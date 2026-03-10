# Node User Env Injection + Build Trigger + Multi-Platform Cache Fixes

Branch: `fix/node-user-env`

## End Goal
Three fixes on one branch:
1. Give the `node` SSH user the same env vars as the gateway container's PID 1 process
2. Fix docker-build Image not triggering downstream pull/container replacement when templates change
3. Fix multi-platform build caching warning by using per-platform builds + Index

## Background Context

### Env Injection Problem
When `node` logs in via SSH (Tailscale Serve), they get a login shell that doesn't inherit Docker ENV vars or runtime `-e` vars (like `OPENCLAW_GATEWAY_TOKEN`). The entrypoint runs as root with all env vars, then `exec gosu node "$@"` passes them to PID 1, but SSH sessions are independent.

### Build Trigger Problem (Critical Lesson)
`docker_build.Image` has a `contextHash` output that hashes context files. However, since our Pulumi program writes files to the temp dir during constructor execution (before the provider's Diff runs), BOTH the old and new `contextHash` are computed from the CURRENT disk content — so they always match. Neo confirmed this is the root cause.

Additionally, using a pre-computed `buildInputDigest` as `pullTriggers` caused a desync: a previous `pulumi up` saw the new digest but the Image didn't rebuild (stable temp dir), so triggers fired prematurely against the old image. On subsequent runs the digest was already in state.

### Multi-Platform Cache
buildx can only cache one platform at a time in multi-platform builds. The fix is per-platform Image resources with independent cache tags, joined by `docker_build.Index`.

## Implementation Details

### 1. Env Injection (templates/entrypoint.ts + templates/dockerfile.ts)
- **entrypoint.sh**: Before `exec gosu node`, dumps env to `/run/openclaw-env` via `printenv -0 | while ... printf %q` (safe quoting)
- **Dockerfile**: `.bashrc` sources `/run/openclaw-env` (covers interactive SSH)
- **Dockerfile**: `sshd_config.d/openclaw.conf` with `SetEnv BASH_ENV=/run/openclaw-env` (covers non-interactive `ssh user@host "cmd"`)
- Filters out session-specific vars: `HOME|USER|LOGNAME|SHELL|TERM|PWD|OLDPWD|SHLVL|_`

### 2. Content-Addressed Temp Dir (components/gateway-image.ts)
- Temp dir path includes content hash: `/tmp/openclaw-build-${profile}-${shortHash}/`
- `context.location` changes as a Pulumi input when templates change
- Stale dirs cleaned up per-profile with try/catch (best-effort)
- `writeIfChanged` function removed (no longer needed)

### 3. Image Ref as Trigger (components/gateway-image.ts)
- `buildAndPush` path: `imageRef` from `Index.ref` (multi-platform) or `Image.ref` (single-platform) — includes registry digest, changes on every push
- `buildOnHost` path: uses `image.digest` (not `image.ref` — ref has no digest when `push: false`, per Neo review)
- All downstream triggers (pullTriggers, remove-stale, prune, tagTriggers) use the build output ref/digest
- `buildInputDigest` is now ONLY used for the content-addressed temp dir name

### 4. Per-Platform Builds + Index (components/gateway-image.ts)
- When `multiPlatform: true`: two `docker_build.Image` resources (amd64, arm64) with independent cache tags (`${repo}:${profile}-cache-${arch}`) using `CacheMode.Max`
- `docker_build.Index` joins them into a manifest list under the canonical tag
- When `multiPlatform: false`: single Image, unchanged

### 5. Test Updates (tests/components.test.ts)
- Mock now provides `ref` output for `docker-build:index:Image` and `docker-build:index:Index`
- `imageDigest` assertion updated to match new format

## TODO Sequence

- [x] Env injection: entrypoint dumps env to `/run/openclaw-env`
- [x] Env injection: `.bashrc` sources the file
- [x] Env injection: sshd `SetEnv BASH_ENV=/run/openclaw-env` for non-interactive SSH
- [x] Content-addressed temp dir for build context
- [x] Use image ref/digest as downstream triggers instead of pre-computed hash
- [x] Per-platform builds with Index for multi-platform caching
- [x] Neo reviewed all three fixes — approved with one issue (buildOnHost ref) which was fixed
- [x] All tests pass (326/326), types clean
- [ ] Deploy and verify env injection works: `ssh node@main.taildc11cf.ts.net "env"`
- [ ] Verify gateway token is correct after deploy
- [ ] Commit and PR

## Key Lessons (save for future)
- `docker_build.Image` contextHash is useless when the program writes files at plan time — use content-addressed paths
- `Image.ref` has NO digest when `push: false` — use `image.digest` for local builds
- `pullTriggers` can fire before the Image rebuilds if using a pre-computed hash — always tie triggers to actual build outputs
- `SetEnv BASH_ENV=...` in sshd_config is needed for non-interactive SSH (`ssh user@host "cmd"`) — `.bashrc` alone is insufficient
- sshd_config.d requires `mkdir -p /etc/ssh/sshd_config.d` in Dockerfile

## IMPORTANT
Always check with the user before proceeding with the next todo item. If all work is done, ask the user if they want to delete this memory.
