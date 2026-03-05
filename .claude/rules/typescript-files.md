---
globs: ["**/*.ts"]
---

# TypeScript Development Rules

## Build & Verify
- `npx tsc --noEmit` — type-check without emitting
- `npx tsc` — compile to `dist/`
- `npx vitest run` — run all tests
- `npx vitest run tests/templates.test.ts` — run a specific test file

## Module
- Package: `openclaw-deploy` (version 0.1.0)
- Runtime: Node.js (Pulumi `nodejs` runtime with TypeScript)
- Entry point: `index.ts`
- Target: ES2022, module: commonjs, strict mode

## Dependencies
| Package | Purpose |
|---------|---------|
| `@pulumi/pulumi` | Pulumi SDK (ComponentResource, Config, Output/Input) |
| `@pulumi/hcloud` | Hetzner Cloud VPS provisioning |
| `@pulumi/digitalocean` | DigitalOcean VPS provisioning |
| `@pulumi/oci` | Oracle Cloud Infrastructure provisioning |
| `@pulumi/docker` | Docker provider (containers, networks, volumes via remote host) |
| `@pulumi/docker-build` | BuildKit image builds via remote Docker daemon |
| `@pulumi/command` | Remote SSH command execution |
| `@pulumi/tls` | TLS private key generation (auto-SSH) |
| `@pulumi/random` | Random password generation (gateway tokens) |
| `vitest` | Test runner |
| `typescript` | TypeScript compiler |

## Package Layout
| Directory | Purpose |
|-----------|---------|
| `components/` | Pulumi ComponentResource subclasses (Server, HostBootstrap, EnvoyEgress, GatewayImage, TailscaleSidecar, EnvoyProxy, GatewayInit, Gateway) |
| `templates/` | Pure functions rendering Docker artifacts (Dockerfile, entrypoint.sh, envoy.yaml) |
| `config/` | Type definitions, hardcoded domain rules, default constants |
| `tests/` | Vitest test files |

## Pulumi Conventions
- Components extend `pulumi.ComponentResource` with a unique type URN (e.g. `openclaw:infra:Server`)
- Constructor takes `(name, args, opts?)` — always call `super()` first, `registerOutputs()` last
- Use `pulumi.Input<T>` for args, `pulumi.Output<T>` for public properties
- Track parent/dependency via `{ parent: this }` and `{ dependsOn: [...] }`
- Secrets use `cfg.requireSecret()` and `additionalSecretOutputs` on remote commands
- Docker provider per component: `new docker.Provider(name, { host: args.dockerHost }, { parent: this })`
- Remote file uploads use base64 encoding: `Buffer.from(content).toString("base64")` → `echo '<b64>' | base64 -d > <path>`

## Template Conventions
- Pure functions in `templates/` returning strings — no side effects, no I/O
- Import constants from `config/defaults.ts` (never hardcode IPs, ports, image tags)
- `renderDockerfile(opts: DockerfileOpts): string`
- `renderEntrypoint(): string` (static — no parameters)
- `renderEnvoyConfig(userRules): EnvoyConfigResult` (returns `{ yaml, warnings, inspectedDomains, tcpPortMappings }`)
- Use TypeScript template literals for multi-line output
- All templates re-exported from `templates/index.ts`

## Config Conventions
- `config/types.ts` — interfaces: `EgressRule`, `VpsProvider`, `GatewayConfig`, `StackConfig`
- `config/domains.ts` — hardcoded egress rules (infrastructure, AI, Homebrew) + `mergeEgressPolicy()`
- `config/defaults.ts` — all constants (network subnets, IPs, ports, image tags, package lists)
- All config re-exported from `config/index.ts`
- When adding a new configurable value, add it to `defaults.ts` and reference from templates/components

## Testing Conventions
- Tests in `tests/` using Vitest (`describe`, `it`, `expect`)
- Template tests: call render functions with various inputs, assert on output strings
- Envoy tests: verify domain merging, YAML structure, warning generation
- Config tests: verify type constraints, domain deduplication
- Component tests: use `pulumi.runtime.setMocks()` for unit testing without real infrastructure
- Test file naming: `<module>.test.ts`
