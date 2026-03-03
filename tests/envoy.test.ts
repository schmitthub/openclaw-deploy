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
  ENVOY_UDP_PORT_BASE,
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

    it("contains every hardcoded TLS domain in server_names list", () => {
      const { yaml } = renderEnvoyConfig();
      for (const rule of HARDCODED_EGRESS_RULES.filter(
        (r) => r.proto === "tls",
      )) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
    });

    it("contains all hardcoded Tailscale TLS domains", () => {
      const { yaml } = renderEnvoyConfig();
      for (const rule of TAILSCALE_TLS_DOMAINS) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
    });

    it("does not contain *.tailscale.com wildcard", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).not.toContain('"*.tailscale.com"');
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
      expect(yaml).toContain("envoy.extensions.filters.udp.dns_filter");
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
      expect(yaml).toContain("envoy.extensions.network.dns_resolver.cares");
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

    it("does not warn for valid TCP rules with port", () => {
      const userRules: EgressRule[] = [
        { dst: "db.internal.com", proto: "tcp", port: 5432, action: "allow" },
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
      expect(warnings[0]).toContain("10.0.0.0/24");
      expect(tcpPortMappings).toHaveLength(0);
    });

    it("warns for CIDR TCP destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "192.168.1.0/24", proto: "tcp", port: 5432, action: "allow" },
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
      const { warnings, tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("missing required port");
      expect(tcpPortMappings).toHaveLength(0);
    });

    it("warns for TCP rules missing port", () => {
      const userRules: EgressRule[] = [
        { dst: "db.example.com", proto: "tcp", action: "allow" },
      ];
      const { warnings, tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("missing required port");
      expect(tcpPortMappings).toHaveLength(0);
    });

    it("does not warn for SSH deny rules", () => {
      const userRules: EgressRule[] = [
        { dst: "evil.com", proto: "ssh", port: 22, action: "deny" },
      ];
      const { warnings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(0);
    });

    it("mixed valid and invalid rules accumulate only invalid warnings", () => {
      const userRules: EgressRule[] = [
        { dst: "a.com", proto: "tls", action: "allow", inspect: true },
        { dst: "b.com", proto: "ssh", port: 22, action: "allow" },
        { dst: "10.0.0.0/8", proto: "tcp", port: 8080, action: "allow" },
      ];
      const { warnings, tcpPortMappings } = renderEnvoyConfig(userRules);
      // Only CIDR TCP generates a warning
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("CIDR");
      expect(tcpPortMappings).toHaveLength(1);
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
      expect(yaml).toContain("tcp_ssh_github_com_22");
    });

    it("creates dedicated listener per TCP rule", () => {
      const userRules: EgressRule[] = [
        { dst: "db.example.com", proto: "tcp", port: 5432, action: "allow" },
      ];
      const { yaml, tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(tcpPortMappings).toHaveLength(1);
      expect(yaml).toContain("tcp_db_example_com_5432");
    });

    it("uses STRICT_DNS cluster with V4_PREFERRED lookup for domain destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      expect(yaml).toContain("type: STRICT_DNS");
      expect(yaml).toContain("dns_lookup_family: V4_PREFERRED");
      expect(yaml).toContain(`address: "${CLOUDFLARE_DNS_PRIMARY}"`);
    });

    it("uses STATIC cluster for IPv4 destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "140.82.121.4", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      // Extract the clusters section, then find the TCP cluster for this IP
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1]!;
      const tcpClusterIdx = clustersSection.indexOf("tcp_ssh_140_82_121_4_22");
      expect(tcpClusterIdx).toBeGreaterThan(-1);
      const tcpCluster = clustersSection.substring(tcpClusterIdx);
      expect(tcpCluster).toContain("type: STATIC");
      expect(tcpCluster).toContain('"140.82.121.4"');
    });

    it("uses STATIC cluster for IPv6 destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "2001:db8::1", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1]!;
      const safeName = "tcp_ssh_2001_db8__1_22";
      const tcpClusterIdx = clustersSection.indexOf(safeName);
      expect(tcpClusterIdx).toBeGreaterThan(-1);
      const tcpCluster = clustersSection.substring(tcpClusterIdx);
      expect(tcpCluster).toContain("type: STATIC");
      expect(tcpCluster).toContain('"2001:db8::1"');
    });

    it("emits iptables limitation warning for IPv6 SSH/TCP destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "2001:db8::1", proto: "ssh", port: 22, action: "allow" },
      ];
      const { warnings, tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("IPv6");
      expect(warnings[0]).toContain("2001:db8::1");
      expect(warnings[0]).toContain("iptables routing is IPv4-only");
      // Mapping is still created (Envoy can reach IPv6)
      expect(tcpPortMappings).toHaveLength(1);
    });

    it("STATIC cluster for IP has no dns_resolvers", () => {
      const userRules: EgressRule[] = [
        { dst: "140.82.121.4", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      // Extract the TCP cluster section for the IP
      const clusterStart = yaml.indexOf("tcp_ssh_140_82_121_4_22");
      const afterCluster = yaml.substring(clusterStart);
      const nextClusterOrEnd = afterCluster.indexOf("\n  - name:", 1);
      const clusterBlock =
        nextClusterOrEnd > 0
          ? afterCluster.substring(0, nextClusterOrEnd)
          : afterCluster;
      expect(clusterBlock).not.toContain("dns_resolver");
    });

    it("deny rules produce no listener or mapping", () => {
      const userRules: EgressRule[] = [
        { dst: "evil.com", proto: "ssh", port: 22, action: "deny" },
        { dst: "bad.com", proto: "tcp", port: 5432, action: "deny" },
      ];
      const { yaml, tcpPortMappings, warnings } = renderEnvoyConfig(userRules);
      expect(tcpPortMappings).toHaveLength(0);
      expect(warnings).toHaveLength(0);
      expect(yaml).not.toContain("evil_com");
      expect(yaml).not.toContain("bad_com");
    });

    it("mixed TLS + SSH + TCP all work together", () => {
      const userRules: EgressRule[] = [
        { dst: "custom.example.com", proto: "tls", action: "allow" },
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
        { dst: "db.example.com", proto: "tcp", port: 5432, action: "allow" },
      ];
      const { yaml, warnings, tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(0);
      // TLS domain in passthrough
      expect(yaml).toContain('"custom.example.com"');
      // SSH + TCP mappings
      expect(tcpPortMappings).toHaveLength(2);
      expect(yaml).toContain("ssh_github_com_22");
      expect(yaml).toContain("tcp_db_example_com_5432");
    });

    it("returns empty tcpPortMappings for default config", () => {
      const { tcpPortMappings } = renderEnvoyConfig();
      expect(tcpPortMappings).toHaveLength(0);
    });

    it("returns 28 hardcoded UDP port mappings for default config", () => {
      const { udpPortMappings } = renderEnvoyConfig();
      expect(udpPortMappings).toHaveLength(28);
      // All are DERP relays on STUN port 3478
      for (const m of udpPortMappings) {
        expect(m.dst).toMatch(/^derp\d+\.tailscale\.com$/);
        expect(m.dstPort).toBe(3478);
      }
    });

    it("TCP listeners appear after DNS listener in YAML", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      const dnsIdx = yaml.indexOf("- name: dns");
      const tcpIdx = yaml.indexOf("ssh_github_com_22");
      expect(dnsIdx).toBeGreaterThan(-1);
      expect(tcpIdx).toBeGreaterThan(-1);
      expect(tcpIdx).toBeGreaterThan(dnsIdx);
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
      // 2 base (dynamic_forward_proxy + deny) + 28 UDP DERP + 2 TCP = 32
      expect(clusterEntries).toHaveLength(2 + 28 + 2);
    });

    it("preserves correct mapping metadata", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { tcpPortMappings } = renderEnvoyConfig(userRules);
      expect(tcpPortMappings[0]).toEqual({
        dst: "github.com",
        dstPort: 22,
        proto: "ssh",
        envoyPort: ENVOY_TCP_PORT_BASE,
      });
    });

    it("uses tcp_proxy filter for TCP listeners", () => {
      const userRules: EgressRule[] = [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      // Count tcp_proxy occurrences — should have catch-all egress + deny + TCP listener
      const tcpProxyMatches = yaml.match(/envoy\.filters\.network\.tcp_proxy/g);
      // egress allowed + egress denied + 1 TCP listener = 3
      expect(tcpProxyMatches!.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("UDP egress", () => {
    it("assigns sequential ports starting from ENVOY_UDP_PORT_BASE", () => {
      const userRules: EgressRule[] = [
        { dst: "stun.example.com", proto: "udp", port: 3478, action: "allow" },
        { dst: "stun2.example.com", proto: "udp", port: 3478, action: "allow" },
      ];
      const { udpPortMappings } = renderEnvoyConfig(userRules);
      // 28 hardcoded DERP + 2 user = 30
      expect(udpPortMappings).toHaveLength(30);
      // User rules come after hardcoded
      const lastTwo = udpPortMappings.slice(-2);
      expect(lastTwo[0].envoyPort).toBe(ENVOY_UDP_PORT_BASE + 28);
      expect(lastTwo[1].envoyPort).toBe(ENVOY_UDP_PORT_BASE + 29);
    });

    it("creates dedicated UDP proxy listener per rule", () => {
      const { yaml } = renderEnvoyConfig();
      // Check first DERP listener exists
      expect(yaml).toContain("udp_derp1_tailscale_com_3478");
      expect(yaml).toContain(`port_value: ${ENVOY_UDP_PORT_BASE}`);
      expect(yaml).toContain(
        "envoy.extensions.filters.udp.udp_proxy.v3.UdpProxyConfig",
      );
    });

    it("uses STRICT_DNS cluster for domain UDP destinations", () => {
      const { yaml } = renderEnvoyConfig();
      // DERP clusters should use STRICT_DNS
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1]!;
      const derpClusterIdx = clustersSection.indexOf(
        "udp_udp_derp1_tailscale_com_3478",
      );
      expect(derpClusterIdx).toBeGreaterThan(-1);
      const derpCluster = clustersSection.substring(derpClusterIdx);
      expect(derpCluster).toContain("type: STRICT_DNS");
      expect(derpCluster).toContain("protocol: UDP");
    });

    it("uses STATIC cluster for IPv4 UDP destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "1.2.3.4", proto: "udp", port: 3478, action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(userRules);
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1]!;
      const udpClusterIdx = clustersSection.indexOf("udp_udp_1_2_3_4_3478");
      expect(udpClusterIdx).toBeGreaterThan(-1);
      const udpCluster = clustersSection.substring(udpClusterIdx);
      expect(udpCluster).toContain("type: STATIC");
      expect(udpCluster).toContain('"1.2.3.4"');
    });

    it("warns for CIDR UDP destinations", () => {
      const userRules: EgressRule[] = [
        { dst: "10.0.0.0/24", proto: "udp", port: 3478, action: "allow" },
      ];
      const { warnings, udpPortMappings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("CIDR");
      // Hardcoded DERP mappings still present
      expect(udpPortMappings).toHaveLength(28);
    });

    it("warns for UDP rules missing port", () => {
      const userRules: EgressRule[] = [
        { dst: "stun.example.com", proto: "udp", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("missing required port");
    });

    it("deny UDP rules produce no listener or mapping", () => {
      const userRules: EgressRule[] = [
        { dst: "evil.com", proto: "udp", port: 3478, action: "deny" },
      ];
      const { yaml, udpPortMappings, warnings } = renderEnvoyConfig(userRules);
      expect(warnings).toHaveLength(0);
      // Only hardcoded DERP mappings
      expect(udpPortMappings).toHaveLength(28);
      expect(yaml).not.toContain("udp_evil_com");
    });

    it("preserves correct UDP mapping metadata", () => {
      const { udpPortMappings } = renderEnvoyConfig();
      expect(udpPortMappings[0]).toEqual({
        dst: "derp1.tailscale.com",
        dstPort: 3478,
        envoyPort: ENVOY_UDP_PORT_BASE,
      });
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
      // All hardcoded TLS domains still present in server_names
      for (const rule of HARDCODED_EGRESS_RULES.filter(
        (r) => r.proto === "tls",
      )) {
        expect(yaml).toContain(`"${rule.dst}"`);
      }
      // Still has correct structure
      expect(yaml).toContain("static_resources:");
      expect(yaml).toContain("name: egress");
    });

    it("handles domains with hyphens, numbers, and deep subdomains", () => {
      const userRules: EgressRule[] = [
        {
          dst: "my-api-v2.sub.deep.example.com",
          proto: "tls",
          action: "allow",
        },
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
      // Hardcoded TLS domains are present in server_names
      for (const rule of HARDCODED_EGRESS_RULES.filter(
        (r) => r.proto === "tls",
      )) {
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

    it("has egress, dns, and hardcoded UDP listeners", () => {
      const { yaml } = renderEnvoyConfig();
      expect(yaml).toContain("- name: egress");
      expect(yaml).toContain("- name: dns");
      // 28 hardcoded DERP UDP listeners
      for (let i = 1; i <= 28; i++) {
        expect(yaml).toContain(`udp_derp${i}_tailscale_com_3478`);
      }
    });

    it("has base clusters plus hardcoded UDP clusters", () => {
      const { yaml } = renderEnvoyConfig();
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1];
      expect(clustersSection).toBeDefined();
      expect(clustersSection).toContain("name: dynamic_forward_proxy_cluster");
      expect(clustersSection).toContain("name: deny_cluster");
      // Count cluster definitions: 2 base + 28 UDP DERP
      const clusterEntries = clustersSection!.match(/^ {2}- name:/gm);
      expect(clusterEntries).toHaveLength(2 + 28);
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
      expect(yaml).toContain(
        `${ENVOY_MITM_CERTS_CONTAINER_DIR}/api.slack.com-key.pem`,
      );
      expect(yaml).toContain(`cluster: ${ENVOY_MITM_CLUSTER_NAME}`);
    });

    it("does not include inspected domain in passthrough server_names", () => {
      const rules: EgressRule[] = [
        { dst: "api.slack.com", proto: "tls", action: "allow", inspect: true },
        { dst: "other.com", proto: "tls", action: "allow" },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      // Extract the passthrough filter chain section
      const passthroughSection =
        yaml.split("Whitelisted TLS domains")[1]?.split("Default deny")[0] ??
        "";
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
      expect(yaml).toContain(
        `${ENVOY_MITM_CERTS_CONTAINER_DIR}/a.com-cert.pem`,
      );
      expect(yaml).toContain(
        `${ENVOY_MITM_CERTS_CONTAINER_DIR}/b.com-cert.pem`,
      );
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
      const passthroughSection =
        yaml.split("Whitelisted TLS domains")[1]?.split("Default deny")[0] ??
        "";
      expect(passthroughSection).toContain('"pass.com"');
      // inspect.com in MITM filter chain
      expect(yaml).toContain(
        `${ENVOY_MITM_CERTS_CONTAINER_DIR}/inspect.com-cert.pem`,
      );
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

    it("has base + MITM + UDP clusters when inspect rules exist", () => {
      const rules: EgressRule[] = [
        { dst: "x.com", proto: "tls", action: "allow", inspect: true },
      ];
      const { yaml } = renderEnvoyConfig(rules);
      const clustersSection = yaml.split(/\n {2}clusters:\n/)[1];
      expect(clustersSection).toBeDefined();
      const clusterEntries = clustersSection!.match(/^ {2}- name:/gm);
      // 2 base + 1 MITM + 28 UDP = 31
      expect(clusterEntries).toHaveLength(2 + 1 + 28);
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

  describe("domain validation", () => {
    it("skips domains with YAML-special characters and emits warning", () => {
      const rules: EgressRule[] = [
        { dst: '"; rm -rf /', proto: "tls", action: "allow" },
      ];
      const { yaml, warnings } = renderEnvoyConfig(rules);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
      expect(yaml).not.toContain("rm -rf");
    });

    it("skips domains with spaces", () => {
      const rules: EgressRule[] = [
        { dst: "evil domain.com", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
    });

    it("skips domains with leading hyphens", () => {
      const rules: EgressRule[] = [
        { dst: "-evil.com", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
    });

    it("skips invalid SSH/TCP destinations with warning", () => {
      const rules: EgressRule[] = [
        { dst: '"; drop table', proto: "ssh", port: 22, action: "allow" },
      ];
      const { warnings, tcpPortMappings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        true,
      );
      expect(tcpPortMappings).toHaveLength(0);
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

    it("accepts wildcard domains through validation", () => {
      const rules: EgressRule[] = [
        { dst: "*.example.com", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        false,
      );
    });

    it("accepts IPv4 addresses through validation", () => {
      const rules: EgressRule[] = [
        { dst: "10.0.0.1", proto: "tls", action: "allow" },
      ];
      const { warnings } = renderEnvoyConfig(rules);
      expect(warnings.some((w) => w.includes("Invalid destination"))).toBe(
        false,
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

    it("throws for path containing newlines", () => {
      const rules: EgressRule[] = [
        {
          dst: "example.com",
          proto: "tls",
          action: "allow",
          inspect: true,
          pathRules: [{ path: "/api/\ninject", action: "deny" }],
        },
      ];
      expect(() => renderEnvoyConfig(rules)).toThrow("forbidden characters");
    });
  });
});
