# TODO

This document covers open features and bugs that I want to address in the future. It is not a roadmap, but rather a collection of ideas and tasks that I may work on at some point.

- [ ] Are we watching for ftp sftp ougoing? Can incoming connections for it work at least? Filesharing is a big one but needs to be secure
- [ ] How is openclaw setup handled. We can't use their interactive installer. we have to run cli commands
- [ ] UDP whitelist: Add "udp" proto to EgressRule, Envoy UDP proxy listeners, iptables UDP DNAT. Enables direct WireGuard instead of DERP.
- [ ] SSH hardening: Short-lived SSH certificates, Pulumi ESC key management, rotate keys.
- [ ] Per-gateway Tailscale authkeys: tailscaleAuthKey-<profile> pattern (like gatewayToken-<profile>) for one-time keys with multi-gateway.
- [ ] Looks like we aren't dynamically adding custom binary installs to the dockerfile for per-deployment skill dependencies
- [ ] Looks like we aren't dynamically running openclaw setup commands for per-deployment customizations
