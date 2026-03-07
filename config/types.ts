// Egress policy types

export interface PathRule {
  path: string; // trailing "*" → Envoy prefix match; otherwise exact match. e.g. "/messages/*", "/health"
  action: "deny"; // deny matching paths; omit paths to allow them
}

export interface EgressRule {
  dst: string; // domain "x.com" | wildcard "*.example.com" | IPv4 "140.82.121.4" | IPv6 "2001:db8::1" | CIDR "10.0.0.0/24"
  proto: "tls" | "ssh" | "tcp"; // tls: SNI-based passthrough or MITM inspection; ssh/tcp: per-rule Envoy port mapping
  port?: number; // required for ssh/tcp, optional for tls (default 443)
  action: "allow" | "deny";
  inspect?: boolean; // MITM TLS termination for path-level filtering (supports wildcard domains)
  pathRules?: PathRule[]; // when inspect=true
}

// VPS provider type (derived from PROVIDERS constant in defaults.ts)
import { PROVIDERS } from "./defaults";
export type VpsProvider = (typeof PROVIDERS)[number];

// Custom Dockerfile RUN instructions (placed after openclaw install, before entrypoint COPY).
// Always run as root — user-mode package managers are installed at runtime via home mount.
export interface ImageStep {
  run: string;
}

// Gateway configuration
export interface GatewayConfig {
  profile: string; // unique name for this gateway instance
  version: string; // openclaw version (npm dist-tag or semver)
  port: number; // gateway port inside container
  installBrowser?: boolean; // bake Playwright + Chromium (~300MB)
  imageSteps?: ImageStep[]; // custom Dockerfile RUN instructions
  setupCommands?: string[]; // openclaw subcommands run in init container (e.g. 'onboard ...')
  env?: Record<string, string>; // additional env vars for container
}

// Per-rule port mapping for SSH/TCP egress (passed to sidecar container via OPENCLAW_TCP_MAPPINGS)
export interface TcpPortMapping {
  /** Destination domain or IP */
  dst: string;
  /** Destination port (e.g. 22 for SSH, 5432 for PostgreSQL) */
  dstPort: number;
  /** Protocol from the egress rule */
  proto: "ssh" | "tcp";
  /** Dedicated Envoy listener port for this mapping */
  envoyPort: number;
}

// Full stack configuration
export interface StackConfig {
  // VPS
  provider: VpsProvider;
  serverType: string; // e.g. "cx22" (Hetzner), "s-1vcpu-1gb" (DO), "VM.Standard.A1.Flex" (OCI)
  region?: string; // Required for Hetzner/DO. Oracle auto-discovers availability domain if omitted.
  sshKeyId?: string; // provider-specific SSH key ID or fingerprint (auto-generated if omitted)

  // Tailscale
  tailscaleAuthKey: string; // secret: one-time auth key

  // Egress
  egressPolicy: EgressRule[];

  // Build
  dockerhubPush?: boolean; // build locally + push to Docker Hub (default: false)

  // Gateways (1+)
  gateways: [GatewayConfig, ...GatewayConfig[]];
}
