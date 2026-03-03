# UAT End-to-End Validation — Local Reference Stack + VPS Deploy

## End Goal
Validate the full OpenClaw gateway deployment end-to-end locally using `reference/` Docker Compose stack (mirrors VPS topology), then deploy to Hetzner UAT and confirm: gateway starts, Tailscale Serve exposes it on tailnet, user can access web UI with gateway token.

## Background Context

### What This Is
- `reference/` directory in openclaw-deploy contains a Docker Compose stack that mirrors the VPS deployment: Envoy (internal+egress networks), gateway with our custom entrypoint (iptables DNAT, Tailscale), CLI service for config/onboard commands.
- Built from our own templates: `Dockerfile`, `entrypoint.sh`, `envoy.yaml` all generated via `node -e "require('./dist/templates')..."`.
- Image `openclaw-gateway:local` is built and available in local Docker registry.

### Key Findings (Confirmed Locally)

1. **Correct onboard flags for OpenRouter:**
   ```
   onboard --non-interactive --accept-risk --auth-choice openrouter-api-key --openrouter-api-key "$OPENROUTER_API_KEY" --skip-channels --skip-skills --skip-daemon --skip-health
   ```
   - `--auth-choice apiKey` = Anthropic ONLY (requires `--anthropic-api-key`)
   - `--auth-choice token --token-provider openrouter` = FAILS ("Only anthropic supported")
   - The OpenRouter docs example is WRONG

2. **gateway.bind must NOT be set when Tailscale Serve is enabled:**
   - `--tailscale serve` requires `bind=loopback`
   - `onboard --mode local` defaults to `bind=loopback` — correct
   - Pulumi `requiredConfig` does NOT include `gateway.bind` — correct
   - Our local test incorrectly set `gateway.bind=lan` causing: `tailscale serve/funnel requires gateway bind=loopback`

3. **Tailscale Serve needs `--operator` flag:**
   - Last error: `serve config denied ... Use 'sudo tailscale serve' ... or 'sudo tailscale set --operator=$USER'`
   - `tailscale serve` runs as `node` user (after gosu drop) but `tailscaled` was started by root
   - Fix needed: add `tailscale set --operator=node` in entrypoint.sh AFTER tailscale authenticates, BEFORE dropping to node user

4. **Entrypoint getent fix:** `getent hosts envoy` silently returns exit code 2 with `set -euo pipefail`. Fixed with `|| true` + retry loop (up to 10s). Already in codebase.

5. **Init container workspace mount:** `openclaw onboard` writes AGENTS.md to workspace. Init container must mount workspace volume too. Already fixed in `components/gateway.ts`.

6. **Pulumi command rebuild trigger:** Changing uploaded files (entrypoint.sh) does NOT trigger `buildImage` re-run. Pulumi only detects `create` string changes. Need content-hash trigger or manual rebuild. NOT YET FIXED.

### Hetzner UAT Stack State
- Stack `hetzner-uat` — resources were being destroyed (user ran destroy). Status unknown.
- Branch: `fix/uat-findings`
- Server IP was: 46.224.86.79

### Files Modified (on branch fix/uat-findings)
- `templates/entrypoint.ts` — getent retry loop fix
- `components/gateway.ts` — workspace volume mount in init container, setupCommands, secretEnv
- `index.ts` — auto-generated gateway tokens via @pulumi/random, secretEnv loading, token export
- `config/types.ts` — setupCommands field on GatewayConfig
- `Pulumi.hetzner-uat.yaml` — UAT stack config with correct onboard flags
- `Pulumi.dev.yaml.example` — updated example with correct flags
- `reference/` — full local test harness (docker-compose.yml, Dockerfile, entrypoint.sh, envoy.yaml, setup.sh)
- `package.json` — @pulumi/random dependency
- AGENTS.md, .claude/rules/* — documentation updates

### Env Vars (in ../.env)
- `TAILSCALE_DEVICE_KEY` — maps to `TAILSCALE_AUTHKEY` in compose
- `OPENROUTER_API_KEY` — used by onboard command
- `OPENCLAW_GATEWAY_TOKEN` — auto-generated per run, stored in `data/.token`

## TODO Sequence

- [x] Fix entrypoint getent hosts envoy crash (exit code 2, empty logs) — retry loop + || true
- [x] Fix init container missing workspace volume mount
- [x] Confirm correct onboard CLI flags for OpenRouter (openrouter-api-key, not apiKey)
- [x] Update Pulumi.hetzner-uat.yaml with correct flags
- [x] Build reference/ Docker Compose stack mirroring VPS topology
- [x] Generate Dockerfile, entrypoint.sh, envoy.yaml from templates into reference/
- [x] Test onboard + config set locally via CLI container
- [x] Test gateway startup with Envoy (healthy, agent model correct)
- [x] Test gateway health check via `openclaw health --token`
- [x] Test Tailscale authentication (tailscaled starts, authenticates, reaches DERP relay)
- [ ] **Fix Tailscale Serve permission error** — add `tailscale set --operator=node` in entrypoint.sh after auth, before gosu drop
- [ ] Re-test locally: gateway + Tailscale Serve working end-to-end
- [ ] Test accessing gateway via Tailscale tailnet URL from host
- [ ] Fix Pulumi buildImage trigger (content-hash so entrypoint changes trigger rebuild)
- [ ] Destroy old hetzner-uat resources if not already done
- [ ] Deploy to Hetzner UAT with all fixes
- [ ] Verify on VPS: gateway healthy, Tailscale Serve active, web UI accessible via tailnet with token
- [ ] Clean up: remove Tailscale device from admin console if test devices accumulated

## Reference Files
- Plan file: /Users/andrew/.claude/plans/parsed-pondering-wall.md (may be stale)
- Reference stack: /Users/andrew/Code/openclaw-deploy/reference/
- Upstream OpenClaw repo: /Users/andrew/Code/vendor/openclaw/openclaw

## IMPERATIVE
Always check with the user before proceeding with the next todo item. Do not proceed autonomously through the list. If all work is done, ask the user if they want to delete this memory.
