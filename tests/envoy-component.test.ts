import { describe, it, expect } from "vitest";
import { EnvoyEgress, type EnvoyEgressArgs } from "../components/envoy";
import {
  ENVOY_IMAGE,
  ENVOY_STATIC_IP,
  INTERNAL_NETWORK_SUBNET,
  INTERNAL_NETWORK_NAME,
  EGRESS_NETWORK_NAME,
  ENVOY_CONFIG_HOST_DIR,
} from "../config";

describe("EnvoyEgress module", () => {
  it("exports the EnvoyEgress class", () => {
    expect(EnvoyEgress).toBeDefined();
    expect(typeof EnvoyEgress).toBe("function");
  });

  it("EnvoyEgressArgs interface accepts the expected shape", () => {
    // Type-level test: compile-time check that the interface is correct.
    // This ensures the component signature doesn't drift from expectations.
    const args: EnvoyEgressArgs = {
      dockerHost: "ssh://root@100.64.0.1",
      connection: { host: "100.64.0.1", user: "root" },
      egressPolicy: [
        { dst: "example.com", proto: "tls", action: "allow" },
      ],
    };
    expect(args.dockerHost).toBeTruthy();
    expect(args.connection).toBeTruthy();
    expect(args.egressPolicy).toHaveLength(1);
  });
});

describe("EnvoyEgress constants", () => {
  it("ENVOY_STATIC_IP is a valid IPv4 address on the internal subnet", () => {
    expect(ENVOY_STATIC_IP).toMatch(/^172\.28\.0\.\d+$/);
    expect(ENVOY_STATIC_IP).toBe("172.28.0.2");
  });

  it("INTERNAL_NETWORK_SUBNET covers the Envoy static IP", () => {
    expect(INTERNAL_NETWORK_SUBNET).toBe("172.28.0.0/24");
    // Envoy's IP (172.28.0.2) is within 172.28.0.0/24
    const envoyOctet = parseInt(ENVOY_STATIC_IP.split(".")[3]);
    expect(envoyOctet).toBeGreaterThanOrEqual(1);
    expect(envoyOctet).toBeLessThanOrEqual(254);
  });

  it("INTERNAL_NETWORK_NAME is set", () => {
    expect(INTERNAL_NETWORK_NAME).toBe("openclaw-internal");
  });

  it("EGRESS_NETWORK_NAME is set", () => {
    expect(EGRESS_NETWORK_NAME).toBe("openclaw-egress");
  });

  it("ENVOY_IMAGE uses v1.33", () => {
    expect(ENVOY_IMAGE).toContain("envoyproxy/envoy");
    expect(ENVOY_IMAGE).toContain("v1.33");
  });

  it("ENVOY_CONFIG_HOST_DIR is an absolute path", () => {
    expect(ENVOY_CONFIG_HOST_DIR).toMatch(/^\//);
    expect(ENVOY_CONFIG_HOST_DIR).toBe("/opt/openclaw-deploy/envoy");
  });
});
