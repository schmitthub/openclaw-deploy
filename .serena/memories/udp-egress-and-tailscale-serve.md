# UDP Egress Support + Tailscale Serve in Container

## End Goal
Implement full UDP egress support via Envoy proxy and get Tailscale Serve working inside gateway containers. This is part of the broader "Tailscale in Container + Simplified Bootstrap" initiative.

## Plan File
Claude Code plan: `/Users/andrew/.claude/plans/validated-zooming-parasol.md`

## Background Context
- UAT deployment to Hetzner (`hetzner-uat` stack) revealed cascading issues when Tailscale was moved from host into gateway containers.
- The original plan called for UDP egress support but it was incorrectly deferred as "Future Work."
- Without UDP, Tailscale can't do STUN for NAT traversal, and `tailscale serve` had issues.
- `*.tailscale.com` wildcard was a security risk — attacker-controlled Tailscale networks use subdomains.
- User was very clear: implement what was agreed, don't cut scope.

## Key Debugging Lessons (from prior sessions)
- **Envoy `dns_lookup_family`**: Must be `V4_PREFERRED`, not `AUTO`. Docker networks are IPv4-only.
- **`docker exec -u node`**: Config commands must run as node user to avoid root-owned files.
- **TS_SOCKET env var**: Required for `tailscale` CLI to find daemon socket inside container.
- **No Tailscale wildcards**: Enumerate specific domains (controlplane, login, log, derp1–28).
- **Mapping env var format**: Pipe-delimited fields (`dst|dstPort|envoyPort`), semicolon-separated entries.

## Implementation Status

### DONE
- [x] Move Tailscale from host to gateway containers (prior session)
- [x] Simplify bootstrap to Docker-only + fail2ban (prior session)
- [x] Use public IP for all host connections (prior session)
- [x] Add Tailscale domains to TLS egress whitelist (prior session)
- [x] Fix Envoy `dns_lookup_family` from AUTO to V4_PREFERRED (prior session)
- [x] Fix `docker exec -u node` for config commands (prior session)
- [x] Add `TS_SOCKET` env var for Tailscale CLI (prior session)
- [x] Fix `*.tailscale.com` wildcard → enumerated 28 DERP TLS + 4 control plane domains
- [x] Fix `HARDCODED_EGRESS_RULES` compilation error (renamed reference)
- [x] Add `"udp"` proto to `EgressRule` type + `UdpPortMapping` interface
- [x] Add `ENVOY_UDP_PORT_BASE = 10100` constant
- [x] Add `TAILSCALE_UDP_DOMAINS` (28 DERP servers on UDP 3478) to hardcoded rules
- [x] Implement Envoy UDP proxy listeners (`renderUdpListener`) and clusters (`renderUdpCluster`)
- [x] Add `case "udp":` to `renderEnvoyConfig` switch
- [x] Add `OPENCLAW_UDP_MAPPINGS` processing to `entrypoint.ts` (UDP DNAT rules)
- [x] Wire `udpPortMappings` through EnvoyEgress → Gateway → container env vars
- [x] Update all tests (249 pass)
- [x] Update AGENTS.md, docker-and-shell.md, pulumi-config.md documentation
- [x] Type-check passes (`npx tsc --noEmit`)

### TODO
- [ ] Deploy to Hetzner (`pulumi up --stack hetzner-uat`) — user destroyed previous resources
- [ ] Verify Tailscale authenticates via DERP relay (STUN UDP should now work through Envoy)
- [ ] Verify `tailscale serve` works with HTTP mode (not HTTPS to avoid cert transparency)
- [ ] Verify gateway accessible via Tailscale hostname
- [ ] End-to-end test: egress isolation working, AI provider domains reachable
- [ ] Consider whether `tailscale serve --http` is the right flag for HTTP-only mode

## Branch
`fix/uat-findings` — all changes are unstaged

## Files Modified (this session)
- `config/domains.ts` — Wildcard removal, DERP TLS enumeration, HARDCODED_EGRESS_RULES fix
- `config/defaults.ts` — ENVOY_UDP_PORT_BASE
- `config/types.ts` — "udp" proto, UdpPortMapping
- `templates/envoy.ts` — UDP listener/cluster rendering
- `templates/entrypoint.ts` — OPENCLAW_UDP_MAPPINGS processing
- `templates/index.ts` — UdpPortMapping export
- `components/envoy.ts` — udpPortMappings output
- `components/gateway.ts` — udpPortMappings arg, OPENCLAW_UDP_MAPPINGS env var
- `index.ts` — Pass udpPortMappings to gateways
- `tests/config.test.ts` — Updated for new domain structure
- `tests/envoy.test.ts` — UDP egress tests
- `tests/templates.test.ts` — UDP mapping entrypoint tests
- `AGENTS.md` — Updated invariants, deployment model, whitelist
- `.claude/rules/docker-and-shell.md` — UDP docs
- `.claude/rules/pulumi-config.md` — Updated args

## IMPORTANT
Always check with the user before proceeding with the next todo item. If all work is done, ask the user if they want to delete this memory.
