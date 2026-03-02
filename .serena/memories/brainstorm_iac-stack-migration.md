# Brainstorm: IaC Stack Migration → openclaw-deploy

> **Status:** Completed — Ready for prototype
> **Created:** 2026-03-01
> **Last Updated:** 2026-03-01 03:45

## Problem / Topic
Evolve openclaw-docker into openclaw-deploy: a Pulumi TypeScript IaC system for deploying OpenClaw fleets with protocol-aware egress security. Supports multiple isolated VPSes (per-purpose or per-user/client), multiple gateways per server, per-gateway package customization, Tailscale networking, Envoy egress filtering with domain+path+protocol rules.

## The Stack
1. **Tailscale** — all networking (Serve for private admin, Funnel for public webhooks)
2. **Envoy** — egress only, protocol-aware policy engine (TLS SNI + HTTP Host + DNS-snooped IP matching + MITM path inspection). No ingress role.
3. **Pulumi (TypeScript)** — IaC fleet management (component resources, one stack per server, raw Docker provider)
4. **Docker** — deployment unit everywhere, per-gateway images with baked packages

## Decisions
- Repo: gut openclaw-docker, rename to `openclaw-deploy`
- **Pulumi TypeScript** — no Ansible, no Compose, no Go CLI
- Stack = one server. `pulumi up --stack <target>` manages one server.
- Raw Docker via Pulumi Docker provider (connected via `ssh://root@<ip>`), no Compose
- Tailscale for all networking; no Cloudflare
- Envoy egress-only — no ingress listener, no TLS certs for ingress (Tailscale handles ingress)
- Non-interactive setup — granular `openclaw config set` commands via Pulumi Command provider
- Tailscale Serve/Funnel configured on HOST via Pulumi Command (Tailscale daemon is on host, not in container)
- Egress policy is server-level (on EnvoyEgress), not per-gateway
- Support VPS providers: Hetzner (phase 1), DigitalOcean, Oracle Cloud (ARM) later

## Egress Security Model (CRITICAL — core value of this project)

### Why this exists
OpenClaw agents can run ANY binary on their host — curl, ncat, telnet, ssh, python, ftp, wget, anything installed. They can use any port, any protocol. A compromised or prompt-injected agent will use whatever tool is available to exfiltrate data. Application-level proxy settings (HTTP_PROXY) are useless because agents bypass them trivially. This project's egress model is the infrastructure-level defense that OpenClaw's own threat model (THREAT-MODEL-ATLAS, F4) identifies as a critical gap.

### Five-layer defense
1. **Docker `internal:true` network** — gateway container has no default route to the internet. No IP to reach. Hard network boundary.
2. **iptables DNAT (kernel level)** — entrypoint.sh runs as root, captures ALL outbound TCP via DNAT to Envoy:10000. Doesn't matter what binary, port, or protocol — the kernel rewrites the destination before the packet leaves. node user cannot modify rules (no CAP_NET_ADMIN after gosu).
3. **Envoy protocol detection** — TLS Inspector reads ClientHello for SNI. Non-TLS traffic falls through to HTTP detection or raw TCP handling.
4. **Envoy egress policy engine** — layered rule evaluation (see Policy Engine below).
5. **Cloudflare malware-blocking DNS** — Envoy DNS listener :53 → 1.1.1.2/1.0.0.2. Refuses to resolve known malware/phishing/C2 domains.

### Egress Policy Engine
The egress policy is NOT a simple domain whitelist. It's a layered rule engine supporting domains, IPs, CIDRs, multiple protocols, and path-level allow/deny.

**Rule model:**
```typescript
type EgressRule = {
  dst: string;              // domain "x.com" | IP "140.82.121.4" | CIDR "10.0.0.0/24"
  proto: "tls" | "http" | "ssh" | "ftp" | "tcp";
  port?: number;            // required for ssh/ftp/tcp, optional for tls/http
  action: "allow" | "deny";
  inspect?: boolean;        // MITM TLS termination / HTTP inspection
  pathRules?: PathRule[];   // when inspect=true, path-level filtering
};

type PathRule = {
  path: string;             // glob: "/messages/*", "/api/dm/*"
  action: "allow" | "deny";
};
```

**Key design principles:**
- First matching rule wins (evaluated top-down)
- Domain whitelist + path blacklist pattern: "allow x.com, deny /messages/*"
- Raw IPs and CIDRs are first-class rule targets (not everything has a domain)
- Protocol is part of the rule: github.com over TLS and github.com over SSH are separate rules
- Default action: DENY everything not matched
- Hardcoded infrastructure domains always prepended (AI providers, npm, GitHub/brew)

**Evaluation flow:**
1. iptables DNAT captures all outbound TCP → Envoy:10000
2. Envoy determines destination identity:
   - TLS? Read SNI → domain name
   - HTTP? Read Host header → domain name
   - SSH/FTP/raw TCP? Read SO_ORIGINAL_DST → IP, reverse-lookup against DNS cache for domain
   - Raw IP with no DNS? Match against IP/CIDR rules directly
3. Match against rules top-down, first match wins
4. If matched rule has inspect=true:
   - TLS: MITM (terminate TLS with Envoy CA, inspect HTTP, re-encrypt to upstream)
   - HTTP: inspect directly (no TLS to terminate)
   - Evaluate pathRules top-down, first match wins
   - No pathRule match → allow (domain whitelisted, only specific paths blacklisted)
5. No rule matched → default DENY

**Example policy:**
```typescript
const egressPolicy: EgressRule[] = [
  // AI providers — full TLS passthrough
  { dst: "api.anthropic.com",  proto: "tls", action: "allow" },
  { dst: "api.openai.com",     proto: "tls", action: "allow" },
  // GitHub — TLS + SSH
  { dst: "github.com",         proto: "tls", action: "allow" },
  { dst: "github.com",         proto: "ssh", port: 22, action: "allow" },
  // Social with exfiltration path blocking
  { dst: "x.com", proto: "tls", action: "allow", inspect: true, pathRules: [
    { path: "/messages/*", action: "deny" },
    { path: "/api/dm/*",   action: "deny" },
  ]},
  { dst: "discord.com", proto: "tls", action: "allow", inspect: true, pathRules: [
    { path: "/api/webhooks/*", action: "deny" },
  ]},
  // Infrastructure
  { dst: "registry.npmjs.org", proto: "tls", action: "allow" },
  // Raw IP
  { dst: "10.0.0.5", proto: "tcp", port: 8080, action: "allow" },
  // Default: deny everything else (implicit)
];
```

### DNS snooping for non-TLS protocols (Phase 2)
SSH, FTP, and raw TCP have no domain in the protocol. To domain-filter these:
1. Gateway resolves domain via Envoy DNS :53 → Envoy records mapping: IP → domain (TTL-cached)
2. When TCP connection to that IP arrives via DNAT, Envoy reverse-looks up the IP to find the domain
3. Matches against domain rules for that protocol
Implementation options: custom Lua/WASM Envoy filter, external xDS controller, or companion sidecar process.

### MITM requirements
For TLS inspection (path-level rules on HTTPS/WSS):
- Envoy generates a CA keypair
- Gateway trusts it via NODE_EXTRA_CA_CERTS environment variable
- Envoy terminates outbound TLS, inspects HTTP request, applies path rules, re-encrypts to upstream

### Protocol coverage by phase
| Phase | Protocols | Filtering method |
|-------|-----------|-----------------|
| Phase 1 | TLS (HTTPS, WSS), plain HTTP/WS | SNI + Host header. Standard Envoy. ~90% of traffic. |
| Phase 2 | SSH, FTP, raw TCP | DNS snooping + IP mapping. Custom Envoy filter or sidecar. |
| Phase 3 | Deep protocol inspection | SSH command filtering, FTP path restrictions, etc. |

## Component Design

### Project Structure
```
openclaw-deploy/
├── Pulumi.yaml
├── Pulumi.<stack>.yaml
├── package.json / tsconfig.json
├── index.ts                          # Stack composition
├── components/
│   ├── server.ts                     # VPS provisioning (hetzner|do|oracle)
│   ├── bootstrap.ts                  # Docker + Tailscale install
│   ├── envoy.ts                      # Egress proxy + policy engine
│   └── gateway.ts                    # OpenClaw gateway instance
├── templates/
│   ├── Dockerfile.tmpl               # Gateway image (version, packages, entrypoint)
│   ├── entrypoint.sh                 # iptables DNAT + gosu (mostly static)
│   └── envoy.yaml.tmpl              # Egress policy rendered from rules
└── config/
    └── domains.ts                    # Hardcoded infrastructure domains + default policy
```

### Server — VPS provisioning
- Inputs: provider (hetzner|do|oracle), size, region, sshKey
- Outputs: ipAddress, connection (SSH args for command.remote), arch (amd64|arm64)
- Switches on provider to create hcloud.Server / do.Droplet / oci.CoreInstance

### HostBootstrap — Docker + Tailscale on bare VPS
- Inputs: server, tailscaleAuthKey (secret)
- Outputs: tailscaleIP, dockerHost (ssh://root@ip for Docker provider)
- Three command.remote.Command: install Docker, install Tailscale, tailscale up --authkey

### EnvoyEgress — Egress proxy + policy engine, one per server
- Inputs: dockerHost, egressPolicy (EgressRule[])
- Outputs: envoyIP (172.28.0.2), networkID, caCertPath (for MITM)
- Creates:
  1. docker.Network — internal:true, IPAM 172.28.0.0/24
  2. Envoy CA keypair (for MITM TLS inspection) — generated once, persisted
  3. Renders envoy.yaml from egressPolicy rules → filter chains:
     - TLS filter chain per passthrough domain (sni_dynamic_forward_proxy)
     - TLS filter chain per inspected domain (terminate → HTTP route match → TLS originate)
     - HTTP filter chain for plain HTTP/WS (Host header matching + path rules)
     - TCP filter chain for IP/CIDR rules (SO_ORIGINAL_DST matching)
     - Default deny filter chain
  4. docker.Container — envoyproxy/envoy:v1.33-latest, static IP 172.28.0.2
  5. DNS listener :53 UDP → 1.1.1.2/1.0.0.2
- Hardcoded infrastructure rules always prepended to user egressPolicy
- No ingress listener

### Gateway — OpenClaw instance, N per server
- Inputs: dockerHost, envoy, server, profile, version, packages, port, arch, auth, tailscale mode, configSet map
- Outputs: containerID, imageDigest, tailscaleURL
- Steps:
  1. docker.Image — build from Dockerfile.tmpl (node:22-bookworm + version + packages + entrypoint.sh, arch-aware)
  2. docker.Container — on internal network, CAP_NET_ADMIN, volumes (/data/<profile>/config, state, workspace), port published to host loopback only (127.0.0.1:<port>:18789), env: HOME, TERM, ENVOY_IP=172.28.0.2, NODE_EXTRA_CA_CERTS (for MITM), command: ["openclaw", "gateway", "--bind", "lan", "--port", "18789"]
  3. command.remote.Command — `docker exec <container> openclaw config set <key> <value>` for each configSet entry (each tracked as separate Pulumi resource)
  4. command.remote.Command on HOST — `tailscale serve --bg https+insecure://localhost:<port>` or `tailscale funnel ...`

### Composition (index.ts)
```
server → bootstrap → envoy (with egressPolicy)
                        ↘
                     gateway-1 (profile: personal, packages: [...], port: 18789, tailscale: serve)
                     gateway-2 (profile: automation, packages: [...], port: 18790, tailscale: funnel)
```

## Key OpenClaw Architecture Facts (from docs + source)
- Gateway stays on loopback (127.0.0.1), never publicly exposed
- Tailscale Serve: tailnet-only HTTPS, identity-based auth via headers (passwordless for tailnet users)
- Tailscale Funnel: public HTTPS for webhook ingress, requires password auth, ports 443/8443/10000 only
- Gateway's built-in `--tailscale serve/funnel` auto-configures tailscale, BUT won't work inside Docker (Tailscale daemon is on host). So we configure tailscale serve/funnel on the HOST via Pulumi Command.
- Most messaging channels are OUTBOUND (WhatsApp/Baileys, Telegram/grammY, Discord, Slack, Signal, iMessage)
- Webhooks are inbound via Tailscale Funnel + bearer token auth (/hooks/wake, /hooks/agent, /hooks/<custom>)
- Webhooks recommended "behind loopback, tailnet, or trusted reverse proxy"
- `openclaw config set` is the configuration mechanism (non-interactive, granular, idempotent)
- `--profile <name>` for multiple isolated gateway instances per host (unique port, config, state dir)
- One gateway owns state + channels. Nodes are peripherals connecting via WebSocket RPC.
- Agents can run ANY installed binary — curl, ncat, ssh, ftp, python, wget, telnet, anything. This is why kernel-level iptables DNAT is the only reliable egress capture mechanism.
- OpenClaw relies heavily on WebSockets (ws, wss), SSH, FTP, and other non-HTTP protocols

## Entrypoint.sh (mostly static, carried over from current codebase)
- Runs as root inside gateway container
- Resolves Envoy IP via `getent hosts envoy`
- Derives INTERNAL_SUBNET from Envoy IP (strip last octet, append .0/24)
- Adds default route via Envoy (`ip route add default via $ENVOY_IP`)
- Flushes iptables, restores DOCKER_OUTPUT chain jump (Docker DNS needs it)
- NAT table: skip DNAT for loopback (-o lo) and internal subnet, DNAT all other outbound TCP to Envoy:10000
- FILTER table: OUTPUT DROP default. Allow: loopback, Docker DNS (127.0.0.11:53 UDP), established/related, internal subnet
- Drops to node user via `exec gosu node "$@"` — node user cannot modify iptables (no CAP_NET_ADMIN)

## Dockerfile Template (carried over, enhanced)
- Base: node:22-bookworm
- Installs: iptables, iproute2, gosu, libsecret-tools, pnpm, bun, Homebrew (Linuxbrew)
- ARG for custom packages (apt-get install)
- ARG for OpenClaw version (npm install -g openclaw@version)
- ARG for optional browser (Playwright + Chromium + Xvfb)
- COPY entrypoint.sh (root-owned, 0755)
- ENTRYPOINT ["entrypoint.sh"]
- CMD ["openclaw", "gateway", "--allow-unconfigured"]
- Per-gateway images: different packages baked in, different versions possible

## Gotchas / Risks
- Tailscale Funnel limited to ports 443, 8443, 10000 (max 3 gateways with public webhooks per server)
- Oracle Cloud = ARM (aarch64) — Docker images must be multi-arch or arm64-specific
- Pulumi requires CLI installed on operator's machine
- Docker image builds on small VPSes may be slow (consider registry for fleet)
- Tailscale SaaS dependency (Headscale for self-hosted alternative)
- DNS snooping for non-TLS protocol filtering (Phase 2) requires custom Envoy extension
- MITM inspection adds latency (double TLS handshake) for inspected domains
- Envoy CA keypair must be generated once and persisted across deploys

## Implementation Phases
| Phase | Scope |
|-------|-------|
| Phase 1 | Prototype: Hetzner server, Docker+Tailscale bootstrap, Envoy egress (TLS SNI + HTTP Host + MITM path inspection), Gateway component, sample composition |
| Phase 2 | DNS snooping for SSH/FTP/raw TCP domain filtering, Oracle ARM support, DigitalOcean provider |
| Phase 3 | Deep protocol inspection, fleet-wide operations tooling, image registry integration |
