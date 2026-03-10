# Disk Usage: BuildKit Cache Cleanup (2026-03-08)

## Problem
VPS disk at ~85% capacity. Root cause: 13GB of orphaned BuildKit cache in `/var/lib/docker/volumes/`.

## Root Cause
Before PR #18 (`feat: Docker Hub push mode`, merged 2026-03-06), images were built directly on the VPS via `@pulumi/docker-build` with `DOCKER_HOST=ssh://`. This creates unmanaged BuildKit containers + state volumes that persist indefinitely (known issue: pulumi/pulumi-docker-build#65).

After switching to `dockerhubPush: true`, builds moved to the local Mac and images are pushed to Docker Hub then pulled on VPS. But the old BuildKit containers and their cache volumes were never cleaned up.

## What Was Found
Two BuildKit containers still running on the VPS:

| Container | Created | Volume Size | Origin |
|-----------|---------|-------------|--------|
| `buildx_buildkit_relaxed_tesla0` | 2026-03-05 06:30 UTC | **13GB** | Orphaned — not tracked by `docker buildx ls` |
| `buildx_buildkit_openclawbuilder0` | 2026-03-07 00:43 UTC | 120K | Registered as `openclawbuilder` in buildx |

Both pre-date the `dockerhubPush` switch (PR #18 merged 2026-03-06 20:31 PST).

## What Was Done
```bash
# Registered builder — removed via buildx
docker buildx rm openclawbuilder

# Orphaned builder — manual container + volume removal
docker rm -f buildx_buildkit_relaxed_tesla0
docker volume rm buildx_buildkit_relaxed_tesla0_state
```

Result: 13GB reclaimed, disk usage dropped from ~85% to 43%.

## If Disk Creep Happens Again
1. Check `du -h --max-depth=2 /var/lib/docker | sort -rh | head -20`
2. Look for `buildx_buildkit_*` volumes — these are BuildKit caches
3. Check `docker buildx ls` for registered builders
4. Orphaned containers (not in `buildx ls`) need manual `docker rm -f` + `docker volume rm`
5. Other potential culprits: old pulled images (`docker image ls`), container logs (`/var/lib/docker/containers/*/`), application data in `openclaw-home-*` volumes

## Prevention
The codebase already has `docker image prune -f` after each pull (in `gateway-image.ts`), but this only removes dangling images. There is no automated BuildKit cleanup. If `dockerhubPush` is ever set back to `false`, BuildKit cache will accumulate again — the warning in `buildOnHost()` documents this.
