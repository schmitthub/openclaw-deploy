import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import {
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  ENVOY_CA_CERT_PATH,
  COREDNS_CONTAINER_PATH,
  dataDir,
} from "../config";

export interface GatewayArgs {
  dockerHost: pulumi.Input<string>;
  profile: string;
  port: number;
  imageName: pulumi.Input<string>;
  sidecarContainerName: pulumi.Input<string>;
  tailscaleHostname: pulumi.Input<string>;
  /** Host path to the Corefile (CoreDNS allowlist config) */
  corefilePath: pulumi.Input<string>;
  env?: Record<string, string>;
  secretEnv?: pulumi.Input<string>;
  auth: { mode: "token"; token: pulumi.Input<string> };
  initHash: string;
  /** Hash of rendered configs (envoy.yaml + Corefile) — triggers container replacement on policy change */
  configHash: string;
}

// Keys that cannot be overridden via gatewaySecretEnv (set by the component itself)
const RESERVED_ENV_KEYS = new Set(["OPENCLAW_GATEWAY_TOKEN"]);

export class Gateway extends pulumi.ComponentResource {
  public readonly containerId: pulumi.Output<string>;
  public readonly tailscaleUrl: pulumi.Output<string>;

  constructor(
    name: string,
    args: GatewayArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:app:Gateway", name, {}, opts);

    const dDir = dataDir(args.profile);

    const dockerProvider = new docker.Provider(
      `${name}-docker`,
      { host: args.dockerHost },
      { parent: this },
    );

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

    // Base env vars + user-defined env
    const envs: pulumi.Input<string>[] = [
      `HOME=/home/node`,
      `TERM=xterm-256color`,
      `NODE_EXTRA_CA_CERTS=${ENVOY_CA_CERT_PATH}`,
      pulumi.interpolate`OPENCLAW_GATEWAY_TOKEN=${args.auth.token}`,
      ...Object.entries(args.env ?? {}).map(([k, v]) => `${k}=${v}`),
    ];

    // Parse secretEnv JSON, filter reserved keys, warn on conflicts
    const computedEnvs = pulumi
      .all([pulumi.all(envs), pulumi.output(args.secretEnv ?? "{}")])
      .apply(([baseEnvs, secretJson]) => {
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
        const conflicts = Object.keys(secrets).filter((k) =>
          RESERVED_ENV_KEYS.has(k),
        );
        if (conflicts.length > 0) {
          pulumi.log.warn(
            `gatewaySecretEnv-${args.profile} contains reserved key(s) that will be ignored: ${conflicts.join(", ")}`,
            this,
          );
        }
        return [
          ...baseEnvs,
          ...Object.entries(secrets)
            .filter(([k]) => !RESERVED_ENV_KEYS.has(k))
            .map(([k, v]) => `${k}=${v}`),
        ];
      });

    const container = new docker.Container(
      `${name}-container`,
      {
        name: `openclaw-gateway-${args.profile}`,
        image: args.imageName,
        restart: "unless-stopped",
        init: true,
        networkMode: pulumi.interpolate`container:${args.sidecarContainerName}`,
        envs: computedEnvs,
        command: [
          "openclaw",
          "gateway",
          "--bind",
          "loopback",
          "--port",
          `${args.port}`,
        ],
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
        volumes: [
          { volumeName: homeVolume.name, containerPath: "/home/node" },
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
          {
            hostPath: args.corefilePath,
            containerPath: COREDNS_CONTAINER_PATH,
            readOnly: true,
          },
        ],
        labels: [
          { label: "openclaw.init-hash", value: args.initHash },
          { label: "openclaw.config-hash", value: args.configHash },
        ],
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
