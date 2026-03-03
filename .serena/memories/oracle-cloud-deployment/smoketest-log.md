# Oracle Cloud Deployment Smoketest Log

> Tracking the full OCI deployment process from zero to running gateway.
> This log will be adapted into a user-facing howto guide.

## Prerequisites

- Pulumi CLI installed
- Pulumi Cloud account (backend)
- Oracle Cloud account (always-free tier works)
- Tailscale account + auth key
- Node.js + npm installed

---

## Phase 1: OCI Account & Credentials Setup

### 1.1 OCI CLI Configuration

```bash
# Install OCI CLI (if not already)
brew install oci-cli   # macOS
# OR: bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"

# Configure OCI credentials (interactive wizard)
oci setup config
# Creates ~/.oci/config with:
#   - tenancy OCID
#   - user OCID
#   - API key fingerprint
#   - private key path
#   - region (e.g. us-phoenix-1)

# Upload the generated API public key to OCI console:
#   Profile icon (top right) → User Settings → Tokens and keys → Add API Key
#   → Paste Public Key contents from ~/.oci/oci_api_key_public.pem
```

### 1.2 Get Tenancy OCID (used as compartmentId)

```bash
oci iam tenancy get --query 'data.id' --raw-output
# Returns: ocid1.tenancy.oc1..aaaaaaa...
```

### 1.3 Verify OCI CLI Works

```bash
oci iam availability-domain list --query 'data[].name'
# Should return: ["Uocm:PHX-AD-1"] (or similar for your region)
```

---

## Phase 2: Pulumi Stack Setup

### 2.1 Login to Pulumi Cloud

```bash
pulumi login
# Opens browser for authentication
# OR: export PULUMI_ACCESS_TOKEN=pul-xxxx
```

### 2.2 Initialize Stack

```bash
cd openclaw-deploy
pulumi stack init uat
```

### 2.3 Configure OCI Provider

```bash
# OCI provider region (must match ~/.oci/config region)
pulumi config set oci:region us-phoenix-1
```

### 2.4 Configure Stack

```bash
# Required: provider and server type
pulumi config set provider oracle
pulumi config set serverType VM.Standard.A1.Flex

# Required: compartment (use tenancy OCID for root compartment)
pulumi config set compartmentId $(oci iam tenancy get --query 'data.id' --raw-output)

# Optional: customize instance resources (defaults: 2 OCPUs, 12GB RAM)
# pulumi config set ocpus 2
# pulumi config set memoryInGbs 12

# Secrets
pulumi config set --secret tailscaleAuthKey tskey-auth-xxxxx
pulumi config set --secret gatewayToken-uat $(openssl rand -hex 32)
```

### 2.5 Configure Egress Policy & Gateways

Edit `Pulumi.uat.yaml` directly for structured config:

```yaml
config:
  oci:region: us-phoenix-1
  openclaw-deploy:provider: oracle
  openclaw-deploy:serverType: VM.Standard.A1.Flex
  openclaw-deploy:compartmentId: ocid1.tenancy.oc1..xxxxx
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
- VCN + Internet Gateway + Route Table + Security List + public Subnet
- Ubuntu 24.04 image (auto-discovered for ARM shape)
- Availability domain (auto-discovered)

---

## Phase 3: Deploy

### 3.1 Pre-flight Checks

```bash
# Type-check
npx tsc --noEmit

# Run unit tests
npx vitest run

# Dry-run (validates config, renders templates, no resource creation)
pulumi preview
```

### 3.2 Deploy

```bash
pulumi up
# Creates: TLS key → VCN → Subnet → OCI Instance → Docker + Tailscale → Envoy → Gateway
# Takes ~5-10 minutes
```

### 3.3 Verify Stack Outputs

```bash
pulumi stack output
# Expected outputs:
#   serverIp: <public-ip>
#   tailscaleIp: <100.x.y.z>
#   envoyIp: 172.28.0.2
#   envoyWarnings: []
#   gatewayUrls: ["https://<hostname>.<tailnet>.ts.net"]
```

---

## Phase 4: Validation & Smoketest

### 4.1 SSH Access (via Tailscale)

```bash
# After Tailscale is up, SSH via tailnet (no public IP needed)
ssh root@<tailscale-ip>
```

### 4.2 Docker Status

```bash
ssh root@<tailscale-ip> docker ps
# Expected: envoy container + openclaw-gateway-uat container
```

### 4.3 Gateway Health Check

```bash
curl -s https://<gateway-url>/health
# Or via Tailscale:
curl -s http://<tailscale-ip>:18789/health
```

### 4.4 Envoy Egress Verification

```bash
# From inside the gateway container, test allowed domain
ssh root@<tailscale-ip> docker exec openclaw-gateway-uat curl -s https://api.anthropic.com
# Should connect (TLS passthrough via SNI whitelist)

# Test blocked domain
ssh root@<tailscale-ip> docker exec openclaw-gateway-uat curl -s https://evil.example.com
# Should fail (connection reset — not in whitelist)
```

### 4.5 DNS Resolution (via Envoy)

```bash
ssh root@<tailscale-ip> docker exec openclaw-gateway-uat nslookup api.anthropic.com
# Should resolve via Envoy DNS (172.28.0.2) → Cloudflare 1.1.1.2
```

---

## Phase 5: Teardown

```bash
pulumi destroy
# Removes all resources: instance, VCN, networking, SSH key
```

---

## Findings & Notes

_This section tracks issues, workarounds, and observations during smoketesting._

- [x] Preview succeeded: 33 resources, clean plan (no errors/warnings)
- [x] Auto-discovered: AD (MgKJ:PHX-AD-1), Ubuntu image, VCN networking, SSH key
- [x] VCN + networking created successfully (VCN, IGW, RT, SL, Subnet)
- [x] TLS SSH key generated and stored as Pulumi secret
- [x] Instance creation FAILED — Out of host capacity (see below)
- [ ] TODO: Retry deployment when capacity is available
- [ ] TODO: Verify cloud-init root SSH enablement timing
- [ ] TODO: Test Tailscale Serve HTTPS access
- [ ] TODO: Verify iptables rules inside gateway container
- [ ] TODO: Test egress isolation (blocked domains, allowed domains)
- [ ] TODO: Measure deployment time
- [ ] TODO: Test `pulumi destroy` clean teardown

---

## Known Issue: OCI ARM Free Tier Capacity

**Problem:** `500-InternalError, Out of host capacity.` when launching `VM.Standard.A1.Flex` instances.

**Root cause:** Oracle's Always Free ARM (Ampere A1) instances are extremely popular and frequently
out of stock. This is a well-known OCI limitation — not a configuration or IaC issue.

**What we tried (all failed with same error):**
- `MgKJ:PHX-AD-1` (auto-discovered, first attempt)
- `MgKJ:PHX-AD-2` (manual override via `pulumi config set region`)
- `MgKJ:PHX-AD-3` (manual override)
- All 3 Phoenix availability domains exhausted

**Note:** The VCN, networking, SSH key, and all other infrastructure resources created successfully.
Only the instance itself fails. Pulumi tracks the partial state — re-running `pulumi up` after
capacity becomes available will only create the missing resources.

**Workarounds:**
1. **Retry later** — capacity fluctuates. Early morning (US time) or weekdays tend to have better availability.
2. **Try a different region** — e.g. `us-ashburn-1`, `eu-frankfurt-1`. Change both:
   ```bash
   pulumi config set oci:region us-ashburn-1
   pulumi config set region ""  # clear AD override, let auto-discovery pick
   ```
   Note: changing regions requires destroying existing VCN resources first (`pulumi destroy`) since
   they're region-specific.
3. **Use a paid instance** — upgrade to a paid OCI account for guaranteed capacity, or switch providers:
   - Hetzner CAX11 (ARM, ~€4/mo) — near-instant provisioning
   - Hetzner CX22 (x86, ~€4/mo) — near-instant provisioning
   - DigitalOcean (x86, ~$6/mo) — near-instant provisioning
4. **OCI "retry loop" scripts** — some users run automated retry scripts that poll until capacity
   is available. This is outside the scope of our IaC but worth mentioning in docs.

**Impact on IaC:** Our auto-provisioning works correctly — the failure is purely an OCI supply-side
constraint. The Pulumi stack is in a partially-created state and will resume cleanly on retry.

**Recommendation for docs:** Warn users prominently that OCI free tier ARM instances may not be
immediately available. Suggest Hetzner as the lowest-friction alternative for getting started quickly.

---

## IaC Features Used

| Feature | Status | Notes |
|---------|--------|-------|
| Auto SSH key generation | Implemented | ED25519 via @pulumi/tls |
| Auto VCN + networking | Implemented | VCN, IGW, RT, SL, Subnet |
| Auto Ubuntu image discovery | Implemented | getImages with shape filter |
| Auto availability domain | Implemented | getAvailabilityDomains |
| Security list | Implemented | SSH (TCP 22) + Tailscale (UDP 41641) ingress |
| Tailscale Serve | Configured | HTTPS access via tailnet |
