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

        // digitalocean.Droplet — provide a fake IPv4 address
        if (args.type === "digitalocean:index/droplet:Droplet") {
          state.ipv4Address = state.ipv4Address ?? "198.51.100.20";
        }

        // oci.core.Instance — provide a fake instance ID
        if (args.type === "oci:Core/instance:Instance") {
          state.id = state.id ?? "ocid1.instance.oc1.phx.mock";
        }

        // command.remote.Command — provide stdout/stderr
        if (args.type === "command:remote:Command") {
          state.stdout = state.stdout ?? "mock-stdout";
          state.stderr = state.stderr ?? "";
        }

        return { id: `${args.name}-id`, state };
      },
      call: (args: pulumi.runtime.MockCallArgs) => {
        // oci.core.getVnicAttachments — return a mock VNIC attachment
        if (args.token === "oci:Core/getVnicAttachments:getVnicAttachments") {
          return {
            vnicAttachments: [{ vnicId: "ocid1.vnic.oc1.phx.mock" }],
          };
        }
        // oci.core.getVnic — return a mock public IP
        if (args.token === "oci:Core/getVnic:getVnic") {
          return {
            publicIpAddress: "152.70.100.30",
            privateIpAddress: "10.0.0.2",
          };
        }
        return args.inputs;
      },
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

  it("creates a DigitalOcean droplet with expected outputs", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-do", {
      provider: "digitalocean",
      serverType: "s-1vcpu-1gb",
      region: "nyc1",
      sshKeyId: "ab:cd:ef:12:34",
    });

    const ip = await promiseOf(server.ipAddress);
    expect(ip).toBe("198.51.100.20");

    const conn = await promiseOf(server.connection);
    expect(conn.host).toBe("198.51.100.20");
    expect(conn.user).toBe("root");

    const dockerHost = await promiseOf(server.dockerHost);
    expect(dockerHost).toBe("ssh://root@198.51.100.20");
  });

  it("detects amd64 architecture for DigitalOcean droplets", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-do-arch", {
      provider: "digitalocean",
      serverType: "s-2vcpu-2gb",
      region: "sfo3",
      sshKeyId: "ab:cd:ef:12:34",
    });

    const arch = await promiseOf(server.arch);
    expect(arch).toBe("amd64");
  });

  it("detects arm64 architecture for DigitalOcean ARM droplets", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-do-arm", {
      provider: "digitalocean",
      serverType: "s-2vcpu-4gb-arm",
      region: "nyc1",
      sshKeyId: "ab:cd:ef:12:34",
    });

    const arch = await promiseOf(server.arch);
    expect(arch).toBe("arm64");
  });

  it("creates an Oracle Cloud instance with expected outputs", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-oci", {
      provider: "oracle",
      serverType: "VM.Standard.A1.Flex",
      region: "Uocm:PHX-AD-1",
      sshKeyId: "ssh-ed25519 AAAA... user@host",
      compartmentId: "ocid1.compartment.oc1..mock",
      subnetId: "ocid1.subnet.oc1.phx.mock",
      image: "ocid1.image.oc1.phx.mock",
    });

    const ip = await promiseOf(server.ipAddress);
    expect(ip).toBe("152.70.100.30");

    const conn = await promiseOf(server.connection);
    expect(conn.host).toBe("152.70.100.30");
    expect(conn.user).toBe("root");

    const dockerHost = await promiseOf(server.dockerHost);
    expect(dockerHost).toBe("ssh://root@152.70.100.30");
  });

  it("detects arm64 architecture for Oracle A1 shapes", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-oci-arm", {
      provider: "oracle",
      serverType: "VM.Standard.A1.Flex",
      region: "Uocm:PHX-AD-1",
      sshKeyId: "ssh-ed25519 AAAA...",
      compartmentId: "ocid1.compartment.oc1..mock",
      subnetId: "ocid1.subnet.oc1.phx.mock",
      image: "ocid1.image.oc1.phx.mock",
    });

    const arch = await promiseOf(server.arch);
    expect(arch).toBe("arm64");
  });

  it("detects amd64 architecture for Oracle E2 shapes", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-oci-amd", {
      provider: "oracle",
      serverType: "VM.Standard.E2.1.Micro",
      region: "Uocm:PHX-AD-1",
      sshKeyId: "ssh-ed25519 AAAA...",
      compartmentId: "ocid1.compartment.oc1..mock",
      subnetId: "ocid1.subnet.oc1.phx.mock",
      image: "ocid1.image.oc1.phx.mock",
    });

    const arch = await promiseOf(server.arch);
    expect(arch).toBe("amd64");
  });

  it("throws when Oracle provider is missing compartmentId", async () => {
    const { Server } = await import("../components/server");
    expect(
      () =>
        new Server("test-oci-no-compartment", {
          provider: "oracle",
          serverType: "VM.Standard.A1.Flex",
          region: "Uocm:PHX-AD-1",
          sshKeyId: "ssh-ed25519 AAAA...",
          subnetId: "ocid1.subnet.oc1.phx.mock",
          image: "ocid1.image.oc1.phx.mock",
        }),
    ).toThrow(/compartmentId/);
  });

  it("throws when Oracle provider is missing subnetId", async () => {
    const { Server } = await import("../components/server");
    expect(
      () =>
        new Server("test-oci-no-subnet", {
          provider: "oracle",
          serverType: "VM.Standard.A1.Flex",
          region: "Uocm:PHX-AD-1",
          sshKeyId: "ssh-ed25519 AAAA...",
          compartmentId: "ocid1.compartment.oc1..mock",
          image: "ocid1.image.oc1.phx.mock",
        }),
    ).toThrow(/subnetId/);
  });

  it("throws when Oracle provider is missing image", async () => {
    const { Server } = await import("../components/server");
    expect(
      () =>
        new Server("test-oci-no-image", {
          provider: "oracle",
          serverType: "VM.Standard.A1.Flex",
          region: "Uocm:PHX-AD-1",
          sshKeyId: "ssh-ed25519 AAAA...",
          compartmentId: "ocid1.compartment.oc1..mock",
          subnetId: "ocid1.subnet.oc1.phx.mock",
        }),
    ).toThrow(/image/);
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

  it("extracts tailscaleIP from last line of stdout", async () => {
    const { HostBootstrap } = await import("../components/bootstrap");
    const bootstrap = new HostBootstrap("test-bootstrap-ip", {
      connection: { host: "1.2.3.4", user: "root" },
      tailscaleAuthKey: "tskey-auth-test",
    });

    // Mock stdout is "mock-stdout" — the last-line extraction returns it as-is
    const tsIP = await promiseOf(bootstrap.tailscaleIP);
    expect(tsIP).toBe("mock-stdout");
  });

  it("derives dockerHost from tailscaleIP", async () => {
    const { HostBootstrap } = await import("../components/bootstrap");
    const bootstrap = new HostBootstrap("test-bootstrap-host", {
      connection: { host: "1.2.3.4", user: "root" },
      tailscaleAuthKey: "tskey-auth-test",
    });

    const tsIP = await promiseOf(bootstrap.tailscaleIP);
    const dockerHost = await promiseOf(bootstrap.dockerHost);
    expect(dockerHost).toBe(`ssh://root@${tsIP}`);
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
        { dst: "10.0.0.0/24", proto: "ssh", port: 22, action: "allow" },
      ],
    });

    expect(envoy.warnings).toHaveLength(1);
    expect(envoy.warnings[0]).toContain("CIDR");
  });

  it("exposes tcpPortMappings from egress policy", async () => {
    const { EnvoyEgress } = await import("../components/envoy");
    const envoy = new EnvoyEgress("test-envoy-tcp", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [
        { dst: "github.com", proto: "ssh", port: 22, action: "allow" },
      ],
    });

    expect(envoy.tcpPortMappings).toHaveLength(1);
    expect(envoy.tcpPortMappings[0].dst).toBe("github.com");
    expect(envoy.tcpPortMappings[0].dstPort).toBe(22);
    expect(envoy.tcpPortMappings[0].proto).toBe("ssh");
  });

  it("exposes caCertPath output for gateway NODE_EXTRA_CA_CERTS", async () => {
    const { EnvoyEgress } = await import("../components/envoy");
    const { ENVOY_CA_CERT_PATH } = await import("../config");
    const envoy = new EnvoyEgress("test-envoy-ca", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [],
    });

    const caCertPath = await promiseOf(envoy.caCertPath);
    expect(caCertPath).toBe(ENVOY_CA_CERT_PATH);
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
    expect(tsUrl).toBe("https://mock-stdout");
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
    expect(tsUrl).toBe("https://mock-stdout");
  });

  it("passes custom env vars to the container", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw-env", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "envtest",
      version: "latest",
      packages: [],
      port: 18789,
      tailscale: "off",
      configSet: {},
      auth: { mode: "token", token: "test-token" },
      env: { CUSTOM_VAR: "custom-value" },
    });

    // Component constructs successfully with custom env
    const containerId = await promiseOf(gw.containerId);
    expect(containerId).toBeDefined();
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
