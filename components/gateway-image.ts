import * as pulumi from "@pulumi/pulumi";
import * as docker_build from "@pulumi/docker-build";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { renderDockerfile, renderEntrypoint } from "../templates";
import type { ImageStep } from "../config/types";

export interface GatewayImageArgs {
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

    // Write entrypoint.sh to a stable temp directory for the build context.
    // Using a stable path (not mkdtempSync) avoids accumulating stale dirs across runs.
    const tempDir = path.join(os.tmpdir(), `openclaw-build-${args.profile}`);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "entrypoint.sh"), entrypoint, {
      mode: 0o755,
    });

    // docker-build provider targeting the remote Docker daemon
    const buildProvider = new docker_build.Provider(
      `${name}-build-provider`,
      { host: args.dockerHost },
      { parent: this },
    );

    // Build the image using BuildKit via @pulumi/docker-build.
    // - dockerfile.inline: rendered Dockerfile content (no file on disk needed)
    // - context.location: local temp dir with entrypoint.sh (transferred by BuildKit)
    // - load: true: exports the image to the remote Docker daemon's image store
    // - push: false: no registry push, local-only image
    const image = new docker_build.Image(
      `${name}-image`,
      {
        tags: [tag],
        dockerfile: { inline: dockerfile },
        context: { location: tempDir },
        load: true,
        push: false,
        buildOnPreview: false,
      },
      { parent: this, provider: buildProvider },
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
