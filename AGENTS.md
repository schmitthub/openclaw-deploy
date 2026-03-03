# AGENTS.md

## Repository Overview

This repository is a **Pulumi TypeScript IaC** program (`openclaw-deploy`) that provisions and manages OpenClaw fleet deployments on remote VPS hosts with protocol-aware egress security.

Primary goals:

- Provision VPS infrastructure (Hetzner phase 1; DigitalOcean, Oracle planned).
- Install Docker + fail2ban on bare hosts via remote commands.
- Deploy OpenClaw gateway containers with transparent egress isolation via Envoy proxy.
- Manage fleet-scale deployments: one Pulumi stack per server, N gateways per server.
- Provide secure access via Tailscale Serve/Funnel (no self-managed TLS/ingress).

## What Agents Should Assume

- This is a Pulumi TypeScript project — not a CLI, not Docker Compose.
- Infrastructure is managed declaratively via Pulumi components and stack config.
- The Docker provider connects to remote hosts via `ssh://root@<ip>` (no local Docker).
- Templates (`templates/`) are pure functions that render Docker artifacts (Dockerfile, entrypoint.sh, envoy.yaml).
- Components (`components/`) are Pulumi `ComponentResource` subclasses that compose infrastructure.
- Changes should prioritize compatibility, determinism, and minimal image complexity.
- Prefer small, focused edits rather than broad refactors.
- Never weaken the egress isolation model (see Threat Model & Egress Security below).

## Project Structure

```
<repo-root>/                          # Pulumi project name: openclaw-deploy
├── index.ts                          # Stack composition entry point
├── package.json                      # Dependencies (Pulumi, Docker, Hcloud, Command)
├── tsconfig.json                     # TypeScript config (ES2022, strict)
├── vitest.config.ts                  # Test runner config
├── Pulumi.yaml                       # Pulumi project metadata
├── Pulumi.dev.yaml.example           # Example stack config
├── components/
│   ├── index.ts                      # Re-exports
│   ├── server.ts                     # VPS provisioning (Hetzner; DO/Oracle Phase 2)
│   ├── bootstrap.ts                  # Docker + fail2ban install on bare host
│   ├── envoy.ts                      # Egress proxy: networks + Envoy container
│   └── gateway.ts                    # OpenClaw gateway instance + config + Tailscale
├── config/
│   ├── index.ts                      # Re-exports
│   ├── types.ts                      # EgressRule, VpsProvider, GatewayConfig, StackConfig
│   ├── domains.ts                    # Hardcoded egress rules + mergeEgressPolicy()
│   └── defaults.ts                   # Constants (networks, ports, images, packages)
├── templates/
│   ├── index.ts                      # Re-exports
│   ├── dockerfile.ts                 # Renders Dockerfile (node:22-bookworm + tools)
│   ├── entrypoint.ts                 # Renders entrypoint.sh (iptables + tailscaled + gosu)
│   └── envoy.ts                      # Renders envoy.yaml (egress-only proxy + DNS)
└── tests/
    ├── config.test.ts                # Config types and domain merging
    ├── templates.test.ts             # Dockerfile/entrypoint rendering
    ├── envoy.test.ts                 # Envoy config rendering
    └── envoy-component.test.ts       # EnvoyEgress Pulumi component (mocked)
```

## Component Hierarchy

Components compose sequentially — each depends on the previous:

```
Server (VPS provisioning)
  ↓ connection (public IP SSH)
HostBootstrap (Docker + fail2ban install)
  ↓ dockerHost (public IP)
EnvoyEgress (Docker networks + Envoy container)
  ↓ internalNetworkName
Gateway(s) (1+ OpenClaw instances per server)
  ↓ Tailscale inside container (serve/funnel)
```

| Component       | Type                           | Provider                             | Purpose                                                                  |
| --------------- | ------------------------------ | ------------------------------------ | ------------------------------------------------------------------------ |
| `Server`        | `openclaw:infra:Server`        | `@pulumi/hcloud`                     | Provision VPS, expose IP + connection                                    |
| `HostBootstrap` | `openclaw:infra:HostBootstrap` | `@pulumi/command`                    | Install Docker + fail2ban on bare host                                   |
| `EnvoyEgress`   | `openclaw:infra:EnvoyEgress`   | `@pulumi/docker` + `@pulumi/command` | Create internal/egress networks, deploy Envoy                            |
| `Gateway`       | `openclaw:app:Gateway`         | `@pulumi/docker` + `@pulumi/command` | Build image, create container, configure gateway, Tailscale in container |

## Stack Configuration

Configuration is managed via `pulumi config` / `Pulumi.<stack>.yaml`:

| Key                          | Type              | Required | Description                                                |
| ---------------------------- | ----------------- | -------- | ---------------------------------------------------------- |
| `provider`                   | `"hetzner"`       | yes      | VPS provider                                               |
| `serverType`                 | string            | yes      | Server type (e.g. `cx22`, `cax21`)                         |
| `region`                     | string            | yes      | Datacenter region (e.g. `fsn1`)                            |
| `sshKeyId`                   | string            | no       | SSH key ID or name at provider (auto-generated if omitted) |
| `tailscaleAuthKey`           | secret            | yes      | One-time Tailscale auth key                                |
| `egressPolicy`               | `EgressRule[]`    | yes      | User egress rules (additive to hardcoded)                  |
| `gateways`                   | `GatewayConfig[]` | yes      | Gateway profile definitions (1+)                           |
| `gatewayToken-<profile>`     | secret            | no       | Auth token override (auto-generated if omitted)            |
| `gatewaySecretEnv-<profile>` | secret            | no       | JSON `{"KEY":"value"}` — env vars for init + runtime       |

## Deployment Model

- Each Pulumi stack deploys **one server** with **N gateway instances**.
- Envoy is the sole egress proxy — gateway containers route all traffic through it.
- Tailscale runs **inside gateway containers** (`openclaw gateway --tailscale serve/funnel`). Each gateway is a separate Tailscale device. The host does not run Tailscale.
- Tailscale uses `--tun=userspace-networking` (no TUN device). DERP relay STUN (UDP 3478) is routed through Envoy's UDP proxy listeners. DERP relay data (TCP 443) is routed through Envoy's TLS proxy. Tailscale domains are enumerated (no wildcards) in `config/domains.ts`.
- Gateway containers run on an `internal: true` Docker network with no default route to the internet.
- Entrypoint.sh (running as root) adds a default route via Envoy, sets iptables DNAT + FILTER rules, starts `tailscaled` (if Tailscale state dir is mounted), then drops to `node` user via `gosu`.
- Gateway configuration is written to a shared volume _before_ the gateway container starts via an ephemeral CLI container (`docker run --rm --network none --user node`). This avoids crash-loops from missing config. After `configSet`, optional `setupCommands` run OpenClaw subcommands (auto-prefixed with `openclaw`, e.g. `models set`, `onboard`). Secret env vars from `gatewaySecretEnv-<profile>` are injected into both the init container and the main gateway container.
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
- Config types are in `config/types.ts` — update the interface when adding new fields.
- Hardcoded egress rules are in `config/domains.ts` — these cannot be removed.
- All constants (IPs, ports, image tags) live in `config/defaults.ts`.

## Threat Model & Egress Security

The primary threat is a compromised or malicious AI agent instructing OpenClaw to exfiltrate data
to attacker-controlled domains using arbitrary tools and transports (`curl`, `wget`, `ncat`, `ssh`,
raw sockets, subprocesses — anything available in the container). Application-level proxy settings
like `HTTP_PROXY` env vars are insufficient because a prompt-injected agent can use **any tool**
that ignores proxy settings, connect on **any port**, or use **any protocol**.

**Defense-in-depth model (five layers):**

1. **Docker `internal: true` network** — the gateway container has no default route to the internet.
   There is no IP to reach. This is the hard network boundary. The entrypoint adds a default route
   via Envoy (`ip route add default via $ENVOY_IP`) so the kernel can make routing decisions for
   iptables DNAT to fire — without this, connections to external IPs fail with "Network is unreachable"
   before iptables can rewrite them.

2. **Root-owned iptables DNAT + FILTER rules** — set by `entrypoint.sh` running as root before
   dropping to the `node` user. The entrypoint derives `INTERNAL_SUBNET` from Envoy's IP (strip
   last octet, append `.0/24`). The NAT table skips DNAT for loopback (`-o lo`) and the internal
   subnet, then transparently redirects **all other outbound TCP** to Envoy's proxy listener via
   DNAT. This allows gateway health checks (loopback) and container-to-container traffic (internal
   subnet) to work without hitting Envoy, while all external traffic is captured. The FILTER table
   provides defense-in-depth with `OUTPUT DROP` default policy, only allowing loopback, Docker DNS,
   established/related, and the internal subnet. The `node` user **cannot modify these rules** —
   `CAP_NET_ADMIN` is only available to root, and the entrypoint drops to `node` via `gosu` after
   configuring iptables. The entrypoint also restores Docker's `DOCKER_OUTPUT` chain jump after
   flushing nat OUTPUT (Docker's embedded DNS uses this chain to DNAT port 53 to a high port).

3. **Envoy SNI-based domain whitelist** — the egress listener uses TLS Inspector to read the SNI
   from the TLS ClientHello without terminating TLS (no MITM). Only connections with whitelisted
   SNI values are forwarded via dynamic DNS resolution. Non-TLS traffic (SSH, plain HTTP, raw TCP)
   has no SNI and is categorically denied. Non-whitelisted SNI is denied. SNI spoofing is useless
   because Envoy resolves the domain independently — a forged SNI pointing to a different IP still
   connects to the real domain, not the attacker's server.

4. **Egress policy engine** — typed rules (`EgressRule`) support domain, IP, and CIDR destinations
   with protocol-specific handling. TLS rules use SNI-based passthrough or MITM inspection.
   SSH and raw TCP rules use per-rule port mapping: each rule gets a dedicated Envoy TCP listener port,
   and destination-specific iptables DNAT rules in the gateway entrypoint route matching traffic
   to the correct port. UDP rules use the same per-rule port mapping pattern with dedicated Envoy
   UDP proxy listeners (sequential from `ENVOY_UDP_PORT_BASE`). Domain resolution happens at
   container startup via `getent ahostsv4`. Mapping info flows as `OPENCLAW_TCP_MAPPINGS` and
   `OPENCLAW_UDP_MAPPINGS` env vars (pipe-delimited `dst|dstPort|envoyPort`, semicolon-separated).
   CIDR destinations are not supported for SSH/TCP/UDP (emit warning). IPs may change after startup
   requiring container restart.

5. **Malware-blocking DNS** — Envoy runs a DNS listener (:53 UDP) that forwards all DNS queries to
   Cloudflare's malware-blocking resolvers (1.1.1.2 / 1.0.0.2). These resolvers refuse to resolve
   known malware, phishing, and command-and-control domains. Docker's embedded DNS cannot forward
   external queries on `internal: true` networks, so gateway containers use `dns: [172.28.0.2]`
   (Envoy's static IP) for DNS resolution.

No `HTTP_PROXY`/`HTTPS_PROXY` env vars are used. The transparent iptables DNAT captures all
outbound TCP regardless of what tool, port, or protocol is used.

**Key invariants (do not weaken):**

- Gateway container must use `capabilities.adds: [NET_ADMIN]` (needed by root during init only).
- Entrypoint must run as root, set iptables (NAT DNAT + FILTER DROP), then `exec gosu node "$@"` — never skip the drop.
- Entrypoint must restore `DOCKER_OUTPUT` chain jump after flushing nat OUTPUT (Docker DNS depends on it).
- Entrypoint must add default route via Envoy (`ip route add default via $ENVOY_IP`) before iptables rules.
- Entrypoint must derive `INTERNAL_SUBNET` from Envoy's IP and skip DNAT for loopback + internal subnet.
- Entrypoint NAT table must DNAT all non-local, non-subnet outbound TCP to Envoy's transparent proxy listener.
- Entrypoint FILTER table must ACCEPT internal subnet traffic (container-to-container, service discovery).
- Internal network must be `internal: true` with IPAM subnet `172.28.0.0/24`.
- Envoy must have static IP `172.28.0.2` on the internal network.
- Gateway containers must use `dns: [172.28.0.2]` (Envoy DNS listener).
- Envoy is the only container on both internal and egress networks.
- All hardcoded domains (infrastructure + AI providers + Homebrew + Tailscale) are always included in the Envoy domain whitelist.
- Envoy DNS listener must forward to Cloudflare malware-blocking resolvers (1.1.1.2 / 1.0.0.2).
- SSH/TCP egress rules must each get a dedicated Envoy listener port (sequential from `ENVOY_TCP_PORT_BASE`).
- SSH/TCP port mappings must be passed to gateway containers via `OPENCLAW_TCP_MAPPINGS` env var.
- Entrypoint must process `OPENCLAW_TCP_MAPPINGS` to create per-destination iptables DNAT rules before the TLS catch-all.
- UDP egress rules must each get a dedicated Envoy UDP proxy listener port (sequential from `ENVOY_UDP_PORT_BASE`).
- UDP port mappings must be passed to gateway containers via `OPENCLAW_UDP_MAPPINGS` env var.
- Entrypoint must process `OPENCLAW_UDP_MAPPINGS` to create per-destination iptables UDP DNAT rules before the TCP catch-all.
- TCP/SSH Envoy clusters must use `STRICT_DNS` for domain destinations (with Cloudflare dns_resolvers) and `STATIC` for IP destinations.
- UDP Envoy clusters must use `STRICT_DNS` for domain destinations (with Cloudflare dns_resolvers) and `STATIC` for IP destinations.
- Tailscale domains must be enumerated specifically (no `*.tailscale.com` wildcard — would allow attacker-controlled Tailscale networks).
- Envoy DNS lookup family must be `V4_PREFERRED` (not `AUTO`) — Docker networks are IPv4-only; `AUTO` resolves IPv6 first on dual-stack hosts, causing connection failures.
- Gateway config must be written to the shared volume _before_ the gateway container starts (ephemeral CLI container: `docker run --rm --network none --user node`).
- Gateway auth token must be passed via `OPENCLAW_GATEWAY_TOKEN` env var (not config file).

## Egress Domain Whitelist

All domains below are hardcoded in `config/domains.ts` and always included. They cannot be removed.

**Infrastructure:**

- `clawhub.com`
- `registry.npmjs.org`

**AI providers:**

- `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.x.ai`

**Homebrew (Linuxbrew):**

- `github.com`, `*.githubusercontent.com`, `ghcr.io`, `formulae.brew.sh`

**Tailscale (control plane + DERP relays — no wildcards):**

- TLS: `tailscale.com`, `login.tailscale.com`, `controlplane.tailscale.com`, `log.tailscale.com`, `derp1–28.tailscale.com`
- UDP (STUN port 3478): `derp1–28.tailscale.com`

User-defined `egressPolicy` rules are **additive** to all hardcoded domains. Duplicates are deduplicated by `mergeEgressPolicy()`.
Domain filtering uses TLS SNI inspection for TLS traffic and per-destination Envoy UDP proxy listeners for UDP traffic.

## Future Steps

- Phase 2: DigitalOcean and Oracle Cloud provider support.
- Add CI validation via pre-commit hooks.
- Expand Pulumi unit tests with mocked components.

## Out of Scope (Unless Explicitly Requested)

- Adding unrelated tooling or frameworks.
- Building registry publishing/release automation.
- Changing release/versioning policy beyond the requested task.
- Local Docker Compose deployments (replaced by Pulumi remote provisioning).

## Editing Style

- Keep docs concise and operational.
- Keep commits scoped to one concern.
- Prefer clarity over cleverness in shell and Docker instructions.
