---
globs: ["Pulumi.yaml", "Pulumi.*.yaml", "index.ts", "config/**/*.ts"]
---

# Pulumi Config Rules

## Stack Config Format
Stack configuration lives in `Pulumi.<stack>.yaml` files. Values are read in `index.ts` via `pulumi.Config`.

```yaml
config:
  openclaw-deploy:provider: hetzner
  openclaw-deploy:serverType: cx22
  openclaw-deploy:region: fsn1
  # openclaw-deploy:sshKeyId: "12345"  # Optional: auto-generates ED25519 SSH key if omitted
  openclaw-deploy:tailscaleAuthKey:
    secure: <encrypted>
  openclaw-deploy:egressPolicy:
    - dst: "custom-api.example.com"
      proto: tls
      action: allow
  openclaw-deploy:gateways:
    - profile: dev
      version: latest
      port: 18789
      preStartCommands:
        default:
          - 'openclaw onboard --non-interactive --mode local --gateway-token "$OPENCLAW_GATEWAY_TOKEN"'
  # openclaw-deploy:dockerhubPush: true  # Optional: build locally + push to Docker Hub
  # openclaw-deploy:multiPlatform: true  # Optional: build amd64 + arm64 (requires dockerhubPush + platform)
  # openclaw-deploy:platform: linux/amd64  # Required when multiPlatform is true (e.g. linux/amd64, linux/arm64)
  # openclaw-deploy:autoUpdate: true  # Optional: automatic security updates via unattended-upgrades
  # openclaw-deploy:hetzner:  # Optional: Hetzner-specific options
  #   backups: true  # automatic daily backups (+20% server cost)
  openclaw-deploy:gatewayToken-dev:
    secure: <encrypted>
```

## Config Access Pattern
```typescript
const cfg = new pulumi.Config();
cfg.require("provider");           // plain string, fails if missing
cfg.get("sshKeyId");               // optional string (auto-generates SSH key if omitted)
cfg.getBoolean("dockerhubPush");   // optional boolean (default: false)
cfg.getBoolean("multiPlatform");   // optional boolean (default: false, only with dockerhubPush)
cfg.get("platform");               // optional string (e.g. "linux/amd64", required when multiPlatform is true)
cfg.getBoolean("autoUpdate");      // optional boolean (default: false)
cfg.getObject<HetznerConfig>("hetzner"); // optional provider-specific config (validated at runtime)
cfg.requireSecret("tailscaleAuthKey"); // secret string
cfg.requireObject<EgressRule[]>("egressPolicy"); // structured object
```

## Secret Handling
- Required secret: `tailscaleAuthKey` — use `cfg.requireSecret()`
- Auto-generated: `gatewayToken-<profile>` — use `cfg.getSecret()` with `random.RandomPassword` fallback (32 chars, stored in Pulumi state)
- Individual secret env vars: `gatewayEnv-<profile>-<KEY>` — discovered via `pulumi.runtime.allConfig()` prefix scanning, read via `cfg.requireSecret()`
- Remote commands that receive secrets use `logging: "none"` and `additionalSecretOutputs: ["stdout", "stderr"]`
- Secret values are encrypted in stack config files and never appear in plaintext logs

## Config Validation
- Provider validated against `VpsProvider` union at config load time
- Gateway profile names validated for uniqueness (duplicates cause Pulumi resource name collisions)
- Egress rules validated during `renderEnvoyConfig()` — unsupported types emit warnings
- Per-gateway tokens auto-generated via `random.RandomPassword`, manual override via `cfg.getSecret(\`gatewayToken-\${gw.profile}\`)`

## Component Argument Patterns
Components accept typed args interfaces (5 per gateway, plus shared infra):
- `ServerArgs`: provider, serverType, region?, sshKeyId?, image?, hetzner?, compartmentId?, subnetId?, ocpus?, memoryInGbs?
- `HostBootstrapArgs`: connection, autoUpdate?
- `EnvoyEgressArgs`: connection, egressPolicy
- `GatewayImageArgs`: connection, dockerHost, profile, version, installBrowser?, imageSteps?, dockerhubPush?, multiPlatform?, platform?
- `TailscaleSidecarArgs`: connection, dockerHost, profile, port, tailscaleAuthKey, tcpPortMappings?
- `EnvoyProxyArgs`: connection, dockerHost, sidecarContainerName, envoyConfigPath, envoyConfigHash, inspectedDomains, profile
- `GatewayInitArgs`: connection, profile, imageName, preStartCommands?, envVars?, gatewayToken, tailscaleHostname
- `GatewayPostInitArgs`: connection, profile, containerName, port, postStartCommands, envVars?, gatewayToken, tailscaleHostname
- `GatewayArgs`: dockerHost, profile, port, imageName, sidecarContainerName, tailscaleHostname, corefilePath, env?, envVars?, auth, initHash, configHash, imageDigest

Security-critical gateway config keys (`gateway.mode`, `gateway.auth.*`, `gateway.trustedProxies`, `discovery.mdns.mode`) are set by `GatewayInit` and **cannot be overridden** by user `preStartCommands`.

## Connection Model
All components use the **public IP** from `server.connection` for SSH commands. Tailscale runs inside sidecar containers (not on the host), so there is no Tailscale IP switching. The `tailscaleAuthKey` is passed to `TailscaleSidecar` which injects it as the `TS_AUTHKEY` env var on the sidecar container. Reusable auth keys are recommended for multi-gateway setups.
