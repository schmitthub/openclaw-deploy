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

| File                 | Description                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `docker-compose.yml` | Two-service stack: `openclaw-gateway` (server) + `openclaw-cli` (ephemeral CLI runner)   |
| `setup.sh`           | Adapted setup script — builds data dirs, fixes permissions, runs onboard, starts gateway |
| `.gitignore`         | Excludes `data/` (config + workspace volumes) and `.env`                                 |
| `data/`              | Created at runtime — bind-mounted as config and workspace volumes (gitignored)           |

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

Once you've verified the right onboard flags and config commands here, translate them to:

1. `setupCommands` in `Pulumi.<stack>.yaml` gateway config (auto-prefixed with `openclaw`)
2. `gatewaySecretEnv-<profile>` for any API keys needed by those commands
