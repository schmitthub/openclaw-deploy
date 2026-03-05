#!/bin/sh
# Tailscale sidecar entrypoint — owns the network namespace.
set -eu

# Get envoy's UID (101 in the official image)
# Exclude envoy from redirect to prevent loop
iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner ${ENVOY_UID:-101} -j RETURN
iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner 0 -j RETURN

# Redirect all other outbound TCP through envoy
iptables -t nat -A OUTPUT -p tcp ! -d 127.0.0.0/8 -j REDIRECT --to-ports 10000


# UDP: tailscaled only + DNS for everyone
# Allow DNS through Docker's embedded resolver (port gets rewritten by DNAT)
iptables -A OUTPUT -p udp -d 127.0.0.11 -j ACCEPT
iptables -A OUTPUT -p udp -m owner --uid-owner root -j ACCEPT
iptables -A OUTPUT -p udp -j DROP

# Hand off to the real tailscale entrypoint
exec /usr/local/bin/containerboot "$@"
