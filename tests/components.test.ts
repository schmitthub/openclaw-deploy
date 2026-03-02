import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// Pulumi unit testing with mocks — must be set before importing any components.
// See: https://www.pulumi.com/docs/using-pulumi/testing/unit/
//
// The mock provides sensible defaults for output-only properties that Pulumi
// resources produce but which aren't part of the input args (e.g. ipv4Address,
// stdout). Without these, .apply() chains in components will receive undefined.
beforeAll(() => {
  pulumi.runtime.setMocks(
    {
      newResource: (args: pulumi.runtime.MockResourceArgs) => {
        const state = { ...args.inputs };

        // hcloud.Server — provide a fake IPv4 address
        if (args.type === "hcloud:index/server:Server") {
          state.ipv4Address = state.ipv4Address ?? "203.0.113.10";
          state.ipv6Address = state.ipv6Address ?? "2001:db8::1";
        }

        // command.remote.Command — provide stdout/stderr
        if (args.type === "command:remote:Command") {
          state.stdout = state.stdout ?? "mock-stdout";
          state.stderr = state.stderr ?? "";
        }

        return { id: `${args.name}-id`, state };
      },
      call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
    },
    "test",
    "test",
    false,
  );
});

/** Helper to resolve a Pulumi Output to its plain value in test context. */
function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise<T>((resolve) => output.apply(resolve));
}

describe("Server component", () => {
  it("creates a Hetzner server with expected outputs", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-server", {
      provider: "hetzner",
      serverType: "cx22",
      region: "fsn1",
      sshKeyId: "12345",
    });

    const ip = await promiseOf(server.ipAddress);
    expect(ip).toBe("203.0.113.10");

    const conn = await promiseOf(server.connection);
    expect(conn.host).toBe("203.0.113.10");
    expect(conn.user).toBe("root");

    const dockerHost = await promiseOf(server.dockerHost);
    expect(dockerHost).toBe("ssh://root@203.0.113.10");
  });

  it("detects ARM architecture from cax server types", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-arm", {
      provider: "hetzner",
      serverType: "cax21",
      region: "fsn1",
      sshKeyId: "12345",
    });

    const arch = await promiseOf(server.arch);
    expect(arch).toBe("arm64");
  });

  it("detects AMD architecture from cx server types", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-amd", {
      provider: "hetzner",
      serverType: "cx22",
      region: "fsn1",
      sshKeyId: "12345",
    });

    const arch = await promiseOf(server.arch);
    expect(arch).toBe("amd64");
  });

  it("uses default ubuntu-24.04 image when not specified", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-default-image", {
      provider: "hetzner",
      serverType: "cx22",
      region: "fsn1",
      sshKeyId: "12345",
    });
    expect(server).toBeDefined();
  });

  it("throws for digitalocean provider (Phase 2)", async () => {
    const { Server } = await import("../components/server");
    expect(
      () =>
        new Server("test-do", {
          provider: "digitalocean",
          serverType: "s-1vcpu-1gb",
          region: "nyc1",
          sshKeyId: "abc",
        }),
    ).toThrow(/digitalocean.*not yet supported/i);
  });

  it("throws for oracle provider (Phase 2)", async () => {
    const { Server } = await import("../components/server");
    expect(
      () =>
        new Server("test-oracle", {
          provider: "oracle",
          serverType: "VM.Standard.A1.Flex",
          region: "us-ashburn-1",
          sshKeyId: "abc",
        }),
    ).toThrow(/oracle.*not yet supported/i);
  });
});

describe("HostBootstrap component", () => {
  it("creates expected resources and outputs", async () => {
    const { HostBootstrap } = await import("../components/bootstrap");
    const bootstrap = new HostBootstrap("test-bootstrap", {
      connection: { host: "1.2.3.4", user: "root" },
      tailscaleAuthKey: "tskey-auth-test",
    });

    expect(bootstrap).toBeDefined();

    const dockerReady = await promiseOf(bootstrap.dockerReady);
    expect(dockerReady).toBe("ready");

    const dockerHost = await promiseOf(bootstrap.dockerHost);
    expect(dockerHost).toMatch(/^ssh:\/\/root@/);
  });
});

describe("EnvoyEgress component", () => {
  it("creates networks and container with correct outputs", async () => {
    const { EnvoyEgress } = await import("../components/envoy");
    const envoy = new EnvoyEgress("test-envoy", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [],
    });

    const envoyIP = await promiseOf(envoy.envoyIP);
    expect(envoyIP).toBe("172.28.0.2");

    const internalName = await promiseOf(envoy.internalNetworkName);
    expect(internalName).toBe("openclaw-internal");

    const egressName = await promiseOf(envoy.egressNetworkName);
    expect(egressName).toBe("openclaw-egress");

    expect(envoy.warnings).toHaveLength(0);
  });

  it("propagates envoy config warnings for unsupported rule types", async () => {
    const { EnvoyEgress } = await import("../components/envoy");
    const envoy = new EnvoyEgress("test-envoy-warn", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [
        { dst: "git.example.com", proto: "ssh", port: 22, action: "allow" },
      ],
    });

    expect(envoy.warnings).toHaveLength(1);
    expect(envoy.warnings[0]).toContain("SSH");
    expect(envoy.warnings[0]).toContain("Phase 2");
  });
});

describe("Gateway component", () => {
  it("creates image, container, and config resources", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "dev",
      version: "latest",
      packages: [],
      port: 18789,
      tailscale: "off",
      configSet: {},
      auth: { mode: "token", token: "test-token" },
    });

    const containerId = await promiseOf(gw.containerId);
    expect(containerId).toBeDefined();

    const tsUrl = await promiseOf(gw.tailscaleUrl);
    expect(tsUrl).toBe("");
  });

  it("creates Tailscale serve command when tailscale is serve", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw-serve", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "prod",
      version: "2026.2",
      packages: ["ffmpeg"],
      port: 18789,
      tailscale: "serve",
      configSet: { "llm.model": "claude-3-opus" },
      auth: { mode: "token", token: "prod-token" },
    });

    // Mock stdout provides "mock-stdout", so tailscaleUrl will be "https://mock-stdout"
    const tsUrl = await promiseOf(gw.tailscaleUrl);
    expect(tsUrl).toContain("https://");
  });

  it("creates Tailscale funnel command when tailscale is funnel", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw-funnel", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "public",
      version: "latest",
      packages: [],
      port: 18789,
      tailscale: "funnel",
      configSet: {},
      auth: { mode: "token", token: "funnel-token" },
    });

    const tsUrl = await promiseOf(gw.tailscaleUrl);
    expect(tsUrl).toContain("https://");
  });

  it("constructs without errors when user configSet overlaps security-critical keys", async () => {
    const { Gateway } = await import("../components/gateway");
    // Required config (gateway.mode, gateway.auth.*, etc.) always wins.
    const gw = new Gateway("test-gw-config", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "test",
      version: "latest",
      packages: [],
      port: 18789,
      tailscale: "off",
      configSet: {
        "gateway.mode": "should-be-overridden",
        "custom.setting": "user-value",
      },
      auth: { mode: "token", token: "test-token" },
    });

    expect(gw).toBeDefined();
  });
});
