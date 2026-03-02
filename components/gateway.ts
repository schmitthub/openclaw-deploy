import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import * as command from "@pulumi/command";
import {
  TailscaleMode,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  ENVOY_STATIC_IP,
} from "../config";
import { renderDockerfile, renderEntrypoint } from "../templates";

export interface GatewayArgs {
  /** Docker host URI, e.g. "ssh://root@<ip>" */
  dockerHost: pulumi.Input<string>;
  /** SSH connection args for remote commands */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Internal network name (from EnvoyEgress) — gateway attaches here */
  internalNetworkName: pulumi.Input<string>;
  /** Unique name for this gateway instance */
  profile: string;
  /** OpenClaw version to install (npm dist-tag or semver) */
  version: string;
  /** Additional apt packages to bake into the image */
  packages: string[];
  /** Host port for the gateway */
  port: number;
  /** Bridge port (defaults 18790) */
  bridgePort?: number;
  /** Tailscale mode: "serve" (private), "funnel" (public), or "off" */
  tailscale: TailscaleMode;
  /** Bake Playwright + Chromium into the image (~300MB) */
  installBrowser?: boolean;
  /** openclaw config set key=value pairs (user overrides, cannot override security-critical keys) */
  configSet: Record<string, string>;
  /** Additional env vars for the container */
  env?: Record<string, string>;
  /** Auth configuration for this gateway */
  auth: { mode: string; token: pulumi.Input<string> };
}

export class Gateway extends pulumi.ComponentResource {
  /** Docker container ID */
  public readonly containerId: pulumi.Output<string>;
  /** Tailscale hostname resolved from the remote host (empty string if tailscale is "off") */
  public readonly tailscaleUrl: pulumi.Output<string>;

  constructor(
    name: string,
    args: GatewayArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:app:Gateway", name, {}, opts);

    const buildDir = `/opt/openclaw-deploy/build/${args.profile}`;
    const dataDir = `/opt/openclaw-deploy/data/${args.profile}`;

    // Render templates (pure functions, runs at plan time)
    const dockerfile = renderDockerfile({
      version: args.version,
      packages: args.packages,
      installBrowser: args.installBrowser ?? false,
      bridgePort: args.bridgePort,
    });
    const entrypoint = renderEntrypoint();

    // Docker provider connected to the remote host
    const dockerProvider = new docker.Provider(
      `${name}-docker`,
      { host: args.dockerHost },
      { parent: this },
    );

    // Step 1: Upload Dockerfile + entrypoint.sh to server via remote command.
    // Uses base64 encoding to safely transfer content without heredoc issues.
    const encodedDockerfile = Buffer.from(dockerfile).toString("base64");
    const encodedEntrypoint = Buffer.from(entrypoint).toString("base64");
    const uploadBuildContext = new command.remote.Command(
      `${name}-upload-build`,
      {
        connection: args.connection,
        create: [
          `mkdir -p ${buildDir}`,
          `echo '${encodedDockerfile}' | base64 -d > ${buildDir}/Dockerfile`,
          `echo '${encodedEntrypoint}' | base64 -d > ${buildDir}/entrypoint.sh`,
          `chmod 755 ${buildDir}/entrypoint.sh`,
        ].join(" && "),
        delete: `rm -rf ${buildDir}`,
      },
      { parent: this },
    );

    // Step 2: Build Docker image on the remote host
    const image = new docker.Image(
      `${name}-image`,
      {
        imageName: `openclaw-gateway-${args.profile}:${args.version}`,
        build: {
          context: buildDir,
          dockerfile: `${buildDir}/Dockerfile`,
          platform: "linux/amd64",
        },
        skipPush: true,
      },
      {
        parent: this,
        provider: dockerProvider,
        dependsOn: [uploadBuildContext],
      },
    );

    // Step 3: Create host directories for persistent data
    const createDirs = new command.remote.Command(
      `${name}-dirs`,
      {
        connection: args.connection,
        create: `mkdir -p ${dataDir}/{config,workspace,config/identity}`,
        delete: `rm -rf ${dataDir}`,
      },
      { parent: this },
    );

    // Step 4: Create the gateway container
    const container = new docker.Container(
      `${name}-container`,
      {
        name: `openclaw-gateway-${args.profile}`,
        image: image.imageName,
        restart: "unless-stopped",
        init: true,
        capabilities: { adds: ["NET_ADMIN"] },
        dns: [ENVOY_STATIC_IP],
        envs: [
          `HOME=/home/node`,
          `TERM=xterm-256color`,
          ...Object.entries(args.env ?? {}).map(([k, v]) => `${k}=${v}`),
        ],
        command: [
          "openclaw",
          "gateway",
          "--bind",
          "lan",
          "--port",
          `${args.port}`,
        ],
        volumes: [
          {
            hostPath: `${dataDir}/config`,
            containerPath: DEFAULT_OPENCLAW_CONFIG_DIR,
          },
          {
            hostPath: `${dataDir}/workspace`,
            containerPath: DEFAULT_OPENCLAW_WORKSPACE_DIR,
          },
        ],
        networksAdvanced: [{ name: args.internalNetworkName }],
      },
      {
        parent: this,
        provider: dockerProvider,
        dependsOn: [createDirs, image],
      },
    );

    // Step 5: Run openclaw config set commands via docker exec.
    // Required config always wins — user configSet cannot override security-critical keys.
    const requiredConfig: Record<string, pulumi.Input<string>> = {
      "gateway.mode": "local",
      "gateway.auth.mode": args.auth.mode,
      "gateway.auth.token": args.auth.token,
      "gateway.trustedProxies":
        '["172.16.0.0/12","10.0.0.0/8","192.168.0.0/16"]',
      "discovery.mdns.mode": "off",
    };

    // User overrides first, then required config on top (required always wins)
    const allConfig: Record<string, pulumi.Input<string>> = {
      ...args.configSet,
      ...requiredConfig,
    };

    // Chain config commands sequentially to avoid concurrent file writes.
    // Each `openclaw config set` reads/modifies/writes the same config file.
    const containerName = `openclaw-gateway-${args.profile}`;
    let previousConfigCmd: command.remote.Command | undefined;

    for (const [key, value] of Object.entries(allConfig)) {
      const safeName = key.replace(/\./g, "-");
      const deps: pulumi.Resource[] = previousConfigCmd
        ? [previousConfigCmd]
        : [container];
      const cmd = new command.remote.Command(
        `${name}-config-${safeName}`,
        {
          connection: args.connection,
          create: pulumi.interpolate`docker exec ${containerName} openclaw config set ${key} '${value}'`,
          logging: "none",
        },
        {
          parent: this,
          dependsOn: deps,
          additionalSecretOutputs: ["stdout", "stderr"],
        },
      );
      previousConfigCmd = cmd;
    }

    const lastConfigCmd = previousConfigCmd;

    // Step 6: Configure Tailscale Serve/Funnel on host (if not "off")
    if (args.tailscale !== "off") {
      const tsAction = args.tailscale === "serve" ? "serve" : "funnel";
      const tailscaleCmd = new command.remote.Command(
        `${name}-tailscale`,
        {
          connection: args.connection,
          create: [
            `tailscale ${tsAction} --bg https+insecure://localhost:${args.port}`,
            `tailscale status --json | jq -r '.Self.DNSName' | sed 's/\\.$//'`,
          ].join(" && "),
          delete: `tailscale ${tsAction} --remove https+insecure://localhost:${args.port}`,
        },
        {
          parent: this,
          dependsOn: lastConfigCmd ? [lastConfigCmd] : [container],
        },
      );

      this.tailscaleUrl = tailscaleCmd.stdout.apply(
        (hostname) => `https://${hostname.trim()}`,
      );
    } else {
      this.tailscaleUrl = pulumi.output("");
    }

    // Outputs
    this.containerId = container.id;

    this.registerOutputs({
      containerId: this.containerId,
      tailscaleUrl: this.tailscaleUrl,
    });
  }
}
