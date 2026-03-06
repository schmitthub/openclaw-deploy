# Firewall Bypass + Agent Environment Prompt Feature

## Branch: `feat/firewall-bypass-exceptions`
## PR: https://github.com/schmitthub/openclaw-deploy/pull/15

## End Goal
Add firewall bypass (root-only SOCKS proxy) and agent environment prompt to both the Pulumi IaC deployment and the `reference/` Docker Compose test harness.

## Current State
- PR #15 created and pushed with initial commit
- Several post-PR fixes applied but NOT yet committed/pushed
- User is testing deploys iteratively

## Key Design Decisions (evolved during session)

### Agent prompt file location
- **Final**: `workspace/ocdeploy/AGENTS.md` (not `workspace/ENVIRONMENT.md`)
- OpenClaw auto-discovers `AGENTS.md` files in workspace subdirectories
- Loaded via `bootstrap-extra-files` hook with path `["ocdeploy/AGENTS.md"]`
- Root-owned, chmod 444, always overwritten on deploy (no hash check needed)

### Injection approach (REMOVED)
- Originally tried prepending `<important>Read ENVIRONMENT.md...</important>` into user's AGENTS.md
- Then tried prepending full file contents into AGENTS.md
- Both approaches removed — the hook handles context injection natively
- The `gateway-agents-ref-*` Pulumi resource was deleted entirely

### Pulumi resource: `gateway-env-prompt-${profile}`
- Single `command.remote.Command` that: mkdir -p ocdeploy, base64 decode write, chown root, chmod 444
- `triggers: [agentPromptHash]` for content-change re-runs
- `dependsOn: [gateway]`

### Default timeout
- Changed from 10s to 30s (`DEFAULT_BYPASS_TIMEOUT_SECS = 30`)

## Uncommitted Changes (since PR #15 commit 211b2ef)

### Fixes from PR review agents
- `renderAgentPrompt` imports constants from `defaults.ts` (was hardcoded)
- `reference/setup.sh` uses `shasum -a 256` (macOS compat, not `sha256sum`)
- `firewall-bypass` ssh -D wrapped in `if !` with actionable error
- `firewall-bypass` pgrep guarded with `|| true` for pipefail
- `firewall-bypass` auto-kill uses `;` not `&&` (pidfile cleanup always runs)
- Gendered pronoun "his" → "their"
- Stale reference/AGENTS.md descriptions fixed (DNAT→REDIRECT, etc.)
- Comments fixed ("immutable"→"read-only chmod 444", build context updated)
- New tests: SSH options, actionable error, constants-based agent prompt tests

### Path migration (ENVIRONMENT.md → ocdeploy/AGENTS.md)
- `index.ts`: env-prompt writes to `ocdeploy/AGENTS.md`, simplified (no hash check), agents-ref resource deleted
- `index.ts`: hook path changed to `["ocdeploy/AGENTS.md"]`
- `reference/setup.sh`: same path changes, injection block replaced with simple write, hook path updated

## TODO
- [ ] User confirms deploy works with new path
- [ ] Commit + push all uncommitted fixes (amend PR or new commit)
- [ ] Update AGENTS.md docs if needed (references to ENVIRONMENT.md path should say ocdeploy/AGENTS.md)
- [ ] Check README.md references to ENVIRONMENT.md
- [ ] Merge PR

## Files Modified (uncommitted)
- `index.ts` — simplified env-prompt, removed agents-ref, hook path
- `reference/setup.sh` — simplified write, removed injection, hook path
- `templates/agent-prompt.ts` — imports constants from defaults
- `templates/bypass.ts` — error handling fixes
- `reference/firewall-bypass` — matching error handling fixes
- `reference/AGENTS.md` — stale descriptions fixed, attribution corrected
- `components/gateway-image.ts` — comment fix
- `config/defaults.ts` — timeout 10→30
- `tests/templates.test.ts` — new tests added

## Lessons Learned
- OpenClaw discovers `AGENTS.md` files in workspace subdirectories automatically
- The `bootstrap-extra-files` hook path is relative to workspace dir
- File must be named `AGENTS.md`, be in a subdir, and be readable
- `sha256sum` doesn't exist on macOS — use `shasum -a 256`
- `set -euo pipefail` + `ssh -D -f` = custom error messages are dead code unless wrapped in `if !`

## IMPERATIVE
Always check with the user before proceeding with the next todo item. If all work is done, ask the user if they want to delete this memory.
