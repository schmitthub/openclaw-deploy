# reference/ — Local Docker Compose Test Harness

This directory contains a minimal Docker Compose stack adapted from [openclaw/openclaw](https://github.com/openclaw/openclaw) for locally testing OpenClaw gateway setup, onboard commands, and CLI workflows **before** deploying to remote infrastructure via Pulumi.

## Purpose

Use this to iterate on:

- `openclaw onboard` flags and auth flows (OpenRouter, Anthropic, etc.)
- `openclaw config set` commands and their effects on `openclaw.json`
- Gateway startup behavior, health checks, and token auth
- Any CLI command via the `openclaw-cli` Compose service

Results here inform the `setupCommands` and `configSet` values used in Pulumi stack configs (`Pulumi.<stack>.yaml`).

## Files

| File                    | Description                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `docker-compose.yml`    | Three-service stack: `tailscale-sidecar` + `openclaw-gateway` + `openclaw-cli` (ephemeral CLI) |
| `sidecar-entrypoint.sh` | Sidecar: iptables REDIRECT + UDP owner-match + exec containerboot                              |
| `entrypoint.sh`         | Gateway: permissions fix + sshd + filebrowser + gosu node (no iptables)                        |
| `setup.sh`              | Runtime configuration only — onboard commands, config set, starts stack                        |
| `firewall-bypass`       | Root-only SOCKS proxy script for temporary firewall bypass (chmod 700)                         |
| `.gitignore`            | Excludes `data/` (config + workspace volumes) and `.env`                                       |
| `data/`                 | Created at runtime — bind-mounted as config and workspace volumes (gitignored)                 |

## Separation of Concerns

| Layer                   | Responsibility                                                                 |
| ----------------------- | ------------------------------------------------------------------------------ |
| `Dockerfile`            | Package installs, binary setup, env vars, filesystem permissions, dir creation |
| `firewall-bypass`       | Root-only SOCKS proxy — baked into image at `/usr/local/bin/firewall-bypass`   |
| `sidecar-entrypoint.sh` | iptables REDIRECT, UDP owner-match, exec containerboot (sidecar container)     |
| `entrypoint.sh`         | Permissions fix, sshd, filebrowser, privilege drop (`gosu node`)               |
| `setup.sh`              | Runtime app config only — config set, onboard, stack up, agent prompt write    |

Do NOT put filesystem permissions or binary installs in `setup.sh`. Do NOT put app-level config in the Dockerfile or entrypoint. Networking/iptables belongs in `sidecar-entrypoint.sh`, not `entrypoint.sh`.

## Prerequisites

Build the OpenClaw image first (from the vendor repo):

```bash
cd <vendor-openclaw-repo>
docker build -t openclaw:local -f Dockerfile .
```

## Usage

### Interactive onboard (wizard)

```bash
cd reference/
./setup.sh
```

### Non-interactive onboard (OpenRouter)

```bash
cd reference/
OPENROUTER_API_KEY=sk-or-... ./setup.sh \
  --auth-choice apiKey --token-provider openrouter --token "\$OPENROUTER_API_KEY"
```

### Run arbitrary CLI commands

```bash
docker compose -f docker-compose.yml run --rm openclaw-cli <command> [args...]
# Examples:
docker compose -f docker-compose.yml run --rm openclaw-cli config get gateway.mode
docker compose -f docker-compose.yml run --rm openclaw-cli auth list
docker compose -f docker-compose.yml run --rm openclaw-cli onboard --help
```

### Tear down

```bash
docker compose -f docker-compose.yml down
rm -rf data/   # reset all config/state
```

## Relationship to Pulumi Deployment

The `openclaw-cli` service here mirrors the init container pattern in `components/gateway.ts`:

- Pulumi's init container = `docker run --rm --network none --user node ... openclaw-gateway-<profile>:<version> /tmp/init.sh`
- This reference stack = `docker compose run --rm openclaw-cli <command>`

After the gateway starts, `setup.sh` writes `ocdeploy/AGENTS.md` (root-owned, chmod 444) to the workspace. This mirrors the Pulumi post-deploy `command.remote.Command` resource (`gateway-env-prompt-*`) that runs after the gateway container starts. The file is loaded into the agent's context via the `bootstrap-extra-files` hook.

Once you've verified the right onboard flags and config commands here, translate them to:

1. `setupCommands` in `Pulumi.<stack>.yaml` gateway config (auto-prefixed with `openclaw`)
2. `gatewaySecretEnv-<profile>` for any API keys needed by those commands
