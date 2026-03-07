import { describe, it, expect } from "vitest";
import { renderEnvoyConfig } from "../templates/envoy";
import { EgressRule } from "../config/types";
import {
  HARDCODED_EGRESS_RULES,
  INFRASTRUCTURE_DOMAINS,
  AI_PROVIDER_DOMAINS,
  HOMEBREW_DOMAINS,
  TAILSCALE_TLS_DOMAINS,
} from "../config/domains";
import {
  ENVOY_EGRESS_PORT,
  ENVOY_TCP_PORT_BASE,
  ENVOY_MITM_CERTS_CONTAINER_DIR,
  ENVOY_MITM_CLUSTER_NAME,
} from "../config/defaults";

describe("renderEnvoyConfig", () => {
  describe("default config (no user rules)", () => {
    it("produces valid output with no warnings", () => {
      const { yaml, warnings } = renderEnvoyConfig();
      expect(yaml).toBeTruthy();
      expect(warnings).toHaveLength(0);
    });

    it("contains all hardcoded infrastructure domains", () => {
      const { yaml } = renderEnvoyConfig();
      for (const rule of INFRASTRUCTURE_DOMAINS) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
    });

    it("contains all hardcoded AI provider domains", () => {
      const { yaml } = renderEnvoyConfig();
      for (const rule of AI_PROVIDER_DOMAINS) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
    });

    it("contains all hardcoded Homebrew domains", () => {
      const { yaml } = renderEnvoyConfig();
      for (const rule of HOMEBREW_DOMAINS) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
    });

    it("contains every hardcoded TLS domain in server_names list", () => {
      const { yaml } = renderEnvoyConfig();
      for (const rule of HARDCODED_EGRESS_RULES.filter(
        (r) => r.proto === "tls",
      )) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
    });

    it("contains *.tailscale.com wildcard", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain('"*.tailscale.com"');
    });

    it("contains all hardcoded Tailscale TLS domains", () => {
      const { yaml } = renderEnvoyConfig();
      for (const rule of TAILSCALE_TLS_DOMAINS) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
    });
  });

  describe("egress listener", () => {
    it("listens on the correct port", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain(`port_value: ${ENVOY_EGRESS_PORT}`);
    });

    it("has TLS Inspector listener filter", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("envoy.filters.listener.tls_inspector");
    });

    it("uses sni_dynamic_forward_proxy filter", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain(
        "envoy.extensions.filters.network.sni_dynamic_forward_proxy",
      );
    });

    it("routes allowed traffic to dynamic_forward_proxy_cluster", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("cluster: dynamic_forward_proxy_cluster");
    });

    it("has default deny chain routing to deny_cluster", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("cluster: deny_cluster");
      expect(yaml).toContain("stat_prefix: egress_denied");
    });
  });

  describe("no DNS listener (removed — Docker DNS via shared netns)", () => {
    it("does not contain a DNS listener", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).not.toContain("- name: dns");
      expect(yaml).not.toContain("protocol: UDP");
      expect(yaml).not.toContain("envoy.extensions.filters.udp.dns_filter");
    });
  });

  describe("TCP keepalive and idle timeout", () => {
    it("has idle_timeout: 0s on the passthrough tcp_proxy filter", () => {
      const { yaml } = renderEnvoyConfig();
      const allowedSection =
        yaml
          .split("stat_prefix: egress_tls_allowed")[1]
          ?.split("stat_prefix:")[0] ?? "";
      expect(allowedSection).toContain("idle_timeout: 0s");
    });

    it("has idle_timeout: 0s on the deny tcp_proxy filter", () => {
      const { yaml } = renderEnvoyConfig();
      const deniedSection =
        yaml.split("stat_prefix: egress_denied")[1]?.split("\n\n")[0] ?? "";
      expect(deniedSection).toContain("idle_timeout: 0s");
    });

    it("has idle_timeout: 0s on dedicated TCP listener tcp_proxy filters", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      const listenerStart = yaml.indexOf("# SSH egress: github.com:22");
      expect(listenerStart).toBeGreaterThan(-1);
      const listenerSection = yaml.substring(
        listenerStart,
        listenerStart + 500,
      );
      expect(listenerSection).toContain("idle_timeout: 0s");
    });

    it("has tcp_keepalive on dynamic_forward_proxy_cluster", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("upstream_connection_options:");
      expect(yaml).toContain("tcp_keepalive:");
      expect(yaml).toContain("keepalive_time: 60");
      expect(yaml).toContain("keepalive_interval: 10");
      expect(yaml).toContain("keepalive_probes: 3");
    });

    it("tcp_keepalive is on the dynamic_forward_proxy_cluster, not deny_cluster", () => {
      const { yaml } = renderEnvoyConfig();
      const denySection = yaml.split("name: deny_cluster")[1] ?? "";
      expect(denySection).not.toContain("tcp_keepalive");
    });
  });

  describe("clusters", () => {
    it("has dynamic_forward_proxy_cluster with CLUSTER_PROVIDED", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("name: dynamic_forward_proxy_cluster");
      expect(yaml).toContain("lb_policy: CLUSTER_PROVIDED");
    });

    it("has deny_cluster as STATIC with no endpoints", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("name: deny_cluster");
      expect(yaml).toContain("type: STATIC");
      const denySection = yaml.split("name: deny_cluster")[1];
      expect(denySection).not.toContain("endpoints:");
    });
  });

  describe("removed features (ingress)", () => {
    it("does not contain an ingress listener", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).not.toContain("name: ingress");
      const listeners = yaml.split("filter_chains:")[0];
      expect(listeners).not.toContain("port_value: 443");
    });

    it("does not contain openclaw_gateway cluster", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).not.toContain("openclaw_gateway");
    });

    it("does not reference TLS certificates in default config (no inspect rules)", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).not.toContain("server-cert.pem");
      expect(yaml).not.toContain("server-key.pem");
      expect(yaml).not.toContain("DownstreamTlsContext");
      expect(yaml).not.toContain("tls_certificates");
    });
  });

  describe("removed features (UDP)", () => {
    it("does not contain UDP proxy listeners", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).not.toContain("envoy.extensions.filters.udp.udp_proxy");
    });

    it("does not contain UDP DERP clusters", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).not.toContain("udp_derp");
    });

    it("does not have udpPortMappings in result", () => {
      const result = renderEnvoyConfig();
      expect(result).not.toHaveProperty("udpPortMappings");
    });
  });

  describe("user TLS rules", () => {
    it("adds user domains to server_names list", () => {
      const userRules: EgressRule[] = [
        { dst: "custom.example.com", proto: "tls", action: "allow" },
      ];
      const { yaml, warnings } = renderEnvoyConfig(userRules);
      expect(yaml).toContain('"custom.example.com"');
      expect(warnings).toHaveLength(0);
    });

    it("deduplicates domains already in hardcoded list", () => {
      const userRules: EgressRule[] = [
        { dst: "api.anthropic.com", proto: "tls", action: "allow" },
        { dst: "new-domain.com", proto: "tls", action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      const matches = yaml.match(/"api\.anthropic\.com"/g);
      expect(matches).toHaveLength(1);
      expect(yaml).toContain('"new-domain.com"');
    });

    it("preserves wildcard domains in server_names", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain('"*.githubusercontent.com"');
    });

    it("ignores deny rules (default deny handles them)", () => {
      const userRules: EgressRule[] = [
        { dst: "evil.com", proto: "tls", action: "deny" },
      ];
      const { yaml, warnings } = renderEnvoyConfig(userRules);
      expect(yaml).not.toContain('"evil.com"');
      expect(warnings).toHaveLength(0);
    });
  });

  describe("SSH/TCP egress warnings", () => {
    it("does not warn for inspect:true TLS rules (MITM implemented)", () => {
      const userRules: EgressRule[] = [
        {
          dst: "api.slack.com",
          proto: "tls",
          action: "allow",
          inspect: true,
          pathRules: [{ path: "/messages/*", action: "deny" }],
        },
      ];
      const { warnings, inspectedDomains } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(0);
      expect(inspectedDomains).toContain("api.slack.com");
    });

    it("does not warn for valid SSH rules with port", () => {
      const userRules: EgressRule[] = [
        { dst: "git.example.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { warnings, tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(0);
      expect(tcpPortMappings).toHaveLength(1);
    });

    it("warns for CIDR SSH destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "10.0.0.0/24", proto: "ssh", port: 22, action: "allow" },
      ];
      const { warnings, tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("CIDR");
      expect(tcpPortMappings).toHaveLength(0);
    });

    it("warns for SSH rules missing port", () => {
      const userRules: EgressRule[] = [
        { dst: "git.example.com", proto: "ssh", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("missing required port");
    });
  });

  describe("SSH/TCP egress", () => {
    it("assigns sequential ports starting from ENVOY_TCP_PORT_BASE", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
        { dst: "db.example.com", proto: "tcp", port: 5432, action: "allow" },
        { dst: "redis.example.com", proto: "tcp", port: 6379, action: "allow" },
      ];
      const { tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(tcpPortMappings).toHaveLength(3);
      expect(tcpPortMappings[0].envoyPort).toBe(ENVOY_TCP_PORT_BASE);
      expect(tcpPortMappings[1].envoyPort).toBe(ENVOY_TCP_PORT_BASE + 1);
      expect(tcpPortMappings[2].envoyPort).toBe(ENVOY_TCP_PORT_BASE + 2);
    });

    it("creates dedicated listener per SSH rule", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml, tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(tcpPortMappings).toHaveLength(1);
      expect(yaml).toContain(`port_value: ${ENVOY_TCP_PORT_BASE}`);
      expect(yaml).toContain("ssh_github_com_22");
    });

    it("uses STRICT_DNS cluster with V4_PREFERRED lookup for domain destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      expect(yaml).toContain("type: STRICT_DNS");
      expect(yaml).toContain("dns_lookup_family: V4_PREFERRED");
    });

    it("STRICT_DNS clusters use system DNS (no explicit Cloudflare resolvers)", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      const clusterStart = yaml.indexOf("tcp_ssh_github_com_22");
      const afterCluster = yaml.substring(clusterStart);
      const nextClusterOrEnd = afterCluster.indexOf("\n  - name:", 1);
      const clusterBlock =
        nextClusterOrEnd > 0
          ? afterCluster.substring(0, nextClusterOrEnd)
          : afterCluster;
      expect(clusterBlock).not.toContain("dns_resolver");
      expect(clusterBlock).not.toContain("1.1.1.2");
    });

    it("uses STATIC cluster for IPv4 destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "140.82.121.4", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1]!;
      const tcpClusterIdx = clustersSection.indexOf("tcp_ssh_140_82_121_4_22");
      expect(tcpClusterIdx).toBeGreaterThan(-1);
      const tcpCluster = clustersSection.substring(tcpClusterIdx);
      expect(tcpCluster).toContain("type: STATIC");
      expect(tcpCluster).toContain('"140.82.121.4"');
    });

    it("mixed TLS + SSH + TCP all work together", () => {
      const userRules: EgressRule[] = [
        { dst: "custom.example.com", proto: "tls", action: "allow" },
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
        { dst: "db.example.com", proto: "tcp", port: 5432, action: "allow" },
      ];
      const { yaml, warnings, tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(0);
      expect(yaml).toContain('"custom.example.com"');
      expect(tcpPortMappings).toHaveLength(2);
    });

    it("returns empty tcpPortMappings for default config", () => {
      const { tcpPortMappings } = renderEnvoyConfig();
      expect(tcpPortMappings).toHaveLength(0);
    });

    it("TCP listeners appear after egress listener in YAML", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      const egressIdx = yaml.indexOf("- name: egress");
      const tcpIdx = yaml.indexOf("ssh_github_com_22");
      expect(egressIdx).toBeGreaterThan(-1);
      expect(tcpIdx).toBeGreaterThan(-1);
      expect(tcpIdx).toBeGreaterThan(egressIdx);
    });

    it("cluster count increases with TCP rules", () => {
      const userRules: EgressRule[] = [
        { dst: "a.com", proto: "ssh", port: 22, action: "allow" },
        { dst: "b.com", proto: "tcp", port: 5432, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1];
      expect(clustersSection).toBeDefined();
      const clusterEntries = clustersSection!.match(/^ {2}- name:/gm);
      // 2 base (dynamic_forward_proxy + deny) + 2 TCP = 4
      expect(clusterEntries).toHaveLength(2 + 2);
    });
  });

  describe("stress and edge cases", () => {
    it("handles 50+ user domains and produces valid config", () => {
      const manyRules: EgressRule[] = Array.from({ length: 55 }, (_, i) => ({
        dst: `domain-${i}.example.com`,
        proto: "tls" as const,
        action: "allow" as const,
      }));
      const { yaml, warnings } = renderEnvoyConfig(manyRules);
      expect(warnings).toHaveLength(0);
      for (let i = 0; i < 55; i++) {
        expect(yaml).toContain(`"domain-${i}.example.com"`);
      }
    });

    it("empty user policy (only hardcoded) produces valid config", () => {
      const { yaml, warnings } = renderEnvoyConfig([]);
      expect(warnings).toHaveLength(0);
      expect(yaml).toContain("static_resources:");
      expect(yaml).toContain("server_names:");
    });

    it("YAML output has valid structure (indentation and keys)", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toMatch(/^static_resources:\n/m);
      expect(yaml).toMatch(/^ {2}listeners:\n/m);
      expect(yaml).toMatch(/^ {2}clusters:\n/m);
      expect(yaml).not.toMatch(/\t/);
    });
  });

  describe("output structure", () => {
    it("starts with a generated-by comment", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toMatch(/^# Generated by openclaw-deploy/);
    });

    it("has egress listener only (no DNS listener)", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("- name: egress");
      expect(yaml).not.toContain("- name: dns");
    });

    it("has base clusters only (no UDP clusters)", () => {
      const { yaml } = renderEnvoyConfig();
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1];
      expect(clustersSection).toBeDefined();
      expect(clustersSection).toContain("name: dynamic_forward_proxy_cluster");
      expect(clustersSection).toContain("name: deny_cluster");
      const clusterEntries = clustersSection!.match(/^ {2}- name:/gm);
      expect(clusterEntries).toHaveLength(2);
    });

    it("contains static_resources top-level key", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("static_resources:");
    });
  });

  describe("MITM TLS inspection", () => {
    it("creates MITM filter chain for inspect:true rules", () => {
      const rules: EgressRule[] = [
        { dst: "api.slack.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml, warnings, inspectedDomains } = renderEnvoyConfig(rules);
      expect(warnings).toHaveLength(0);
      expect(inspectedDomains).toEqual(["api.slack.com"]);
      expect(yaml).toContain("DownstreamTlsContext");
      expect(yaml).toContain(
        `${ENVOY_MITM_CERTS_CONTAINER_DIR}/api.slack.com-cert.pem`,
      );
      expect(yaml).toContain(`cluster: ${ENVOY_MITM_CLUSTER_NAME}`);
    });

    it("creates MITM filter chain for wildcard inspect:true rules", () => {
      const rules: EgressRule[] = [
        {
          dst: "*.example.com",
          proto: "tls",
          action: "allow",
          inspect: true,
        },
      ];
      const { yaml, warnings, inspectedDomains } = renderEnvoyConfig(rules);
      expect(warnings).toHaveLength(0);
      expect(inspectedDomains).toContain("*.example.com");
      expect(yaml).toContain("DownstreamTlsContext");
      // Wildcard escaped in filenames but preserved in server_names
      expect(yaml).toContain(
        `${ENVOY_MITM_CERTS_CONTAINER_DIR}/_wildcard_.example.com-cert.pem`,
      );
      expect(yaml).toContain(
        `${ENVOY_MITM_CERTS_CONTAINER_DIR}/_wildcard_.example.com-key.pem`,
      );
      expect(yaml).toContain('"*.example.com"');
      expect(yaml).toContain(`cluster: ${ENVOY_MITM_CLUSTER_NAME}`);
    });

    it("creates MITM filter chain for multi-level wildcard *.a.b.com", () => {
      const rules: EgressRule[] = [
        {
          dst: "*.cdn.example.com",
          proto: "tls",
          action: "allow",
          inspect: true,
        },
      ];
      const { yaml, warnings, inspectedDomains } = renderEnvoyConfig(rules);
      expect(warnings).toHaveLength(0);
      expect(inspectedDomains).toContain("*.cdn.example.com");
      expect(yaml).toContain(
        `${ENVOY_MITM_CERTS_CONTAINER_DIR}/_wildcard_.cdn.example.com-cert.pem`,
      );
      expect(yaml).toContain(
        `${ENVOY_MITM_CERTS_CONTAINER_DIR}/_wildcard_.cdn.example.com-key.pem`,
      );
      expect(yaml).toContain('"*.cdn.example.com"');
    });

    it("does not include wildcard inspected domain in passthrough server_names", () => {
      const rules: EgressRule[] = [
        {
          dst: "*.example.com",
          proto: "tls",
          action: "allow",
          inspect: true,
        },
        { dst: "other.com", proto: "tls", action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      const passthroughSection =
        yaml.split("Whitelisted TLS domains")[1]?.split("Default deny")[0] ??
        "";
      expect(passthroughSection).not.toContain('"*.example.com"');
      expect(passthroughSection).toContain('"other.com"');
    });

    it("does not include inspected domain in passthrough server_names", () => {
      const rules: EgressRule[] = [
        { dst: "api.slack.com", proto: "tls", action: "allow", inspect: true },
        { dst: "other.com", proto: "tls", action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      const passthroughSection =
        yaml.split("Whitelisted TLS domains")[1]?.split("Default deny")[0] ??
        "";
      expect(passthroughSection).toContain('"other.com"');
      expect(passthroughSection).not.toContain('"api.slack.com"');
    });

    it("does not emit MITM cluster when no inspect rules exist", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).not.toContain(ENVOY_MITM_CLUSTER_NAME);
      expect(yaml).not.toContain("UpstreamTlsContext");
    });

    it("emits MITM cluster when inspect rules exist", () => {
      const rules: EgressRule[] = [
        { dst: "x.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain(`name: ${ENVOY_MITM_CLUSTER_NAME}`);
      expect(yaml).toContain("UpstreamTlsContext");
    });

    it("returns empty inspectedDomains for default config", () => {
      const { inspectedDomains } = renderEnvoyConfig();
      expect(inspectedDomains).toHaveLength(0);
    });

    it("has base + MITM clusters when inspect rules exist", () => {
      const rules: EgressRule[] = [
        { dst: "x.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1];
      const clusterEntries = clustersSection!.match(/^ {2}- name:/gm);
      // 2 base + 1 MITM = 3
      expect(clusterEntries).toHaveLength(2 + 1);
    });
  });

  describe("domain validation", () => {
    it("skips domains with YAML-special characters and emits warning", () => {
      const rules: EgressRule[] = [
        { dst: '"; rm -rf /', proto: "tls", action: "allow" },
      ];
      const { yaml, warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
      expect(yaml).not.toContain("rm -rf");
    });

    it("accepts valid domains through validation", () => {
      const rules: EgressRule[] = [
        { dst: "valid-domain.example.com", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        false,
      );
    });

    it("accepts valid wildcard domain *.example.com", () => {
      const rules: EgressRule[] = [
        { dst: "*.example.com", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        false,
      );
    });

    it("rejects overly broad wildcard *.com (requires ≥2 labels)", () => {
      const rules: EgressRule[] = [
        { dst: "*.com", proto: "tls", action: "allow" },
      ];
      const { yaml, warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
      expect(yaml).not.toContain('"*.com"');
    });

    it("rejects mid-label wildcard foo.*.com", () => {
      const rules: EgressRule[] = [
        { dst: "foo.*.com", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
    });

    it("rejects double-asterisk wildcard **.example.com", () => {
      const rules: EgressRule[] = [
        { dst: "**.example.com", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
    });

    it("rejects bare wildcard *", () => {
      const rules: EgressRule[] = [{ dst: "*", proto: "tls", action: "allow" }];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
    });

    it("rejects wildcard without dot separator *com", () => {
      const rules: EgressRule[] = [
        { dst: "*com", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
    });

    it("rejects single-label wildcard *.io", () => {
      const rules: EgressRule[] = [
        { dst: "*.io", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
    });
  });

  describe("path validation", () => {
    it("throws for path without leading /", () => {
      const rules: EgressRule[] = [
        {
          dst: "example.com",
          proto: "tls",
          action: "allow",
          inspect: true,
          pathRules: [{ path: "no-leading-slash", action: "deny" }],
        },
      ];
      expect(() => renderEnvoyConfig(rules)).toThrow("must start with /");
    });

    it("throws for path containing double quotes", () => {
      const rules: EgressRule[] = [
        {
          dst: "example.com",
          proto: "tls",
          action: "allow",
          inspect: true,
          pathRules: [{ path: '/api/"inject', action: "deny" }],
        },
      ];
      expect(() => renderEnvoyConfig(rules)).toThrow("forbidden characters");
    });
  });
});
