import * as pulumi from "@pulumi/pulumi";
import * as oci from "@pulumi/oci";

export interface OciInfraArgs {
  compartmentId: pulumi.Input<string>;
}

/**
 * Creates OCI networking infrastructure for OpenClaw deployments:
 * VCN, Internet Gateway, Route Table, Security List, and public Subnet.
 *
 * Security list allows:
 *   - Ingress: TCP 22 (SSH for bootstrap), UDP 41641 (Tailscale)
 *   - Egress: all traffic
 */
export class OciInfra extends pulumi.ComponentResource {
  public readonly subnetId: pulumi.Output<string>;
  public readonly vcnId: pulumi.Output<string>;

  constructor(
    name: string,
    args: OciInfraArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:infra:OciInfra", name, {}, opts);

    const vcn = new oci.core.Vcn(
      `${name}-vcn`,
      {
        compartmentId: args.compartmentId,
        cidrBlocks: ["10.0.0.0/16"],
        displayName: `${name}-vcn`,
      },
      { parent: this },
    );

    const igw = new oci.core.InternetGateway(
      `${name}-igw`,
      {
        compartmentId: args.compartmentId,
        vcnId: vcn.id,
        displayName: `${name}-igw`,
      },
      { parent: this },
    );

    const routeTable = new oci.core.RouteTable(
      `${name}-rt`,
      {
        compartmentId: args.compartmentId,
        vcnId: vcn.id,
        displayName: `${name}-rt`,
        routeRules: [
          {
            networkEntityId: igw.id,
            destination: "0.0.0.0/0",
            destinationType: "CIDR_BLOCK",
          },
        ],
      },
      { parent: this },
    );

    const securityList = new oci.core.SecurityList(
      `${name}-sl`,
      {
        compartmentId: args.compartmentId,
        vcnId: vcn.id,
        displayName: `${name}-sl`,
        egressSecurityRules: [
          {
            protocol: "all",
            destination: "0.0.0.0/0",
          },
        ],
        ingressSecurityRules: [
          // SSH — needed for initial bootstrap before Tailscale is up
          {
            protocol: "6", // TCP
            source: "0.0.0.0/0",
            tcpOptions: { min: 22, max: 22 },
          },
          // Tailscale direct connection discovery (WireGuard)
          {
            protocol: "17", // UDP
            source: "0.0.0.0/0",
            udpOptions: { min: 41641, max: 41641 },
          },
        ],
      },
      { parent: this },
    );

    const subnet = new oci.core.Subnet(
      `${name}-subnet`,
      {
        compartmentId: args.compartmentId,
        vcnId: vcn.id,
        cidrBlock: "10.0.0.0/24",
        displayName: `${name}-subnet`,
        routeTableId: routeTable.id,
        securityListIds: [securityList.id],
      },
      { parent: this },
    );

    this.subnetId = subnet.id;
    this.vcnId = vcn.id;

    this.registerOutputs({
      subnetId: this.subnetId,
      vcnId: this.vcnId,
    });
  }
}
