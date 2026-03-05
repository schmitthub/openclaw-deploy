// Envoy
export const ENVOY_IMAGE = "envoyproxy/envoy:v1.33-latest";
export const ENVOY_EGRESS_PORT = 10000;
export const ENVOY_TCP_PORT_BASE = 10001;
export const ENVOY_UID = 101;
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
export const DEFAULT_OPENCLAW_CONFIG_DIR = "/home/node/.openclaw";
export const DEFAULT_OPENCLAW_WORKSPACE_DIR = "/home/node/.openclaw/workspace";
export const DOCKER_BASE_IMAGE = "node:22-bookworm";
export const NODE_COMPILE_CACHE_DIR = "/home/node/.node-compile-cache";

// SSH access (replaces ttyd/filebrowser web tools)
export const SSHD_PORT = 2222;

// Core apt packages (always installed)
export const CORE_APT_PACKAGES = [
  "gosu",
  "libsecret-tools",
  "build-essential", // Homebrew requirement (compiling from source when bottles unavailable)
  "ripgrep",
  "jq",
  "openssh-server",
];

// Tailscale Funnel allowed ports
export const TAILSCALE_FUNNEL_PORTS = [443, 8443, 10000];

// Supported VPS providers
export const PROVIDERS = ["hetzner", "digitalocean", "oracle"] as const;

// Tailscale sidecar
export const TAILSCALE_IMAGE = "tailscale/tailscale:v1.94.2";
export const TAILSCALE_STATE_DIR = "/var/lib/tailscale";
export const TAILSCALE_HEALTH_PORT = 9002;

// Host paths (per-profile directories on the remote VPS)
export const buildDir = (profile: string) =>
  `/opt/openclaw-deploy/build/${profile}`;
export const dataDir = (profile: string) =>
  `/opt/openclaw-deploy/data/${profile}`;

// Oracle Cloud (OCI) defaults
export const OCI_ARM_SHAPE_PREFIX = "VM.Standard.A1";
export const OCI_DEFAULT_OCPUS = 2;
export const OCI_DEFAULT_MEMORY_GBS = 12;
