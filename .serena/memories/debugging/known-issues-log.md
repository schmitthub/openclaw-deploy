# Known Issues Log

## Large File Serving via Filebrowser / Tailscale Serve

### Issue #1 — 2026-03-11
**Symptom:** Control UI and filebrowser both became unresponsive while attempting to load a large image through filebrowser.

**Root cause:** Filebrowser serves files through Tailscale Serve's HTTPS reverse proxy (`/browse/` → `http://127.0.0.1:8080`). Large file transfers saturate the Tailscale connection, causing backpressure that affects all services sharing the same Tailscale Serve proxy (control UI on `/`, filebrowser on `/browse/`, SSH on port 22).

**Evidence from logs:**
- `proxy error: dial tcp 127.0.0.1:18789: connect: connection refused` — Tailscale Serve couldn't reach gateway during load
- `netstack: decrementing connsInFlightByClient[100.64.39.79] because the packet was not handled` — packets dropped due to pipeline saturation
- DERP relay flapping (derp-17 LAX connecting/disconnecting every 1-2 min) throughout the incident
- Gateway container itself remained healthy (`docker ps` showed `Up (healthy)`) — issue was at the Tailscale networking layer

**Impact:** All services behind Tailscale Serve become slow or unresponsive until the large transfer completes or times out. Self-resolving once load drops.

**Additional observations (second occurrence, same session):**
- Issue recurred when user attempted to load a large image again in filebrowser
- VPS-side Tailscale logs: DERP-17 (LAX) relay flapping continued (connect/disconnect every 1-2 min)
- macOS client Tailscale logs: **clean** — no errors, no timeouts, all loopback connections succeeded with status 200. Only noise was unrelated `LSCopyDefaultApplicationURLForURL` LaunchServices errors.
- `tailscale ping` showed 232ms latency (expected US→Germany/nbg1)
- Tailscale sidecar NOT OOM — only 33 MiB (0.85%) memory usage
- No new `proxy error` or `packet was not handled` messages in second occurrence — suggests the second bout was milder backpressure
- **Self-recovered** both times without intervention once the large transfer completed/timed out

**Key insight (revised):** The root cause is **Tailscale Serve HTTPS reverse proxy throughput**, NOT file size. Testing showed:
- Filebrowser responds in ~130ms locally inside the container (fast)
- Gateway responds in ~130ms locally (fast)
- Tailscale ping: 235ms direct WireGuard (reasonable US→Germany)
- Tailscale Serve: **2.4s for 5.7KB** = ~2.3 KB/s throughput — orders of magnitude slower than expected
- A 600KB image (not large at all) took minutes to download through filebrowser/Tailscale Serve
- The DERP relay flapping (derp-17 LAX ↔ derp-26 Frankfurt) is a secondary symptom, not the root cause

This is a Tailscale Serve performance limitation, possibly related to shared CPU VPS, TLS termination overhead, or the reverse proxy implementation itself.

**Workarounds (in priority order):**
1. **Wait for self-recovery** — backpressure clears once the large transfer completes or times out (typically 30-60s)
2. **Use `scp` for large files** — direct TCP stream, avoids Tailscale Serve reverse proxy bottleneck:
   ```bash
   scp root@<tailscale-hostname>:/path/to/file ./local-destination
   ```
3. **Avoid previewing large images in filebrowser** — download instead of inline viewing

**Potential fixes (not yet implemented):**
- Rate limiting or max file size in filebrowser config
- Serving large files via a separate mechanism (direct download link, rsync)
- Upgrading to dedicated CPU VPS to reduce hypervisor-induced latency under load
- Adding bandwidth/connection limits to Tailscale Serve (not currently supported upstream)

**Debugging command reference:**
```bash
# macOS client logs (no useful errors found here for this issue)
/usr/bin/log show --predicate 'process == "Tailscale"' --last 10m --info | tail -60

# Local Tailscale connectivity check
tailscale ping <tailscale-hostname>

# VPS-side tailscale logs (where the errors actually appear)
ssh root@<VPS_IP> "docker logs --tail 100 tailscale-<profile>"

# VPS container resource usage
ssh root@<VPS_IP> "docker stats --no-stream"
```

**Environment:** Hetzner cx23 (shared CPU, 4GB RAM), Tailscale v1.94.2, filebrowser via Tailscale Serve reverse proxy
