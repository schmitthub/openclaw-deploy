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
  ENVOY_CA_CERT_PATH,
  ENVOY_CA_KEY_PATH,
  ENVOY_MITM_CERTS_HOST_DIR,
  ENVOY_MITM_CERTS_CONTAINER_DIR,
} from "../config";
import {
  renderEnvoyConfig,
  TcpPortMapping,
  UdpPortMapping,
} from "../templates";

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
  /** Egress network ID (Envoy attaches here for internet access) */
  public readonly egressNetworkId: pulumi.Output<string>;
  /** Egress network name */
  public readonly egressNetworkName: pulumi.Output<string>;
  /** Envoy container ID */
  public readonly containerId: pulumi.Output<string>;
  /** Host path to the CA certificate (for gateway NODE_EXTRA_CA_CERTS) */
  public readonly caCertPath: pulumi.Output<string>;
  /** Domains with MITM TLS inspection enabled (need per-domain certs) */
  public readonly inspectedDomains: string[];
  /** Per-rule port mappings for SSH/TCP egress (passed to gateway containers) */
  public readonly tcpPortMappings: TcpPortMapping[];
  /** Per-rule port mappings for UDP egress (passed to gateway containers) */
  public readonly udpPortMappings: UdpPortMapping[];
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
    this.inspectedDomains = envoyConfig.inspectedDomains;
    this.tcpPortMappings = envoyConfig.tcpPortMappings;
    this.udpPortMappings = envoyConfig.udpPortMappings;
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

    // Step 4: Generate CA certificate for MITM TLS inspection (idempotent).
    // Only generates if cert doesn't already exist. Used to sign per-domain
    // certs (Step 4b) and trusted by gateway containers via NODE_EXTRA_CA_CERTS.
    const generateCA = new command.remote.Command(
      `${name}-generate-ca`,
      {
        connection: args.connection,
        create: [
          `mkdir -p ${ENVOY_CONFIG_HOST_DIR}`,
          `[ -f ${ENVOY_CA_CERT_PATH} -a -f ${ENVOY_CA_KEY_PATH} ] || (openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -nodes -subj "/CN=OpenClaw Egress CA" -keyout ${ENVOY_CA_KEY_PATH} -out ${ENVOY_CA_CERT_PATH} && chmod 644 ${ENVOY_CA_CERT_PATH} && chmod 600 ${ENVOY_CA_KEY_PATH})`,
        ].join(" && "),
        delete: `rm -f ${ENVOY_CA_CERT_PATH} ${ENVOY_CA_KEY_PATH}`,
      },
      { parent: this },
    );

    // Step 4b: Generate per-domain certificates for MITM inspection (idempotent).
    // Each inspected domain gets a cert signed by the CA. Uses temp files for the
    // SAN extension and CSR to avoid process substitution (portability).
    const domainCertCommands: command.remote.Command[] = [];
    const HOSTNAME_RE =
      /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    for (const domain of envoyConfig.inspectedDomains) {
      if (!HOSTNAME_RE.test(domain)) {
        throw new Error(`Invalid domain for MITM cert generation: ${domain}`);
      }
      const safeName = domain.replace(/\./g, "-");
      const certPath = `${ENVOY_MITM_CERTS_HOST_DIR}/${domain}-cert.pem`;
      const keyPath = `${ENVOY_MITM_CERTS_HOST_DIR}/${domain}-key.pem`;

      const genCert = new command.remote.Command(
        `${name}-cert-${safeName}`,
        {
          connection: args.connection,
          create: [
            `mkdir -p ${ENVOY_MITM_CERTS_HOST_DIR}`,
            `[ -f "${certPath}" ] || (` +
              `openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes` +
              ` -subj "/CN=${domain}" -keyout "${keyPath}" -out "/tmp/${domain}.csr"` +
              ` && printf "subjectAltName=DNS:${domain}" > "/tmp/${domain}.ext"` +
              ` && openssl x509 -req -in "/tmp/${domain}.csr"` +
              ` -CA ${ENVOY_CA_CERT_PATH} -CAkey ${ENVOY_CA_KEY_PATH}` +
              ` -CAcreateserial -days 365 -extfile "/tmp/${domain}.ext"` +
              ` -out "${certPath}"` +
              ` && rm -f "/tmp/${domain}.csr" "/tmp/${domain}.ext"` +
              ` && chmod 644 "${certPath}" && chmod 600 "${keyPath}"` +
              `)`,
          ].join(" && "),
          delete: `rm -f ${certPath} ${keyPath}`,
        },
        { parent: this, dependsOn: [generateCA] },
      );
      domainCertCommands.push(genCert);
    }

    // Step 5: Create the Envoy container
    const envoyContainer = new docker.Container(
      `${name}-envoy`,
      {
        name: "envoy",
        image: ENVOY_IMAGE,
        restart: "unless-stopped",
        // Envoy runs as non-root 'envoy' user — allow binding to port 53
        sysctls: { "net.ipv4.ip_unprivileged_port_start": "53" },
        healthcheck: {
          tests: ["CMD", "bash", "-c", "echo > /dev/tcp/localhost/10000"],
          interval: "5s",
          timeout: "3s",
          retries: 5,
          startPeriod: "5s",
        },
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
          {
            hostPath: ENVOY_CA_CERT_PATH,
            containerPath: "/etc/envoy/ca-cert.pem",
            readOnly: true,
          },
          ...(envoyConfig.inspectedDomains.length > 0
            ? [
                {
                  hostPath: ENVOY_MITM_CERTS_HOST_DIR,
                  containerPath: ENVOY_MITM_CERTS_CONTAINER_DIR,
                  readOnly: true,
                },
              ]
            : []),
        ],
      },
      {
        parent: this,
        provider: dockerProvider,
        dependsOn: [
          writeEnvoyConfig,
          generateCA,
          ...domainCertCommands,
          internalNetwork,
          egressNetwork,
        ],
      },
    );

    // Outputs
    this.envoyIP = pulumi.output(ENVOY_STATIC_IP);
    this.internalNetworkId = internalNetwork.id;
    this.internalNetworkName = internalNetwork.name;
    this.egressNetworkId = egressNetwork.id;
    this.egressNetworkName = egressNetwork.name;
    this.containerId = envoyContainer.id;
    this.caCertPath = pulumi.output(ENVOY_CA_CERT_PATH);

    this.registerOutputs({
      envoyIP: this.envoyIP,
      internalNetworkId: this.internalNetworkId,
      internalNetworkName: this.internalNetworkName,
      egressNetworkId: this.egressNetworkId,
      egressNetworkName: this.egressNetworkName,
      containerId: this.containerId,
      caCertPath: this.caCertPath,
      inspectedDomains: this.inspectedDomains,
      tcpPortMappings: this.tcpPortMappings,
      udpPortMappings: this.udpPortMappings,
      warnings: this.warnings,
    });
  }
}
