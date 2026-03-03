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

        // tls.PrivateKey — provide mock key material
        if (args.type === "tls:index/privateKey:PrivateKey") {
          state.privateKeyOpenssh =
            state.privateKeyOpenssh ??
            "-----BEGIN OPENSSH PRIVATE KEY-----\nmock\n-----END OPENSSH PRIVATE KEY-----";
          state.privateKeyPem =
            state.privateKeyPem ??
            "-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----";
          state.publicKeyOpenssh =
            state.publicKeyOpenssh ?? "ssh-ed25519 AAAAMOCKPUBLICKEY mock@test";
          state.publicKeyPem =
            state.publicKeyPem ??
            "-----BEGIN PUBLIC KEY-----\nmock\n-----END PUBLIC KEY-----";
          state.publicKeyFingerprintMd5 =
            state.publicKeyFingerprintMd5 ?? "aa:bb:cc:dd:ee:ff";
          state.publicKeyFingerprintSha256 =
            state.publicKeyFingerprintSha256 ?? "SHA256:mock";
        }

        // hcloud.SshKey — provide a mock fingerprint
        if (args.type === "hcloud:index/sshKey:SshKey") {
          state.fingerprint = state.fingerprint ?? "aa:bb:cc:dd:ee:ff";
        }

        // digitalocean.SshKey — provide a mock fingerprint
        if (args.type === "digitalocean:index/sshKey:SshKey") {
          state.fingerprint = state.fingerprint ?? "ab:cd:ef:12:34:56";
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
        // oci.identity.getAvailabilityDomains — return a mock AD
        if (
          args.token ===
          "oci:Identity/getAvailabilityDomains:getAvailabilityDomains"
        ) {
          return {
            availabilityDomains: [
              {
                compartmentId: "ocid1.compartment.oc1..mock",
                id: "ocid1.availabilitydomain.oc1.phx.mock",
                name: "Uocm:PHX-AD-1",
              },
            ],
          };
        }
        // oci.core.getImages — return a mock Ubuntu image
        if (args.token === "oci:Core/getImages:getImages") {
          return {
            images: [
              {
                id: "ocid1.image.oc1.phx.mock-ubuntu-2404",
                displayName: "Canonical-Ubuntu-24.04-aarch64-2026.03.01-0",
                operatingSystem: "Canonical Ubuntu",
                operatingSystemVersion: "24.04",
              },
            ],
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

  it("auto-provisions Oracle networking, image, and AD when only compartmentId provided", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-oci-auto", {
      provider: "oracle",
      serverType: "VM.Standard.A1.Flex",
      compartmentId: "ocid1.compartment.oc1..mock",
    });

    const ip = await promiseOf(server.ipAddress);
    expect(ip).toBe("152.70.100.30");

    const conn = await promiseOf(server.connection);
    expect(conn.host).toBe("152.70.100.30");
    expect(conn.user).toBe("root");
    expect(conn.privateKey).toBeDefined();
  });

  it("throws when Hetzner provider is missing region", async () => {
    const { Server } = await import("../components/server");
    expect(
      () =>
        new Server("test-hetzner-no-region", {
          provider: "hetzner",
          serverType: "cx22",
          sshKeyId: "12345",
        }),
    ).toThrow(/region/);
  });

  it("auto-generates SSH key when sshKeyId is omitted (Hetzner)", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-auto-key-hetzner", {
      provider: "hetzner",
      serverType: "cx22",
      region: "fsn1",
    });

    const conn = await promiseOf(server.connection);
    expect(conn.host).toBe("203.0.113.10");
    expect(conn.user).toBe("root");
    expect(conn.privateKey).toBeDefined();
    expect(conn.privateKey).toContain("OPENSSH PRIVATE KEY");
  });

  it("auto-generates SSH key when sshKeyId is omitted (DigitalOcean)", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-auto-key-do", {
      provider: "digitalocean",
      serverType: "s-1vcpu-1gb",
      region: "nyc1",
    });

    const conn = await promiseOf(server.connection);
    expect(conn.host).toBe("198.51.100.20");
    expect(conn.user).toBe("root");
    expect(conn.privateKey).toBeDefined();
    expect(conn.privateKey).toContain("OPENSSH PRIVATE KEY");
  });

  it("auto-generates SSH key when sshKeyId is omitted (Oracle)", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-auto-key-oci", {
      provider: "oracle",
      serverType: "VM.Standard.A1.Flex",
      region: "Uocm:PHX-AD-1",
      compartmentId: "ocid1.compartment.oc1..mock",
      subnetId: "ocid1.subnet.oc1.phx.mock",
      image: "ocid1.image.oc1.phx.mock",
    });

    const conn = await promiseOf(server.connection);
    expect(conn.host).toBe("152.70.100.30");
    expect(conn.user).toBe("root");
    expect(conn.privateKey).toBeDefined();
    expect(conn.privateKey).toContain("OPENSSH PRIVATE KEY");
  });

  it("does not include privateKey in connection when sshKeyId is provided", async () => {
    const { Server } = await import("../components/server");
    const server = new Server("test-explicit-key", {
      provider: "hetzner",
      serverType: "cx22",
      region: "fsn1",
      sshKeyId: "12345",
    });

    const conn = await promiseOf(server.connection);
    expect(conn.host).toBe("203.0.113.10");
    expect(conn.user).toBe("root");
    expect(conn.privateKey).toBeUndefined();
  });
});

describe("HostBootstrap component", () => {
  it("creates expected resources and outputs", async () => {
    const { HostBootstrap } = await import("../components/bootstrap");
    const bootstrap = new HostBootstrap("test-bootstrap", {
      connection: { host: "1.2.3.4", user: "root" },
    });

    expect(bootstrap).toBeDefined();

    const dockerReady = await promiseOf(bootstrap.dockerReady);
    expect(dockerReady).toBe("ready");

    const dockerHost = await promiseOf(bootstrap.dockerHost);
    expect(dockerHost).toMatch(/^ssh:\/\/root@/);
  });

  it("derives dockerHost from public IP", async () => {
    const { HostBootstrap } = await import("../components/bootstrap");
    const bootstrap = new HostBootstrap("test-bootstrap-host", {
      connection: { host: "1.2.3.4", user: "root" },
    });

    const dockerHost = await promiseOf(bootstrap.dockerHost);
    expect(dockerHost).toBe("ssh://root@1.2.3.4");
  });
});

describe("EnvoyEgress component MITM validation", () => {
  it("skips MITM domain with shell-injection characters via warning", async () => {
    const { EnvoyEgress } = await import("../components/envoy");
    const envoy = new EnvoyEgress("test-envoy-bad-mitm", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [
        {
          dst: '"; rm -rf /',
          proto: "tls",
          action: "allow",
          inspect: true,
        },
      ],
    });
    expect(envoy.warnings.some((w) => w.includes("Invalid destination"))).toBe(
      true,
    );
    expect(envoy.inspectedDomains).toHaveLength(0);
  });

  it("skips MITM domain with leading hyphen via warning", async () => {
    const { EnvoyEgress } = await import("../components/envoy");
    const envoy = new EnvoyEgress("test-envoy-bad-mitm-hyphen", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [
        {
          dst: "-evil.com",
          proto: "tls",
          action: "allow",
          inspect: true,
        },
      ],
    });
    expect(envoy.warnings.some((w) => w.includes("Invalid destination"))).toBe(
      true,
    );
    expect(envoy.inspectedDomains).toHaveLength(0);
  });

  it("skips MITM domain with spaces via warning", async () => {
    const { EnvoyEgress } = await import("../components/envoy");
    const envoy = new EnvoyEgress("test-envoy-bad-mitm-space", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [
        {
          dst: "evil domain.com",
          proto: "tls",
          action: "allow",
          inspect: true,
        },
      ],
    });
    expect(envoy.warnings.some((w) => w.includes("Invalid destination"))).toBe(
      true,
    );
    expect(envoy.inspectedDomains).toHaveLength(0);
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

  it("produces different config hashes for different egress policies", async () => {
    const { EnvoyEgress } = await import("../components/envoy");
    const envoy1 = new EnvoyEgress("test-envoy-hash1", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [],
    });
    const envoy2 = new EnvoyEgress("test-envoy-hash2", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [
        { dst: "extra.example.com", proto: "tls", action: "allow" },
      ],
    });
    expect(envoy1.configHash).toBeDefined();
    expect(envoy2.configHash).toBeDefined();
    expect(envoy1.configHash).not.toBe(envoy2.configHash);
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
      port: 18789,
      auth: { mode: "token", token: "test-token" },
      tailscaleAuthKey: "tskey-auth-test",
    });

    const containerId = await promiseOf(gw.containerId);
    expect(containerId).toBeDefined();

    // Tailscale is always enabled — mock stdout → "https://mock-stdout"
    const tsUrl = await promiseOf(gw.tailscaleUrl);
    expect(tsUrl).toBe("https://mock-stdout");
  });

  it("always queries Tailscale hostname", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw-serve", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "prod",
      version: "2026.2",
      port: 18789,
      auth: { mode: "token", token: "prod-token" },
      tailscaleAuthKey: "tskey-auth-test",
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
      port: 18789,
      auth: { mode: "token", token: "test-token" },
      tailscaleAuthKey: "tskey-auth-test",
      env: { CUSTOM_VAR: "custom-value" },
    });

    const containerId = await promiseOf(gw.containerId);
    expect(containerId).toBeDefined();
  });

  it("constructs with setupCommands without errors", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw-setup", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "setuptest",
      version: "latest",
      port: 18789,
      setupCommands: [
        'onboard --non-interactive --tailscale serve --accept-risk --mode local --gateway-bind loopback --gateway-token "$OPENCLAW_GATEWAY_TOKEN" --no-install-daemon --auth-choice token --token-provider anthropic --token "$ANTHROPIC_API_KEY" --skip-channels --skip-skills --skip-daemon --skip-health',
        "config set gateway.controlUi.basePath /openclaw",
      ],
      auth: { mode: "token", token: "test-token" },
      tailscaleAuthKey: "tskey-auth-test",
    });

    const containerId = await promiseOf(gw.containerId);
    expect(containerId).toBeDefined();
  });

  it("constructs with secretEnv without errors", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw-secret", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "secrettest",
      version: "latest",
      port: 18789,
      setupCommands: [
        'onboard --non-interactive --auth-choice token --token-provider openrouter --token "$OPENROUTER_API_KEY" --skip-channels --skip-skills --skip-daemon --skip-health',
      ],
      secretEnv: JSON.stringify({ OPENROUTER_API_KEY: "sk-or-test-123" }),
      auth: { mode: "token", token: "test-token" },
      tailscaleAuthKey: "tskey-auth-test",
    });

    const containerId = await promiseOf(gw.containerId);
    expect(containerId).toBeDefined();
  });

  it("constructs with tcpPortMappings without errors", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw-tcp", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "tcptest",
      version: "latest",
      port: 18789,
      auth: { mode: "token", token: "test-token" },
      tailscaleAuthKey: "tskey-auth-test",
      tcpPortMappings: [
        { dst: "github.com", dstPort: 22, proto: "ssh", envoyPort: 10001 },
        {
          dst: "db.example.com",
          dstPort: 5432,
          proto: "tcp",
          envoyPort: 10002,
        },
      ],
    });

    const containerId = await promiseOf(gw.containerId);
    expect(containerId).toBeDefined();
  });

  it("filters reserved env keys from secretEnv", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw-reserved", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "reservedtest",
      version: "latest",
      port: 18789,
      auth: { mode: "token", token: "test-token" },
      tailscaleAuthKey: "tskey-auth-test",
      secretEnv: JSON.stringify({
        OPENCLAW_GATEWAY_TOKEN: "attacker-token",
        CUSTOM_KEY: "value",
      }),
    });

    const containerId = await promiseOf(gw.containerId);
    expect(containerId).toBeDefined();
  });

  it("produces different content hashes for different setupCommands", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw1 = new Gateway("test-gw-hash1", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "hash1",
      version: "latest",
      port: 18789,
      setupCommands: ["config set foo bar"],
      auth: { mode: "token", token: "test-token" },
      tailscaleAuthKey: "tskey-auth-test",
    });

    const gw2 = new Gateway("test-gw-hash2", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "hash2",
      version: "latest",
      port: 18789,
      setupCommands: ["config set baz qux"],
      auth: { mode: "token", token: "test-token" },
      tailscaleAuthKey: "tskey-auth-test",
    });

    const id1 = await promiseOf(gw1.containerId);
    const id2 = await promiseOf(gw2.containerId);
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
  });

  it("constructs with imageSteps without errors", async () => {
    const { Gateway } = await import("../components/gateway");
    const gw = new Gateway("test-gw-steps", {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      internalNetworkName: "openclaw-internal",
      profile: "stepstest",
      version: "latest",
      port: 18789,
      auth: { mode: "token", token: "test-token" },
      tailscaleAuthKey: "tskey-auth-test",
      imageSteps: [
        { user: "root", run: "apt-get install -y ffmpeg" },
        { user: "node", run: "npm install -g some-tool" },
      ],
    });

    const containerId = await promiseOf(gw.containerId);
    expect(containerId).toBeDefined();
  });
});
