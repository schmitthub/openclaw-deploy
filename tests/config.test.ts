import { describe, it, expect } from "vitest";
import {
  INFRASTRUCTURE_DOMAINS,
  AI_PROVIDER_DOMAINS,
  HOMEBREW_DOMAINS,
  TAILSCALE_TLS_DOMAINS,
  HARDCODED_EGRESS_RULES,
  mergeEgressPolicy,
} from "../config/domains";
import {
  CLOUDFLARE_DNS_PRIMARY,
  CLOUDFLARE_DNS_SECONDARY,
  CORE_APT_PACKAGES,
  DOCKER_BASE_IMAGE,
  SSHD_PORT,
  ENVOY_UID,
  TAILSCALE_HEALTH_PORT,
} from "../config/defaults";
import { validateHetznerConfig } from "../config/types";
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

  it("has expected Tailscale TLS domain count (wildcard + Let's Encrypt)", () => {
    expect(TAILSCALE_TLS_DOMAINS).toHaveLength(2);
  });

  it("uses *.tailscale.com wildcard for Tailscale domains", () => {
    const dsts = TAILSCALE_TLS_DOMAINS.map((r) => r.dst);
    expect(dsts).toContain("*.tailscale.com");
  });

  it("includes Let's Encrypt ACME domain for Tailscale Serve TLS certs", () => {
    const dsts = TAILSCALE_TLS_DOMAINS.map((r) => r.dst);
    expect(dsts).toContain("*.api.letsencrypt.org");
  });

  it("hardcoded rules equal sum of all categories", () => {
    const expected =
      INFRASTRUCTURE_DOMAINS.length +
      AI_PROVIDER_DOMAINS.length +
      HOMEBREW_DOMAINS.length +
      TAILSCALE_TLS_DOMAINS.length;
    expect(HARDCODED_EGRESS_RULES).toHaveLength(expected);
  });

  it("all hardcoded rules have action allow", () => {
    for (const rule of HARDCODED_EGRESS_RULES) {
      expect(rule.action).toBe("allow");
    }
  });

  it("all hardcoded rules use tls proto", () => {
    for (const rule of HARDCODED_EGRESS_RULES) {
      expect(rule.proto).toBe("tls");
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

  it("deduplicates Tailscale wildcard from user rules", () => {
    const userRules: EgressRule[] = [
      { dst: "*.tailscale.com", proto: "tls", action: "allow" },
    ];
    const merged = mergeEgressPolicy(userRules);
    const tailscaleRules = merged.filter(
      (r) => r.dst === "*.tailscale.com" && r.proto === "tls",
    );
    expect(tailscaleRules).toHaveLength(1);
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
  it("uses Cloudflare malware-blocking DNS", () => {
    expect(CLOUDFLARE_DNS_PRIMARY).toBe("1.1.1.2");
    expect(CLOUDFLARE_DNS_SECONDARY).toBe("1.0.0.2");
  });

  it("includes openssh-server in core apt packages", () => {
    expect(CORE_APT_PACKAGES).toContain("openssh-server");
  });

  it("does not include iptables or iproute2 in core apt packages (sidecar handles networking)", () => {
    expect(CORE_APT_PACKAGES).not.toContain("iptables");
    expect(CORE_APT_PACKAGES).not.toContain("iproute2");
  });

  it("includes gosu and libsecret-tools in core apt packages", () => {
    expect(CORE_APT_PACKAGES).toContain("gosu");
    expect(CORE_APT_PACKAGES).toContain("libsecret-tools");
  });

  it("uses node:22-bookworm base image", () => {
    expect(DOCKER_BASE_IMAGE).toBe("node:22-bookworm");
  });

  it("has SSHD_PORT constant", () => {
    expect(SSHD_PORT).toBe(2222);
  });

  it("has ENVOY_UID constant", () => {
    expect(ENVOY_UID).toBe(101);
  });

  it("has TAILSCALE_HEALTH_PORT constant", () => {
    expect(TAILSCALE_HEALTH_PORT).toBe(9002);
  });
});

describe("validateHetznerConfig", () => {
  it("accepts valid config with backups", () => {
    const { config, warnings } = validateHetznerConfig(
      { backups: true },
      "hetzner",
    );
    expect(config).toEqual({ backups: true });
    expect(warnings).toHaveLength(0);
  });

  it("accepts empty object", () => {
    const { config, warnings } = validateHetznerConfig({}, "hetzner");
    expect(config).toEqual({});
    expect(warnings).toHaveLength(0);
  });

  it("throws on array input", () => {
    expect(() => validateHetznerConfig(["backups"], "hetzner")).toThrow(
      /got an array/,
    );
  });

  it("throws on null input", () => {
    expect(() => validateHetznerConfig(null, "hetzner")).toThrow(/got null/);
  });

  it("throws on string input", () => {
    expect(() => validateHetznerConfig("backups", "hetzner")).toThrow(
      /got string/,
    );
  });

  it("throws on unknown keys", () => {
    expect(() =>
      validateHetznerConfig({ backups: true, snapshots: true }, "hetzner"),
    ).toThrow(/Unknown key.*snapshots/);
  });

  it("lists valid keys in unknown-key error", () => {
    expect(() => validateHetznerConfig({ bad: true }, "hetzner")).toThrow(
      /Valid keys: backups/,
    );
  });

  it("warns when provider is not hetzner", () => {
    const { warnings } = validateHetznerConfig(
      { backups: true },
      "digitalocean",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"digitalocean"');
  });

  it("does not warn when provider is hetzner", () => {
    const { warnings } = validateHetznerConfig({ backups: true }, "hetzner");
    expect(warnings).toHaveLength(0);
  });
});
