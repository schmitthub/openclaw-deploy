import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import * as command from "@pulumi/command";
import * as crypto from "crypto";
import {
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  ENVOY_STATIC_IP,
  ENVOY_CA_CERT_PATH,
  TAILSCALE_STATE_DIR,
  TAILSCALE_SOCKET_PATH,
} from "../config";
import {
  renderDockerfile,
  renderEntrypoint,
  TcpPortMapping,
  UdpPortMapping,
} from "../templates";
import type { ImageStep } from "../config/types";

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
  /** Host port for the gateway */
  port: number;
  /** Bake Playwright + Chromium into the image (~300MB) */
  installBrowser?: boolean;
  /** Custom Dockerfile RUN instructions (after openclaw install, before entrypoint COPY) */
  imageSteps?: ImageStep[];
  /** OpenClaw subcommands run in the init container (auto-prefixed with `openclaw `) */
  setupCommands?: string[];
  /** Additional env vars for the container */
  env?: Record<string, string>;
  /** Secret env vars (JSON string: {"KEY":"value",...}) for init container and main container */
  secretEnv?: pulumi.Input<string>;
  /** Auth configuration for this gateway */
  auth: { mode: "token"; token: pulumi.Input<string> };
  /** Per-rule port mappings for SSH/TCP egress (from EnvoyEgress) */
  tcpPortMappings?: TcpPortMapping[];
  /** Per-rule port mappings for UDP egress (from EnvoyEgress) */
  udpPortMappings?: UdpPortMapping[];
  /** Secret: Tailscale auth key (always required) */
  tailscaleAuthKey: pulumi.Input<string>;
}

export class Gateway extends pulumi.ComponentResource {
  /** Docker container ID */
  public readonly containerId: pulumi.Output<string>;
  /** Tailscale hostname resolved from the container */
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
      installBrowser: args.installBrowser ?? false,
      imageSteps: args.imageSteps,
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

    // Step 2: Build Docker image on the remote host via docker build command.
    // Cannot use docker.Image because it validates the Dockerfile path locally
    // during preview, but the build context only exists on the remote host.
    // Content hash in the --label forces Pulumi to re-run when Dockerfile or
    // entrypoint.sh content changes (Pulumi only diffs the command string).
    const imageName = `openclaw-gateway-${args.profile}:${args.version}`;
    const buildContextHash = crypto
      .createHash("sha256")
      .update(dockerfile)
      .update(entrypoint)
      .digest("hex")
      .slice(0, 12);
    const buildImage = new command.remote.Command(
      `${name}-build-image`,
      {
        connection: args.connection,
        create: `DOCKER_BUILDKIT=1 docker build --label openclaw.build-hash=${buildContextHash} -t ${imageName} ${buildDir}`,
        delete: `docker rmi ${imageName} 2>/dev/null; true`,
      },
      {
        parent: this,
        dependsOn: [uploadBuildContext],
      },
    );

    // Step 3: Create host directories for bind-mounted persistent data
    const createDirs = new command.remote.Command(
      `${name}-dirs`,
      {
        connection: args.connection,
        create: `mkdir -p ${dataDir}/{config,workspace,config/identity,config/agents/main/agent,config/agents/main/sessions,tailscale} && chown -R 1000:1000 ${dataDir}/config ${dataDir}/workspace`,
        delete: `rm -rf ${dataDir}`,
      },
      { parent: this },
    );

    // Named Docker volumes for home and linuxbrew — auto-populated from the
    // image on first use, persist across container recreations. No seed step needed.
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

    // Step 4: Write config to shared volume via ephemeral CLI container.
    // Runs BEFORE the gateway container starts — avoids crash-loop from missing config.
    // Uses --network none (pure file I/O) and --user node (no root-owned files).
    const containerName = `openclaw-gateway-${args.profile}`;

    // Init container runs user setupCommands only (prefixed with `openclaw `)
    const setupCmds = (args.setupCommands ?? []).map(
      (cmd) => `openclaw ${cmd}`,
    );

    // Base64-encode the init script to avoid nested shell quoting issues.
    // The script runs inside the container where env vars ($SECRET_ENV_VARS)
    // are available from the --env-file.
    const initScript = setupCmds.join("\n");
    const encodedInitScript = Buffer.from(initScript).toString("base64");

    // Step 4a: Write secret env file to host (separate command so secrets
    // don't appear in the init container command string on error).
    const envFile = `${dataDir}/.init-env`;
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
            // Include gateway token so setupCommands can reference $OPENCLAW_GATEWAY_TOKEN
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
        dependsOn: [buildImage, createDirs],
        additionalSecretOutputs: ["stdout", "stderr"],
      },
    );

    // Step 4b: Run init container with base64-decoded script piped to sh.
    // The --env-file provides secret env vars; the command string has no secrets.
    const writeConfig = new command.remote.Command(
      `${name}-write-config`,
      {
        connection: args.connection,
        create: [
          // Skip init if gateway is already configured (token exists in config file on host).
          // Requires jq on the host (installed by HostBootstrap).
          `if jq -e '.gateway.auth.token // empty' ${dataDir}/config/openclaw.json >/dev/null 2>&1;`,
          `then echo "Gateway already configured (token found), skipping init."; echo "To force re-init: rm ${dataDir}/config/openclaw.json on the host"; exit 0; fi`,
          `&& echo '${encodedInitScript}' | base64 -d > ${dataDir}/.init.sh`,
          `&&`,
          `docker run --rm --network none --user node`,
          `--entrypoint /bin/sh`,
          `--env-file ${envFile}`,
          `-v openclaw-home-${args.profile}:/home/node`,
          `-v ${dataDir}/config:${DEFAULT_OPENCLAW_CONFIG_DIR}`,
          `-v ${dataDir}/workspace:${DEFAULT_OPENCLAW_WORKSPACE_DIR}`,
          `-v ${dataDir}/.init.sh:/tmp/init.sh:ro`,
          `${imageName} /tmp/init.sh`,
          `&& rm -f ${dataDir}/.init.sh`,
        ].join(" "),
        delete: `rm -f ${dataDir}/.init.sh`,
      },
      {
        parent: this,
        dependsOn: [writeSecretEnv],
      },
    );

    // Step 5: Create the gateway container

    // Build env vars list
    const envs: pulumi.Input<string>[] = [
      `HOME=/home/node`,
      `TERM=xterm-256color`,
      // Always set so the gateway trusts MITM-issued certs (harmless when no inspect rules exist)
      `NODE_EXTRA_CA_CERTS=${ENVOY_CA_CERT_PATH}`,
    ];

    // Auth token via env var (takes precedence over config file in local mode)
    envs.push(pulumi.interpolate`OPENCLAW_GATEWAY_TOKEN=${args.auth.token}`);

    if (args.tcpPortMappings && args.tcpPortMappings.length > 0) {
      envs.push(
        `OPENCLAW_TCP_MAPPINGS=${args.tcpPortMappings.map((m) => `${m.dst}|${m.dstPort}|${m.envoyPort}`).join(";")}`,
      );
    }

    if (args.udpPortMappings && args.udpPortMappings.length > 0) {
      envs.push(
        `OPENCLAW_UDP_MAPPINGS=${args.udpPortMappings.map((m) => `${m.dst}|${m.dstPort}|${m.envoyPort}`).join(";")}`,
      );
    }

    // Tailscale env vars (always enabled)
    envs.push(`TS_SOCKET=${TAILSCALE_SOCKET_PATH}`);
    envs.push(pulumi.interpolate`TAILSCALE_AUTHKEY=${args.tailscaleAuthKey}`);

    for (const [k, v] of Object.entries(args.env ?? {})) {
      envs.push(`${k}=${v}`);
    }

    // Merge secret env vars into the container's envs.
    // secretEnv is a Pulumi secret, so we resolve both base envs and parsed
    // secrets into a single Output<string[]> for the container's envs field.
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

    // Filter out reserved env vars that are managed by this component.
    // Docker uses the last value for duplicate keys, so user-provided
    // secrets could silently override auth tokens or port mappings.
    const RESERVED_ENV_KEYS = new Set([
      "OPENCLAW_GATEWAY_TOKEN",
      "TAILSCALE_AUTHKEY",
      "TS_SOCKET",
      "OPENCLAW_TCP_MAPPINGS",
      "OPENCLAW_UDP_MAPPINGS",
    ]);

    // Warn at plan time if secretEnv contains reserved keys that will be silently filtered.
    pulumi.output(args.secretEnv ?? "{}").apply((s) => {
      try {
        const parsed = JSON.parse(s) as Record<string, string>;
        const conflicts = Object.keys(parsed).filter((k) =>
          RESERVED_ENV_KEYS.has(k),
        );
        if (conflicts.length > 0) {
          pulumi.log.warn(
            `gatewaySecretEnv-${args.profile} contains reserved key(s) that will be ignored: ${conflicts.join(", ")}`,
            this,
          );
        }
      } catch {
        // JSON parse error is handled by secretEnvParsed above
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

    // Build volumes list — named volumes first, then bind mount overlays on top
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
        hostPath: `${dataDir}/config`,
        containerPath: DEFAULT_OPENCLAW_CONFIG_DIR,
      },
      {
        hostPath: `${dataDir}/workspace`,
        containerPath: DEFAULT_OPENCLAW_WORKSPACE_DIR,
      },
      {
        hostPath: ENVOY_CA_CERT_PATH,
        containerPath: ENVOY_CA_CERT_PATH,
        readOnly: true,
      },
      {
        hostPath: `${dataDir}/tailscale`,
        containerPath: TAILSCALE_STATE_DIR,
      },
    ];

    // Container command overrides Dockerfile CMD — only --port is passed here.
    // --bind and --tailscale are omitted because onboard setupCommands configure those
    // in openclaw.json (gateway.bind, gateway.tailscale). CLI flags would conflict.
    const containerCommand = ["openclaw", "gateway", "--port", `${args.port}`];

    // Content hash of init script + Dockerfile — forces container replacement
    // when setupCommands or image content changes (Pulumi only detects input diffs).
    const contentHash = crypto
      .createHash("sha256")
      .update(initScript)
      .update(dockerfile)
      .digest("hex")
      .slice(0, 12);

    const container = new docker.Container(
      `${name}-container`,
      {
        name: containerName,
        image: imageName,
        restart: "unless-stopped",
        init: true,
        capabilities: { adds: ["NET_ADMIN"] },
        sysctls: {
          "net.ipv4.tcp_keepalive_time": "60",
          "net.ipv4.tcp_keepalive_intvl": "10",
          "net.ipv4.tcp_keepalive_probes": "3",
        },
        dns: [ENVOY_STATIC_IP],
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
        networksAdvanced: [{ name: args.internalNetworkName }],
        labels: [{ label: "openclaw.init-hash", value: contentHash }],
      },
      {
        parent: this,
        provider: dockerProvider,
        dependsOn: [writeConfig],
        additionalSecretOutputs: ["envs"],
      },
    );

    // Step 6: Query Tailscale hostname from inside the container
    const tailscaleHostname = new command.remote.Command(
      `${name}-tailscale-url`,
      {
        connection: args.connection,
        create: [
          // Wait for Tailscale to authenticate inside the container (up to 120s)
          `TS_READY=false; for i in $(seq 1 60); do docker exec ${containerName} tailscale --socket=/var/run/tailscale/tailscaled.sock status --json 2>/dev/null | jq -e '.BackendState == "Running"' >/dev/null 2>&1 && TS_READY=true && break; sleep 2; done`,
          `if [ "$TS_READY" != "true" ]; then echo "ERROR: Tailscale did not reach Running state in 120s" >&2; exit 1; fi`,
          // Extract DNSName via jq (installed on host by bootstrap)
          `docker exec ${containerName} tailscale --socket=/var/run/tailscale/tailscaled.sock status --json | jq -r '.Self.DNSName' | sed 's/\\.$//'`,
        ].join(" && "),
        // Re-run when the container is replaced (new container ID = new Tailscale identity)
        triggers: [container.id],
      },
      {
        parent: this,
        dependsOn: [container],
      },
    );

    this.tailscaleUrl = tailscaleHostname.stdout.apply(
      (hostname) => `https://${hostname.trim()}`,
    );

    // Outputs
    this.containerId = container.id;

    this.registerOutputs({
      containerId: this.containerId,
      tailscaleUrl: this.tailscaleUrl,
    });
  }
}
