# Roadmap

## In Progress

### IaC Migration (openclaw-docker → openclaw-deploy)
- **Branch:** `refator/iac`
- Pulumi TypeScript IaC for OpenClaw fleet deployment
- Tasks 1-10 complete, Task 11 (Testing infrastructure & CI) pending
- See Serena memory `initiative-iac-migration` for full task tracker

## Planned

### Phase 2: Multi-provider support
- DigitalOcean provider in `components/server.ts`
- Oracle Cloud provider in `components/server.ts`
- Provider-specific defaults and region validation

### Phase 2: Advanced egress policy
- MITM TLS inspection for path-level filtering (structure in `EgressRule.inspect` + `pathRules`)
- SSH egress rules via DNS snooping
- TCP egress rules via DNS snooping

### Phase 2: CI/CD
- Pre-commit hooks for TypeScript linting and type-checking
- Pulumi preview in CI for PR validation
- Expanded Pulumi unit tests with mocked components
