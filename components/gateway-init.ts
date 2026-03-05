import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as crypto from "crypto";
import {
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  dataDir,
} from "../config";

export interface GatewayInitArgs {
  /** SSH connection args for remote commands */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Unique name for this gateway instance */
  profile: string;
  /** Docker image tag for the gateway (from GatewayImage) */
  imageName: pulumi.Input<string>;
  /** OpenClaw subcommands run in init containers (auto-prefixed with `openclaw `) */
  setupCommands?: string[];
  /** Secret env vars (JSON string: {"KEY":"value",...}) for init containers */
  secretEnv?: pulumi.Input<string>;
  /** Gateway auth token */
  gatewayToken: pulumi.Input<string>;
  /** Tailscale hostname (from TailscaleSidecar) — injected only into commands that reference it */
  tailscaleHostname: pulumi.Input<string>;
}

/**
 * Scans a command string for references to known env vars ($VAR or ${VAR}).
 * Returns the list of variable names that are referenced.
 */
function extractReferencedVars(cmd: string, availableVars: string[]): string[] {
  return availableVars.filter(
    (v) => cmd.includes(`$${v}`) || cmd.includes(`\${${v}}`),
  );
}

export class GatewayInit extends pulumi.ComponentResource {
  /** Signals that all init steps have completed */
  public readonly initComplete: pulumi.Output<string>;
  /** Content hash of all init commands (for gateway container replacement) */
  public readonly contentHash: string;

  constructor(
    name: string,
    args: GatewayInitArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:app:GatewayInit", name, {}, opts);

    const dDir = dataDir(args.profile);

    // Step 1: Create host directories for bind-mounted persistent data
    const createDirs = new command.remote.Command(
      `${name}-dirs`,
      {
        connection: args.connection,
        create: `mkdir -p ${dDir}/{config,workspace,config/identity,config/agents/main/agent,config/agents/main/sessions} && chown -R 1000:1000 ${dDir}/config ${dDir}/workspace`,
        delete: `rm -rf ${dDir}`,
      },
      { parent: this },
    );

    // Filter and prefix setup commands
    const setupCmds = (args.setupCommands ?? [])
      .filter((cmd) => {
        if (!cmd.trim()) {
          pulumi.log.warn(
            `Skipping empty setupCommand for gateway ${args.profile}`,
            this,
          );
          return false;
        }
        return true;
      })
      .map((cmd) => `openclaw ${cmd}`);

    // Content hash covers only setupCommand text changes (not secrets).
    // Secret rotation triggers gateway container replacement separately via
    // the Docker provider detecting changes to computedEnvs in gateway.ts.
    this.contentHash = crypto
      .createHash("sha256")
      .update(setupCmds.join("\n"))
      .digest("hex")
      .slice(0, 12);

    // Known variables available for env var scanning.
    // Only these vars use selective scanning — if a command references $VAR,
    // the resolved Pulumi output is included in the create string (causing re-run
    // when the value changes). All secretEnv keys are always exported unconditionally.
    const KNOWN_VARS = ["TAILSCALE_SERVE_HOST", "OPENCLAW_GATEWAY_TOKEN"];

    // Step 2: Generate per-command resources with env var scanning
    const setupResources: command.remote.Command[] = [];

    for (let i = 0; i < setupCmds.length; i++) {
      const cmd = setupCmds[i];
      const rawCmd = (args.setupCommands ?? [])[i] ?? "";
      const words = cmd.replace(/^openclaw\s+/, "").split(/\s+/);
      const slug = words
        .slice(0, 2)
        .join("-")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 20);
      const encoded = Buffer.from(cmd).toString("base64");

      // Scan for referenced variables in the raw (unprefixed) command
      const referencedVars = extractReferencedVars(rawCmd, KNOWN_VARS);
      const needsHostname = referencedVars.includes("TAILSCALE_SERVE_HOST");
      const needsToken = referencedVars.includes("OPENCLAW_GATEWAY_TOKEN");

      // Build the command string using pulumi.all() to resolve only referenced outputs.
      // Commands that don't reference TAILSCALE_SERVE_HOST won't include it in the
      // create string, so Pulumi won't re-run them when the hostname changes.
      const createCmd = buildInitCommand({
        profile: args.profile,
        imageName: args.imageName,
        encoded,
        dDir,
        needsHostname,
        needsToken,
        tailscaleHostname: args.tailscaleHostname,
        gatewayToken: args.gatewayToken,
        secretEnv: args.secretEnv,
      });

      const setupResource = new command.remote.Command(
        `${name}-setup-${i}-${slug}`,
        {
          connection: args.connection,
          create: createCmd,
          logging: "none",
        },
        {
          parent: this,
          dependsOn: [i === 0 ? createDirs : setupResources[i - 1]],
          additionalSecretOutputs: ["stdout", "stderr"],
        },
      );
      setupResources.push(setupResource);
    }

    const lastResource =
      setupResources.length > 0
        ? setupResources[setupResources.length - 1]
        : createDirs;

    this.initComplete = lastResource.stdout;

    this.registerOutputs({
      initComplete: this.initComplete,
      contentHash: this.contentHash,
    });
  }
}

/**
 * Builds the remote command string for an init container.
 * Uses export/unset pattern — secrets exist only in the SSH session's env
 * and the ephemeral container's env, both disappear after execution.
 */
function buildInitCommand(opts: {
  profile: string;
  imageName: pulumi.Input<string>;
  encoded: string;
  dDir: string;
  needsHostname: boolean;
  needsToken: boolean;
  tailscaleHostname: pulumi.Input<string>;
  gatewayToken: pulumi.Input<string>;
  secretEnv?: pulumi.Input<string>;
}): pulumi.Output<string> {
  // Use a named object to avoid fragile positional indexing.
  // Only include hostname/token if the command references them — this keeps
  // them out of the create string so Pulumi won't re-run unrelated commands
  // when these values change.
  return pulumi
    .all({
      imageName: pulumi.output(opts.imageName),
      secretJson: pulumi.output(opts.secretEnv ?? "{}"),
      hostname: opts.needsHostname
        ? pulumi.output(opts.tailscaleHostname)
        : pulumi.output(""),
      token: opts.needsToken
        ? pulumi.output(opts.gatewayToken)
        : pulumi.output(""),
    })
    .apply(({ imageName, secretJson, hostname, token }) => {
      let secrets: Record<string, string>;
      try {
        secrets = JSON.parse(secretJson) as Record<string, string>;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Invalid JSON in gatewaySecretEnv-${opts.profile}: ${detail}. Expected {"KEY":"value",...}`,
          { cause: e },
        );
      }

      const hostnameVal = opts.needsHostname ? hostname : undefined;
      const tokenVal = opts.needsToken ? token : undefined;

      // Build export statements
      const exports: string[] = [];
      const unsets: string[] = [];
      const dockerEnvFlags: string[] = [];

      // Add hostname if needed
      if (hostnameVal !== undefined) {
        const escaped = hostnameVal.replace(/'/g, "'\\''");
        exports.push(`export TAILSCALE_SERVE_HOST='${escaped}'`);
        dockerEnvFlags.push("-e TAILSCALE_SERVE_HOST");
        unsets.push("TAILSCALE_SERVE_HOST");
      }

      // Add token if needed
      if (tokenVal !== undefined) {
        const escaped = tokenVal.replace(/'/g, "'\\''");
        exports.push(`export OPENCLAW_GATEWAY_TOKEN='${escaped}'`);
        dockerEnvFlags.push("-e OPENCLAW_GATEWAY_TOKEN");
        unsets.push("OPENCLAW_GATEWAY_TOKEN");
      }

      // Add secret env vars
      for (const [k, v] of Object.entries(secrets)) {
        const escaped = v.replace(/'/g, "'\\''");
        exports.push(`export ${k}='${escaped}'`);
        dockerEnvFlags.push(`-e ${k}`);
        unsets.push(k);
      }

      const exportBlock =
        exports.length > 0 ? exports.join(" && ") + " && " : "";
      const unsetBlock =
        unsets.length > 0
          ? " && " + unsets.map((k) => `unset ${k}`).join(" && ")
          : "";
      const envFlags =
        dockerEnvFlags.length > 0 ? " " + dockerEnvFlags.join(" ") : "";

      return `${exportBlock}docker run --rm --network none --user node --entrypoint /bin/sh${envFlags} -v openclaw-home-${opts.profile}:/home/node -v ${opts.dDir}/config:${DEFAULT_OPENCLAW_CONFIG_DIR} -v ${opts.dDir}/workspace:${DEFAULT_OPENCLAW_WORKSPACE_DIR} ${imageName} -c "set -e; echo '${opts.encoded}' | base64 -d | sh -e"${unsetBlock}`;
    });
}
