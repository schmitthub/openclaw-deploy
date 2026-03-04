# Persist Node Home + Relocate User-Mode Package Managers

## Goal
Bind-mount `/home/node` so user-mode package managers (pnpm, brew, uv) and their installed packages survive container recreation. Relocate Homebrew under `/home/node/.linuxbrew`. Pass `--node-manager pnpm` during onboard.

## Branch
`fix/openclaw-doctor`

## Implementation Steps — All Complete

- [x] **`config/defaults.ts`** — `NODE_COMPILE_CACHE_DIR` → `/home/node/.node-compile-cache`
- [x] **`config/types.ts`** — Removed `user` field from `ImageStep` (always root now)
- [x] **`templates/dockerfile.ts`** — Homebrew relocated to `/home/node/.linuxbrew` with `HOMEBREW_PREFIX` env var; removed explicit mkdir/chown for compile cache; simplified `renderImageSteps` (no USER directives)
- [x] **`components/gateway.ts`** — Added `home` to `createDirs`; added `seedHome` step (copies `/home/node` from image on first deploy with `.seeded` sentinel); `fixPermissions` mounts home + depends on `seedHome`; init container mounts home; main container gets `/home/node` volume (first, before config/workspace overlays)
- [x] **`Pulumi.dev.yaml.example`** — Added `--node-manager pnpm` to onboard command
- [x] **`Pulumi.hetzner-uat.yaml`** — Added `--node-manager pnpm` to onboard command + `installBrowser: true`
- [x] **`reference/Dockerfile`** — Matching Homebrew relocation + compile cache changes
- [x] **Tests** — Updated `imageSteps` tests (removed `user` field), updated Homebrew path assertions. All 260 tests pass. `tsc --noEmit` clean.

## Next Steps — Not Yet Done

- [ ] **Deploy fresh UAT** — User destroyed hetzner-uat stack. Run `pulumi up -s hetzner-uat` for fresh deploy.
- [ ] **Smoke test** — Verify on deployed container:
  - Homebrew works: `brew --prefix` returns `/home/node/.linuxbrew`
  - pnpm works: `pnpm --version`
  - uv works: `uv --version`
  - Playwright/Chromium installed (installBrowser: true)
  - Container recreation preserves home contents (stop/start container, check brew/pnpm still present)
- [ ] **Commit** — Once verified, commit all changes

## Mount Order (for reference)
```
${dataDir}/home       → /home/node                     (base home)
${dataDir}/config     → /home/node/.openclaw            (overlays home)
${dataDir}/workspace  → /home/node/.openclaw/workspace  (overlays home)
envoy ca-cert         → /opt/openclaw-deploy/...
${dataDir}/tailscale  → /var/lib/tailscale
```

## Key Design Decisions
- `seedHome` uses a `.seeded` sentinel file to avoid re-copying on subsequent deploys (preserves user-installed packages)
- imageSteps always run as root (user-mode packages installed at runtime via persisted home)
- Homebrew uses `HOMEBREW_PREFIX=/home/node/.linuxbrew` env var to override default `/home/linuxbrew/.linuxbrew`
- Go is installed by openclaw via Homebrew at runtime — no Dockerfile install needed

---

**IMPORTANT:** Always check with the user before proceeding with the next todo item. If all work is done, ask the user if they want to delete this memory.
