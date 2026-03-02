// Docker network constants
export const INTERNAL_NETWORK_SUBNET = "172.28.0.0/24";
export const ENVOY_STATIC_IP = "172.28.0.2";
export const INTERNAL_NETWORK_NAME = "openclaw-internal";
export const EGRESS_NETWORK_NAME = "openclaw-egress";

// Envoy
export const ENVOY_IMAGE = "envoyproxy/envoy:v1.33-latest";
export const ENVOY_EGRESS_PORT = 10000;
export const ENVOY_DNS_PORT = 53;
export const CLOUDFLARE_DNS_PRIMARY = "1.1.1.2";
export const CLOUDFLARE_DNS_SECONDARY = "1.0.0.2";
export const ENVOY_CONFIG_HOST_DIR = "/opt/openclaw-deploy/envoy";
export const ENVOY_CA_CERT_PATH = "/opt/openclaw-deploy/envoy/ca-cert.pem";
export const ENVOY_CA_KEY_PATH = "/opt/openclaw-deploy/envoy/ca-key.pem";

// MITM TLS inspection
export const ENVOY_MITM_CERTS_HOST_DIR = "/opt/openclaw-deploy/envoy/certs";
export const ENVOY_MITM_CERTS_CONTAINER_DIR = "/etc/envoy/certs";
export const ENVOY_MITM_CLUSTER_NAME = "mitm_forward_cluster";

// Gateway defaults
export const DEFAULT_GATEWAY_PORT = 18789;
export const DEFAULT_BRIDGE_PORT = 18790;
export const DEFAULT_OPENCLAW_CONFIG_DIR = "/home/node/.openclaw";
export const DEFAULT_OPENCLAW_WORKSPACE_DIR = "/home/node/.openclaw/workspace";
export const DEFAULT_GATEWAY_BIND = "lan";
export const DOCKER_BASE_IMAGE = "node:22-bookworm";

// Core apt packages (always installed)
export const CORE_APT_PACKAGES = ["iptables", "iproute2", "gosu", "libsecret-tools"];

// Tailscale Funnel allowed ports
export const TAILSCALE_FUNNEL_PORTS = [443, 8443, 10000];

// Oracle Cloud (OCI) defaults
export const OCI_ARM_SHAPE_PREFIX = "VM.Standard.A1";
export const OCI_DEFAULT_OCPUS = 2;
export const OCI_DEFAULT_MEMORY_GBS = 12;
