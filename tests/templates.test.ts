import { describe, it, expect } from "vitest";
import { renderDockerfile, type DockerfileOpts } from "../templates/dockerfile";
import { renderEntrypoint } from "../templates/entrypoint";
import {
  DOCKER_BASE_IMAGE,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  DEFAULT_GATEWAY_PORT,
  ENVOY_EGRESS_PORT,
  TTYD_PORT,
  FILEBROWSER_PORT,
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

  it("sets CMD to openclaw gateway with port only (no --bind, no --tailscale)", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain(
      `CMD ["openclaw", "gateway", "--port", "${DEFAULT_GATEWAY_PORT}"]`,
    );
    // Must NOT contain --bind or --tailscale in CMD
    const cmdLine = df.split("\n").find((l) => l.startsWith("CMD "));
    expect(cmdLine).not.toContain("--bind");
    expect(cmdLine).not.toContain("--tailscale");
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

  it("installs Tailscale via official install script", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("https://tailscale.com/install.sh");
  });

  it("installs ttyd", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("ttyd");
    expect(df).toContain("/usr/local/bin/ttyd");
  });

  it("installs filebrowser", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("filebrowser/get/master/get.sh");
  });

  it("is idempotent — same args produce identical output", () => {
    const a = renderDockerfile(defaultOpts);
    const b = renderDockerfile(defaultOpts);
    expect(a).toBe(b);
  });

  it("different versions produce different Dockerfiles", () => {
    const a = renderDockerfile({ version: "1.0.0" });
    const b = renderDockerfile({ version: "2.0.0" });
    expect(a).not.toBe(b);
    expect(a).toContain("OPENCLAW_VERSION=1.0.0");
    expect(b).toContain("OPENCLAW_VERSION=2.0.0");
  });

  describe("imageSteps", () => {
    it("renders imageSteps as USER+RUN pairs", () => {
      const df = renderDockerfile({
        version: "latest",
        imageSteps: [
          { user: "root", run: "apt-get install -y ffmpeg" },
          { user: "node", run: "npm install -g some-tool" },
        ],
      });
      expect(df).toContain("USER root\nRUN apt-get install -y ffmpeg");
      expect(df).toContain("USER node\nRUN npm install -g some-tool");
    });

    it("restores USER root after imageSteps for entrypoint COPY", () => {
      const df = renderDockerfile({
        version: "latest",
        imageSteps: [{ user: "node", run: "echo hello" }],
      });
      // After imageSteps, should have USER root before COPY
      const stepsIdx = df.indexOf("RUN echo hello");
      const userRootIdx = df.indexOf("USER root", stepsIdx);
      const copyIdx = df.indexOf("COPY entrypoint.sh", stepsIdx);
      expect(userRootIdx).toBeGreaterThan(stepsIdx);
      expect(copyIdx).toBeGreaterThan(userRootIdx);
    });

    it("places imageSteps after openclaw install and before entrypoint COPY", () => {
      const df = renderDockerfile({
        version: "latest",
        imageSteps: [{ user: "root", run: "echo custom-step" }],
      });
      const openclawIdx = df.indexOf("npm install -g --no-fund --no-audit");
      const customIdx = df.indexOf("echo custom-step");
      const copyIdx = df.indexOf("COPY entrypoint.sh");
      expect(customIdx).toBeGreaterThan(openclawIdx);
      expect(customIdx).toBeLessThan(copyIdx);
    });

    it("no imageSteps produces valid Dockerfile without extra USER directives", () => {
      const df = renderDockerfile(defaultOpts);
      // Should not have a bare "USER root" right before COPY (only from standard flow)
      expect(df).not.toContain("USER root\n\nCOPY entrypoint.sh");
    });
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
    expect(ep).toContain(`--to-destination "$ENVOY_IP":${ENVOY_EGRESS_PORT}`);
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
    expect(ep).toContain('iptables -A OUTPUT -d "$INTERNAL_SUBNET" -j ACCEPT');
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

  describe("TCP mappings", () => {
    it("contains OPENCLAW_TCP_MAPPINGS env var reference", () => {
      expect(ep).toContain("OPENCLAW_TCP_MAPPINGS");
    });

    it("parses semicolon-delimited entries with pipe field separator", () => {
      expect(ep).toContain("IFS=';'");
      expect(ep).toContain("TCP_ENTRIES");
      // Fields within each entry use | (not : which conflicts with IPv6)
      expect(ep).toContain("IFS='|'");
      expect(ep).toContain("dst|dstPort|envoyPort");
    });

    it("resolves domains via getent ahostsv4", () => {
      expect(ep).toContain("getent ahostsv4");
    });

    it("handles IPv4 destinations without resolution", () => {
      expect(ep).toContain("grep -qE");
      expect(ep).toMatch(/\[0-9\]\{1,3\}/);
      expect(ep).toContain('RESOLVED_IP="$DST"');
    });

    it("skips IPv6 destinations with warning (iptables is IPv4-only)", () => {
      expect(ep).toContain("grep -q ':'");
      expect(ep).toContain("IPv6 destination");
      expect(ep).toContain("iptables routing is IPv4-only");
    });

    it("per-destination DNAT rules appear before catch-all", () => {
      const tcpMappingIdx = ep.indexOf("OPENCLAW_TCP_MAPPINGS");
      const catchAllIdx = ep.indexOf(
        `--to-destination "$ENVOY_IP":${ENVOY_EGRESS_PORT}`,
      );
      expect(tcpMappingIdx).toBeGreaterThan(-1);
      expect(catchAllIdx).toBeGreaterThan(-1);
      expect(tcpMappingIdx).toBeLessThan(catchAllIdx);
    });

    it("warns on malformed entries", () => {
      expect(ep).toContain("malformed TCP mapping");
    });

    it("warns on unresolvable domains", () => {
      expect(ep).toContain("cannot resolve");
      expect(ep).toContain("TCP mapping");
    });

    it("uses DNAT to route to specific Envoy port per mapping", () => {
      expect(ep).toContain(
        '-j DNAT --to-destination "$ENVOY_IP":"$ENVOY_PORT"',
      );
    });

    it("only processes mappings when env var is set", () => {
      // Should be conditional on OPENCLAW_TCP_MAPPINGS being non-empty
      expect(ep).toContain("${OPENCLAW_TCP_MAPPINGS:-}");
    });

    it("has || true on getent ahostsv4 pipeline for TCP mappings", () => {
      // The RESOLVED_IP line must have || true to prevent pipefail from killing the script
      const tcpSection = ep.substring(
        ep.indexOf("OPENCLAW_TCP_MAPPINGS"),
        ep.indexOf("OPENCLAW_UDP_MAPPINGS"),
      );
      expect(tcpSection).toContain(
        'getent ahostsv4 "$DST" 2>/dev/null | head -1 | awk \'{print $1}\')" || true',
      );
    });
  });

  describe("UDP mappings", () => {
    it("contains OPENCLAW_UDP_MAPPINGS env var reference", () => {
      expect(ep).toContain("OPENCLAW_UDP_MAPPINGS");
    });

    it("parses semicolon-delimited UDP entries with pipe field separator", () => {
      expect(ep).toContain("UDP_ENTRIES");
    });

    it("resolves UDP domains via getent ahostsv4", () => {
      // Both TCP and UDP sections use getent ahostsv4 for domain resolution
      const matches = ep.match(/getent ahostsv4/g);
      expect(matches!.length).toBeGreaterThanOrEqual(4); // 2 per mapping type (resolve + validate)
    });

    it("per-destination UDP DNAT rules appear before TCP catch-all", () => {
      const udpMappingIdx = ep.indexOf("OPENCLAW_UDP_MAPPINGS");
      const catchAllIdx = ep.indexOf(
        `--to-destination "$ENVOY_IP":${ENVOY_EGRESS_PORT}`,
      );
      expect(udpMappingIdx).toBeGreaterThan(-1);
      expect(catchAllIdx).toBeGreaterThan(-1);
      expect(udpMappingIdx).toBeLessThan(catchAllIdx);
    });

    it("uses -p udp for UDP DNAT rules", () => {
      expect(ep).toContain("iptables -t nat -A OUTPUT -p udp");
    });

    it("warns on malformed UDP entries", () => {
      expect(ep).toContain("malformed UDP mapping");
    });

    it("only processes UDP mappings when env var is set", () => {
      expect(ep).toContain("${OPENCLAW_UDP_MAPPINGS:-}");
    });

    it("has || true on getent ahostsv4 pipeline for UDP mappings", () => {
      const udpSection = ep.substring(ep.indexOf("OPENCLAW_UDP_MAPPINGS"));
      expect(udpSection).toContain(
        'getent ahostsv4 "$DST" 2>/dev/null | head -1 | awk \'{print $1}\')" || true',
      );
    });
  });

  describe("Tailscale daemon startup", () => {
    it("always starts tailscaled (no conditional)", () => {
      expect(ep).toContain("tailscaled --tun=userspace-networking");
      // Should NOT have if [ -d "/var/lib/tailscale" ] guarding tailscaled
      expect(ep).not.toContain('if [ -d "/var/lib/tailscale" ]');
    });

    it("uses userspace networking (no TUN device needed)", () => {
      expect(ep).toContain("--tun=userspace-networking");
    });

    it("waits for daemon to be ready", () => {
      expect(ep).toContain("seq 1 30");
      expect(ep).toContain(
        "tailscale --socket=/var/run/tailscale/tailscaled.sock status",
      );
    });

    it("authenticates with TAILSCALE_AUTHKEY and --ssh flag", () => {
      expect(ep).toContain("${TAILSCALE_AUTHKEY:-}");
      expect(ep).toContain(
        'tailscale --socket=/var/run/tailscale/tailscaled.sock up --authkey="$TAILSCALE_AUTHKEY" --ssh',
      );
    });

    it("sets --ssh and --operator=node after auth", () => {
      expect(ep).toContain(
        "tailscale --socket=/var/run/tailscale/tailscaled.sock set --ssh --operator=node",
      );
    });

    it("runs tailscaled AFTER iptables setup", () => {
      const iptablesIdx = ep.indexOf("iptables -P OUTPUT DROP");
      const tailscaledIdx = ep.indexOf("tailscaled --tun=userspace-networking");
      expect(iptablesIdx).toBeGreaterThan(-1);
      expect(tailscaledIdx).toBeGreaterThan(-1);
      expect(tailscaledIdx).toBeGreaterThan(iptablesIdx);
    });

    it("runs tailscaled BEFORE exec gosu node", () => {
      const tailscaledIdx = ep.indexOf("tailscaled --tun=userspace-networking");
      const gosuIdx = ep.indexOf('exec gosu node "$@"');
      expect(tailscaledIdx).toBeGreaterThan(-1);
      expect(gosuIdx).toBeGreaterThan(-1);
      expect(tailscaledIdx).toBeLessThan(gosuIdx);
    });
  });

  describe("web tools", () => {
    it("starts ttyd on loopback", () => {
      expect(ep).toContain(
        `gosu node ttyd --port ${TTYD_PORT} --interface lo --writable bash`,
      );
    });

    it("starts filebrowser on loopback", () => {
      expect(ep).toContain(
        `gosu node filebrowser --address 127.0.0.1 --port ${FILEBROWSER_PORT} --noauth --root /home/node --baseurl /files`,
      );
    });

    it("configures tailscale serve paths for web tools", () => {
      expect(ep).toContain(`serve --bg --set-path /shell ${TTYD_PORT}`);
      expect(ep).toContain(`serve --bg --set-path /files ${FILEBROWSER_PORT}`);
    });

    it("web tools start AFTER tailscale", () => {
      const tailscaleSetIdx = ep.indexOf("set --ssh --operator=node");
      const ttydIdx = ep.indexOf("gosu node ttyd");
      expect(tailscaleSetIdx).toBeGreaterThan(-1);
      expect(ttydIdx).toBeGreaterThan(-1);
      expect(ttydIdx).toBeGreaterThan(tailscaleSetIdx);
    });

    it("web tools start BEFORE exec gosu node", () => {
      const ttydIdx = ep.indexOf("gosu node ttyd");
      const gosuIdx = ep.indexOf('exec gosu node "$@"');
      expect(ttydIdx).toBeGreaterThan(-1);
      expect(gosuIdx).toBeGreaterThan(-1);
      expect(ttydIdx).toBeLessThan(gosuIdx);
    });
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
      // Bash variable patterns: ${VAR}, ${VAR%.*}, ${VAR:-default}, ${VAR:+alt}, ${VAR[@]}
      expect(expr).toMatch(
        /^\$\{[A-Z_][A-Z0-9_]*(%\.\*|:-[^}]*|:\+[^}]*|#[^}]*|##[^}]*|\[@\])?\}$/,
      );
    }
  });
});
