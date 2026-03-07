# feat/backups-security-updates — Progress & Todos

## Branch
`feat/backups-security-updates` off `main` — pushed to `origin`

## End Goal
Add optional Hetzner backups + automatic security updates to stack config, and fix image tagging so unchanged images don't cascade updates to all downstream resources.

## What's Done

### 1. autoUpdate config (DONE)
- `HostBootstrapArgs.autoUpdate?: boolean` in `components/bootstrap.ts`
- Installs `unattended-upgrades` via `command.remote.Command`, gated by `if (args.autoUpdate)`
- Includes `sleep 1` + `systemctl is-active` verification step
- Wired into `dockerReady` dependency chain via `pulumi.all()`
- Read from `cfg.getBoolean("autoUpdate")` in `index.ts`

### 2. Hetzner backups config (DONE)
- `HetznerConfig` interface in `config/types.ts` (`{ backups?: boolean }`)
- `ServerArgs.hetzner?: HetznerConfig` in `components/server.ts`
- `hcloud.Server` gets `backups: args.hetzner?.backups ?? false`
- `index.ts` reads `cfg.getObject<HetznerConfig>("hetzner")` with runtime validation:
  - Throws if value is not an object (catches `hetzner: true` YAML mistake)
  - Validates unknown keys (catches typos like `backup` vs `backups`)
  - Warns if `hetzner` config set for non-Hetzner provider
- `autoUpdate` added to `StackConfig` interface

### 3. Documentation (DONE)
- README.md, AGENTS.md, Pulumi.dev.yaml.example, .claude/rules/pulumi-config.md all updated

### 4. Image tag cascade fix (DONE)
- Removed `commitTag` (GIT_SHA-based) from `docker_build.Image.tags` in both `buildAndPush` and `buildOnHost` modes
- Only stable version tag remains in `tags` (e.g. `ajschmitt/openclaw:main-latest`)
- Commit SHA tag applied via separate `docker.Tag` resource with `tagTriggers: [image.digest]`
- `imageName` output now returns the stable version tag — downstream resources don't see changes on every commit
- `imageDigest` remains source of truth for content-based updates

### 5. PR Review (DONE)
- 4 parallel review agents: code, errors, types, comments — all issues fixed
- Commits: `5c7dbbe`, `38383f9`, `08d4ad7`

## Current State — One-Time Migration Cost

`pulumi preview` shows 37 changes because Pulumi state has old tag patterns. This is a **one-time transition**:
- `imageName` output changed from commit-tagged (`main-5c7dbbe`) to version-tagged (`main-latest`)
- Cascades to RemoteImage (replace), all init commands (update), gateway container (replace)
- **After one `pulumi up`, future previews will be clean.** Only `docker.Tag` updates per commit (leaf node, no cascade).

User confirmed: commit SHA tagging needed for rollback capability.

## Next Steps

- [ ] **Run `pulumi up`** to apply the one-time migration (user must confirm)
- [ ] **Verify clean preview** — run `pulumi preview` after up to confirm no spurious changes
- [ ] **Create PR** to main
- [ ] **Clean up** — update/delete this memory

## Key Design Decisions
- `docker.Tag` is a leaf node — `targetImage` changes every commit but nothing depends on its outputs
- `tagTriggers: [image.digest]` gates re-creation on content change
- Version tag in `docker_build.Image.tags` is stable (comes from stack config, not git)
- `pullTriggers: [image.digest]` on RemoteImage gates re-pull on content change

## IMPORTANT
Always check with the user before proceeding with the next todo item. If all work is done, ask the user if they want to delete this memory.
