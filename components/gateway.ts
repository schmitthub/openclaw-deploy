import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import * as command from "@pulumi/command";
import * as crypto from "crypto";
import {
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  ENVOY_CA_CERT_PATH,
  dataDir,
} from "../config";

export interface GatewayArgs {
  /** Docker host URI, e.g. "ssh://root@<ip>" */
  dockerHost: pulumi.Input<string>;
  /** SSH connection args for remote commands */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Unique name for this gateway instance */
  profile: string;
  /** Host port for the gateway */
  port: number;
  /** Docker image tag for the gateway (from GatewayImage) */
  imageName: pulumi.Input<string>;
  /** Sidecar container name for network_mode (from TailscaleSidecar) */
  sidecarContainerName: pulumi.Input<string>;
  /** Tailscale hostname (from TailscaleSidecar) */
  tailscaleHostname: pulumi.Input<string>;
  /** OpenClaw subcommands run in the init container (auto-prefixed with `openclaw `) */
  setupCommands?: string[];
  /** Additional env vars for the container */
  env?: Record<string, string>;
  /** Secret env vars (JSON string: {"KEY":"value",...}) for init container and main container */
  secretEnv?: pulumi.Input<string>;
  /** Auth configuration for this gateway */
  auth: { mode: "token"; token: pulumi.Input<string> };
}

export class Gateway extends pulumi.ComponentResource {
  /** Docker container ID */
  public readonly containerId: pulumi.Output<string>;
  /** Tailscale hostname URL */
  public readonly tailscaleUrl: pulumi.Output<string>;

  constructor(
    name: string,
    args: GatewayArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:app:Gateway", name, {}, opts);

    const dDir = dataDir(args.profile);

    // Docker provider connected to the remote host
    const dockerProvider = new docker.Provider(
      `${name}-docker`,
      { host: args.dockerHost },
      { parent: this },
    );

    const imageName = args.imageName;
    const sidecarName = args.sidecarContainerName;
    const containerName = `openclaw-gateway-${args.profile}`;

    // Step 1: Create host directories for bind-mounted persistent data
    const createDirs = new command.remote.Command(
      `${name}-dirs`,
      {
        connection: args.connection,
        create: `mkdir -p ${dDir}/{config,workspace,config/identity,config/agents/main/agent,config/agents/main/sessions} && chown -R 1000:1000 ${dDir}/config ${dDir}/workspace`,
        delete: `rm -rf ${dDir}`,
      },
      { parent: this },
    );

    // Named Docker volumes for home and linuxbrew
    const homeVolume = new docker.Volume(
      `${name}-home`,
      { name: `openclaw-home-${args.profile}` },
      { parent: this, provider: dockerProvider },
    );
    const linuxbrewVolume = new docker.Volume(
      `${name}-linuxbrew`,
      { name: `openclaw-linuxbrew-${args.profile}` },
      { parent: this, provider: dockerProvider },
    );

    // Init container runs user setupCommands only (prefixed with `openclaw `)
    const setupCmds = (args.setupCommands ?? [])
      .filter((cmd) => {
        if (!cmd.trim()) {
          pulumi.log.warn(
            `Skipping empty setupCommand for gateway ${args.profile}`,
            this,
          );
          return false;
        }
        return true;
      })
      .map((cmd) => `openclaw ${cmd}`);

    const initScript = setupCmds.join("\n");

    // Step 2: Write secret env file to host
    const envFile = `${dDir}/.init-env`;
    const writeSecretEnv = new command.remote.Command(
      `${name}-write-secret-env`,
      {
        connection: args.connection,
        create: pulumi
          .all([
            pulumi.output(args.secretEnv ?? "{}"),
            pulumi.output(args.auth.token),
          ])
          .apply(([secretJson, token]) => {
            let secrets: Record<string, string>;
            try {
              secrets = JSON.parse(secretJson) as Record<string, string>;
            } catch (e) {
              const detail = e instanceof Error ? e.message : String(e);
              throw new Error(
                `Invalid JSON in gatewaySecretEnv-${args.profile}: ${detail}. Expected {"KEY":"value",...}`,
                { cause: e },
              );
            }
            secrets["OPENCLAW_GATEWAY_TOKEN"] = token;
            const entries = Object.entries(secrets);
            const printfs = entries
              .map(
                ([k, v]) => `printf '%s\\n' '${k}=${v.replace(/'/g, "'\\''")}'`,
              )
              .join(" && ");
            return `{ ${printfs}; } > ${envFile} && chmod 600 ${envFile}`;
          }),
        delete: `rm -f ${envFile}`,
        logging: "none",
      },
      {
        parent: this,
        dependsOn: [createDirs],
        additionalSecretOutputs: ["stdout", "stderr"],
      },
    );

    // Step 3: Run setupCommands as init containers.
    // TAILSCALE_SERVE_HOST is written to the env file from the sidecar hostname output.
    const writeHostnameToEnv = new command.remote.Command(
      `${name}-write-hostname`,
      {
        connection: args.connection,
        create: pulumi.interpolate`printf '%s\n' "TAILSCALE_SERVE_HOST=${args.tailscaleHostname}" >> ${envFile}`,
        triggers: [args.tailscaleHostname],
      },
      { parent: this, dependsOn: [writeSecretEnv] },
    );

    const setupResources: command.remote.Command[] = [];

    for (let i = 0; i < setupCmds.length; i++) {
      const cmd = setupCmds[i];
      const words = cmd.replace(/^openclaw\s+/, "").split(/\s+/);
      const slug = words
        .slice(0, 2)
        .join("-")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 20);
      const encoded = Buffer.from(cmd).toString("base64");

      const setupResource = new command.remote.Command(
        `${name}-setup-${i}-${slug}`,
        {
          connection: args.connection,
          create: pulumi.interpolate`docker run --rm --network none --user node --entrypoint /bin/sh --env-file ${envFile} -v openclaw-home-${args.profile}:/home/node -v ${dDir}/config:${DEFAULT_OPENCLAW_CONFIG_DIR} -v ${dDir}/workspace:${DEFAULT_OPENCLAW_WORKSPACE_DIR} ${imageName} -c "set -e; echo '${encoded}' | base64 -d | sh -e"`,
          triggers: i === 0 ? [writeHostnameToEnv.stdout] : undefined,
        },
        {
          parent: this,
          dependsOn: [i === 0 ? writeHostnameToEnv : setupResources[i - 1]],
          additionalSecretOutputs: ["stdout", "stderr"],
        },
      );
      setupResources.push(setupResource);
    }

    const lastSetupDep =
      setupResources.length > 0
        ? setupResources[setupResources.length - 1]
        : writeHostnameToEnv;

    // Step 4: Create the gateway container (shares sidecar's network namespace)

    // Build env vars list
    const envs: pulumi.Input<string>[] = [
      `HOME=/home/node`,
      `TERM=xterm-256color`,
      `NODE_EXTRA_CA_CERTS=${ENVOY_CA_CERT_PATH}`,
    ];

    // Auth token via env var
    envs.push(pulumi.interpolate`OPENCLAW_GATEWAY_TOKEN=${args.auth.token}`);

    for (const [k, v] of Object.entries(args.env ?? {})) {
      envs.push(`${k}=${v}`);
    }

    // Merge secret env vars into the container's envs
    const secretEnvParsed = pulumi.output(args.secretEnv ?? "{}").apply((s) => {
      try {
        return JSON.parse(s) as Record<string, string>;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Invalid JSON in gatewaySecretEnv-${args.profile}: ${detail}. Expected {"KEY":"value",...}`,
          { cause: e },
        );
      }
    });

    // Filter out reserved env vars that are managed by this component
    const RESERVED_ENV_KEYS = new Set([
      "OPENCLAW_GATEWAY_TOKEN",
      "TS_AUTHKEY",
      "TS_SOCKET",
      "OPENCLAW_TCP_MAPPINGS",
    ]);

    // Warn at plan time if secretEnv contains reserved keys
    pulumi.output(args.secretEnv ?? "{}").apply((s) => {
      let parsed: Record<string, string>;
      try {
        parsed = JSON.parse(s) as Record<string, string>;
      } catch (e) {
        if (!(e instanceof SyntaxError)) {
          pulumi.log.warn(
            `Unexpected error checking secretEnv for reserved keys: ${e}`,
            this,
          );
        }
        return;
      }
      const conflicts = Object.keys(parsed).filter((k) =>
        RESERVED_ENV_KEYS.has(k),
      );
      if (conflicts.length > 0) {
        pulumi.log.warn(
          `gatewaySecretEnv-${args.profile} contains reserved key(s) that will be ignored: ${conflicts.join(", ")}`,
          this,
        );
      }
    });

    const computedEnvs = pulumi
      .all([pulumi.all(envs), secretEnvParsed])
      .apply(([baseEnvs, secrets]) => [
        ...baseEnvs,
        ...Object.entries(secrets)
          .filter(([k]) => !RESERVED_ENV_KEYS.has(k))
          .map(([k, v]) => `${k}=${v}`),
      ]);

    // Build volumes list
    const volumes: docker.types.input.ContainerVolume[] = [
      {
        volumeName: homeVolume.name,
        containerPath: "/home/node",
      },
      {
        volumeName: linuxbrewVolume.name,
        containerPath: "/home/linuxbrew/.linuxbrew",
      },
      {
        hostPath: `${dDir}/config`,
        containerPath: DEFAULT_OPENCLAW_CONFIG_DIR,
      },
      {
        hostPath: `${dDir}/workspace`,
        containerPath: DEFAULT_OPENCLAW_WORKSPACE_DIR,
      },
      {
        hostPath: ENVOY_CA_CERT_PATH,
        containerPath: ENVOY_CA_CERT_PATH,
        readOnly: true,
      },
    ];

    // Container command overrides Dockerfile CMD
    const containerCommand = ["openclaw", "gateway", "--port", `${args.port}`];

    // Content hash of init script — forces container replacement when setup changes
    const contentHash = crypto
      .createHash("sha256")
      .update(initScript)
      .digest("hex")
      .slice(0, 12);

    const container = new docker.Container(
      `${name}-container`,
      {
        name: containerName,
        image: imageName,
        restart: "unless-stopped",
        init: true,
        networkMode: pulumi.interpolate`container:${sidecarName}`,
        sysctls: {
          "net.ipv4.tcp_keepalive_time": "60",
          "net.ipv4.tcp_keepalive_intvl": "10",
          "net.ipv4.tcp_keepalive_probes": "3",
        },
        envs: computedEnvs,
        command: containerCommand,
        healthcheck: {
          tests: [
            "CMD",
            "node",
            "-e",
            `fetch('http://127.0.0.1:${args.port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
          ],
          interval: "30s",
          timeout: "5s",
          retries: 5,
          startPeriod: "20s",
        },
        volumes,
        labels: [{ label: "openclaw.init-hash", value: contentHash }],
      },
      {
        parent: this,
        provider: dockerProvider,
        dependsOn: [lastSetupDep],
        additionalSecretOutputs: ["envs"],
      },
    );

    this.tailscaleUrl = pulumi.interpolate`https://${args.tailscaleHostname}`;

    // Outputs
    this.containerId = container.id;

    this.registerOutputs({
      containerId: this.containerId,
      tailscaleUrl: this.tailscaleUrl,
    });
  }
}
