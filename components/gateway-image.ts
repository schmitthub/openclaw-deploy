import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as docker from "@pulumi/docker";
import * as docker_build from "@pulumi/docker-build";
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
}

export class GatewayImage extends pulumi.ComponentResource {
  /** The image tag, e.g. "openclaw-gateway-dev:latest" or "registry/openclaw-gateway-dev:latest" */
  public readonly imageName: pulumi.Output<string>;

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

    // Write build context files to a stable temp directory.
    // Using a stable path (not mkdtempSync) avoids accumulating stale dirs across runs.
    // Only write if content changed — preserves mtime so BuildKit context hash is stable.
    const tempDir = path.join(os.tmpdir(), `openclaw-build-${args.profile}`);
    fs.mkdirSync(tempDir, { recursive: true });
    writeIfChanged(path.join(tempDir, "Dockerfile"), dockerfile, 0o644);
    writeIfChanged(path.join(tempDir, "entrypoint.sh"), entrypoint, 0o755);
    writeIfChanged(path.join(tempDir, "firewall-bypass"), bypassScript, 0o700);

    if (args.dockerhubPush) {
      this.imageName = this.buildAndPush(name, args, tempDir);
    } else {
      this.imageName = this.buildOnHost(name, args, tempDir);
    }

    this.registerOutputs({
      imageName: this.imageName,
    });
  }

  /** Build locally and push to Docker Hub. VPS pulls via docker.RemoteImage. */
  private buildAndPush(
    name: string,
    args: GatewayImageArgs,
    tempDir: string,
  ): pulumi.Output<string> {
    const repo = process.env.DOCKER_REGISTRY_REPO;
    const username = process.env.DOCKER_REGISTRY_USER;
    const password = process.env.DOCKER_REGISTRY_PASS;

    if (!repo || !username || !password) {
      throw new Error(
        "dockerhubPush requires DOCKER_REGISTRY_REPO, DOCKER_REGISTRY_USER, and DOCKER_REGISTRY_PASS env vars",
      );
    }

    const remoteTag = `${repo}:${args.profile}-${args.version}`;

    const SAFE_DOCKER_RE = /^[a-zA-Z0-9._\-/:]+$/;
    if (!SAFE_DOCKER_RE.test(remoteTag)) {
      throw new Error(`Invalid characters in Docker tag: ${remoteTag}`);
    }

    // Build locally and push to Docker Hub
    const image = new docker_build.Image(
      `${name}-image`,
      {
        tags: [remoteTag],
        dockerfile: { location: path.join(tempDir, "Dockerfile") },
        context: { location: tempDir },
        push: true,
        load: false,
        buildOnPreview: false,
        registries: [
          {
            address: "docker.io",
            username,
            password: pulumi.secret(password),
          },
        ],
      },
      { parent: this },
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

    // Use docker.io/ prefix so the provider matches registryAuth address
    const pullTag =
      remoteTag.includes("/") && !remoteTag.includes(".")
        ? `docker.io/${remoteTag}`
        : remoteTag;
    const pulled = new docker.RemoteImage(
      `${name}-pull`,
      {
        name: pullTag,
        pullTriggers: [image.ref],
        keepLocally: true,
      },
      { parent: this, provider: remoteDockerProvider, dependsOn: [image] },
    );

    // Prune dangling images on VPS after pull
    new command.remote.Command(
      `${name}-prune`,
      {
        connection: args.connection,
        create:
          "docker image prune -f 2>&1 || echo 'WARNING: docker image prune failed (non-critical)'",
        triggers: [pulled.repoDigest],
      },
      { parent: this, dependsOn: [pulled] },
    );

    return firstTag(image, name);
  }

  /** Build on the VPS via DOCKER_HOST=ssh://. Emits a warning about BuildKit cache accumulation. */
  private buildOnHost(
    name: string,
    args: GatewayImageArgs,
    tempDir: string,
  ): pulumi.Output<string> {
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

    // Prune dangling images after build (previous untagged builds)
    new command.remote.Command(
      `${name}-prune`,
      {
        connection: args.connection,
        create:
          "docker image prune -f 2>&1 || echo 'WARNING: docker image prune failed (non-critical)'",
        triggers: [image.ref],
      },
      { parent: this, dependsOn: [image] },
    );

    return firstTag(image, name);
  }
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

/** Write file only if content differs from what's on disk — preserves mtime for stable BuildKit context hashing. */
function writeIfChanged(filePath: string, content: string, mode: number) {
  try {
    const existing = fs.readFileSync(filePath, "utf-8");
    if (existing === content) return;
  } catch (err: unknown) {
    if (
      !(
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      throw err;
    }
  }
  fs.writeFileSync(filePath, content, { mode });
}
