import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as command from "@pulumi/command";
import * as crypto from "crypto";
import {
  Server,
  HostBootstrap,
  EnvoyEgress,
  GatewayImage,
  TailscaleSidecar,
  EnvoyProxy,
  GatewayInit,
  Gateway,
} from "./components";
import {
  validateHetznerConfig,
  type EgressRule,
  type GatewayConfig,
  type HetznerConfig,
  type VpsProvider,
} from "./config/types";
import { PROVIDERS } from "./config/defaults";
import { renderAgentPrompt } from "./templates";

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
// Server → HostBootstrap → {EnvoyEgress, GatewayImage, TailscaleSidecar} → EnvoyProxy → GatewayInit → Gateway

// Provider-specific config validation
const rawHetznerConfig = cfg.getObject<HetznerConfig>("hetzner");
let hetznerConfig: HetznerConfig | undefined;
if (rawHetznerConfig !== undefined) {
  const result = validateHetznerConfig(rawHetznerConfig, provider);
  for (const w of result.warnings) pulumi.log.warn(w);
  hetznerConfig = provider === "hetzner" ? result.config : undefined;
}

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
  hetzner: hetznerConfig,
});

// 2. Install Docker + fail2ban on the host (Tailscale runs inside gateway containers)
const bootstrap = new HostBootstrap("bootstrap", {
  connection: server.connection,
  autoUpdate: cfg.getBoolean("autoUpdate") ?? false,
});

// 3. Render egress config + generate certificates
const envoy = new EnvoyEgress(
  "envoy",
  {
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
    { length: 32, special: false, upper: false },
  );
  const token = manualToken ?? generatedToken.result;

  const secretEnv = cfg.getSecret(`gatewaySecretEnv-${gw.profile}`);

  // Build image: Docker Hub (dockerhubPush: true) or on-VPS via SSH (default).
  const image = new GatewayImage(
    `gateway-image-${gw.profile}`,
    {
      connection: server.connection,
      dockerHost: bootstrap.dockerHost,
      profile: gw.profile,
      version: gw.version,
      installBrowser: gw.installBrowser,
      imageSteps: gw.imageSteps,
      dockerhubPush: cfg.getBoolean("dockerhubPush"),
    },
    { dependsOn: [bootstrap] },
  );

  // Tailscale sidecar (bridge network + auth + hostname)
  const sidecar = new TailscaleSidecar(
    `gateway-ts-${gw.profile}`,
    {
      connection: server.connection,
      dockerHost: bootstrap.dockerHost,
      profile: gw.profile,
      port: gw.port,
      tailscaleAuthKey,
      tcpPortMappings: envoy.tcpPortMappings,
    },
    { dependsOn: [bootstrap] },
  );

  // Envoy proxy (egress, shares sidecar netns)
  const envoyProxy = new EnvoyProxy(
    `gateway-envoy-${gw.profile}`,
    {
      connection: server.connection,
      dockerHost: bootstrap.dockerHost,
      sidecarContainerName: sidecar.containerName,
      envoyConfigPath: envoy.envoyConfigPath,
      envoyConfigHash: envoy.configHash,
      inspectedDomains: envoy.inspectedDomains,
      profile: gw.profile,
    },
    { dependsOn: [sidecar, envoy] },
  );

  // Init containers (sequential config, needs hostname + image + envoy healthy)
  const init = new GatewayInit(
    `gateway-init-${gw.profile}`,
    {
      connection: server.connection,
      profile: gw.profile,
      imageName: image.imageName,
      setupCommands: [
        ...(gw.installBrowser
          ? [
              "config set browser.headless true",
              "config set browser.noSandbox true",
            ]
          : []),
        ...(gw.setupCommands ?? []),
        // Force agent constraints into context via bootstrap-extra-files hook
        "hooks enable bootstrap-extra-files",
        "config set hooks.internal.entries.bootstrap-extra-files.paths '[\"ocdeploy/AGENTS.md\"]'",
      ],
      secretEnv,
      gatewayToken: token,
      tailscaleHostname: sidecar.tailscaleHostname,
    },
    { dependsOn: [image, envoyProxy] },
  );

  // Gateway container (last — after everything)
  const gateway = new Gateway(
    `gateway-${gw.profile}`,
    {
      dockerHost: bootstrap.dockerHost,
      profile: gw.profile,
      port: gw.port,
      imageName: image.imageName,
      sidecarContainerName: sidecar.containerName,
      tailscaleHostname: sidecar.tailscaleHostname,
      corefilePath: envoy.corefilePath,
      env: gw.env,
      secretEnv,
      auth: { mode: "token", token },
      initHash: init.contentHash,
      configHash: envoy.configHash,
      imageDigest: image.imageDigest,
    },
    { dependsOn: [envoyProxy, init] },
  );

  // Post-deploy: write agent constraints to workspace/ocdeploy/AGENTS.md
  // Root-owned, read-only (444). Re-run only when content hash changes (Pulumi trigger).
  // Loaded into agent context via bootstrap-extra-files hook.
  const agentPromptContent = renderAgentPrompt();
  const agentPromptHash = crypto
    .createHash("sha256")
    .update(agentPromptContent)
    .digest("hex");
  const agentPromptB64 = Buffer.from(agentPromptContent).toString("base64");
  const containerName = `openclaw-gateway-${gw.profile}`;

  new command.remote.Command(
    `gateway-env-prompt-${gw.profile}`,
    {
      connection: server.connection,
      create: [
        `docker exec ${containerName} sh -c '`,
        `  set -e`,
        `  mkdir -p /home/node/.openclaw/workspace/ocdeploy`,
        `  echo "${agentPromptB64}" | base64 -d > /home/node/.openclaw/workspace/ocdeploy/AGENTS.md`,
        `  chown root:root /home/node/.openclaw/workspace/ocdeploy/AGENTS.md`,
        `  chmod 444 /home/node/.openclaw/workspace/ocdeploy/AGENTS.md`,
        `'`,
      ].join("\n"),
      triggers: [agentPromptHash],
    },
    { dependsOn: [gateway] },
  );

  return { gateway, token };
});

// --- Stack Exports ---

export const serverIp = server.ipAddress;
export const envoyWarnings = envoy.warnings;

// Per-gateway service URLs. The controlUi URL includes the gateway auth token as
// a query parameter so operators can open the Control UI directly after deploy.
//
// Why token-in-URL: OpenClaw's trusted-proxy auth mode breaks CLI→gateway calls
// (the CLI credential resolver skips token when mode=trusted-proxy), and Tailscale
// header auth short-circuits the token check causing device identity/pairing failures.
// Token mode with allowTailscale=false + dangerouslyDisableDeviceAuth=true is the
// only working auth strategy for headless Tailscale Serve deployments.
//
// Security mitigations for including the token in the URL:
// 1. pulumi.secret() — the entire output is encrypted in Pulumi state and masked
//    in `pulumi up` logs. Only `pulumi stack output --show-secrets` reveals it.
// 2. Tailscale Serve — the gateway is only reachable within the operator's tailnet.
//    An attacker needs both the token AND authenticated Tailscale access.
// 3. Token auth mode — gateway.auth.allowTailscale=false prevents Tailscale header
//    auth from bypassing the token check. The token is the sole auth credential.
export const gatewayServices = pulumi.secret(
  pulumi.all(
    gatewayInstances.map((g, i) =>
      pulumi
        .all([g.gateway.tailscaleUrl, pulumi.output(g.token)])
        .apply(([url, token]) => ({
          profile: gateways[i].profile,
          controlUi: `${url}#token=${token}`,
          browse: `${url}/browse/`,
          ssh: `ssh root@${url.replace("https://", "")}`,
        })),
    ),
  ),
);

// Remind users how to retrieve their gateway URLs (secret outputs are masked in console).
pulumi.log.info(
  "To view gateway URLs: pulumi stack output gatewayServices --show-secrets",
);
