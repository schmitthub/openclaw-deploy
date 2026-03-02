import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as digitalocean from "@pulumi/digitalocean";
import { VpsProvider } from "../config";

export interface ServerArgs {
  provider: VpsProvider;
  serverType: pulumi.Input<string>; // e.g. "cx22" (Hetzner), "s-1vcpu-1gb" (DO)
  region: pulumi.Input<string>; // e.g. "fsn1" (Hetzner), "nyc1" (DO)
  sshKeyId: pulumi.Input<string>; // Provider-specific SSH key ID or fingerprint
  image?: pulumi.Input<string>; // e.g. "ubuntu-24.04" (Hetzner), "ubuntu-24-04-x64" (DO)
}

export class Server extends pulumi.ComponentResource {
  public readonly ipAddress: pulumi.Output<string>;
  public readonly arch: pulumi.Output<string>; // "amd64" or "arm64"
  public readonly connection: pulumi.Output<{ host: string; user: string }>;
  public readonly dockerHost: pulumi.Output<string>; // "ssh://root@<ip>"

  constructor(
    name: string,
    args: ServerArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:infra:Server", name, {}, opts);

    switch (args.provider) {
      case "hetzner": {
        const server = new hcloud.Server(
          `${name}-server`,
          {
            name,
            serverType: args.serverType,
            location: args.region,
            image: args.image ?? "ubuntu-24.04",
            sshKeys: [args.sshKeyId],
            publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
          },
          { parent: this },
        );

        this.ipAddress = server.ipv4Address;

        this.arch = pulumi
          .output(args.serverType)
          .apply((st) => (st.startsWith("cax") ? "arm64" : "amd64"));

        this.connection = server.ipv4Address.apply((ip) => ({
          host: ip,
          user: "root",
        }));

        this.dockerHost = server.ipv4Address.apply(
          (ip) => `ssh://root@${ip}`,
        );

        break;
      }

      case "digitalocean": {
        const droplet = new digitalocean.Droplet(
          `${name}-droplet`,
          {
            name,
            size: args.serverType, // e.g. "s-1vcpu-1gb", "s-2vcpu-2gb"
            region: args.region, // e.g. "nyc1", "sfo3"
            image: args.image ?? "ubuntu-24-04-x64",
            sshKeys: [args.sshKeyId],
          },
          { parent: this },
        );

        this.ipAddress = droplet.ipv4Address;

        // DO arm64 droplet slugs end in "-arm" (e.g. "s-2vcpu-4gb-arm")
        this.arch = pulumi
          .output(args.serverType)
          .apply((st) => (st.endsWith("-arm") ? "arm64" : "amd64"));

        this.connection = droplet.ipv4Address.apply((ip) => ({
          host: ip,
          user: "root",
        }));

        this.dockerHost = droplet.ipv4Address.apply(
          (ip) => `ssh://root@${ip}`,
        );

        break;
      }

      case "oracle":
        // Phase 2: Oracle Cloud support
        throw new Error(
          `Provider "oracle" is not yet supported. Only "hetzner" is available.`,
        );

      default: {
        const _exhaustive: never = args.provider;
        throw new Error(`Unknown provider: ${_exhaustive}`);
      }
    }

    this.registerOutputs({
      ipAddress: this.ipAddress,
      arch: this.arch,
      connection: this.connection,
      dockerHost: this.dockerHost,
    });
  }
}
