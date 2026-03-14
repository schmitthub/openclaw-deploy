import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as crypto from "crypto";
import {
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEFAULT_OPENCLAW_WORKSPACE_DIR,
  dataDir,
} from "../config";
import type { CommandGroup } from "../config/types";

export interface GatewayInitArgs {
  /** SSH connection args for remote commands */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Unique name for this gateway instance */
  profile: string;
  /** Docker image tag for the gateway (from GatewayImage) */
  imageName: pulumi.Input<string>;
  /** Ordered pre-start command groups. One init container per group. */
  preStartCommands?: CommandGroup[];
  /** Individual secret env vars — each key is a separate Pulumi secret. All are available to all commands. */
  envVars?: Record<string, pulumi.Input<string>>;
  /** Gateway auth token */
  gatewayToken: pulumi.Input<string>;
  /** Tailscale hostname (from TailscaleSidecar) — available as $TAILSCALE_SERVE_HOST in commands */
  tailscaleHostname: pulumi.Input<string>;
}

/** Hash a list of command strings into a short hex digest. */
function hashCommands(cmds: string[]): string {
  return crypto
    .createHash("sha256")
    .update(cmds.join("\n"))
    .digest("hex")
    .slice(0, 12);
}

/** Scan command text for $VAR or ${VAR} references and return matching key names. */
function scanReferencedVars(cmdText: string, varNames: string[]): string[] {
  return varNames.filter(
    (v) => cmdText.includes(`$${v}`) || cmdText.includes(`\${${v}}`),
  );
}

export class GatewayInit extends pulumi.ComponentResource {
  /** Signals that all pre-start init steps have completed */
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
    const envVars = args.envVars ?? {};
    const groups = args.preStartCommands ?? [];

    // All available env var names for reference scanning
    const allVarNames = [
      "OPENCLAW_GATEWAY_TOKEN",
      "TAILSCALE_SERVE_HOST",
      ...Object.keys(envVars),
    ];

    // Full env var map: custom vars first, then reserved vars (reserved always win).
    const allEnvOutputs: Record<string, pulumi.Input<string>> = {
      ...envVars,
      OPENCLAW_GATEWAY_TOKEN: args.gatewayToken,
      TAILSCALE_SERVE_HOST: args.tailscaleHostname,
    };

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

    // Content hash covers all command text across all groups (for gateway container replacement)
    const allCmds = groups.flatMap((g) => g.commands);
    this.contentHash = hashCommands(allCmds);

    // Step 2: Create one resource per group in config-defined order
    const groupResources: command.remote.Command[] = [];

    for (const group of groups) {
      const validCmds = group.commands.filter((cmd) => {
        if (!cmd.trim()) {
          pulumi.log.warn(
            `Skipping empty command in group "${group.name}" for gateway ${args.profile}`,
            this,
          );
          return false;
        }
        return true;
      });

      if (validCmds.length === 0) continue;

      const script = validCmds.join("\n");
      const encoded = Buffer.from(script).toString("base64");
      const groupHash = hashCommands(validCmds);

      // Scan which env vars this group's commands reference.
      // All vars are in the environment; scanning controls triggers only.
      const groupCmdText = validCmds.join("\n");
      const referencedVars = scanReferencedVars(groupCmdText, allVarNames);

      // Build environment (all vars) and triggers (only referenced vars + group hash)
      const environment = pulumi
        .all(
          Object.fromEntries(
            Object.entries(allEnvOutputs).map(([k, v]) => [
              k,
              pulumi.output(v),
            ]),
          ),
        )
        .apply((env) => env as Record<string, string>);

      const triggerInputs: pulumi.Input<string>[] = [groupHash];
      for (const varName of referencedVars) {
        if (allEnvOutputs[varName]) {
          triggerInputs.push(allEnvOutputs[varName]);
        }
      }
      const triggers = pulumi.all(triggerInputs);

      // Build the create command (no secret values — safe to log)
      const create = pulumi
        .all([pulumi.output(args.imageName), environment] as const)
        .apply(([imageName, env]) => {
          const envFlags = Object.keys(env)
            .map((k) => `-e ${k}`)
            .join(" ");
          const envFlagsStr = envFlags ? ` ${envFlags}` : "";

          return `docker run --rm --network none --user node --entrypoint /bin/sh${envFlagsStr} -v openclaw-home-${args.profile}:/home/node -v ${dDir}/config:${DEFAULT_OPENCLAW_CONFIG_DIR} -v ${dDir}/workspace:${DEFAULT_OPENCLAW_WORKSPACE_DIR} ${imageName} -c "set -e; echo '${encoded}' | base64 -d | sh -e"`;
        });

      const groupResource = new command.remote.Command(
        `${name}-group-${group.name}`,
        {
          connection: args.connection,
          create,
          environment,
          triggers,
        },
        {
          parent: this,
          dependsOn: [
            groupResources.length === 0
              ? createDirs
              : groupResources[groupResources.length - 1],
          ],
          additionalSecretOutputs: ["stdout", "stderr", "environment"],
          // Don't re-run when only the image tag changes — triggers control re-execution
          ignoreChanges: ["create", "environment"],
        },
      );
      groupResources.push(groupResource);
    }

    const lastResource =
      groupResources.length > 0
        ? groupResources[groupResources.length - 1]
        : createDirs;

    this.initComplete = lastResource.stdout;

    this.registerOutputs({
      initComplete: this.initComplete,
      contentHash: this.contentHash,
    });
  }
}
