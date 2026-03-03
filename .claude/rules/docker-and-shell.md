---
globs: ["**/Dockerfile*", "**/*.sh", "templates/dockerfile.ts", "templates/entrypoint.ts", "templates/envoy.ts"]
---

# Docker & Shell Artifact Rules

## Generated Artifacts (rendered by templates/)

Templates are pure TypeScript functions that return strings. They are called at Pulumi plan time
and uploaded to remote hosts via `command.remote.Command` (base64-encoded).

| Template | Output | Purpose |
|----------|--------|---------|
| `templates/dockerfile.ts` | `Dockerfile` | `node:22-bookworm` + iptables + iproute2 + gosu + libsecret-tools + pnpm + bun + brew + uv + tailscale + openclaw |
| `templates/entrypoint.ts` | `entrypoint.sh` | Root-owned: iptables DNAT + FILTER → tailscaled → gosu node |
| `templates/envoy.ts` | `envoy.yaml` | Egress-only: transparent TLS proxy (SNI whitelist) + DNS forwarder |

Artifacts are written to the remote host at `/opt/openclaw-deploy/build/<profile>/` (Dockerfile, entrypoint.sh)
and `/opt/openclaw-deploy/envoy/envoy.yaml` (Envoy config).

## Dockerfile Conventions
- Base: `node:22-bookworm` (matches official OpenClaw Docker pattern)
- Always installs `iptables`, `iproute2`, `gosu`, and `libsecret-tools` (egress security + keychain)
- `pnpm` installed via `npm install -g pnpm`; `PNPM_HOME=/home/node/.local/share/pnpm` for global bin dir
- `bun` installed via `curl -fsSL https://bun.sh/install | bash` then **copied** to `/usr/local/bin/bun` (symlinks through `/root/` fail — mode 0700)
- `uv` (Python package manager) installed via official install script as node user
- Tailscale (`tailscaled` + `tailscale` CLI) installed via official install script (~20MB, always installed)
- Homebrew (Linuxbrew) installed via official install script as `node` user; available via PATH
- OpenClaw installed via `npm install -g openclaw@<version>`
- `SHARP_IGNORE_GLOBAL_LIBVIPS=1` set during npm install
- `NODE_OPTIONS=--max-old-space-size=2048` during npm install (prevents OOM on low-memory hosts)
- CLI symlink: `ln -sf "$(npm root -g)/openclaw/dist/entry.js" /usr/local/bin/openclaw`
- Optional `OPENCLAW_INSTALL_BROWSER` ARG: bakes Playwright + Chromium + Xvfb (~300MB)
- `COPY entrypoint.sh /usr/local/bin/entrypoint.sh` — root-owned, 0755
- `ENTRYPOINT ["entrypoint.sh"]` runs as root to set iptables, then drops to `node`
- `CMD ["openclaw", "gateway", "--bind", "lan", "--port", "18789"]` (overridden by container command)
- `OPENCLAW_DOCKER_APT_PACKAGES` ARG for optional additional packages via `packages` config
- `OPENCLAW_PREFER_PNPM=1` env var (Bun may fail on ARM/Synology)
- No dev tools (zsh, git-delta, hadolint, fzf)

## Entrypoint Security Model
The `entrypoint.sh` script enforces transparent egress isolation via iptables:
1. Resolves Envoy's IP via `getent hosts envoy`
2. Derives `INTERNAL_SUBNET` from Envoy's IP (strip last octet, append `.0/24`)
3. Adds default route via Envoy (`ip route add default via $ENVOY_IP`) — required because `internal: true` networks have no gateway
4. Flushes existing rules, then restores Docker's `DOCKER_OUTPUT` chain jump (Docker DNS depends on it)
5. NAT table: skip DNAT for loopback (`-o lo`) and internal subnet
6. Processes `OPENCLAW_TCP_MAPPINGS` env var (if set) — per-destination TCP DNAT rules for SSH/TCP egress. Each semicolon-delimited entry (`dst|dstPort|envoyPort`) resolves the domain to IP via `getent ahostsv4` and adds a destination-specific iptables DNAT rule routing matching traffic to a dedicated Envoy listener port. IP destinations skip resolution. Malformed entries and unresolvable domains emit warnings and are skipped.
7. Processes `OPENCLAW_UDP_MAPPINGS` env var (if set) — per-destination UDP DNAT rules for UDP egress. Same format and resolution logic as TCP mappings but uses `-p udp` for iptables rules.
8. Catch-all DNAT: all remaining outbound TCP to Envoy's transparent TLS proxy listener (:10000)
9. FILTER table: `OUTPUT DROP` default policy. Allows: loopback, Docker DNS (127.0.0.11:53 UDP), established/related, internal subnet
10. Starts `tailscaled` (if `/var/lib/tailscale` dir is mounted) with `--tun=userspace-networking`. Waits for daemon ready, authenticates with `TAILSCALE_AUTHKEY` env var if set and not already authenticated. Runs AFTER iptables so Tailscale traffic routes through Envoy.
11. Drops to `node` user via `exec gosu node "$@"`

Apps are unaware of the proxy — they connect normally and iptables rewrites the destination.
The `node` user cannot modify iptables rules (requires `CAP_NET_ADMIN` which only root has).

## Envoy Configuration (egress-only)
- **No ingress listener** — Tailscale handles all ingress (Serve/Funnel)
- **Egress listener (:10000)**: Transparent TLS proxy with SNI-based domain whitelist. All outbound TCP from gateway is DNAT'd here by iptables.
- **DNS listener (:53 UDP)**: Forwards DNS queries to Cloudflare malware-blocking resolvers (1.1.1.2 / 1.0.0.2). Uses `envoy.filters.udp.dns_filter` with c-ares resolver.
- TLS Inspector listener filter reads SNI from ClientHello without terminating TLS (no MITM)
- Domain ACL via `filter_chain_match.server_names` matching TLS SNI
- Non-TLS, non-mapped traffic (plain HTTP, unmapped raw TCP) is denied — no SNI to inspect and no port mapping
- `sni_dynamic_forward_proxy` resolves whitelisted domains via DNS and forwards to port 443
- DNS lookup family: `V4_PREFERRED` — prefers IPv4 but falls back to IPv6 if no A record exists (Docker networks are IPv4-only by default; `AUTO` causes failures on IPv6-first resolvers)
- `deny_cluster` (STATIC, no endpoints) immediately resets non-whitelisted connections
- **SSH/TCP listeners (:10001+)**: Per-rule dedicated `tcp_proxy` listeners for SSH/TCP egress rules. Each rule gets a sequential port starting from `ENVOY_TCP_PORT_BASE` (10001). Uses `STRICT_DNS` clusters for domain destinations (with Cloudflare dns_resolvers) and `STATIC` clusters for IP destinations.
- **UDP listeners (:10100+)**: Per-rule dedicated `udp_proxy` listeners for UDP egress rules. Each rule gets a sequential port starting from `ENVOY_UDP_PORT_BASE` (10100). Uses `STRICT_DNS` clusters for domain destinations and `STATIC` clusters for IP destinations. Hardcoded: 28 Tailscale DERP relay STUN listeners (derp1–28.tailscale.com:3478).
- Hardcoded domains defined in `config/domains.ts` (no wildcards for Tailscale — enumerated specifically), user rules additive via `egressPolicy` config
- Warnings emitted for CIDR SSH/TCP/UDP destinations (not supported) and missing port on SSH/TCP/UDP rules

## Docker Container Conventions
- Gateway containers run on `internal: true` network only — no direct internet access
- Envoy container on both internal and egress networks (sole bridge to internet)
- Envoy has static IP `172.28.0.2` on internal network (IPAM subnet `172.28.0.0/24`)
- Envoy runs as non-root `envoy` user with `sysctls: [net.ipv4.ip_unprivileged_port_start=53]`
- Gateway uses `capabilities.adds: [NET_ADMIN]` — required by root entrypoint for iptables
- Gateway uses `dns: [172.28.0.2]` so Docker DNS forwards external queries to Envoy
- Gateway has `init: true`, `restart: unless-stopped`
- Gateway command: `openclaw gateway --tailscale serve --port <port>` (when Tailscale enabled) or `openclaw gateway --bind lan --port <port>` (when off)
- No `HTTP_PROXY`/`HTTPS_PROXY` env vars — iptables DNAT handles all routing transparently
- `OPENCLAW_TCP_MAPPINGS` env var (optional): semicolon-delimited `dst|dstPort|envoyPort` entries for SSH/TCP egress. Set by the Gateway component when `tcpPortMappings` is non-empty. Processed by entrypoint.sh to create per-destination iptables DNAT rules.
- `OPENCLAW_UDP_MAPPINGS` env var (optional): semicolon-delimited `dst|dstPort|envoyPort` entries for UDP egress. Set by the Gateway component when `udpPortMappings` is non-empty. Processed by entrypoint.sh to create per-destination iptables UDP DNAT rules.
- `OPENCLAW_GATEWAY_TOKEN` env var (secret): gateway auth token, always set. Takes precedence over config file in local mode.
- `TAILSCALE_AUTHKEY` env var (secret, optional): one-time Tailscale auth key, set when `tailscale != "off"`. Consumed by entrypoint.sh to authenticate `tailscaled`.
- `TS_SOCKET=/var/run/tailscale/tailscaled.sock` env var: set when Tailscale enabled so the `tailscale` CLI (used by OpenClaw's `--tailscale serve`) can find the daemon socket.
- Tailscale state volume: `${dataDir}/tailscale → /var/lib/tailscale` (mounted when Tailscale enabled, persists auth across restarts)
- Gateway config is written to the shared volume *before* the gateway container starts via an ephemeral CLI container (`docker run --rm --network none --user node --entrypoint /bin/sh -v ${dataDir}/config:/home/node/.openclaw <image> -c "openclaw config set ..."`). This avoids crash-loops from the gateway requiring config (especially `gateway.mode=local`) before it will start.
- Init container runs commands in order: (1) required config set (security-critical), (2) user `configSet` entries, (3) user `setupCommands` (OpenClaw subcommands, auto-prefixed with `openclaw `, e.g. `models set`, `onboard`).
- `gatewaySecretEnv-<profile>` (secret, optional): JSON `{"KEY":"value"}` map. Each entry becomes a `-e KEY='VALUE'` flag on the init container (for `setupCommands` that reference `$KEY`) and an env var on the main gateway container (for runtime use). Set via `pulumi config set --secret gatewaySecretEnv-<profile> '{"OPENROUTER_API_KEY":"sk-or-..."}'`. Init container uses `logging: "none"` and `additionalSecretOutputs` to suppress secrets in logs.
- Per-gateway Docker image: `openclaw-gateway-<profile>:<version>`

## Template Code Conventions
- Templates live in `templates/` and are **pure functions** returning strings
- No side effects, no I/O, no Pulumi dependencies
- `renderDockerfile(opts)` — parameterized by version, packages, installBrowser, ports
- `renderEntrypoint()` — static content (no parameters)
- `renderEnvoyConfig(userRules)` — returns `{ yaml, warnings }`, merges with hardcoded domains
- All constants imported from `config/defaults.ts`
