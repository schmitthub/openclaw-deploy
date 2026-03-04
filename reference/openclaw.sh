#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

# Source .env from parent directory if it exists
if [[ -f "$ROOT_DIR/../.env" ]]; then
  set -a
  source "$ROOT_DIR/../.env"
  set +a
fi

COMPOSE_ARGS=("-f" "$COMPOSE_FILE")

docker compose "${COMPOSE_ARGS[@]}" exec -T openclaw-gateway \
  openclaw "$@"
