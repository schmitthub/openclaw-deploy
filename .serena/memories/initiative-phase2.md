# Phase 2 Initiative — Multi-Provider, Advanced Egress & CI/CD

**Branch:** `feat/phase2`
**Parent memory:** `initiative-iac-migration`
**PRD Reference:** See `AGENTS.md` "Future Steps" and `brainstorm_iac-stack-migration` memory

---

## Progress Tracker

| Task | Status | Agent |
|------|--------|-------|
| Task 1: CI/CD pipeline & pre-commit hooks | `complete` | — |
| Task 2: DigitalOcean provider | `complete` | — |
| Task 3: Oracle Cloud provider (ARM) | `complete` | — |
| Task 4: Envoy CA certificate infrastructure | `complete` | — |
| Task 5: MITM TLS inspection for path-level filtering | `complete` | — |
| Task 6: DNS snooping for SSH/TCP egress | `pending` | — |

## Key Learnings

(Agents append here as they complete tasks)

- **Task 1**: Husky v9 `init` creates pre-commit without shebang — added manually. Existing `pr.yml` + `security.yml` workflows only handle gitleaks; CI workflow added separately. Existing component tests were already reasonable; added `tailscaleIP` direct assertion and tightened `tailscaleUrl` assertions from `toContain` to `toBe`.
- **Task 2**: Straightforward — followed Hetzner pattern exactly. Code reviewer caught that DO now offers ARM droplets (slug suffix `-arm`), so `arch` detection was changed from hardcoded `"amd64"` to slug-based detection mirroring Hetzner's `cax` prefix pattern. DO uses `ipv4Address` output (same field name as Hetzner). Default image slug uses dashes (`ubuntu-24-04-x64`) vs Hetzner dots (`ubuntu-24.04`).
- **Task 4**: CA generation uses `openssl req -x509 -newkey ec` with P-256 curve (fast, small keys). Made idempotent with `[ -f ca-cert.pem ] || (openssl ... && chmod)` guard. CA cert mounted into Envoy container (`/etc/envoy/ca-cert.pem`) and gateway container (at host path via `ENVOY_CA_CERT_PATH`). Gateway trusts via `NODE_EXTRA_CA_CERTS` env var — standard Node.js mechanism. `caCertPath` exposed as `pulumi.Output<string>` from `EnvoyEgress`. Code review findings: (1) removed dead `caCertPath` arg from `GatewayArgs` — the constant is always correct and the arg was misleading; (2) deferred CA key mount in Envoy container to Task 5 — only the cert (public) is mounted now, the key (private) stays on host until MITM filter chains need it; (3) added `chmod 644` on cert and `chmod 640` on key during generation to ensure correct permissions when Task 5 mounts the key.
- **Task 5**: Implemented MITM TLS inspection using static per-domain certs generated at deploy time. Each inspected domain gets a cert signed by the CA (EC P-256, 365-day validity, SAN via temp extension file for portability). Envoy config uses per-domain `DownstreamTlsContext` filter chains with `http_connection_manager` for HTTP-level path inspection, plus `dynamic_forward_proxy` HTTP filter with a separate DNS cache (`mitm_forward_proxy_cache`) and `UpstreamTlsContext` cluster for TLS re-origination. Code review findings: (1) added hostname regex validation before shell interpolation in cert generation commands — prevents injection from malformed domain strings; (2) narrowed `PathRule.action` from `"allow" | "deny"` to just `"deny"` since allow paths are no-ops (catch-all allows everything not denied); (3) added test for MITM filter chain ordering (must appear before passthrough in YAML); (4) CA key stays on host only — Envoy only needs per-domain certs, not the CA key. Wildcard domains with `inspect: true` fall back to passthrough with a warning since you can't generate a meaningful static cert per-subdomain.
- **Task 3**: OCI doesn't expose public IP directly on `oci.core.Instance` — requires VNIC attachment lookup chain (`getVnicAttachmentsOutput` → `getVnic`). Used `*Output` variants for idiomatic Pulumi data source chaining. OCI Ubuntu images default to `ubuntu` user with root disabled — added cloud-init user_data to copy SSH keys to root and enable `PermitRootLogin prohibit-password`, matching Hetzner/DO root SSH pattern. OCI flex shapes (`VM.Standard.A1.Flex`) require `shapeConfig` with `ocpus` and `memoryInGbs` — added as optional `ServerArgs` fields with defaults (2 OCPUs, 12GB). OCI `image` is a region-specific OCID (not a slug) — made required for Oracle provider. ARM detection uses `VM.Standard.A1` shape prefix.

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

`openclaw-deploy` is a Pulumi TypeScript IaC program that provisions remote VPS hosts, installs Docker + Tailscale, and deploys OpenClaw gateway containers with transparent egress isolation via Envoy proxy. Phase 1 (the `initiative-iac-migration`) is complete — it delivers Hetzner VPS provisioning, TLS SNI-based egress filtering, and full stack composition.

Phase 2 extends the platform with:
- **Multi-cloud VPS**: DigitalOcean and Oracle Cloud (ARM) providers alongside Hetzner
- **Advanced egress**: MITM TLS inspection for path-level filtering, DNS snooping for SSH/TCP domain enforcement
- **CI/CD**: Pre-commit hooks, GitHub Actions validation, expanded test coverage

### Key Files

| File | Purpose |
|------|---------|
| `components/server.ts` | VPS provisioning — has DO/Oracle stubs (throw errors) |
| `components/bootstrap.ts` | Docker + Tailscale install on bare host |
| `components/envoy.ts` | EnvoyEgress component — Docker networks + Envoy container |
| `components/gateway.ts` | Gateway instance + config + Tailscale |
| `config/types.ts` | `EgressRule` (already has `inspect`, `pathRules`, `ssh`/`tcp` proto), `VpsProvider` (already has all three providers) |
| `config/domains.ts` | Hardcoded egress rules + `mergeEgressPolicy()` |
| `config/defaults.ts` | Constants (networks, ports, images, packages) |
| `templates/envoy.ts` | `renderEnvoyConfig()` — has Phase 2 warning stubs for MITM, SSH, TCP |
| `templates/entrypoint.ts` | `renderEntrypoint()` — iptables DNAT + FILTER rules |
| `templates/dockerfile.ts` | `renderDockerfile()` — gateway image renderer |
| `tests/components.test.ts` | Component tests with Pulumi mocks — has "should throw" tests for DO/Oracle |
| `tests/envoy.test.ts` | Envoy config rendering tests — has Phase 2 warning tests |
| `index.ts` | Stack composition entry point |

### Design Patterns

- **Components**: Pulumi `ComponentResource` subclass, `super()` first, `registerOutputs()` last, `{ parent: this }` on children
- **Templates**: Pure functions returning strings, no side effects, constants from `config/defaults.ts`
- **Config**: Typed interfaces in `config/types.ts`, hardcoded rules in `config/domains.ts`
- **Testing**: Vitest, `pulumi.runtime.setMocks()` for component tests, string assertions for template tests
- **Remote file uploads**: base64 encoding via `Buffer.from(content).toString("base64")` → `echo '<b64>' | base64 -d > <path>`
- **Docker provider**: per-component `new docker.Provider(name, { host: args.dockerHost }, { parent: this })`
- **Exhaustive switch**: `default: { const _exhaustive: never = x; throw ... }` pattern for union types

### Rules

- Read `CLAUDE.md`, relevant `.claude/rules/` files, and Serena memories before starting
- Use Serena tools for code exploration — read symbol bodies only when needed
- All new code must compile (`npx tsc --noEmit`) and tests must pass (`npx vitest run`)
- Follow existing test patterns in `tests/`
- Never weaken the egress isolation model (see AGENTS.md Threat Model)
- No `any` types or type assertions without justification
- Pin versions where stability matters
- Keep commits scoped to one concern

---

## Task 1: CI/CD Pipeline & Pre-Commit Hooks

**Creates/modifies:** `.husky/pre-commit`, `.github/workflows/ci.yml`, `package.json`, `tests/components.test.ts`
**Depends on:** nothing (independent)

### Implementation Phase

1. **Install dev dependencies**:
   - `husky` for Git hooks
   - `lint-staged` for targeted pre-commit checks (optional — can do full `tsc` + `vitest` instead)

2. **Configure pre-commit hook** (`.husky/pre-commit`):
   ```bash
   npx tsc --noEmit
   npx vitest run
   ```

3. **Create GitHub Actions CI workflow** (`.github/workflows/ci.yml`):
   - Trigger on push to `main` and on pull requests
   - Node.js 22 matrix
   - Steps: checkout → install deps → `npx tsc --noEmit` → `npx vitest run`
   - Optional: `pulumi preview` step (requires stack config / secrets — may skip for now and add a placeholder)

4. **Expand component test coverage**:
   - Add test for `HostBootstrap` component verifying Tailscale IP extraction and Docker host switching
   - Add test for `Gateway` component verifying image build, container creation, config exec commands
   - Ensure all existing tests still pass

5. **Update `package.json`**:
   - Add `"prepare": "husky"` script (standard husky setup)
   - Add `"lint": "tsc --noEmit"` and `"test": "vitest run"` scripts if not already present
   - Add `husky` to `devDependencies`

### Acceptance Criteria

```bash
npx tsc --noEmit       # zero errors
npx vitest run         # all tests pass
cat .husky/pre-commit  # exists and runs tsc + vitest
cat .github/workflows/ci.yml  # valid GitHub Actions workflow
```

### Wrap Up

1. Update Progress Tracker: Task 1 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 2. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the Phase 2 initiative. Read the Serena memory `initiative-phase2` — Task 1 is complete. Begin Task 2: DigitalOcean provider."

---

## Task 2: DigitalOcean Provider

**Creates/modifies:** `components/server.ts`, `package.json`, `config/defaults.ts`, `tests/components.test.ts`
**Depends on:** nothing (independent of Task 1, but ordered for context)

### Implementation Phase

1. **Add DigitalOcean Pulumi provider**:
   - `npm install @pulumi/digitalocean`
   - Import in `components/server.ts`

2. **Implement `case "digitalocean"` in `Server` constructor**:
   - Create a `digitalocean.Droplet` resource with:
     - `name`: resource name
     - `size`: `args.serverType` (e.g. `"s-1vcpu-1gb"`, `"s-2vcpu-2gb"`)
     - `region`: `args.region` (e.g. `"nyc1"`, `"sfo3"`)
     - `image`: `args.image ?? "ubuntu-24-04-x64"` (DO image slug format)
     - `sshKeys`: `[args.sshKeyId]` (DO uses fingerprints or IDs)
   - Set `this.ipAddress` from `droplet.ipv4Address`
   - Set `this.arch` — all standard DO droplets are `amd64`; if premium GPU/ARM droplets exist, add detection logic. Default to `"amd64"`.
   - Set `this.connection` and `this.dockerHost` from the IP

3. **Add DigitalOcean defaults** to `config/defaults.ts` (if needed):
   - Default image slug: `"ubuntu-24-04-x64"`

4. **Update tests**:
   - In `tests/components.test.ts`, update the mock to handle `digitalocean:index/droplet:Droplet` resource type (return a mock `ipv4Address`)
   - Change the "should throw for digitalocean" test to verify successful creation instead
   - Add test verifying `arch` is `"amd64"` for DO droplets
   - Add test verifying DO droplet resource is created with expected properties

5. **Update `ServerArgs` doc comments** to reflect multi-provider support:
   - `serverType`: e.g. "cx22" (Hetzner), "s-1vcpu-1gb" (DO)
   - `sshKeyId`: Provider-specific SSH key ID or fingerprint
   - `region`: e.g. "fsn1" (Hetzner), "nyc1" (DO)

### Acceptance Criteria

```bash
npx tsc --noEmit       # zero errors
npx vitest run         # all tests pass including new DO tests
grep -c "digitalocean" components/server.ts  # implementation exists (no throw)
```

### Wrap Up

1. Update Progress Tracker: Task 2 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 3. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the Phase 2 initiative. Read the Serena memory `initiative-phase2` — Task 2 is complete. Begin Task 3: Oracle Cloud provider (ARM)."

---

## Task 3: Oracle Cloud Provider (ARM)

**Creates/modifies:** `components/server.ts`, `package.json`, `config/defaults.ts`, `tests/components.test.ts`
**Depends on:** Task 2 (follows same pattern, benefits from DO implementation as reference)

### Implementation Phase

1. **Add Oracle Cloud Pulumi provider**:
   - `npm install @pulumi/oci`
   - Import in `components/server.ts`

2. **Implement `case "oracle"` in `Server` constructor**:
   - Oracle Cloud uses `oci.core.Instance` with:
     - `compartmentId`: Need to decide — either add to `ServerArgs` or derive from config. Most likely add `compartmentId` as a new optional field in `ServerArgs` (required when `provider === "oracle"`)
     - `shape`: `args.serverType` (e.g. `"VM.Standard.A1.Flex"` for ARM, `"VM.Standard.E2.1.Micro"` for x86)
     - `availabilityDomain`: `args.region` (OCI uses availability domain, not just region)
     - `sourceDetails`: image OCID (Ubuntu 24.04 ARM)
     - `metadata.ssh_authorized_keys`: SSH public key content (different from Hetzner/DO which use key IDs)
   - Set `this.ipAddress` from the instance's public IP (may need a `oci.core.InstancePool` or VNIC attachment)
   - Set `this.arch`: Oracle ARM instances (A1 shape) → `"arm64"`, E2/E3/E4 shapes → `"amd64"`
   - **Important**: OCI's free tier includes ARM Ampere A1 instances — this is a key use case

3. **Extend `ServerArgs` for OCI-specific fields**:
   - Add `compartmentId?: pulumi.Input<string>` (required for Oracle)
   - Add `subnetId?: pulumi.Input<string>` (OCI requires explicit VCN/subnet)
   - Consider whether these should be provider-specific sub-interfaces or optional top-level fields
   - Document that OCI requires additional config compared to Hetzner/DO

4. **Add Oracle defaults** to `config/defaults.ts`:
   - ARM shape prefix: `"VM.Standard.A1"`
   - Default image: Ubuntu 24.04 aarch64 OCID (note: OCIDs are region-specific)

5. **Update tests**:
   - Add mock for `oci:core/instance:Instance` resource type
   - Change "should throw for oracle" test to verify successful creation
   - Add test verifying `arch` is `"arm64"` for A1 shapes and `"amd64"` for E2 shapes
   - Add test verifying OCI instance is created with expected properties

6. **Verify ARM compatibility**:
   - `renderDockerfile()` already uses `node:22-bookworm` which is multi-arch
   - Bun installer detects arch automatically
   - Homebrew works on ARM Linux
   - Confirm no x86-specific assumptions in templates

### Acceptance Criteria

```bash
npx tsc --noEmit       # zero errors
npx vitest run         # all tests pass including new Oracle tests
grep -c "oracle" components/server.ts  # implementation exists (no throw)
```

### Wrap Up

1. Update Progress Tracker: Task 3 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 4. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the Phase 2 initiative. Read the Serena memory `initiative-phase2` — Task 3 is complete. Begin Task 4: Envoy CA certificate infrastructure."

---

## Task 4: Envoy CA Certificate Infrastructure

**Creates/modifies:** `components/envoy.ts`, `config/defaults.ts`, `components/gateway.ts`, `tests/envoy-component.test.ts`
**Depends on:** nothing (egress-track, independent of provider tasks)

### Implementation Phase

This task builds the CA certificate infrastructure needed by Task 5 (MITM TLS inspection). The CA cert must be:
- Generated once per server (in `EnvoyEgress` component)
- Mounted into the Envoy container for TLS termination
- Made available to gateway containers via `NODE_EXTRA_CA_CERTS` for trust

1. **Generate CA keypair in `EnvoyEgress` component**:
   - Use `command.remote.Command` to generate a self-signed CA cert + key on the remote host:
     ```bash
     openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
       -days 3650 -nodes -subj "/CN=OpenClaw Egress CA" \
       -keyout /opt/openclaw-deploy/envoy/ca-key.pem \
       -out /opt/openclaw-deploy/envoy/ca-cert.pem
     ```
   - Make this idempotent: only generate if the cert doesn't exist (`[ ! -f ca-cert.pem ] && openssl ...`)
   - Output `caCertPath` and `caKeyPath` from the component

2. **Mount CA cert into Envoy container**:
   - Add the CA cert + key directory to the Envoy container's volume mounts
   - The envoy.yaml will reference these paths when MITM filter chains are added (Task 5)

3. **Expose CA cert path for Gateway containers**:
   - Add `caCertPath: pulumi.Output<string>` to `EnvoyEgress` outputs
   - In `Gateway` component, set `NODE_EXTRA_CA_CERTS=/opt/openclaw-deploy/envoy/ca-cert.pem` env var
   - This tells Node.js to trust the Envoy CA for MITM-inspected connections

4. **Add constants** to `config/defaults.ts`:
   - `ENVOY_CA_CERT_PATH = "/opt/openclaw-deploy/envoy/ca-cert.pem"`
   - `ENVOY_CA_KEY_PATH = "/opt/openclaw-deploy/envoy/ca-key.pem"`

5. **Update tests**:
   - Test that `EnvoyEgress` creates the CA generation command resource
   - Test that `caCertPath` output is set
   - Test that `Gateway` container env includes `NODE_EXTRA_CA_CERTS` when CA is available

### Acceptance Criteria

```bash
npx tsc --noEmit       # zero errors
npx vitest run         # all tests pass
grep "NODE_EXTRA_CA_CERTS" components/gateway.ts  # env var is set
grep "ca-cert.pem" components/envoy.ts             # CA cert generation exists
```

### Wrap Up

1. Update Progress Tracker: Task 4 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 5. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the Phase 2 initiative. Read the Serena memory `initiative-phase2` — Task 4 is complete. Begin Task 5: MITM TLS inspection for path-level filtering."

---

## Task 5: MITM TLS Inspection for Path-Level Filtering

**Creates/modifies:** `templates/envoy.ts`, `tests/envoy.test.ts`, `config/defaults.ts`
**Depends on:** Task 4 (CA cert infrastructure must exist)

### Implementation Phase

This task implements the `inspect: true` + `pathRules` handling in `renderEnvoyConfig()`. When a TLS rule has `inspect: true`, Envoy should:
1. Terminate the inbound TLS connection using the CA cert (from Task 4)
2. Inspect the HTTP request (Host, path, method)
3. Apply `pathRules` — deny matching paths, allow the rest
4. Re-encrypt and forward to the upstream

1. **Design the MITM filter chain** in `templates/envoy.ts`:
   - Separate `inspectDomains` from `passthroughDomains` in the rule processing loop
   - For each inspected domain, generate a filter chain with:
     - `filter_chain_match.server_names: ["<domain>"]`
     - `transport_socket` with `DownstreamTlsContext` using the CA cert/key for dynamic cert generation
     - `HttpConnectionManager` filter with route config
     - Routes: for each `pathRule` with `action: "deny"`, add a route that returns 403
     - Default route: forward via `sni_dynamic_forward_proxy` to the upstream with TLS origination
   - Add an `upstream_tls_context` cluster or use `auto_sni` + `auto_san_validation` for re-encryption

2. **Add MITM Envoy cluster**:
   - A new cluster type that originates TLS to the upstream (re-encrypts after inspection)
   - Use Envoy's `transport_socket` on the cluster with `UpstreamTlsContext` and `auto_sni: true`

3. **Update the `renderEnvoyConfig` signature** (if needed):
   - May need a `caCertPath` and `caKeyPath` parameter for embedding cert paths in the YAML
   - Or reference the constants from `config/defaults.ts`

4. **Remove the MITM Phase 2 warning** for implemented rules:
   - Keep the warning only for edge cases not yet handled (e.g., wildcard domains with inspection)

5. **Update tests** in `tests/envoy.test.ts`:
   - Test that `inspect: true` TLS rules generate a separate MITM filter chain (not passthrough)
   - Test that `pathRules` with `action: "deny"` produce 403 routes
   - Test that the default route for inspected domains still forwards traffic
   - Test that the CA cert paths appear in the generated YAML
   - Test mixed rules: some passthrough, some inspected
   - Update Phase 2 warning tests to remove the MITM warning (it's now implemented)

6. **Research Envoy MITM configuration**:
   - Envoy does not natively do dynamic cert generation like mitmproxy. Options:
     a. **Static per-domain certs**: Generate a cert for each inspected domain at config render time. Simpler but requires re-render when domains change.
     b. **SDS (Secret Discovery Service)**: Dynamic cert provisioning. More complex, requires a sidecar.
     c. **Lua filter**: Generate certs on-the-fly using OpenSSL bindings. Medium complexity.
   - Recommendation: Start with **static per-domain certs** generated during `EnvoyEgress` setup. Each inspected domain gets a cert signed by the CA. This is the simplest approach and fits the Pulumi declarative model (domains are known at plan time).

### Acceptance Criteria

```bash
npx tsc --noEmit       # zero errors
npx vitest run         # all tests pass
# Verify MITM filter chain is generated for inspect rules:
npx vitest run tests/envoy.test.ts -t "inspect"
```

### Wrap Up

1. Update Progress Tracker: Task 5 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Do not proceed to Task 6. Inform the user you are done and present this handoff prompt:

> **Next agent prompt:** "Continue the Phase 2 initiative. Read the Serena memory `initiative-phase2` — Task 5 is complete. Begin Task 6: DNS snooping for SSH/TCP egress."

---

## Task 6: DNS Snooping for SSH/TCP Egress

**Creates/modifies:** `templates/envoy.ts`, `components/envoy.ts`, `config/defaults.ts`, `tests/envoy.test.ts`, possibly new files
**Depends on:** Task 5 (builds on the expanded Envoy config architecture)

### Implementation Phase

This is the most complex Phase 2 task. The problem: SSH, FTP, and raw TCP connections have no domain identifier in the protocol (no SNI equivalent). To enforce per-domain rules for these protocols, we need a **DNS-to-IP mapping** — when the gateway resolves a domain via Envoy's DNS listener, Envoy records the mapping `IP → domain`, then uses it to match incoming TCP connections against domain rules.

**Research phase** (agent should investigate before implementing):

1. **Evaluate Envoy DNS snooping approaches**:
   - **Option A: Lua filter on DNS listener** — Envoy's Lua filter can intercept DNS responses, extract A/AAAA records, and store IP→domain mappings in shared memory. When a TCP connection arrives with `SO_ORIGINAL_DST`, the Lua filter on the egress listener looks up the original destination IP in the mapping.
   - **Option B: External xDS controller** — A sidecar process watches DNS queries (via Envoy's access log or tap), maintains the IP→domain map, and pushes dynamic cluster/route configs to Envoy via xDS API. More robust but much more complex.
   - **Option C: Companion DNS sidecar** — A custom DNS proxy (e.g., CoreDNS with a plugin, or a small Node.js/Go DNS proxy) sits between the gateway and Envoy's DNS. It answers queries, records mappings, and writes Envoy config updates. Pragmatic for a Pulumi-managed deployment.
   - **Option D: iptables + conntrack + Envoy original_dst** — Use iptables DNAT to redirect non-443 TCP to a separate Envoy listener. Envoy uses `original_dst` cluster to learn the real destination IP, which we match against a pre-populated IP allowlist (resolved at Pulumi plan time). Simpler but doesn't handle dynamic DNS.

2. **Recommended approach: Option D (static IP resolution at plan time) + Option A (Lua for dynamic)**:
   - **Phase 2a (this task)**: For SSH/TCP rules with domain destinations, resolve the domain to IPs at Pulumi plan time using `command.remote.Command` (`dig +short <domain>`). Generate Envoy config with IP-based matching on a separate listener port. This handles the common case (known domains like `github.com` for SSH).
   - **Phase 2b (future)**: Add Lua-based dynamic DNS snooping for domains with frequently changing IPs. This can be a follow-up task.

3. **Implementation for Phase 2a**:
   - Add a new Envoy listener (e.g., `egress_tcp` on port 10001) for non-TLS TCP traffic
   - In `entrypoint.sh`, update iptables to DNAT non-TLS TCP to port 10001 instead of 10000. This requires protocol detection — challenge: iptables can't distinguish TLS from raw TCP. Alternative: DNAT all TCP to 10000 and let Envoy's TLS Inspector handle routing (TLS → filter chain 1, non-TLS → filter chain 2 based on `transport_protocol: "raw_buffer"`)
   - For SSH/TCP rules, resolve domain IPs at render time and generate `filter_chain_match` entries with IP prefix ranges
   - Use `envoy.filters.network.tcp_proxy` with `original_dst` cluster for allowed IP ranges
   - Deny all other non-TLS TCP traffic

4. **Update `renderEnvoyConfig()`**:
   - Accept resolved IPs for SSH/TCP rules (new parameter or resolve within the function)
   - Generate a non-TLS filter chain in the existing egress listener using `transport_protocol: "raw_buffer"` match
   - Remove Phase 2 warnings for SSH/TCP rules

5. **Update `renderEntrypoint()`** (if needed):
   - May need to adjust iptables rules if a separate listener port is used
   - If using TLS Inspector's `transport_protocol` matching, no entrypoint changes needed

6. **Update tests**:
   - Test SSH rule generates non-TLS filter chain with IP matching
   - Test TCP rule generates correct clusters
   - Test mixed TLS + SSH rules produce correct multi-chain config
   - Remove SSH/TCP Phase 2 warning tests (they're now implemented)

### Acceptance Criteria

```bash
npx tsc --noEmit       # zero errors
npx vitest run         # all tests pass
# Verify SSH/TCP rules generate filter chains:
npx vitest run tests/envoy.test.ts -t "ssh"
npx vitest run tests/envoy.test.ts -t "tcp"
```

### Wrap Up

1. Update Progress Tracker: Task 6 → `complete`
2. Append key learnings
3. Run a single `code-reviewer` subagent to review only this task's changes. Fix any findings before proceeding.
4. Commit all changes from this task with a descriptive commit message.
5. **STOP.** Inform the user that Phase 2 is complete. Present this summary:

> **Phase 2 complete.** All six tasks are done:
> 1. CI/CD pipeline & pre-commit hooks
> 2. DigitalOcean provider
> 3. Oracle Cloud provider (ARM)
> 4. Envoy CA certificate infrastructure
> 5. MITM TLS inspection for path-level filtering
> 6. DNS snooping for SSH/TCP egress
>
> Update the `roadmap` Serena memory to move Phase 2 items from "Planned" to "Complete". Update `AGENTS.md` to reflect the new capabilities and remove Phase 2 annotations from "Future Steps".
