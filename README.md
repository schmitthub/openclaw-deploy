# openclaw-deploy

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Pulumi](https://img.shields.io/badge/Pulumi-IaC-8A3391?logo=pulumi&logoColor=white)](https://www.pulumi.com)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-supported-6E56CF)](https://docs.openclaw.ai)
![macOS](https://img.shields.io/badge/macOS-supported-000000?logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-supported-FCC624?logo=linux&logoColor=black)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/schmitthub/openclaw-docker)

Pulumi TypeScript IaC that provisions remote VPS hosts and deploys [OpenClaw](https://openclaw.ai) gateway fleets with network-level egress isolation via Envoy proxy and Tailscale networking.

> Early development — features and conventions may change. Contributions and feedback welcome!

## Table of Contents

- [Architecture](#architecture)
- [Threat Model](#threat-model)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Stack Configuration](#stack-configuration)
- [Component Hierarchy](#component-hierarchy)
- [Egress Domain Whitelist](#egress-domain-whitelist)
- [Common Operations](#common-operations)
- [Development](#development)
- [Repository Structure](#repository-structure)
- [Known Limitations](#known-limitations)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Remote VPS (Hetzner / DigitalOcean / Oracle Cloud)                 │
│                                                                     │
│   Tailscale Serve/Funnel ──┐                                       │
│     (ingress: HTTPS, WSS)  │                                       │
│                             ▼ 127.0.0.1:<port>                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  openclaw-internal network (internal: true, 172.28.0.0/24)  │   │
│   │  No default route to internet                               │   │
│   │                                                             │   │
│   │   ┌───────────────────────────────────┐                     │   │
│   │   │  openclaw-gateway-<profile>       │                     │   │
│   │   │  • OpenClaw + pnpm + bun + brew   │                     │   │
│   │   │  • dns: [172.28.0.2] (Envoy)      │                     │   │
│   │   │                                   │                     │   │
│   │   │  entrypoint.sh (root, immutable): │                     │   │
│   │   │  ┌─────────────────────────────┐  │                     │   │
│   │   │  │ ip route default via Envoy  │  │                     │   │
│   │   │  │ NAT: SSH/TCP → DNAT :10001+ │  │                     │   │
│   │   │  │ NAT: ALL TCP → DNAT :10000  │  │                     │   │
│   │   │  │ FILTER: OUTPUT DROP default │  │                     │   │
│   │   │  │ gosu → drops to node user   │  │                     │   │
│   │   │  └─────────────────────────────┘  │                     │   │
│   │   └───────────────────────────────────┘                     │   │
│   │              ... (N gateways per server)                    │   │
│   │                                                             │   │
│   │                  ┌──────────────────────────┐               │   │
│   │    Internet ◄──► │  Envoy (172.28.0.2)      │               │   │
│   │   (whitelisted   │                          │               │   │
│   │    domains only) │  TLS (:10000):           │               │   │
│   │                  │  • TLS Inspector (SNI)   │               │   │
│   │    Cloudflare    │  • Domain whitelist       │               │   │
│   │    1.1.1.2 ◄──   │  • MITM inspection (opt) │               │   │
│   │    1.0.0.2       │                          │               │   │
│   │                  │  SSH/TCP (:10001+):       │               │   │
│   │                  │  • Per-rule tcp_proxy     │               │   │
│   │                  │  • STRICT_DNS / STATIC    │               │   │
│   │                  │                          │               │   │
│   │                  │  DNS (:53 UDP):           │               │   │
│   │                  │  • → Cloudflare (malware  │               │   │
│   │                  │    blocking resolvers)    │               │   │
│   │                  └──────────────────────────┘               │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│   Tailscale daemon (host-level, manages Serve/Funnel)              │
│   Docker daemon (provisioned by HostBootstrap)                     │
└─────────────────────────────────────────────────────────────────────┘

Operator machine:
  $ pulumi up --stack dev     # provisions server + deploys everything
  $ pulumi destroy --stack dev  # tears down
```

One Pulumi stack = one server. Each server runs N gateway instances sharing a single Envoy egress proxy. Tailscale handles all ingress (Serve for private tailnet access, Funnel for public webhooks). No self-managed TLS certificates or reverse proxies.

## Threat Model

**Threat:** Prompt injection coerces the AI agent into exfiltrating data. The agent can run any tool available in the container — `curl`, `wget`, `ncat`, `ssh`, raw sockets, subprocesses. It can use any port, any protocol, and target any destination. Application-level proxy settings (`HTTP_PROXY`) are trivially bypassed.

**Defense-in-depth (five layers):**

| Layer | Mechanism | What it stops | Bypassable by `node` user? |
|-------|-----------|---------------|---------------------------|
| **1. Network isolation** | Docker `internal: true` network | No default route to internet — no IP to reach | No |
| **2. iptables DNAT + FILTER** | Root-owned rules: SSH/TCP → specific Envoy ports, all other TCP → Envoy:10000 | Every TCP connection goes through Envoy | No (`CAP_NET_ADMIN` required, root only) |
| **3. Envoy protocol-aware whitelist** | TLS: SNI inspection + domain whitelist. SSH/TCP: per-rule port-mapped listeners | Non-whitelisted HTTPS, non-mapped SSH/TCP, plain HTTP | No (Envoy resolves DNS independently) |
| **4. Egress policy engine** | Typed `EgressRule[]` with domain/IP + protocol support (TLS, SSH, TCP) | Structured policy control with per-protocol handling | No (Envoy config, not in container) |
| **5. Malware-blocking DNS** | Cloudflare 1.1.1.2 / 1.0.0.2 via Envoy DNS listener | Known malware, phishing, and C2 domains | No (Envoy resolves DNS, containers cannot override) |

**Why SNI spoofing doesn't work:** If an attacker forges the SNI to `api.anthropic.com` while connecting to `evil.com`'s IP, Envoy resolves `api.anthropic.com` via DNS independently and connects to the **real** IP — not the attacker's server.

**What gets blocked / allowed:**
- `curl https://evil.com` — SNI not in whitelist → **BLOCKED**
- `ssh user@evil.com` — no SSH egress rule configured → **BLOCKED**
- `ssh git@github.com` — SSH rule with port 22 in egressPolicy → **ALLOWED** (via dedicated Envoy listener)
- `ncat evil.com 4444` — no matching TCP rule → **BLOCKED**
- `python3 -c "import socket; s.connect(('1.2.3.4', 443))"` — no SNI → **BLOCKED**
- `curl https://api.anthropic.com` — SNI matches whitelist → **ALLOWED**

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- [Tailscale](https://tailscale.com/) account with an auth key
- A VPS provider account with an SSH key uploaded: [Hetzner Cloud](https://www.hetzner.com/cloud), [DigitalOcean](https://www.digitalocean.com/), or [Oracle Cloud](https://www.oracle.com/cloud/)

## Quickstart

```bash
# Clone and install
git clone https://github.com/schmitthub/openclaw-docker.git openclaw-deploy
cd openclaw-deploy
npm install

# Initialize a stack
pulumi stack init dev
cp Pulumi.dev.yaml.example Pulumi.dev.yaml

# Set required secrets
pulumi config set --secret tailscaleAuthKey <your-tailscale-auth-key>
pulumi config set --secret gatewayToken-personal $(openssl rand -hex 32)

# Edit Pulumi.dev.yaml with your server config, egress policy, and gateway profiles

# Deploy
pulumi up
```

`pulumi up` will:
1. Provision a VPS (Hetzner, DigitalOcean, or Oracle Cloud)
2. Install Docker + Tailscale on the host (switching to Tailscale IP for subsequent commands)
3. Create Docker networks + deploy Envoy egress proxy
4. Build gateway Docker images (with baked packages) and deploy containers
5. Configure each gateway via `docker exec openclaw config set` commands
6. Set up Tailscale Serve/Funnel on the host for ingress

## Stack Configuration

Configuration lives in `Pulumi.<stack>.yaml`. See `Pulumi.dev.yaml.example` for a complete example.

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `provider` | `"hetzner"` \| `"digitalocean"` \| `"oracle"` | yes | VPS provider |
| `serverType` | string | yes | Server type (e.g. `cx22`, `cax21`) |
| `region` | string | yes | Datacenter region (e.g. `fsn1`) |
| `sshKeyId` | string | yes | SSH key ID at provider |
| `tailscaleAuthKey` | secret | yes | One-time Tailscale auth key |
| `egressPolicy` | `EgressRule[]` | yes | User egress rules (additive to hardcoded) |
| `gateways` | `GatewayConfig[]` | yes | Gateway profile definitions (1+) |
| `gatewayToken-<profile>` | secret | per-gateway | Auth token for each gateway |

**Gateway profile fields:**

| Field | Type | Description |
|-------|------|-------------|
| `profile` | string | Unique name (used in resource names) |
| `version` | string | OpenClaw version (`latest` or semver) |
| `packages` | string[] | Extra apt packages baked into the image |
| `port` | number | Gateway port (e.g. `18789`) |
| `tailscale` | `"serve" \| "funnel"` | Tailscale ingress mode |
| `configSet` | object | Key-value pairs for `openclaw config set` |
| `installBrowser` | boolean | Bake Playwright + Chromium (~300MB) |
| `env` | object | Extra environment variables |

## Component Hierarchy

Components compose sequentially — each depends on the previous:

```
Server (VPS provisioning: Hetzner / DigitalOcean / Oracle)
  ↓ connection (public IP SSH)
HostBootstrap (Docker + Tailscale install)
  ↓ tailscaleIP, dockerHost (switches to Tailscale IP)
EnvoyEgress (Docker networks + Envoy container)
  ↓ internalNetworkName
Gateway(s) (1+ OpenClaw instances per server)
  ↓ optional Tailscale Serve/Funnel
```

| Component | Pulumi Type | Provider | Purpose |
|-----------|-------------|----------|---------|
| `Server` | `openclaw:infra:Server` | `@pulumi/hcloud` / DO / OCI | Provision VPS, expose IP + SSH connection |
| `HostBootstrap` | `openclaw:infra:HostBootstrap` | `@pulumi/command` | Install Docker + Tailscale on bare host |
| `EnvoyEgress` | `openclaw:infra:EnvoyEgress` | `@pulumi/docker` + `@pulumi/command` | Create networks, deploy Envoy |
| `Gateway` | `openclaw:app:Gateway` | `@pulumi/docker` + `@pulumi/command` | Build image, deploy container, configure gateway |

## Egress Domain Whitelist

Envoy enforces protocol-aware egress filtering: TLS connections are filtered by SNI whitelist, SSH/TCP connections are forwarded via per-rule dedicated listeners, and all other traffic is denied.

**Always included (hardcoded, cannot be removed):**

| Category | Domains |
|----------|---------|
| Infrastructure | `clawhub.com`, `registry.npmjs.org` |
| AI providers | `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.x.ai` |
| Homebrew | `github.com`, `*.githubusercontent.com`, `ghcr.io`, `formulae.brew.sh` |

User-defined `egressPolicy` rules are **additive** — hardcoded domains are always present. Duplicates are deduplicated by `mergeEgressPolicy()`.

```yaml
# Example: TLS domains, SSH access, and TCP database
openclaw-deploy:egressPolicy:
  - dst: "discord.com"
    proto: tls
    action: allow
  - dst: "gateway.discord.gg"
    proto: tls
    action: allow
  - dst: "cdn.discordapp.com"
    proto: tls
    action: allow
  - dst: "github.com"
    proto: ssh
    port: 22
    action: allow
  - dst: "db.example.com"
    proto: tcp
    port: 5432
    action: allow
```

SSH/TCP rules use per-rule port mapping: each rule gets a dedicated Envoy listener port (starting from 10001), and destination-specific iptables DNAT rules in the gateway entrypoint route matching traffic to the correct port. Domain resolution happens at container startup.

## Common Operations

```bash
# Deploy / update
pulumi up --stack dev

# Preview changes without applying
pulumi preview --stack dev

# View stack outputs (server IP, Tailscale IP, gateway URLs)
pulumi stack output --stack dev

# Tear down everything
pulumi destroy --stack dev

# View gateway logs (via SSH)
ssh root@<tailscale-ip> docker logs -f openclaw-gateway-personal

# Restart a gateway after config changes
ssh root@<tailscale-ip> docker restart openclaw-gateway-personal

# Run an openclaw CLI command inside a gateway container
ssh root@<tailscale-ip> docker exec openclaw-gateway-personal openclaw config get gateway
```

## Development

```bash
npm install                # install dependencies
npx tsc --noEmit           # type-check
npx vitest run             # run all tests
npx vitest run tests/envoy.test.ts  # run a specific test
npm run check              # typecheck + test
```

## Repository Structure

```
index.ts                    # Stack composition entry point
Pulumi.yaml                 # Pulumi project metadata
Pulumi.dev.yaml.example     # Example stack config
components/
  index.ts                  # Re-exports
  server.ts                 # VPS provisioning (Hetzner / DigitalOcean / Oracle)
  bootstrap.ts              # Docker + Tailscale install on bare host
  envoy.ts                  # Egress proxy: networks + Envoy container
  gateway.ts                # OpenClaw gateway instance + config + Tailscale
config/
  index.ts                  # Re-exports
  types.ts                  # EgressRule, VpsProvider, GatewayConfig, StackConfig
  domains.ts                # Hardcoded egress rules + mergeEgressPolicy()
  defaults.ts               # Constants (networks, ports, images, packages)
templates/
  index.ts                  # Re-exports
  dockerfile.ts             # Renders Dockerfile (node:22-bookworm + tools)
  entrypoint.ts             # Renders entrypoint.sh (iptables + gosu)
  envoy.ts                  # Renders envoy.yaml (egress-only proxy + DNS)
tests/
  config.test.ts            # Config types and domain merging
  templates.test.ts         # Dockerfile/entrypoint rendering
  envoy.test.ts             # Envoy config rendering
  envoy-component.test.ts   # EnvoyEgress Pulumi component (mocked)
```

## Known Limitations

- **SSH/TCP egress: startup-time DNS resolution** — SSH/TCP rules resolve domains to IPs at container startup. IP changes require a container restart.
- **No CIDR destinations for SSH/TCP** — SSH and TCP egress rules require specific domain or IP destinations (CIDR ranges emit a warning and are skipped).
- **Tailscale Funnel port limits** — Funnel is limited to ports 443, 8443, 10000 (max 3 public gateways per server).
