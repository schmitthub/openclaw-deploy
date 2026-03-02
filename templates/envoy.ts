import { EgressRule, PathRule } from "../config/types";
import { mergeEgressPolicy } from "../config/domains";
import {
  ENVOY_EGRESS_PORT,
  ENVOY_DNS_PORT,
  CLOUDFLARE_DNS_PRIMARY,
  CLOUDFLARE_DNS_SECONDARY,
  ENVOY_MITM_CERTS_CONTAINER_DIR,
  ENVOY_MITM_CLUSTER_NAME,
} from "../config/defaults";

export interface EnvoyConfigResult {
  yaml: string;
  warnings: string[];
  /** Domains requiring per-domain certs for MITM TLS inspection */
  inspectedDomains: string[];
}

interface MitmDomainConfig {
  domain: string;
  pathRules: PathRule[];
}

/** Convert a PathRule path to an Envoy route match line (prefix or exact). */
function renderRouteMatch(path: string): string {
  if (path.endsWith("*")) {
    return `prefix: "${path.slice(0, -1)}"`;
  }
  return `path: "${path}"`;
}

/** Render Envoy route entries for an inspected domain's pathRules. */
function renderPathRoutes(pathRules: PathRule[]): string {
  const lines: string[] = [];

  // Deny routes (matched before catch-all)
  for (const pr of pathRules) {
    lines.push(`              - match:
                  ${renderRouteMatch(pr.path)}
                direct_response:
                  status: 403
                  body:
                    inline_string: "Blocked by egress policy"`);
  }

  // Catch-all: forward all remaining traffic to upstream
  lines.push(`              - match:
                  prefix: "/"
                route:
                  cluster: ${ENVOY_MITM_CLUSTER_NAME}`);

  return lines.join("\n");
}

/** Render a single MITM filter chain for an inspected domain. */
function renderMitmFilterChain(config: MitmDomainConfig): string {
  const { domain, pathRules } = config;
  const safeName = domain.replace(/\./g, "_");
  const certPath = `${ENVOY_MITM_CERTS_CONTAINER_DIR}/${domain}-cert.pem`;
  const keyPath = `${ENVOY_MITM_CERTS_CONTAINER_DIR}/${domain}-key.pem`;
  const routeEntries = renderPathRoutes(pathRules);

  return `    # MITM TLS inspection: ${domain}
    - filter_chain_match:
        server_names:
        - "${domain}"
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          common_tls_context:
            tls_certificates:
            - certificate_chain:
                filename: "${certPath}"
              private_key:
                filename: "${keyPath}"
      filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: mitm_${safeName}
          codec_type: AUTO
          route_config:
            name: mitm_route_${safeName}
            virtual_hosts:
            - name: ${safeName}
              domains: ["${domain}"]
              routes:
${routeEntries}
          http_filters:
          - name: envoy.filters.http.dynamic_forward_proxy
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig
              dns_cache_config:
                name: mitm_forward_proxy_cache
                dns_lookup_family: V4_PREFERRED
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router`;
}

/** Render the MITM forward cluster for TLS origination to upstream.
 * The dynamic_forward_proxy cluster derives upstream SNI from the resolved
 * hostname automatically — no explicit auto_sni config needed. */
function renderMitmCluster(): string {
  return `
  - name: ${ENVOY_MITM_CLUSTER_NAME}
    lb_policy: CLUSTER_PROVIDED
    cluster_type:
      name: envoy.clusters.dynamic_forward_proxy
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig
        dns_cache_config:
          name: mitm_forward_proxy_cache
          dns_lookup_family: V4_PREFERRED
    transport_socket:
      name: envoy.transport_sockets.tls
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
        common_tls_context:
          validation_context:
            trusted_ca:
              filename: /etc/ssl/certs/ca-certificates.crt`;
}

/**
 * Renders envoy.yaml from an egress policy.
 *
 * Egress-only: no ingress listener.
 * Tailscale handles all ingress. Envoy handles transparent egress + DNS.
 * TLS rules with inspect:true use MITM termination for path-level filtering.
 * All other TLS rules use SNI-based passthrough (no TLS termination).
 */
export function renderEnvoyConfig(
  userRules: EgressRule[] = [],
): EnvoyConfigResult {
  const warnings: string[] = [];
  const merged = mergeEgressPolicy(userRules);

  const passthroughDomains: string[] = [];
  const inspectedDomains: string[] = [];
  const mitmConfigs: MitmDomainConfig[] = [];

  for (const rule of merged) {
    if (rule.action === "deny") {
      continue;
    }

    switch (rule.proto) {
      case "tls":
        if (rule.inspect) {
          if (rule.dst.includes("*")) {
            warnings.push(
              `Wildcard domain "${rule.dst}" cannot use MITM inspection — treating as passthrough`,
            );
            passthroughDomains.push(rule.dst);
          } else {
            inspectedDomains.push(rule.dst);
            mitmConfigs.push({
              domain: rule.dst,
              pathRules: rule.pathRules ?? [],
            });
          }
        } else {
          passthroughDomains.push(rule.dst);
        }
        break;

      case "ssh":
        warnings.push(
          `SSH egress rule for "${rule.dst}" skipped — requires DNS snooping (Phase 2)`,
        );
        break;

      case "tcp":
        warnings.push(
          `TCP egress rule for "${rule.dst}" skipped — requires DNS snooping (Phase 2)`,
        );
        break;
    }
  }

  const domainLines = passthroughDomains
    .map((d) => `        - "${d}"`)
    .join("\n");

  const mitmFilterChains = mitmConfigs
    .map(renderMitmFilterChain)
    .join("\n");

  const hasMitm = inspectedDomains.length > 0;
  const mitmClusterSection = hasMitm ? renderMitmCluster() : "";

  const yaml = `# Generated by openclaw-deploy. Do not edit directly.
#
# Envoy egress-only proxy: transparent TLS proxy${hasMitm ? " + MITM inspection" : ""} + DNS forwarder.
# Ingress is handled by Tailscale (no ingress listener here).
# Egress uses TLS Inspector + SNI-based domain whitelist.${hasMitm ? "\n# Domains with inspect:true use MITM TLS termination for path-level filtering." : " No MITM / TLS termination."}
# All outbound TCP from the gateway is DNAT'd here by iptables in entrypoint.sh.
# Restart after editing: docker compose restart envoy

static_resources:
  listeners:
  # Egress: transparent TLS proxy with SNI-based domain whitelist.
  # All outbound TCP from the gateway is DNAT'd here by iptables.
  # TLS Inspector reads SNI from ClientHello.
  # Whitelisted SNI -> forwarded${hasMitm ? " (passthrough or MITM inspected)" : ""}. Everything else -> connection refused.
  - name: egress
    address:
      socket_address:
        address: 0.0.0.0
        port_value: ${ENVOY_EGRESS_PORT}
    listener_filters:
    - name: envoy.filters.listener.tls_inspector
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector
    filter_chains:
${mitmFilterChains ? mitmFilterChains + "\n" : ""}    # Whitelisted TLS domains — passthrough (matched by SNI from ClientHello).
    - filter_chain_match:
        server_names:
${domainLines}
      filters:
      - name: envoy.filters.network.sni_dynamic_forward_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.sni_dynamic_forward_proxy.v3.FilterConfig
          port_value: 443
          dns_cache_config:
            name: dynamic_forward_proxy_cache
            dns_lookup_family: V4_PREFERRED
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: egress_tls_allowed
          cluster: dynamic_forward_proxy_cluster
    # Default deny: non-whitelisted SNI or non-TLS traffic.
    # Connection is immediately reset (deny_cluster has no endpoints).
    - filters:
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: egress_denied
          cluster: deny_cluster

  # DNS: forward resolver for containers on the internal network.
  # Docker's embedded DNS cannot forward external queries from internal-only
  # networks. Gateway services use dns: [172.28.0.2] (Envoy's static IP)
  # so Docker DNS forwards here instead of failing with SERVFAIL.
  # Upstream: Cloudflare ${CLOUDFLARE_DNS_PRIMARY} / ${CLOUDFLARE_DNS_SECONDARY} (malware-blocking DNS).
  - name: dns
    address:
      socket_address:
        address: 0.0.0.0
        port_value: ${ENVOY_DNS_PORT}
        protocol: UDP
    listener_filters:
    - name: envoy.filters.udp.dns_filter
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.filters.udp.dns_filter.v3.DnsFilterConfig
        stat_prefix: dns
        client_config:
          resolver_timeout: 5s
          max_pending_lookups: 256
          typed_dns_resolver_config:
            name: envoy.network.dns_resolver.cares
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.network.dns_resolver.cares.v3.CaresDnsResolverConfig
              resolvers:
              - socket_address:
                  address: "${CLOUDFLARE_DNS_PRIMARY}"
                  port_value: 53
              - socket_address:
                  address: "${CLOUDFLARE_DNS_SECONDARY}"
                  port_value: 53

  clusters:
  - name: dynamic_forward_proxy_cluster
    lb_policy: CLUSTER_PROVIDED
    cluster_type:
      name: envoy.clusters.dynamic_forward_proxy
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig
        dns_cache_config:
          name: dynamic_forward_proxy_cache
          dns_lookup_family: V4_PREFERRED
${mitmClusterSection}
  - name: deny_cluster
    type: STATIC
    connect_timeout: 0.25s
    load_assignment:
      cluster_name: deny_cluster
`;

  return { yaml, warnings, inspectedDomains };
}
