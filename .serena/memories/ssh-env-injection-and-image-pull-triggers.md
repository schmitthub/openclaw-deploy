# SSH Env Injection + Image Pull Triggers + Multi-Platform Cache Fixes

Branch: `fix/node-user-env`
Last commit: `4f2298a` (NOT pushed)

## End Goal
Three fixes on one branch:
1. Give the `node` SSH user the same env vars as the gateway container's PID 1 process
2. Fix docker-build Image not triggering downstream pull/container replacement when templates change
3. Fix multi-platform build caching warning by using per-platform builds + Index

## What Was Done (Committed as 4f2298a)

### 1. Env Injection — WORKING, VERIFIED ON VPS
- **entrypoint.sh**: Writes PID 1 env to `/home/node/.ssh/environment` (sshd native format: `KEY=VALUE`)
- **Dockerfile**: `PermitUserEnvironment yes` in sshd_config (sshd reads `~/.ssh/environment` natively)
- Filters session-specific vars: `HOME|USER|LOGNAME|SHELL|TERM|PWD|OLDPWD|SHLVL|_`
- Verified via `ssh node@main.taildc11cf.ts.net "env"` — all vars visible including secrets

### 2. Content-Addressed Temp Dir
- Temp dir path includes content hash: `/tmp/openclaw-build-${profile}-${shortHash}/`
- `context.location` changes as a Pulumi input when templates change
- Stale dirs cleaned up per-profile with try/catch (best-effort)

### 3. RemoteImage triggers (NOT pullTriggers)
- Switched from `pullTriggers` to `triggers` on `docker.RemoteImage`
- `pullTriggers` does in-place update where `findImage()` short-circuits on local tag cache
- `triggers` forces delete+create = guaranteed fresh pull (per Neo analysis)
- Uses per-platform `Image.digest` (actual registry manifest digest) instead of `Index.ref` (just tag string)

### 4. Per-Platform Builds + Index
- When `multiPlatform: true`: two `docker_build.Image` resources (amd64, arm64) with independent cache tags
- `docker_build.Index` joins them into a manifest list under the canonical tag
- When `multiPlatform: false`: single Image, unchanged

## TODO Sequence

- [x] Env injection: entrypoint dumps env to `~/.ssh/environment`
- [x] Env injection: `PermitUserEnvironment yes` in sshd_config
- [x] Content-addressed temp dir for build context
- [x] Use `triggers` (not `pullTriggers`) on RemoteImage with `Image.digest`
- [x] Per-platform builds with Index for multi-platform caching
- [x] All tests pass (326/326), types clean, pre-commit hooks pass
- [x] Committed as `4f2298a` on branch `fix/node-user-env`
- [x] Verified env injection works on VPS via SSH
- [ ] Push branch and create PR
- [ ] Investigate: `docker_build.Index` replace fails with "digest required to delete manifest" — may need `retainOnDelete: true` or workaround. The Index doesn't reliably update the manifest list tag on Docker Hub during normal `pulumi up`. Per-platform images push fine but the manifest list can become stale.
- [ ] Investigate: full end-to-end `pulumi up` flow (build → push → index → pull → container replace) without manual `--replace` flags. The current deploy required manual `docker pull` on VPS + `pulumi refresh` + `pulumi up` to get the new image running.
- [ ] Clean up Pulumi state — there may be pending operations from failed updates (v85, v88 failed). Run `pulumi refresh` to clear.
- [ ] Update MEMORY.md with key lessons from this work

## Key Lessons

- `docker.RemoteImage.pullTriggers` is unreliable — use `triggers` instead (forces resource replacement)
- `docker_build.Index.ref` is just the tag string (no digest) — useless as a change trigger
- `docker_build.Image.digest` is the registry manifest digest — changes on every push, use this for triggers
- `docker_build.Image.ref` includes digest when `push: true` but NOT when `push: false`
- `PermitUserEnvironment yes` + `~/.ssh/environment` is the simplest way to inject env vars into SSH sessions
- sshd deliberately strips inherited environment variables — Docker ENV vars are NOT available in SSH sessions
- `docker_build.Index` replace can fail with "digest required to delete manifest" — the delete step needs a digest but only has a tag reference

## Pulumi State Notes

- Stack: `hetzner` (v91 last successful update)
- Several failed updates in history (v85, v88) from Index delete failures
- VPS currently running the correct new image with env injection working
- Docker Hub credentials cached on VPS at `/root/.docker/config.json` (from manual login during debugging)

## IMPORTANT
Always check with the user before proceeding with the next todo item. If all work is done, ask the user if they want to delete this memory.
