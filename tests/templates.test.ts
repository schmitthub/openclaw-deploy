import { describe, it, expect } from "vitest";
import { renderDockerfile, type DockerfileOpts } from "../templates/dockerfile";
import { renderEntrypoint } from "../templates/entrypoint";
import { renderSidecarEntrypoint } from "../templates/sidecar";
import { renderServeConfig } from "../templates/serve";
import {
  DOCKER_BASE_IMAGE,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  DEFAULT_GATEWAY_PORT,
  ENVOY_EGRESS_PORT,
  ENVOY_UID,
  SSHD_PORT,
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

  it("does not install iptables (sidecar handles networking)", () => {
    const df = renderDockerfile(defaultOpts);
    // Should not be in the apt-get install line
    const aptLine = df.split("\n").find((l) => l.includes("apt-get install"));
    expect(aptLine).not.toContain("iptables");
  });

  it("does not install iproute2 (sidecar handles networking)", () => {
    const df = renderDockerfile(defaultOpts);
    const aptLine = df.split("\n").find((l) => l.includes("apt-get install"));
    expect(aptLine).not.toContain("iproute2");
  });

  it("installs openssh-server", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("openssh-server");
  });

  it("configures sshd on loopback with port 2222", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("ListenAddress 127.0.0.1");
    expect(df).toContain(`Port ${SSHD_PORT}`);
    expect(df).toContain("PermitRootLogin yes");
    expect(df).toContain("PermitEmptyPasswords yes");
    expect(df).toContain("UsePAM no");
    expect(df).toContain("passwd -d root");
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

  it("installs Homebrew via linuxbrew user with ENV vars and Library symlink", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew");
    expect(df).toContain("su - linuxbrew");
    expect(df).toContain("CI=1");
    expect(df).toContain("usermod -aG linuxbrew node");
  });

  it("installs uv as node user", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("https://astral.sh/uv/install.sh");
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

  it("sets CMD to openclaw gateway with port only (no --tailscale)", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain(
      `CMD ["openclaw", "gateway", "--port", "${DEFAULT_GATEWAY_PORT}"]`,
    );
    expect(df).not.toContain("--tailscale");
  });

  it("sets OPENCLAW_BRIDGE_PORT and OPENCLAW_GATEWAY_BIND env vars", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("OPENCLAW_BRIDGE_PORT=18790");
    expect(df).toContain("OPENCLAW_GATEWAY_BIND=loopback");
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
    expect(df).toContain("playwright-core/cli.js");
  });

  it("browser block has default 1 when installBrowser is true", () => {
    const df = renderDockerfile({ version: "latest", installBrowser: true });
    expect(df).toContain('ARG OPENCLAW_INSTALL_BROWSER="1"');
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

  it("installs Tailscale CLI via official install script", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("https://tailscale.com/install.sh");
  });

  it("does not install ttyd (replaced by SSH)", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).not.toMatch(/install.*ttyd|ttyd.*install|RUN.*ttyd/);
  });

  it("installs filebrowser via official install script", () => {
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
    it("renders imageSteps as RUN instructions (always root)", () => {
      const df = renderDockerfile({
        version: "latest",
        imageSteps: [
          { run: "apt-get install -y ffmpeg" },
          { run: "apt-get install -y some-lib" },
        ],
      });
      expect(df).toContain("RUN apt-get install -y ffmpeg");
      expect(df).toContain("RUN apt-get install -y some-lib");
    });

    it("places imageSteps after openclaw install and before entrypoint COPY", () => {
      const df = renderDockerfile({
        version: "latest",
        imageSteps: [{ run: "echo custom-step" }],
      });
      const openclawIdx = df.indexOf("npm install -g --no-fund --no-audit");
      const customIdx = df.indexOf("echo custom-step");
      const copyIdx = df.indexOf("COPY entrypoint.sh");
      expect(customIdx).toBeGreaterThan(openclawIdx);
      expect(customIdx).toBeLessThan(copyIdx);
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

  it("does NOT run iptables commands (sidecar handles networking)", () => {
    expect(ep).not.toMatch(/^iptables /m);
    expect(ep).not.toContain("iptables -");
  });

  it("does NOT contain ip route (sidecar handles routing)", () => {
    expect(ep).not.toContain("ip route");
  });

  it("does NOT start tailscaled process (sidecar handles Tailscale)", () => {
    expect(ep).not.toContain("tailscaled --tun");
    expect(ep).not.toContain("tailscaled &");
  });

  it("does NOT contain TAILSCALE_AUTHKEY (sidecar handles auth)", () => {
    expect(ep).not.toContain("TAILSCALE_AUTHKEY");
  });

  it("does NOT wait for Tailscale socket (containerboot manages it internally)", () => {
    expect(ep).not.toContain("tailscaled.sock");
  });

  it("does NOT start ttyd (replaced by SSH)", () => {
    expect(ep).not.toContain("ttyd");
  });

  it("starts filebrowser on loopback at /browse", () => {
    expect(ep).toContain("filebrowser");
    expect(ep).toContain("--address 127.0.0.1");
    expect(ep).toContain("--port 8080");
    expect(ep).toContain("--baseurl /browse");
    expect(ep).toContain("--root /home/node");
  });

  it("starts filebrowser BEFORE exec gosu node", () => {
    const fbIdx = ep.indexOf("filebrowser --address");
    const gosuIdx = ep.indexOf('exec gosu node "$@"');
    expect(fbIdx).toBeGreaterThan(-1);
    expect(gosuIdx).toBeGreaterThan(-1);
    expect(fbIdx).toBeLessThan(gosuIdx);
  });

  it("does NOT configure Tailscale serve paths (handled by TS_SERVE_CONFIG)", () => {
    expect(ep).not.toContain("tailscale serve");
    expect(ep).not.toContain("serve --bg");
  });

  it("starts sshd", () => {
    expect(ep).toContain("/usr/sbin/sshd");
  });

  it("drops to node user via exec gosu node", () => {
    expect(ep).toContain('exec gosu node "$@"');
  });

  it("fixes config dir permissions", () => {
    expect(ep).toContain("chown node:node /home/node/.openclaw");
    expect(ep).toContain("chmod 700 /home/node/.openclaw");
  });

  it("fixes git safe.directory for linuxbrew", () => {
    expect(ep).toContain("safe.directory");
    expect(ep).toContain("/home/linuxbrew/.linuxbrew/Homebrew");
  });

  it("sshd starts BEFORE exec gosu node", () => {
    const sshdIdx = ep.indexOf("/usr/sbin/sshd");
    const gosuIdx = ep.indexOf('exec gosu node "$@"');
    expect(sshdIdx).toBeGreaterThan(-1);
    expect(gosuIdx).toBeGreaterThan(-1);
    expect(sshdIdx).toBeLessThan(gosuIdx);
  });

  it("is valid bash — no TypeScript interpolation artifacts", () => {
    expect(ep).not.toContain("undefined");
    expect(ep).not.toContain("[object");
    expect(ep).not.toContain("NaN");
  });
});

describe("renderSidecarEntrypoint", () => {
  const sep = renderSidecarEntrypoint();

  it("has sh shebang", () => {
    expect(sep).toMatch(/^#!\/bin\/sh\n/);
  });

  it("has set -eu", () => {
    expect(sep).toContain("set -eu");
  });

  it("does NOT resolve Envoy IP (shared netns, localhost)", () => {
    expect(sep).not.toContain("getent hosts envoy");
    expect(sep).not.toContain("ENVOY_IP");
  });

  it("does NOT add default route (not needed in shared netns)", () => {
    expect(sep).not.toContain("ip route");
  });

  it("does NOT set FILTER table OUTPUT DROP policy", () => {
    expect(sep).not.toContain("iptables -P OUTPUT DROP");
  });

  it("does NOT restore DOCKER_OUTPUT chain", () => {
    expect(sep).not.toContain("DOCKER_OUTPUT");
  });

  it("excludes envoy (uid ${ENVOY_UID}) from redirect", () => {
    expect(sep).toContain(
      `iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner ${ENVOY_UID} -j RETURN`,
    );
  });

  it("excludes root (uid 0) from redirect", () => {
    expect(sep).toContain(
      "iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner 0 -j RETURN",
    );
  });

  it("uses REDIRECT instead of DNAT for catch-all", () => {
    expect(sep).toContain(`-j REDIRECT --to-ports ${ENVOY_EGRESS_PORT}`);
    expect(sep).not.toContain("--to-destination");
  });

  it("excludes loopback from catch-all REDIRECT", () => {
    expect(sep).toContain("! -d 127.0.0.0/8 -j REDIRECT");
  });

  it("allows Docker DNS (127.0.0.11) UDP", () => {
    expect(sep).toContain("iptables -A OUTPUT -p udp -d 127.0.0.11 -j ACCEPT");
  });

  describe("UDP owner-match rules", () => {
    it("allows UDP from root (uid 0) only", () => {
      expect(sep).toContain(
        "iptables -A OUTPUT -p udp -m owner --uid-owner 0 -j ACCEPT",
      );
    });

    it("drops all other UDP", () => {
      expect(sep).toContain("iptables -A OUTPUT -p udp -j DROP");
    });

    it("UDP ACCEPT rule comes before UDP DROP rule", () => {
      const acceptIdx = sep.indexOf("--uid-owner 0 -j ACCEPT");
      const dropIdx = sep.indexOf("-p udp -j DROP");
      expect(acceptIdx).toBeGreaterThan(-1);
      expect(dropIdx).toBeGreaterThan(-1);
      expect(acceptIdx).toBeLessThan(dropIdx);
    });
  });

  describe("TCP mappings", () => {
    it("contains OPENCLAW_TCP_MAPPINGS env var reference", () => {
      expect(sep).toContain("OPENCLAW_TCP_MAPPINGS");
    });

    it("resolves domains via getent ahostsv4", () => {
      expect(sep).toContain("getent ahostsv4");
    });

    it("handles IPv4 destinations without resolution", () => {
      expect(sep).toContain("grep -qE");
      expect(sep).toContain('RESOLVED_IP="$DST"');
    });

    it("skips IPv6 destinations with warning", () => {
      expect(sep).toContain("grep -q ':'");
      expect(sep).toContain("IPv6 destination");
    });

    it("per-destination REDIRECT rules appear before catch-all", () => {
      const tcpMappingIdx = sep.indexOf("OPENCLAW_TCP_MAPPINGS");
      const catchAllIdx = sep.indexOf(
        `-j REDIRECT --to-ports ${ENVOY_EGRESS_PORT}`,
      );
      expect(tcpMappingIdx).toBeGreaterThan(-1);
      expect(catchAllIdx).toBeGreaterThan(-1);
      expect(tcpMappingIdx).toBeLessThan(catchAllIdx);
    });

    it("uses REDIRECT for per-destination rules (not DNAT)", () => {
      expect(sep).toContain('-j REDIRECT --to-ports "$ENVOY_PORT"');
    });

    it("warns on malformed entries", () => {
      expect(sep).toContain("malformed TCP mapping");
    });

    it("warns on unresolvable domains", () => {
      expect(sep).toContain("cannot resolve");
      expect(sep).toContain("TCP mapping");
    });

    it("only processes mappings when env var is set", () => {
      expect(sep).toContain("${OPENCLAW_TCP_MAPPINGS:-}");
    });

    it("has || true on getent ahostsv4 pipeline for TCP mappings", () => {
      expect(sep).toContain(
        'getent ahostsv4 "$DST" 2>/dev/null | head -1 | awk \'{print $1}\')" || true',
      );
    });
  });

  describe("containerboot handoff", () => {
    it("execs containerboot (official Tailscale entrypoint)", () => {
      expect(sep).toContain("exec /usr/local/bin/containerboot");
    });

    it("does NOT start tailscaled manually", () => {
      expect(sep).not.toContain("tailscaled --tun");
      expect(sep).not.toContain("TAILSCALED_PID");
    });

    it("does NOT authenticate with TAILSCALE_AUTHKEY (containerboot does that)", () => {
      expect(sep).not.toContain("tailscale up");
      expect(sep).not.toContain("TAILSCALE_AUTHKEY");
    });

    it("does NOT set --ssh or --operator (containerboot manages Tailscale state)", () => {
      expect(sep).not.toContain("tailscale set");
      expect(sep).not.toContain("--operator=node");
    });
  });

  it("does NOT contain UDP mappings (sidecar uses owner-match)", () => {
    expect(sep).not.toContain("OPENCLAW_UDP_MAPPINGS");
  });

  it("does NOT drop to node user (sidecar stays as root for containerboot)", () => {
    expect(sep).not.toContain("gosu node");
    expect(sep).not.toContain("exec gosu");
  });
});

describe("renderServeConfig", () => {
  it("produces valid JSON", () => {
    const config = renderServeConfig(18789, 2222);
    expect(() => JSON.parse(config)).not.toThrow();
  });

  it("configures HTTPS on port 443", () => {
    const config = JSON.parse(renderServeConfig(18789, 2222));
    expect(config.TCP["443"].HTTPS).toBe(true);
  });

  it("configures SSH TCP forwarding on port 22", () => {
    const config = JSON.parse(renderServeConfig(18789, 2222));
    expect(config.TCP["22"].TCPForward).toBe("127.0.0.1:2222");
  });

  it("configures web handler proxy to gateway port", () => {
    const config = JSON.parse(renderServeConfig(18789, 2222));
    const webKey = "${TS_CERT_DOMAIN}:443";
    expect(config.Web[webKey].Handlers["/"].Proxy).toBe(
      "http://127.0.0.1:18789",
    );
  });

  it("configures web handler proxy to filebrowser at /browse/", () => {
    const config = JSON.parse(renderServeConfig(18789, 2222));
    const webKey = "${TS_CERT_DOMAIN}:443";
    expect(config.Web[webKey].Handlers["/browse/"].Proxy).toBe(
      `http://127.0.0.1:${FILEBROWSER_PORT}`,
    );
  });

  it("disables Funnel", () => {
    const config = JSON.parse(renderServeConfig(18789, 2222));
    const funnelKey = "${TS_CERT_DOMAIN}:443";
    expect(config.AllowFunnel[funnelKey]).toBe(false);
  });

  it("uses custom gateway port", () => {
    const config = JSON.parse(renderServeConfig(9999, 2222));
    const webKey = "${TS_CERT_DOMAIN}:443";
    expect(config.Web[webKey].Handlers["/"].Proxy).toBe(
      "http://127.0.0.1:9999",
    );
  });

  it("uses custom filebrowser port", () => {
    const config = JSON.parse(renderServeConfig(18789, 2222, 9090));
    const webKey = "${TS_CERT_DOMAIN}:443";
    expect(config.Web[webKey].Handlers["/browse/"].Proxy).toBe(
      "http://127.0.0.1:9090",
    );
  });

  it("uses custom sshd port", () => {
    const config = JSON.parse(renderServeConfig(18789, 3333));
    expect(config.TCP["22"].TCPForward).toBe("127.0.0.1:3333");
  });

  it("uses default SSHD_PORT when not specified", () => {
    const config = JSON.parse(renderServeConfig(18789));
    expect(config.TCP["22"].TCPForward).toBe(`127.0.0.1:${SSHD_PORT}`);
  });
});
