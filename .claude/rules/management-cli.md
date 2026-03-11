---
globs: ["scripts/manage.sh", "Makefile"]
---

# Management CLI (ocm) Rules

## Script: `scripts/manage.sh`
- Symlinked to `/usr/local/bin/ocm` via `make install`
- Config: `scripts/.ocm.conf` (git-ignored) — stores `OCM_DEFAULT_STACK` and `OCM_DEFAULT_PROFILE`
- Prerequisites: `jq`, `pulumi`, `ssh` (checked at startup)

## Adding New Commands
1. Create `cmd_<name>()` function in the Subcommands section
2. Add dispatch entry in the `case` block at the bottom (with alias if needed)
3. Add help text in `cmd_help()`
4. Add corresponding Makefile target if appropriate
5. Update README.md `## Management CLI (ocm)` section
6. Run `shellcheck scripts/manage.sh` before committing

## Conventions
- Call `_resolve_stack` before using `OCM_STACK` or stack-dependent helpers (`_get_ip`, `_pulumi`)
- Call `_resolve_profile` before using `OCM_PROFILE` or `_container_name`
- Use `_ssh` for remote commands, `_docker` for remote Docker commands (handles quoting)
- Use `_info`, `_ok`, `_warn`, `_error`, `_die` for user-facing output (auto-disable color when not TTY)
- Use `_wait_healthy` after container restarts (polls healthcheck, 120s timeout)
- Container names: `openclaw-gateway-<profile>`, `envoy-<profile>`, `tailscale-<profile>`
- Service aliases in `_container_name`: `gateway|gw`, `sidecar|ts`

## Dependency-Aware Restart
When restarting, the chain is: sidecar → envoy → gateway.
Restarting an upstream service must cascade to all downstream services.
- `sidecar` or `all`: restart sidecar, then envoy, then gateway
- `envoy`: restart envoy, then gateway
- `gateway`: restart gateway only

## Makefile Integration
`Makefile` wraps ocm with Make variables: `STACK`, `PROFILE`, `SERVICE`, `TARGET`, `FOLLOW`, `CMD`.
When adding a new ocm command, add a corresponding Make target and update the `.PHONY` line.
