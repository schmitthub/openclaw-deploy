# Hetzner Deployment Smoketest Log

> Tracking the full Hetzner deployment process from zero to running gateway.
> This log will be adapted into a user-facing howto guide.

## Prerequisites

- Pulumi CLI installed + Pulumi Cloud account (backend)
- Hetzner Cloud account + API token
- Tailscale account + auth key
- Node.js + npm installed
- `openclaw-deploy` repo cloned

---

## Phase 1: Hetzner Account & API Token

### 1.1 Create Hetzner Cloud Account

1. Sign up at https://console.hetzner.cloud
2. Create a new project (e.g. "openclaw")

### 1.2 Generate API Token

1. In the Hetzner console, go to your project
2. Click **Security** (left sidebar)
3. Click the **API Tokens** tab
4. Click **Generate API Token**
5. Name: `openclaw-pulumi`, Permission: **Read & Write**
6. Click **Generate API Token**
7. **Copy the token immediately** — it's only shown once

### 1.3 Set Hetzner Token for Pulumi

```bash
export HCLOUD_TOKEN=your-token-here
# OR set via Pulumi config:
pulumi config set hcloud:token --secret your-token-here
```

---

## Phase 2: Pulumi Stack Setup

### 2.1 Login to Pulumi Cloud

```bash
pulumi login
```

### 2.2 Initialize Stack

```bash
cd openclaw-deploy
pulumi stack init hetzner-uat
```

### 2.3 Configure Stack

```bash
# Required: provider, server type, region
pulumi config set provider hetzner
pulumi config set serverType cx23          # x86, 2 vCPU, 4GB RAM (~€4/mo)
# OR: pulumi config set serverType cax11   # ARM, 2 vCPU, 4GB RAM (~€4/mo)
# NOTE: Hetzner renamed server types in Oct 2025 (Gen3). cx22→cx23, cx32→cx33, etc.
# Use the API to list current types: curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/server_types
pulumi config set region nbg1              # Nuremberg, DE (recommended)
# Also available: hel1 (Helsinki, FI)
# WARNING: fsn1 (Falkenstein) is currently disabled for new provisioning (as of Mar 2026).
# US locations (ash, hil) and Singapore (sin) also available.

# Secrets
pulumi config set --secret tailscaleAuthKey tskey-auth-xxxxx
pulumi config set --secret gatewayToken-uat $(openssl rand -hex 32)
```

### 2.4 Configure Egress Policy & Gateways

Edit `Pulumi.hetzner-uat.yaml` for structured config:

```yaml
config:
  openclaw-deploy:provider: hetzner
  openclaw-deploy:serverType: cx22
  openclaw-deploy:region: fsn1
  openclaw-deploy:tailscaleAuthKey:
    secure: <auto-encrypted>
  openclaw-deploy:egressPolicy:
    - dst: "api.anthropic.com"
      proto: tls
      action: allow
  openclaw-deploy:gateways:
    - profile: uat
      version: latest
      packages: []
      port: 18789
      tailscale: serve
      configSet: {}
  openclaw-deploy:gatewayToken-uat:
    secure: <auto-encrypted>
```

**What's auto-provisioned (no config needed):**
- SSH key pair (ED25519, stored as Pulumi secret)

---

## Phase 3: Deploy

### 3.1 Pre-flight

```bash
npx tsc --noEmit
npx vitest run
pulumi preview
```

### 3.2 Deploy

```bash
pulumi up
```

### 3.3 Verify Stack Outputs

```bash
pulumi stack output
```

---

## Phase 4: Validation & Smoketest

- [ ] SSH access via Tailscale IP
- [ ] Docker containers running (envoy + gateway)
- [ ] Gateway health check
- [ ] Egress isolation: allowed domain works
- [ ] Egress isolation: blocked domain rejected
- [ ] DNS resolution via Envoy (Cloudflare 1.1.1.2)
- [ ] Tailscale Serve HTTPS access

---

## Phase 5: Teardown

```bash
pulumi destroy
pulumi stack rm hetzner-uat
```

---

## Findings & Notes

_This section tracks issues, workarounds, and observations during smoketesting._

- [x] Preview succeeded: 28 resources, clean plan
- [x] Server type `cx22` no longer exists — renamed to `cx23` in Hetzner Gen3 update (Oct 2025)
- [x] `fsn1` (Falkenstein) disabled for new provisioning — zero available server types
- [x] Switched to `nbg1` (Nuremberg) — full availability
- [ ] TODO: Run `pulumi up` and record outputs + timing
- [ ] TODO: Run validation checklist
- [ ] TODO: Test `pulumi destroy` clean teardown

---

## Comparison with Oracle Cloud

| Aspect | Oracle (Free Tier) | Hetzner |
|--------|-------------------|---------|
| Cost | Free (if capacity available) | ~€4/mo |
| Provisioning | Often fails (capacity) | Near-instant |
| Auto-provisioned | VCN, networking, SSH key, image, AD | SSH key only |
| Config complexity | Just `compartmentId` | `region` + `serverType` |
| ARM support | VM.Standard.A1.Flex | cax11, cax21, etc. |
| x86 support | VM.Standard.E2.1.Micro (limited) | cx22, cx32, etc. |
