import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import {
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  ENVOY_CA_CERT_PATH,
  dataDir,
} from "../config";

export interface GatewayArgs {
  /** Docker host URI, e.g. "ssh://root@<ip>" */
  dockerHost: pulumi.Input<string>;
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
  /** Additional env vars for the container */
  env?: Record<string, string>;
  /** Secret env vars (JSON string: {"KEY":"value",...}) for the main container */
  secretEnv?: pulumi.Input<string>;
  /** Auth configuration for this gateway */
  auth: { mode: "token"; token: pulumi.Input<string> };
  /** Content hash of init commands (forces container replacement when setup changes) */
  initHash: string;
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
        labels: [{ label: "openclaw.init-hash", value: args.initHash }],
      },
      {
        parent: this,
        provider: dockerProvider,
        additionalSecretOutputs: ["envs"],
      },
    );

    this.tailscaleUrl = pulumi.interpolate`https://${args.tailscaleHostname}`;
    this.containerId = container.id;

    this.registerOutputs({
      containerId: this.containerId,
      tailscaleUrl: this.tailscaleUrl,
    });
  }
}
