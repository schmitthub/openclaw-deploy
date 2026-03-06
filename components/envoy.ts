import * as crypto from "crypto";
import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import {
  EgressRule,
  ENVOY_CONFIG_HOST_DIR,
  ENVOY_CA_CERT_PATH,
  ENVOY_CA_KEY_PATH,
  ENVOY_MITM_CERTS_HOST_DIR,
  COREDNS_CONFIG_HOST_DIR,
} from "../config";
import {
  renderEnvoyConfig,
  renderCorefile,
  TcpPortMapping,
} from "../templates";

export interface EnvoyEgressArgs {
  /** SSH connection args for remote commands (writing config files to host) */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Egress policy rules (merged with hardcoded infrastructure domains) */
  egressPolicy: EgressRule[];
}

/**
 * EnvoyEgress renders the Envoy config and manages certificates on the remote host.
 *
 * In the reference architecture, Envoy runs as a per-gateway container (created by EnvoyProxy),
 * not as a shared singleton. This component only handles config rendering and cert generation.
 */
export class EnvoyEgress extends pulumi.ComponentResource {
  /** Host path to the uploaded envoy.yaml */
  public readonly envoyConfigPath: pulumi.Output<string>;
  /** Host path to the uploaded Corefile (CoreDNS allowlist config) */
  public readonly corefilePath: pulumi.Output<string>;
  /** Host path to the CA certificate (for gateway NODE_EXTRA_CA_CERTS) */
  public readonly caCertPath: pulumi.Output<string>;
  /** Domains with MITM TLS inspection enabled (need per-domain certs) */
  public readonly inspectedDomains: string[];
  /** Per-rule port mappings for SSH/TCP egress (passed to sidecar container via OPENCLAW_TCP_MAPPINGS) */
  public readonly tcpPortMappings: TcpPortMapping[];
  /** Warnings from egress policy rendering (e.g. unsupported rule types) */
  public readonly warnings: string[];
  /** SHA256 hash (12 chars) of rendered configs — triggers container replacement on config change */
  public readonly configHash: string;

  constructor(
    name: string,
    args: EnvoyEgressArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:infra:EnvoyEgress", name, {}, opts);

    // Render envoy config + Corefile from egress policy (pure functions, run at plan time)
    const envoyConfig = renderEnvoyConfig(args.egressPolicy);
    const corefile = renderCorefile(args.egressPolicy);
    this.inspectedDomains = envoyConfig.inspectedDomains;
    this.tcpPortMappings = envoyConfig.tcpPortMappings;
    this.warnings = envoyConfig.warnings;
    this.configHash = crypto
      .createHash("sha256")
      .update(envoyConfig.yaml + corefile)
      .digest("hex")
      .slice(0, 12);

    // Step 1: Write envoy.yaml to host via remote command.
    // Uses base64 encoding to safely transfer content without heredoc
    // injection risks from user-provided domain strings in the egress policy.
    const configPath = `${ENVOY_CONFIG_HOST_DIR}/envoy.yaml`;
    const encodedConfig = Buffer.from(envoyConfig.yaml).toString("base64");
    new command.remote.Command(
      `${name}-write-config`,
      {
        connection: args.connection,
        create: `set -euo pipefail && mkdir -p ${ENVOY_CONFIG_HOST_DIR} && echo '${encodedConfig}' | base64 -d > ${configPath} && [ -s ${configPath} ]`,
        delete: `rm -f ${configPath} && rmdir --ignore-fail-on-non-empty ${ENVOY_CONFIG_HOST_DIR}`,
      },
      { parent: this },
    );

    // Step 1b: Write Corefile (CoreDNS allowlist config) to host.
    const corefilePath = `${COREDNS_CONFIG_HOST_DIR}/Corefile`;
    const encodedCorefile = Buffer.from(corefile).toString("base64");
    new command.remote.Command(
      `${name}-write-corefile`,
      {
        connection: args.connection,
        create: `set -euo pipefail && mkdir -p ${COREDNS_CONFIG_HOST_DIR} && echo '${encodedCorefile}' | base64 -d > ${corefilePath} && [ -s ${corefilePath} ]`,
        delete: `rm -f ${corefilePath} && rmdir --ignore-fail-on-non-empty ${COREDNS_CONFIG_HOST_DIR}`,
      },
      { parent: this },
    );

    // Step 2: Generate CA certificate for MITM TLS inspection (idempotent).
    // Only generates if cert doesn't already exist. Used to sign per-domain
    // certs (Step 2b) and trusted by gateway containers via NODE_EXTRA_CA_CERTS.
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

    // Step 2b: Generate per-domain certificates for MITM inspection (idempotent).
    const HOSTNAME_RE =
      /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    for (const domain of envoyConfig.inspectedDomains) {
      if (!HOSTNAME_RE.test(domain)) {
        throw new Error(`Invalid domain for MITM cert generation: ${domain}`);
      }
      const safeName = domain.replace(/\./g, "-");
      const certPath = `${ENVOY_MITM_CERTS_HOST_DIR}/${domain}-cert.pem`;
      const keyPath = `${ENVOY_MITM_CERTS_HOST_DIR}/${domain}-key.pem`;

      new command.remote.Command(
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
    }

    // Outputs
    this.envoyConfigPath = pulumi.output(configPath);
    this.corefilePath = pulumi.output(corefilePath);
    this.caCertPath = pulumi.output(ENVOY_CA_CERT_PATH);

    this.registerOutputs({
      envoyConfigPath: this.envoyConfigPath,
      corefilePath: this.corefilePath,
      caCertPath: this.caCertPath,
      configHash: this.configHash,
      inspectedDomains: this.inspectedDomains,
      tcpPortMappings: this.tcpPortMappings,
      warnings: this.warnings,
    });
  }
}
