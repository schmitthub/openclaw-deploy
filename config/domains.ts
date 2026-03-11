import { EgressRule } from "./types";

// Infrastructure domains — always allowed, cannot be removed
export const INFRASTRUCTURE_DOMAINS: EgressRule[] = [
  { dst: "clawhub.com", proto: "tls", action: "allow" },
  { dst: "registry.npmjs.org", proto: "tls", action: "allow" },
  { dst: "api.search.brave.com", proto: "tls", action: "allow" },
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

// Tailscale TLS domains — wildcard covers control plane, login, logging, and all DERP relays.
// Tailscale runs in a sidecar container with direct UDP access (owner-match iptables),
// so *.tailscale.com is safe: even if a compromised agent resolves a Tailscale subdomain,
// it cannot send UDP (only root/tailscaled can). TCP to *.tailscale.com goes through Envoy
// SNI passthrough — connecting to an attacker-controlled Tailscale subdomain over TLS is
// harmless (no data exfiltration path without UDP/WireGuard).
export const TAILSCALE_TLS_DOMAINS: EgressRule[] = [
  { dst: "*.tailscale.com", proto: "tls", action: "allow" },
  // Let's Encrypt ACME — Tailscale Serve provisions TLS certs via ACME
  { dst: "*.api.letsencrypt.org", proto: "tls", action: "allow" },
];

// All hardcoded rules combined (prepended to user policy)
export const HARDCODED_EGRESS_RULES: EgressRule[] = [
  ...INFRASTRUCTURE_DOMAINS,
  ...AI_PROVIDER_DOMAINS,
  ...HOMEBREW_DOMAINS,
  ...TAILSCALE_TLS_DOMAINS,
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
