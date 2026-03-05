# Brainstorm: Pulumi Refactor — Separation of Concerns

> **Status:** Completed → Initiative created
> **Created:** 2026-03-04
> **Last Updated:** 2026-03-04 00:05
> **Initiative:** `refactor-component-decomposition`

## Problem / Topic
The Gateway component is a ~540-line monolith constructor that handles everything: template rendering, file uploads, image builds, directory creation, volume management, sidecar containers, health checks, init containers, env file management, and the gateway container itself. There's no proper dependency graph segmentation — Pulumi can't track state granularly because everything is jammed into one ComponentResource. The reference docker-compose.yml and setup.sh show a cleaner separation that the Pulumi code doesn't mirror.

## Open Items / Questions
- (none yet)

## Decisions Made
- **Secrets via shell env, not files.** `export && docker run -e && unset`. No persistent env file.
- **5 first-class components per gateway:** `GatewayImage`, `TailscaleSidecar`, `EnvoyProxy`, `GatewayInit`, `Gateway`. Every service is independent — NO combining sidecar+envoy.
- **`@pulumi/docker-build` for image builds.** BuildKit-native. Local temp dir context, remote Docker daemon via DOCKER_HOST=ssh://. No base64 uploads, no content-hash hacks.
- **`@pulumi/docker` for containers/networks/volumes.** Standard Docker provider.
- **EnvoyEgress stays as-is** (shared config + certs). Envoy container is separate `EnvoyProxy` component.
- **Env var scanning for init step dependencies.** Commands referencing `$TAILSCALE_SERVE_HOST` automatically re-run when hostname changes. Commands without it are stable. No manual annotations (for now).
- **Reference is spec.** `reference/` directory defines exact service topology, ordering, healthchecks, env vars. Pulumi must replicate to the letter.
- **Strict ordering:** Tailscale → Envoy → Init → Gateway. Each step waits for the previous.
- **Cascade tracking:** Sidecar recreated → hostname-dependent init steps re-run → gateway restarts. Hostname-independent steps untouched.
- **`buildDir(profile)` and `dataDir(profile)` helpers** in `config/defaults.ts`.