# Unit Tests with Mocks (Jest/Vitest)

Project structure
my-project/
├── index.ts          # your Pulumi program
├── infra.ts          # resource definitions (imported by index.ts and tests)
├── Pulumi.yaml
├── Pulumi.dev.yaml
├── package.json
├── tsconfig.json
└── tests/
    └── infra.test.ts

The key pattern: separate resource creation from index.ts
Export your resource-creating logic from a module so tests can import it after setting mocks:

// infra.ts
import *as pulumi from "@pulumi/pulumi";
import* as command from "@pulumi/command";

export interface InitGroup {
  name: string;
  commands: string[];
  envVars: Record<string, pulumi.Input<string>>;
  triggers: pulumi.Input<any>[];
}

export function createInitGroups(
  connection: command.remote.ConnectionArgs,
  groups: InitGroup[],
) {
  return groups.map((group) => {
    const script = group.commands.join(" && ");
    return new command.remote.Command(`init-${group.name}`, {
      connection,
      create: pulumi.Output.all(
        ...Object.values(group.envVars),
      ).apply((vals) => {
        const envFlags = Object.keys(group.envVars)
          .map((k, i) => `-e ${k}="${vals[i]}"`)
          .join(" ");
        return `docker run --rm ${envFlags} -v /path/to/config:/config myapp:latest sh -c '${script}'`;
      }),
      triggers: { script, ...Object.fromEntries(group.triggers.map((t, i) => [`t${i}`, t])) },
    });
  });
}

Test file
// tests/infra.test.ts
import * as pulumi from "@pulumi/pulumi";

// Set mocks BEFORE importing any module that creates resources
pulumi.runtime.setMocks({
  newResource(args: pulumi.runtime.MockResourceArgs): {
    id: string;
    state: Record<string, any>;
  } {
    // Return the inputs as outputs, with a fake ID
    return {
      id: `${args.name}-id`,
      state: args.inputs,
    };
  },
  call(args: pulumi.runtime.MockCallArgs): Record<string, any> {
    return {};
  },
});

// Also mock config so your program doesn't fail on missing config keys
pulumi.runtime.setAllConfig({
  "my-project:host": "fake-host",
  "my-project:user": "fake-user",
  "my-project:privateKey": "fake-key",
  "my-project:dbPassword": "fake-db-pass",
  "my-project:apiKey": "fake-api-key",
  "my-project:licenseKey": "fake-license-key",
});

// NOW import your infra module
import { createInitGroups, InitGroup } from "../infra";

// Helper: unwrap a Pulumi Output for assertions
function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

describe("init groups", () => {
  const connection = {
    host: "fake",
    user: "fake",
    privateKey: "fake",
  };

  const groups: InitGroup[] = [
    {
      name: "db",
      commands: ["myapp configure --set db.password=$DB_PASSWORD", "myapp db migrate"],
      envVars: { DB_PASSWORD: "secret1" },
      triggers: ["secret1"],
    },
    {
      name: "api",
      commands: ["myapp configure --set api.key=$API_KEY"],
      envVars: { API_KEY: "secret2" },
      triggers: ["secret2"],
    },
    {
      name: "static",
      commands: ["myapp configure --set log.level=info"],
      envVars: {},
      triggers: [],
    },
  ];

  const resources = createInitGroups(connection, groups);

  test("creates one resource per group", () => {
    expect(resources).toHaveLength(3);
  });

  test("db group create command includes DB_PASSWORD env var", async () => {
    const createCmd = await promiseOf(resources[0].create!);
    expect(createCmd).toContain("-e DB_PASSWORD=");
    expect(createCmd).toContain("myapp db migrate");
  });

  test("db group triggers include the secret", async () => {
    const triggers = await promiseOf(
      pulumi.Output.create(resources[0].triggers),
    );
    expect(triggers).toHaveProperty("t0", "secret1");
  });

  test("static group has no env flags", async () => {
    const createCmd = await promiseOf(resources[2].create!);
    expect(createCmd).not.toContain("-e ");
  });

  test("create command runs all commands in group sequentially", async () => {
    const createCmd = await promiseOf(resources[0].create!);
    expect(createCmd).toContain(
      "myapp configure --set db.password=$DB_PASSWORD && myapp db migrate",
    );
  });
});

package.json additions
{
  "devDependencies": {
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "@types/jest": "^29.0.0"
  },
  "scripts": {
    "test": "jest"
  },
  "jest": {
    "transform": { "^.+\\.tsx?$": "ts-jest" },
    "testMatch": ["**/tests/**/*.test.ts"]
  }
}

Run with npm test -- no credentials, no engine, runs in seconds.

Local UAT (Preview with Local Backend)
This validates the full Pulumi resource graph and trigger diffing behavior without a real remote host:

# Use local state, no Pulumi Cloud needed

pulumi login --local

# Init a test stack

pulumi stack init uat

# Set config (commands will fail at deploy time since host is fake

# but preview works fine to validate the resource graph)

pulumi config set host 127.0.0.1
pulumi config set user testuser
pulumi config set --secret privateKey "fake-key"
pulumi config set --secret dbPassword "password-v1"
pulumi config set --secret apiKey "key-v1"
pulumi config set --secret licenseKey "lic-v1"

# Preview -- see all init groups created

pulumi preview

# Now change just one secret

pulumi config set --secret dbPassword "password-v2"

# Preview again -- only the db init group should show as "replace"

pulumi preview

The second preview should show something like:

  ~ command:remote:Command  init-db  replace   [diff: ~triggers]
    command:remote:Command  init-api           no change
    command:remote:Command  init-static        no change

That confirms only the group tied to the changed secret gets replaced.

Summary
Approach What it validates Speed Credentials needed
Unit tests (mocks) Grouping logic, trigger wiring, command construction Seconds None
Local preview Full resource graph, trigger diffing, replacement behavior ~10s None (local backend)
Real preview/up Actual SSH + docker execution Minutes Real host + secrets
Start with unit tests for fast iteration on the grouping logic, then local preview to confirm trigger behavior, then real deploy when you're confident.
