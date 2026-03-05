# AGENTS.md

## Repository Overview

This repository is a **Pulumi TypeScript IaC** program (`openclaw-deploy`) that provisions and manages OpenClaw fleet deployments on remote VPS hosts with protocol-aware egress security.

Primary goals:

- Provision VPS infrastructure (Hetzner phase 1; DigitalOcean, Oracle planned).
- Install Docker + fail2ban on bare hosts via remote commands.
- Deploy OpenClaw gateway containers with transparent egress isolation via Envoy proxy.
- Manage fleet-scale deployments: one Pulumi stack per server, N gateways per server.
- Provide secure access via Tailscale Serve (SSH + HTTPS, no self-managed TLS/ingress).

## What Agents Should Assume

- This is a Pulumi TypeScript project — not a CLI, not Docker Compose.
- Infrastructure is managed declaratively via Pulumi components and stack config.
- The Docker provider connects to remote hosts via `ssh://root@<ip>` (no local Docker).
- Templates (`templates/`) are pure functions that render Docker artifacts (Dockerfile, entrypoint.sh, envoy.yaml, serve-config.json).
- Components (`components/`) are Pulumi `ComponentResource` subclasses that compose infrastructure.
- Changes should prioritize compatibility, determinism, and minimal image complexity.
- Prefer small, focused edits rather than broad refactors.
- Never weaken the egress isolation model (see Threat Model & Egress Security below).

## Project Structure

```
<repo-root>/                          # Pulumi project name: openclaw-deploy
├── index.ts                          # Stack composition entry point (5-component pipeline per gateway)
├── package.json                      # Dependencies (Pulumi, Docker, docker-build, Hcloud, Command)
├── tsconfig.json                     # TypeScript config (ES2022, strict)
├── vitest.config.ts                  # Test runner config
├── Pulumi.yaml                       # Pulumi project metadata
├── Pulumi.dev.yaml.example           # Example stack config
├── components/
│   ├── index.ts                      # Re-exports all components
│   ├── server.ts                     # VPS provisioning (Hetzner, DigitalOcean, Oracle)
│   ├── oci-infra.ts                  # Oracle Cloud auto-provisioned networking
│   ├── bootstrap.ts                  # Docker + fail2ban install on bare host
│   ├── envoy.ts                      # EnvoyEgress: config rendering + cert generation (shared)
│   ├── gateway-image.ts              # GatewayImage: BuildKit image build via @pulumi/docker-build
│   ├── tailscale-sidecar.ts          # TailscaleSidecar: bridge network + sidecar + health + hostname
│   ├── envoy-proxy.ts                # EnvoyProxy: envoy container + health wait
│   ├── gateway-init.ts               # GatewayInit: sequential init containers + env var scanning
│   └── gateway.ts                    # Gateway: container-only (volumes + gateway container)
├── config/
│   ├── index.ts                      # Re-exports
│   ├── types.ts                      # EgressRule, VpsProvider, GatewayConfig, StackConfig
│   ├── domains.ts                    # Hardcoded egress rules + mergeEgressPolicy()
│   └── defaults.ts                   # Constants (ports, images, packages, path helpers)
├── templates/
│   ├── index.ts                      # Re-exports
│   ├── dockerfile.ts                 # Renders Dockerfile (node:22-bookworm + tools)
│   ├── entrypoint.ts                 # Renders entrypoint.sh (sshd + gosu node)
│   ├── sidecar.ts                    # Renders sidecar-entrypoint.sh (iptables REDIRECT + containerboot)
│   ├── serve.ts                      # Renders serve-config.json (Tailscale Serve config)
│   └── envoy.ts                      # Renders envoy.yaml (egress-only TLS proxy)
└── tests/
    ├── config.test.ts                # Config types and domain merging
    ├── templates.test.ts             # Dockerfile/entrypoint/sidecar/serve rendering
    ├── envoy.test.ts                 # Envoy config rendering
    ├── envoy-component.test.ts       # EnvoyEgress Pulumi component (mocked)
    └── components.test.ts            # All Pulumi components (mocked)
```

## Component Hierarchy

Shared infrastructure components compose sequentially. Per-gateway, five focused components form a pipeline:

```
Server (VPS provisioning)
  ↓ connection, dockerHost
HostBootstrap (Docker + fail2ban install)
  ↓ dockerHost
EnvoyEgress (shared config rendering + cert generation — no Docker resources)
  ↓ envoyConfigPath, configHash, inspectedDomains, tcpPortMappings
  ↓
Per gateway (1+ per server):
  GatewayImage ──→ TailscaleSidecar ──→ EnvoyProxy ──→ GatewayInit ──→ Gateway
  (build)          (netns + auth)        (egress)       (config)        (container)
```

`GatewayImage` and `TailscaleSidecar` can run in parallel (independent). `EnvoyProxy` waits for sidecar + envoy config. `GatewayInit` waits for image + envoy proxy. `Gateway` waits for envoy proxy + init.

| Component          | Type                            | Provider                             | Purpose                                                            |
| ------------------ | ------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `Server`           | `openclaw:infra:Server`         | `@pulumi/hcloud` + DO + OCI          | Provision VPS, expose IP + connection                              |
| `HostBootstrap`    | `openclaw:infra:HostBootstrap`  | `@pulumi/command`                    | Install Docker + fail2ban on bare host                             |
| `EnvoyEgress`      | `openclaw:infra:EnvoyEgress`    | `@pulumi/command`                    | Render envoy.yaml, upload config, generate CA + MITM certs         |
| `GatewayImage`     | `openclaw:build:GatewayImage`   | `@pulumi/docker-build`               | BuildKit image build (Dockerfile + entrypoint rendered locally)    |
| `TailscaleSidecar` | `openclaw:net:TailscaleSidecar` | `@pulumi/docker` + `@pulumi/command` | Bridge network, sidecar container, health wait, hostname capture   |
| `EnvoyProxy`       | `openclaw:net:EnvoyProxy`       | `@pulumi/docker` + `@pulumi/command` | Envoy container + health wait                                      |
| `GatewayInit`      | `openclaw:app:GatewayInit`      | `@pulumi/command`                    | Sequential init containers via `docker run --rm`, env var scanning |
| `Gateway`          | `openclaw:app:Gateway`          | `@pulumi/docker`                     | Gateway container (volumes + env + healthcheck)                    |

## Network Topology

All containers per gateway share a single network namespace via the Tailscale sidecar:

```
[Bridge network: openclaw-net-<profile>]
  tailscale-<profile>  (sidecar — owns netns, iptables REDIRECT, containerboot)
    ├── envoy-<profile>  (network_mode: container:tailscale-<profile>)
    └── openclaw-<profile>  (network_mode: container:tailscale-<profile>)
```

- **Single bridge network** per gateway (NOT `internal: true` — sidecar needs internet for Envoy upstreams)
- All containers share the sidecar's network namespace via `network_mode: container:`
- iptables uses `REDIRECT` (not `DNAT`) — everything is localhost in shared netns
- Owner-match exclusions (uid 101 envoy, uid 0 root) prevent redirect loops
- No static IPs, no IPAM, no dual-network architecture

## Stack Configuration

Configuration is managed via `pulumi config` / `Pulumi.<stack>.yaml`:

| Key                          | Type                                          | Required | Description                                                |
| ---------------------------- | --------------------------------------------- | -------- | ---------------------------------------------------------- |
| `provider`                   | `"hetzner"` \| `"digitalocean"` \| `"oracle"` | yes      | VPS provider                                               |
| `serverType`                 | string                                        | yes      | Server type (e.g. `cx22`, `cax21`)                         |
| `region`                     | string                                        | yes      | Datacenter region (e.g. `fsn1`)                            |
| `sshKeyId`                   | string                                        | no       | SSH key ID or name at provider (auto-generated if omitted) |
| `tailscaleAuthKey`           | secret                                        | yes      | One-time Tailscale auth key                                |
| `egressPolicy`               | `EgressRule[]`                                | yes      | User egress rules (additive to hardcoded)                  |
| `gateways`                   | `GatewayConfig[]`                             | yes      | Gateway profile definitions (1+)                           |
| `gatewayToken-<profile>`     | secret                                        | no       | Auth token override (auto-generated if omitted)            |
| `gatewaySecretEnv-<profile>` | secret                                        | no       | JSON `{"KEY":"value"}` — env vars for init + runtime       |

## Deployment Model

- Each Pulumi stack deploys **one server** with **N gateway instances**.
- Each gateway instance is composed of **5 Pulumi components** in a pipeline (see Component Hierarchy).
- Envoy is the sole egress proxy — all TCP egress routes through it via iptables REDIRECT.
- **Image builds** use `@pulumi/docker-build` (BuildKit). Templates are rendered locally at plan time, written to a temp dir, and BuildKit transfers the build context to the remote Docker daemon via `DOCKER_HOST=ssh://`. No base64 file uploads for image builds.
- **Tailscale sidecar model**: Each gateway has a dedicated Tailscale sidecar container (`tailscale-<profile>`) that owns the network namespace. The sidecar runs the official `containerboot` entrypoint (Tailscale's Docker image entrypoint). The gateway and envoy containers share the sidecar's netns via `network_mode: container:tailscale-<profile>`.
- The sidecar entrypoint sets iptables REDIRECT rules, then `exec`s `containerboot` which handles Tailscale auth, state, and serve config automatically.
- Tailscale uses kernel networking (`TS_USERSPACE=false`) with TUN device (`/dev/net/tun`). WireGuard UDP is allowed only for root (containerboot) via `iptables -m owner --uid-owner 0`. The node user (openclaw) is blocked from all UDP egress.
- The sidecar container uses `dns: [1.1.1.2, 1.0.0.2]` (Cloudflare malware-blocking DNS, inherited by all containers via shared netns).
- The gateway entrypoint (`entrypoint.sh`) starts sshd, fixes permissions, and drops to `node` user via `gosu`. No iptables, no routing, no tailscaled.
- SSH access is provided via Tailscale Serve TCP forwarding (port 22 → sshd on port 2222).
- HTTPS access is provided via Tailscale Serve web handler (port 443 → gateway on loopback).
- `TS_SERVE_CONFIG` points to a static JSON file rendered by `renderServeConfig()` — containerboot applies it automatically.
- **Init containers** (`GatewayInit`) run _before_ the gateway container starts via ephemeral CLI containers (`docker run --rm --network none --user node`). This avoids crash-loops from missing config. Each `setupCommand` is a separate `command.remote.Command` resource. Env var scanning detects hostname-dependent commands — only those include the Tailscale hostname in their Pulumi command string, so hostname changes only re-run affected init steps.
- **Secrets never persist on disk.** Init containers use `export SECRET='val' && docker run -e SECRET && unset SECRET`. No env files.
- Gateway auth token is passed via `OPENCLAW_GATEWAY_TOKEN` env var (takes precedence over config file in local mode).
- Docker provider connects to remote hosts via SSH (`ssh://root@<publicIP>`).

## Validation Expectations

Before considering work complete, agents should:

- Run `npx tsc --noEmit` to verify type safety.
- Run `npx vitest run` to verify all tests pass.
- For component/template changes, verify rendered output is correct.
- Run `pulumi preview` (if a stack is configured) to verify no resource errors.
- Ensure no new `any` types or type assertions without justification.

## Contribution Guidelines for Agents

- Pin versions where stability matters; document why when pinning is non-obvious.
- Avoid introducing unnecessary runtime dependencies.
- Templates are **pure functions** returning strings — no side effects, no I/O.
- Components follow Pulumi conventions: `ComponentResource` subclass, `registerOutputs()`, parent/dependency tracking.
- Each service is a **first-class component** with its own lifecycle, state tracking, and outputs. Do not combine services.
- Config types are in `config/types.ts` — update the interface when adding new fields.
- Hardcoded egress rules are in `config/domains.ts` — these cannot be removed.
- All constants (ports, image tags, path helpers) live in `config/defaults.ts`.

## Threat Model & Egress Security

The primary threat is a compromised or malicious AI agent instructing OpenClaw to exfiltrate data
to attacker-controlled domains using arbitrary tools and transports (`curl`, `wget`, `ncat`, `ssh`,
raw sockets, subprocesses — anything available in the container). Application-level proxy settings
like `HTTP_PROXY` env vars are insufficient because a prompt-injected agent can use **any tool**
that ignores proxy settings, connect on **any port**, or use **any protocol**.

**Defense-in-depth model (four layers):**

1. **Root-owned iptables REDIRECT rules** — set by the **sidecar entrypoint**
   (`sidecar-entrypoint.sh`) running as root before `exec containerboot`. The NAT table uses
   owner-match to exclude Envoy (uid 101) and root (uid 0) from redirection, then REDIRECTs
   **all other outbound TCP** to Envoy's proxy listener on localhost:10000. No FILTER table is
   needed — REDIRECT + UDP DROP is sufficient in the shared netns model. **UDP exfiltration is
   prevented** by `iptables -A OUTPUT -p udp -d 127.0.0.11 -j ACCEPT` (Docker DNS), then
   `iptables -A OUTPUT -p udp -m owner --uid-owner root -j ACCEPT` (containerboot/tailscaled
   only), then `iptables -A OUTPUT -p udp -j DROP` (block all other UDP). The gateway container
   shares this network namespace via `network_mode: container:tailscale-<profile>` and has
   **no `CAP_NET_ADMIN`**, so the `node` user cannot modify these rules.

2. **Envoy SNI-based domain whitelist** — the egress listener uses TLS Inspector to read the SNI
   from the TLS ClientHello without terminating TLS (no MITM). Only connections with whitelisted
   SNI values are forwarded via dynamic DNS resolution. Non-TLS traffic (SSH, plain HTTP, raw TCP)
   has no SNI and is categorically denied. Non-whitelisted SNI is denied. SNI spoofing is useless
   because Envoy resolves the domain independently — a forged SNI pointing to a different IP still
   connects to the real domain, not the attacker's server.

3. **Egress policy engine** — typed rules (`EgressRule`) support domain, IP, and CIDR destinations
   with protocol-specific handling. TLS rules use SNI-based passthrough or MITM inspection.
   SSH and raw TCP rules use per-rule port mapping: each rule gets a dedicated Envoy TCP listener port,
   and destination-specific iptables REDIRECT rules in the sidecar entrypoint route matching traffic
   to the correct port. Domain resolution happens at container startup via `getent ahostsv4`.
   Mapping info flows as `OPENCLAW_TCP_MAPPINGS` env var (pipe-delimited `dst|dstPort|envoyPort`,
   semicolon-separated). CIDR destinations are not supported for SSH/TCP (emit warning). IPs may
   change after startup requiring container restart. **UDP is not proxied through Envoy** — the
   sidecar's iptables owner-match rules allow only root (containerboot) to send UDP directly.

4. **Malware-blocking DNS** — the sidecar container uses `dns: [1.1.1.2, 1.0.0.2]` (Cloudflare's
   malware-blocking resolvers). These resolvers refuse to resolve known malware, phishing, and
   command-and-control domains. All containers inherit this DNS config via shared netns.

No `HTTP_PROXY`/`HTTPS_PROXY` env vars are used. The transparent iptables REDIRECT captures all
outbound TCP regardless of what tool, port, or protocol is used.

**Key invariants (do not weaken):**

- **Sidecar model**: Tailscale sidecar (`tailscale-<profile>`) owns the network namespace. Gateway and Envoy share it via `network_mode: container:tailscale-<profile>`. Gateway has **no** `CAP_NET_ADMIN`.
- Sidecar must use `capabilities.adds: [NET_ADMIN]` for iptables.
- Sidecar entrypoint must run as root, set iptables (NAT REDIRECT + UDP DROP), then `exec containerboot`.
- Sidecar entrypoint must exclude Envoy (uid 101) and root (uid 0) from REDIRECT via owner-match.
- Sidecar NAT table must REDIRECT all non-excluded outbound TCP to Envoy's transparent proxy listener (localhost:10000).
- **UDP exfiltration prevention**: Sidecar must `ACCEPT -p udp -d 127.0.0.11` (Docker DNS), `ACCEPT -p udp -m owner --uid-owner root` (containerboot only), then `DROP -p udp` (all others). The `node` user cannot send UDP.
- Gateway entrypoint must start sshd, fix permissions, then `exec gosu node "$@"`.
- All hardcoded domains (infrastructure + AI providers + Homebrew + Tailscale) are always included in the Envoy domain whitelist.
- SSH/TCP egress rules must each get a dedicated Envoy listener port (sequential from `ENVOY_TCP_PORT_BASE`).
- SSH/TCP port mappings must be passed to the sidecar via `OPENCLAW_TCP_MAPPINGS` env var.
- Sidecar entrypoint must process `OPENCLAW_TCP_MAPPINGS` to create per-destination iptables REDIRECT rules before the catch-all.
- TCP/SSH Envoy clusters must use `STRICT_DNS` for domain destinations and `STATIC` for IP destinations.
- Tailscale domains use `*.tailscale.com` wildcard in Envoy SNI whitelist. This is safe because UDP exfiltration (the risk from attacker-controlled Tailscale networks) is blocked by the sidecar's iptables owner-match rules — only root (containerboot) can send UDP.
- Envoy DNS lookup family must be `V4_PREFERRED` (not `AUTO`) — Docker networks are IPv4-only; `AUTO` resolves IPv6 first on dual-stack hosts, causing connection failures.
- Gateway config must be written to the shared volume _before_ the gateway container starts (ephemeral CLI container: `docker run --rm --network none --user node`).
- Gateway auth token must be passed via `OPENCLAW_GATEWAY_TOKEN` env var (not config file).
- Sidecar uses `dns: [1.1.1.2, 1.0.0.2]` (Cloudflare malware-blocking), inherited by all containers.
- Sidecar uses `TS_SERVE_CONFIG` for Tailscale Serve — no dynamic `tailscale serve` CLI calls.

## Egress Domain Whitelist

All domains below are hardcoded in `config/domains.ts` and always included. They cannot be removed.

**Infrastructure:**

- `clawhub.com`
- `registry.npmjs.org`

**AI providers:**

- `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.x.ai`

**Homebrew (Linuxbrew):**

- `github.com`, `*.githubusercontent.com`, `ghcr.io`, `formulae.brew.sh`

**Tailscale (wildcard — safe because UDP is owner-match restricted):**

- TLS: `*.tailscale.com` (covers control plane, login, log, all DERP relays — current and future)
- TLS: `*.api.letsencrypt.org` (ACME for Tailscale Serve TLS certificates)

User-defined `egressPolicy` rules are **additive** to all hardcoded domains. Duplicates are deduplicated by `mergeEgressPolicy()`.
Domain filtering uses TLS SNI inspection for TLS traffic. UDP egress is not proxied through Envoy — the sidecar's iptables owner-match rules restrict UDP to root (containerboot) only.

## Future Steps

- Add CI validation via pre-commit hooks.

## Out of Scope (Unless Explicitly Requested)

- Adding unrelated tooling or frameworks.
- Building registry publishing/release automation.
- Changing release/versioning policy beyond the requested task.
- Local Docker Compose deployments (replaced by Pulumi remote provisioning).

## Editing Style

- Keep docs concise and operational.
- Keep commits scoped to one concern.
- Prefer clarity over cleverness in shell and Docker instructions.
