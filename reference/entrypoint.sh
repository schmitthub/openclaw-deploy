#!/bin/bash
# Gateway entrypoint — runs inside the sidecar's shared network namespace.
# The sidecar container handles all networking (iptables, routing, tailscaled).
# This entrypoint only handles application-level setup:
# 1. Wait for Tailscale socket from sidecar
# 2. Start web tools (ttyd, filebrowser) on loopback
# 3. Configure Tailscale Serve paths
# 4. Fix permissions and drop to node user
set -euo pipefail

# TS_SOCKET_PATH="/var/run/tailscale/tailscaled.sock"

# # Wait for Tailscale socket from sidecar (shared volume).
# # The sidecar starts tailscaled and creates the socket. We need it for
# # tailscale serve commands and for OpenClaw to manage Tailscale Serve paths.
# echo "Waiting for Tailscale socket from sidecar..."
# for i in $(seq 1 60); do
#   [ -S "$TS_SOCKET_PATH" ] && break
#   sleep 1
# done
# if [ ! -S "$TS_SOCKET_PATH" ]; then
#   echo "ERROR: Tailscale socket did not appear in 60s — is the sidecar container running?" >&2
#   exit 1
# fi
# echo "Tailscale socket found."

# # Wait for Tailscale to reach Running state.
# for i in $(seq 1 30); do
#   TS_STATE="$(tailscale --socket="$TS_SOCKET_PATH" status --json 2>/dev/null | jq -r '.BackendState' 2>/dev/null)" || true
#   [ "$TS_STATE" = "Running" ] && break
#   sleep 1
# done
# if [ "$TS_STATE" != "Running" ]; then
#   echo "WARN: Tailscale not in Running state after 30s (state=$TS_STATE)" >&2
# fi

# # Start web tools on loopback (accessible only via Tailscale Serve).
# if command -v ttyd >/dev/null 2>&1; then
#   ttyd --port 7681 --interface lo --writable bash &
# fi
# if command -v filebrowser >/dev/null 2>&1; then
#   gosu node filebrowser --address 127.0.0.1 --port 8080 --noauth --root /home/node --baseurl /files &
# fi

# # Configure Tailscale Serve paths for web tools.
# tailscale --socket="$TS_SOCKET_PATH" serve --bg --set-path /shell 7681 2>&1 || echo "WARN: Failed to configure Tailscale Serve path /shell" >&2
# tailscale --socket="$TS_SOCKET_PATH" serve --bg --set-path /files 8080 2>&1 || echo "WARN: Failed to configure Tailscale Serve path /files" >&2


# Tighten config dir permissions (bind mounts inherit host perms, this fixes both sides).
chown node:node /home/node/.openclaw 2>/dev/null || true
chmod 700 /home/node/.openclaw 2>/dev/null || true

# Fix git safe.directory for linuxbrew repo (volume UID mismatch).
# Homebrew repos are owned by the linuxbrew user but node runs brew.
# Git refuses to operate on repos owned by a different user without this exception.
if command -v git >/dev/null 2>&1; then
  gosu node git config --global --get-all safe.directory 2>/dev/null \
    | grep -qF "/home/linuxbrew/.linuxbrew/Homebrew" \
    || gosu node git config --global --add safe.directory /home/linuxbrew/.linuxbrew/Homebrew
fi

# Drop privileges and exec the CMD as the node user.
exec gosu node "$@"
