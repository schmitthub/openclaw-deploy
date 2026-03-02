import { describe, it, expect } from "vitest";
import { renderEnvoyConfig } from "../templates/envoy";
import { EgressRule } from "../config/types";
import {
  HARDCODED_EGRESS_RULES,
  INFRASTRUCTURE_DOMAINS,
  AI_PROVIDER_DOMAINS,
  HOMEBREW_DOMAINS,
} from "../config/domains";
import {
  ENVOY_EGRESS_PORT,
  ENVOY_DNS_PORT,
  CLOUDFLARE_DNS_PRIMARY,
  CLOUDFLARE_DNS_SECONDARY,
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

    it("contains every hardcoded domain in server_names list", () => {
      const { yaml } = renderEnvoyConfig();
      for (const rule of HARDCODED_EGRESS_RULES) {
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
      expect(yaml).toContain(
        "envoy.filters.listener.tls_inspector",
      );
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

  describe("DNS listener", () => {
    it("listens on the correct port", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain(`port_value: ${ENVOY_DNS_PORT}`);
    });

    it("uses UDP protocol", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("protocol: UDP");
    });

    it("uses dns_filter", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain(
        "envoy.extensions.filters.udp.dns_filter",
      );
    });

    it("forwards to Cloudflare primary resolver", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain(`address: "${CLOUDFLARE_DNS_PRIMARY}"`);
    });

    it("forwards to Cloudflare secondary resolver", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain(`address: "${CLOUDFLARE_DNS_SECONDARY}"`);
    });

    it("uses c-ares DNS resolver", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain(
        "envoy.extensions.network.dns_resolver.cares",
      );
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
      // deny_cluster load_assignment has no endpoints array entries
      const denySection = yaml.split("name: deny_cluster")[1];
      expect(denySection).not.toContain("endpoints:");
    });
  });

  describe("removed features (ingress)", () => {
    it("does not contain an ingress listener", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).not.toContain("name: ingress");
      // Verify no listener binds to port 443 — the only port_value: 443
      // reference should be inside the SNI forward proxy filter (upstream port),
      // not as a listener socket_address.
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
      // api.anthropic.com should appear exactly once
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

  describe("phase 2 warnings", () => {
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

    it("warns for SSH rules", () => {
      const userRules: EgressRule[] = [
        { dst: "git.example.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("git.example.com");
      expect(warnings[0]).toContain("SSH");
      expect(warnings[0]).toContain("Phase 2");
    });

    it("warns for TCP rules", () => {
      const userRules: EgressRule[] = [
        { dst: "db.internal.com", proto: "tcp", port: 5432, action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("db.internal.com");
      expect(warnings[0]).toContain("TCP");
      expect(warnings[0]).toContain("Phase 2");
    });

    it("accumulates warnings for SSH and TCP (not for inspect:true)", () => {
      const userRules: EgressRule[] = [
        { dst: "a.com", proto: "tls", action: "allow", inspect: true },
        { dst: "b.com", proto: "ssh", port: 22, action: "allow" },
        { dst: "c.com", proto: "tcp", port: 8080, action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(userRules);
      // Only SSH and TCP generate warnings; inspect:true is now implemented
      expect(warnings).toHaveLength(2);
    });

    it("does not warn for SSH deny rules", () => {
      const userRules: EgressRule[] = [
        { dst: "evil.com", proto: "ssh", port: 22, action: "deny" },
      ];
      const { warnings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(0);
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
      // All user domains present
      for (let i = 0; i < 55; i++) {
        expect(yaml).toContain(`"domain-${i}.example.com"`);
      }
      // All hardcoded domains still present
      for (const rule of HARDCODED_EGRESS_RULES) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
      // Still has correct structure
      expect(yaml).toContain("static_resources:");
      expect(yaml).toContain("name: egress");
    });

    it("handles domains with hyphens, numbers, and deep subdomains", () => {
      const userRules: EgressRule[] = [
        { dst: "my-api-v2.sub.deep.example.com", proto: "tls", action: "allow" },
        { dst: "123-service.io", proto: "tls", action: "allow" },
      ];
      const { yaml, warnings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(0);
      expect(yaml).toContain('"my-api-v2.sub.deep.example.com"');
      expect(yaml).toContain('"123-service.io"');
    });

    it("empty user policy (only hardcoded) produces valid config", () => {
      const { yaml, warnings } = renderEnvoyConfig([]);
      expect(warnings).toHaveLength(0);
      expect(yaml).toContain("static_resources:");
      expect(yaml).toContain("server_names:");
      // Hardcoded domains are present
      for (const rule of HARDCODED_EGRESS_RULES) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
    });

    it("YAML output has valid structure (indentation and keys)", () => {
      const { yaml } = renderEnvoyConfig();
      // Check key structural elements are correctly indented
      expect(yaml).toMatch(/^static_resources:\n/m);
      expect(yaml).toMatch(/^ {2}listeners:\n/m);
      expect(yaml).toMatch(/^ {2}clusters:\n/m);
      // No tabs (YAML uses spaces)
      expect(yaml).not.toMatch(/\t/);
    });
  });

  describe("output structure", () => {
    it("starts with a generated-by comment", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toMatch(/^# Generated by openclaw-deploy/);
    });

    it("has exactly two listeners (egress and dns)", () => {
      const { yaml } = renderEnvoyConfig();
      const listenerMatches = yaml.match(/- name: (egress|dns)/g);
      expect(listenerMatches).toHaveLength(2);
      expect(listenerMatches).toContain("- name: egress");
      expect(listenerMatches).toContain("- name: dns");
    });

    it("has exactly two clusters", () => {
      const { yaml } = renderEnvoyConfig();
      // Extract the clusters section and count entries
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1];
      expect(clustersSection).toBeDefined();
      expect(clustersSection).toContain("name: dynamic_forward_proxy_cluster");
      expect(clustersSection).toContain("name: deny_cluster");
      // Count cluster definitions (indented "- name:" entries within clusters section)
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
      expect(yaml).toContain(`${ENVOY_MITM_CERTS_CONTAINER_DIR}/api.slack.com-cert.pem`);
      expect(yaml).toContain(`${ENVOY_MITM_CERTS_CONTAINER_DIR}/api.slack.com-key.pem`);
      expect(yaml).toContain(`cluster: ${ENVOY_MITM_CLUSTER_NAME}`);
    });

    it("does not include inspected domain in passthrough server_names", () => {
      const rules: EgressRule[] = [
        { dst: "api.slack.com", proto: "tls", action: "allow", inspect: true },
        { dst: "other.com", proto: "tls", action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      // Extract the passthrough filter chain section
      const passthroughSection = yaml.split("Whitelisted TLS domains")[1]?.split("Default deny")[0] ?? "";
      expect(passthroughSection).toContain('"other.com"');
      expect(passthroughSection).not.toContain('"api.slack.com"');
    });

    it("inspect without pathRules creates catch-all allow route", () => {
      const rules: EgressRule[] = [
        { dst: "x.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain('prefix: "/"');
      expect(yaml).toContain(`cluster: ${ENVOY_MITM_CLUSTER_NAME}`);
      // No deny routes (no pathRules)
      expect(yaml).not.toContain("direct_response");
    });

    it("inspect with deny pathRules emits 403 routes before catch-all", () => {
      const rules: EgressRule[] = [
        {
          dst: "api.slack.com",
          proto: "tls",
          action: "allow",
          inspect: true,
          pathRules: [{ path: "/messages/*", action: "deny" }],
        },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain('prefix: "/messages/"');
      expect(yaml).toContain("status: 403");
      expect(yaml).toContain("Blocked by egress policy");
      // Catch-all still present after deny routes
      expect(yaml).toContain('prefix: "/"');
    });

    it("converts wildcard paths to prefix match", () => {
      const rules: EgressRule[] = [
        {
          dst: "example.com",
          proto: "tls",
          action: "allow",
          inspect: true,
          pathRules: [{ path: "/api/dm/*", action: "deny" }],
        },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain('prefix: "/api/dm/"');
    });

    it("converts exact paths to path match", () => {
      const rules: EgressRule[] = [
        {
          dst: "example.com",
          proto: "tls",
          action: "allow",
          inspect: true,
          pathRules: [{ path: "/health", action: "deny" }],
        },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain('path: "/health"');
    });

    it("warns for wildcard domains with inspect:true and treats as passthrough", () => {
      const rules: EgressRule[] = [
        { dst: "*.example.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml, warnings, inspectedDomains } = renderEnvoyConfig(rules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("*.example.com");
      expect(warnings[0]).toContain("passthrough");
      expect(inspectedDomains).toHaveLength(0);
      // Should appear in passthrough server_names instead
      expect(yaml).toContain('"*.example.com"');
    });

    it("handles multiple inspected domains", () => {
      const rules: EgressRule[] = [
        { dst: "a.com", proto: "tls", action: "allow", inspect: true },
        { dst: "b.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml, inspectedDomains } = renderEnvoyConfig(rules);
      expect(inspectedDomains).toEqual(["a.com", "b.com"]);
      expect(yaml).toContain(`${ENVOY_MITM_CERTS_CONTAINER_DIR}/a.com-cert.pem`);
      expect(yaml).toContain(`${ENVOY_MITM_CERTS_CONTAINER_DIR}/b.com-cert.pem`);
      // Both should have MITM filter chain comments
      const mitmMatches = yaml.match(/MITM TLS inspection:/g);
      expect(mitmMatches).toHaveLength(2);
    });

    it("mixed passthrough and inspect rules are separated correctly", () => {
      const rules: EgressRule[] = [
        { dst: "pass.com", proto: "tls", action: "allow" },
        { dst: "inspect.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml, inspectedDomains } = renderEnvoyConfig(rules);
      expect(inspectedDomains).toEqual(["inspect.com"]);
      // pass.com in passthrough section
      const passthroughSection = yaml.split("Whitelisted TLS domains")[1]?.split("Default deny")[0] ?? "";
      expect(passthroughSection).toContain('"pass.com"');
      // inspect.com in MITM filter chain
      expect(yaml).toContain(`${ENVOY_MITM_CERTS_CONTAINER_DIR}/inspect.com-cert.pem`);
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
      expect(yaml).toContain("ca-certificates.crt");
    });

    it("returns empty inspectedDomains for default config", () => {
      const { inspectedDomains } = renderEnvoyConfig();
      expect(inspectedDomains).toHaveLength(0);
    });

    it("uses correct stat_prefix with dots replaced by underscores", () => {
      const rules: EgressRule[] = [
        { dst: "api.slack.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain("stat_prefix: mitm_api_slack_com");
    });

    it("orders deny pathRules before catch-all route", () => {
      const rules: EgressRule[] = [
        {
          dst: "example.com",
          proto: "tls",
          action: "allow",
          inspect: true,
          pathRules: [
            { path: "/secret/*", action: "deny" },
            { path: "/admin", action: "deny" },
          ],
        },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      const secretIdx = yaml.indexOf('prefix: "/secret/"');
      const adminIdx = yaml.indexOf('path: "/admin"');
      const catchAllIdx = yaml.lastIndexOf('prefix: "/"');
      expect(secretIdx).toBeGreaterThan(-1);
      expect(adminIdx).toBeGreaterThan(-1);
      expect(secretIdx).toBeLessThan(catchAllIdx);
      expect(adminIdx).toBeLessThan(catchAllIdx);
    });

    it("has exactly three clusters when inspect rules exist", () => {
      const rules: EgressRule[] = [
        { dst: "x.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1];
      expect(clustersSection).toBeDefined();
      const clusterEntries = clustersSection!.match(/^ {2}- name:/gm);
      expect(clusterEntries).toHaveLength(3);
    });

    it("MITM filter chain has http_connection_manager with dynamic_forward_proxy", () => {
      const rules: EgressRule[] = [
        { dst: "x.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain("envoy.filters.network.http_connection_manager");
      expect(yaml).toContain("envoy.filters.http.dynamic_forward_proxy");
      expect(yaml).toContain("envoy.filters.http.router");
    });

    it("inspect:true on deny rules does not create filter chain", () => {
      const rules: EgressRule[] = [
        { dst: "evil.com", proto: "tls", action: "deny", inspect: true },
      ];
      const { warnings, inspectedDomains } = renderEnvoyConfig(rules);
      expect(warnings).toHaveLength(0);
      expect(inspectedDomains).toHaveLength(0);
    });

    it("MITM filter chain uses codec_type AUTO", () => {
      const rules: EgressRule[] = [
        { dst: "x.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain("codec_type: AUTO");
    });

    it("MITM cluster uses separate DNS cache from passthrough", () => {
      const rules: EgressRule[] = [
        { dst: "x.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain("name: mitm_forward_proxy_cache");
      expect(yaml).toContain("name: dynamic_forward_proxy_cache");
    });

    it("MITM filter chains appear before passthrough chain in YAML", () => {
      const rules: EgressRule[] = [
        { dst: "inspect.com", proto: "tls", action: "allow", inspect: true },
        { dst: "pass.com", proto: "tls", action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      const mitmIdx = yaml.indexOf("# MITM TLS inspection: inspect.com");
      const passthroughIdx = yaml.indexOf("# Whitelisted TLS domains");
      expect(mitmIdx).toBeGreaterThan(-1);
      expect(passthroughIdx).toBeGreaterThan(-1);
      expect(mitmIdx).toBeLessThan(passthroughIdx);
    });

    it("MITM header comment reflects inspection mode", () => {
      const rules: EgressRule[] = [
        { dst: "x.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      expect(yaml).toContain("MITM inspection");
      expect(yaml).toContain("inspect:true use MITM TLS termination");
    });
  });
});
