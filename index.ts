import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { Server, HostBootstrap, EnvoyEgress, Gateway } from "./components";
import type { EgressRule, GatewayConfig, VpsProvider } from "./config/types";
import { PROVIDERS } from "./config/defaults";

// --- Pulumi Config ---

const cfg = new pulumi.Config();

// VPS — validate provider at config load time for clear error messages
const providerRaw = cfg.require("provider");
if (!(PROVIDERS as readonly string[]).includes(providerRaw)) {
  throw new Error(
    `Invalid provider "${providerRaw}". Must be one of: ${PROVIDERS.join(", ")}`,
  );
}
const provider = providerRaw as VpsProvider;

// OCI-specific config validation (fail early with clear error messages)
if (provider === "oracle") {
  if (!cfg.get("compartmentId"))
    throw new Error(
      'Oracle provider requires "compartmentId" in stack config.',
    );
}

const serverType = cfg.require("serverType");
const region = cfg.get("region"); // Required for Hetzner/DO. Oracle auto-discovers AD if omitted.
if (provider !== "oracle" && !region) {
  throw new Error(`Region is required for provider "${provider}".`);
}
const sshKeyId = cfg.get("sshKeyId"); // Optional: auto-generates SSH key if omitted

// OCI-specific config (optional — auto-provisioned if omitted)
const compartmentId = cfg.get("compartmentId");
const subnetId = cfg.get("subnetId");
const ocpus = cfg.getNumber("ocpus");
const memoryInGbs = cfg.getNumber("memoryInGbs");

// Tailscale
const tailscaleAuthKey = cfg.requireSecret("tailscaleAuthKey");

// Egress policy — user-defined rules (additive to hardcoded infrastructure domains)
const egressPolicy = cfg.requireObject<EgressRule[]>("egressPolicy");

// Gateways — one or more gateway profiles per server
const gateways = cfg.requireObject<GatewayConfig[]>("gateways");

// Validate gateway profiles are unique (duplicates cause Pulumi resource name collisions)
const profileNames = gateways.map((gw) => gw.profile);
const duplicates = profileNames.filter((p, i) => profileNames.indexOf(p) !== i);
if (duplicates.length > 0) {
  throw new Error(
    `Duplicate gateway profiles: ${[...new Set(duplicates)].join(", ")}. Each profile must be unique.`,
  );
}

// --- Component Composition ---
// Server → HostBootstrap → EnvoyEgress → Gateway(s)
// Each component depends on the previous one via explicit resource dependencies.

// 1. Provision VPS
const server = new Server("server", {
  provider,
  serverType,
  ...(region && { region }),
  ...(sshKeyId && { sshKeyId }),
  ...(compartmentId && { compartmentId }),
  ...(subnetId && { subnetId }),
  ...(ocpus !== undefined && { ocpus }),
  ...(memoryInGbs !== undefined && { memoryInGbs }),
});

// 2. Install Docker + fail2ban on the host (Tailscale runs inside gateway containers)
const bootstrap = new HostBootstrap("bootstrap", {
  connection: server.connection,
});

// 3. Deploy egress proxy (Envoy + Docker networks)
const envoy = new EnvoyEgress(
  "envoy",
  {
    dockerHost: bootstrap.dockerHost,
    egressPolicy,
    connection: server.connection,
  },
  { dependsOn: [bootstrap] },
);

// Surface egress policy warnings during pulumi up
for (const w of envoy.warnings) {
  pulumi.log.warn(`Egress policy: ${w}`);
}

// 4. Deploy gateway instances
const gatewayInstances = gateways.map((gw) => {
  // Auto-generate gateway token if not manually set. Stored in Pulumi state
  // (encrypted), stable across deploys. Manual override via config is optional.
  const manualToken = cfg.getSecret(`gatewayToken-${gw.profile}`);
  const generatedToken = new random.RandomPassword(
    `gateway-token-${gw.profile}`,
    { length: 32, special: false },
  );
  const token = manualToken ?? generatedToken.result;

  const secretEnv = cfg.getSecret(`gatewaySecretEnv-${gw.profile}`);
  const gateway = new Gateway(
    `gateway-${gw.profile}`,
    {
      dockerHost: bootstrap.dockerHost,
      connection: server.connection,
      internalNetworkName: envoy.internalNetworkName,
      profile: gw.profile,
      version: gw.version,
      port: gw.port,
      installBrowser: gw.installBrowser,
      imageSteps: gw.imageSteps,
      setupCommands: gw.setupCommands,
      env: gw.env,
      secretEnv,
      auth: { mode: "token", token },
      tcpPortMappings: envoy.tcpPortMappings,
      udpPortMappings: envoy.udpPortMappings,
      tailscaleAuthKey: tailscaleAuthKey,
    },
    { dependsOn: [envoy] },
  );
  return { gateway, token };
});

// --- Stack Exports ---

export const serverIp = server.ipAddress;
export const envoyIp = envoy.envoyIP;
export const envoyWarnings = envoy.warnings;
export const gatewayUrls = gatewayInstances.map((g) => g.gateway.tailscaleUrl);
export const gatewayTokens = pulumi.secret(
  pulumi.all(
    gatewayInstances.map((g, i) =>
      pulumi
        .output(g.token)
        .apply((t) => ({ profile: gateways[i].profile, token: t })),
    ),
  ),
);
