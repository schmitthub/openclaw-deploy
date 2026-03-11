# OCM — OpenClaw Management CLI

## Overview
`scripts/manage.sh` is a bash CLI providing ergonomic wrappers for VPS/container operations.
Symlinked to `/usr/local/bin/ocm` via `make install`. Config in `scripts/.ocm.conf` (git-ignored).

## Architecture
- Reads Pulumi stack outputs (`serverIp`) and config (`gateways[].profile`) to target remote hosts
- SSH via `_ssh` helper → `root@<ip>` with host key checking disabled
- Docker commands via `_docker` helper (properly quoted remote execution)
- Container names: `openclaw-gateway-<profile>`, `envoy-<profile>`, `tailscale-<profile>`
- Resolution order: `--stack`/`--profile` flags → `OCM_STACK`/`OCM_PROFILE` env vars → `.ocm.conf` defaults

## Commands (15 total)
| Command | Description |
|---------|-------------|
| `init` | Interactive setup → saves stack + profile to `.ocm.conf` |
| `status` / `st` | Container status (ps filtered to profile's 3 containers) |
| `logs` / `log` | Container logs with `-f`, `-n`, service selection |
| `restart` | Dependency-aware: sidecar→envoy→gw cascade, waits for healthy |
| `exec` | `docker exec -it` into gateway (default: bash as node, `-u root`) |
| `run` | Ephemeral `docker run --rm` with gateway image |
| `shell` / `sh` | Shell: `node` (default), `root`, `vps` (SSH to host) |
| `openclaw` | Run `openclaw` CLI as node in gateway |
| `stats` | `docker stats --no-stream` for profile containers |
| `health` | Full system: uptime, memory, disk, docker df, containers, resources |
| `ts-status` | `tailscale status` from sidecar |
| `bypass` | Firewall-bypass SOCKS proxy (default 30s timeout) |
| `ps` | `docker ps` on VPS |

## Key Implementation Details
- `_wait_healthy()`: Polls container healthcheck every 2s, 120s timeout
- `_restart_container()`: Restart + wait for healthy, die on timeout
- `cmd_restart()`: Dependency chain — restarting sidecar cascades to envoy+gateway
- `cmd_run()`: Discovers image from running container via `docker inspect`
- Color helpers auto-disable when stdout is not a TTY
- Prerequisites: `jq`, `pulumi`, `ssh` (checked at startup)

## Makefile Integration
`Makefile` wraps ocm with Make targets: `status`, `logs`, `restart`, `exec`, `shell`, `openclaw`, `stats`, `health`, `ps`, `bypass`.
Variables: `STACK`, `PROFILE`, `SERVICE`, `TARGET`, `FOLLOW`, `CMD`.

## CI
ShellCheck runs on `scripts/manage.sh` in `.github/workflows/ci.yml`.

## Development Conventions
- Subcommands are `cmd_<name>()` functions
- Dispatch via `case` block at bottom of script
- Aliases in dispatch: `status|st`, `logs|log`, `shell|sh`
- Service aliases: `gateway|gw`, `sidecar|ts`
