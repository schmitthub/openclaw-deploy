# Digest Pinning & Pulumi Replace Bug Fix

## Branch: `fix/pulumi-replace-bug`

## End Goal
Fix spurious Pulumi container replacements on every `pulumi up` and pin all base images with SHA256 digests for reproducible, architecture-safe builds.

## Background / Root Cause Analysis
1. **Spurious replacements**: Floating image tags (e.g. `envoyproxy/envoy:v1.33-latest`) and unstable `docker_build.Image.digest` outputs caused Pulumi to see property diffs on containers every run, triggering unnecessary replacements.
2. **Stale builds**: `npm install -g openclaw@latest` in the Dockerfile was opaque to BuildKit's cache — instruction text didn't change when a new version was published, so BuildKit served stale cached layers.
3. **Docker Hub auth bug**: `pullTag` logic in `buildAndPush` checked `!remoteTag.includes(".")` to decide whether to add `docker.io/` prefix. Dots in semver tags (e.g. `2026.3.7`) caused it to skip the prefix, breaking registry auth matching.
4. **Wrong digest type**: `docker manifest inspect | jq '.manifests[0].digest'` returns a platform-specific digest (e.g. linux/amd64 only). Using this in `image:tag@sha256:...` forced a single platform, causing `exec format error` on other architectures.
5. **Single-arch builds**: `buildAndPush` mode only built for the local architecture, not multi-arch.

## Completed Steps
- [x] Pin all base images with `@sha256:` manifest list digests in `config/defaults.ts`:
  - `DOCKER_BASE_IMAGE` (node:22-bookworm)
  - `DOCKER_DOWNLOADS_IMAGE` (new constant — debian:bookworm-slim, was hardcoded in template)
  - `DOCKER_BASE_IMAGE_DIGEST` (standalone digest for OCI labels)
  - `TAILSCALE_IMAGE` (tailscale:v1.94.2)
  - `ENVOY_IMAGE` (envoy:v1.33-latest)
- [x] Update `templates/dockerfile.ts` to use `DOCKER_DOWNLOADS_IMAGE` constant + add OCI base-image labels
- [x] Fix `pullTag` logic in `gateway-image.ts` — check dots only in registry portion (`registryPart.includes(".")`) not entire tag
- [x] Fix digest script to use `docker buildx imagetools inspect --format '{{json .Manifest}}'` for manifest LIST digests (multi-arch safe)
- [x] Add optional `multiPlatform` config flag for multi-arch builds in `buildAndPush` (default: host arch only)
- [x] Add registry-backed build cache (`cacheFrom`/`cacheTo`) to `buildAndPush` for fast subsequent builds
- [x] Create `scripts/update-base-digests.sh` + `Makefile` with `make update-digests` target
- [x] Update tests for digest-pinned expectations
- [x] All 297 tests passing, tsc clean

## Remaining Steps
- [ ] Run `pulumi up` to verify the full deploy works end-to-end (sidecar healthy, image pulled, gateway running)
- [ ] Verify `make update-digests` produces correct idempotent output after a real upstream digest change
- [ ] Consider adding a test that validates all image constants contain `@sha256:` digests (like openclaw's `docker-image-digests.test.ts`)
- [ ] Commit and create PR

## Key Lessons Learned
- `.manifests[0].digest` from `docker manifest inspect` is a PLATFORM-SPECIFIC digest, NOT the manifest list digest. Use `docker buildx imagetools inspect --format '{{json .Manifest}}' | jq -r '.digest'` for the multi-arch manifest list digest.
- `@pulumi/docker` provider matches `registryAuth` by the `address` field against the image name prefix. Images without explicit registry (e.g. `user/repo:tag`) need `docker.io/` prefix for auth to match.
- BuildKit caches by instruction text, not by what commands produce. `npm install pkg@latest` never cache-busts. Use explicit versions in Dockerfile instructions.
- `docker_build.Image` with `platforms` requires `push: true` + `load: false` (multi-arch can't be loaded locally).

## Files Modified
- `config/defaults.ts` — digest-pinned image constants + new `DOCKER_DOWNLOADS_IMAGE`, `DOCKER_BASE_IMAGE_DIGEST`
- `templates/dockerfile.ts` — uses `DOCKER_DOWNLOADS_IMAGE`, adds OCI labels
- `components/gateway-image.ts` — fixed `pullTag` prefix logic, optional `multiPlatform` flag, registry build cache
- `config/types.ts` — added `multiPlatform` to `StackConfig`
- `index.ts` — passes `multiPlatform` config to `GatewayImage`
- `tests/config.test.ts` — updated base image assertion
- `tests/templates.test.ts` — updated downloads stage assertion
- `scripts/update-base-digests.sh` — new helper script
- `Makefile` — new, `update-digests` target

---
**IMPORTANT**: Always check with the user before proceeding with the next todo item. If all work is done, ask the user if they want to delete this memory.
