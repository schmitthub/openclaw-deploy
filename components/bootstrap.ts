import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";

export interface HostBootstrapArgs {
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  tailscaleAuthKey: pulumi.Input<string>; // secret
}

export class HostBootstrap extends pulumi.ComponentResource {
  public readonly dockerReady: pulumi.Output<string>; // sentinel for dependency
  public readonly tailscaleIP: pulumi.Output<string>;
  public readonly dockerHost: pulumi.Output<string>; // "ssh://root@<tailscaleIP>"

  constructor(
    name: string,
    args: HostBootstrapArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:infra:HostBootstrap", name, {}, opts);

    // Step 1: Install Docker Engine via official convenience script
    const installDocker = new command.remote.Command(
      `${name}-install-docker`,
      {
        connection: args.connection,
        create: [
          "curl -fsSL https://get.docker.com | sh",
          "systemctl enable docker",
          "systemctl start docker",
          "docker --version",
        ].join(" && "),
      },
      { parent: this },
    );

    // Step 2: Install Tailscale via official install script
    // Serialized after Docker to avoid concurrent apt/dpkg lock contention
    const installTailscale = new command.remote.Command(
      `${name}-install-tailscale`,
      {
        connection: args.connection,
        create: "curl -fsSL https://tailscale.com/install.sh | sh",
      },
      { parent: this, dependsOn: [installDocker] },
    );

    // Step 3: Authenticate Tailscale and retrieve the Tailscale IP
    const tailscaleUp = new command.remote.Command(
      `${name}-tailscale-up`,
      {
        connection: args.connection,
        create: pulumi.interpolate`tailscale up --authkey=${args.tailscaleAuthKey} --ssh && tailscale ip -4`,
        logging: "none",
      },
      {
        parent: this,
        dependsOn: [installTailscale],
        additionalSecretOutputs: ["stdout", "stderr"],
      },
    );

    this.dockerReady = installDocker.stdout.apply(() => "ready");

    // Extract only the last line — `tailscale up` may emit status messages before `tailscale ip -4`
    this.tailscaleIP = tailscaleUp.stdout.apply((out) => {
      const lines = out.trim().split("\n");
      return lines[lines.length - 1].trim();
    });

    this.dockerHost = this.tailscaleIP.apply((ip) => `ssh://root@${ip}`);

    this.registerOutputs({
      dockerReady: this.dockerReady,
      tailscaleIP: this.tailscaleIP,
      dockerHost: this.dockerHost,
    });
  }
}
