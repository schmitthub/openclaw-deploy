export * from "./types";
export * from "./domains";
export * from "./defaults";
export * from "./digests";

// Derived pinned image refs — consumers import these
import {
  ENVOY_IMAGE_TAG,
  DOCKER_BASE_IMAGE_TAG,
  DOCKER_DOWNLOADS_IMAGE_TAG,
  TAILSCALE_IMAGE_TAG,
  pinImage,
} from "./defaults";
import { IMAGE_DIGESTS } from "./digests";

function pinOrThrow(tag: string): string {
  const digest = IMAGE_DIGESTS[tag];
  if (!digest || digest.startsWith("sha256:TODO")) {
    throw new Error(
      `No digest for "${tag}" — run \`make update-digests\` after changing image tags in config/defaults.ts`,
    );
  }
  return pinImage(tag, digest);
}

export const ENVOY_IMAGE = pinOrThrow(ENVOY_IMAGE_TAG);
export const DOCKER_BASE_IMAGE = pinOrThrow(DOCKER_BASE_IMAGE_TAG);
export const DOCKER_DOWNLOADS_IMAGE = pinOrThrow(DOCKER_DOWNLOADS_IMAGE_TAG);
export const TAILSCALE_IMAGE = pinOrThrow(TAILSCALE_IMAGE_TAG);
export const DOCKER_BASE_IMAGE_NAME = DOCKER_BASE_IMAGE_TAG;
export const DOCKER_BASE_IMAGE_DIGEST = DOCKER_BASE_IMAGE.split("@")[1];
