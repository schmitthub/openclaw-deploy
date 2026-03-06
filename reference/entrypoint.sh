#!/bin/bash
# Gateway entrypoint — runs inside the sidecar's shared network namespace.
# This entrypoint only handles application-level setup:
set -euo pipefail

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

# start sshd for Tailscale Serve TCP forwarding (configured in serve-config.json).
/usr/sbin/sshd

# Start CoreDNS allowlist proxy (mandatory — runs as root so upstream queries bypass UDP DROP).
# Listens on port 5300; sidecar iptables redirects uid 1000 DNS here.
if [ ! -x /usr/local/bin/coredns ]; then
  echo "ERROR: coredns binary not found at /usr/local/bin/coredns" >&2
  exit 1
fi
if [ ! -f /etc/coredns/Corefile ]; then
  echo "ERROR: CoreDNS Corefile not found at /etc/coredns/Corefile" >&2
  exit 1
fi
/usr/local/bin/coredns -conf /etc/coredns/Corefile -dns.port 5300 &
sleep 0.5
if ! pgrep -x coredns >/dev/null 2>&1; then
  echo "ERROR: CoreDNS exited immediately after start — DNS allowlist is NOT active" >&2
  exit 1
fi

# Start filebrowser on loopback (accessible only via Tailscale Serve at /browse).
if command -v filebrowser >/dev/null 2>&1; then
  gosu node filebrowser --address 127.0.0.1 --port 8080 --noauth --root /home/node --baseurl /browse &
fi

# Drop privileges and exec the CMD as the node user.
exec gosu node "$@"
