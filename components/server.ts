import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as digitalocean from "@pulumi/digitalocean";
import * as oci from "@pulumi/oci";
import * as tls from "@pulumi/tls";
import { VpsProvider, HetznerConfig } from "../config";
import {
  OCI_ARM_SHAPE_PREFIX,
  OCI_DEFAULT_OCPUS,
  OCI_DEFAULT_MEMORY_GBS,
} from "../config/defaults";
import { OciInfra } from "./oci-infra";

export interface ServerArgs {
  provider: VpsProvider;
  serverType: pulumi.Input<string>; // e.g. "cx22" (Hetzner), "s-1vcpu-1gb" (DO), "VM.Standard.A1.Flex" (OCI)
  region?: pulumi.Input<string>; // Required for Hetzner/DO. Oracle auto-discovers availability domain if omitted.
  sshKeyId?: pulumi.Input<string>; // Key ID (Hetzner), fingerprint (DO), or SSH public key content (OCI). Auto-generated if omitted.
  image?: pulumi.Input<string>; // e.g. "ubuntu-24.04" (Hetzner), "ubuntu-24-04-x64" (DO), image OCID (OCI). Oracle auto-discovers if omitted.
  hetzner?: HetznerConfig; // Hetzner-specific options
  // OCI-specific
  compartmentId?: pulumi.Input<string>; // OCI compartment OCID (required for Oracle)
  subnetId?: pulumi.Input<string>; // OCI subnet OCID. Auto-creates VCN + networking if omitted.
  ocpus?: pulumi.Input<number>; // OCI flex shape: CPU count (default: 2)
  memoryInGbs?: pulumi.Input<number>; // OCI flex shape: memory in GB (default: 12)
}

export class Server extends pulumi.ComponentResource {
  public readonly ipAddress: pulumi.Output<string>;
  public readonly arch: pulumi.Output<string>; // "amd64" or "arm64"
  public readonly connection: pulumi.Output<{
    host: string;
    user: string;
    privateKey?: string;
  }>;
  public readonly dockerHost: pulumi.Output<string>; // "ssh://root@<ip>"

  constructor(
    name: string,
    args: ServerArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:infra:Server", name, {}, opts);

    // Auto-generate SSH key pair when sshKeyId is not provided
    let generatedKey: tls.PrivateKey | undefined;
    if (args.sshKeyId === undefined) {
      generatedKey = new tls.PrivateKey(
        `${name}-ssh-key`,
        { algorithm: "ED25519" },
        {
          parent: this,
          additionalSecretOutputs: ["privateKeyOpenssh", "privateKeyPem"],
        },
      );
    }

    switch (args.provider) {
      case "hetzner": {
        if (!args.region) {
          throw new Error('Hetzner provider requires "region" in ServerArgs.');
        }

        // Resolve SSH key: use provided ID or register generated key
        let sshKeyRef: pulumi.Input<string>;
        if (args.sshKeyId !== undefined) {
          sshKeyRef = args.sshKeyId;
        } else {
          const hcloudKey = new hcloud.SshKey(
            `${name}-ssh-key`,
            {
              name: `${name}-auto`,
              publicKey: generatedKey!.publicKeyOpenssh,
            },
            { parent: this },
          );
          sshKeyRef = hcloudKey.id;
        }

        const server = new hcloud.Server(
          `${name}-server`,
          {
            name,
            serverType: args.serverType,
            location: args.region,
            image: args.image ?? "ubuntu-24.04",
            backups: args.hetzner?.backups ?? false,
            sshKeys: [sshKeyRef],
            publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
          },
          { parent: this },
        );

        this.ipAddress = server.ipv4Address;

        this.arch = pulumi
          .output(args.serverType)
          .apply((st) => (st.startsWith("cax") ? "arm64" : "amd64"));

        if (generatedKey) {
          this.connection = pulumi
            .all([server.ipv4Address, generatedKey.privateKeyOpenssh])
            .apply(([ip, pk]) => ({
              host: ip,
              user: "root",
              privateKey: pk,
            }));
        } else {
          this.connection = server.ipv4Address.apply((ip) => ({
            host: ip,
            user: "root",
          }));
        }

        this.dockerHost = server.ipv4Address.apply((ip) => `ssh://root@${ip}`);

        break;
      }

      case "digitalocean": {
        if (!args.region) {
          throw new Error(
            'DigitalOcean provider requires "region" in ServerArgs.',
          );
        }

        // Resolve SSH key: use provided fingerprint or register generated key
        let sshKeyRef: pulumi.Input<string>;
        if (args.sshKeyId !== undefined) {
          sshKeyRef = args.sshKeyId;
        } else {
          const doKey = new digitalocean.SshKey(
            `${name}-ssh-key`,
            {
              name: `${name}-auto`,
              publicKey: generatedKey!.publicKeyOpenssh,
            },
            { parent: this },
          );
          sshKeyRef = doKey.fingerprint;
        }

        const droplet = new digitalocean.Droplet(
          `${name}-droplet`,
          {
            name,
            size: args.serverType, // e.g. "s-1vcpu-1gb", "s-2vcpu-2gb"
            region: args.region, // e.g. "nyc1", "sfo3"
            image: args.image ?? "ubuntu-24-04-x64",
            sshKeys: [sshKeyRef],
          },
          { parent: this },
        );

        this.ipAddress = droplet.ipv4Address;

        // DO arm64 droplet slugs end in "-arm" (e.g. "s-2vcpu-4gb-arm")
        this.arch = pulumi
          .output(args.serverType)
          .apply((st) => (st.endsWith("-arm") ? "arm64" : "amd64"));

        if (generatedKey) {
          this.connection = pulumi
            .all([droplet.ipv4Address, generatedKey.privateKeyOpenssh])
            .apply(([ip, pk]) => ({
              host: ip,
              user: "root",
              privateKey: pk,
            }));
        } else {
          this.connection = droplet.ipv4Address.apply((ip) => ({
            host: ip,
            user: "root",
          }));
        }

        this.dockerHost = droplet.ipv4Address.apply((ip) => `ssh://root@${ip}`);

        break;
      }

      case "oracle": {
        if (!args.compartmentId) {
          throw new Error(
            'Oracle provider requires "compartmentId" in ServerArgs.',
          );
        }

        // Auto-discover availability domain (first AD in the provider's region)
        const availabilityDomain = args.region
          ? pulumi.output(args.region)
          : oci.identity
              .getAvailabilityDomainsOutput({
                compartmentId: args.compartmentId,
              })
              .apply((result) => {
                if (result.availabilityDomains.length === 0) {
                  throw new Error(
                    "No availability domains found. Check OCI region configuration.",
                  );
                }
                return result.availabilityDomains[0].name;
              });

        // Auto-create VCN + networking when subnetId is not provided
        let subnetId: pulumi.Input<string>;
        if (args.subnetId) {
          subnetId = args.subnetId;
        } else {
          const infra = new OciInfra(
            `${name}-infra`,
            { compartmentId: args.compartmentId },
            { parent: this },
          );
          subnetId = infra.subnetId;
        }

        // Auto-discover Ubuntu 24.04 image when not provided
        let imageId: pulumi.Input<string>;
        if (args.image) {
          imageId = args.image;
        } else {
          imageId = oci.core
            .getImagesOutput({
              compartmentId: args.compartmentId,
              operatingSystem: "Canonical Ubuntu",
              operatingSystemVersion: "24.04",
              shape: args.serverType,
              sortBy: "TIMECREATED",
              sortOrder: "DESC",
              state: "AVAILABLE",
            })
            .apply((result) => {
              if (result.images.length === 0) {
                throw new Error(
                  'No Ubuntu 24.04 image found for shape. Provide "image" OCID explicitly.',
                );
              }
              return result.images[0].id;
            });
        }

        // Resolve SSH public key: use provided content or generated key
        const sshPublicKey =
          args.sshKeyId !== undefined
            ? args.sshKeyId
            : generatedKey!.publicKeyOpenssh;

        // OCI Ubuntu images default to "ubuntu" user with root login disabled.
        // Cloud-init enables root SSH to match the Hetzner/DO pattern expected
        // by bootstrap, envoy, and gateway components.
        const cloudInit = [
          "#!/bin/bash",
          "set -euo pipefail",
          "mkdir -p /root/.ssh && chmod 700 /root/.ssh",
          "if [ ! -f /home/ubuntu/.ssh/authorized_keys ]; then",
          '  echo "ERROR: /home/ubuntu/.ssh/authorized_keys not found" >&2; exit 1',
          "fi",
          "cp /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys",
          "chmod 600 /root/.ssh/authorized_keys",
          "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config",
          "sshd -t || { echo 'ERROR: sshd config test failed' >&2; exit 1; }",
          "systemctl restart sshd",
        ].join("\n");

        const instance = new oci.core.Instance(
          `${name}-instance`,
          {
            compartmentId: args.compartmentId,
            availabilityDomain,
            shape: args.serverType,
            shapeConfig: {
              ocpus: args.ocpus ?? OCI_DEFAULT_OCPUS,
              memoryInGbs: args.memoryInGbs ?? OCI_DEFAULT_MEMORY_GBS,
            },
            sourceDetails: {
              sourceType: "image",
              sourceId: imageId,
            },
            createVnicDetails: {
              subnetId,
              assignPublicIp: "true",
            },
            metadata: {
              ssh_authorized_keys: sshPublicKey,
              user_data: Buffer.from(cloudInit).toString("base64"),
            },
            displayName: name,
          },
          { parent: this },
        );

        // OCI doesn't expose public IP on the Instance directly —
        // resolve via primary VNIC attachment → VNIC → publicIpAddress.
        const publicIp = oci.core
          .getVnicAttachmentsOutput({
            instanceId: instance.id,
            compartmentId: args.compartmentId,
          })
          .apply((att) => {
            if (att.vnicAttachments.length === 0) {
              throw new Error("No VNIC attachments found for OCI instance.");
            }
            return oci.core.getVnic({
              vnicId: att.vnicAttachments[0].vnicId,
            });
          })
          .apply((vnic) => {
            if (!vnic.publicIpAddress) {
              throw new Error(
                "OCI instance VNIC has no public IP address. Ensure the subnet allows " +
                  "public IP assignment and the VNIC is configured with assignPublicIp: true.",
              );
            }
            return vnic.publicIpAddress;
          });

        this.ipAddress = publicIp;

        // ARM detection: A1 shapes are ARM (Ampere), others are x86
        this.arch = pulumi
          .output(args.serverType)
          .apply((st) =>
            st.startsWith(OCI_ARM_SHAPE_PREFIX) ? "arm64" : "amd64",
          );

        if (generatedKey) {
          this.connection = pulumi
            .all([publicIp, generatedKey.privateKeyOpenssh])
            .apply(([ip, pk]) => ({
              host: ip,
              user: "root",
              privateKey: pk,
            }));
        } else {
          this.connection = publicIp.apply((ip) => ({
            host: ip,
            user: "root",
          }));
        }

        this.dockerHost = publicIp.apply((ip) => `ssh://root@${ip}`);

        break;
      }

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
