import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as docker from "@pulumi/docker";
import * as docker_build from "@pulumi/docker-build";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  renderDockerfile,
  renderEntrypoint,
  renderFirewallBypass,
} from "../templates";
import type { ImageStep } from "../config/types";

export interface GatewayImageArgs {
  /** SSH connection args for remote commands */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Docker host URI for the remote build daemon, e.g. "ssh://root@<ip>" */
  dockerHost: pulumi.Input<string>;
  /** Unique name for this gateway instance */
  profile: string;
  /** OpenClaw version to install (npm dist-tag or semver) */
  version: string;
  /** Bake Playwright + Chromium into the image (~300MB) */
  installBrowser?: boolean;
  /** Custom Dockerfile RUN instructions (after openclaw install, before entrypoint COPY) */
  imageSteps?: ImageStep[];
  /** Push to Docker Hub instead of building on VPS. Uses DOCKER_REGISTRY_REPO for image tag prefix; auth via DOCKER_REGISTRY_USER + DOCKER_REGISTRY_PASS. */
  dockerhubPush?: boolean;
  /** Build for both linux/amd64 and linux/arm64 (only applies when dockerhubPush is true). First build is slow (~30min) due to cross-compilation; subsequent builds use registry cache. Default: false (builds for host architecture only). */
  multiPlatform?: boolean;
  /** Docker platform of the VPS, e.g. "linux/amd64". Required when multiPlatform is true so RemoteImage pulls the correct architecture. */
  platform?: string;
}

export class GatewayImage extends pulumi.ComponentResource {
  /** The image tag, e.g. "openclaw-gateway-dev:latest" or "registry/openclaw-gateway-dev:latest" */
  public readonly imageName: pulumi.Output<string>;
  /** Stable image change token. Changes when build inputs change and, for pulled images, prefers the remote repo digest. */
  public readonly imageDigest: pulumi.Output<string>;

  constructor(
    name: string,
    args: GatewayImageArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:build:GatewayImage", name, {}, opts);

    // Render templates (pure functions, runs at plan time)
    const dockerfile = renderDockerfile({
      version: args.version,
      installBrowser: args.installBrowser ?? false,
      imageSteps: args.imageSteps,
    });
    const entrypoint = renderEntrypoint();
    const bypassScript = renderFirewallBypass();
    const buildInputDigest = stableBuildInputDigest(
      dockerfile,
      entrypoint,
      bypassScript,
    );

    // Write build context to a content-addressed temp directory.
    // The path includes the digest so context.location changes when templates change,
    // which the docker-build provider detects as an input diff.
    // Clean up stale dirs from previous builds for this profile.
    const shortHash = buildInputDigest.slice(7, 19); // 12 hex chars from sha256:...
    const dirPrefix = `openclaw-build-${args.profile}-`;
    const tempDir = path.join(os.tmpdir(), `${dirPrefix}${shortHash}`);
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith(dirPrefix) && entry !== `${dirPrefix}${shortHash}`) {
        try {
          fs.rmSync(path.join(os.tmpdir(), entry), {
            recursive: true,
            force: true,
          });
        } catch {
          // Best-effort cleanup; stale dir will be removed on next run.
        }
      }
    }
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "Dockerfile"), dockerfile, {
      mode: 0o644,
    });
    fs.writeFileSync(path.join(tempDir, "entrypoint.sh"), entrypoint, {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(tempDir, "firewall-bypass"), bypassScript, {
      mode: 0o700,
    });

    if (args.multiPlatform && !args.dockerhubPush) {
      throw new Error(
        "multiPlatform: true requires dockerhubPush: true. " +
          "On-VPS builds always use the server's native architecture.",
      );
    }
    if (args.multiPlatform && !args.platform) {
      throw new Error(
        'multiPlatform: true requires "platform" in stack config (e.g. "linux/amd64") ' +
          "so the VPS pulls the correct architecture from the manifest list.",
      );
    }

    if (args.dockerhubPush) {
      const result = this.buildAndPush(name, args, tempDir);
      this.imageName = result.imageName;
      this.imageDigest = result.imageDigest;
    } else {
      const result = this.buildOnHost(name, args, tempDir);
      this.imageName = result.imageName;
      this.imageDigest = result.imageDigest;
    }

    this.registerOutputs({
      imageName: this.imageName,
      imageDigest: this.imageDigest,
    });
  }

  /** Build locally and push to Docker Hub. VPS pulls via docker.RemoteImage. */
  private buildAndPush(
    name: string,
    args: GatewayImageArgs,
    tempDir: string,
  ): { imageName: pulumi.Output<string>; imageDigest: pulumi.Output<string> } {
    const repo = process.env.DOCKER_REGISTRY_REPO;
    const username = process.env.DOCKER_REGISTRY_USER;
    const password = process.env.DOCKER_REGISTRY_PASS;

    if (!repo || !username || !password) {
      throw new Error(
        "dockerhubPush requires DOCKER_REGISTRY_REPO, DOCKER_REGISTRY_USER, and DOCKER_REGISTRY_PASS env vars",
      );
    }
    if (!repo.includes("/")) {
      throw new Error(
        `DOCKER_REGISTRY_REPO must include namespace (e.g. "username/repo"), got: "${repo}"`,
      );
    }

    const remoteTag = `${repo}:${args.profile}-${args.version}`;
    const SAFE_DOCKER_RE = /^[a-zA-Z0-9._\-/:]+$/;
    if (!SAFE_DOCKER_RE.test(remoteTag)) {
      throw new Error(`Invalid characters in Docker tag: ${remoteTag}`);
    }

    const registries = [
      {
        address: "docker.io",
        username,
        password: pulumi.secret(password),
      },
    ];

    // The resource that downstream depends on — either a single Image or an Index.
    // imageDigestTrigger is the registry manifest digest — changes on every push,
    // used to force RemoteImage replacement (triggers, not pullTriggers).
    let image: pulumi.Resource;
    let imageDigestTrigger: pulumi.Output<string>;

    if (args.multiPlatform) {
      // Build each platform separately with independent caches, then join via Index.
      // This avoids the buildx limitation where multi-platform builds only cache one platform.
      // First build per platform is slow (~30min for cross-arch via QEMU); subsequent builds
      // use per-platform registry cache.
      const platformBuilds = (
        [
          ["amd64", docker_build.Platform.Linux_amd64],
          ["arm64", docker_build.Platform.Linux_arm64],
        ] as const
      ).map(([arch, platform]) => {
        const archTag = `${remoteTag}-${arch}`;
        const cacheTag = `${repo}:${args.profile}-cache-${arch}`;
        return new docker_build.Image(
          `${name}-image-${arch}`,
          {
            tags: [archTag],

            dockerfile: { location: path.join(tempDir, "Dockerfile") },
            context: { location: tempDir },
            platforms: [platform],
            push: true,
            buildOnPreview: false,
            cacheFrom: [{ registry: { ref: cacheTag } }],
            cacheTo: [
              {
                registry: {
                  ref: cacheTag,
                  mode: docker_build.CacheMode.Max,
                },
              },
            ],
            registries,
          },
          { parent: this },
        );
      });

      // Join per-platform manifests into a manifest list under the version + commit tags.
      // Uses imagetools (no delete semantics — mutable tags are just overwritten).
      imageDigestTrigger = pulumi
        .all(platformBuilds.map((b) => b.digest))
        .apply((digests) => digests.join(","));

      // Git SHA resolved at runtime so the create string stays stable across commits.
      const manifestCreate = pulumi
        .all(platformBuilds.map((b) => b.ref))
        .apply(
          (refs) =>
            `docker buildx imagetools create -t ${remoteTag} ${refs.join(" ")}`,
        );

      const manifestList = new command.local.Command(
        `${name}-manifest`,
        {
          create: manifestCreate,
          triggers: [imageDigestTrigger],
        },
        { parent: this, dependsOn: platformBuilds, ignoreChanges: ["create"] },
      );
      image = manifestList;
    } else {
      // Single-platform build (host arch only) — fast, no cross-compilation.
      const singleImage = new docker_build.Image(
        `${name}-image`,
        {
          tags: [remoteTag],
          dockerfile: { location: path.join(tempDir, "Dockerfile") },
          context: { location: tempDir },
          push: true,
          buildOnPreview: false,
          cacheFrom: [{ registry: { ref: remoteTag } }],
          cacheTo: [{ inline: {} }],
          registries,
        },
        { parent: this },
      );
      image = singleImage;
      imageDigestTrigger = singleImage.digest;
    }

    // Push git SHA tag to registry for commit-level identification.
    // Git SHA is resolved at runtime (not plan time) so the create string stays stable
    // across commits. ignoreChanges on "create" prevents one-time migration diff from
    // the old plan-time SHA — only `triggers` (image digest) controls re-execution.
    const commitTag = new command.local.Command(
      `${name}-commit-tag`,
      {
        create: `docker buildx imagetools create -t ${repo}:${args.profile}-$(git rev-parse --short=7 HEAD) ${remoteTag}`,
        triggers: [imageDigestTrigger],
      },
      { parent: this, dependsOn: [image], ignoreChanges: ["create"] },
    );

    // Stop buildkit containers left behind by @pulumi/docker-build
    // (pulumi/pulumi-docker-build#65). Build cache is stored in named Docker volumes
    // and survives container stop — the provider restarts them on the next build.
    // Depends on commitTag (last local buildx operation) to avoid race conditions.
    new command.local.Command(
      `${name}-buildkit-cleanup`,
      {
        create:
          'docker ps -q --filter "name=^buildx_buildkit_" | xargs -r docker stop' +
          ' || echo "WARNING: buildkit cleanup failed — see pulumi/pulumi-docker-build#65" >&2',
        triggers: [imageDigestTrigger],
      },
      { parent: this, dependsOn: [commitTag] },
    );

    // Pull on VPS via docker.RemoteImage with provider-level registryAuth.
    // Address must be "docker.io" for Docker Hub (provider normalizes internally).
    const remoteDockerProvider = new docker.Provider(
      `${name}-docker-provider`,
      {
        host: args.dockerHost,
        registryAuth: [
          {
            address: "docker.io",
            username,
            password: pulumi.secret(password),
          },
        ],
      },
      { parent: this },
    );

    // Pull by stable version tag — re-pull gated by stable build inputs.
    // Use docker.io/ prefix so the provider matches registryAuth address.
    // Treat a first path segment as an explicit registry if it contains a dot,
    // contains a port, or is "localhost" (Docker reference semantics).
    const pullTag = hasExplicitRegistry(remoteTag)
      ? remoteTag
      : `docker.io/${remoteTag}`;

    // Remove stale local image before pulling. The Docker provider's findImage()
    // short-circuits on local tag match and ignores the platform field, so a cached
    // arm64 image prevents re-pulling the correct amd64 variant.
    const removeStale = new command.remote.Command(
      `${name}-remove-stale`,
      {
        connection: args.connection,
        create: `docker rmi ${pullTag} 2>/dev/null || true`,
        triggers: [
          imageDigestTrigger,
          ...(args.platform ? [args.platform] : []),
        ],
      },
      { parent: this, dependsOn: [image] },
    );

    // Use triggers (not pullTriggers) to force resource replacement on digest change.
    // pullTriggers does in-place update where findImage() can short-circuit on local tag.
    // triggers forces delete+create = guaranteed fresh pull.
    new docker.RemoteImage(
      `${name}-pull`,
      {
        name: pullTag,
        platform: args.platform,
        triggers: {
          digest: imageDigestTrigger,
          ...(args.platform ? { platform: args.platform } : {}),
        },
        keepLocally: true,
      },
      {
        parent: this,
        provider: remoteDockerProvider,
        dependsOn: [image, removeStale],
      },
    );

    return {
      imageName: pulumi.output(pullTag),
      imageDigest: imageDigestTrigger,
    };
  }

  /** Build on the VPS via DOCKER_HOST=ssh://. Emits a warning about BuildKit cache accumulation. */
  private buildOnHost(
    name: string,
    args: GatewayImageArgs,
    tempDir: string,
  ): { imageName: pulumi.Output<string>; imageDigest: pulumi.Output<string> } {
    const tag = `openclaw-gateway-${args.profile}:${args.version}`;

    pulumi.log.warn(
      [
        `[${args.profile}] Building on VPS via SSH. The @pulumi/docker-build provider creates`,
        "an unmanaged BuildKit container whose build cache accumulates on disk",
        "(pulumi/pulumi-docker-build#65). To reclaim space, SSH into the VPS and run:",
        "",
        "  docker ps --filter name=buildx_buildkit -q \\",
        "    | xargs -r -I{} docker exec {} buildctl prune --keep-storage=2GB",
        "",
        "To avoid this, set `dockerhubPush: true` in stack config to build locally",
        "and push to Docker Hub instead.",
      ].join("\n"),
      this,
    );

    const buildProvider = new docker_build.Provider(
      `${name}-build-provider`,
      { host: args.dockerHost },
      { parent: this },
    );

    const image = new docker_build.Image(
      `${name}-image`,
      {
        tags: [tag],
        dockerfile: { location: path.join(tempDir, "Dockerfile") },
        context: { location: tempDir },
        load: true,
        push: false,
        buildOnPreview: false,
      },
      { parent: this, provider: buildProvider },
    );

    // Stop buildkit containers left behind by @pulumi/docker-build on the VPS
    // (pulumi/pulumi-docker-build#65). Build cache is stored in named Docker volumes
    // and survives container stop — the provider restarts them on the next build.
    new command.remote.Command(
      `${name}-buildkit-cleanup`,
      {
        connection: args.connection,
        create:
          'docker ps -q --filter "name=^buildx_buildkit_" | xargs -r docker stop' +
          ' || echo "WARNING: buildkit cleanup failed — see pulumi/pulumi-docker-build#65" >&2',
        triggers: [image.digest],
      },
      { parent: this, dependsOn: [image] },
    );

    return {
      imageName: firstTag(image, name),
      imageDigest: image.digest,
    };
  }
}

function hasExplicitRegistry(imageRef: string): boolean {
  const firstSegment = imageRef.split("/")[0];
  return (
    firstSegment.includes(".") ||
    firstSegment.includes(":") ||
    firstSegment === "localhost"
  );
}

function stableBuildInputDigest(...parts: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function firstTag(
  image: docker_build.Image,
  name: string,
): pulumi.Output<string> {
  return image.tags.apply((tags) => {
    if (!tags || tags.length === 0) {
      throw new Error(`No tags found for image ${name}`);
    }
    return tags[0];
  });
}
