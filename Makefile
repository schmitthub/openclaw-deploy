.PHONY: update-digests

## update-digests: Fetch current multi-arch manifest digests and update config/defaults.ts
update-digests:
	@./scripts/update-base-digests.sh
