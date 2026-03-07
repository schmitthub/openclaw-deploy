import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";

export interface HostBootstrapArgs {
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  autoUpdate?: boolean;
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
          "command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)",
          "systemctl enable docker",
          "systemctl start docker",
          "docker --version",
          "apt-get install -y fail2ban jq",
          "systemctl enable fail2ban",
          "systemctl start fail2ban",
        ].join(" && "),
      },
      { parent: this },
    );

    // Step 1a: Enable automatic security updates via unattended-upgrades (opt-in).
    let enableAutoUpdates: command.remote.Command | undefined;
    if (args.autoUpdate) {
      const UNATTENDED_CMD = [
        "DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades",
        `printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades`,
        "systemctl enable unattended-upgrades",
        "systemctl restart unattended-upgrades",
        "sleep 1",
        "systemctl is-active unattended-upgrades",
      ].join(" && ");
      enableAutoUpdates = new command.remote.Command(
        `${name}-unattended-upgrades`,
        {
          connection: args.connection,
          create: UNATTENDED_CMD,
          triggers: [UNATTENDED_CMD],
        },
        { parent: this, dependsOn: [installDocker] },
      );
    }

    // Step 1b: Configure SSH AcceptEnv so Pulumi can pass env vars via setenv.
    // Separate resource so it runs even when installDocker is already in state.
    // Uses sshd_config.d/ for global scope (avoids Match block scoping issues).
    // Service name varies: ssh (Ubuntu/Debian) vs sshd (RHEL/Fedora/Hetzner).
    const ACCEPT_ENV_CMD = [
      "mkdir -p /etc/ssh/sshd_config.d",
      "echo 'AcceptEnv *' > /etc/ssh/sshd_config.d/99-accept-env.conf",
      "(systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || kill -HUP $(cat /var/run/sshd.pid 2>/dev/null) 2>/dev/null || echo 'WARNING: sshd reload failed — AcceptEnv may not take effect until next restart' >&2)",
    ].join(" && ");
    const configureAcceptEnv = new command.remote.Command(
      `${name}-accept-env`,
      {
        connection: args.connection,
        create: ACCEPT_ENV_CMD,
        triggers: [ACCEPT_ENV_CMD],
      },
      { parent: this, dependsOn: [installDocker] },
    );

    // dockerReady waits for all bootstrap steps
    const bootstrapOutputs: pulumi.Output<string>[] = [
      configureAcceptEnv.stdout,
    ];
    if (enableAutoUpdates) bootstrapOutputs.push(enableAutoUpdates.stdout);
    this.dockerReady = pulumi.all(bootstrapOutputs).apply(() => "ready");

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
