# Persist /home/node & Homebrew Fix — Implementation Progress

## End Goal
Persist `/home/node` and `/home/linuxbrew/.linuxbrew` across container recreations via bind mounts, with correct Homebrew setup so `node` user can seamlessly run `brew install` at runtime (called by OpenClaw).

## Branch
`fix/openclaw-doctor`

## Current Status
All code changes complete. 260/260 tests pass. Hetzner UAT deployed (28 resources). Several runtime issues discovered and fixed during UAT. **Current blocker: user reports they cannot edit settings in the Control UI — needs investigation.**

## Hetzner UAT Stack Info
- Stack: `hetzner-uat`
- Server IP: `<UAT_SERVER_IP>`
- Tailscale hostname: `<UAT_TAILSCALE_HOSTNAME>`
- Token was regenerated (lowercase-only change) — config file has OLD token, env var has NEW token. **Old token is the one that works** because init container didn't re-run.
- Gateway services: `pulumi stack output gatewayServices -s <UAT_STACK_NAME> --show-secrets`

## Key Discoveries & Lessons Learned

### macOS vs Linux Filesystem Differences
- **Case sensitivity**: macOS APFS is case-insensitive by default. Homebrew packages (openssl, ncurses) have man pages that differ only by case. `brew install` fails with "File exists @ syserr_fail2_in" when `/home/linuxbrew/.linuxbrew` is bind-mounted to macOS host. This ONLY affects local testing — Hetzner (ext4) is case-sensitive and works fine.
- **UID mapping**: macOS Docker Desktop remaps UIDs on bind mounts so file ownership "just works". On Linux (Hetzner), bind mounts map directly — ownership must be explicitly correct.

### Seed Step Ownership Bug (FIXED)
- `mkdir -p` on host creates dirs as `root:root`
- `docker run --user root` with `cp -a` preserves ownership FROM the image, but some files (e.g. `.cache/`) are root-owned from build steps
- **Fix**: After `cp -a`, explicitly `chown -R 1000:1000 /mnt/home/` and `chown -R linuxbrew:linuxbrew /mnt/linuxbrew/ && chmod -R g+rwx /mnt/linuxbrew/`

### ttyd Root Shell
- Changed `gosu node ttyd` → `ttyd` (runs as root) so users can `kill 1` from `/shell` to restart the container
- Docker ENV vars are NOT inherited by `su - node` (login shell resets environment)
- **Fix**: Added Homebrew PATH exports to `/home/node/.bashrc` in Dockerfile (as `USER node`)

### Init Container Skip Logic (IMPLEMENTED)
- `RandomPassword` with `upper: false` forced token regeneration
- Init container (onboard) didn't re-run because command string didn't change
- Config file has old token, env var has new token → mismatch
- **Fix**: `writeConfig` command now checks `jq -e '.gateway.auth.token' ${dataDir}/config/openclaw.json` on the HOST before running the init container. If token exists, skip init entirely.

### Token URL Safety
- `RandomPassword` now uses `upper: false, special: false` → `[a-z0-9]` only
- URL-safe and case-insensitive for all clients

### Pulumi Output Visibility
- Added `pulumi.log.info("To view gateway URLs: pulumi stack output gatewayServices --show-secrets")` so users know how to get their URLs (secret outputs are masked in console)

### Homebrew Path Resolution (SOLVED — prior session)
- Library symlink: `ln -s Homebrew/Library .linuxbrew/Library`
- ENV vars set BEFORE install, `su - linuxbrew -c` with `CI=1`
- Do NOT use `eval "$(brew shellenv)"` in entrypoint

### Tailscale Fixes (prior session)
- `tailscale up --authkey=... --reset` (not `--ssh`)
- `tailscale set --ssh --operator=node` separately after auth
- Socket readiness check: `[ -S socket ] && break` loop

## Files Modified (this session)
- `config/defaults.ts` — added `ripgrep`, `jq` to CORE_APT_PACKAGES
- `templates/entrypoint.ts` — ttyd runs as root (no gosu node)
- `templates/dockerfile.ts` — Homebrew .bashrc exports (as USER node)
- `reference/Dockerfile` — same: ripgrep, jq, .bashrc exports
- `reference/entrypoint.sh` — ttyd runs as root
- `reference/setup.sh` — seed chown fix (node:node + linuxbrew:linuxbrew)
- `components/gateway.ts` — seed chown fix, init skip logic (jq check on host)
- `index.ts` — `upper: false` on RandomPassword, `pulumi.log.info` for URLs
- `tests/templates.test.ts` — updated ttyd assertions (no gosu node)

## TODO Sequence
- [x] ttyd runs as root for `kill 1` access
- [x] Add ripgrep + jq to CORE_APT_PACKAGES
- [x] Fix seed ownership (chown node:node for home, linuxbrew:linuxbrew for brew)
- [x] Add Homebrew PATH to /home/node/.bashrc in Dockerfile
- [x] URL-safe tokens (lowercase only)
- [x] pulumi.log.info for gateway URLs
- [x] Init container skip logic (check gateway.auth.token on host)
- [x] Deploy UAT stack (28 resources, 12m12s first deploy, 8m39s update)
- [x] All 260 tests pass
- [ ] **INVESTIGATE: User cannot edit settings in Control UI — ask user for details**
- [ ] Fix token mismatch on current UAT (old token works, new token doesn't)
- [ ] Verify brew install works on Hetzner after permission fixes
- [ ] Verify su - node picks up Homebrew PATH after .bashrc fix
- [ ] Smoke test: pnpm, uv, home persistence across container restart
- [ ] Commit all changes
- [ ] Update serena memory with results

## User Preferences
- **Reference first**: Apply changes to `reference/` files first so user can test locally before template changes.
- **No manual docker/SSH commands** to bypass Pulumi during UAT (use proper `pulumi up`).
- **No "hacks"** — follow official docs and clean patterns.
- **Don't guess config paths** — verify the actual schema.
- **Don't put everything in entrypoint** — use the right place for each concern.

---
**IMPERATIVE**: Always check with the user before proceeding with the next todo item. The FIRST thing to do is ask the user about the Control UI settings issue (user argument: "user can't edit any settings in controlUI ask about it"). If all work is done, ask the user if they want to delete this memory.
