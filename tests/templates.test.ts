import { describe, it, expect } from "vitest";
import { renderDockerfile, type DockerfileOpts } from "../templates/dockerfile";
import { renderEntrypoint } from "../templates/entrypoint";
import { renderSidecarEntrypoint } from "../templates/sidecar";
import { renderServeConfig } from "../templates/serve";
import { renderFirewallBypass } from "../templates/bypass";
import { renderAgentPrompt } from "../templates/agent-prompt";
import { renderCorefile } from "../templates/coredns";
import {
  DOCKER_BASE_IMAGE,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  DEFAULT_GATEWAY_PORT,
  ENVOY_EGRESS_PORT,
  ENVOY_UID,
  SSHD_PORT,
  FILEBROWSER_PORT,
  BYPASS_SOCKS_PORT,
  DEFAULT_BYPASS_TIMEOUT_SECS,
  COREDNS_PORT,
  COREDNS_CONTAINER_PATH,
} from "../config";

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
      `CMD ["openclaw", "gateway", "run", "--port", "${DEFAULT_GATEWAY_PORT}"]`,
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

  it("does not include browser block when installBrowser is false", () => {
    const df = renderDockerfile({ version: "latest", installBrowser: false });
    expect(df).not.toContain(
      "apt-get install -y --no-install-recommends chromium",
    );
  });

  it("installs chromium and xvfb when installBrowser is true", () => {
    const df = renderDockerfile({ version: "latest", installBrowser: true });
    expect(df).toContain(
      "apt-get install -y --no-install-recommends chromium xvfb",
    );
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

  it("copies firewall-bypass to /usr/local/bin/ with root-only permissions", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("COPY firewall-bypass /usr/local/bin/firewall-bypass");
    expect(df).toContain("chmod 700 /usr/local/bin/firewall-bypass");
  });

  it("creates CLI wrapper", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("/usr/local/bin/openclaw");
    expect(df).toContain("exec bun");
  });

  it("does not install Tailscale CLI (handled by sidecar container)", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).not.toContain("tailscale.com/install.sh");
  });

  it("uses multi-stage build with downloads stage", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toMatch(
      /FROM debian:bookworm-slim@sha256:[a-f0-9]{64} AS downloads/,
    );
    expect(df).toContain("COPY --from=downloads /usr/local/bin/coredns");
    expect(df).toContain("COPY --from=downloads /usr/local/bin/bun");
  });

  it("uses multi-stage build with homebrew stage", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain(`FROM ${DOCKER_BASE_IMAGE} AS homebrew`);
    expect(df).toContain("COPY --from=homebrew /home/linuxbrew");
  });

  it("does not install ttyd (replaced by SSH)", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).not.toMatch(/install.*ttyd|ttyd.*install|RUN.*ttyd/);
  });

  it("installs pinned filebrowser from GitHub releases", () => {
    const df = renderDockerfile(defaultOpts);
    expect(df).toContain("filebrowser/filebrowser/releases/download/v");
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

  it("starts CoreDNS allowlist proxy as root before gosu drop", () => {
    expect(ep).toContain("coredns");
    expect(ep).toContain(`-dns.port ${COREDNS_PORT}`);
    expect(ep).toContain(COREDNS_CONTAINER_PATH);
  });

  it("treats CoreDNS as mandatory — fails if binary or config missing", () => {
    expect(ep).toContain("if [ ! -x /usr/local/bin/coredns ]");
    expect(ep).toContain(`if [ ! -f ${COREDNS_CONTAINER_PATH} ]`);
    expect(ep).toContain("coredns binary not found");
    expect(ep).toContain("Corefile not found");
  });

  it("verifies CoreDNS is running after start", () => {
    expect(ep).toContain("pgrep -x coredns");
    expect(ep).toContain("DNS allowlist is NOT active");
  });

  it("starts CoreDNS BEFORE exec gosu node", () => {
    const corednsIdx = ep.indexOf("coredns -conf");
    const gosuIdx = ep.indexOf('exec gosu node "$@"');
    expect(corednsIdx).toBeGreaterThan(-1);
    expect(gosuIdx).toBeGreaterThan(-1);
    expect(corednsIdx).toBeLessThan(gosuIdx);
  });

  it("monitors CoreDNS and kills PID 1 if it dies", () => {
    expect(ep).toContain("FATAL: CoreDNS died");
    expect(ep).toContain("kill 1");
  });

  it("CoreDNS monitor disables set -e to survive pgrep exit code 1", () => {
    expect(ep).toContain("set +e");
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

  it("redirects node user (uid 1000) DNS to CoreDNS allowlist proxy", () => {
    expect(sep).toContain(
      `iptables -t nat -A OUTPUT -p udp --dport 53 -m owner --uid-owner 1000 -j REDIRECT --to-port ${COREDNS_PORT}`,
    );
  });

  it("redirects TCP DNS (port 53) from node user to CoreDNS", () => {
    expect(sep).toContain(
      `iptables -t nat -A OUTPUT -p tcp --dport 53 -m owner --uid-owner 1000 -j REDIRECT --to-port ${COREDNS_PORT}`,
    );
  });

  it("DNS REDIRECT rules come BEFORE TCP catch-all", () => {
    const dnsRedirect = sep.indexOf("--dport 53 -m owner --uid-owner 1000");
    const tcpCatchAll = sep.indexOf(
      `-j REDIRECT --to-ports ${ENVOY_EGRESS_PORT}`,
    );
    expect(dnsRedirect).toBeGreaterThan(-1);
    expect(tcpCatchAll).toBeGreaterThan(-1);
    expect(dnsRedirect).toBeLessThan(tcpCatchAll);
  });

  it("allows Docker DNS (127.0.0.11) UDP", () => {
    expect(sep).toContain("iptables -A OUTPUT -p udp -d 127.0.0.11 -j ACCEPT");
  });

  it("scopes CoreDNS UDP ACCEPT to loopback only", () => {
    expect(sep).toContain(
      `iptables -A OUTPUT -p udp -d 127.0.0.0/8 --dport ${COREDNS_PORT} -j ACCEPT`,
    );
  });

  it("CoreDNS UDP ACCEPT comes before UDP DROP", () => {
    const corednsAccept = sep.indexOf(`--dport ${COREDNS_PORT} -j ACCEPT`);
    const udpDrop = sep.indexOf("-p udp -j DROP");
    expect(corednsAccept).toBeGreaterThan(-1);
    expect(udpDrop).toBeGreaterThan(-1);
    expect(corednsAccept).toBeLessThan(udpDrop);
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

describe("renderFirewallBypass", () => {
  const script = renderFirewallBypass();

  it("has bash shebang", () => {
    expect(script).toMatch(/^#!\/bin\/bash\n/);
  });

  it("has set -euo pipefail", () => {
    expect(script).toContain("set -euo pipefail");
  });

  it("checks for root (id -u)", () => {
    expect(script).toContain('$(id -u)" -ne 0');
  });

  it("uses configured SOCKS port", () => {
    expect(script).toContain(`SOCKS_PORT=${BYPASS_SOCKS_PORT}`);
  });

  it("uses configured default timeout", () => {
    expect(script).toContain(`\${1:-${DEFAULT_BYPASS_TIMEOUT_SECS}}`);
  });

  it("starts danted SOCKS5 proxy", () => {
    expect(script).toContain('danted -f "$DANTED_CONF"');
  });

  it("writes danted config with loopback binding", () => {
    expect(script).toContain("internal: 127.0.0.1 port = $SOCKS_PORT");
    expect(script).toContain("socksmethod: none");
  });

  it("enables UDP ASSOCIATE in danted config", () => {
    expect(script).toContain("command: connect udpassociate");
    expect(script).toContain("protocol: tcp udp");
  });

  it("writes proxychains config for node user", () => {
    expect(script).toContain("PROXYCHAINS_CONF=");
    expect(script).toContain("socks5 127.0.0.1 $SOCKS_PORT");
  });

  it("saves PID to pidfile", () => {
    expect(script).toContain('echo "$DANTED_PID" > "$PIDFILE"');
  });

  it("has stop subcommand", () => {
    expect(script).toContain("stop)");
    expect(script).toContain("stop_proxy");
  });

  it("has list subcommand", () => {
    expect(script).toContain("list)");
    expect(script).toContain("list_proxy");
  });

  it("validates timeout input", () => {
    expect(script).toContain("timeout must be a positive integer");
  });

  it("pre-checks port availability", () => {
    expect(script).toContain("port $SOCKS_PORT is already in use");
  });

  it("runs in foreground with trap and wait for cleanup", () => {
    expect(script).toContain("trap '");
    expect(script).toContain("INT TERM HUP");
    expect(script).toContain('wait "$DANTED_PID"');
    expect(script).not.toContain("disown");
  });

  it("trap handler disables set -e to survive closed stderr on HUP", () => {
    expect(script).toContain("trap 'set +e;");
  });

  it("sets trap before danted starts (not after)", () => {
    const trapIdx = script.indexOf("trap '");
    const dantedIdx = script.indexOf('danted -f "$DANTED_CONF" &');
    expect(trapIdx).toBeGreaterThan(0);
    expect(dantedIdx).toBeGreaterThan(0);
    expect(trapIdx).toBeLessThan(dantedIdx);
  });

  it("verifies kill succeeded with SIGKILL fallback", () => {
    expect(script).toContain("kill -9");
  });

  it("validates pidfile content before using", () => {
    expect(script).toContain("corrupt pidfile");
  });

  it("shows proxychains and curl usage examples (no wget)", () => {
    expect(script).toContain("proxychains4 -f");
    expect(script).toContain("socks5h://localhost:$SOCKS_PORT");
    // wget does not support SOCKS5 natively — only proxychains works
    expect(script).not.toContain("wget -e");
    expect(script).not.toContain("http_proxy=socks5h");
  });

  it("logs connections in real-time via stderr", () => {
    expect(script).toContain("logoutput: stderr");
    expect(script).toContain("Connection log below");
  });

  it("auto-detects external interface from /proc/net/route", () => {
    expect(script).toContain("/proc/net/route");
    expect(script).toContain("EXT_IFACE=");
    expect(script).toContain("external: $EXT_IFACE");
    expect(script).not.toContain("external: eth0");
  });

  it("runs danted as root for iptables bypass (user.unprivileged: root)", () => {
    expect(script).toContain("user.privileged: root");
    expect(script).toContain("user.unprivileged: root");
    expect(script).not.toContain("user.unprivileged: nobody");
  });

  it("restricts client access to loopback only", () => {
    expect(script).toContain("from: 127.0.0.0/8 to: 0.0.0.0/0");
  });

  it("proxychains config enables DNS proxying and strict chain", () => {
    expect(script).toContain("strict_chain");
    expect(script).toContain("proxy_dns");
  });

  it("detects danted crash on startup", () => {
    expect(script).toContain("danted exited immediately");
    expect(script).toContain("not listening after");
  });

  it("cleanup removes all generated files via remove_files helper", () => {
    expect(script).toContain("remove_files()");
    expect(script).toContain(
      'rm -f "$PIDFILE" "$DANTED_CONF" "$PROXYCHAINS_CONF"',
    );
  });

  it("uses kill_gracefully with SIGKILL escalation and logging", () => {
    expect(script).toContain("kill_gracefully()");
    expect(script).toContain("after SIGTERM, sending SIGKILL");
    expect(script).toContain("failed to kill");
  });

  it("makes proxychains config world-readable", () => {
    expect(script).toContain('chmod 644 "$PROXYCHAINS_CONF"');
  });

  it("stop_proxy delegates to kill_gracefully for clean shutdown", () => {
    const stopFn = script.slice(
      script.indexOf("stop_proxy()"),
      script.indexOf("list_proxy()"),
    );
    expect(stopFn).toContain("kill_gracefully");
  });

  it("stop_proxy verifies process is danted before killing (PID reuse protection)", () => {
    const stopFn = script.slice(
      script.indexOf("stop_proxy()"),
      script.indexOf("list_proxy()"),
    );
    expect(stopFn).toContain("/proc/$DANTED_PID/cmdline");
    expect(stopFn).toContain("is not danted");
  });

  it("fails with clear error if no default route found", () => {
    expect(script).toContain("cannot determine default route interface");
  });

  it("readiness-loop failure calls cleanup() for consistent error handling", () => {
    // After the readiness loop, failure should call cleanup() not separate kill+remove
    const readinessError = script.slice(
      script.indexOf("SOCKS port $SOCKS_PORT not listening"),
    );
    const nextLines = readinessError.slice(0, readinessError.indexOf("fi"));
    expect(nextLines).toContain("cleanup");
  });

  it("warns on timeout exceeding 1 hour", () => {
    expect(script).toContain("3600");
    expect(script).toContain("proxy will remain open for a long time");
  });

  it("list_proxy warns on corrupt pidfile", () => {
    // list_proxy should warn (not silently remove) on corrupt pidfile
    const listFn = script.slice(script.indexOf("list_proxy()"));
    expect(listFn).toContain("corrupt pidfile");
  });

  it("proxychains config notes it is ephemeral", () => {
    expect(script).toContain("only exists while the proxy is running");
  });

  it("uses wait + background timeout instead of sleep", () => {
    // Background timeout killer sends SIGTERM to danted
    expect(script).toContain('(sleep "$TIMEOUT" && kill "$DANTED_PID"');
    expect(script).toContain("TIMEOUT_PID=$!");
    expect(script).toContain('wait "$DANTED_PID"');
    // No blocking sleep for timeout in start_proxy main flow
    const startFn = script.slice(script.indexOf("start_proxy()"));
    const waitIdx = startFn.indexOf('wait "$DANTED_PID"');
    expect(waitIdx).toBeGreaterThan(0);
  });

  it("is idempotent — same output each time", () => {
    expect(renderFirewallBypass()).toBe(renderFirewallBypass());
  });
});

describe("renderAgentPrompt", () => {
  const prompt = renderAgentPrompt();

  it("renders without errors or undefined interpolations", () => {
    expect(prompt).not.toContain("undefined");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("wraps content in <environment> tags", () => {
    expect(prompt).toMatch(/^<environment>/);
    expect(prompt).toContain("</environment>");
  });

  it("interpolates BYPASS_SOCKS_PORT constant", () => {
    expect(prompt).toContain(`localhost:${BYPASS_SOCKS_PORT}`);
  });

  it("interpolates DEFAULT_BYPASS_TIMEOUT_SECS constant", () => {
    expect(prompt).toContain(`${DEFAULT_BYPASS_TIMEOUT_SECS}s`);
  });

  it("contains Gateway Restarts section", () => {
    expect(prompt).toContain("Gateway Restarts");
  });

  it("contains Firewall section", () => {
    expect(prompt).toContain("Firewall");
  });

  it("contains IaC autogenerated warning", () => {
    expect(prompt).toContain("IaC AUTOGENERATED");
  });

  it("does not include wget SOCKS5 examples (wget lacks native SOCKS5 support)", () => {
    expect(prompt).not.toContain("ALL_PROXY=socks5h");
    expect(prompt).not.toContain("wget -e");
  });

  it("notes proxychains config is ephemeral", () => {
    expect(prompt).toContain("only exists while the proxy is running");
  });

  it("is idempotent — same output each time", () => {
    expect(renderAgentPrompt()).toBe(renderAgentPrompt());
  });
});

describe("renderCorefile", () => {
  it("includes hardcoded infrastructure domains", () => {
    const cf = renderCorefile();
    expect(cf).toContain("github.com");
    expect(cf).toContain("registry.npmjs.org");
    expect(cf).toContain("api.anthropic.com");
  });

  it("includes user-defined egress domains", () => {
    const cf = renderCorefile([
      { dst: "custom-api.example.com", proto: "tls", action: "allow" },
    ]);
    expect(cf).toContain("custom-api.example.com");
  });

  it("strips wildcard prefix from domains", () => {
    const cf = renderCorefile();
    // *.tailscale.com should become a tailscale.com server block
    expect(cf).toContain("tailscale.com");
    expect(cf).not.toContain("*.tailscale.com");
  });

  it("has catch-all NXDOMAIN block", () => {
    const cf = renderCorefile();
    expect(cf).toContain("rcode NXDOMAIN");
  });

  it("forwards to Cloudflare malware-blocking DNS", () => {
    const cf = renderCorefile();
    expect(cf).toContain("1.1.1.2");
    expect(cf).toContain("1.0.0.2");
  });

  it("deduplicates domains from user rules and hardcoded", () => {
    const cf = renderCorefile([
      { dst: "github.com", proto: "tls", action: "allow" },
    ]);
    const matches = cf.match(/^github\.com \{/gm);
    expect(matches).toHaveLength(1);
  });

  it("skips IP and CIDR destinations", () => {
    const cf = renderCorefile([
      { dst: "192.168.1.0/24", proto: "tls", action: "allow" },
      { dst: "10.0.0.1", proto: "tls", action: "allow" },
    ]);
    expect(cf).not.toContain("192.168.1.0");
    expect(cf).not.toContain("10.0.0.1");
  });

  it("excludes deny rules from DNS allowlist", () => {
    const cf = renderCorefile([
      { dst: "blocked.example.com", proto: "tls", action: "deny" },
    ]);
    expect(cf).not.toContain("blocked.example.com");
  });

  it("includes SSH egress rule domains in DNS allowlist", () => {
    const cf = renderCorefile([
      { dst: "git.example.com", proto: "ssh", port: 22, action: "allow" },
    ]);
    expect(cf).toContain("git.example.com");
  });

  it("is idempotent — same rules produce identical output", () => {
    const rules = [
      { dst: "example.com", proto: "tls" as const, action: "allow" as const },
    ];
    expect(renderCorefile(rules)).toBe(renderCorefile(rules));
  });
});
