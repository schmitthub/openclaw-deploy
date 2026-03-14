import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as crypto from "crypto";
import type { CommandGroup } from "../config/types";

export interface GatewayPostInitArgs {
  /** SSH connection args for remote commands */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Unique name for this gateway instance */
  profile: string;
  /** Gateway container name (e.g. "openclaw-gateway-main") */
  containerName: pulumi.Input<string>;
  /** Gateway port for healthcheck */
  port: number;
  /** Ordered post-start command groups */
  postStartCommands: CommandGroup[];
  /** Individual secret env vars — all available to all commands */
  envVars?: Record<string, pulumi.Input<string>>;
  /** Gateway auth token */
  gatewayToken: pulumi.Input<string>;
  /** Tailscale hostname — available as $TAILSCALE_SERVE_HOST */
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

export class GatewayPostInit extends pulumi.ComponentResource {
  /** Signals that all post-start commands have completed */
  public readonly postInitComplete: pulumi.Output<string>;

  constructor(
    name: string,
    args: GatewayPostInitArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:app:GatewayPostInit", name, {}, opts);

    const envVars = args.envVars ?? {};
    const groups = args.postStartCommands;

    const allVarNames = [
      "OPENCLAW_GATEWAY_TOKEN",
      "TAILSCALE_SERVE_HOST",
      ...Object.keys(envVars),
    ];

    const allEnvOutputs: Record<string, pulumi.Input<string>> = {
      ...envVars,
      OPENCLAW_GATEWAY_TOKEN: args.gatewayToken,
      TAILSCALE_SERVE_HOST: args.tailscaleHostname,
    };

    // Wait for the gateway to be healthy before running post-start commands
    const healthWait = new command.remote.Command(
      `${name}-health-wait`,
      {
        connection: args.connection,
        create: pulumi.interpolate`timeout 60 sh -c 'until docker exec ${args.containerName} wget -q --spider http://127.0.0.1:${args.port}/healthz 2>/dev/null; do state=$(docker inspect -f "{{.State.Status}}" ${args.containerName} 2>/dev/null); [ "$state" != "running" ] && echo "ERROR: container not running (state: $state)" >&2 && exit 1; sleep 3; done'`,
        triggers: [Date.now().toString()],
      },
      { parent: this },
    );

    // Create one resource per group in config-defined order, executed via docker exec
    const groupResources: command.remote.Command[] = [];

    for (const group of groups) {
      const validCmds = group.commands.filter((cmd) => {
        if (!cmd.trim()) {
          pulumi.log.warn(
            `Skipping empty post-start command in group "${group.name}" for gateway ${args.profile}`,
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

      // Scan which env vars this group references (triggers only)
      const groupCmdText = validCmds.join("\n");
      const referencedVars = scanReferencedVars(groupCmdText, allVarNames);

      // Triggers: group hash + referenced env vars only
      const triggerInputs: pulumi.Input<string>[] = [groupHash];
      for (const varName of referencedVars) {
        if (allEnvOutputs[varName]) {
          triggerInputs.push(allEnvOutputs[varName]);
        }
      }
      const triggers = pulumi.all(triggerInputs);

      // docker exec inherits the container's environment — all env vars are already
      // set on the gateway container via gateway.ts envs property.
      const create = pulumi
        .output(args.containerName)
        .apply(
          (containerName) =>
            `docker exec ${containerName} sh -c 'set -e; echo '"'"'${encoded}'"'"' | base64 -d | sh -e'`,
        );

      const groupResource = new command.remote.Command(
        `${name}-group-${group.name}`,
        {
          connection: args.connection,
          create,
          triggers,
        },
        {
          parent: this,
          dependsOn: [
            groupResources.length === 0
              ? healthWait
              : groupResources[groupResources.length - 1],
          ],
          // Don't re-run when only the container name changes — triggers control re-execution
          ignoreChanges: ["create"],
        },
      );
      groupResources.push(groupResource);
    }

    const lastResource =
      groupResources.length > 0
        ? groupResources[groupResources.length - 1]
        : healthWait;

    this.postInitComplete = lastResource.stdout;

    this.registerOutputs({
      postInitComplete: this.postInitComplete,
    });
  }
}
