# feat/backups-security-updates — Progress & Todos

## Branch
`feat/backups-security-updates` off `main`

## End Goal
Add optional Hetzner backups + automatic security updates to stack config, and fix image tagging so unchanged images don't cascade updates to all downstream resources.

## What's Done

### 1. autoUpdate config (DONE)
- `HostBootstrapArgs.autoUpdate?: boolean` in `components/bootstrap.ts`
- Installs `unattended-upgrades` via `command.remote.Command`, gated by `if (args.autoUpdate)`
- Includes `systemctl is-active` verification step
- Wired into `dockerReady` dependency chain via `pulumi.all()`
- Read from `cfg.getBoolean("autoUpdate")` in `index.ts`

### 2. Hetzner backups config (DONE)
- `HetznerConfig` interface in `config/types.ts` (`{ backups?: boolean }`)
- `ServerArgs.hetzner?: HetznerConfig` in `components/server.ts` (imports the type, no inline duplication)
- `hcloud.Server` gets `backups: args.hetzner?.backups ?? false`
- `index.ts` reads `cfg.getObject<HetznerConfig>("hetzner")` with runtime validation:
  - Throws if value is not an object (catches `hetzner: true` YAML mistake)
  - Warns if `hetzner` config set for non-Hetzner provider
- `autoUpdate` added to `StackConfig` interface

### 3. Documentation (DONE)
- README.md: stack config table + Hetzner options sub-table
- AGENTS.md: stack config table + HostBootstrap description updated
- Pulumi.dev.yaml.example: commented-out examples
- .claude/rules/pulumi-config.md: config access patterns + component arg listings updated

### 4. PR Review (DONE)
- 4 parallel review agents ran (code, errors, types, comments)
- All critical/important issues fixed (see commit history)
- Committed as `5c7dbbe` on branch

### 5. Pulumi preview cascade problem (IDENTIFIED, NOT FIXED)
- `pulumi preview` shows 37 changes when only 2 are real (server backups + new unattended-upgrades command)
- Root cause: `GatewayImage.buildAndPush()` puts `commitTag` (includes `GIT_SHA`) in the `tags` array of `docker_build.Image`. Every commit changes the tag → Pulumi sees input diff → cascades to RemoteImage, all init commands, gateway container
- The `image.digest` and `pullTriggers` are already in place but the tag name change triggers updates before digest can gate anything

## Next Todo — Image Change Tracking (NOT STARTED)

### Research needed
- [ ] **Research best practice for tracking image changes with `@pulumi/docker-build`** — how to avoid cascading updates when image content hasn't changed but commit hash has
- Key constraint from user: keep the commit SHA tagging, but only perform push/pull/tag operations if the image digest has actually changed
- Don't remove any existing functionality — just gate operations on digest change
- The `docker_build.Image` resource is declarative — Pulumi diffs its `tags` input. If `commitTag` is in `tags` and changes, Pulumi always sees a diff regardless of digest
- Possible approaches to research:
  - Can `docker_build.Image` be configured to ignore tag changes if content is same?
  - Should commit tag be applied as a post-build step (separate resource) triggered only by digest?
  - Is there a Pulumi `ignoreChanges` option that could help?
  - How do other Pulumi projects handle this pattern?
- After research, propose approach to user before implementing

### After image tracking is resolved
- [ ] Amend or create new commit with the fix
- [ ] Re-run `pulumi preview` to verify only real changes show
- [ ] Create PR

## Lessons Learned
- User is very specific about scope — do exactly what's asked, don't restructure or rename things that weren't requested
- User wants to be consulted before any approach is taken on the image tracking issue
- The `dockerhubPush` mode uses commit SHA tags for identification — this is intentional and should be preserved
- `buildOnHost` mode also has the same `commitTag` in its `tags` array (line 228)

## IMPORTANT
Always check with the user before proceeding with the next todo item. If all work is done, ask the user if they want to delete this memory.
