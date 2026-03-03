import { EgressRule } from "./types";

// Infrastructure domains — always allowed, cannot be removed
export const INFRASTRUCTURE_DOMAINS: EgressRule[] = [
  { dst: "clawhub.com", proto: "tls", action: "allow" },
  { dst: "registry.npmjs.org", proto: "tls", action: "allow" },
];

// AI provider domains — always allowed
export const AI_PROVIDER_DOMAINS: EgressRule[] = [
  { dst: "api.anthropic.com", proto: "tls", action: "allow" },
  { dst: "api.openai.com", proto: "tls", action: "allow" },
  { dst: "generativelanguage.googleapis.com", proto: "tls", action: "allow" },
  { dst: "openrouter.ai", proto: "tls", action: "allow" },
  { dst: "api.x.ai", proto: "tls", action: "allow" },
];

// Homebrew (Linuxbrew) domains — always allowed
export const HOMEBREW_DOMAINS: EgressRule[] = [
  { dst: "github.com", proto: "tls", action: "allow" },
  { dst: "*.githubusercontent.com", proto: "tls", action: "allow" },
  { dst: "ghcr.io", proto: "tls", action: "allow" },
  { dst: "formulae.brew.sh", proto: "tls", action: "allow" },
];

// Tailscale TLS domains — control plane, login, logging, DERP relays (TCP 443).
// No wildcards: *.tailscale.com would allow attacker-controlled Tailscale networks.
// DERP relay list from https://tailscale.com/docs/reference/faq/firewall-ports (derp1–28).
// Tailscale activates new DERP regions dynamically — include all 28 to avoid connection resets.
const DERP_COUNT = 28;
export const TAILSCALE_TLS_DOMAINS: EgressRule[] = [
  { dst: "tailscale.com", proto: "tls", action: "allow" },
  { dst: "login.tailscale.com", proto: "tls", action: "allow" },
  { dst: "controlplane.tailscale.com", proto: "tls", action: "allow" },
  { dst: "log.tailscale.com", proto: "tls", action: "allow" },
  // Let's Encrypt ACME — Tailscale Serve provisions TLS certs via ACME
  { dst: "*.api.letsencrypt.org", proto: "tls", action: "allow" },
  // DERP relays on TCP 443 (DERP protocol over TLS, fallback when UDP is blocked)
  ...Array.from(
    { length: DERP_COUNT },
    (_, i): EgressRule => ({
      dst: `derp${i + 1}.tailscale.com`,
      proto: "tls",
      action: "allow",
    }),
  ),
];

// Tailscale DERP relay servers — STUN (UDP 3478) for NAT traversal.
// Each gets a dedicated Envoy UDP proxy listener, like SSH/TCP rules.
// List from https://tailscale.com/docs/reference/faq/firewall-ports (derp1–28 as of Aug 2025).
export const TAILSCALE_UDP_DOMAINS: EgressRule[] = Array.from(
  { length: DERP_COUNT },
  (_, i): EgressRule => ({
    dst: `derp${i + 1}.tailscale.com`,
    proto: "udp",
    port: 3478,
    action: "allow",
  }),
);

// All hardcoded rules combined (prepended to user policy)
export const HARDCODED_EGRESS_RULES: EgressRule[] = [
  ...INFRASTRUCTURE_DOMAINS,
  ...AI_PROVIDER_DOMAINS,
  ...HOMEBREW_DOMAINS,
  ...TAILSCALE_TLS_DOMAINS,
  ...TAILSCALE_UDP_DOMAINS,
];

// Merge user rules with hardcoded rules (hardcoded first, deduped by dst+proto+port)
export function mergeEgressPolicy(userRules: EgressRule[]): EgressRule[] {
  const seen = new Set<string>();
  const merged: EgressRule[] = [];
  for (const rule of [...HARDCODED_EGRESS_RULES, ...userRules]) {
    const key = `${rule.dst}:${rule.proto}:${rule.port ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(rule);
    }
  }
  return merged;
}
