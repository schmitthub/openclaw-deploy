#
# NOTE: THIS DOCKERFILE IS GENERATED VIA "openclaw-deploy"
#
# PLEASE DO NOT EDIT IT DIRECTLY.
#

FROM node:22-bookworm

# Pin node user UID/GID to 1000 (matches chown in Pulumi host provisioning).
RUN groupmod -g 1000 node && usermod -u 1000 node

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
# Note: iptables and iproute2 are NOT needed — the sidecar handles networking.
# Tailscale CLI is still needed for 'tailscale serve' commands in entrypoint.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      gosu libsecret-tools build-essential ripgrep jq openssh-server \
      $OPENCLAW_DOCKER_APT_PACKAGES && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Configure sshd with open access on loopback (guarded by tailscale sidecar)
RUN mkdir -p /run/sshd && \
  sed -i 's/#ListenAddress 0.0.0.0/ListenAddress 127.0.0.1/' /etc/ssh/sshd_config && \
  sed -i 's/#Port 22/Port 2222/' /etc/ssh/sshd_config && \
  sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
  sed -i 's/#PermitEmptyPasswords no/PermitEmptyPasswords yes/' /etc/ssh/sshd_config && \
  sed -i 's/UsePAM yes/UsePAM no/' /etc/ssh/sshd_config && \
  chown root:root /usr/bin/ssh && \
  chmod 700 /usr/bin/ssh && \
  ssh-keygen -A && \
  passwd -d root


# Install Bun (required for build scripts).
# Binary copied to /usr/local/bin/ so node user can access it at runtime.
# (Symlinking through /root/ fails — root home is mode 0700.)
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun

# Install pnpm globally (used by OpenClaw for skill/plugin installs at runtime).
# PNPM_HOME sets the global bin directory so pnpm install -g works as node user.
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH="${PNPM_HOME}:/home/node/.local/bin:${PATH}"
RUN npm install -g pnpm && \
    mkdir -p "${PNPM_HOME}" /home/node/.local/bin && chown -R node:node /home/node/.local

# Install Homebrew (Linuxbrew) via dedicated linuxbrew user at default prefix.
# Custom prefixes lose bottle (binary) support — everything builds from source.
# The /home/linuxbrew directory is mounted as a named volume for persistence across container recreations.
# The node user is added to the linuxbrew group for write access (brew install at runtime).
ENV HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew
ENV HOMEBREW_CELLAR=/home/linuxbrew/.linuxbrew/Cellar
ENV HOMEBREW_REPOSITORY=/home/linuxbrew/.linuxbrew/Homebrew
ENV PATH=/home/linuxbrew/.linuxbrew/bin:$PATH

RUN if ! id -u linuxbrew >/dev/null 2>&1; then useradd -m -s /bin/bash linuxbrew; fi; \
        usermod -aG linuxbrew node; \
        mkdir -p "/home/linuxbrew/.linuxbrew"; \
        chown -R linuxbrew:linuxbrew "/home/linuxbrew"; \
        su - linuxbrew -c "NONINTERACTIVE=1 CI=1 /bin/bash -c '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'"; \
        if [ ! -e "/home/linuxbrew/.linuxbrew/Library" ]; then ln -s "/home/linuxbrew/.linuxbrew/Homebrew/Library" "/home/linuxbrew/.linuxbrew/Library"; fi; \
        if [ ! -x "/home/linuxbrew/.linuxbrew/bin/brew" ]; then echo "brew install failed"; exit 1; fi; \
        chmod -R g+rwx "/home/linuxbrew";

# Install uv (Python package manager) as node user.
USER node
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
# Persist Homebrew env in .bashrc so it survives su - node (Docker ENV vars
# are lost when login shells reset the environment, e.g. via ttyd root shell).
RUN echo 'export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH' >> /home/node/.bashrc && \
    echo 'export HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew' >> /home/node/.bashrc && \
    echo 'export HOMEBREW_CELLAR=/home/linuxbrew/.linuxbrew/Cellar' >> /home/node/.bashrc && \
    echo 'export HOMEBREW_REPOSITORY=/home/linuxbrew/.linuxbrew/Homebrew' >> /home/node/.bashrc
USER root

WORKDIR /app
RUN chown node:node /app

ENV OPENCLAW_VERSION=latest
ENV OPENCLAW_CONFIG_DIR=/home/node/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace
ENV OPENCLAW_GATEWAY_PORT=18789
ENV OPENCLAW_BRIDGE_PORT=18790
ENV OPENCLAW_GATEWAY_BIND=loopback

# Create config and workspace directories (700 = owner-only, per openclaw doctor)
RUN mkdir -p "${OPENCLAW_CONFIG_DIR}" "${OPENCLAW_WORKSPACE_DIR}" && \
    chown -R node:node "${OPENCLAW_CONFIG_DIR}" "${OPENCLAW_WORKSPACE_DIR}" && \
    chmod 700 "${OPENCLAW_CONFIG_DIR}"

# Install OpenClaw via npm (global, as root → /usr/local).
# NODE_OPTIONS reduces OOM risk on low-memory hosts (exit 137).
RUN SHARP_IGNORE_GLOBAL_LIBVIPS=1 NODE_OPTIONS=--max-old-space-size=2048 \
    npm install -g --no-fund --no-audit "openclaw@${OPENCLAW_VERSION}"

# CLI symlink for consistent access across users
RUN ln -sf "$(npm root -g)/openclaw/dist/entry.js" /usr/local/bin/openclaw && \
    chmod 755 "$(npm root -g)/openclaw/dist/entry.js"

# Optional: bake Playwright + Chromium into the image for browser automation.
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      mkdir -p /home/node/.cache/ms-playwright && \
      PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
      node "$(npm root -g)/openclaw/node_modules/playwright-core/cli.js" install --with-deps chromium && \
      chown -R node:node /home/node/.cache/ms-playwright && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# Ensure node owns everything in its home directory (catches root-created
# files from Playwright, npm, uv, etc. that would break runtime writes).
RUN chown -R node:node /home/node

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

# Force pnpm for package operations (Bun may fail on ARM/Synology architectures).
ENV OPENCLAW_PREFER_PNPM=1
ENV NODE_ENV=production
ENV OPENCLAW_NO_RESPAWN=1
ENV NODE_COMPILE_CACHE=/home/node/.node-compile-cache

ENTRYPOINT ["entrypoint.sh"]
CMD ["openclaw", "gateway", "--port", "18789"]
