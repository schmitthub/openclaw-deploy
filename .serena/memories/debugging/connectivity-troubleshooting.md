# Connectivity Troubleshooting Playbook

## Overview
When gateway services (control UI, filebrowser, SSH) become slow or unresponsive, systematically check each layer: VPS system resources, Docker containers, Tailscale networking, and gateway application logs.

## Step 1: VPS System Resources
Check for RAM/CPU/disk exhaustion on the remote host.

```bash
# Memory, disk, load average
ssh root@<VPS_IP> "free -h && echo '---' && df -h / && echo '---' && uptime"

# Per-container resource usage
ssh root@<VPS_IP> "docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'"

# Kernel logs — check for OOM kills, CPU hogging, hypervisor latency
ssh root@<VPS_IP> "dmesg --time-format iso | tail -30"
```

**What to look for:**
- RAM near total with no available → OOM risk (no swap configured)
- `drain_vmap_area_work hogged CPU` or `hrtimer: interrupt took Xns` → hypervisor latency (shared CPU VPS)
- `Out of memory: Killed process` → OOM killer hit a container

## Step 2: Docker Container Status
Verify all 3 containers are running and healthy.

```bash
ssh root@<VPS_IP> "docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
```

**Expected:** All 3 containers (`tailscale-<profile>`, `envoy-<profile>`, `openclaw-gateway-<profile>`) show `Up` and `(healthy)`.

## Step 3: Tailscale Sidecar Logs
Check for DERP relay flapping, dropped packets, and proxy errors.

```bash
ssh root@<VPS_IP> "docker logs --tail 100 tailscale-<profile> 2>&1"
```

**What to look for:**
- `proxy error: dial tcp 127.0.0.1:<port>: connect: connection refused` → gateway port unreachable, likely overloaded or crashed
- `netstack: decrementing connsInFlightByClient[<ip>] because the packet was not handled` → packets dropped, connection pipeline backed up
- `http: TLS handshake error ... connection reset by peer` → TLS connections dropped mid-handshake
- Rapid `adding connection to derp-N` / `closing connection to derp-N (idle)` cycling → DERP relay flapping, unstable path between client and VPS
- `magicsock: disco: node [XXX] now using <ip>:<port>` alternating ports → WireGuard path renegotiation

## Step 4: Gateway Container Logs
Check for application errors, WebSocket failures, and service issues.

```bash
ssh root@<VPS_IP> "docker logs --tail 100 openclaw-gateway-<profile> 2>&1"
```

**What to look for:**
- `device identity required` (ws code 1008) → client auth/identity issue
- `connect failed` (ws code 4008) → WebSocket connection failures
- `unresolved SecretRef` → missing secret env vars
- Telegram `chat not found` spam → misconfigured chat_id (noisy but not causal)
- Process crashes or restarts

## Step 5: Gateway Process Health
Check processes inside the gateway container.

```bash
ssh root@<VPS_IP> "docker exec openclaw-gateway-<profile> ps aux --sort=-%mem | head -15"
```

**Expected processes:** `openclaw-gateway` (node), `coredns`, `filebrowser`, `sshd`, entrypoint shell, crash monitor sleep.

## Step 6: Tailscale Serve Status
Verify Tailscale Serve is correctly proxying.

```bash
ssh root@<VPS_IP> "docker exec tailscale-<profile> tailscale serve status"
ssh root@<VPS_IP> "docker exec tailscale-<profile> tailscale status"
```

## Step 7: macOS Client Logs (local)
Check Tailscale logs on the client side for path issues.

```bash
# macOS Tailscale GUI logs
log show --predicate 'process == "Tailscale" OR process == "tailscaled"' --last 5m --info

# Or if using CLI tailscale
tailscale status
tailscale ping <tailscale-hostname>
```

## Common Root Causes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| All services slow/unresponsive | DERP relay flapping, large file transfer saturating Tailscale Serve | Use `scp` for large files instead of filebrowser |
| Gateway port connection refused | Gateway process crashed or overloaded | Check gateway logs, restart container |
| Packets not handled | Backpressure from high throughput through reverse proxy | Reduce concurrent load, use direct SSH for transfers |
| Hypervisor CPU hogging in dmesg | Shared CPU VPS noisy neighbor | Consider dedicated CPU VPS |
| High RAM, no swap | OOM risk on 4GB VPS | Monitor gateway RSS, add swap or upgrade |

## Key Details
- VPS IP from `pulumi stack output serverIp`
- Default profile: `main` (containers: `tailscale-main`, `envoy-main`, `openclaw-gateway-main`)
- Gateway port: 18789, filebrowser: 8080, sshd: 2222, CoreDNS: 5300
- Tailscale health endpoint: `http://localhost:9002/healthz`
- DERP-26 is the home relay (Frankfurt); DERP-17 (LAX) is secondary for US clients
