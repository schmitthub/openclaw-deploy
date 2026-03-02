// Egress policy types

export interface PathRule {
  path: string; // glob: "/messages/*", "/api/dm/*"
  action: "allow" | "deny";
}

export interface EgressRule {
  dst: string; // domain "x.com" | IP "140.82.121.4" | CIDR "10.0.0.0/24"
  proto: "tls" | "ssh" | "tcp"; // ssh/tcp reserved for future port-based rules
  port?: number; // required for ssh/ftp/tcp, optional for tls/http (defaults 443/80)
  action: "allow" | "deny";
  inspect?: boolean; // MITM TLS termination for path-level rules
  pathRules?: PathRule[]; // when inspect=true
}

// VPS provider type
export type VpsProvider = "hetzner" | "digitalocean" | "oracle";

// Tailscale mode per gateway
export type TailscaleMode = "serve" | "funnel" | "off";

// Gateway configuration
export interface GatewayConfig {
  profile: string; // unique name for this gateway instance
  version: string; // openclaw version (npm dist-tag or semver)
  packages: string[]; // apt packages to bake into image
  port: number; // host port (maps to 18789 inside container)
  bridgePort?: number; // bridge port (defaults 18790)
  tailscale: TailscaleMode;
  installBrowser?: boolean; // bake Playwright + Chromium (~300MB)
  configSet: Record<string, string>; // openclaw config set key=value pairs
  env?: Record<string, string>; // additional env vars for container
}

// Full stack configuration
export interface StackConfig {
  // VPS
  provider: VpsProvider;
  serverType: string; // e.g. "cx22" (Hetzner), "s-1vcpu-1gb" (DO)
  region: string; // e.g. "fsn1", "nyc1"
  sshKeyId: string; // provider-specific SSH key ID or fingerprint

  // Tailscale
  tailscaleAuthKey: string; // secret: one-time auth key

  // Egress
  egressPolicy: EgressRule[];

  // Gateways (1+)
  gateways: [GatewayConfig, ...GatewayConfig[]];
}
