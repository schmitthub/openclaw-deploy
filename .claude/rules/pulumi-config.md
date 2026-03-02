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
  openclaw-deploy:sshKeyId: "12345"
  openclaw-deploy:tailscaleAuthKey:
    secure: <encrypted>
  openclaw-deploy:egressPolicy:
    - dst: "custom-api.example.com"
      proto: tls
      action: allow
  openclaw-deploy:gateways:
    - profile: dev
      version: latest
      packages: []
      port: 18789
      tailscale: serve
      configSet: {}
  openclaw-deploy:gatewayToken-dev:
    secure: <encrypted>
```

## Config Access Pattern
```typescript
const cfg = new pulumi.Config();
cfg.require("provider");           // plain string, fails if missing
cfg.requireSecret("tailscaleAuthKey"); // secret string
cfg.requireObject<EgressRule[]>("egressPolicy"); // structured object
```

## Secret Handling
- Secrets: `tailscaleAuthKey`, `gatewayToken-<profile>` — always use `cfg.requireSecret()`
- Remote commands that receive secrets use `logging: "none"` and `additionalSecretOutputs: ["stdout", "stderr"]`
- Secret values are encrypted in stack config files and never appear in plaintext logs

## Config Validation
- Provider validated against `VpsProvider` union at config load time
- Gateway profile names validated for uniqueness (duplicates cause Pulumi resource name collisions)
- Egress rules validated during `renderEnvoyConfig()` — unsupported types emit warnings
- Per-gateway tokens loaded dynamically: `cfg.requireSecret(\`gatewayToken-\${gw.profile}\`)`

## Component Argument Patterns
Components accept typed args interfaces:
- `ServerArgs`: provider, serverType, region, sshKeyId, image?
- `HostBootstrapArgs`: connection, tailscaleAuthKey
- `EnvoyEgressArgs`: dockerHost, connection, egressPolicy
- `GatewayArgs`: dockerHost, connection, internalNetworkName, profile, version, packages, port, tailscale, auth, configSet, env?

Security-critical gateway config keys (`gateway.mode`, `gateway.auth.*`, `gateway.trustedProxies`, `discovery.mdns.mode`) are set by the component and **cannot be overridden** by user `configSet`.

## Connection Switching
After `HostBootstrap` completes, all subsequent components (`EnvoyEgress`, `Gateway`) use the **Tailscale IP** for SSH commands, not the original public IP. This is because the public IP may be firewalled once Tailscale is up. The connection is derived in `index.ts` via `bootstrap.tailscaleIP.apply()`.
