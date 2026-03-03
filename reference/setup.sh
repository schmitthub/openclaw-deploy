#!/usr/bin/env bash
set -euo pipefail

# OpenClaw gateway setup for Tailscale Serve deployment.
# Mirrors the Pulumi VPS deployment topology locally via Docker Compose.
#
# Prerequisites:
#   - .env file in parent directory with OPENROUTER_API_KEY and TAILSCALE_DEVICE_KEY
#   - Docker image built: docker compose build openclaw-gateway
#   - Envoy running: docker compose up -d envoy
#
# Usage:
#   ./setup.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

# Source .env from parent directory if it exists
if [[ -f "$ROOT_DIR/../.env" ]]; then
  set -a
  source "$ROOT_DIR/../.env"
  set +a
fi

# Auth provider config — adjust per deployment:
#   Anthropic:   AUTH_CHOICE=token  TOKEN_PROVIDER=anthropic  TOKEN=$ANTHROPIC_API_KEY
#   OpenRouter:  AUTH_CHOICE=openrouter-api-key  (uses --openrouter-api-key flag)
#   OpenAI:      AUTH_CHOICE=openai-api-key      (uses --openai-api-key flag)
AUTH_CHOICE="openrouter-api-key"
AUTH_KEY="${OPENROUTER_API_KEY:-}"

if [[ -z "$AUTH_KEY" ]]; then
  echo "ERROR: OPENROUTER_API_KEY not set. Add it to ../.env" >&2
  exit 1
fi

# Data directories (local to this reference dir)
export OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$ROOT_DIR/data/config}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$ROOT_DIR/data/workspace}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

# Gateway auth token — pre-generated so it can be passed to both onboard and compose.
# In Pulumi this is a random.RandomPassword stored in state.
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
fi
export OPENCLAW_GATEWAY_TOKEN

COMPOSE_ARGS=("-f" "$COMPOSE_FILE")

# Create data directories
mkdir -p "$OPENCLAW_CONFIG_DIR/identity"
mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/agent"
mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/sessions"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"

echo "==> Config dir:  $OPENCLAW_CONFIG_DIR"
echo "==> Workspace:   $OPENCLAW_WORKSPACE_DIR"
echo ""

# Fix permissions (same as upstream docker-setup.sh)
echo "==> Fixing data-directory permissions"
docker compose "${COMPOSE_ARGS[@]}" run --rm --user root --entrypoint sh openclaw-cli -c \
  'find /home/node/.openclaw -xdev -exec chown node:node {} +; \
   [ -d /home/node/.openclaw/workspace/.openclaw ] && chown -R node:node /home/node/.openclaw/workspace/.openclaw || true'

echo ""
echo "==> Running onboard"
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli onboard \
  --non-interactive \
  --tailscale serve \
  --accept-risk \
  --mode local \
  --gateway-bind loopback \
  --gateway-token "$OPENCLAW_GATEWAY_TOKEN" \
  --no-install-daemon \
  --auth-choice "$AUTH_CHOICE" \
  --openrouter-api-key "$AUTH_KEY" \
  --skip-channels \
  --skip-skills \
  --skip-daemon \
  --skip-health

echo ""
echo "==> Setting security config"
# gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: True. Unfortunate hack around for Non-interactive bug that doesn't seed the tailnet origin
# https://github.com/openclaw/openclaw/issues/27877
# Additionally have to set trusted proxy like this due to more bugs.
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true >/dev/null
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set gateway.auth.mode trusted-proxy >/dev/null
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set gateway.trustedProxies '["127.0.0.1"]' >/dev/null
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set gateway.auth.trustedProxy.userHeader tailscale-user-login >/dev/null
echo "Set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true"

echo ""
echo "==> Setting control UI base path"
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
    config set gateway.controlUi.basePath /openclaw

echo ""
echo "==> Setting memory search config"
# Use the "openai" provider (OpenAI-compatible API)
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set agents.defaults.memorySearch.provider openai
# Point it at OpenRouter's base URL
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set agents.defaults.memorySearch.remote.baseUrl "https://openrouter.ai/api/v1"
# Set your OpenRouter API key for embeddings
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set agents.defaults.memorySearch.remote.apiKey '{"source":"env","provider":"default","id":"OPENROUTER_API_KEY"}'
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set agents.defaults.memorySearch.model "openai/text-embedding-3-small"

echo ""
echo "==> Setting web search config"
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set tools.web.search.provider brave
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set tools.web.search.apiKey '{"source":"env","provider":"default","id":"BRAVE_API_KEY"}'

echo ""
echo "==> Setting Discord config"
if [[ -z "${DISCORD_BOT_TOKEN:-}" ]] || [[ -z "${DISCORD_USER_ID:-}" ]] || [[ -z "${DISCORD_SERVER_ID:-}" ]]; then
  echo "WARN: Skipping Discord config — DISCORD_BOT_TOKEN, DISCORD_USER_ID, or DISCORD_SERVER_ID not set" >&2
else
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set channels.discord.token '{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}'
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set channels.discord.allowFrom "[\"$DISCORD_USER_ID\"]"
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set channels.discord.dmPolicy allowlist
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set channels.discord.groupPolicy allowlist
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set channels.discord.guilds "{\"$DISCORD_SERVER_ID\": {\"users\": [\"$DISCORD_USER_ID\"], \"requireMention\": false}}"
fi

echo ""
echo "==> Starting Stack"
docker compose "${COMPOSE_ARGS[@]}" up -d

echo ""
echo "Gateway running with Tailscale Serve on port $OPENCLAW_GATEWAY_PORT"
echo ""
echo "Commands:"
echo "  cd $ROOT_DIR"
echo "  docker compose ${COMPOSE_ARGS[*]} logs -f openclaw-gateway"
echo "  docker compose ${COMPOSE_ARGS[*]} run --rm openclaw-cli <command>"
echo "  docker compose ${COMPOSE_ARGS[*]} down"
