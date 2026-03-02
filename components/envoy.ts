import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import * as command from "@pulumi/command";
import {
  EgressRule,
  ENVOY_IMAGE,
  ENVOY_STATIC_IP,
  INTERNAL_NETWORK_SUBNET,
  INTERNAL_NETWORK_NAME,
  EGRESS_NETWORK_NAME,
  ENVOY_CONFIG_HOST_DIR,
} from "../config";
import { renderEnvoyConfig } from "../templates";

export interface EnvoyEgressArgs {
  /** Docker host URI, e.g. "ssh://root@<ip>" */
  dockerHost: pulumi.Input<string>;
  /** SSH connection args for remote commands (writing config files to host) */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Egress policy rules (merged with hardcoded infrastructure domains) */
  egressPolicy: EgressRule[];
}

export class EnvoyEgress extends pulumi.ComponentResource {
  /** Static IP of the Envoy container on the internal network */
  public readonly envoyIP: pulumi.Output<string>;
  /** Internal network ID (internal: true, gateway containers attach here) */
  public readonly internalNetworkId: pulumi.Output<string>;
  /** Internal network name */
  public readonly internalNetworkName: pulumi.Output<string>;
  /** Egress network ID (Envoy + CLI containers attach here) */
  public readonly egressNetworkId: pulumi.Output<string>;
  /** Egress network name */
  public readonly egressNetworkName: pulumi.Output<string>;
  /** Envoy container ID */
  public readonly containerId: pulumi.Output<string>;
  /** Warnings from egress policy rendering (e.g. unsupported rule types) */
  public readonly warnings: string[];

  constructor(
    name: string,
    args: EnvoyEgressArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:infra:EnvoyEgress", name, {}, opts);

    // Render envoy config from egress policy (pure function, runs at plan time)
    const envoyConfig = renderEnvoyConfig(args.egressPolicy);
    this.warnings = envoyConfig.warnings;

    // Docker provider connected to the remote host
    const dockerProvider = new docker.Provider(
      `${name}-docker`,
      { host: args.dockerHost },
      { parent: this },
    );

    // Step 1: Create the internal network (internal: true — no default route)
    const internalNetwork = new docker.Network(
      `${name}-internal`,
      {
        name: INTERNAL_NETWORK_NAME,
        internal: true,
        driver: "bridge",
        ipamConfigs: [{ subnet: INTERNAL_NETWORK_SUBNET }],
      },
      { parent: this, provider: dockerProvider },
    );

    // Step 2: Create the egress network (Envoy + CLI containers)
    const egressNetwork = new docker.Network(
      `${name}-egress`,
      {
        name: EGRESS_NETWORK_NAME,
        driver: "bridge",
      },
      { parent: this, provider: dockerProvider },
    );

    // Step 3: Write envoy.yaml to host via remote command.
    // Uses base64 encoding to safely transfer content without heredoc
    // injection risks from user-provided domain strings in the egress policy.
    const configPath = `${ENVOY_CONFIG_HOST_DIR}/envoy.yaml`;
    const encodedConfig = Buffer.from(envoyConfig.yaml).toString("base64");
    const writeEnvoyConfig = new command.remote.Command(
      `${name}-write-config`,
      {
        connection: args.connection,
        create: `mkdir -p ${ENVOY_CONFIG_HOST_DIR} && echo '${encodedConfig}' | base64 -d > ${configPath}`,
        delete: `rm -f ${configPath} && rmdir --ignore-fail-on-non-empty ${ENVOY_CONFIG_HOST_DIR}`,
      },
      { parent: this },
    );

    // Step 4: Create the Envoy container
    const envoyContainer = new docker.Container(
      `${name}-envoy`,
      {
        name: "envoy",
        image: ENVOY_IMAGE,
        restart: "unless-stopped",
        // Envoy runs as non-root 'envoy' user — allow binding to port 53
        sysctls: { "net.ipv4.ip_unprivileged_port_start": "53" },
        networksAdvanced: [
          {
            name: internalNetwork.name,
            ipv4Address: ENVOY_STATIC_IP,
          },
          {
            name: egressNetwork.name,
          },
        ],
        volumes: [
          {
            hostPath: configPath,
            containerPath: "/etc/envoy/envoy.yaml",
            readOnly: true,
          },
        ],
      },
      {
        parent: this,
        provider: dockerProvider,
        dependsOn: [writeEnvoyConfig, internalNetwork, egressNetwork],
      },
    );

    // Outputs
    this.envoyIP = pulumi.output(ENVOY_STATIC_IP);
    this.internalNetworkId = internalNetwork.id;
    this.internalNetworkName = internalNetwork.name;
    this.egressNetworkId = egressNetwork.id;
    this.egressNetworkName = egressNetwork.name;
    this.containerId = envoyContainer.id;

    this.registerOutputs({
      envoyIP: this.envoyIP,
      internalNetworkId: this.internalNetworkId,
      internalNetworkName: this.internalNetworkName,
      egressNetworkId: this.egressNetworkId,
      egressNetworkName: this.egressNetworkName,
      containerId: this.containerId,
      warnings: this.warnings,
    });
  }
}
