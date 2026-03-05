import {
  CORE_APT_PACKAGES,
  DOCKER_BASE_IMAGE,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  DEFAULT_GATEWAY_PORT,
  NODE_COMPILE_CACHE_DIR,
  SSHD_PORT,
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

# Pin node user UID/GID to 1000 (matches chown in Pulumi host provisioning).
RUN groupmod -g 1000 node && usermod -u 1000 node

RUN apt-get update && \\
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      ${CORE_APT_PACKAGES.join(" ")} && \\
    apt-get clean && \\
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Configure sshd: listen on loopback only, port ${SSHD_PORT}, allow root with empty password.
# SSH is only accessible via Tailscale Serve TCP forwarding (not exposed to the network).
RUN mkdir -p /run/sshd && \\
    sed -i 's/#ListenAddress 0.0.0.0/ListenAddress 127.0.0.1/' /etc/ssh/sshd_config && \\
    sed -i 's/#Port 22/Port ${SSHD_PORT}/' /etc/ssh/sshd_config && \\
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \\
    sed -i 's/#PermitEmptyPasswords no/PermitEmptyPasswords yes/' /etc/ssh/sshd_config && \\
    sed -i 's/UsePAM yes/UsePAM no/' /etc/ssh/sshd_config && \\
    passwd -d root && \\
    ssh-keygen -A && \\
    chown root:root /usr/bin/ssh && \\
    chmod 700 /usr/bin/ssh

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

# Install Homebrew (Linuxbrew) via dedicated linuxbrew user at default prefix.
# Custom prefixes lose bottle (binary) support — everything builds from source.
# The /home/linuxbrew directory is mounted as a named Docker volume for persistence across container recreations.
# The node user is added to the linuxbrew group for write access (brew install at runtime).
ENV HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew
ENV HOMEBREW_CELLAR=/home/linuxbrew/.linuxbrew/Cellar
ENV HOMEBREW_REPOSITORY=/home/linuxbrew/.linuxbrew/Homebrew
ENV PATH=/home/linuxbrew/.linuxbrew/bin:\${PATH}

RUN if ! id -u linuxbrew >/dev/null 2>&1; then useradd -m -s /bin/bash linuxbrew; fi; \\
        usermod -aG linuxbrew node; \\
        mkdir -p "/home/linuxbrew/.linuxbrew"; \\
        chown -R linuxbrew:linuxbrew "/home/linuxbrew"; \\
        su - linuxbrew -c "NONINTERACTIVE=1 CI=1 /bin/bash -c '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'"; \\
        if [ ! -e "/home/linuxbrew/.linuxbrew/Library" ]; then ln -s "/home/linuxbrew/.linuxbrew/Homebrew/Library" "/home/linuxbrew/.linuxbrew/Library"; fi; \\
        if [ ! -x "/home/linuxbrew/.linuxbrew/bin/brew" ]; then echo "brew install failed"; exit 1; fi; \\
        chmod -R g+rwx "/home/linuxbrew";

# Install uv (Python package manager) as node user.
USER node
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
# Persist Homebrew env in .bashrc so it survives login shells (Docker ENV vars
# are lost when login shells like SSH reset the environment).
RUN echo 'export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH' >> /home/node/.bashrc && \\
    echo 'export HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew' >> /home/node/.bashrc && \\
    echo 'export HOMEBREW_CELLAR=/home/linuxbrew/.linuxbrew/Cellar' >> /home/node/.bashrc && \\
    echo 'export HOMEBREW_REPOSITORY=/home/linuxbrew/.linuxbrew/Homebrew' >> /home/node/.bashrc
USER root

# Install Tailscale CLI (useful for ad-hoc troubleshooting from gateway).
RUN curl -fsSL https://tailscale.com/install.sh | sh

WORKDIR /app
RUN chown node:node /app

ENV OPENCLAW_VERSION=${opts.version}
ENV OPENCLAW_CONFIG_DIR=${configDir}
ENV OPENCLAW_WORKSPACE_DIR=${workspaceDir}
ENV OPENCLAW_GATEWAY_PORT=${gatewayPort}

# Create config and workspace directories (700 = owner-only, per openclaw doctor)
RUN mkdir -p "\${OPENCLAW_CONFIG_DIR}" "\${OPENCLAW_WORKSPACE_DIR}" && \\
    chown -R node:node "\${OPENCLAW_CONFIG_DIR}" "\${OPENCLAW_WORKSPACE_DIR}" && \\
    chmod 700 "\${OPENCLAW_CONFIG_DIR}"

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
${renderImageSteps(opts.imageSteps ?? [])}# Ensure node owns everything in its home directory (catches root-created
# files from Playwright, npm, uv, etc. that would break runtime writes).
RUN chown -R node:node /home/node

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

# Force pnpm for package operations (Bun may fail on ARM/Synology architectures).
ENV OPENCLAW_PREFER_PNPM=1
ENV NODE_ENV=production
ENV OPENCLAW_NO_RESPAWN=1
ENV NODE_COMPILE_CACHE=${NODE_COMPILE_CACHE_DIR}

# Gateway binds to loopback — Tailscale Serve handles external access.
ENV OPENCLAW_BRIDGE_PORT=18790
ENV OPENCLAW_GATEWAY_BIND=loopback

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
  for (const s of steps) {
    if (!s.run || s.run.trim().length === 0) {
      throw new Error("imageSteps: 'run' must be a non-empty string");
    }
  }
  const lines = steps.map((s) => `RUN ${s.run}`);
  return lines.join("\n") + "\n\n";
}
