import {
  CORE_APT_PACKAGES,
  DOCKER_BASE_IMAGE,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  DEFAULT_GATEWAY_PORT,
} from "../config/defaults";
import type { ImageStep } from "../config/types";

export interface DockerfileOpts {
  version: string;
  installBrowser?: boolean;
  configDir?: string;
  workspaceDir?: string;
  gatewayPort?: number;
  imageSteps?: ImageStep[];
}

export function renderDockerfile(opts: DockerfileOpts): string {
  const configDir = opts.configDir ?? DEFAULT_OPENCLAW_CONFIG_DIR;
  const workspaceDir = opts.workspaceDir ?? DEFAULT_OPENCLAW_WORKSPACE_DIR;
  const gatewayPort = opts.gatewayPort ?? DEFAULT_GATEWAY_PORT;

  return `#
# NOTE: THIS DOCKERFILE IS GENERATED VIA "openclaw-deploy"
#
# PLEASE DO NOT EDIT IT DIRECTLY.
#

FROM ${DOCKER_BASE_IMAGE}

RUN apt-get update && \\
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      ${CORE_APT_PACKAGES.join(" ")} && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install Bun (required for build scripts).
# Binary copied to /usr/local/bin/ so node user can access it at runtime.
# (Symlinking through /root/ fails — root home is mode 0700.)
RUN curl -fsSL https://bun.sh/install | bash && \\
    cp /root/.bun/bin/bun /usr/local/bin/bun

# Install pnpm globally (used by OpenClaw for skill/plugin installs at runtime).
# PNPM_HOME sets the global bin directory so pnpm install -g works as node user.
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH="\${PNPM_HOME}:/home/node/.local/bin:\${PATH}"
RUN npm install -g pnpm && \\
    mkdir -p "\${PNPM_HOME}" /home/node/.local/bin && chown -R node:node /home/node/.local

# Install Homebrew (Linuxbrew). Installer refuses to run as root,
# but needs the target directory to exist and be writable.
RUN mkdir -p /home/linuxbrew/.linuxbrew && chown -R node:node /home/linuxbrew
USER node
RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
USER root
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:\${PATH}"

# Install uv (Python package manager) as node user.
USER node
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
USER root

# Install Tailscale (used for gateway ingress via tailscale serve/funnel).
RUN curl -fsSL https://tailscale.com/install.sh | sh

# Install ttyd (web terminal) and filebrowser (web file manager).
RUN TTYD_ARCH=$(uname -m) && \\
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.\${TTYD_ARCH}" -o /usr/local/bin/ttyd && \\
    chmod 755 /usr/local/bin/ttyd && \\
    curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | bash

WORKDIR /app
RUN chown node:node /app

ENV OPENCLAW_VERSION=${opts.version}
ENV OPENCLAW_CONFIG_DIR=${configDir}
ENV OPENCLAW_WORKSPACE_DIR=${workspaceDir}
ENV OPENCLAW_GATEWAY_PORT=${gatewayPort}

# Create config and workspace directories
RUN mkdir -p "\${OPENCLAW_CONFIG_DIR}" "\${OPENCLAW_WORKSPACE_DIR}" && \\
    chown -R node:node "\${OPENCLAW_CONFIG_DIR}" "\${OPENCLAW_WORKSPACE_DIR}"

# Install OpenClaw via npm (global, as root → /usr/local).
# NODE_OPTIONS reduces OOM risk on low-memory hosts (exit 137).
RUN SHARP_IGNORE_GLOBAL_LIBVIPS=1 NODE_OPTIONS=--max-old-space-size=2048 \\
    npm install -g --no-fund --no-audit "openclaw@\${OPENCLAW_VERSION}"

# CLI symlink for consistent access across users
RUN ln -sf "$(npm root -g)/openclaw/dist/entry.js" /usr/local/bin/openclaw && \\
    chmod 755 "$(npm root -g)/openclaw/dist/entry.js"

# Optional: bake Playwright + Chromium into the image for browser automation.
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
${renderBrowserBlock(opts.installBrowser ?? false)}
${renderImageSteps(opts.imageSteps ?? [])}COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

# Force pnpm for package operations (Bun may fail on ARM/Synology architectures).
ENV OPENCLAW_PREFER_PNPM=1
ENV NODE_ENV=production

ENTRYPOINT ["entrypoint.sh"]
CMD ["openclaw", "gateway", "--port", "${gatewayPort}"]
`;
}

function renderBrowserBlock(installBrowser: boolean): string {
  const defaultVal = installBrowser ? "1" : "";
  return `ARG OPENCLAW_INSTALL_BROWSER="${defaultVal}"
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \\
      apt-get update && \\
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \\
      mkdir -p /home/node/.cache/ms-playwright && \\
      PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \\
      node "$(npm root -g)/openclaw/node_modules/playwright-core/cli.js" install --with-deps chromium && \\
      chown -R node:node /home/node/.cache/ms-playwright && \\
      apt-get clean && \\
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \\
    fi

`;
}

function renderImageSteps(steps: ImageStep[]): string {
  if (steps.length === 0) return "";
  const lines = steps.map((s) => `USER ${s.user}\nRUN ${s.run}`);
  // Ensure we return to root after imageSteps for entrypoint COPY
  return lines.join("\n") + "\nUSER root\n\n";
}
