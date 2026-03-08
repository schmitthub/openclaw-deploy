#!/usr/bin/env bash
set -euo pipefail

# Updates digest-pinned base images in config/defaults.ts.
# Fetches current multi-arch manifest digests via `docker buildx imagetools inspect`
# and replaces the @sha256:... suffix in-place.
#
# Usage: ./scripts/update-base-digests.sh
# Requires: docker with buildx + imagetools support, jq

DEFAULTS_FILE="config/defaults.ts"

if [ ! -f "$DEFAULTS_FILE" ]; then
  echo "ERROR: $DEFAULTS_FILE not found. Run from repo root." >&2
  exit 1
fi

# image:tag pairs to pin (without digest)
IMAGES=(
  "node:22-bookworm"
  "debian:bookworm-slim"
  "tailscale/tailscale:v1.94.2"
  "envoyproxy/envoy:v1.33-latest"
)

changed=0

for image in "${IMAGES[@]}"; do
  printf "  %-40s " "$image"

  # Get the manifest LIST digest (multi-arch), not a platform-specific digest.
  # docker buildx imagetools inspect returns the list digest, which lets Docker
  # select the correct platform at pull time.
  digest=$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' 2>/dev/null \
    | jq -r '.digest // empty' 2>/dev/null) || true

  if [ -z "$digest" ]; then
    echo "ERROR: failed to get digest (is Docker running?)" >&2
    exit 1
  fi

  if grep -q "$digest" "$DEFAULTS_FILE"; then
    echo "up to date"
  else
    echo "UPDATED -> ${digest:0:19}..."
    changed=$((changed + 1))
  fi

  # Escape dots and slashes for sed
  escaped_image=$(printf '%s' "$image" | sed 's|[./]|\\\0|g')

  # Replace existing pinned reference: "image@sha256:old" -> "image@sha256:new"
  sed -i'' -e "s|\"${escaped_image}@sha256:[a-f0-9]*\"|\"${image}@${digest}\"|g" "$DEFAULTS_FILE"

  # Replace unpinned reference: "image" -> "image@sha256:new" (first pin)
  sed -i'' -e "s|\"${escaped_image}\"|\"${image}@${digest}\"|g" "$DEFAULTS_FILE"
done

# Clean up sed backup files (macOS sed -i'' creates them)
rm -f "${DEFAULTS_FILE}-e" "${DEFAULTS_FILE}''"

if [ "$changed" -eq 0 ]; then
  echo "All digests already up to date."
else
  echo "$changed image(s) updated. Review: git diff $DEFAULTS_FILE"
fi
