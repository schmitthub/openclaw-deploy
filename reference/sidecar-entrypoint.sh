#!/bin/sh
# Tailscale sidecar entrypoint — owns the network namespace.
set -eu

# Get envoy's UID (101 in the official image)
# Exclude envoy from redirect to prevent loop
iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner ${ENVOY_UID:-101} -j RETURN
iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner 0 -j RETURN

# Redirect all other outbound TCP through envoy
iptables -t nat -A OUTPUT -p tcp ! -d 127.0.0.0/8 -j REDIRECT --to-ports 10000


# Allow DNS to localhost (envoy's listener)
iptables -A OUTPUT -p udp -d 127.0.0.0/8 --dport 53 -j ACCEPT

# UDP: only tailscaled (root) can send
iptables -A OUTPUT -p udp -m owner --uid-owner root -j ACCEPT

# Envoy upstream DNS
iptables -A OUTPUT -p udp --dport 53 -m owner --uid-owner ${ENVOY_UID:-101} -j ACCEPT

# Block everything else
iptables -A OUTPUT -p udp -j DROP

# Hand off to the real tailscale entrypoint
exec /usr/local/bin/containerboot "$@"
