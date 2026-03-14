.PHONY: update-digests status logs restart exec shell openclaw stats health ps bypass install uninstall

OCM := ./scripts/manage.sh
STACK ?=
PROFILE ?=
SERVICE ?= gateway
TARGET ?= node
FOLLOW ?=
CMD ?=

# Build OCM flags from Make variables
_OCM_FLAGS := $(if $(STACK),--stack $(STACK)) $(if $(PROFILE),--profile $(PROFILE))

## update-digests: Fetch current multi-arch manifest digests and write config/digests.ts
update-digests:
	@./scripts/update-base-digests.sh

## status: Show container status for the current profile
status:
	@$(OCM) $(_OCM_FLAGS) status

## logs: Container logs (SERVICE=gateway|envoy|sidecar, FOLLOW=-f)
logs:
	@$(OCM) $(_OCM_FLAGS) logs $(SERVICE) $(FOLLOW)

## restart: Restart containers (SERVICE=gateway|envoy|sidecar|all)
restart:
	@$(OCM) $(_OCM_FLAGS) restart $(SERVICE)

## exec: Shell into gateway container
exec:
	@$(OCM) $(_OCM_FLAGS) exec

## shell: Shell access (TARGET=node|root|vps)
shell:
	@$(OCM) $(_OCM_FLAGS) shell $(TARGET)

## openclaw: Run openclaw CLI (CMD="config get gateway.port")
openclaw:
	@$(OCM) $(_OCM_FLAGS) openclaw $(CMD)

## stats: Container CPU, memory, network, block I/O
stats:
	@$(OCM) $(_OCM_FLAGS) stats

## health: Full system health (VPS host + disk + memory + containers)
health:
	@$(OCM) $(_OCM_FLAGS) health

## ps: Docker ps on VPS
ps:
	@$(OCM) $(_OCM_FLAGS) ps

## bypass: Firewall bypass SOCKS proxy
bypass:
	@$(OCM) $(_OCM_FLAGS) bypass

## install: Symlink ocm to /usr/local/bin
install:
	@sudo ln -sf "$(abspath $(OCM))" /usr/local/bin/ocm
	@echo "Installed: /usr/local/bin/ocm → $(abspath $(OCM))"

## uninstall: Remove ocm symlink
uninstall:
	@sudo rm -f /usr/local/bin/ocm
	@echo "Removed /usr/local/bin/ocm"
