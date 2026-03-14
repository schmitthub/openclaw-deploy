#!/usr/bin/env bash
set -euo pipefail

# ocm — OpenClaw fleet management CLI
# Ergonomic wrappers for day-to-day VPS/container operations.
#
# Usage: ocm <subcommand> [options]
# Install: ln -sf "$(pwd)/scripts/manage.sh" /usr/local/bin/ocm

# ---------------------------------------------------------------------------
# Project dir resolution (follows symlinks so `ocm` works from anywhere)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || realpath "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONF_FILE="$SCRIPT_DIR/.ocm.conf"

# ---------------------------------------------------------------------------
# Color helpers (auto-disable when not a TTY)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
  CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; RESET=''
fi

_info()  { printf "${CYAN}%s${RESET}\n" "$*"; }
_ok()    { printf "${GREEN}%s${RESET}\n" "$*"; }
_warn()  { printf "${YELLOW}WARNING: %s${RESET}\n" "$*" >&2; }
_error() { printf "${RED}ERROR: %s${RESET}\n" "$*" >&2; }
_die()   { _error "$@"; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
command -v jq >/dev/null 2>&1 || _die "jq is required but not installed"
command -v pulumi >/dev/null 2>&1 || _die "pulumi is required but not installed"
command -v ssh >/dev/null 2>&1 || _die "ssh is required but not installed"

# ---------------------------------------------------------------------------
# Global state (populated by _resolve_stack / _resolve_profile)
# ---------------------------------------------------------------------------
OCM_STACK=""
OCM_PROFILE=""
_CACHED_IP=""
_CACHED_PROFILES=""

# ---------------------------------------------------------------------------
# Load config file
# ---------------------------------------------------------------------------
_load_conf() {
  if [[ -f "$CONF_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$CONF_FILE"
  fi
}

# ---------------------------------------------------------------------------
# Stack / profile resolution
# ---------------------------------------------------------------------------
_resolve_stack() {
  if [[ -n "$OCM_STACK" ]]; then return; fi
  OCM_STACK="${OCM_STACK_ENV:-${OCM_DEFAULT_STACK:-}}"
  if [[ -z "$OCM_STACK" ]]; then
    _die "No stack configured. Run 'ocm init' or pass --stack <stack>"
  fi
}

_resolve_profile() {
  if [[ -n "$OCM_PROFILE" ]]; then return; fi
  OCM_PROFILE="${OCM_PROFILE_ENV:-${OCM_DEFAULT_PROFILE:-}}"
  if [[ -z "$OCM_PROFILE" ]]; then
    _die "No profile configured. Run 'ocm init' or pass --profile <profile>"
  fi
}

# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------
_pulumi() {
  pulumi --cwd "$PROJECT_DIR" --stack "$OCM_STACK" "$@"
}

_get_ip() {
  if [[ -z "$_CACHED_IP" ]]; then
    _CACHED_IP="$(_pulumi stack output serverIp 2>/dev/null)" \
      || _die "Failed to get server IP from stack '$OCM_STACK'. Is the stack deployed?"
  fi
  printf '%s' "$_CACHED_IP"
}

_get_profiles() {
  if [[ -z "$_CACHED_PROFILES" ]]; then
    _CACHED_PROFILES="$(_pulumi config get openclaw-deploy:gateways --json 2>/dev/null | jq -r '.[].profile')" \
      || _die "Failed to read gateway profiles from stack '$OCM_STACK'"
  fi
  printf '%s' "$_CACHED_PROFILES"
}

_ssh() {
  local ip
  ip="$(_get_ip)"
  # Separate leading SSH flags (e.g. -t) from the remote command so they are
  # placed before the destination host — required for POSIX getopt platforms.
  local ssh_opts=()
  while [[ $# -gt 0 && "$1" == -* ]]; do
    ssh_opts+=("$1"); shift
  done
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "${ssh_opts[@]}" "root@${ip}" "$@"
}

_docker() {
  # Build a properly quoted command string for remote execution
  local cmd="docker"
  local arg
  for arg in "$@"; do
    cmd+=" $(printf '%q' "$arg")"
  done
  _ssh "$cmd"
}

_container_name() {
  local service="${1:-gateway}"
  _resolve_profile
  case "$service" in
    gateway|gw)   printf 'openclaw-gateway-%s' "$OCM_PROFILE" ;;
    envoy)        printf 'envoy-%s' "$OCM_PROFILE" ;;
    sidecar|ts)   printf 'tailscale-%s' "$OCM_PROFILE" ;;
    *) _die "Unknown service '$service'. Use: gateway, envoy, sidecar" ;;
  esac
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

cmd_init() {
  _info "Configuring ocm defaults..."
  echo

  # List available stacks
  local stacks
  stacks="$(pulumi --cwd "$PROJECT_DIR" stack ls --json 2>/dev/null | jq -r '.[].name' 2>/dev/null || true)"
  if [[ -n "$stacks" ]]; then
    printf '%b%s%b\n' "$BOLD" "Available stacks:" "$RESET"
    echo "$stacks" | while IFS= read -r s; do printf "  %s\n" "$s"; done
    echo
  fi

  local default_stack="${OCM_DEFAULT_STACK:-}"
  read -rp "Default stack${default_stack:+ [$default_stack]}: " input_stack
  local stack="${input_stack:-$default_stack}"
  [[ -n "$stack" ]] || _die "Stack is required"

  # List available profiles for the chosen stack
  local profiles
  profiles="$(pulumi --cwd "$PROJECT_DIR" --stack "$stack" config get openclaw-deploy:gateways --json 2>/dev/null | jq -r '.[].profile' 2>/dev/null || true)"
  if [[ -n "$profiles" ]]; then
    printf '\n%b%s%b\n' "$BOLD" "Available profiles for stack '$stack':" "$RESET"
    echo "$profiles" | while IFS= read -r p; do printf "  %s\n" "$p"; done
    echo
  fi

  local default_profile="${OCM_DEFAULT_PROFILE:-}"
  read -rp "Default profile${default_profile:+ [$default_profile]}: " input_profile
  local profile="${input_profile:-$default_profile}"
  [[ -n "$profile" ]] || _die "Profile is required"

  cat > "$CONF_FILE" <<EOF
# ocm defaults (git-ignored)
OCM_DEFAULT_STACK=$stack
OCM_DEFAULT_PROFILE=$profile
EOF

  _ok "Saved defaults to $CONF_FILE"
  printf "  Stack:   %s\n" "$stack"
  printf "  Profile: %s\n" "$profile"
}

cmd_status() {
  _resolve_stack
  _resolve_profile
  local gw envoy sc
  gw="$(_container_name gateway)"
  envoy="$(_container_name envoy)"
  sc="$(_container_name sidecar)"

  printf '%bStack:%b   %s\n' "$BOLD" "$RESET" "$OCM_STACK"
  printf '%bProfile:%b %s\n' "$BOLD" "$RESET" "$OCM_PROFILE"
  printf '%bVPS IP:%b  %s\n\n' "$BOLD" "$RESET" "$(_get_ip)"

  _docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' \
    --filter "name=$gw" --filter "name=$envoy" --filter "name=$sc"
}

cmd_logs() {
  _resolve_stack
  _resolve_profile
  local service="gateway"
  local follow=""
  local tail_lines=""
  local extra_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--follow) follow="-f"; shift ;;
      -n|--tail)   tail_lines="$2"; shift 2 ;;
      gateway|gw|envoy|sidecar|ts) service="$1"; shift ;;
      *) extra_args+=("$1"); shift ;;
    esac
  done

  local cname
  cname="$(_container_name "$service")"
  local args=("logs")
  [[ -n "$follow" ]] && args+=("-f")
  [[ -n "$tail_lines" ]] && args+=("--tail" "$tail_lines")
  args+=("${extra_args[@]+"${extra_args[@]}"}")
  args+=("$cname")

  _docker "${args[@]}"
}

_wait_healthy() {
  local cname="$1"
  local timeout="${2:-120}"
  local elapsed=0
  local interval=2
  local status

  printf "  Waiting for %s to be healthy..." "$cname"
  while [[ $elapsed -lt $timeout ]]; do
    status="$(_docker inspect --format '{{.State.Health.Status}}' "$cname" 2>/dev/null || echo "unknown")"
    if [[ "$status" == "healthy" ]]; then
      printf " ${GREEN}healthy${RESET} (%ds)\n" "$elapsed"
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  printf " ${RED}timeout after %ds (status: %s)${RESET}\n" "$timeout" "$status"
  return 1
}

_restart_container() {
  local cname="$1"
  _info "Restarting $cname..."
  _docker restart "$cname"
  _wait_healthy "$cname" || _die "$cname failed to become healthy"
}

cmd_restart() {
  _resolve_stack
  _resolve_profile
  local service="${1:-all}"

  # Dependency chain: sidecar → envoy → gateway
  # Restarting upstream requires cascading restarts downstream.
  case "$service" in
    all|sidecar|ts)
      _info "Restarting all containers for profile '$OCM_PROFILE' (dependency order)..."
      _restart_container "$(_container_name sidecar)"
      _restart_container "$(_container_name envoy)"
      _restart_container "$(_container_name gateway)"
      ;;
    envoy)
      _info "Restarting envoy + gateway for profile '$OCM_PROFILE' (dependency order)..."
      _restart_container "$(_container_name envoy)"
      _restart_container "$(_container_name gateway)"
      ;;
    gateway|gw)
      _restart_container "$(_container_name gateway)"
      ;;
    *)
      _die "Unknown service '$service'. Use: gateway, envoy, sidecar, all"
      ;;
  esac
  _ok "Done."
}

cmd_exec() {
  _resolve_stack
  _resolve_profile
  local user="node"
  local cmd=("bash")

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -u|--user) user="$2"; shift 2 ;;
      --) shift; cmd=("$@"); break ;;
      *)  cmd=("$@"); break ;;
    esac
  done

  local cname
  cname="$(_container_name gateway)"
  _ssh -t docker exec -it -u "$user" "$cname" "${cmd[@]}"
}

cmd_run() {
  _resolve_stack
  _resolve_profile
  local user="node"
  local cmd=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -u|--user) user="$2"; shift 2 ;;
      --) shift; cmd=("$@"); break ;;
      *)  cmd=("$@"); break ;;
    esac
  done

  [[ ${#cmd[@]} -gt 0 ]] || _die "Usage: ocm run [--user root] <cmd...>"

  # Discover image from running container
  local cname
  cname="$(_container_name gateway)"
  local image
  image="$(_docker inspect --format '{{.Config.Image}}' "$cname" 2>/dev/null)" \
    || _die "Failed to inspect container '$cname'. Is it running?"

  _ssh -t docker run --rm -it --user "$user" "$image" "${cmd[@]}"
}

cmd_shell() {
  _resolve_stack
  local target="${1:-node}"

  case "$target" in
    node)
      _resolve_profile
      local cname
      cname="$(_container_name gateway)"
      _ssh -t docker exec -it -u node "$cname" bash
      ;;
    root)
      _resolve_profile
      local cname
      cname="$(_container_name gateway)"
      _ssh -t docker exec -it -u root "$cname" bash
      ;;
    vps|host)
      _info "SSH into VPS as root..."
      _ssh
      ;;
    *)
      _die "Unknown shell target '$target'. Use: node (default), root, vps"
      ;;
  esac
}

cmd_openclaw() {
  _resolve_stack
  _resolve_profile
  [[ $# -gt 0 ]] || _die "Usage: ocm openclaw <cmd...>"

  local cname
  cname="$(_container_name gateway)"
  _ssh -t docker exec -it -u node "$cname" openclaw "$@"
}

cmd_ts_status() {
  _resolve_stack
  _resolve_profile
  local cname
  cname="$(_container_name sidecar)"
  _docker exec "$cname" tailscale status "$@"
}

cmd_bypass() {
  _resolve_stack
  _resolve_profile
  local duration="${1:-30}"
  local cname
  cname="$(_container_name gateway)"
  _ssh -t docker exec -it -u root "$cname" firewall-bypass "$duration"
}

cmd_stats() {
  _resolve_stack
  _resolve_profile
  local gw envoy sc
  gw="$(_container_name gateway)"
  envoy="$(_container_name envoy)"
  sc="$(_container_name sidecar)"

  printf '%bContainer resources:%b\n' "$BOLD" "$RESET"
  _ssh "docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}' | head -1; docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}' | grep -E '${gw}|${envoy}|${sc}'"
}

cmd_health() {
  _resolve_stack
  _resolve_profile

  printf '%b=== VPS Host ===%b\n' "$BOLD" "$RESET"
  _ssh "uptime"
  echo

  printf '%b=== Memory ===%b\n' "$BOLD" "$RESET"
  _ssh "free -h"
  echo

  printf '%b=== Disk ===%b\n' "$BOLD" "$RESET"
  _ssh "df -h / && echo && docker system df"
  echo

  printf '%b=== Containers ===%b\n' "$BOLD" "$RESET"
  local gw envoy sc
  gw="$(_container_name gateway)"
  envoy="$(_container_name envoy)"
  sc="$(_container_name sidecar)"
  _docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' \
    --filter "name=$gw" --filter "name=$envoy" --filter "name=$sc"
  echo

  printf '%b=== Container Resources ===%b\n' "$BOLD" "$RESET"
  _ssh "docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' | head -1; docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' | grep -E '${gw}|${envoy}|${sc}'"
}

cmd_ps() {
  _resolve_stack
  _docker ps "$@"
}

cmd_env() {
  _resolve_stack
  _resolve_profile
  local subcmd="${1:-}"
  shift || true

  case "$subcmd" in
    set)
      local key="${1:-}"
      local value="${2:-}"
      [[ -z "$key" ]] && _die "Usage: ocm env set <KEY> <VALUE>"
      [[ -z "$value" ]] && _die "Usage: ocm env set <KEY> <VALUE>"
      _pulumi config set --secret "gatewayEnv-${OCM_PROFILE}-${key}" "$value"
      _ok "✓ gatewayEnv-${OCM_PROFILE}-${key}"
      ;;
    list|ls)
      _info "[env] Profile: $OCM_PROFILE (stack: $OCM_STACK)"
      local prefix="openclaw-deploy:gatewayEnv-${OCM_PROFILE}-"
      _pulumi config --json \
        | jq -r --arg pfx "$prefix" 'to_entries[] | select(.key | startswith($pfx)) | .key | ltrimstr($pfx)'
      ;;
    delete|rm)
      local key="${1:-}"
      [[ -z "$key" ]] && _die "Usage: ocm env delete <KEY>"
      _pulumi config rm "gatewayEnv-${OCM_PROFILE}-${key}"
      _ok "✓ Removed gatewayEnv-${OCM_PROFILE}-${key}"
      ;;
    *)
      _die "Usage: ocm env <set|list|delete> [args...]"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
cmd_help() {
  cat <<EOF
${BOLD}ocm${RESET} — OpenClaw fleet management CLI

${BOLD}USAGE${RESET}
  ocm [--stack <stack>] [--profile <profile>] <command> [args...]

${BOLD}GLOBAL FLAGS${RESET}
  --stack <stack>       Override Pulumi stack (env: OCM_STACK)
  --profile <profile>   Override gateway profile (env: OCM_PROFILE)

${BOLD}COMMANDS${RESET}
  init                  Interactive setup of defaults (scripts/.ocm.conf)
  status                Show container status for the current profile
  logs [svc] [-f]       Container logs (svc: gateway, envoy, sidecar)
  restart [svc]         Restart with dependency cascade (sidecar→envoy→gateway)
  exec [opts] [cmd]     Exec into gateway (default: bash, -u root for root)
  run [opts] <cmd>      Ephemeral docker run --rm with gateway image
  shell [target]        Shell access (target: node, root, vps)
  openclaw <cmd>        Run openclaw CLI as node user
  stats                 Container CPU, memory, network, block I/O
  health                Full system health (VPS host + disk + memory + containers)
  ts-status             Tailscale status from sidecar
  bypass [duration]     Firewall bypass SOCKS proxy (default: 30s)
  env set <K> <V>       Set a secret env var (gatewayEnv-<profile>-<KEY>)
  env list              List env var keys for current profile
  env delete <K>        Remove an env var
  ps [args]             Docker ps on VPS
  help                  Show this help

${BOLD}SERVICES${RESET}
  gateway (gw)          OpenClaw gateway container
  envoy                 Envoy egress proxy container
  sidecar (ts)          Tailscale sidecar container

${BOLD}EXAMPLES${RESET}
  ocm status
  ocm logs -f
  ocm logs envoy -n 100
  ocm restart gateway
  ocm shell
  ocm shell vps
  ocm openclaw config get gateway.port
  ocm --stack oracle --profile dev logs -f
  ocm bypass 120
EOF
}

# ---------------------------------------------------------------------------
# Global flag parsing + dispatch
# ---------------------------------------------------------------------------
_load_conf

# Capture env var overrides before flag parsing
OCM_STACK_ENV="${OCM_STACK:-}"
OCM_PROFILE_ENV="${OCM_PROFILE:-}"

# Reset for flag parsing
OCM_STACK=""
OCM_PROFILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack)   OCM_STACK="$2"; shift 2 ;;
    --profile) OCM_PROFILE="$2"; shift 2 ;;
    -*)
      # Unknown global flag — might be for a subcommand, stop parsing
      break
      ;;
    *)
      break
      ;;
  esac
done

SUBCOMMAND="${1:-help}"
shift || true

case "$SUBCOMMAND" in
  init)       cmd_init "$@" ;;
  status|st)  cmd_status "$@" ;;
  logs|log)   cmd_logs "$@" ;;
  restart)    cmd_restart "$@" ;;
  exec)       cmd_exec "$@" ;;
  run)        cmd_run "$@" ;;
  shell|sh)   cmd_shell "$@" ;;
  openclaw)   cmd_openclaw "$@" ;;
  stats)      cmd_stats "$@" ;;
  health)     cmd_health "$@" ;;
  ts-status)  cmd_ts_status "$@" ;;
  bypass)     cmd_bypass "$@" ;;
  env)        cmd_env "$@" ;;
  ps)         cmd_ps "$@" ;;
  help|-h|--help) cmd_help ;;
  *) _die "Unknown command '$SUBCOMMAND'. Run 'ocm help' for usage." ;;
esac
