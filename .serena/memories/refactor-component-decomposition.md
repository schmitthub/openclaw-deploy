# Pulumi Component Decomposition

**Branch:** `refactor/component-decomposition`
**Parent memory:** `brainstorm_pulumi-refactor-separation-of-concerns`

---

## Progress Tracker

| Task | Status | Agent |
|------|--------|-------|
| Task 1: Foundation + GatewayImage with docker-build | `complete` | — |
| Task 2: TailscaleSidecar component | `complete` | — |
| Task 3: EnvoyProxy component | `complete` | — |
| Task 4: GatewayInit component + secrets fix | `complete` | — |
| Task 5: Slim Gateway + final composition | `complete` | — |
| Task 6: Tests + documentation + validation | `complete` | — |

## Key Learnings

- **Task 1:** `docker-build.Provider` accepts `host` param just like `docker.Provider` — use `{ host: args.dockerHost }` for remote builds. `docker-build.Image` supports `dockerfile: { inline: content }` so no Dockerfile needs to be written to disk. Only `entrypoint.sh` (COPYed by Dockerfile) needs the temp dir context. Use stable temp dir path (not `mkdtempSync`) to avoid accumulating stale dirs. `imageName` is `Output<string>` — must use `pulumi.interpolate` when embedding in `command.remote.Command` create strings (plain template literals resolve to `[object Object]`). Pin `@pulumi/docker-build` exactly (pre-1.0 package). Mock `docker-build:index:Image` in tests to populate `tags` output.
- **Task 4:** Env var scanning via `extractReferencedVars()` — pure function checking if command strings contain `$VAR` or `${VAR}` references. Only hostname/token are selectively included in `create` strings; all `secretEnv` keys are always exported unconditionally. Named `pulumi.all({...})` object pattern avoids fragile positional array indexing. `contentHash` only covers setupCommand text — secret rotation triggers gateway container replacement via Docker provider detecting `computedEnvs` changes separately. Export/unset pattern: `export SECRET='val' && docker run -e SECRET && unset SECRET` — no env files on disk.
- **Task 3:** Clean extraction — envoy container + health wait moved without modification. Component-level `dependsOn: [sidecar]` in `index.ts` is sufficient for Docker ordering because `TailscaleSidecar` includes a health-wait command that must complete before outputs resolve. No need for explicit `dependsOn` on internal `docker.Container` resources. The `ENVOY_CA_CERT_PATH` volume mount on the gateway container is correctly retained (gateway needs `NODE_EXTRA_CA_CERTS` for MITM CA trust).
- **Task 5:** Gateway was already slim after Task 4 (213 lines). Main changes: added `--bind loopback` to match reference docker-compose, consolidated two separate `secretEnv` apply calls into one, removed `sysctls` (invalid on containers sharing another's netns via `network_mode: container:` — Docker either ignores or rejects; TCP keepalive tuning would need to be on the sidecar). Moved `RESERVED_ENV_KEYS` to module scope. Final: 165 lines. The index.ts 5-component pipeline was already wired correctly from Task 4.
- **Task 2:** Healthcheck must use `CMD-SHELL` with `||` fallback (`wget localhost || wget 127.0.0.1`) to match reference — `CMD` array format doesn't support shell `||`. Each component should own its own directory lifecycle (tailscale state dir in TailscaleSidecar, config/workspace dirs in Gateway). Don't pass fields that aren't used — `networkName` was dead code in Gateway since containers use `networkMode: container:` not `networksAdvanced`.

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

The `openclaw-deploy` Pulumi TypeScript project deploys OpenClaw gateway containers on remote VPS hosts with egress isolation via Envoy proxy and Tailscale networking. The current `Gateway` component is a 540-line monolith handling 10+ concerns in one constructor. This refactor decomposes it into focused components that **exactly replicate** the reference Docker Compose architecture in `reference/docker-compose.yml` and the procedural setup flow in `reference/setup.sh`.

### Constraints (NON-NEGOTIABLE)

The `reference/` directory is the **specification**, not a suggestion. Every service, dependency, ordering, and behavior must be replicated exactly in Pulumi.

1. **Service ordering is strict and sequential:**
   - Tailscale sidecar starts FIRST — authenticates, gets hostname
   - Envoy starts SECOND — requires sidecar's netns, gateway fails without working egress
   - Init containers run THIRD — sequential config commands against shared volumes, some need hostname
   - Gateway starts LAST — only after all init steps complete

2. **Every service is a first-class citizen.** No combining services into one component. Each gets its own ComponentResource with its own lifecycle, state tracking, and outputs.

3. **Init containers run before the gateway, not exec into it.** Config must be written to shared volumes via ephemeral `docker run --rm --network none` containers before the gateway container starts. This prevents crash-loops from missing config. You cannot use `docker exec` because the gateway isn't running yet.

4. **Init steps declare dependencies via env var references.** If a setupCommand string references `$TAILSCALE_SERVE_HOST` or `${TAILSCALE_SERVE_HOST}`, the system detects this, injects the Pulumi output value, and Pulumi automatically re-runs that step when the hostname changes. Steps without hostname references are stable — they only re-run if their own command string changes.

5. **Secrets never persist on disk.** No env files. Use `export SECRET='val' && docker run -e SECRET && unset SECRET` for init containers. Secrets exist only in the SSH session's env and the ephemeral container's env — both disappear after execution.

6. **Dependency cascade must be tracked.** If the Tailscale sidecar is recreated (new hostname), only hostname-dependent init steps re-run, then the gateway restarts. Hostname-independent init steps do NOT re-run. This works because:
   - Hostname is interpolated into command strings only for steps that reference it
   - Pulumi detects the string diff and re-runs only those commands
   - Gateway depends on all init step outputs

7. **`@pulumi/docker-build` for image builds.** Use BuildKit via `docker-build.Image` resource — NOT `command.remote.Command` running `docker build` over SSH. Build context is a local temp directory (templates rendered at plan time), BuildKit transfers to remote Docker daemon via DOCKER_HOST=ssh://. No base64 file uploads. Content-aware caching is built-in.

8. **`@pulumi/docker` for everything else.** Containers, networks, volumes use the standard Docker provider connected to the remote host.

### Architecture: Before → After

**Before (current):** One `Gateway` ComponentResource owns everything.

```
Server → HostBootstrap → EnvoyEgress (config only) → Gateway (MONOLITH)
```

**After (target):** Five focused components per gateway, plus shared EnvoyEgress.

```
Server → HostBootstrap → EnvoyEgress (shared config + certs, unchanged)
                            ↘
                          Per gateway:
                            GatewayImage ──→ TailscaleSidecar ──→ EnvoyProxy ──→ GatewayInit ──→ Gateway
                            (build)          (netns + auth)        (egress)       (config)        (container)
```

### Component Responsibilities

| Component | Type URN | Provider | Resources | Key Outputs |
|-----------|----------|----------|-----------|-------------|
| `GatewayImage` | `openclaw:build:GatewayImage` | `@pulumi/docker-build` | Image | `imageName`, `imageRef` |
| `TailscaleSidecar` | `openclaw:net:TailscaleSidecar` | `@pulumi/docker` + `@pulumi/command` | bridgeNetwork, sidecarContainer, healthWait | `containerName`, `tailscaleHostname`, `networkName` |
| `EnvoyProxy` | `openclaw:net:EnvoyProxy` | `@pulumi/docker` + `@pulumi/command` | envoyContainer, healthWait | `envoyReady` |
| `GatewayInit` | `openclaw:app:GatewayInit` | `@pulumi/command` | createDirs, N × setupCommand | `initComplete` |
| `Gateway` | `openclaw:app:Gateway` | `@pulumi/docker` | homeVolume, linuxbrewVolume, gatewayContainer | `containerId`, `tailscaleUrl` |

### Design Decisions

1. **Secrets via shell env, not files.** `export && docker run -e && unset`. No `.init-env` file.
2. **EnvoyEgress stays as-is** (shared config + certs). Envoy *container* is a separate `EnvoyProxy` component.
3. **Each component creates its own `docker.Provider`** from `dockerHost` arg (where needed).
4. **Health waits internal to each component.** Outputs only available after health confirmed. Container ID used as trigger.
5. **`@pulumi/docker-build`** for image builds. Local temp dir context, remote Docker daemon via SSH.
6. **Env var scanning** determines init step dependencies. No manual annotations (for now — may add explicit `needs` in YAML config later if OpenClaw changes require it).
7. **`buildDir(profile)` and `dataDir(profile)` helpers** in `config/defaults.ts`.

### Key Files

- `components/gateway.ts` — current monolith (to be decomposed)
- `components/envoy.ts` — EnvoyEgress (stays as-is)
- `components/server.ts`, `components/bootstrap.ts` — unchanged
- `components/index.ts` — re-exports (update with new components)
- `index.ts` — stack composition (rewrite per-gateway wiring)
- `config/defaults.ts` — constants (add path helpers)
- `config/types.ts` — type definitions
- `templates/` — pure rendering functions (unchanged)
- `tests/components.test.ts` — component tests
- `reference/docker-compose.yml` — THE specification for Docker service topology
- `reference/setup.sh` — THE specification for setup flow and ordering
- `reference/Dockerfile` — THE specification for the gateway image
- `reference/sidecar-entrypoint.sh` — THE specification for sidecar behavior
- `reference/entrypoint.sh` — THE specification for gateway entrypoint
- `reference/envoy.yaml` — THE specification for envoy config structure

### Gotchas

- **Pulumi state migration:** Moving resources between components changes URNs. First `pulumi up` after refactor destroys+recreates containers (brief downtime). Acceptable for dev/staging.
- **Remote Docker build context:** `@pulumi/docker-build` needs DOCKER_HOST=ssh://root@ip. The Docker provider and docker-build provider must both target the remote host. Templates are rendered to a local temp dir — ensure cleanup.
- **Health wait staleness:** Must use container ID as trigger. Without this, cached hostname goes stale on sidecar recreation.
- **Sidecar files still need uploading:** sidecar-entrypoint.sh and serve-config.json must be on the remote host (bind-mounted into sidecar). These are uploaded via `command.remote.Command`, not docker-build.

### Rules

- Read `CLAUDE.md`, `.claude/rules/` files before starting each task
- Use Serena tools for code exploration — read symbol bodies only when needed
- All new code must compile (`npx tsc --noEmit`) and tests must pass (`npx vitest run`)
- Follow existing Pulumi component patterns (ComponentResource, registerOutputs, parent/dependency)
- Never weaken the egress isolation model (see AGENTS.md Threat Model)
- Templates remain pure functions — no changes to `templates/` directory
- Match the reference stack EXACTLY in behavior, ordering, env vars, healthchecks, volumes

---

## Task 1: Foundation + GatewayImage with @pulumi/docker-build

**Creates:** `components/gateway-image.ts`
**Modifies:** `components/gateway.ts`, `components/index.ts`, `config/defaults.ts`, `index.ts`, `package.json`
**Depends on:** Nothing (first task)

### Implementation Phase

#### Step 1: Install `@pulumi/docker-build`

```bash
npm install @pulumi/docker-build
```

#### Step 2: Add path helper functions to `config/defaults.ts`

```typescript
export const buildDir = (profile: string) => `/opt/openclaw-deploy/build/${profile}`;
export const dataDir = (profile: string) => `/opt/openclaw-deploy/data/${profile}`;
```

#### Step 3: Create `components/gateway-image.ts`

Create `GatewayImage` ComponentResource with type URN `openclaw:build:GatewayImage`.

**Interface:**
```typescript
interface GatewayImageArgs {
  dockerHost: pulumi.Input<string>;  // ssh://root@<ip> for remote builds
  profile: string;
  version: string;
  installBrowser?: boolean;
  imageSteps?: ImageStep[];
}
```

**Constructor logic:**

1. Call `renderDockerfile()` and `renderEntrypoint()` — template rendering at plan time.

2. Write rendered files to a local temp directory:
   ```typescript
   import * as fs from "fs";
   import * as os from "os";
   import * as path from "path";
   
   const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-build-${args.profile}-`));
   fs.writeFileSync(path.join(tempDir, "Dockerfile"), dockerfile);
   fs.writeFileSync(path.join(tempDir, "entrypoint.sh"), entrypoint, { mode: 0o755 });
   ```

3. Create `docker_build.Image` resource:
   ```typescript
   import * as docker_build from "@pulumi/docker-build";
   
   const image = new docker_build.Image(`${name}-image`, {
     tags: [`openclaw-gateway-${args.profile}:${args.version}`],
     context: { location: tempDir },
     dockerfile: { location: path.join(tempDir, "Dockerfile") },
     push: false,  // local image only, no registry
     // BuildKit handles content-aware caching — no manual hash needed
   }, { parent: this });
   ```

   Note: The `docker-build` provider needs to target the remote Docker daemon. This is handled by setting `DOCKER_HOST` on the provider or via the buildx builder config. Research the exact mechanism — it may require creating a buildx builder that points to the remote host. If `docker-build.Image` doesn't directly support `host` like `docker.Provider`, the alternative is to set the `DOCKER_HOST` environment variable or use a `docker-build.Provider` if one exists.

4. Output `imageName` (the tag string) and `imageRef` (from `image.ref`).

5. Call `registerOutputs()`.

**IMPORTANT:** Investigate how `@pulumi/docker-build` targets remote Docker hosts. The `@pulumi/docker` provider uses `new docker.Provider("p", { host: "ssh://..." })`. The `docker-build` provider may use a different mechanism (buildx context, DOCKER_HOST env, or its own provider config). The implementing agent MUST verify this works with remote hosts before proceeding.

#### Step 4: Update `GatewayArgs` in `components/gateway.ts`

- **Add:** `imageName: pulumi.Input<string>`
- **Remove:** `version`, `installBrowser`, `imageSteps`
- Keep all other args (removed in later tasks)

#### Step 5: Update `Gateway` constructor

- Remove: `renderDockerfile`, `renderEntrypoint` calls and encoding
- Remove: `uploadBuildContext`, `buildImage` resources
- Remove: `buildContextHash` computation
- Use `args.imageName` wherever `imageName` was locally computed
- The sidecar file upload stays in Gateway for now (moved in Task 2)

#### Step 6: Update `components/index.ts`

Add: `export { GatewayImage } from "./gateway-image";`

#### Step 7: Update `index.ts`

Per-gateway loop:
```typescript
const image = new GatewayImage(`gateway-image-${gw.profile}`, {
  dockerHost: bootstrap.dockerHost,
  profile: gw.profile,
  version: gw.version,
  installBrowser: gw.installBrowser,
  imageSteps: gw.imageSteps,
}, { dependsOn: [bootstrap] });
```

Pass `image.imageName` to Gateway. Remove `version`/`installBrowser`/`imageSteps` from Gateway args.

#### Step 8: Update tests

- Add test for `GatewayImage`
- Update Gateway test for new args

### Acceptance Criteria

```bash
npx tsc --noEmit
npx vitest run
# Verify: @pulumi/docker-build is in package.json dependencies
# Verify: No base64 encoding or command.remote.Command for image builds in any component
# Verify: Gateway constructor no longer renders templates or builds images
```

### Wrap Up

1. Update Progress Tracker: Task 1 → `complete`
2. Append key learnings (especially: how docker-build targets remote hosts)
3. Code review subagent, fix findings
4. Commit: `refactor: extract GatewayImage component with @pulumi/docker-build`
5. **STOP.** Handoff prompt:

> "Continue the component decomposition initiative. Read the Serena memory `refactor-component-decomposition` — Task 1 is complete. Begin Task 2: TailscaleSidecar component."

---

## Task 2: TailscaleSidecar Component

**Creates:** `components/tailscale-sidecar.ts`
**Modifies:** `components/gateway.ts`, `components/index.ts`, `index.ts`
**Depends on:** Task 1

### Implementation Phase

#### Step 1: Read the reference files

Read `reference/docker-compose.yml` (tailscale-sidecar service) and `reference/sidecar-entrypoint.sh`. These are the spec. Match exactly.

#### Step 2: Create `components/tailscale-sidecar.ts`

Create `TailscaleSidecar` ComponentResource with type URN `openclaw:net:TailscaleSidecar`.

**Interface:**
```typescript
interface TailscaleSidecarArgs {
  connection: types.input.remote.ConnectionArgs;
  dockerHost: pulumi.Input<string>;
  profile: string;
  port: number;                                    // gateway port (for serve config rendering)
  tailscaleAuthKey: pulumi.Input<string>;
  tcpPortMappings?: TcpPortMapping[];              // from EnvoyEgress (for OPENCLAW_TCP_MAPPINGS)
}
```

**Constructor logic — must match reference docker-compose.yml `tailscale-sidecar` service:**

1. **Docker provider** from `dockerHost`.

2. **Render sidecar files** at plan time:
   - `renderSidecarEntrypoint()` → sidecar-entrypoint.sh
   - `renderServeConfig(args.port, SSHD_PORT)` → serve-config.json

3. **Upload sidecar files** to remote host via `command.remote.Command`:
   - `mkdir -p ${buildDir(args.profile)}`
   - Base64-decode sidecar-entrypoint.sh + serve-config.json
   - `chmod 755 sidecar-entrypoint.sh`
   - Embed content hash in command string for change detection

4. **Bridge network** — `docker.Network`:
   - Name: `openclaw-net-${profile}`
   - Driver: `bridge`
   - **NOT** `internal: true` (sidecar needs internet for Envoy upstreams)

5. **Sidecar container** — `docker.Container`:
   Match reference `tailscale-sidecar` service EXACTLY:
   - Image: `tailscale/tailscale:v1.94.2` (from `TAILSCALE_IMAGE` constant)
   - Hostname: `openclaw` (reference) or `${profile}` — check reference
   - `capabilities.adds: [NET_ADMIN]`
   - Devices: `/dev/net/tun`
   - DNS: `[1.1.1.2, 1.0.0.2]` (Cloudflare malware-blocking)
   - Env vars: `TS_AUTHKEY`, `TS_STATE_DIR=/var/lib/tailscale`, `TS_USERSPACE=false`, `TS_SERVE_CONFIG=/config/serve-config.json`, `TS_ENABLE_HEALTH_CHECK=true`, `ENVOY_UID=101`, `OPENCLAW_TCP_MAPPINGS` (if tcpPortMappings present)
   - Entrypoint: `[sidecar-entrypoint.sh]` (path on remote host)
   - Volumes: tailscale state dir, sidecar-entrypoint.sh (ro), serve-config.json (ro)
   - `networksAdvanced: [{ name: bridgeNetwork.name }]`
   - Healthcheck: `wget -q --spider http://localhost:9002/healthz || wget -q --spider http://127.0.0.1:9002/healthz` (match reference exactly)
   - Restart: `unless-stopped`
   - Labels: `openclaw.sidecar-hash` (content hash for replacement)
   - `dependsOn: [uploadSidecarFiles, bridgeNetwork]`

6. **Health wait + hostname capture** — `command.remote.Command`:
   - Wait for Docker healthcheck to report healthy
   - Wait for Tailscale to reach `Running` state
   - Capture hostname: `tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//'`
   - `triggers: [sidecarContainer.id]` — CRITICAL: re-runs on container recreation

**Outputs:**
```typescript
containerName: string;                    // e.g. "tailscale-dev" — for network_mode
tailscaleHostname: pulumi.Output<string>; // e.g. "openclaw.tail1234.ts.net"
networkName: pulumi.Output<string>;       // bridge network name
```

#### Step 3: Update `GatewayArgs`

- **Add:** `sidecarContainerName: pulumi.Input<string>`, `tailscaleHostname: pulumi.Input<string>`, `networkName: pulumi.Input<string>`
- **Remove:** `tailscaleAuthKey`, `tcpPortMappings`

#### Step 4: Update `Gateway` constructor

Remove:
- Sidecar file rendering + encoding + upload
- Bridge network creation
- Sidecar container creation + all env var assembly
- Sidecar health wait + hostname capture
- Use `args.sidecarContainerName` for gateway container's `networkMode`

#### Step 5: Update `index.ts`

```typescript
const sidecar = new TailscaleSidecar(`gateway-ts-${gw.profile}`, {
  connection: server.connection,
  dockerHost: bootstrap.dockerHost,
  profile: gw.profile,
  port: gw.port,
  tailscaleAuthKey,
  tcpPortMappings: envoy.tcpPortMappings,
}, { dependsOn: [bootstrap] });
```

Pass `sidecar.containerName`, `sidecar.tailscaleHostname`, `sidecar.networkName` to downstream components.

#### Step 6: Update tests

### Acceptance Criteria

```bash
npx tsc --noEmit
npx vitest run
# Verify: Gateway constructor no longer contains sidecar or network code
# Verify: TailscaleSidecar matches reference docker-compose tailscale-sidecar service
# Verify: Healthcheck matches reference exactly
```

### Wrap Up

1. Update Progress Tracker: Task 2 → `complete`
2. Append key learnings
3. Code review subagent, fix findings
4. Commit: `refactor: extract TailscaleSidecar component`
5. **STOP.** Handoff prompt:

> "Continue the component decomposition initiative. Read the Serena memory `refactor-component-decomposition` — Task 2 is complete. Begin Task 3: EnvoyProxy component."

---

## Task 3: EnvoyProxy Component

**Creates:** `components/envoy-proxy.ts`
**Modifies:** `components/gateway.ts`, `components/index.ts`, `index.ts`
**Depends on:** Task 2

### Implementation Phase

#### Step 1: Read the reference

Read `reference/docker-compose.yml` (envoy service). This is the spec.

#### Step 2: Create `components/envoy-proxy.ts`

Create `EnvoyProxy` ComponentResource with type URN `openclaw:net:EnvoyProxy`.

**Interface:**
```typescript
interface EnvoyProxyArgs {
  connection: types.input.remote.ConnectionArgs;
  dockerHost: pulumi.Input<string>;
  sidecarContainerName: pulumi.Input<string>;  // for network_mode
  envoyConfigPath: pulumi.Input<string>;       // from EnvoyEgress
  envoyConfigHash: string;                     // from EnvoyEgress
  inspectedDomains: string[];                  // from EnvoyEgress (for MITM cert volumes)
}
```

**Constructor logic — must match reference docker-compose.yml `envoy` service:**

1. **Docker provider** from `dockerHost`.

2. **Envoy container** — `docker.Container`:
   - Image: `envoyproxy/envoy:v1.33-latest` (from `ENVOY_IMAGE` constant)
   - `networkMode: container:${sidecarContainerName}` (shares sidecar's netns)
   - Env: `ENVOY_UID=101`
   - Healthcheck: `["CMD", "bash", "-c", "echo > /dev/tcp/localhost/10000"]` — match reference exactly
   - Volumes: envoy.yaml (ro), CA cert (ro), MITM certs (conditional, ro)
   - Labels: `openclaw.config-hash` (triggers replacement on config change)
   - Restart: `unless-stopped`
   - No `networksAdvanced` (uses container network mode)
   - No `dns` (inherited from sidecar)

3. **Health wait** — `command.remote.Command`:
   - Poll `docker inspect --format='{{.State.Health.Status}}'` for `healthy`
   - `triggers: [envoyContainer.id]` — re-runs on container recreation

**Outputs:**
```typescript
envoyReady: pulumi.Output<string>;  // signal for downstream dependencies
```

#### Step 3: Update `GatewayArgs`

- **Remove:** `envoyConfigPath`, `envoyConfigHash`, `inspectedDomains`

#### Step 4: Update `Gateway` constructor

Remove:
- Envoy container creation + volume assembly
- Envoy health wait
- Gateway container no longer depends on `envoyHealthy` (it depends on EnvoyProxy via index.ts)

#### Step 5: Update `index.ts`

```typescript
const envoyProxy = new EnvoyProxy(`gateway-envoy-${gw.profile}`, {
  connection: server.connection,
  dockerHost: bootstrap.dockerHost,
  sidecarContainerName: sidecar.containerName,
  envoyConfigPath: envoy.envoyConfigPath,
  envoyConfigHash: envoy.configHash,
  inspectedDomains: envoy.inspectedDomains,
}, { dependsOn: [sidecar] });
```

#### Step 6: Update tests

### Acceptance Criteria

```bash
npx tsc --noEmit
npx vitest run
# Verify: Gateway constructor no longer contains envoy container or health wait
# Verify: EnvoyProxy matches reference docker-compose envoy service
# Verify: EnvoyProxy depends on sidecar (not created until sidecar is healthy)
```

### Wrap Up

1. Update Progress Tracker: Task 3 → `complete`
2. Append key learnings
3. Code review subagent, fix findings
4. Commit: `refactor: extract EnvoyProxy component`
5. **STOP.** Handoff prompt:

> "Continue the component decomposition initiative. Read the Serena memory `refactor-component-decomposition` — Task 3 is complete. Begin Task 4: GatewayInit component + secrets fix."

---

## Task 4: GatewayInit Component + Secrets Fix

**Creates:** `components/gateway-init.ts`
**Modifies:** `components/gateway.ts`, `components/index.ts`, `index.ts`
**Depends on:** Task 3

### Implementation Phase

#### Step 1: Read the reference

Read `reference/setup.sh` lines 76-176. These are the init steps. Note how:
- `onboard` runs first (may or may not reference `$TAILSCALE_SERVE_HOST` depending on deployment)
- `config set` commands run sequentially
- Some reference `$TAILSCALE_SERVE_HOST`, most don't
- All use `docker compose run --rm openclaw-cli` (our equivalent: `docker run --rm --network none`)

#### Step 2: Create `components/gateway-init.ts`

Create `GatewayInit` ComponentResource with type URN `openclaw:app:GatewayInit`.

**Interface:**
```typescript
interface GatewayInitArgs {
  connection: types.input.remote.ConnectionArgs;
  profile: string;
  imageName: pulumi.Input<string>;
  setupCommands?: string[];                     // raw command strings, may contain $VAR references
  secretEnv?: pulumi.Input<string>;             // JSON {"KEY":"value",...}
  gatewayToken: pulumi.Input<string>;
  tailscaleHostname: pulumi.Input<string>;      // from TailscaleSidecar
}
```

**Constructor logic:**

1. **Create data directories** — `command.remote.Command`:
   ```
   mkdir -p ${dataDir}/{config,workspace,config/identity,config/agents/main/agent,config/agents/main/sessions,tailscale}
   && chown -R 1000:1000 ${dataDir}/config ${dataDir}/workspace
   ```

2. **Build the known variables map** — available for env var scanning:
   ```typescript
   // Known variables and their Pulumi output values
   const knownVars: Record<string, pulumi.Input<string>> = {
     TAILSCALE_SERVE_HOST: args.tailscaleHostname,
     OPENCLAW_GATEWAY_TOKEN: args.gatewayToken,
   };
   // Add all secretEnv keys to knownVars
   // (parsed from JSON at plan time via pulumi.output().apply())
   ```

3. **For each setupCommand, scan for env var references:**

   ```typescript
   function extractReferencedVars(cmd: string, availableVars: string[]): string[] {
     return availableVars.filter(v =>
       cmd.includes(`$${v}`) || cmd.includes(`\${${v}}`)
     );
   }
   ```

4. **Generate per-command `command.remote.Command` resources:**

   For each setupCommand:
   a. Scan for referenced variables
   b. Build the command using `pulumi.all()` to resolve only referenced Pulumi outputs:
   ```
   export TAILSCALE_SERVE_HOST='<resolved-value>' && \
   docker run --rm --network none --user node \
     --entrypoint /bin/sh \
     -e TAILSCALE_SERVE_HOST \
     -v openclaw-home-${profile}:/home/node \
     -v ${dataDir}/config:/home/node/.openclaw \
     -v ${dataDir}/workspace:/home/node/.openclaw/workspace \
     ${imageName} -c "set -e; echo '<base64cmd>' | base64 -d | sh -e" && \
   unset TAILSCALE_SERVE_HOST
   ```
   c. For commands that DON'T reference `TAILSCALE_SERVE_HOST`:
   - The hostname value is NOT in the `create` string
   - Pulumi sees no diff when hostname changes → command does NOT re-run ✓
   d. For commands that DO reference it:
   - The resolved hostname IS in the `create` string
   - Pulumi detects the diff → command re-runs ✓

   Resource options: `logging: "none"`, `additionalSecretOutputs: ["stdout", "stderr"]`

5. **Sequential dependency chain:**
   - Filter empty commands (existing behavior, warn)
   - Auto-prefix with `openclaw ` (existing behavior)
   - Each depends on the previous: `dependsOn: [i === 0 ? createDirs : setupResources[i-1]]`

**Output:**
```typescript
initComplete: pulumi.Output<string>;  // stdout of last step (or createDirs if no commands)
```

#### Step 3: Remove env file pattern from Gateway

- Delete `writeSecretEnv` resource and all references to `envFile`, `.init-env`, `--env-file`
- Delete `sidecarHealthy` hostname-append-to-envfile logic (hostname is now a Pulumi output)
- Delete setup command loop + `setupResources` array + `lastSetupDep`
- Delete `createDirs` resource

#### Step 4: Update `GatewayArgs`

- **Remove:** `setupCommands`, `secretEnv` (moved to GatewayInit)
- **Keep:** `auth`/`gatewayToken` (Gateway still needs it for container env var)

#### Step 5: Update `index.ts`

```typescript
const init = new GatewayInit(`gateway-init-${gw.profile}`, {
  connection: server.connection,
  profile: gw.profile,
  imageName: image.imageName,
  setupCommands: gw.setupCommands,
  secretEnv,
  gatewayToken: token,
  tailscaleHostname: sidecar.tailscaleHostname,
}, { dependsOn: [image, envoyProxy] });
```

Note: `dependsOn: [image, envoyProxy]` — init runs AFTER envoy is healthy (matching reference: envoy must be up before any openclaw commands that might need network).

#### Step 6: Update tests

- Verify NO references to env file pattern remain
- Test env var scanning: command with `$TAILSCALE_SERVE_HOST` → detects dependency; command without → doesn't

### Acceptance Criteria

```bash
npx tsc --noEmit
npx vitest run
grep -r "init-env\|envFile\|env-file\|writeSecretEnv" components/ index.ts  # No results
# Verify: Env var scanning correctly identifies hostname-dependent commands
# Verify: Each setupCommand is its own Pulumi resource with correct dependencies
```

### Wrap Up

1. Update Progress Tracker: Task 4 → `complete`
2. Append key learnings
3. Code review subagent, fix findings
4. Commit: `refactor: extract GatewayInit component, fix secrets pattern`
5. **STOP.** Handoff prompt:

> "Continue the component decomposition initiative. Read the Serena memory `refactor-component-decomposition` — Task 4 is complete. Begin Task 5: Slim Gateway + final composition."

---

## Task 5: Slim Gateway + Final Composition

**Modifies:** `components/gateway.ts`, `index.ts`
**Depends on:** Task 4

### Implementation Phase

#### Step 1: Slim `GatewayArgs` to minimal interface

```typescript
interface GatewayArgs {
  dockerHost: pulumi.Input<string>;
  profile: string;
  port: number;
  imageName: pulumi.Input<string>;              // from GatewayImage
  sidecarContainerName: pulumi.Input<string>;   // from TailscaleSidecar
  tailscaleHostname: pulumi.Input<string>;      // from TailscaleSidecar
  gatewayToken: pulumi.Input<string>;           // for OPENCLAW_GATEWAY_TOKEN env var
  env?: Record<string, string>;                 // user-defined env vars
  secretEnv?: pulumi.Input<string>;             // for container runtime env (parsed JSON)
}
```

No `connection` needed if Gateway only creates Docker resources (volumes + container).

#### Step 2: Clean Gateway constructor to ~80-100 lines

Match reference `openclaw-gateway` service from docker-compose.yml:

1. Docker provider from `dockerHost`
2. `homeVolume` + `linuxbrewVolume` (docker.Volume)
3. Build env vars: `HOME=/home/node`, `TERM=xterm-256color`, `NODE_EXTRA_CA_CERTS=...`, `OPENCLAW_GATEWAY_TOKEN=<token>`, user env, parsed secretEnv
4. Build volumes: home, linuxbrew, config dir, workspace dir, CA cert
5. Gateway container — `docker.Container`:
   - Image: `args.imageName`
   - `networkMode: container:${args.sidecarContainerName}`
   - `init: true`
   - `restart: unless-stopped`
   - Command: `["openclaw", "gateway", "--bind", "loopback", "--port", "${args.port}"]` — match reference
   - Healthcheck: `node -e "fetch('http://127.0.0.1:${port}/healthz')..."` — match reference
   - No `CAP_NET_ADMIN`, no `dns`, no `networksAdvanced`
6. `this.tailscaleUrl` from `args.tailscaleHostname`
7. `this.containerId` from container.id
8. `registerOutputs()`

Remove ALL dead code, unused imports.

#### Step 3: Update `index.ts` — clean composition

The per-gateway loop must read as a clean sequential pipeline:

```typescript
gateways.map((gw) => {
  const token = manualToken ?? generatedToken.result;
  const secretEnv = cfg.getSecret(`gatewaySecretEnv-${gw.profile}`);

  // 1. Build image (local context → remote Docker via BuildKit)
  const image = new GatewayImage(`gw-image-${gw.profile}`, { ... },
    { dependsOn: [bootstrap] });

  // 2. Tailscale sidecar (bridge network + auth + hostname)
  const sidecar = new TailscaleSidecar(`gw-ts-${gw.profile}`, { ... },
    { dependsOn: [bootstrap] });

  // 3. Envoy proxy (egress, shares sidecar netns)
  const envoyProxy = new EnvoyProxy(`gw-envoy-${gw.profile}`, { ... },
    { dependsOn: [sidecar, envoy] });  // envoy = EnvoyEgress (config)

  // 4. Init containers (sequential config, needs hostname + image + envoy healthy)
  const init = new GatewayInit(`gw-init-${gw.profile}`, { ... },
    { dependsOn: [image, envoyProxy] });

  // 5. Gateway container (last — after everything)
  const gateway = new Gateway(`gw-${gw.profile}`, { ... },
    { dependsOn: [envoyProxy, init] });

  return { gateway, token };
});
```

Verify dependency chain matches reference ordering:
- `image` + `sidecar` can run in parallel (independent)
- `envoyProxy` waits for `sidecar` (needs netns) + `envoy` config (needs envoy.yaml)
- `init` waits for `image` (needs built image) + `envoyProxy` (envoy must be healthy)
- `gateway` waits for `envoyProxy` (needs healthy envoy) + `init` (config must be written)

#### Step 4: Verify cascade behavior

Trace through scenarios:
- **Sidecar recreated** → new container ID → health wait re-runs → new hostname → hostname-dependent init steps re-run (create string changed) → gateway recreated (depends on init)
- **Envoy config changed** → EnvoyEgress outputs new hash → EnvoyProxy container replaced (label change) → envoy health re-runs → init steps that depend on envoyProxy re-run? No — init depends on envoyProxy being complete, but init command strings haven't changed. Gateway depends on envoyProxy too, so it may be recreated. Verify this chain.
- **setupCommand text changed** → init step's create string changed → Pulumi re-runs it → gateway recreated (depends on init output)
- **Stable state, no changes** → nothing re-runs ✓

#### Step 5: Full validation

```bash
npx tsc --noEmit
npx vitest run
wc -l components/gateway.ts  # Should be ~100-130 lines total
```

### Acceptance Criteria

```bash
npx tsc --noEmit
npx vitest run
wc -l components/gateway.ts  # ≤ 150 lines
# Verify: index.ts has clean 5-component pipeline per gateway
# Verify: No dead code in gateway.ts
# Verify: Dependency chain matches reference ordering exactly
```

### Wrap Up

1. Update Progress Tracker: Task 5 → `complete`
2. Append key learnings
3. Code review subagent, fix findings
4. Commit: `refactor: slim Gateway to container-only, wire final composition`
5. **STOP.** Handoff prompt:

> "Continue the component decomposition initiative. Read the Serena memory `refactor-component-decomposition` — Task 5 is complete. Begin Task 6: Tests + documentation + validation."

---

## Task 6: Tests + Documentation + Validation

**Modifies:** `tests/`, `AGENTS.md`, `.claude/rules/docker-and-shell.md`, `.claude/rules/typescript-files.md`
**Creates:** test files for new components as needed
**Depends on:** Task 5

### Implementation Phase

#### Step 1: Component tests for all new components

Using `pulumi.runtime.setMocks()` pattern from existing tests.

**GatewayImage tests:**
- Creates a `docker-build.Image` resource (not command.remote.Command)
- Tags match `openclaw-gateway-${profile}:${version}`
- `push: false`

**TailscaleSidecar tests:**
- Creates bridge network (not internal)
- Creates sidecar container with NET_ADMIN, /dev/net/tun, correct DNS, correct healthcheck
- Creates health wait command with container ID trigger
- Outputs containerName, tailscaleHostname, networkName

**EnvoyProxy tests:**
- Creates envoy container with `networkMode: container:${sidecarName}`
- Creates health wait with container ID trigger
- Correct healthcheck matching reference

**GatewayInit tests:**
- Creates dir setup command
- Creates per-command resources with correct dependencies
- Env var scanning: command with `$TAILSCALE_SERVE_HOST` includes hostname in create string
- Env var scanning: command without hostname does NOT include it
- No env file references anywhere
- `logging: "none"` on secret-bearing commands

**Gateway tests (slimmed):**
- Creates only: homeVolume, linuxbrewVolume, gatewayContainer
- No sidecar, no envoy, no init, no image build resources
- Container uses `networkMode: container:${sidecarName}`
- Container has `init: true`, correct healthcheck

#### Step 2: Verify all existing tests pass

```bash
npx vitest run
```

Template, envoy config, and config tests should be unaffected.

#### Step 3: Update `AGENTS.md`

Update ALL sections to reflect new architecture:
- **Project Structure:** Add new component files
- **Component Hierarchy:** 5 components per gateway with dependency diagram
- **Network Topology:** Unchanged (still shared netns)
- **Deployment Model:** Document 5-component pipeline, export/unset secrets, env var scanning
- **Docker Container Conventions:** Remove ALL env file references, document new patterns
- **Contribution Guidelines:** Note that each service is a first-class component

#### Step 4: Update `.claude/rules/`

- `docker-and-shell.md`: Remove env file references. Document export/unset. Document docker-build usage. Update component list.
- `typescript-files.md`: Add new files to package layout. Add `@pulumi/docker-build` to dependencies table.

#### Step 5: Final validation

```bash
npx tsc --noEmit
npx vitest run
grep -r "init-env\|envFile\|env-file\|writeSecretEnv" components/ index.ts  # No results
grep -r "uploadBuildContext\|buildImage" components/  # No results (except maybe comments)
```

#### Step 6: Clean up dead code

Search for orphaned references:
```bash
grep -rn "base64.*Dockerfile\|encodedDockerfile\|encodedEntrypoint\|encodedSidecar" components/
```

### Acceptance Criteria

```bash
npx tsc --noEmit
npx vitest run
grep -r "init-env" components/ index.ts  # No results
grep -r "env-file" components/ index.ts  # No results
# All new components have test coverage
# AGENTS.md reflects 5-component architecture
# .claude/rules/ files updated
```

### Wrap Up

1. Update Progress Tracker: Task 6 → `complete`
2. Append key learnings
3. Code review subagent, fix findings
4. Commit: `docs: update documentation for component decomposition`
5. **DONE.** Inform the user:

> **Initiative complete.** Gateway monolith decomposed into 5 first-class components: `GatewayImage`, `TailscaleSidecar`, `EnvoyProxy`, `GatewayInit`, `Gateway`. Each mirrors a reference service exactly. Secrets never touch disk. Init step dependencies tracked automatically via env var scanning. Image builds use BuildKit via `@pulumi/docker-build`. First `pulumi up` on existing stacks will recreate containers due to URN changes (expected, brief downtime).
