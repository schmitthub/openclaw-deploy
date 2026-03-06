import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
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
}

export class GatewayImage extends pulumi.ComponentResource {
  /** The image tag, e.g. "openclaw-gateway-dev:latest" */
  public readonly imageName: pulumi.Output<string>;

  constructor(
    name: string,
    args: GatewayImageArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:build:GatewayImage", name, {}, opts);

    const tag = `openclaw-gateway-${args.profile}:${args.version}`;

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

    // docker-build provider targeting the remote Docker daemon
    const buildProvider = new docker_build.Provider(
      `${name}-build-provider`,
      { host: args.dockerHost },
      { parent: this },
    );

    // Build the image using BuildKit via @pulumi/docker-build.
    // - dockerfile.location: Dockerfile written to temp dir alongside other build context files
    // - context.location: local temp dir with Dockerfile + entrypoint.sh + firewall-bypass (transferred by BuildKit)
    // - load: true: exports the image to the remote Docker daemon's image store
    // - push: false: no registry push, local-only image
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

    // Prune dangling images after build to reclaim disk space from previous untagged builds
    new command.remote.Command(
      `${name}-prune`,
      {
        connection: args.connection,
        create:
          "docker image prune -f 2>&1 || echo 'WARN: docker image prune failed (non-critical)'",
        triggers: [image.ref],
      },
      { parent: this, dependsOn: [image] },
    );

    this.imageName = image.tags.apply((tags) => {
      if (!tags || tags.length === 0) {
        throw new Error(`No tags found for image ${name}`);
      }
      return tags[0];
    });

    this.registerOutputs({
      imageName: this.imageName,
    });
  }
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
