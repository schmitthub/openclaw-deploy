import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import * as command from "@pulumi/command";
import * as crypto from "crypto";
import {
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  ENVOY_CA_CERT_PATH,
  ENVOY_IMAGE,
  ENVOY_UID,
  TAILSCALE_IMAGE,
  TAILSCALE_STATE_DIR,
  TAILSCALE_HEALTH_PORT,
  CLOUDFLARE_DNS_PRIMARY,
  CLOUDFLARE_DNS_SECONDARY,
  ENVOY_MITM_CERTS_HOST_DIR,
  ENVOY_MITM_CERTS_CONTAINER_DIR,
  SSHD_PORT,
  buildDir,
  dataDir,
} from "../config";
import {
  renderSidecarEntrypoint,
  renderServeConfig,
  TcpPortMapping,
} from "../templates";

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
  /** Secret: Tailscale auth key (always required) */
  tailscaleAuthKey: pulumi.Input<string>;
  /** Host path to the envoy.yaml config file (from EnvoyEgress) */
  envoyConfigPath: pulumi.Input<string>;
  /** SHA256 hash of envoy.yaml (triggers envoy container replacement) */
  envoyConfigHash: string;
  /** Domains with MITM TLS inspection enabled (from EnvoyEgress) */
  inspectedDomains: string[];
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

    const bDir = buildDir(args.profile);
    const dDir = dataDir(args.profile);

    // Render sidecar templates (pure functions, runs at plan time).
    // Dockerfile + entrypoint are now handled by GatewayImage.
    const sidecarEntrypoint = renderSidecarEntrypoint();
    const serveConfig = renderServeConfig(args.port, SSHD_PORT);

    // Docker provider connected to the remote host
    const dockerProvider = new docker.Provider(
      `${name}-docker`,
      { host: args.dockerHost },
      { parent: this },
    );

    // Upload sidecar files to the remote host (sidecar-entrypoint.sh + serve-config.json).
    // Dockerfile + entrypoint.sh are handled by GatewayImage via BuildKit.
    const encodedSidecar = Buffer.from(sidecarEntrypoint).toString("base64");
    const encodedServeConfig = Buffer.from(serveConfig).toString("base64");
    const sidecarContentHash = crypto
      .createHash("sha256")
      .update(sidecarEntrypoint)
      .update(serveConfig)
      .digest("hex")
      .slice(0, 12);
    const uploadSidecarFiles = new command.remote.Command(
      `${name}-upload-sidecar`,
      {
        connection: args.connection,
        create: [
          `mkdir -p ${bDir}`,
          `echo '${encodedSidecar}' | base64 -d > ${bDir}/sidecar-entrypoint.sh`,
          `echo '${encodedServeConfig}' | base64 -d > ${bDir}/serve-config.json`,
          `chmod 755 ${bDir}/sidecar-entrypoint.sh`,
          `# content-hash=${sidecarContentHash}`,
        ].join(" && "),
        delete: `rm -f ${bDir}/sidecar-entrypoint.sh ${bDir}/serve-config.json`,
      },
      { parent: this },
    );

    // Image name comes from GatewayImage component
    const imageName = args.imageName;

    // Step 3: Create host directories for bind-mounted persistent data
    const createDirs = new command.remote.Command(
      `${name}-dirs`,
      {
        connection: args.connection,
        create: `mkdir -p ${dDir}/{config,workspace,config/identity,config/agents/main/agent,config/agents/main/sessions,tailscale} && chown -R 1000:1000 ${dDir}/config ${dDir}/workspace`,
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

    // Step 4: Write config to shared volume via ephemeral CLI container.
    const containerName = `openclaw-gateway-${args.profile}`;
    const sidecarName = `tailscale-${args.profile}`;
    const envoyName = `envoy-${args.profile}`;

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

    // Step 4a: Write secret env file to host
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

    // Step 5: Create the per-gateway bridge network.
    // NOT internal: true — the sidecar needs internet access for Envoy to reach upstreams.
    // All three containers (sidecar, envoy, gateway) share the sidecar's network namespace.
    const bridgeNetwork = new docker.Network(
      `${name}-network`,
      {
        name: `openclaw-net-${args.profile}`,
        driver: "bridge",
      },
      { parent: this, provider: dockerProvider },
    );

    // Step 6a: Create the Tailscale sidecar container.
    // The sidecar owns the network namespace. Envoy and gateway share it via network_mode.
    // Uses containerboot (official Tailscale entrypoint) with sidecar-entrypoint.sh as wrapper.

    // Build sidecar env vars
    const sidecarEnvs: pulumi.Input<string>[] = [
      `TS_STATE_DIR=${TAILSCALE_STATE_DIR}`,
      `TS_USERSPACE=false`,
      `TS_SERVE_CONFIG=/config/serve-config.json`,
      `TS_ENABLE_HEALTH_CHECK=true`,
      `ENVOY_UID=${ENVOY_UID}`,
    ];
    sidecarEnvs.push(pulumi.interpolate`TS_AUTHKEY=${args.tailscaleAuthKey}`);
    if (args.tcpPortMappings && args.tcpPortMappings.length > 0) {
      sidecarEnvs.push(
        `OPENCLAW_TCP_MAPPINGS=${args.tcpPortMappings.map((m) => `${m.dst}|${m.dstPort}|${m.envoyPort}`).join(";")}`,
      );
    }

    // Content hash for sidecar — forces replacement when sidecar entrypoint changes
    const sidecarHash = crypto
      .createHash("sha256")
      .update(sidecarEntrypoint)
      .digest("hex")
      .slice(0, 12);

    const sidecarContainer = new docker.Container(
      `${name}-sidecar`,
      {
        name: sidecarName,
        image: TAILSCALE_IMAGE,
        restart: "unless-stopped",
        hostname: args.profile,
        capabilities: { adds: ["NET_ADMIN"] },
        devices: [
          {
            hostPath: "/dev/net/tun",
            containerPath: "/dev/net/tun",
          },
        ],
        dns: [CLOUDFLARE_DNS_PRIMARY, CLOUDFLARE_DNS_SECONDARY],
        envs: pulumi.all(sidecarEnvs),
        entrypoints: [`${bDir}/sidecar-entrypoint.sh`],
        healthcheck: {
          tests: [
            "CMD",
            "wget",
            "-q",
            "--spider",
            `http://127.0.0.1:${TAILSCALE_HEALTH_PORT}/healthz`,
          ],
          interval: "10s",
          timeout: "5s",
          retries: 5,
          startPeriod: "30s",
        },
        volumes: [
          {
            hostPath: `${bDir}/sidecar-entrypoint.sh`,
            containerPath: `${bDir}/sidecar-entrypoint.sh`,
            readOnly: true,
          },
          {
            hostPath: `${dDir}/tailscale`,
            containerPath: TAILSCALE_STATE_DIR,
          },
          {
            hostPath: `${bDir}/serve-config.json`,
            containerPath: "/config/serve-config.json",
            readOnly: true,
          },
        ],
        networksAdvanced: [{ name: bridgeNetwork.name }],
        labels: [{ label: "openclaw.sidecar-hash", value: sidecarHash }],
      },
      {
        parent: this,
        provider: dockerProvider,
        dependsOn: [uploadSidecarFiles, bridgeNetwork],
        additionalSecretOutputs: ["envs"],
      },
    );

    // Step 6b: Wait for sidecar to be healthy, capture Tailscale hostname, write to env file.
    // "Healthy" means: Docker healthcheck passes + Tailscale authenticated + hostname available.
    // TAILSCALE_SERVE_HOST is appended to the env file so setupCommands can reference it.
    const sidecarHealthy = new command.remote.Command(
      `${name}-sidecar-healthy`,
      {
        connection: args.connection,
        create: [
          // Wait for Docker healthcheck
          `for i in $(seq 1 60); do if [ "$(docker inspect --format='{{.State.Health.Status}}' ${sidecarName} 2>/dev/null)" = "healthy" ]; then break; fi; if [ "$i" = "60" ]; then echo "ERROR: Tailscale sidecar did not become healthy within 120s" >&2; exit 1; fi; sleep 2; done`,
          // Wait for Tailscale to authenticate
          `for i in $(seq 1 60); do docker exec ${sidecarName} tailscale status --json 2>/dev/null | jq -e '.BackendState == "Running"' >/dev/null 2>&1 && break; if [ "$i" = "60" ]; then echo "ERROR: Tailscale did not reach Running state in 120s" >&2; exit 1; fi; sleep 2; done`,
          // Capture hostname and append to env file
          `TS_HOST=$(docker exec ${sidecarName} tailscale status --json | jq -r '.Self.DNSName' | sed 's/\\.$//')`,
          `printf '%s\\n' "TAILSCALE_SERVE_HOST=$TS_HOST" >> ${envFile}`,
          `echo "$TS_HOST"`,
        ].join(" && "),
        triggers: [sidecarContainer.id],
      },
      { parent: this, dependsOn: [sidecarContainer, writeSecretEnv] },
    );

    // Step 7: Run setupCommands as init containers (depend on sidecar being healthy).
    // TAILSCALE_SERVE_HOST is in the env file from Step 6b.
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
          triggers: i === 0 ? [sidecarHealthy.stdout] : undefined,
        },
        {
          parent: this,
          dependsOn: [i === 0 ? sidecarHealthy : setupResources[i - 1]],
          additionalSecretOutputs: ["stdout", "stderr"],
        },
      );
      setupResources.push(setupResource);
    }

    const lastSetupDep =
      setupResources.length > 0
        ? setupResources[setupResources.length - 1]
        : sidecarHealthy;

    // Step 8: Create Envoy container (shares sidecar's network namespace).
    const envoyVolumes: docker.types.input.ContainerVolume[] = [
      {
        hostPath: pulumi.output(args.envoyConfigPath).apply((p) => p),
        containerPath: "/etc/envoy/envoy.yaml",
        readOnly: true,
      },
      {
        hostPath: ENVOY_CA_CERT_PATH,
        containerPath: "/etc/envoy/ca-cert.pem",
        readOnly: true,
      },
    ];
    if (args.inspectedDomains.length > 0) {
      envoyVolumes.push({
        hostPath: ENVOY_MITM_CERTS_HOST_DIR,
        containerPath: ENVOY_MITM_CERTS_CONTAINER_DIR,
        readOnly: true,
      });
    }

    const envoyContainer = new docker.Container(
      `${name}-envoy`,
      {
        name: envoyName,
        image: ENVOY_IMAGE,
        restart: "unless-stopped",
        networkMode: `container:${sidecarName}`,
        envs: [`ENVOY_UID=${ENVOY_UID}`],
        healthcheck: {
          tests: ["CMD", "bash", "-c", "echo > /dev/tcp/localhost/10000"],
          interval: "5s",
          timeout: "3s",
          retries: 5,
          startPeriod: "5s",
        },
        volumes: envoyVolumes,
        labels: [
          { label: "openclaw.config-hash", value: args.envoyConfigHash },
        ],
      },
      {
        parent: this,
        provider: dockerProvider,
        dependsOn: [sidecarHealthy],
      },
    );

    // Step 7b: Wait for Envoy to pass healthcheck.
    const envoyHealthy = new command.remote.Command(
      `${name}-envoy-healthy`,
      {
        connection: args.connection,
        create: pulumi.interpolate`for i in $(seq 1 30); do if [ "$(docker inspect --format='{{.State.Health.Status}}' ${envoyName} 2>/dev/null)" = "healthy" ]; then exit 0; fi; sleep 2; done; echo "ERROR: Envoy did not become healthy within 60s" >&2; exit 1`,
        triggers: [envoyContainer.id],
      },
      { parent: this, dependsOn: [envoyContainer] },
    );

    // Step 8: Create the gateway container (shares sidecar's network namespace)

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

    // Merge secret env vars into the container's envs.
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
    const RESERVED_ENV_KEYS = new Set([
      "OPENCLAW_GATEWAY_TOKEN",
      "TS_AUTHKEY",
      "TS_SOCKET",
      "OPENCLAW_TCP_MAPPINGS",
    ]);

    // Warn at plan time if secretEnv contains reserved keys.
    pulumi.output(args.secretEnv ?? "{}").apply((s) => {
      let parsed: Record<string, string>;
      try {
        parsed = JSON.parse(s) as Record<string, string>;
      } catch (e) {
        // JSON parse error is handled by secretEnvParsed above — skip warning check
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

    // Content hash of init script — forces container replacement when setup changes.
    // Dockerfile content changes are tracked by GatewayImage via BuildKit.
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
        // No CAP_NET_ADMIN needed — sidecar handles all networking
        networkMode: `container:${sidecarName}`,
        // No networksAdvanced — mutually exclusive with networkMode
        // No dns — inherited from sidecar's netns
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
        dependsOn: [envoyHealthy, lastSetupDep],
        additionalSecretOutputs: ["envs"],
      },
    );

    this.tailscaleUrl = sidecarHealthy.stdout.apply(
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
