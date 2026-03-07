import { EgressRule, PathRule, TcpPortMapping } from "../config/types";
import { mergeEgressPolicy } from "../config/domains";
import {
  ENVOY_EGRESS_PORT,
  ENVOY_TCP_PORT_BASE,
  ENVOY_MITM_CERTS_CONTAINER_DIR,
  ENVOY_MITM_CLUSTER_NAME,
  DOMAIN_VALIDATION_RE,
  safeFileDomain,
} from "../config/defaults";

export interface EnvoyConfigResult {
  yaml: string;
  warnings: string[];
  /** Domains requiring per-domain certs for MITM TLS inspection */
  inspectedDomains: string[];
  /** Per-rule port mappings for SSH/TCP egress (passed to sidecar entrypoint via OPENCLAW_TCP_MAPPINGS) */
  tcpPortMappings: TcpPortMapping[];
}

interface MitmDomainConfig {
  domain: string;
  pathRules: PathRule[];
}

/** Validate and convert a PathRule path to an Envoy route match line (prefix or exact). */
function renderRouteMatch(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`Invalid pathRule path "${path}": must start with /`);
  }
  if (/["\n\r]/.test(path)) {
    throw new Error(
      `Invalid pathRule path "${path}": contains forbidden characters`,
    );
  }
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
  const safeName = safeFileDomain(domain).replace(/\./g, "_");
  const fileDomain = safeFileDomain(domain);
  const certPath = `${ENVOY_MITM_CERTS_CONTAINER_DIR}/${fileDomain}-cert.pem`;
  const keyPath = `${ENVOY_MITM_CERTS_CONTAINER_DIR}/${fileDomain}-key.pem`;
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
 * The dynamic_forward_proxy cluster derives upstream SNI from the HTTP
 * Host/:authority header automatically — no explicit auto_sni config needed. */
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

/** Render a dedicated TCP proxy listener for a single SSH/TCP egress rule. */
function renderTcpListener(mapping: TcpPortMapping): string {
  const safeName = `${mapping.proto}_${mapping.dst.replace(/[.:]/g, "_")}_${mapping.dstPort}`;
  const clusterName = `tcp_${safeName}`;
  return `
  # ${mapping.proto.toUpperCase()} egress: ${mapping.dst}:${mapping.dstPort} → :${mapping.envoyPort}
  - name: ${safeName}
    address:
      socket_address:
        address: 0.0.0.0
        port_value: ${mapping.envoyPort}
    filter_chains:
    - filters:
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: ${safeName}
          cluster: ${clusterName}
          idle_timeout: 0s`;
}

/** Render a STRICT_DNS or STATIC cluster for a single SSH/TCP egress rule.
 * Uses system DNS (inherited from sidecar's Cloudflare config via shared netns). */
function renderTcpCluster(mapping: TcpPortMapping): string {
  const safeName = `${mapping.proto}_${mapping.dst.replace(/[.:]/g, "_")}_${mapping.dstPort}`;
  const clusterName = `tcp_${safeName}`;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(mapping.dst);
  const isIpv6 = mapping.dst.includes(":");
  const isIp = isIpv4 || isIpv6;

  if (isIp) {
    return `
  - name: ${clusterName}
    type: STATIC
    connect_timeout: 5s
    load_assignment:
      cluster_name: ${clusterName}
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              socket_address:
                address: "${mapping.dst}"
                port_value: ${mapping.dstPort}`;
  }

  return `
  - name: ${clusterName}
    type: STRICT_DNS
    connect_timeout: 5s
    dns_lookup_family: V4_PREFERRED
    load_assignment:
      cluster_name: ${clusterName}
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              socket_address:
                address: "${mapping.dst}"
                port_value: ${mapping.dstPort}`;
}

/**
 * Renders envoy.yaml from an egress policy.
 *
 * Egress-only: no ingress listener, no DNS listener.
 * Tailscale handles all ingress. Envoy handles transparent egress only.
 * DNS is provided by Docker (sidecar uses dns: [Cloudflare] which is inherited via shared netns).
 * TLS rules with inspect:true use MITM termination for path-level filtering.
 * All other TLS rules use SNI-based passthrough (no TLS termination).
 */
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function renderEnvoyConfig(
  userRules: EgressRule[] = [],
): EnvoyConfigResult {
  const warnings: string[] = [];
  const merged = mergeEgressPolicy(userRules);

  const passthroughDomains: string[] = [];
  const inspectedDomains: string[] = [];
  const mitmConfigs: MitmDomainConfig[] = [];
  const tcpMappings: TcpPortMapping[] = [];

  for (const rule of merged) {
    if (rule.action === "deny") {
      continue;
    }

    switch (rule.proto) {
      case "tls":
        // Validate domain before interpolating into YAML (CIDRs not valid for TLS)
        if (!DOMAIN_VALIDATION_RE.test(rule.dst) && !IP_RE.test(rule.dst)) {
          warnings.push(`Invalid destination "${rule.dst}" — skipped`);
          break;
        }
        if (rule.inspect) {
          inspectedDomains.push(rule.dst);
          mitmConfigs.push({
            domain: rule.dst,
            pathRules: rule.pathRules ?? [],
          });
        } else {
          passthroughDomains.push(rule.dst);
        }
        break;

      case "ssh":
      case "tcp": {
        // Validate destination before interpolating into YAML
        if (
          !DOMAIN_VALIDATION_RE.test(rule.dst) &&
          !IP_RE.test(rule.dst) &&
          !rule.dst.includes("/") &&
          !rule.dst.includes(":")
        ) {
          warnings.push(`Invalid destination "${rule.dst}" — skipped`);
          break;
        }
        if (rule.dst.includes("/")) {
          warnings.push(
            `CIDR destination "${rule.dst}" not supported for ${rule.proto.toUpperCase()} egress — use a specific IP or domain`,
          );
          break;
        }
        if (rule.port === undefined) {
          warnings.push(
            `${rule.proto.toUpperCase()} egress rule for "${rule.dst}" missing required port — skipped`,
          );
          break;
        }
        if (rule.dst.includes(":")) {
          warnings.push(
            `IPv6 destination "${rule.dst}" for ${rule.proto.toUpperCase()} rule — Envoy listener created but gateway iptables routing is IPv4-only (traffic may not route until dual-stack internal network is supported)`,
          );
        }
        const envoyPort = ENVOY_TCP_PORT_BASE + tcpMappings.length;
        tcpMappings.push({
          dst: rule.dst,
          dstPort: rule.port,
          proto: rule.proto,
          envoyPort,
        });
        break;
      }

      default:
        warnings.push(
          `Unknown protocol "${(rule as EgressRule).proto}" for destination "${rule.dst}" — skipped`,
        );
        break;
    }
  }

  const domainLines = passthroughDomains
    .map((d) => `        - "${d}"`)
    .join("\n");

  const mitmFilterChains = mitmConfigs.map(renderMitmFilterChain).join("\n");

  const hasMitm = inspectedDomains.length > 0;
  const mitmClusterSection = hasMitm ? renderMitmCluster() : "";

  const tcpListenerSection = tcpMappings.map(renderTcpListener).join("\n");
  const tcpClusterSection = tcpMappings.map(renderTcpCluster).join("\n");

  const yaml = `# Generated by openclaw-deploy. Do not edit directly.
#
# Envoy egress-only proxy: transparent TLS proxy${hasMitm ? " + MITM inspection" : ""}.
# Ingress is handled by Tailscale (no ingress listener here).
# DNS is provided by Docker (sidecar uses dns: [Cloudflare], inherited via shared netns).
# Egress uses TLS Inspector + SNI-based domain whitelist.${hasMitm ? "\n# Domains with inspect:true use MITM TLS termination for path-level filtering." : " No MITM / TLS termination."}
# All outbound TCP from the gateway is redirected here by iptables in sidecar-entrypoint.sh.
# Restart after editing: docker restart envoy-<profile>

static_resources:
  listeners:
  # Egress: transparent TLS proxy with SNI-based domain whitelist.
  # All outbound TCP from the gateway is redirected here by iptables.
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
          idle_timeout: 0s
    # Default deny: non-whitelisted SNI or non-TLS traffic.
    # Connection is immediately reset (deny_cluster has no endpoints).
    - filters:
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: egress_denied
          cluster: deny_cluster
          idle_timeout: 0s
${tcpListenerSection}
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
    upstream_connection_options:
      tcp_keepalive:
        keepalive_time: 60
        keepalive_interval: 10
        keepalive_probes: 3
${mitmClusterSection}
${tcpClusterSection}
  - name: deny_cluster
    type: STATIC
    connect_timeout: 0.25s
    load_assignment:
      cluster_name: deny_cluster
`;

  return {
    yaml,
    warnings,
    inspectedDomains,
    tcpPortMappings: tcpMappings,
  };
}
