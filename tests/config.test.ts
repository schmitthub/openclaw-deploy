import { describe, it, expect } from "vitest";
import {
  INFRASTRUCTURE_DOMAINS,
  AI_PROVIDER_DOMAINS,
  HOMEBREW_DOMAINS,
  TAILSCALE_TLS_DOMAINS,
  TAILSCALE_UDP_DOMAINS,
  HARDCODED_EGRESS_RULES,
  mergeEgressPolicy,
} from "../config/domains";
import {
  INTERNAL_NETWORK_SUBNET,
  ENVOY_STATIC_IP,
  CLOUDFLARE_DNS_PRIMARY,
  CLOUDFLARE_DNS_SECONDARY,
  CORE_APT_PACKAGES,
  DOCKER_BASE_IMAGE,
} from "../config/defaults";
import type { EgressRule } from "../config/types";

describe("domain registry", () => {
  it("has expected infrastructure domain count", () => {
    expect(INFRASTRUCTURE_DOMAINS).toHaveLength(2);
  });

  it("has expected AI provider domain count", () => {
    expect(AI_PROVIDER_DOMAINS).toHaveLength(5);
  });

  it("has expected Homebrew domain count", () => {
    expect(HOMEBREW_DOMAINS).toHaveLength(4);
  });

  it("has expected Tailscale TLS domain count (5 fixed + 28 DERP)", () => {
    expect(TAILSCALE_TLS_DOMAINS).toHaveLength(5 + 28);
  });

  it("has expected Tailscale UDP domain count (28 DERP)", () => {
    expect(TAILSCALE_UDP_DOMAINS).toHaveLength(28);
  });

  it("includes Tailscale control plane and login domains", () => {
    const dsts = TAILSCALE_TLS_DOMAINS.map((r) => r.dst);
    expect(dsts).toContain("tailscale.com");
    expect(dsts).toContain("controlplane.tailscale.com");
    expect(dsts).toContain("login.tailscale.com");
    expect(dsts).toContain("log.tailscale.com");
  });

  it("does not use wildcard for Tailscale domains", () => {
    const dsts = TAILSCALE_TLS_DOMAINS.map((r) => r.dst);
    expect(dsts).not.toContain("*.tailscale.com");
  });

  it("includes all 28 DERP relay TLS domains", () => {
    const dsts = TAILSCALE_TLS_DOMAINS.map((r) => r.dst);
    for (let i = 1; i <= 28; i++) {
      expect(dsts).toContain(`derp${i}.tailscale.com`);
    }
  });

  it("includes Let's Encrypt ACME domain for Tailscale Serve TLS certs", () => {
    const dsts = TAILSCALE_TLS_DOMAINS.map((r) => r.dst);
    expect(dsts).toContain("*.api.letsencrypt.org");
  });

  it("includes all 28 DERP relay UDP domains on port 3478", () => {
    for (let i = 1; i <= 28; i++) {
      const rule = TAILSCALE_UDP_DOMAINS.find(
        (r) => r.dst === `derp${i}.tailscale.com`,
      );
      expect(rule).toBeDefined();
      expect(rule!.proto).toBe("udp");
      expect(rule!.port).toBe(3478);
    }
  });

  it("hardcoded rules equal sum of all categories", () => {
    const expected =
      INFRASTRUCTURE_DOMAINS.length +
      AI_PROVIDER_DOMAINS.length +
      HOMEBREW_DOMAINS.length +
      TAILSCALE_TLS_DOMAINS.length +
      TAILSCALE_UDP_DOMAINS.length;
    expect(HARDCODED_EGRESS_RULES).toHaveLength(expected);
  });

  it("all hardcoded rules have action allow", () => {
    for (const rule of HARDCODED_EGRESS_RULES) {
      expect(rule.action).toBe("allow");
    }
  });

  it("TLS hardcoded rules use tls proto", () => {
    const tlsRules = HARDCODED_EGRESS_RULES.filter((r) => r.proto === "tls");
    expect(tlsRules.length).toBeGreaterThan(0);
    for (const rule of tlsRules) {
      expect(rule.proto).toBe("tls");
    }
  });

  it("UDP hardcoded rules use udp proto", () => {
    const udpRules = HARDCODED_EGRESS_RULES.filter((r) => r.proto === "udp");
    expect(udpRules.length).toBe(28);
    for (const rule of udpRules) {
      expect(rule.proto).toBe("udp");
      expect(rule.port).toBe(3478);
    }
  });
});

describe("mergeEgressPolicy", () => {
  it("returns hardcoded rules when user rules are empty", () => {
    const merged = mergeEgressPolicy([]);
    expect(merged).toEqual(HARDCODED_EGRESS_RULES);
  });

  it("appends user rules after hardcoded rules", () => {
    const userRules: EgressRule[] = [
      { dst: "custom.example.com", proto: "tls", action: "allow" },
    ];
    const merged = mergeEgressPolicy(userRules);

    // Hardcoded rules come first
    for (let i = 0; i < HARDCODED_EGRESS_RULES.length; i++) {
      expect(merged[i]).toEqual(HARDCODED_EGRESS_RULES[i]);
    }

    // User rule is last
    expect(merged[merged.length - 1]).toEqual(userRules[0]);
    expect(merged).toHaveLength(HARDCODED_EGRESS_RULES.length + 1);
  });

  it("deduplicates by dst+proto+port", () => {
    const userRules: EgressRule[] = [
      // Duplicate of hardcoded rule
      { dst: "api.anthropic.com", proto: "tls", action: "allow" },
      // Unique rule
      { dst: "my-api.example.com", proto: "tls", action: "allow" },
    ];
    const merged = mergeEgressPolicy(userRules);
    expect(merged).toHaveLength(HARDCODED_EGRESS_RULES.length + 1);

    const anthropicRules = merged.filter((r) => r.dst === "api.anthropic.com");
    expect(anthropicRules).toHaveLength(1);
  });

  it("treats same domain with different proto as distinct", () => {
    const userRules: EgressRule[] = [
      { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
    ];
    const merged = mergeEgressPolicy(userRules);
    const githubRules = merged.filter((r) => r.dst === "github.com");
    expect(githubRules).toHaveLength(2); // tls (hardcoded) + ssh (user)
  });

  it("treats same domain+proto with different port as distinct", () => {
    const userRules: EgressRule[] = [
      { dst: "api.anthropic.com", proto: "tls", port: 8443, action: "allow" },
    ];
    const merged = mergeEgressPolicy(userRules);
    const anthropicRules = merged.filter((r) => r.dst === "api.anthropic.com");
    expect(anthropicRules).toHaveLength(2); // default port + 8443
  });

  it("preserves user rule properties (inspect, pathRules)", () => {
    const userRules: EgressRule[] = [
      {
        dst: "x.com",
        proto: "tls",
        action: "allow",
        inspect: true,
        pathRules: [{ path: "/api/dm/*", action: "deny" }],
      },
    ];
    const merged = mergeEgressPolicy(userRules);
    const xRule = merged.find((r) => r.dst === "x.com");
    expect(xRule).toBeDefined();
    expect(xRule!.inspect).toBe(true);
    expect(xRule!.pathRules).toHaveLength(1);
    expect(xRule!.pathRules![0].path).toBe("/api/dm/*");
  });

  it("deduplicates Tailscale domains from user rules", () => {
    const userRules: EgressRule[] = [
      { dst: "tailscale.com", proto: "tls", action: "allow" },
      { dst: "controlplane.tailscale.com", proto: "tls", action: "allow" },
    ];
    const merged = mergeEgressPolicy(userRules);
    const tailscaleRules = merged.filter(
      (r) => r.dst === "tailscale.com" && r.proto === "tls",
    );
    expect(tailscaleRules).toHaveLength(1);
    const cpRules = merged.filter(
      (r) => r.dst === "controlplane.tailscale.com" && r.proto === "tls",
    );
    expect(cpRules).toHaveLength(1);
  });

  it("hardcoded rule wins over duplicate user rule", () => {
    const userRules: EgressRule[] = [
      // User tries to deny a hardcoded domain — hardcoded wins
      { dst: "api.anthropic.com", proto: "tls", action: "deny" },
    ];
    const merged = mergeEgressPolicy(userRules);
    const anthropicRule = merged.find((r) => r.dst === "api.anthropic.com");
    expect(anthropicRule!.action).toBe("allow");
  });
});

describe("defaults", () => {
  it("uses correct internal network subnet", () => {
    expect(INTERNAL_NETWORK_SUBNET).toBe("172.28.0.0/24");
  });

  it("uses correct Envoy static IP", () => {
    expect(ENVOY_STATIC_IP).toBe("172.28.0.2");
  });

  it("uses Cloudflare malware-blocking DNS", () => {
    expect(CLOUDFLARE_DNS_PRIMARY).toBe("1.1.1.2");
    expect(CLOUDFLARE_DNS_SECONDARY).toBe("1.0.0.2");
  });

  it("includes all required core apt packages", () => {
    expect(CORE_APT_PACKAGES).toEqual(
      expect.arrayContaining([
        "iptables",
        "iproute2",
        "gosu",
        "libsecret-tools",
      ]),
    );
  });

  it("uses node:22-bookworm base image", () => {
    expect(DOCKER_BASE_IMAGE).toBe("node:22-bookworm");
  });
});
