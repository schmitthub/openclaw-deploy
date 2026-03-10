// Envoy (digest-pinned — update via `make update-digests`)
export const ENVOY_IMAGE =
  "envoyproxy/envoy:v1.33-latest@sha256:f91c972d5c99bc133233a079b5663b903e7d56b3b0b0216398924f7b80d09e47";
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

// CoreDNS (DNS allowlist proxy — runs inside gateway container)
export const COREDNS_PORT = 5300;
export const COREDNS_VERSION = "1.12.1";
export const COREDNS_CONFIG_HOST_DIR = "/opt/openclaw-deploy/coredns";
export const COREDNS_CONTAINER_PATH = "/etc/coredns/Corefile";

// Gateway defaults
export const DEFAULT_GATEWAY_PORT = 18789;
export const DEFAULT_OPENCLAW_CONFIG_DIR = "/home/node/.openclaw";
export const DEFAULT_OPENCLAW_WORKSPACE_DIR = "/home/node/.openclaw/workspace";

// Base images (digest-pinned — update via `make update-digests`)
export const DOCKER_BASE_IMAGE =
  "node:22-bookworm@sha256:b501c082306a4f528bc4038cbf2fbb58095d583d0419a259b2114b5ac53d12e9";
export const DOCKER_DOWNLOADS_IMAGE =
  "debian:bookworm-slim@sha256:74d56e3931e0d5a1dd51f8c8a2466d21de84a271cd3b5a733b803aa91abf4421";
export const DOCKER_BASE_IMAGE_NAME = nameFromImageRef(DOCKER_BASE_IMAGE);
export const DOCKER_BASE_IMAGE_DIGEST = digestFromImageRef(DOCKER_BASE_IMAGE);
export const NODE_COMPILE_CACHE_DIR = "/home/node/.node-compile-cache";

// SSH access
export const SSHD_PORT = 2222;

// Firewall bypass (root-only SOCKS proxy)
export const BYPASS_SOCKS_PORT = 9100;
export const DEFAULT_BYPASS_TIMEOUT_SECS = 30;

// Filebrowser (web file manager, served via Tailscale Serve at /browse)
export const FILEBROWSER_PORT = 8080;

// Core apt packages (always installed)
export const CORE_APT_PACKAGES = [
  "gosu",
  "libsecret-tools",
  "build-essential", // Homebrew requirement (compiling from source when bottles unavailable)
  "ripgrep",
  "jq",
  "openssh-server",
  "dante-server", // SOCKS5 proxy server for firewall bypass (root-only, supports UDP ASSOCIATE)
  "proxychains4", // SOCKS5 client wrapper for agent convenience (transparent TCP proxying)
];

// Tailscale Funnel allowed ports
export const TAILSCALE_FUNNEL_PORTS = [443, 8443, 10000];

// Supported VPS providers
export const PROVIDERS = ["hetzner", "digitalocean", "oracle"] as const;

// Tailscale sidecar (digest-pinned — update via `make update-digests`)
export const TAILSCALE_IMAGE =
  "tailscale/tailscale:v1.94.2@sha256:95e528798bebe75f39b10e74e7051cf51188ee615934f232ba7ad06a3390ffa1";
export const TAILSCALE_STATE_DIR = "/var/lib/tailscale";
export const TAILSCALE_HEALTH_PORT = 9002;

// Host paths (per-profile directories on the remote VPS)
export const buildDir = (profile: string) =>
  `/opt/openclaw-deploy/build/${profile}`;
export const dataDir = (profile: string) =>
  `/opt/openclaw-deploy/data/${profile}`;

// Domain validation (shared between templates/envoy.ts and components/envoy.ts)
// Accepts: "example.com", "*.example.com" (wildcard prefix only, requires ≥2 labels after *)
// Rejects: "*.com" (too broad), "foo.*.com" (mid-label), "**.com", "*com", bare "*"
// Uses + (not *) on the final group to require at least two labels total, preventing
// overly broad wildcards like "*.com" that would match all .com subdomains.
export const DOMAIN_VALIDATION_RE =
  /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/** Escape wildcard `*` in domain to produce filesystem-safe names.
 *  e.g. "*.example.com" → "_wildcard_.example.com" */
export function safeFileDomain(domain: string): string {
  return domain.replace(/\*/g, "_wildcard_");
}

function nameFromImageRef(imageRef: string): string {
  const at = imageRef.indexOf("@");
  return at === -1 ? imageRef : imageRef.slice(0, at);
}

function digestFromImageRef(imageRef: string): string {
  const at = imageRef.indexOf("@");
  if (at === -1) {
    throw new Error(`Image ref is not digest-pinned: ${imageRef}`);
  }
  return imageRef.slice(at + 1);
}

// Oracle Cloud (OCI) defaults
export const OCI_ARM_SHAPE_PREFIX = "VM.Standard.A1";
export const OCI_DEFAULT_OCPUS = 2;
export const OCI_DEFAULT_MEMORY_GBS = 12;
