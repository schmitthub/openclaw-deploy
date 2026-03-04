# Named Volumes Migration & Control UI Fixes

## End Goal
1. Switch home + linuxbrew from bind mounts to named Docker volumes (eliminates seed steps and Mac permission issues)
2. Fix Control UI so user can edit settings and install skills
3. Fix Homebrew permissions so `brew install` works at runtime as `node` user
4. Fix directory ownership so init container can write config

## Branch
`fix/openclaw-doctor`

## Hetzner UAT Stack Info
- Stack: `hetzner-uat`
- Server IP: `46.224.86.79`
- Tailscale hostname: `18980d6e7b76.taildc11cf.ts.net`
- 28 resources deployed, all 260 tests pass
- Token: set via `pulumi config set --secret gatewayToken-uat` (matches openclaw.json)

## Local Reference Stack
- Tailscale hostname: `051a5204cead.taildc11cf.ts.net`

## What Was Done

### Named Volumes (DONE — both stacks)
- `reference/docker-compose.yml`: Named volumes `openclaw-home`, `openclaw-linuxbrew` instead of bind mounts
- `components/gateway.ts`: `docker.Volume` resources, removed `seedHome` and `fixPermissions` commands
- Init container mounts named volume (`-v openclaw-home-${profile}:/home/node`)

### Git safe.directory Fix (DONE — both stacks)
- `reference/entrypoint.sh` and `templates/entrypoint.ts`: Added `gosu node git config --global --add safe.directory /home/linuxbrew/.linuxbrew/Homebrew`

### trustedProxies (DONE — both stacks)
- `config set gateway.trustedProxies '["127.0.0.1/8"]'` in setupCommands

### tools.profile full (DONE — UAT stack)
- Added `config set tools.profile full` to `Pulumi.hetzner-uat.yaml` setupCommands
- NOT yet in `Pulumi.dev.yaml.example`

### Homebrew chmod Fix (DONE — both stacks)
- **Root cause**: `chmod -R g+rwx "/home/linuxbrew"` ran BEFORE the Homebrew install script, so installer-created files had default umask (755 dirs, no group write)
- **Fix**: Moved `chmod -R g+rwx "/home/linuxbrew"` to AFTER the install in both `reference/Dockerfile` and `templates/dockerfile.ts`

### Home directory ownership fix (DONE — both stacks)
- **Root cause**: Playwright install creates `/home/node/.cache` as root; other root-level RUN steps create root-owned files in `/home/node`
- **Fix**: Added `RUN chown -R node:node /home/node` right before the entrypoint COPY in both Dockerfile and template
- This catches `.cache`, `.local`, and any other root-created files

### Host directory ownership fix (DONE — Pulumi component)
- **Root cause**: `mkdir -p` in `createDirs` runs as root (SSH), so config/workspace dirs are root:root. Init container runs `--user node` and can't write.
- **Fix**: Added `&& chown -R 1000:1000 ${dataDir}/config ${dataDir}/workspace` to `createDirs` command in `components/gateway.ts`

### Go egress domains (DONE — reference + UAT only, NOT hardcoded)
- Added `proxy.golang.org`, `sum.golang.org`, `storage.googleapis.com` to `reference/envoy.yaml` server_names
- Added to `Pulumi.hetzner-uat.yaml` egressPolicy as user rules
- NOT in `config/domains.ts` hardcoded rules (Go is optional, installed via brew)

### Gateway token fix (DONE)
- Set `pulumi config set --secret gatewayToken-uat` to match the token in openclaw.json
- Token in config file is authoritative — env var does NOT override it despite AGENTS.md claiming it does

### Dockerfile CMD (DONE — template)
- Added `--bind loopback --tailscale serve` to template CMD to match reference Dockerfile

### Duplicate envoy domain cleanup (DONE)
- Removed duplicate `proxy.golang.org` from reference/envoy.yaml

## Key Bugs Found & Fixed

- **Named volumes don't repopulate from new images**: Docker only auto-populates on first create. If image changes affect volume contents (e.g., new chown), the existing volume keeps stale data. Had to `pulumi destroy` + `pulumi up` to get fresh volumes.
- **OPENCLAW_GATEWAY_TOKEN env var does NOT take precedence**: Despite AGENTS.md/CLAUDE.md claiming it does, the config file token is authoritative. Must set `gatewayToken-<profile>` in Pulumi config to match.
- **Init container skip-all bug**: The init checks `jq -e '.gateway.auth.token'` and skips ALL setupCommands if config exists. New commands never run on subsequent deploys.
- **ffmpeg install timeout**: UI has 2-minute timeout. Large brew packages (ffmpeg) exceed this. Install likely completes but UI reports failure.

## Root Cause Analysis — Control UI Read-Only
- Browser session is an unpaired virtual device. Gateway requires device pairing for write access.
- `dangerouslyDisableDeviceAuth=true` doesn't auto-pair. `trustedProxies` doesn't grant write.
- **Workaround**: `tools.profile full` during init gives agent full tool access.
- User said not to chase this further right now.

## TODO Sequence
- [x] Switch home + linuxbrew to named Docker volumes (both stacks)
- [x] Remove seed steps and fix-permissions steps (both stacks)
- [x] Add git safe.directory fix to entrypoint (both stacks)
- [x] Add trustedProxies config (both stacks)
- [x] Add tools.profile full to UAT stack
- [x] Fix Homebrew chmod ordering (both stacks)
- [x] Fix home directory ownership — `chown -R node:node /home/node` in Dockerfile (both stacks)
- [x] Fix host config dir ownership — `chown -R 1000:1000` in createDirs (Pulumi component)
- [x] Add Go egress domains to reference envoy.yaml + UAT egressPolicy
- [x] Fix gateway token mismatch on UAT
- [x] Add `--bind loopback --tailscale serve` to template CMD
- [x] Deploy to Hetzner UAT — fresh destroy + up (28 resources, clean)
- [ ] Add tools.profile full to `Pulumi.dev.yaml.example` setupCommands
- [ ] Investigate Control UI read-only / device pairing issue (user says not priority)
- [ ] Run full test suite + commit all changes
- [ ] Update AGENTS.md/CLAUDE.md re: token precedence (env var does NOT override config file)
- [ ] Consider adding Discord domains to `config/domains.ts` as hardcoded (currently user-only in UAT)

## Future TODOs (in serena memory `todo`)
- **Per-command init tracking**: Replace all-or-nothing init with one `command.remote.Command` per setupCommand, named by content hash. Ephemeral `docker run --rm --network none --user node` containers with same bind mounts. `retainOnDelete: true`. See serena memory `todo` for details.

## User Preferences (IMPORTANT)
- Don't SSH into prod and change random config — make code changes, deploy properly
- Don't chase multiple issues — focus on one thing at a time
- Ask before proceeding to next todo item
- Reference stack first — test locally before deploying to Hetzner
- Don't conflate concepts — skills ≠ tools, Docker Desktop ≠ Docker CE
- Don't rely on entrypoint for hacks — fixes belong in Dockerfile or Pulumi component
- Don't come up with novel ideas on your own — research proper patterns first
- The point of UAT is to validate the SOLUTION works, not just get a server running

---
**IMPERATIVE**: Always check with the user before proceeding with the next todo item. If all work is done, ask the user if they want to delete this memory.
