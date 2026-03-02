# IaC Migration Initiative — openclaw-docker → openclaw-deploy

**Branch:** `refactor/iac`
**Parent memory:** `brainstorm_iac-stack-migration`

---

## Progress Tracker

| Task | Status | Agent |
|------|--------|-------|
| Task 1: Gut repo & scaffold Pulumi TypeScript project | `complete` | Task 1 agent |
| Task 2: Type system, config schema & domain registry | `complete` | Task 2 agent |
| Task 3: Template engine — Dockerfile & entrypoint | `complete` | Task 3 agent |
| Task 4: Template engine — Envoy egress config | `complete` | Task 4 agent |
| Task 5: Server component (Hetzner VPS provisioning) | `complete` | Task 5 agent |
| Task 6: HostBootstrap component (Docker + Tailscale) | `complete` | Task 6 agent |
| Task 7: EnvoyEgress component (egress proxy per server) | `complete` | Task 7 agent |
| Task 8: Gateway component (OpenClaw instance) | `complete` | Task 8 agent |
| Task 9: Stack composition & example config | `complete` | Task 9 agent |
| Task 10: Documentation overhaul | `complete` | Task 10 agent |
| Task 11: Testing infrastructure & CI | `complete` | Task 11 agent |

## Key Learnings

(Agents append here as they complete tasks)

- **Task 1:** Serena's Go language server will fail after deleting Go code. The `.serena/project.yml` was updated to remove `go` from languages. Future agents should only see `bash` and `typescript`.
- **Task 2:** PYTHON_DOMAINS were in the initiative plan but not in AGENTS.md — removed to avoid unauthorized egress surface expansion. Removed `http` and `ftp` from `EgressRule.proto` union since they contradict the SNI-only egress model. Added `vitest.config.ts` to exclude `dist/` from test discovery. Used tuple type `[GatewayConfig, ...GatewayConfig[]]` for non-empty gateways enforcement. Serena's `edit_memory` tool fails due to Go language server init error — use Claude's Edit tool on the memory file directly instead.
- **Task 3:** Ported Dockerfile and entrypoint.sh renderers from Go `fmt.Sprintf` to TypeScript pure functions. Added `uv` (Python/astral.sh) install step and `/home/node/.local/bin` to PATH (new vs old Go code). Changed `DockerfileOpts.packages` to `string[]` instead of the old single-string `DockerAptPackages` — packages are merged with `CORE_APT_PACKAGES` at render time. Entrypoint uses `ENVOY_EGRESS_PORT` constant from config/defaults instead of hardcoding `10000`. The `renderBrowserBlock` helper conditionally emits the Playwright block rather than using the old ARG-based conditional. 47 template tests cover all security-critical invariants.
- **Task 5:** Created `components/server.ts` — Pulumi `ComponentResource` wrapping `hcloud.Server`. `ServerArgs.provider` is typed as plain `VpsProvider` (not `Input<VpsProvider>`) to enable compile-time exhaustive switch checking. Arch mapping: `cax*` → arm64, everything else → amd64. Uses `location` (not deprecated `datacenter`). Removed `components/.gitkeep` since real files exist now. `node_modules` needed `--ignore-scripts` install in sandbox (esbuild EACCES). Vitest has rollup native module issue in sandbox but `tsc --noEmit` passes cleanly.
- **Task 4:** Ported Envoy config renderer as egress-only (removed ingress listener, openclaw_gateway cluster, TLS cert references). Returns `{ yaml: string, warnings: string[] }` to surface Phase 2 gaps. TLS inspect rules emit passthrough + warning. SSH/TCP rules are skipped with warnings. All TLS allow domains go into one filter chain with combined `server_names` (same as old Go code). Uses `mergeEgressPolicy()` for hardcoded domain prepending + dedup. 34 tests cover all security invariants. Serena language server still fails due to Go not installed — used Claude's standard Read/Edit tools throughout.
- **Task 7:** EnvoyEgress component at `components/envoy.ts`. Takes `dockerHost` (for Docker provider), `connection` (for remote commands to write config files), and `egressPolicy` (EgressRule[]). Creates: Docker internal network (internal:true, IPAM 172.28.0.0/24), egress network, writes rendered envoy.yaml to host via command.remote.Command, creates Envoy container (static IP 172.28.0.2, both networks, sysctls for port 53 binding). Envoy container itself does NOT set dns config (it IS the DNS resolver). The vitest runner fails due to rollup native module issue on linux-arm64 but typecheck passes cleanly. Test file at `tests/envoy-component.test.ts` validates module exports and constant consistency.
- **Task 8:** Created `components/gateway.ts` — Pulumi `ComponentResource` wrapping Docker image build + container + config set + Tailscale serve/funnel. Key review fixes: (1) Config commands chained sequentially to prevent concurrent file write race conditions (each `openclaw config set` reads/modifies/writes same file). (2) Auth token protected via `logging: "none"` + `additionalSecretOutputs` on all config commands (matches bootstrap.ts pattern). (3) Required security config (`gateway.mode`, `auth.mode`, `auth.token`, `trustedProxies`, `mdns.mode`) always wins over user `configSet` — reversed merge order. (4) `bridgePort` now passed through to `renderDockerfile`. (5) `tailscaleUrl` resolved from actual `tailscale status --json` output instead of placeholder string. Created `components/index.ts` barrel export for all 4 components.
- **Task 9:** Created `index.ts` stack composition wiring Server → HostBootstrap → EnvoyEgress → Gateway(s). Key review fixes: (1) Placeholder `secure:` values in `Pulumi.dev.yaml` cause decryption failures — removed secrets from example file, added comments with `pulumi config set --secret` instructions instead. (2) Post-bootstrap SSH commands must use Tailscale IP (not public IP) since public SSH may be firewalled — derived `tsConnection` from `bootstrap.tailscaleIP`. (3) Added runtime validation for `provider` config (the `as VpsProvider` assertion is erased at runtime). (4) Added duplicate gateway profile detection (duplicates cause Pulumi resource URN collisions with confusing errors). (5) `jq` is used in `gateway.ts` for Tailscale DNS name extraction but isn't installed by `bootstrap.ts` — noted for future fix (Ubuntu 24.04 doesn't include `jq` by default). `pulumi stack rm --force` deletes the `Pulumi.<stack>.yaml` file — learned the hard way when it deleted the example config.
- **Task 11:** Pulumi `runtime.setMocks()` doesn't generate output-only properties like `ipv4Address` or `stdout` — the mock's `newResource` must explicitly provide these in the returned `state` object keyed by resource type (e.g. `hcloud:index/server:Server`, `command:remote:Command`). The initiative plan suggested `globals: true` in vitest config, but all existing tests use explicit `import { describe, it, expect } from "vitest"` — adding `globals: true` without a `tsconfig.json` `types: ["vitest/globals"]` entry would create a mismatch. Removed it per code review. Reinstalled `node_modules` after rollup platform mismatch error (`npm has a bug related to optional dependencies`).
- **Task 10:** Rewrote `AGENTS.md` for Pulumi TypeScript architecture — removed all Go CLI, Docker Compose, setup.sh, CLI wrapper, and ingress listener references. Added component hierarchy documentation, stack config table, and five-layer egress security model. Deleted `.claude/rules/go-files.md`, `go-test-files.md`, `config-files.md`. Updated `docker-and-shell.md` to remove Compose/setup.sh/ingress sections and reference `templates/` TypeScript code. Created `typescript-files.md` (build/verify, package layout, Pulumi/template/config conventions) and `pulumi-config.md` (stack config format, secret handling, component arg patterns). Updated `CLAUDE.md` (simplified delegation). Updated Serena `roadmap` memory for IaC migration state. `.serena/project.yml` was already correct from Task 1.
- **Task 6:** Created `components/bootstrap.ts` — Pulumi `ComponentResource` with three chained `command.remote.Command` resources (Docker install, Tailscale install, Tailscale auth). `connection` arg typed as `command.types.input.remote.ConnectionArgs` (not inline `{ host; user }`) so callers can pass `privateKey`, `agentSocketPath`, etc. Tailscale auth command uses `logging: "none"` + `additionalSecretOutputs: ["stdout", "stderr"]` to prevent auth key leakage in Pulumi logs. `tailscaleIP` extracts last line of stdout (since `tailscale up` may emit status messages before `tailscale ip -4`). Docker/Tailscale installs serialized to avoid apt/dpkg lock contention. `dockerHost` uses Tailscale IP (private, encrypted) not public IP.

---

## Context Window Management

**After completing each task, you MUST stop working immediately.** Do not begin the next task. Instead:
1. Run acceptance criteria for the completed task
2. Update the Progress Tracker in this memory
3. Append any key learnings to the Key Learnings section
4. Run a single `code-reviewer` subagent to review this task's changes, then fix any findings
5. Commit all changes from this task with a descriptive commit message
6. Present the handoff prompt from the task's Wrap Up section to the user
7. Wait for the user to start a new conversation with the handoff prompt

This ensures each task gets a fresh context window. Each task is designed to be self-contained — the handoff prompt provides all context the next agent needs.

---

## Context for All Agents

### Background

This initiative converts `openclaw-docker` (a Go CLI that generates Docker deployment artifacts) into `openclaw-deploy` — a Pulumi TypeScript IaC system for deploying OpenClaw fleets with protocol-aware egress security.

**What's changing:**
- Go CLI → Pulumi TypeScript program
- Docker Compose → Raw Docker via Pulumi Docker provider (connected via `ssh://root@<ip>`)
- setup.sh → Pulumi Command provider (granular `openclaw config set` commands)
- CLI wrapper → Tailscale Serve/Funnel handles all access
- Envoy: ingress listener REMOVED (Tailscale handles ingress), egress-only with enhanced policy engine
- TLS certs for ingress: REMOVED (Tailscale handles TLS)
- Single local deploy → Fleet management (one Pulumi stack per server, N gateways per server)

**What's carried over (ported to TypeScript renderers):**
- Dockerfile template (node:22-bookworm + iptables + iproute2 + gosu + pnpm + bun + brew + openclaw)
- entrypoint.sh (root → iptables DNAT → gosu node) — mostly static
- Envoy egress listener structure (TLS Inspector + SNI filtering + DNS :53)
- Hardcoded domain whitelist (infrastructure + AI providers + brew)
- Five-layer egress security model (Docker internal network → iptables DNAT → Envoy protocol detection → policy engine → malware DNS)

**What's new:**
- Pulumi component resources (Server, HostBootstrap, EnvoyEgress, Gateway)
- VPS provisioning (Hetzner phase 1, DO/Oracle later)
- Tailscale integration (install on host, configure Serve/Funnel per gateway)
- Egress policy engine with typed rules (domain/IP/CIDR × protocol × path allow/deny)
- MITM TLS inspection for path-level filtering (structure in place, full impl Phase 2)
- Per-gateway Docker images with baked packages
- Non-interactive gateway setup via `docker exec ... openclaw config set`
- Multiple gateway profiles per server

**Read the Serena memory `brainstorm_iac-stack-migration`** for the complete design document including the egress policy engine specification, component interfaces, and architecture decisions.

### Target Project Structure

```
openclaw-deploy/
├── Pulumi.yaml                       # Project metadata
├── Pulumi.dev.yaml                   # Example stack config (dev server)
├── package.json                      # Dependencies
├── tsconfig.json                     # TypeScript config
├── index.ts                          # Stack composition entry point
├── components/
│   ├── server.ts                     # VPS provisioning (Hetzner → DO → Oracle)
│   ├── bootstrap.ts                  # Docker + Tailscale install on bare VPS
│   ├── envoy.ts                      # Egress proxy: network + container + policy → envoy.yaml
│   └── gateway.ts                    # OpenClaw instance: image + container + config + tailscale
├── templates/
│   ├── dockerfile.ts                 # Dockerfile string renderer (version, packages, browser)
│   ├── entrypoint.ts                 # entrypoint.sh content (mostly static)
│   └── envoy.ts                      # envoy.yaml renderer from EgressRule[]
├── config/
│   ├── types.ts                      # EgressRule, PathRule, GatewayConfig, StackConfig interfaces
│   ├── domains.ts                    # Hardcoded infrastructure domain registry
│   └── defaults.ts                   # Default values and constants
├── templates/                        # Static assets deployed to servers
│   └── entrypoint.sh                 # (also available as .ts renderer — both approaches available)
├── LICENSE                           # MIT (carried over)
├── .claude/                          # Claude Code config (carried over, rules updated)
│   └── rules/                        # Updated for TypeScript
├── .serena/                          # Serena config (carried over, project.yml updated)
└── tests/                            # Pulumi unit tests + template tests
    ├── templates.test.ts             # Template rendering tests
    ├── envoy.test.ts                 # Envoy config generation tests
    └── components.test.ts            # Component interface tests (Pulumi mocks)
```

### Key Design Decisions (from brainstorm)

1. **Stack = one server.** `pulumi up --stack hetzner-personal` manages one VPS.
2. **Raw Docker provider** connected via `ssh://root@<ip>`. No Compose.
3. **Tailscale for all networking.** Serve = private tailnet access. Funnel = public webhooks.
4. **Envoy egress-only.** No ingress listener. Tailscale handles all ingress.
5. **Egress policy is server-level** (on EnvoyEgress component), not per-gateway.
6. **Per-gateway Docker images** with baked packages (AI agents have arbitrary deps).
7. **Non-interactive setup.** `openclaw config set` commands via Pulumi Command provider.
8. **Tailscale on HOST, not in container.** Configured via `command.remote.Command`.
9. **Gateway on loopback only.** Tailscale Serve proxies `https+insecure://localhost:<port>`.
10. **Funnel limited to ports 443, 8443, 10000.** Max 3 public-facing gateways per server.

### Egress Rule Type System (CRITICAL)

```typescript
type EgressRule = {
  dst: string;              // domain "x.com" | IP "140.82.121.4" | CIDR "10.0.0.0/24"
  proto: "tls" | "http" | "ssh" | "ftp" | "tcp";
  port?: number;            // required for ssh/ftp/tcp, optional for tls/http
  action: "allow" | "deny";
  inspect?: boolean;        // MITM TLS termination for path-level rules
  pathRules?: PathRule[];   // when inspect=true
};

type PathRule = {
  path: string;             // glob: "/messages/*", "/api/dm/*"
  action: "allow" | "deny";
};
```

- First matching rule wins (top-down evaluation)
- Default: DENY everything not matched
- Hardcoded infrastructure domains always prepended
- Domain whitelist + path blacklist pattern: "allow x.com, deny /messages/*"

### Current Entrypoint.sh (carried over — mostly static)

Runs as root in gateway container:
1. Resolves Envoy IP via `getent hosts envoy`
2. Derives INTERNAL_SUBNET (strip last octet, append `.0/24`)
3. Adds default route via Envoy (required for `internal:true` network)
4. Flushes iptables, restores DOCKER_OUTPUT chain (Docker DNS)
5. NAT: skip DNAT for loopback + internal subnet, DNAT all other TCP to Envoy:10000
6. FILTER: OUTPUT DROP, allow loopback + Docker DNS + established + internal subnet
7. Drops to node via `exec gosu node "$@"`

### Current Dockerfile Template (carried over — enhanced with per-gateway packages)

- Base: `FROM node:22-bookworm`
- Core: iptables, iproute2, gosu, libsecret-tools
- Runtime: pnpm (npm), bun (curl + copy), Homebrew (Linuxbrew as node user), uv (Python)
- OpenClaw: `npm install -g openclaw@${version}` with `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
- CLI symlink: `ln -sf "$(npm root -g)/openclaw/dist/entry.js" /usr/local/bin/openclaw`
- Optional: Playwright + Chromium via `OPENCLAW_INSTALL_BROWSER` ARG
- ENTRYPOINT ["entrypoint.sh"], CMD ["openclaw", "gateway", "--allow-unconfigured"]

### Current Envoy Config (egress portion carried over, ingress REMOVED)

**Kept:**
- Egress listener (:10000) — TLS Inspector + SNI filter chains + deny_cluster
- DNS listener (:53 UDP) — Cloudflare 1.1.1.2/1.0.0.2
- dynamic_forward_proxy_cluster for SNI passthrough
- deny_cluster (STATIC, no endpoints) for non-whitelisted traffic

**Removed:**
- Ingress listener (:443) — Tailscale handles this now
- TLS cert mounting — no more self-signed certs
- openclaw_gateway cluster — gateway reached via Tailscale, not Envoy

**New (Phase 1 structure):**
- Per-domain filter chains for inspected domains (MITM TLS → HTTP path matching)
- HTTP filter chain for plain HTTP/WS (Host header + path rules)

### Hardcoded Domain Registry

**Infrastructure (always included):**
- `clawhub.com`, `registry.npmjs.org`

**AI providers (always included):**
- `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.x.ai`

**Homebrew (always included):**
- `github.com`, `*.githubusercontent.com`, `ghcr.io`, `formulae.brew.sh`

**Python/uv (always included):**
- `pypi.org`, `files.pythonhosted.org`, `astral.sh`

User-provided `egressPolicy` rules are ADDITIVE to these hardcoded domains.

### Rules

- Read `CLAUDE.md`, relevant `.claude/rules/` files, and package `CLAUDE.md` before starting each task
- Read the Serena memory `brainstorm_iac-stack-migration` for full design context
- Use Serena tools for code exploration — read symbol bodies only when needed
- All new code must compile: `npx tsc --noEmit` must pass
- Follow Pulumi TypeScript conventions: ComponentResource subclasses, registerOutputs(), Input/Output types
- Templates are pure functions: (config) → string. No side effects, easily testable.
- Components create Pulumi resources. Templates render file content. Config defines types and defaults. Keep these separate.
- Entrypoint.sh and Dockerfile are the security boundary — do not weaken iptables rules or change the root→gosu→node flow
- Envoy egress is the policy enforcement point — maintain TLS Inspector + SNI filtering + deny-by-default
- Test template output thoroughly — these are the artifacts that actually run on servers

---

## Task 1: Gut Repo & Scaffold Pulumi TypeScript Project

**Creates/modifies:** `package.json`, `tsconfig.json`, `Pulumi.yaml`, `.gitignore`, `index.ts`, `components/`, `templates/`, `config/`, `tests/`, `.serena/project.yml`, `.envrc`
**Deletes:** `main.go`, `go.mod`, `go.sum`, `Makefile`, `.goreleaser.yaml`, `internal/`, `e2e/`, `bin/`, `openclaw-deploy/` (generated output), `.pre-commit-config.yaml` (recreated in Task 11)
**Depends on:** nothing

### Implementation Phase

1. **Read current state:** Read `go.mod` to confirm module name. List all Go files to delete. Read `.serena/project.yml` and `.envrc`.

2. **Delete Go codebase:**
   - Delete: `main.go`, `go.mod`, `go.sum`, `Makefile`, `.goreleaser.yaml`
   - Delete directories: `internal/`, `e2e/`, `bin/`
   - Delete generated output: `openclaw-deploy/` (this was test output, not source)
   - Keep: `.claude/`, `.serena/`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `.git/`, `.envrc`
   - Delete package-level `CLAUDE.md` and `AGENTS.md` files inside `internal/` (they go with the directory)
   - Delete `.pre-commit-config.yaml` (will be recreated for TypeScript in Task 11)

3. **Initialize npm project:**
   ```bash
   npm init -y
   ```
   Then edit `package.json`:
   - name: `openclaw-deploy`
   - version: `0.1.0`
   - description: `Pulumi IaC for deploying OpenClaw fleets with protocol-aware egress security`
   - license: `MIT`
   - main: `index.ts`
   - scripts: `{ "build": "tsc", "test": "vitest run", "typecheck": "tsc --noEmit" }`

4. **Install dependencies:**
   ```bash
   npm install @pulumi/pulumi @pulumi/command @pulumi/docker @pulumi/hcloud
   npm install -D typescript @types/node vitest
   ```

5. **Create `tsconfig.json`:**
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "commonjs",
       "moduleResolution": "node",
       "lib": ["ES2022"],
       "strict": true,
       "esModuleInterop": true,
       "skipLibCheck": true,
       "forceConsistentCasingInFileNames": true,
       "outDir": "./dist",
       "rootDir": ".",
       "declaration": true,
       "sourceMap": true
     },
     "include": ["index.ts", "components/**/*.ts", "templates/**/*.ts", "config/**/*.ts", "tests/**/*.ts"],
     "exclude": ["node_modules", "dist"]
   }
   ```

6. **Create `Pulumi.yaml`:**
   ```yaml
   name: openclaw-deploy
   runtime:
     name: nodejs
     options:
       typescript: true
   description: Pulumi IaC for deploying OpenClaw fleets with protocol-aware egress security
   ```

7. **Create directory structure:**
   ```
   mkdir -p components templates config tests
   ```
   Create placeholder files:
   - `index.ts` — minimal `import * as pulumi from "@pulumi/pulumi";` + comment
   - `components/.gitkeep`
   - `templates/.gitkeep`
   - `config/.gitkeep`
   - `tests/.gitkeep`

8. **Update `.gitignore`:** Add `node_modules/`, `dist/`, `Pulumi.*.yaml` (stack configs with secrets), keep `.env*` ignore

9. **Update `.serena/project.yml`:** Change languages from `bash, go` to `bash, typescript`

10. **Update `.envrc`:** Change from `PATH_add bin` to just ensure node_modules/.bin is available (or remove if not needed)

### Acceptance Criteria

```bash
# TypeScript compiles
npx tsc --noEmit

# Dependencies installed
test -d node_modules/@pulumi/pulumi
test -d node_modules/@pulumi/command
test -d node_modules/@pulumi/docker
test -d node_modules/@pulumi/hcloud

# Go code fully removed
test ! -f main.go
test ! -f go.mod
test ! -d internal
test ! -d e2e

# Project structure exists
test -f Pulumi.yaml
test -f tsconfig.json
test -f package.json
test -f index.ts
test -d components
test -d templates
test -d config
test -d tests
```

### Wrap Up

1. Update Progress Tracker: Task 1 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 2. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 1 is complete. Begin Task 2: Type system, config schema & domain registry."

---

## Task 2: Type System, Config Schema & Domain Registry

**Creates/modifies:** `config/types.ts`, `config/domains.ts`, `config/defaults.ts`, `config/index.ts`
**Depends on:** Task 1

### Implementation Phase

1. **Create `config/types.ts`** — All TypeScript interfaces for the project:

   ```typescript
   // Egress policy types
   export interface PathRule {
     path: string;           // glob: "/messages/*", "/api/dm/*"
     action: "allow" | "deny";
   }

   export interface EgressRule {
     dst: string;            // domain "x.com" | IP "140.82.121.4" | CIDR "10.0.0.0/24"
     proto: "tls" | "http" | "ssh" | "ftp" | "tcp";
     port?: number;          // required for ssh/ftp/tcp, optional for tls/http (defaults 443/80)
     action: "allow" | "deny";
     inspect?: boolean;      // MITM TLS termination for path-level rules
     pathRules?: PathRule[]; // when inspect=true
   }

   // VPS provider type
   export type VpsProvider = "hetzner" | "digitalocean" | "oracle";

   // Tailscale mode per gateway
   export type TailscaleMode = "serve" | "funnel" | "off";

   // Gateway configuration
   export interface GatewayConfig {
     profile: string;           // unique name for this gateway instance
     version: string;           // openclaw version (npm dist-tag or semver)
     packages: string[];        // apt packages to bake into image
     port: number;              // host port (maps to 18789 inside container)
     bridgePort?: number;       // bridge port (defaults 18790)
     tailscale: TailscaleMode;
     installBrowser?: boolean;  // bake Playwright + Chromium (~300MB)
     configSet: Record<string, string>; // openclaw config set key=value pairs
     env?: Record<string, string>;      // additional env vars for container
   }

   // Full stack configuration
   export interface StackConfig {
     // VPS
     provider: VpsProvider;
     serverType: string;        // e.g. "cx22" (Hetzner), "s-1vcpu-1gb" (DO)
     region: string;            // e.g. "fsn1", "nyc1"
     sshKeyId: string;          // provider-specific SSH key ID or fingerprint

     // Tailscale
     tailscaleAuthKey: string;  // secret: one-time auth key

     // Egress
     egressPolicy: EgressRule[];

     // Gateways (1+)
     gateways: GatewayConfig[];
   }
   ```

2. **Create `config/domains.ts`** — Hardcoded infrastructure domain registry:

   ```typescript
   import { EgressRule } from "./types";

   // Infrastructure domains — always allowed, cannot be removed
   export const INFRASTRUCTURE_DOMAINS: EgressRule[] = [
     { dst: "clawhub.com",           proto: "tls", action: "allow" },
     { dst: "registry.npmjs.org",    proto: "tls", action: "allow" },
   ];

   // AI provider domains — always allowed
   export const AI_PROVIDER_DOMAINS: EgressRule[] = [
     { dst: "api.anthropic.com",                  proto: "tls", action: "allow" },
     { dst: "api.openai.com",                     proto: "tls", action: "allow" },
     { dst: "generativelanguage.googleapis.com",   proto: "tls", action: "allow" },
     { dst: "openrouter.ai",                      proto: "tls", action: "allow" },
     { dst: "api.x.ai",                           proto: "tls", action: "allow" },
   ];

   // Homebrew (Linuxbrew) domains — always allowed
   export const HOMEBREW_DOMAINS: EgressRule[] = [
     { dst: "github.com",                 proto: "tls", action: "allow" },
     { dst: "*.githubusercontent.com",    proto: "tls", action: "allow" },
     { dst: "ghcr.io",                    proto: "tls", action: "allow" },
     { dst: "formulae.brew.sh",           proto: "tls", action: "allow" },
   ];

   // Python/uv domains — always allowed
   export const PYTHON_DOMAINS: EgressRule[] = [
     { dst: "pypi.org",                  proto: "tls", action: "allow" },
     { dst: "files.pythonhosted.org",    proto: "tls", action: "allow" },
     { dst: "astral.sh",                 proto: "tls", action: "allow" },
   ];

   // All hardcoded rules combined (prepended to user policy)
   export const HARDCODED_EGRESS_RULES: EgressRule[] = [
     ...INFRASTRUCTURE_DOMAINS,
     ...AI_PROVIDER_DOMAINS,
     ...HOMEBREW_DOMAINS,
     ...PYTHON_DOMAINS,
   ];

   // Merge user rules with hardcoded rules (hardcoded first, deduped by dst+proto)
   export function mergeEgressPolicy(userRules: EgressRule[]): EgressRule[] {
     const seen = new Set<string>();
     const merged: EgressRule[] = [];
     for (const rule of [...HARDCODED_EGRESS_RULES, ...userRules]) {
       const key = `${rule.dst}:${rule.proto}:${rule.port ?? ""}`;
       if (!seen.has(key)) {
         seen.add(key);
         merged.push(rule);
       }
     }
     return merged;
   }
   ```

3. **Create `config/defaults.ts`** — Constants and default values:

   ```typescript
   // Docker network constants
   export const INTERNAL_NETWORK_SUBNET = "172.28.0.0/24";
   export const ENVOY_STATIC_IP = "172.28.0.2";
   export const INTERNAL_NETWORK_NAME = "openclaw-internal";
   export const EGRESS_NETWORK_NAME = "openclaw-egress";

   // Envoy
   export const ENVOY_IMAGE = "envoyproxy/envoy:v1.33-latest";
   export const ENVOY_EGRESS_PORT = 10000;
   export const ENVOY_DNS_PORT = 53;
   export const CLOUDFLARE_DNS_PRIMARY = "1.1.1.2";
   export const CLOUDFLARE_DNS_SECONDARY = "1.0.0.2";

   // Gateway defaults
   export const DEFAULT_GATEWAY_PORT = 18789;
   export const DEFAULT_BRIDGE_PORT = 18790;
   export const DEFAULT_OPENCLAW_CONFIG_DIR = "/home/node/.openclaw";
   export const DEFAULT_OPENCLAW_WORKSPACE_DIR = "/home/node/.openclaw/workspace";
   export const DEFAULT_GATEWAY_BIND = "lan";
   export const DOCKER_BASE_IMAGE = "node:22-bookworm";

   // Core apt packages (always installed)
   export const CORE_APT_PACKAGES = ["iptables", "iproute2", "gosu", "libsecret-tools"];

   // Tailscale Funnel allowed ports
   export const TAILSCALE_FUNNEL_PORTS = [443, 8443, 10000];
   ```

4. **Create `config/index.ts`** — barrel export:
   ```typescript
   export * from "./types";
   export * from "./domains";
   export * from "./defaults";
   ```

5. **Write unit tests** `tests/config.test.ts`:
   - Test `mergeEgressPolicy` deduplication
   - Test that hardcoded domains are always first
   - Test that user rules are additive
   - Verify all hardcoded domain counts

### Acceptance Criteria

```bash
# TypeScript compiles
npx tsc --noEmit

# Tests pass
npx vitest run tests/config.test.ts

# Verify exports
node -e "const c = require('./dist/config'); console.log(Object.keys(c))"
```

### Wrap Up

1. Update Progress Tracker: Task 2 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 3. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 2 is complete. Begin Task 3: Template engine — Dockerfile & entrypoint."

---

## Task 3: Template Engine — Dockerfile & Entrypoint

**Creates/modifies:** `templates/dockerfile.ts`, `templates/entrypoint.ts`, `templates/index.ts`, `tests/templates.test.ts`
**Depends on:** Task 2 (config/types, config/defaults)

### Implementation Phase

Port the Dockerfile and entrypoint.sh generators from the current Go `internal/render/render.go` (functions `dockerfileFor()` and `entrypointContent()`). These become pure TypeScript functions that return strings.

1. **Create `templates/dockerfile.ts`:**

   A pure function `renderDockerfile(opts)` that returns the Dockerfile string. Port from the current Go template but parameterize:
   - `version: string` — OpenClaw version to install
   - `packages: string[]` — additional apt packages to bake in
   - `installBrowser: boolean` — bake Playwright + Chromium
   - `configDir: string` — defaults to `/home/node/.openclaw`
   - `workspaceDir: string` — defaults to `/home/node/.openclaw/workspace`
   - `gatewayPort: number` — defaults to 18789
   - `bridgePort: number` — defaults to 18790
   - `gatewayBind: string` — defaults to `lan`

   **CRITICAL details from current Dockerfile to preserve:**
   - Base: `FROM node:22-bookworm`
   - Core packages: `iptables iproute2 gosu libsecret-tools` + user packages in single `apt-get install`
   - Bun: `curl -fsSL https://bun.sh/install | bash` then `cp /root/.bun/bin/bun /usr/local/bin/bun` (symlinks through `/root/` fail — mode 0700)
   - pnpm: `npm install -g pnpm`, `PNPM_HOME=/home/node/.local/share/pnpm`, `mkdir -p "${PNPM_HOME}" /home/node/.local/bin`, `chown -R node:node /home/node/.local`
   - Homebrew: `mkdir -p /home/linuxbrew/.linuxbrew && chown -R node:node /home/linuxbrew`, switch to `USER node`, run installer as non-root, switch back to `USER root`, set HOMEBREW env vars
   - uv: installed as `node` user via `curl -LsSf https://astral.sh/uv/install.sh | sh`
   - PATH includes: `${PNPM_HOME}`, `/home/node/.local/bin`, `/home/linuxbrew/.linuxbrew/bin`, `/home/linuxbrew/.linuxbrew/sbin`
   - OpenClaw: `SHARP_IGNORE_GLOBAL_LIBVIPS=1 NODE_OPTIONS=--max-old-space-size=2048 npm install -g --no-fund --no-audit "openclaw@${OPENCLAW_VERSION}"`
   - CLI symlink: `ln -sf "$(npm root -g)/openclaw/dist/entry.js" /usr/local/bin/openclaw`
   - Browser: conditional `if [ -n "$OPENCLAW_INSTALL_BROWSER" ]` block with xvfb + playwright
   - COPY entrypoint.sh + chmod 755
   - `OPENCLAW_PREFER_PNPM=1`, `NODE_ENV=production`
   - `ENTRYPOINT ["entrypoint.sh"]`
   - `CMD ["openclaw", "gateway", "--allow-unconfigured"]`

2. **Create `templates/entrypoint.ts`:**

   A pure function `renderEntrypoint()` that returns the entrypoint.sh string. This is mostly static — port directly from current `entrypointContent()` in render.go.

   **CRITICAL details to preserve exactly:**
   - `#!/bin/bash` shebang (not `#!/usr/bin/env bash` — this runs inside Docker, not macOS)
   - `set -euo pipefail`
   - Resolve Envoy IP: `ENVOY_IP="$(getent hosts envoy | awk '{print $1}')"`
   - Error if empty
   - Derive subnet: `INTERNAL_SUBNET="${ENVOY_IP%.*}.0/24"`
   - Default route: `ip route add default via "$ENVOY_IP" 2>/dev/null || true`
   - Flush: `iptables -F OUTPUT`, `iptables -F INPUT`, `iptables -t nat -F OUTPUT`
   - Restore Docker DNS: `iptables -t nat -A OUTPUT -j DOCKER_OUTPUT 2>/dev/null || true`
   - NAT: RETURN for `-o lo`, RETURN for `-d "$INTERNAL_SUBNET"`, DNAT all TCP to `"$ENVOY_IP":10000`
   - FILTER: `-P OUTPUT DROP`, ACCEPT `-o lo`, ACCEPT Docker DNS `127.0.0.11:53 UDP`, ACCEPT established/related, ACCEPT `$INTERNAL_SUBNET`
   - LOG prefix: `OPENCLAW-BLOCKED:`
   - Drop: `exec gosu node "$@"`

3. **Create `templates/index.ts`** — barrel export

4. **Write tests `tests/templates.test.ts`:**
   - Dockerfile contains base image `node:22-bookworm`
   - Dockerfile contains version ARG/ENV
   - Dockerfile contains iptables, iproute2, gosu, libsecret-tools
   - Dockerfile contains pnpm install + PNPM_HOME
   - Dockerfile contains bun install + copy to /usr/local/bin
   - Dockerfile contains Homebrew install as node user
   - Dockerfile contains uv install as node user
   - Dockerfile contains openclaw install with SHARP_IGNORE_GLOBAL_LIBVIPS
   - Dockerfile ENTRYPOINT is ["entrypoint.sh"]
   - Dockerfile CMD is ["openclaw", "gateway", "--allow-unconfigured"]
   - Dockerfile includes custom packages when provided
   - Dockerfile includes browser block when installBrowser=true
   - Dockerfile does NOT include browser block when installBrowser=false
   - Entrypoint contains `getent hosts envoy`
   - Entrypoint contains `ip route add default`
   - Entrypoint contains `DOCKER_OUTPUT` chain restore
   - Entrypoint contains iptables NAT DNAT to port 10000
   - Entrypoint contains `iptables -P OUTPUT DROP`
   - Entrypoint contains `exec gosu node`
   - Entrypoint contains Docker DNS allow (127.0.0.11:53)
   - Entrypoint is valid bash (no TypeScript interpolation artifacts)

### Acceptance Criteria

```bash
npx tsc --noEmit
npx vitest run tests/templates.test.ts
```

### Wrap Up

1. Update Progress Tracker: Task 3 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 4. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 3 is complete. Begin Task 4: Template engine — Envoy egress config."

---

## Task 4: Template Engine — Envoy Egress Config

**Creates/modifies:** `templates/envoy.ts`, `tests/envoy.test.ts`
**Depends on:** Task 2 (config/types, config/defaults, config/domains)

### Implementation Phase

Port the Envoy config generator from `envoyConfigContent()` in render.go, but with significant changes:
- **REMOVE** the ingress listener (:443) — Tailscale handles ingress now
- **REMOVE** the `openclaw_gateway` cluster — no longer needed
- **REMOVE** TLS cert references — no ingress TLS termination
- **KEEP** the egress listener (:10000) with TLS Inspector + SNI filtering
- **KEEP** the DNS listener (:53 UDP) with Cloudflare resolvers
- **KEEP** the dynamic_forward_proxy_cluster and deny_cluster
- **ENHANCE** to generate filter chains from `EgressRule[]` (not a flat domain list)

1. **Create `templates/envoy.ts`:**

   A pure function `renderEnvoyConfig(rules: EgressRule[])` that returns the envoy.yaml string.

   **Structure:**
   ```yaml
   static_resources:
     listeners:
       # Egress listener (:10000) — transparent TLS proxy with policy engine
       - name: egress
         address: { socket_address: { address: 0.0.0.0, port_value: 10000 } }
         listener_filters:
           - tls_inspector
         filter_chains:
           # For each TLS "allow" rule without inspect: SNI passthrough chain
           - filter_chain_match: { server_names: [<domain>] }
             filters: [sni_dynamic_forward_proxy, tcp_proxy → dynamic_forward_proxy_cluster]

           # For each TLS "allow" rule WITH inspect: MITM chain (Phase 2 stub)
           # Structure: terminate TLS → HTTP connection manager → route match by path → re-encrypt upstream
           # For now: treat same as passthrough (log warning about inspect not yet implemented)

           # For each HTTP "allow" rule: plain HTTP chain (matched by... TODO: needs original_dst)
           # Phase 2: HTTP connection manager on non-TLS traffic

           # Default deny chain (no match criteria = catch-all)
           - filters: [tcp_proxy → deny_cluster]

       # DNS listener (:53 UDP) — Cloudflare malware-blocking
       - name: dns
         address: { socket_address: { address: 0.0.0.0, port_value: 53, protocol: UDP } }
         listener_filters:
           - dns_filter → 1.1.1.2, 1.0.0.2

     clusters:
       - dynamic_forward_proxy_cluster (CLUSTER_PROVIDED)
       - deny_cluster (STATIC, no endpoints)
   ```

   **Key implementation details:**
   - Group TLS rules by action to build SNI server_names lists
   - All TLS "allow" passthrough domains go into ONE filter chain with all server_names (same as current implementation — simpler, performant)
   - Inspected TLS domains get logged as "not yet implemented, treating as passthrough" and added to the passthrough list (Phase 1)
   - SSH/FTP/TCP rules get logged as "Phase 2 — requires DNS snooping" and skipped
   - HTTP rules get logged as "Phase 2 — requires original_dst listener filter" and skipped
   - The function should return `{ yaml: string, warnings: string[] }` so callers can surface phase-2 warnings
   - Use `mergeEgressPolicy()` from config/domains to prepend hardcoded rules

2. **Write tests `tests/envoy.test.ts`:**
   - Default (empty user rules) produces valid config with hardcoded domains
   - All hardcoded domains appear in SNI server_names list
   - User TLS rules add to server_names list
   - Duplicate domains are deduplicated
   - DNS listener present with Cloudflare resolvers (1.1.1.2, 1.0.0.2)
   - DNS port is 53 UDP
   - Egress listener is on port 10000
   - deny_cluster is STATIC with no endpoints
   - No ingress listener (port 443 NOT present)
   - No openclaw_gateway cluster
   - No TLS certificate references
   - Inspected TLS rules produce warnings (phase 2)
   - SSH/FTP/TCP rules produce warnings (phase 2)
   - Wildcard domains (e.g., `*.githubusercontent.com`) preserved correctly in server_names
   - Output is valid YAML (parse with js-yaml and verify structure)

### Acceptance Criteria

```bash
npx tsc --noEmit
npx vitest run tests/envoy.test.ts
```

### Wrap Up

1. Update Progress Tracker: Task 4 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 5. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 4 is complete. Begin Task 5: Server component (Hetzner VPS provisioning)."

---

## Task 5: Server Component (Hetzner VPS Provisioning)

**Creates/modifies:** `components/server.ts`
**Depends on:** Task 1 (Pulumi deps installed)

### Implementation Phase

Create the Server component that provisions a VPS. Phase 1 = Hetzner only. The component should be structured for future provider support (DO, Oracle) but only implement Hetzner.

1. **Create `components/server.ts`:**

   ```typescript
   import * as pulumi from "@pulumi/pulumi";
   import * as hcloud from "@pulumi/hcloud";
   import { VpsProvider } from "../config";

   export interface ServerArgs {
     provider: VpsProvider;
     serverType: pulumi.Input<string>;  // e.g. "cx22", "cx32"
     region: pulumi.Input<string>;      // e.g. "fsn1", "nbg1"
     sshKeyId: pulumi.Input<string>;    // Hetzner SSH key ID
     image?: pulumi.Input<string>;      // defaults to "ubuntu-24.04"
   }

   export class Server extends pulumi.ComponentResource {
     public readonly ipAddress: pulumi.Output<string>;
     public readonly arch: pulumi.Output<string>;  // "amd64" or "arm64"
     public readonly connection: pulumi.Output<{ host: string; user: string }>;
     public readonly dockerHost: pulumi.Output<string>; // "ssh://root@<ip>"

     constructor(name: string, args: ServerArgs, opts?: pulumi.ComponentResourceOptions) {
       super("openclaw:infra:Server", name, {}, opts);
       // ... switch on args.provider, create hcloud.Server
       // For Hetzner: create server with cloud-init for basic setup
       // Output connection info for Command provider
       this.registerOutputs({ ... });
     }
   }
   ```

   **Hetzner implementation details:**
   - Use `@pulumi/hcloud` provider
   - Create `hcloud.Server` with specified server type, location, image, SSH keys
   - Map Hetzner server types to arch: `cx*` and `cpx*` = amd64, `cax*` = arm64
   - Output `ipAddress` from server's `ipv4Address`
   - Output `connection` as `{ host: ipAddress, user: "root" }` for `command.remote`
   - Output `dockerHost` as `ssh://root@<ipAddress>` for Docker provider
   - No cloud-init for now — HostBootstrap handles all configuration

   **Provider abstraction:**
   - Validate `provider === "hetzner"` in constructor, throw for unsupported providers
   - Comment stubs for `"digitalocean"` and `"oracle"` cases

### Acceptance Criteria

```bash
npx tsc --noEmit

# Verify component can be instantiated (dry run — no actual cloud resources)
# This will be validated when index.ts is composed in Task 9
```

### Wrap Up

1. Update Progress Tracker: Task 5 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 6. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 5 is complete. Begin Task 6: HostBootstrap component (Docker + Tailscale)."

---

## Task 6: HostBootstrap Component (Docker + Tailscale)

**Creates/modifies:** `components/bootstrap.ts`
**Depends on:** Task 5 (Server component for connection/dockerHost outputs)

### Implementation Phase

Create the HostBootstrap component that installs Docker Engine and Tailscale on a bare VPS via remote commands.

1. **Create `components/bootstrap.ts`:**

   ```typescript
   import * as pulumi from "@pulumi/pulumi";
   import * as command from "@pulumi/command";

   export interface HostBootstrapArgs {
     connection: pulumi.Input<{ host: string; user: string }>;
     tailscaleAuthKey: pulumi.Input<string>;  // secret
   }

   export class HostBootstrap extends pulumi.ComponentResource {
     public readonly dockerReady: pulumi.Output<string>;  // sentinel for dependency
     public readonly tailscaleIP: pulumi.Output<string>;
     public readonly dockerHost: pulumi.Output<string>;

     constructor(name: string, args: HostBootstrapArgs, opts?: pulumi.ComponentResourceOptions) {
       super("openclaw:infra:HostBootstrap", name, {}, opts);
       // ... three command.remote.Command resources, chained via dependsOn
       this.registerOutputs({ ... });
     }
   }
   ```

   **Three remote commands (chained):**

   a. **Install Docker Engine:**
   ```bash
   # Install Docker using official convenience script
   curl -fsSL https://get.docker.com | sh
   # Enable and start Docker
   systemctl enable docker
   systemctl start docker
   # Verify
   docker --version
   ```
   - Uses `command.remote.Command`
   - Connection from Server component
   - Idempotent: Docker install script handles already-installed case

   b. **Install Tailscale:**
   ```bash
   # Install Tailscale using official script
   curl -fsSL https://tailscale.com/install.sh | sh
   ```
   - `dependsOn: [installDocker]`

   c. **Authenticate Tailscale:**
   ```bash
   tailscale up --authkey=${authKey} --ssh
   ```
   - `dependsOn: [installTailscale]`
   - `--ssh` enables Tailscale SSH (secure remote access)
   - Output: parse `tailscale ip -4` for tailscaleIP

   **Outputs:**
   - `dockerReady`: sentinel string (completion signal for dependent resources)
   - `tailscaleIP`: the Tailscale IPv4 address
   - `dockerHost`: `ssh://root@<tailscaleIP>` — Docker provider connects via Tailscale SSH, not public IP

   **Important:** After bootstrap, the Docker provider should connect via Tailscale IP (private, encrypted) rather than public IP. This means `dockerHost` output uses `tailscaleIP`, not the server's public IP.

### Acceptance Criteria

```bash
npx tsc --noEmit
```

### Wrap Up

1. Update Progress Tracker: Task 6 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 7. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 6 is complete. Begin Task 7: EnvoyEgress component (egress proxy per server)."

---

## Task 7: EnvoyEgress Component (Egress Proxy Per Server)

**Creates/modifies:** `components/envoy.ts`
**Depends on:** Task 4 (templates/envoy.ts for config rendering), Task 6 (HostBootstrap for dockerHost)

### Implementation Phase

Create the EnvoyEgress component that sets up the Docker networks and Envoy container on a server.

1. **Create `components/envoy.ts`:**

   ```typescript
   import * as pulumi from "@pulumi/pulumi";
   import * as docker from "@pulumi/docker";
   import * as command from "@pulumi/command";
   import { EgressRule } from "../config";

   export interface EnvoyEgressArgs {
     dockerHost: pulumi.Input<string>;      // ssh://root@<ip>
     egressPolicy: EgressRule[];
     connection: pulumi.Input<{ host: string; user: string }>;
   }

   export class EnvoyEgress extends pulumi.ComponentResource {
     public readonly envoyIP: pulumi.Output<string>;       // 172.28.0.2
     public readonly internalNetworkId: pulumi.Output<string>;
     public readonly egressNetworkId: pulumi.Output<string>;

     constructor(name: string, args: EnvoyEgressArgs, opts?: pulumi.ComponentResourceOptions) {
       super("openclaw:network:EnvoyEgress", name, {}, opts);
       // ... create resources
       this.registerOutputs({ ... });
     }
   }
   ```

   **Resources created:**

   a. **Docker Provider** (for this server):
   ```typescript
   const dockerProvider = new docker.Provider(`${name}-docker`, {
     host: args.dockerHost,
   }, { parent: this });
   ```

   b. **Internal Network** (`openclaw-internal`):
   ```typescript
   new docker.Network(`${name}-internal`, {
     name: "openclaw-internal",
     internal: true,
     ipamConfigs: [{ subnet: "172.28.0.0/24" }],
   }, { provider: dockerProvider, parent: this });
   ```

   c. **Egress Network** (`openclaw-egress`):
   ```typescript
   new docker.Network(`${name}-egress`, {
     name: "openclaw-egress",
   }, { provider: dockerProvider, parent: this });
   ```

   d. **Render Envoy config** from egress policy:
   ```typescript
   const { yaml: envoyYaml, warnings } = renderEnvoyConfig(args.egressPolicy);
   // Log warnings for phase-2 features
   ```

   e. **Upload envoy.yaml to server** via `command.remote.Command`:
   ```bash
   mkdir -p /opt/openclaw/envoy
   cat > /opt/openclaw/envoy/envoy.yaml << 'ENVOY_EOF'
   ${envoyYaml}
   ENVOY_EOF
   ```

   f. **Envoy Container:**
   ```typescript
   new docker.Container(`${name}-envoy`, {
     name: "envoy",
     image: "envoyproxy/envoy:v1.33-latest",
     restart: "unless-stopped",
     sysctls: { "net.ipv4.ip_unprivileged_port_start": "53" },
     networksAdvanced: [
       { name: internalNetwork.name, ipv4Address: "172.28.0.2" },
       { name: egressNetwork.name },
     ],
     volumes: [{
       hostPath: "/opt/openclaw/envoy/envoy.yaml",
       containerPath: "/etc/envoy/envoy.yaml",
       readOnly: true,
     }],
   }, { provider: dockerProvider, parent: this, dependsOn: [uploadConfig] });
   ```

   **Note:** No port publishing for Envoy. Egress listener (:10000) is internal-only (iptables DNAT from gateway). DNS listener (:53) is internal-only. No ingress listener anymore (Tailscale handles it).

   **Important Docker provider detail:** The `@pulumi/docker` provider connects to remote Docker daemons via `ssh://`. All Docker resources created with this provider execute on the remote server, not locally.

### Acceptance Criteria

```bash
npx tsc --noEmit
```

### Wrap Up

1. Update Progress Tracker: Task 7 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 8. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 7 is complete. Begin Task 8: Gateway component (OpenClaw instance)."

---

## Task 8: Gateway Component (OpenClaw Instance)

**Creates/modifies:** `components/gateway.ts`, `components/index.ts`
**Depends on:** Task 3 (templates/dockerfile.ts, templates/entrypoint.ts), Task 7 (EnvoyEgress for networks)

### Implementation Phase

Create the Gateway component — the most complex component. Each gateway is: Docker image build + container + config set commands + Tailscale Serve/Funnel on host.

1. **Create `components/gateway.ts`:**

   ```typescript
   import * as pulumi from "@pulumi/pulumi";
   import * as docker from "@pulumi/docker";
   import * as command from "@pulumi/command";
   import { GatewayConfig, TailscaleMode } from "../config";

   export interface GatewayArgs {
     dockerHost: pulumi.Input<string>;
     connection: pulumi.Input<{ host: string; user: string }>;
     internalNetworkId: pulumi.Input<string>;
     envoyIP: pulumi.Input<string>;
     profile: string;
     version: string;
     packages: string[];
     port: number;
     bridgePort?: number;
     tailscale: TailscaleMode;
     installBrowser?: boolean;
     configSet: Record<string, string>;
     env?: Record<string, string>;
     auth: { mode: string; token: pulumi.Input<string> };
   }

   export class Gateway extends pulumi.ComponentResource {
     public readonly containerId: pulumi.Output<string>;
     public readonly tailscaleUrl: pulumi.Output<string>;

     constructor(name: string, args: GatewayArgs, opts?: pulumi.ComponentResourceOptions) {
       super("openclaw:app:Gateway", name, {}, opts);
       // ... create resources
       this.registerOutputs({ ... });
     }
   }
   ```

   **Resources created (in dependency order):**

   a. **Upload Dockerfile + entrypoint.sh to server:**
   ```typescript
   // Render templates
   const dockerfile = renderDockerfile({
     version: args.version,
     packages: args.packages,
     installBrowser: args.installBrowser ?? false,
   });
   const entrypoint = renderEntrypoint();

   // Upload via command.remote
   const uploadBuildContext = new command.remote.Command(`${name}-upload-build`, {
     connection: args.connection,
     create: pulumi.interpolate`
       mkdir -p /opt/openclaw/build/${args.profile}
       cat > /opt/openclaw/build/${args.profile}/Dockerfile << 'DOCKERFILE_EOF'
       ${dockerfile}
       DOCKERFILE_EOF
       cat > /opt/openclaw/build/${args.profile}/entrypoint.sh << 'ENTRYPOINT_EOF'
       ${entrypoint}
       ENTRYPOINT_EOF
       chmod 755 /opt/openclaw/build/${args.profile}/entrypoint.sh
     `,
   }, { parent: this });
   ```

   b. **Build Docker image:**
   ```typescript
   const image = new docker.Image(`${name}-image`, {
     imageName: `openclaw-gateway-${args.profile}:${args.version}`,
     build: {
       context: `/opt/openclaw/build/${args.profile}`,
       dockerfile: `/opt/openclaw/build/${args.profile}/Dockerfile`,
     },
     skipPush: true,  // local build only, no registry
   }, { provider: dockerProvider, parent: this, dependsOn: [uploadBuildContext] });
   ```

   c. **Create host directories:**
   ```typescript
   new command.remote.Command(`${name}-dirs`, {
     connection: args.connection,
     create: `mkdir -p /opt/openclaw/data/${args.profile}/{config,workspace,config/identity}`,
   }, { parent: this });
   ```

   d. **Create container:**
   ```typescript
   const container = new docker.Container(`${name}-container`, {
     name: `openclaw-gateway-${args.profile}`,
     image: image.imageName,
     restart: "unless-stopped",
     capabilities: { adds: ["NET_ADMIN"] },
     dns: ["172.28.0.2"],
     envs: [
       `HOME=/home/node`,
       `TERM=xterm-256color`,
       `ENVOY_IP=${args.envoyIP}`,  // used by entrypoint.sh if needed
       ...Object.entries(args.env ?? {}).map(([k, v]) => `${k}=${v}`),
     ],
     command: ["openclaw", "gateway", "--bind", "lan", "--port", `${args.port}`],
     volumes: [
       { hostPath: `/opt/openclaw/data/${args.profile}/config`, containerPath: "/home/node/.openclaw" },
       { hostPath: `/opt/openclaw/data/${args.profile}/workspace`, containerPath: "/home/node/.openclaw/workspace" },
     ],
     networksAdvanced: [
       { name: "openclaw-internal" },
     ],
   }, { provider: dockerProvider, parent: this, dependsOn: [createDirs] });
   ```

   e. **Run `openclaw config set` commands (one resource per key):**
   ```typescript
   // Always-required config
   const requiredConfig: Record<string, string> = {
     "gateway.mode": "local",
     "gateway.auth.mode": args.auth.mode,
     "gateway.auth.token": args.auth.token,  // resolved from pulumi secret
     "gateway.trustedProxies": '["172.16.0.0/12","10.0.0.0/8","192.168.0.0/16"]',
     "discovery.mdns.mode": "off",
     ...args.configSet,  // user overrides
   };

   // Create one command per config key (tracked individually by Pulumi)
   for (const [key, value] of Object.entries(requiredConfig)) {
     new command.remote.Command(`${name}-config-${key.replace(/\./g, "-")}`, {
       connection: args.connection,
       create: `docker exec ${container.name} openclaw config set ${key} '${value}'`,
     }, { parent: this, dependsOn: [container] });
   }
   ```

   f. **Configure Tailscale on host:**
   ```typescript
   if (args.tailscale !== "off") {
     const tsCmd = args.tailscale === "serve"
       ? `tailscale serve --bg https+insecure://localhost:${args.port}`
       : `tailscale funnel --bg https+insecure://localhost:${args.port}`;

     new command.remote.Command(`${name}-tailscale`, {
       connection: args.connection,
       create: tsCmd,
       // delete: cleanup tailscale serve/funnel on destroy
     }, { parent: this, dependsOn: [container] });
   }
   ```

2. **Create `components/index.ts`** — barrel export of all components:
   ```typescript
   export { Server, ServerArgs } from "./server";
   export { HostBootstrap, HostBootstrapArgs } from "./bootstrap";
   export { EnvoyEgress, EnvoyEgressArgs } from "./envoy";
   export { Gateway, GatewayArgs } from "./gateway";
   ```

### Acceptance Criteria

```bash
npx tsc --noEmit
```

### Wrap Up

1. Update Progress Tracker: Task 8 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 9. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 8 is complete. Begin Task 9: Stack composition & example config."

---

## Task 9: Stack Composition & Example Config

**Creates/modifies:** `index.ts`, `Pulumi.dev.yaml`
**Depends on:** Tasks 5-8 (all components)

### Implementation Phase

Wire all components together in `index.ts` and create an example stack configuration.

1. **Write `index.ts`:**

   ```typescript
   import * as pulumi from "@pulumi/pulumi";
   import { Server, HostBootstrap, EnvoyEgress, Gateway } from "./components";
   import { StackConfig, EgressRule, GatewayConfig } from "./config";

   // Read Pulumi config
   const config = new pulumi.Config();

   // VPS config
   const provider = config.require("provider") as StackConfig["provider"];
   const serverType = config.require("serverType");
   const region = config.require("region");
   const sshKeyId = config.require("sshKeyId");

   // Tailscale
   const tailscaleAuthKey = config.requireSecret("tailscaleAuthKey");

   // Egress policy (JSON array in config)
   const egressPolicy = config.requireObject<EgressRule[]>("egressPolicy");

   // Gateways (JSON array in config)
   const gateways = config.requireObject<GatewayConfig[]>("gateways");

   // --- Composition ---

   // 1. Provision VPS
   const server = new Server("server", {
     provider,
     serverType,
     region,
     sshKeyId,
   });

   // 2. Install Docker + Tailscale
   const bootstrap = new HostBootstrap("bootstrap", {
     connection: server.connection,
     tailscaleAuthKey,
   });

   // 3. Set up egress proxy
   const envoy = new EnvoyEgress("envoy", {
     dockerHost: bootstrap.dockerHost,
     egressPolicy,
     connection: server.connection,
   }, { dependsOn: [bootstrap] });

   // 4. Deploy gateways
   const gatewayInstances = gateways.map((gw, i) => {
     const token = config.requireSecret(`gatewayToken-${gw.profile}`);
     return new Gateway(`gateway-${gw.profile}`, {
       dockerHost: bootstrap.dockerHost,
       connection: server.connection,
       internalNetworkId: envoy.internalNetworkId,
       envoyIP: envoy.envoyIP,
       profile: gw.profile,
       version: gw.version,
       packages: gw.packages,
       port: gw.port,
       bridgePort: gw.bridgePort,
       tailscale: gw.tailscale,
       installBrowser: gw.installBrowser,
       configSet: gw.configSet,
       env: gw.env,
       auth: { mode: "token", token },
     }, { dependsOn: [envoy] });
   });

   // --- Exports ---
   export const serverIp = server.ipAddress;
   export const tailscaleIp = bootstrap.tailscaleIP;
   export const envoyIp = envoy.envoyIP;
   export const gatewayUrls = gatewayInstances.map(g => g.tailscaleUrl);
   ```

2. **Create example `Pulumi.dev.yaml`** (with placeholder values, committed as reference):
   ```yaml
   config:
     openclaw-deploy:provider: hetzner
     openclaw-deploy:serverType: cx22
     openclaw-deploy:region: fsn1
     openclaw-deploy:sshKeyId: "12345"
     openclaw-deploy:tailscaleAuthKey:
       secure: <run pulumi config set --secret>
     openclaw-deploy:egressPolicy:
       - dst: "api.anthropic.com"
         proto: tls
         action: allow
       - dst: "discord.com"
         proto: tls
         action: allow
       - dst: "gateway.discord.gg"
         proto: tls
         action: allow
     openclaw-deploy:gateways:
       - profile: personal
         version: latest
         packages: ["ffmpeg", "imagemagick"]
         port: 18789
         tailscale: serve
         configSet:
           gateway.controlUi.allowedOrigins: '["https://localhost"]'
       - profile: automation
         version: latest
         packages: []
         port: 18790
         tailscale: funnel
         configSet: {}
     openclaw-deploy:gatewayToken-personal:
       secure: <run pulumi config set --secret>
     openclaw-deploy:gatewayToken-automation:
       secure: <run pulumi config set --secret>
   ```

3. **Add inline comments in `index.ts`** explaining the composition flow and how to customize.

### Acceptance Criteria

```bash
npx tsc --noEmit

# Verify Pulumi can parse the program (requires Pulumi CLI installed)
# This validates the program structure without creating real resources
pulumi preview --stack dev --non-interactive 2>&1 | head -20 || echo "Pulumi CLI not installed — skip preview"
```

### Wrap Up

1. Update Progress Tracker: Task 9 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 10. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 9 is complete. Begin Task 10: Documentation overhaul."

---

## Task 10: Documentation Overhaul

**Creates/modifies:** `AGENTS.md`, `CLAUDE.md`, `.claude/rules/*`, `.serena/project.yml`, `MEMORY.md`
**Deletes:** Old `.claude/rules/go-files.md`, `.claude/rules/go-test-files.md`, `.claude/rules/config-files.md` (content merged/rewritten)
**Depends on:** Tasks 1-9

### Implementation Phase

Rewrite all project documentation for the new TypeScript Pulumi architecture.

1. **Rewrite `AGENTS.md`** — Primary project guidance document:
   - Update repository overview: Pulumi TypeScript IaC for OpenClaw fleet deployment
   - Update project structure (components/, templates/, config/, tests/)
   - Document component hierarchy: Server → HostBootstrap → EnvoyEgress → Gateway
   - Document egress security model (five layers, carried over)
   - Document Tailscale networking model
   - Document egress policy engine and rule types
   - Document stack configuration (Pulumi config)
   - Update validation expectations: `npx tsc --noEmit`, `npx vitest run`, `pulumi preview`
   - Update contribution guidelines for TypeScript
   - Keep threat model & egress security section (update for new architecture)
   - Remove all Go-specific content
   - Remove Docker Compose references (replaced by raw Docker provider)
   - Remove setup.sh references (replaced by Pulumi Command)
   - Remove CLI wrapper references (replaced by Tailscale)
   - Remove ingress listener references (replaced by Tailscale)

2. **Rewrite `.claude/rules/`:**
   - Delete `go-files.md`, `go-test-files.md`, `config-files.md`
   - Keep `docker-and-shell.md` but update:
     - Remove Compose conventions section
     - Remove setup.sh section
     - Remove CLI wrapper section
     - Remove ingress listener from Envoy section
     - Update generated artifacts list (no compose.yaml, no .env.openclaw, no setup.sh, no CLI wrapper, no TLS certs)
     - Keep Dockerfile conventions, entrypoint security model, envoy egress conventions
   - Create `typescript-files.md`:
     - Build & verify: `npx tsc --noEmit`, `npx vitest run`
     - Module layout: components/, templates/, config/, tests/
     - Pulumi conventions: ComponentResource subclasses, Input/Output types, registerOutputs()
     - Template conventions: pure functions returning strings, no side effects
     - Config conventions: types.ts for interfaces, domains.ts for hardcoded rules, defaults.ts for constants
   - Create `pulumi-config.md`:
     - Stack config format and how to read values
     - Secret handling
     - Component argument patterns

3. **Update `CLAUDE.md`** — Keep delegation to `AGENTS.md`

4. **Update `.serena/project.yml`** — Languages: `bash, typescript`

5. **Update Serena memory `MEMORY.md`** — Reflect completed migration state

6. **Update Serena memory `roadmap`** — Mark IaC migration as in-progress, update future plans

### Acceptance Criteria

```bash
# All referenced files exist
test -f AGENTS.md
test -f CLAUDE.md
test -f .claude/rules/docker-and-shell.md
test -f .claude/rules/typescript-files.md
test -f .claude/rules/pulumi-config.md

# Old Go rules removed
test ! -f .claude/rules/go-files.md
test ! -f .claude/rules/go-test-files.md
test ! -f .claude/rules/config-files.md
```

### Wrap Up

1. Update Progress Tracker: Task 10 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 11. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the IaC Migration initiative. Read the Serena memory `initiative-iac-migration` — Task 10 is complete. Begin Task 11: Testing infrastructure & CI."

---

## Task 11: Testing Infrastructure & CI

**Creates/modifies:** `tests/templates.test.ts` (expand), `tests/envoy.test.ts` (expand), `tests/config.test.ts` (expand), `tests/components.test.ts`, `vitest.config.ts`, `.pre-commit-config.yaml`
**Depends on:** Tasks 1-10

### Implementation Phase

Set up comprehensive testing and CI hooks for the new TypeScript project.

1. **Create `vitest.config.ts`:**
   ```typescript
   import { defineConfig } from "vitest/config";
   export default defineConfig({
     test: {
       include: ["tests/**/*.test.ts"],
       globals: true,
     },
   });
   ```

2. **Expand template tests (`tests/templates.test.ts`):**
   Tests written in Task 3 should already cover Dockerfile and entrypoint. Add:
   - Idempotency: calling renderDockerfile twice with same args produces identical output
   - Different packages produce different Dockerfiles
   - Different versions produce different Dockerfiles
   - Empty packages list produces valid Dockerfile (no trailing spaces in apt-get)
   - Very long package lists don't break formatting

3. **Expand envoy tests (`tests/envoy.test.ts`):**
   Tests written in Task 4 should already cover core cases. Add:
   - Large number of domains (50+) produces valid config
   - Domains with special characters handled correctly
   - Empty user policy (only hardcoded) produces valid config
   - YAML output can be parsed by js-yaml without errors

4. **Create `tests/components.test.ts`** — Pulumi unit tests with mocks:
   ```typescript
   import * as pulumi from "@pulumi/pulumi";
   import { Server } from "../components/server";

   // Pulumi unit testing with mocks
   // See: https://www.pulumi.com/docs/using-pulumi/testing/unit/
   pulumi.runtime.setMocks({
     newResource: (args) => ({ id: `${args.name}-id`, state: args.inputs }),
     call: (args) => args.inputs,
   });

   describe("Server component", () => {
     it("creates a Hetzner server", async () => {
       const server = new Server("test", {
         provider: "hetzner",
         serverType: "cx22",
         region: "fsn1",
         sshKeyId: "12345",
       });
       const ip = await new Promise<string>(resolve =>
         server.ipAddress.apply(resolve)
       );
       expect(ip).toBeDefined();
     });

     it("rejects unsupported providers", () => {
       expect(() => new Server("test", {
         provider: "aws" as any,
         ...
       })).toThrow();
     });
   });
   ```

5. **Create `.pre-commit-config.yaml`** for TypeScript:
   ```yaml
   repos:
     - repo: https://github.com/pre-commit/pre-commit-hooks
       rev: v5.0.0
       hooks:
         - id: trailing-whitespace
         - id: end-of-file-fixer
         - id: check-yaml
         - id: check-json

     - repo: https://github.com/gitleaks/gitleaks
       rev: v8.30.0
       hooks:
         - id: gitleaks

     - repo: local
       hooks:
         - id: typecheck
           name: TypeScript type check
           entry: npx tsc --noEmit
           language: system
           types: [typescript]
           pass_filenames: false

         - id: test
           name: Run tests
           entry: npx vitest run
           language: system
           types: [typescript]
           pass_filenames: false
   ```

6. **Update `package.json` scripts:**
   ```json
   {
     "scripts": {
       "build": "tsc",
       "test": "vitest run",
       "typecheck": "tsc --noEmit",
       "check": "npm run typecheck && npm run test"
     }
   }
   ```

### Acceptance Criteria

```bash
# All tests pass
npx vitest run

# TypeScript compiles
npx tsc --noEmit

# Combined check
npm run check

# Pre-commit config is valid YAML
python3 -c "import yaml; yaml.safe_load(open('.pre-commit-config.yaml'))"
```

### Wrap Up

1. Update Progress Tracker: Task 11 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Inform the user the initiative is complete and present this summary:

> **Initiative complete.** All 11 tasks finished. The openclaw-docker repo has been fully converted to openclaw-deploy — a Pulumi TypeScript IaC project for deploying OpenClaw fleets with protocol-aware egress security.
>
> **What's ready:**
> - Pulumi TypeScript project with four component resources (Server, HostBootstrap, EnvoyEgress, Gateway)
> - Template engine porting Dockerfile, entrypoint.sh, and Envoy config from original Go CLI
> - Egress policy engine with typed rules (domain/IP/CIDR × protocol × path allow/deny)
> - Hetzner VPS provisioning + Tailscale networking
> - Comprehensive test suite (template + config + component tests)
> - Updated documentation (AGENTS.md, CLAUDE.md, .claude/rules/)
>
> **What's next (Phase 2):**
> - MITM TLS inspection for path-level filtering
> - DNS snooping for SSH/FTP/raw TCP domain filtering
> - DigitalOcean and Oracle Cloud (ARM) provider support
> - Image registry integration for fleet-wide builds
> - End-to-end integration testing with real infrastructure
