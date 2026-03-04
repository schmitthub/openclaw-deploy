# TODO

This document covers open features and bugs that I want to address in the future. It is not a roadmap, but rather a collection of ideas and tasks that I may work on at some point.

- [ ] Are we watching for ftp sftp ougoing? Can incoming connections for it work at least? Filesharing is a big one but needs to be secure
- [ ] How is openclaw setup handled. We can't use their interactive installer. we have to run cli commands
- [ ] UDP whitelist: Add "udp" proto to EgressRule, Envoy UDP proxy listeners, iptables UDP DNAT. Enables direct WireGuard instead of DERP.
- [ ] SSH hardening: Short-lived SSH certificates, Pulumi ESC key management, rotate keys.
- [ ] Per-gateway Tailscale authkeys: tailscaleAuthKey-<profile> pattern (like gatewayToken-<profile>) for one-time keys with multi-gateway.
- [ ] Looks like we aren't dynamically adding custom binary installs to the dockerfile for per-deployment skill dependencies
- [ ] **Per-command init tracking**: Replace all-or-nothing init container with one `command.remote.Command` per setupCommand, named by content hash. Pulumi tracks each independently — only new/changed commands run. Use `retainOnDelete: true` so removing a command doesn't undo it. Each command runs as an ephemeral `docker run --rm --network none --user node` container with the same bind mounts (config, workspace, home volumes) — pre-configures the gateway's files before the gateway container starts. No `docker exec` (gateway container runs as `node`, no root shell access).
