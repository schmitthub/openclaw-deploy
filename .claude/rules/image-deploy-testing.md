---
globs: ["components/gateway-image.ts", "components/gateway.ts", "index.ts", "config/defaults.ts"]
---

# Image & Deploy Testing Rules

## Verify with Pulumi Preview

After making changes to image build, pull, prune, or container deployment logic, you **must** run `pulumi preview --diff --stack <stack>` and review the output before considering work complete.

- Confirm no spurious resource replacements or re-creations appear.
- Confirm resources that should be unchanged show no diff.
- Confirm new/changed resources have the expected operation (create, update, delete).
- If the preview shows unexpected diffs, investigate and fix before proceeding.

Unit tests with mocked Pulumi resources cannot detect these regressions — only `pulumi preview` against real state validates resource lifecycle behavior.

## Neo Review Gate

- When `pulumi preview` shows unexpected diffs or errors you cannot immediately diagnose, ask Pulumi Neo (`neo-bridge` MCP tool) for guidance before attempting fixes.
- Before requesting Neo review, **commit and push** changes so they are available on the remote. Provide Neo the commit hash, branch name, a summary of changes, and `pulumi preview --diff` output. Neo must approve before proceeding.
