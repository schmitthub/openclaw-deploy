import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";

export interface HostBootstrapArgs {
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
}

export class HostBootstrap extends pulumi.ComponentResource {
  public readonly dockerReady: pulumi.Output<string>; // sentinel for dependency
  public readonly dockerHost: pulumi.Output<string>; // "ssh://root@<publicIP>"

  constructor(
    name: string,
    args: HostBootstrapArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:infra:HostBootstrap", name, {}, opts);

    // Step 1: Install Docker Engine + fail2ban for SSH hardening
    const installDocker = new command.remote.Command(
      `${name}-install-docker`,
      {
        connection: args.connection,
        create: [
          "curl -fsSL https://get.docker.com | sh",
          "systemctl enable docker",
          "systemctl start docker",
          "docker --version",
          "apt-get install -y fail2ban jq",
          // Allow Pulumi's SSH client to pass env vars to remote commands.
          // Secrets are passed via the `environment` property on command.remote.Command
          // instead of embedding them in command strings (which Pulumi logs on error).
          "grep -q '^AcceptEnv \\*' /etc/ssh/sshd_config || (echo 'AcceptEnv *' >> /etc/ssh/sshd_config && systemctl reload sshd)",
          "systemctl enable fail2ban",
          "systemctl start fail2ban",
        ].join(" && "),
      },
      { parent: this },
    );

    this.dockerReady = installDocker.stdout.apply(() => "ready");

    const conn = pulumi.output(args.connection);
    const hostIp = conn.apply((c) => c.host);
    const privateKey = conn.apply((c) => c.privateKey ?? "");

    // Step 2: Add the host's SSH key to local known_hosts + configure SSH identity.
    // The Docker provider shells out to the system `ssh` client which needs:
    // (a) the host key in known_hosts, and
    // (b) the private key accessible via ~/.ssh/config IdentityFile.
    // When using auto-generated SSH keys (no sshKeyId), the private key only exists
    // in Pulumi state — we write it to disk so the Docker provider can use it.
    const setupSsh = new command.local.Command(
      `${name}-setup-ssh`,
      {
        create: pulumi.interpolate`set -euo pipefail
mkdir -p ~/.ssh && chmod 700 ~/.ssh
KEYSCAN_OK=false
for i in 1 2 3 4 5; do
  if ssh-keyscan -H ${hostIp} >> ~/.ssh/known_hosts 2>/dev/null && grep -q "${hostIp}" ~/.ssh/known_hosts 2>/dev/null; then
    KEYSCAN_OK=true
    break
  fi
  echo "ssh-keyscan attempt $i failed, retrying in 10s..." >&2
  sleep 10
done
if [ "$KEYSCAN_OK" != "true" ]; then
  echo "ERROR: ssh-keyscan failed after 5 attempts for ${hostIp}" >&2
  exit 1
fi
KEY="${privateKey}"
if [ -n "$KEY" ]; then
  KEYFILE=~/.ssh/openclaw-deploy-${name}
  printf '%s\n' "$KEY" > "$KEYFILE"
  chmod 600 "$KEYFILE"
  # Add SSH config entry if not already present
  if ! grep -q "# openclaw-deploy-${name}" ~/.ssh/config 2>/dev/null; then
    printf '\n# openclaw-deploy-${name}\nHost %s\n  IdentityFile %s\n  IdentitiesOnly yes\n  StrictHostKeyChecking no\n  UserKnownHostsFile ~/.ssh/known_hosts\n' "${hostIp}" "$KEYFILE" >> ~/.ssh/config
  fi
fi
`,
        delete: pulumi.interpolate`
ssh-keygen -R ${hostIp} 2>/dev/null; true
rm -f ~/.ssh/openclaw-deploy-${name}
if [ -f ~/.ssh/config ]; then
  sed -i.bak '/# openclaw-deploy-${name}/,/^$/d' ~/.ssh/config 2>/dev/null && rm -f ~/.ssh/config.bak; true
fi
`,
        logging: "none",
      },
      {
        parent: this,
        dependsOn: [installDocker],
        additionalSecretOutputs: ["stdout", "stderr"],
      },
    );

    // dockerHost depends on setupSsh so downstream Docker providers
    // don't connect until SSH is fully configured locally.
    this.dockerHost = pulumi
      .all([setupSsh.stdout, hostIp])
      .apply(([, ip]) => `ssh://root@${ip}`);

    this.registerOutputs({
      dockerReady: this.dockerReady,
      dockerHost: this.dockerHost,
    });
  }
}
