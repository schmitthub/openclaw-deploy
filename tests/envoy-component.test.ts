import { describe, it, expect } from "vitest";
import { EnvoyEgress, type EnvoyEgressArgs } from "../components/envoy";
import {
  ENVOY_IMAGE,
  ENVOY_STATIC_IP,
  INTERNAL_NETWORK_SUBNET,
  INTERNAL_NETWORK_NAME,
  EGRESS_NETWORK_NAME,
  ENVOY_CONFIG_HOST_DIR,
  ENVOY_CA_CERT_PATH,
  ENVOY_CA_KEY_PATH,
  ENVOY_MITM_CERTS_HOST_DIR,
  ENVOY_MITM_CERTS_CONTAINER_DIR,
  ENVOY_MITM_CLUSTER_NAME,
} from "../config";
import { renderEnvoyConfig } from "../templates";

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
      egressPolicy: [{ dst: "example.com", proto: "tls", action: "allow" }],
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

  it("ENVOY_CA_CERT_PATH is under the envoy config directory", () => {
    expect(ENVOY_CA_CERT_PATH).toMatch(/^\//);
    expect(ENVOY_CA_CERT_PATH).toBe("/opt/openclaw-deploy/envoy/ca-cert.pem");
    expect(ENVOY_CA_CERT_PATH).toContain(ENVOY_CONFIG_HOST_DIR);
  });

  it("ENVOY_CA_KEY_PATH is under the envoy config directory", () => {
    expect(ENVOY_CA_KEY_PATH).toMatch(/^\//);
    expect(ENVOY_CA_KEY_PATH).toBe("/opt/openclaw-deploy/envoy/ca-key.pem");
    expect(ENVOY_CA_KEY_PATH).toContain(ENVOY_CONFIG_HOST_DIR);
  });

  it("ENVOY_MITM_CERTS_HOST_DIR is under the envoy config directory", () => {
    expect(ENVOY_MITM_CERTS_HOST_DIR).toMatch(/^\//);
    expect(ENVOY_MITM_CERTS_HOST_DIR).toBe("/opt/openclaw-deploy/envoy/certs");
    expect(ENVOY_MITM_CERTS_HOST_DIR).toContain(ENVOY_CONFIG_HOST_DIR);
  });

  it("ENVOY_MITM_CERTS_CONTAINER_DIR is an absolute container path", () => {
    expect(ENVOY_MITM_CERTS_CONTAINER_DIR).toMatch(/^\//);
    expect(ENVOY_MITM_CERTS_CONTAINER_DIR).toBe("/etc/envoy/certs");
  });

  it("ENVOY_MITM_CLUSTER_NAME is set", () => {
    expect(ENVOY_MITM_CLUSTER_NAME).toBe("mitm_forward_cluster");
  });
});

describe("EnvoyConfigResult", () => {
  it("includes inspectedDomains field", () => {
    const result = renderEnvoyConfig();
    expect(result).toHaveProperty("inspectedDomains");
    expect(Array.isArray(result.inspectedDomains)).toBe(true);
    expect(result.inspectedDomains).toHaveLength(0);
  });

  it("populates inspectedDomains for inspect:true rules", () => {
    const result = renderEnvoyConfig([
      { dst: "example.com", proto: "tls", action: "allow", inspect: true },
    ]);
    expect(result.inspectedDomains).toEqual(["example.com"]);
  });
});
