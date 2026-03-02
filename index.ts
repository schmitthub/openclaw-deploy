import * as pulumi from "@pulumi/pulumi";
import { Server, HostBootstrap, EnvoyEgress, Gateway } from "./components";
import { EgressRule, GatewayConfig, VpsProvider } from "./config/types";

// --- Pulumi Config ---

const cfg = new pulumi.Config();

// VPS — validate provider at config load time for clear error messages
const VALID_PROVIDERS: VpsProvider[] = ["hetzner", "digitalocean", "oracle"];
const providerRaw = cfg.require("provider");
if (!VALID_PROVIDERS.includes(providerRaw as VpsProvider)) {
  throw new Error(
    `Invalid provider "${providerRaw}". Must be one of: ${VALID_PROVIDERS.join(", ")}`,
  );
}
const provider = providerRaw as VpsProvider;
const serverType = cfg.require("serverType");
const region = cfg.require("region");
const sshKeyId = cfg.require("sshKeyId");

// OCI-specific config (required when provider === "oracle")
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
  region,
  sshKeyId,
  ...(compartmentId && { compartmentId }),
  ...(subnetId && { subnetId }),
  ...(ocpus !== undefined && { ocpus }),
  ...(memoryInGbs !== undefined && { memoryInGbs }),
});

// 2. Install Docker + Tailscale on the host
const bootstrap = new HostBootstrap("bootstrap", {
  connection: server.connection,
  tailscaleAuthKey,
});

// After bootstrap, use Tailscale IP for all SSH commands. The public IP may be
// firewalled once Tailscale is up — routing through the tailnet is more reliable.
const tsConnection = bootstrap.tailscaleIP.apply((ip) => ({
  host: ip,
  user: "root",
}));

// 3. Deploy egress proxy (Envoy + Docker networks)
const envoy = new EnvoyEgress(
  "envoy",
  {
    dockerHost: bootstrap.dockerHost,
    egressPolicy,
    connection: tsConnection,
  },
  { dependsOn: [bootstrap] },
);

// 4. Deploy gateway instances
const gatewayInstances = gateways.map((gw) => {
  const token = cfg.requireSecret(`gatewayToken-${gw.profile}`);
  return new Gateway(
    `gateway-${gw.profile}`,
    {
      dockerHost: bootstrap.dockerHost,
      connection: tsConnection,
      internalNetworkName: envoy.internalNetworkName,
      profile: gw.profile,
      version: gw.version,
      packages: gw.packages,
      port: gw.port,
      bridgePort: gw.bridgePort,
      tailscale: gw.tailscale,
      installBrowser: gw.installBrowser,
      configSet: gw.configSet ?? {},
      env: gw.env,
      auth: { mode: "token", token },
    },
    { dependsOn: [envoy] },
  );
});

// --- Stack Exports ---

export const serverIp = server.ipAddress;
export const tailscaleIp = bootstrap.tailscaleIP;
export const envoyIp = envoy.envoyIP;
export const envoyWarnings = envoy.warnings;
export const gatewayUrls = gatewayInstances.map((g) => g.tailscaleUrl);
