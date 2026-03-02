import { describe, it, expect } from "vitest";
import { renderDockerfile, type DockerfileOpts } from "../templates/dockerfile";
import { renderEntrypoint } from "../templates/entrypoint";
import {
  DOCKER_BASE_IMAGE,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_GATEWAY_BIND,
  ENVOY_EGRESS_PORT,
} from "../config/defaults";

const defaultOpts: DockerfileOpts = { version: "2026.2" };

describe("renderDockerfile", () => {
  it("uses correct base image", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain(`FROM ${DOCKER_BASE_IMAGE}`);
  });

  it("contains version in OPENCLAW_VERSION env", () => {
    const df = renderDockerfile({ version: "1.2.3" });
    expect(df).toContain("OPENCLAW_VERSION=1.2.3");
  });

  it("installs iptables", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("iptables");
  });

  it("installs iproute2", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("iproute2");
  });

  it("installs gosu", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("gosu");
  });

  it("installs libsecret-tools", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("libsecret-tools");
  });

  it("installs pnpm and sets PNPM_HOME", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("npm install -g pnpm");
    expect(df).toContain("PNPM_HOME=/home/node/.local/share/pnpm");
  });

  it("installs bun and copies to /usr/local/bin", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("https://bun.sh/install");
    expect(df).toContain("cp /root/.bun/bin/bun /usr/local/bin/bun");
  });

  it("installs Homebrew as node user", () => {
    const df = renderDockerfile(defaultOpts);
    // Must switch to node user for brew install
    expect(df).toMatch(/USER node[\s\S]*Homebrew\/install[\s\S]*USER root/);
    expect(df).toContain("/home/linuxbrew/.linuxbrew/bin");
  });

  it("installs uv as node user", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("https://astral.sh/uv/install.sh");
    // Must run as node user
    expect(df).toMatch(/USER node\nRUN curl -LsSf https:\/\/astral\.sh\/uv/);
  });

  it("installs openclaw with SHARP_IGNORE_GLOBAL_LIBVIPS", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("SHARP_IGNORE_GLOBAL_LIBVIPS=1");
    expect(df).toContain('npm install -g --no-fund --no-audit "openclaw@');
  });

  it("sets ENTRYPOINT to entrypoint.sh", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain('ENTRYPOINT ["entrypoint.sh"]');
  });

  it("sets CMD to openclaw gateway --allow-unconfigured", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain('CMD ["openclaw", "gateway", "--allow-unconfigured"]');
  });

  it("uses default config dir when not specified", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain(`OPENCLAW_CONFIG_DIR=${DEFAULT_OPENCLAW_CONFIG_DIR}`);
  });

  it("uses default workspace dir when not specified", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain(
      `OPENCLAW_WORKSPACE_DIR=${DEFAULT_OPENCLAW_WORKSPACE_DIR}`,
    );
  });

  it("uses default gateway port when not specified", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain(`OPENCLAW_GATEWAY_PORT=${DEFAULT_GATEWAY_PORT}`);
  });

  it("uses default bridge port when not specified", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain(`OPENCLAW_BRIDGE_PORT=${DEFAULT_BRIDGE_PORT}`);
  });

  it("uses default gateway bind when not specified", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain(`OPENCLAW_GATEWAY_BIND=${DEFAULT_GATEWAY_BIND}`);
  });

  it("includes custom packages via OPENCLAW_DOCKER_APT_PACKAGES ARG", () => {
    const df = renderDockerfile({
      version: "latest",
      packages: ["ffmpeg", "imagemagick"],
    });
    expect(df).toContain('ARG OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg imagemagick"');
    expect(df).toContain("$OPENCLAW_DOCKER_APT_PACKAGES");
    // Core packages still present as direct install
    expect(df).toContain("iptables");
    expect(df).toContain("gosu");
  });

  it("emits empty OPENCLAW_DOCKER_APT_PACKAGES ARG when no packages", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain('ARG OPENCLAW_DOCKER_APT_PACKAGES=""');
  });

  it("browser block has empty default when installBrowser is false", () => {
    const df = renderDockerfile({ version: "latest", installBrowser: false });
    expect(df).toContain('ARG OPENCLAW_INSTALL_BROWSER=""');
    // Block is still present (allows --build-arg override)
    expect(df).toContain("playwright-core/cli.js");
  });

  it("browser block has empty default by default", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain('ARG OPENCLAW_INSTALL_BROWSER=""');
  });

  it("browser block has default 1 when installBrowser is true", () => {
    const df = renderDockerfile({ version: "latest", installBrowser: true });
    expect(df).toContain('ARG OPENCLAW_INSTALL_BROWSER="1"');
    expect(df).toContain("playwright-core/cli.js");
    expect(df).toContain("xvfb");
    expect(df).toContain("install --with-deps chromium");
  });

  it("respects custom config dir", () => {
    const df = renderDockerfile({
      version: "latest",
      configDir: "/custom/config",
    });
    expect(df).toContain("OPENCLAW_CONFIG_DIR=/custom/config");
  });

  it("respects custom gateway port", () => {
    const df = renderDockerfile({ version: "latest", gatewayPort: 9999 });
    expect(df).toContain("OPENCLAW_GATEWAY_PORT=9999");
  });

  it("sets OPENCLAW_PREFER_PNPM=1", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("OPENCLAW_PREFER_PNPM=1");
  });

  it("sets NODE_ENV=production", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("NODE_ENV=production");
  });

  it("copies entrypoint.sh to /usr/local/bin/", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("COPY entrypoint.sh /usr/local/bin/entrypoint.sh");
    expect(df).toContain("chmod 755 /usr/local/bin/entrypoint.sh");
  });

  it("creates CLI symlink", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("ln -sf");
    expect(df).toContain("/usr/local/bin/openclaw");
  });

  it("is idempotent — same args produce identical output", () => {
    const a = renderDockerfile(defaultOpts);
    const b = renderDockerfile(defaultOpts);
    expect(a).toBe(b);
  });

  it("different packages produce different Dockerfiles", () => {
    const a = renderDockerfile({ version: "latest", packages: ["ffmpeg"] });
    const b = renderDockerfile({ version: "latest", packages: ["imagemagick"] });
    expect(a).not.toBe(b);
    expect(a).toContain("ffmpeg");
    expect(b).toContain("imagemagick");
  });

  it("different versions produce different Dockerfiles", () => {
    const a = renderDockerfile({ version: "1.0.0" });
    const b = renderDockerfile({ version: "2.0.0" });
    expect(a).not.toBe(b);
    expect(a).toContain("OPENCLAW_VERSION=1.0.0");
    expect(b).toContain("OPENCLAW_VERSION=2.0.0");
  });

  it("empty packages list produces valid Dockerfile without trailing spaces in apt-get", () => {
    const df = renderDockerfile({ version: "latest", packages: [] });
    expect(df).toContain('ARG OPENCLAW_DOCKER_APT_PACKAGES=""');
    // No trailing spaces in apt-get install lines
    const lines = df.split("\n");
    for (const line of lines) {
      if (line.includes("apt-get install")) {
        expect(line).not.toMatch(/ $/);
      }
    }
  });

  it("very long package lists don't break formatting", () => {
    const packages = Array.from({ length: 30 }, (_, i) => `pkg-${i}`);
    const df = renderDockerfile({ version: "latest", packages });
    // All packages present in the ARG
    expect(df).toContain(`ARG OPENCLAW_DOCKER_APT_PACKAGES="${packages.join(" ")}"`);
    // Still a valid Dockerfile (has FROM and ENTRYPOINT)
    expect(df).toContain(`FROM ${DOCKER_BASE_IMAGE}`);
    expect(df).toContain('ENTRYPOINT ["entrypoint.sh"]');
  });
});

describe("renderEntrypoint", () => {
  const ep = renderEntrypoint();

  it("has bash shebang", () => {
    expect(ep).toMatch(/^#!\/bin\/bash\n/);
  });

  it("has set -euo pipefail", () => {
    expect(ep).toContain("set -euo pipefail");
  });

  it("resolves Envoy IP via getent hosts envoy", () => {
    expect(ep).toContain("getent hosts envoy");
  });

  it("errors if Envoy IP is empty", () => {
    expect(ep).toContain('if [ -z "$ENVOY_IP" ]');
    expect(ep).toContain("exit 1");
  });

  it("derives INTERNAL_SUBNET from Envoy IP", () => {
    expect(ep).toContain("INTERNAL_SUBNET=");
    expect(ep).toContain('.0/24"');
  });

  it("adds default route via Envoy", () => {
    expect(ep).toContain('ip route add default via "$ENVOY_IP"');
  });

  it("restores DOCKER_OUTPUT chain", () => {
    expect(ep).toContain(
      "iptables -t nat -A OUTPUT -j DOCKER_OUTPUT 2>/dev/null || true",
    );
  });

  it("has iptables NAT DNAT to Envoy egress port", () => {
    expect(ep).toContain(
      `--to-destination "$ENVOY_IP":${ENVOY_EGRESS_PORT}`,
    );
  });

  it("skips DNAT for loopback", () => {
    expect(ep).toContain("iptables -t nat -A OUTPUT -o lo -j RETURN");
  });

  it("skips DNAT for internal subnet", () => {
    expect(ep).toContain(
      'iptables -t nat -A OUTPUT -p tcp -d "$INTERNAL_SUBNET" -j RETURN',
    );
  });

  it("sets OUTPUT policy to DROP", () => {
    expect(ep).toContain("iptables -P OUTPUT DROP");
  });

  it("allows loopback in FILTER table", () => {
    expect(ep).toContain("iptables -A OUTPUT -o lo -j ACCEPT");
  });

  it("allows Docker DNS (127.0.0.11:53 UDP)", () => {
    expect(ep).toContain(
      "iptables -A OUTPUT -d 127.0.0.11/32 -p udp --dport 53 -j ACCEPT",
    );
  });

  it("allows established/related connections", () => {
    expect(ep).toContain(
      "iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT",
    );
  });

  it("allows internal subnet traffic", () => {
    expect(ep).toContain(
      'iptables -A OUTPUT -d "$INTERNAL_SUBNET" -j ACCEPT',
    );
  });

  it("logs blocked connections with OPENCLAW-BLOCKED prefix", () => {
    expect(ep).toContain('--log-prefix "OPENCLAW-BLOCKED: "');
  });

  it("drops to node user via exec gosu node", () => {
    expect(ep).toContain('exec gosu node "$@"');
  });

  it("flushes existing iptables rules", () => {
    expect(ep).toContain("iptables -F OUTPUT");
    expect(ep).toContain("iptables -F INPUT");
    expect(ep).toContain("iptables -t nat -F OUTPUT");
  });

  it("is valid bash — no TypeScript interpolation artifacts", () => {
    // Template literals with ${} should be bash variables, not TS artifacts
    // Check there are no unescaped TS template expressions
    expect(ep).not.toContain("undefined");
    expect(ep).not.toContain("[object");
    expect(ep).not.toContain("NaN");
    // All ${...} in the output should be valid bash variable references
    const templateExpressions = ep.match(/\$\{[^}]+\}/g) ?? [];
    for (const expr of templateExpressions) {
      // Bash variable patterns: ${VAR}, ${VAR%.*}, ${VAR:-default}
      expect(expr).toMatch(
        /^\$\{[A-Z_][A-Z0-9_]*(%\.\*|:-[^}]*|#[^}]*|##[^}]*)?\}$/,
      );
    }
  });
});
