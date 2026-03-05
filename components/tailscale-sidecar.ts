import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import * as command from "@pulumi/command";
import * as crypto from "crypto";
import {
  CLOUDFLARE_DNS_PRIMARY,
  CLOUDFLARE_DNS_SECONDARY,
  ENVOY_UID,
  SSHD_PORT,
  TAILSCALE_HEALTH_PORT,
  TAILSCALE_IMAGE,
  TAILSCALE_STATE_DIR,
  buildDir,
  dataDir,
} from "../config";
import {
  renderSidecarEntrypoint,
  renderServeConfig,
  TcpPortMapping,
} from "../templates";

export interface TailscaleSidecarArgs {
  /** SSH connection args for remote commands */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Docker host URI, e.g. "ssh://root@<ip>" */
  dockerHost: pulumi.Input<string>;
  /** Unique name for this gateway instance */
  profile: string;
  /** Gateway port (for Tailscale Serve config rendering) */
  port: number;
  /** Secret: Tailscale auth key */
  tailscaleAuthKey: pulumi.Input<string>;
  /** Per-rule port mappings for SSH/TCP egress (from EnvoyEgress) */
  tcpPortMappings?: TcpPortMapping[];
}

export class TailscaleSidecar extends pulumi.ComponentResource {
  /** Container name, e.g. "tailscale-dev" — used for network_mode by downstream containers */
  public readonly containerName: string;
  /** Tailscale hostname resolved after authentication, e.g. "openclaw.tail1234.ts.net" */
  public readonly tailscaleHostname: pulumi.Output<string>;
  /** Bridge network name, e.g. "openclaw-net-dev" */
  public readonly networkName: pulumi.Output<string>;

  constructor(
    name: string,
    args: TailscaleSidecarArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:net:TailscaleSidecar", name, {}, opts);

    const bDir = buildDir(args.profile);
    const dDir = dataDir(args.profile);
    const sidecarName = `tailscale-${args.profile}`;
    this.containerName = sidecarName;

    // Render sidecar templates (pure functions, runs at plan time)
    const sidecarEntrypoint = renderSidecarEntrypoint();
    const serveConfig = renderServeConfig(args.port, SSHD_PORT);

    // Docker provider connected to the remote host
    const dockerProvider = new docker.Provider(
      `${name}-docker`,
      { host: args.dockerHost },
      { parent: this },
    );

    // Create the tailscale state directory on the remote host
    const createStateDir = new command.remote.Command(
      `${name}-state-dir`,
      {
        connection: args.connection,
        create: `mkdir -p ${dDir}/tailscale`,
        delete: `rm -rf ${dDir}/tailscale`,
      },
      { parent: this },
    );

    // Upload sidecar files to the remote host
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
          `set -euo pipefail`,
          `mkdir -p ${bDir}`,
          `echo '${encodedSidecar}' | base64 -d > ${bDir}/sidecar-entrypoint.sh`,
          `echo '${encodedServeConfig}' | base64 -d > ${bDir}/serve-config.json`,
          `chmod 755 ${bDir}/sidecar-entrypoint.sh`,
          `[ -s ${bDir}/sidecar-entrypoint.sh ] && [ -s ${bDir}/serve-config.json ]`,
          `true # content-hash=${sidecarContentHash}`,
        ].join(" && "),
        delete: `rm -f ${bDir}/sidecar-entrypoint.sh ${bDir}/serve-config.json`,
      },
      { parent: this },
    );

    // Bridge network — NOT internal: true (sidecar needs internet for Envoy upstreams)
    const bridgeNetwork = new docker.Network(
      `${name}-network`,
      {
        name: `openclaw-net-${args.profile}`,
        driver: "bridge",
      },
      { parent: this, provider: dockerProvider },
    );
    this.networkName = bridgeNetwork.name;

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

    // Content hash for sidecar — forces replacement when sidecar entrypoint or serve config changes
    const sidecarHash = crypto
      .createHash("sha256")
      .update(sidecarEntrypoint)
      .update(serveConfig)
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
            "CMD-SHELL",
            `wget -q --spider http://localhost:${TAILSCALE_HEALTH_PORT}/healthz || wget -q --spider http://127.0.0.1:${TAILSCALE_HEALTH_PORT}/healthz`,
          ],
          interval: "10s",
          timeout: "3s",
          retries: 6,
          startPeriod: "45s",
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
        dependsOn: [uploadSidecarFiles, bridgeNetwork, createStateDir],
        additionalSecretOutputs: ["envs"],
      },
    );

    // Wait for sidecar to be healthy, capture Tailscale hostname.
    // "Healthy" means: Docker healthcheck passes + Tailscale authenticated + hostname available.
    const sidecarHealthy = new command.remote.Command(
      `${name}-sidecar-healthy`,
      {
        connection: args.connection,
        create: [
          // Wait for Docker healthcheck
          `for i in $(seq 1 60); do if [ "$(docker inspect --format='{{.State.Health.Status}}' ${sidecarName} 2>/dev/null)" = "healthy" ]; then break; fi; if [ "$i" = "60" ]; then echo "ERROR: Tailscale sidecar did not become healthy within 120s" >&2; exit 1; fi; sleep 2; done`,
          // Wait for Tailscale to authenticate
          `for i in $(seq 1 60); do docker exec ${sidecarName} tailscale status --json 2>/dev/null | jq -e '.BackendState == "Running"' >/dev/null 2>&1 && break; if [ "$i" = "60" ]; then echo "ERROR: Tailscale did not reach Running state in 120s" >&2; exit 1; fi; sleep 2; done`,
          // Capture and validate hostname
          `TS_HOST=$(docker exec ${sidecarName} tailscale status --json | jq -r '.Self.DNSName' | sed 's/\\.$//')`,
          `if [ -z "$TS_HOST" ] || ! echo "$TS_HOST" | grep -q '\\.'; then echo "ERROR: Failed to capture valid Tailscale hostname (got: '$TS_HOST')" >&2; exit 1; fi`,
          `echo "$TS_HOST"`,
        ].join(" && "),
        triggers: [sidecarContainer.id],
      },
      { parent: this, dependsOn: [sidecarContainer] },
    );

    this.tailscaleHostname = sidecarHealthy.stdout.apply((s) => s.trim());

    this.registerOutputs({
      containerName: this.containerName,
      tailscaleHostname: this.tailscaleHostname,
      networkName: this.networkName,
    });
  }
}
