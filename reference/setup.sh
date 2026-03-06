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

echo ""
echo "==> Starting Envoy and Tailscale"

docker compose -f "$COMPOSE_FILE" up -d envoy tailscale-sidecar


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
# In Pulumi this is a random.RandomPassword stored in state (use pulumi.secret()).
# The token may appear in init container logs/command args. This is acceptable because
# the gateway is only reachable via Tailscale Serve — an attacker would need both the
# token AND authenticated access to the user's Tailscale account to reach the gateway.
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
# mkdir -p "$ROOT_DIR/data/tailscale"

echo "==> Config dir:  $OPENCLAW_CONFIG_DIR"
echo "==> Workspace:   $OPENCLAW_WORKSPACE_DIR"
echo ""

# Build image first (needed for seeding and all subsequent steps).
echo "==> Building image"
docker compose "${COMPOSE_ARGS[@]}" build openclaw-gateway

echo ""
echo "==> Running onboard"
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli onboard \
  --non-interactive \
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
echo "==> Waiting for tailscale config"
TAILSCALE_SERVE_JSON=""
TAILSCALE_SERVE_HOST=""
TAILSCALE_SERVE_MAX_RETRIES="${TAILSCALE_SERVE_MAX_RETRIES:-30}"
TAILSCALE_SERVE_RETRY_DELAY="${TAILSCALE_SERVE_RETRY_DELAY:-2}"

for attempt in $(seq 1 "$TAILSCALE_SERVE_MAX_RETRIES"); do
  TAILSCALE_SERVE_JSON="$(docker compose "${COMPOSE_ARGS[@]}" exec -T tailscale-sidecar sh -c 'tailscale serve status -json' 2>/dev/null || true)"
  TAILSCALE_SERVE_HOST="$(printf '%s\n' "$TAILSCALE_SERVE_JSON" | jq -r '.Web | keys[0] // empty | sub(":\\d+$"; "")' 2>/dev/null || true)"

  if [[ -n "$TAILSCALE_SERVE_HOST" ]]; then
    break
  fi

  if [[ "$attempt" -lt "$TAILSCALE_SERVE_MAX_RETRIES" ]]; then
    sleep "$TAILSCALE_SERVE_RETRY_DELAY"
  fi
done

if [[ -n "$TAILSCALE_SERVE_HOST" ]]; then
  echo "==> Tailscale Serve host: $TAILSCALE_SERVE_HOST"
else
  echo "WARN: Could not extract Tailscale Serve host from tailscale serve status after $TAILSCALE_SERVE_MAX_RETRIES attempts" >&2
fi

echo ""
echo "==> Setting security config"
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
    config set gateway.controlUi.allowedOrigins \
    "[\"https://${TAILSCALE_SERVE_HOST}\", \"http://localhost:18789\", \"http://127.0.0.1:18789\"]"

docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set gateway.auth.allowTailscale true >/dev/null
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set gateway.controlUi.dangerouslyDisableDeviceAuth true >/dev/null
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set tools.profile full >/dev/null
# Trust Tailscale Serve's loopback proxy so the gateway treats proxied connections
# as local. Without this, the Control UI is read-only (Save button muted).
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set gateway.trustedProxies "[\"127.0.0.1/8\"]" >/dev/null

echo ""
echo "==> Setting browser config"
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set browser.headless true >/dev/null
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set browser.noSandbox true >/dev/null

echo ""
echo "==> Setting pnpm as node manager"
# has to be done here if --skip-skills is used during onboarding
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set skills.install.nodeManager pnpm

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
echo "==> Setting required files config (agent environment prompt)"

docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  hooks enable bootstrap-extra-files
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli \
  config set hooks.internal.entries.bootstrap-extra-files.paths '["ocdeploy/AGENTS.md"]'

echo ""
echo "==> Starting Stack"
docker compose "${COMPOSE_ARGS[@]}" up openclaw-gateway -d --build

echo ""
echo "==> Writing agent constraints to workspace/ocdeploy/AGENTS.md"
ENV_PROMPT_CONTENT='<environment>
## Environment Constraints
I am running in a customized container stack managed by Pulumi IaC controlled by my user and not in openclaw gateway'"'"'s native sandbox mode.
- **Gateway Restarts:** The `openclaw gateway restart` command, or any self-restart capability, **will not work**. Risky changes to configurations can crash the entire gateway process and it will be unrecoverable. I must always ask my user to manually restart the container when a configuration change requires it because there is no virtual way for me to do it myself. Do not attempt to run it myself or assume I can successfully restart. Without their direct availability and assistance, any operation requiring a restart will leave me stuck in the prior state.
- **Config Management:** My configuration is managed via Pulumi (Infrastructure as Code). Since any manual modifications to `openclaw.json` could be destroyed on the next IaC deploy, it is better to provide my user with the exact `openclaw config set ...` command they need so they can add it to the Pulumi IaC configuration and persist it properly.
- **Firewall Restrictions:** I am heavily locked down with outbound connections blocked on TCP and UDP.  My firewall configuration is managed externally over the internet by Pulumi in a different environment. There are two ways to get internet access:
  - **Permanent access** (new API, recurring service): Ask my user to add a route/whitelist entry in the Pulumi config. Provide the exact hostname and port needed.
  - **Temporary access** (one-off download, quick fetch): Ask my user to open the SOCKS tunnel. They can open a SOCKS5 proxy on `localhost:9100` for a short window (default 30 seconds). Route requests through it: `curl --socks5 localhost:9100 https://example.com`. The tunnel auto-closes after the timeout. I cannot open it myself, my user and I lack the ability to grant me the permissions to do so. I must have my exact command ready BEFORE asking my user to open the tunnel — there is no time to figure it out after it opens.

!IMPORTANT: THIS IS IAC AUTOGENERATED. ANY ALTERATION WILL RESULT IN IT BEING REWRITTEN
</environment>'

ENV_PROMPT_B64=$(printf '%s\n' "$ENV_PROMPT_CONTENT" | base64)

docker compose "${COMPOSE_ARGS[@]}" exec -T openclaw-gateway sh -c "
  set -e
  mkdir -p /home/node/.openclaw/workspace/ocdeploy
  echo '$ENV_PROMPT_B64' | base64 -d > /home/node/.openclaw/workspace/ocdeploy/AGENTS.md
  chown root:root /home/node/.openclaw/workspace/ocdeploy/AGENTS.md
  chmod 444 /home/node/.openclaw/workspace/ocdeploy/AGENTS.md
"

echo ""
echo "Gateway running — Tailscale Serve URLs:"
echo "  https://${TAILSCALE_SERVE_HOST}#token=$OPENCLAW_GATEWAY_TOKEN  (Control UI)"
echo "  https://${TAILSCALE_SERVE_HOST}/browse/  (File Browser)"
