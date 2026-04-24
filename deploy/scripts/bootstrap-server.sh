#!/usr/bin/env bash
set -euo pipefail

MODE="direct-http"
REPO_URL="https://github.com/GreenhandTan/openclaw-lobster-monitor.git"
REPO_BRANCH="main"
REPO_DIR="/opt/openclaw-lobster-monitor"
PUBLIC_HOST=""
PUBLIC_PORT=""
LISTEN_PORT=""
INGEST_TOKEN=""
DATA_DIR="/var/lib/openclaw-lobster-monitor"
SERVICE_NAME="openclaw-lobster-monitor"
APP_USER="openclaw-monitor"
APP_GROUP="openclaw-monitor"
ENV_FILE="/etc/openclaw-lobster-monitor/dashboard.env"
CADDYFILE="/etc/caddy/Caddyfile"
TARGET_NODE_MAJOR="${TARGET_NODE_MAJOR:-22}"
FORCE_NODE_INSTALL="false"
SKIP_REPO_UPDATE="false"
NODE_BIN=""

OS_NAME="unknown"
OS_VERSION="unknown"
PKG_MANAGER=""

usage() {
  cat <<'EOF'
Usage:
  sudo bash deploy/scripts/bootstrap-server.sh [options]

Options:
  --repo-url URL
  --repo-branch NAME
  --repo-dir PATH
  --mode MODE                 direct-http | caddy-http | caddy-https
  --public-host HOST
  --public-port PORT
  --listen-port PORT
  --ingest-token TOKEN
  --data-dir PATH
  --service-name NAME
  --app-user USER
  --app-group GROUP
  --env-file PATH
  --caddyfile PATH
  --target-node-major N       default: 22
  --force-node-install
  --skip-repo-update
  --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url) REPO_URL="${2:?}"; shift 2 ;;
    --repo-branch) REPO_BRANCH="${2:?}"; shift 2 ;;
    --repo-dir) REPO_DIR="${2:?}"; shift 2 ;;
    --mode) MODE="${2:?}"; shift 2 ;;
    --public-host) PUBLIC_HOST="${2:?}"; shift 2 ;;
    --public-port) PUBLIC_PORT="${2:?}"; shift 2 ;;
    --listen-port) LISTEN_PORT="${2:?}"; shift 2 ;;
    --ingest-token) INGEST_TOKEN="${2:?}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
    --service-name) SERVICE_NAME="${2:?}"; shift 2 ;;
    --app-user) APP_USER="${2:?}"; shift 2 ;;
    --app-group) APP_GROUP="${2:?}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --caddyfile) CADDYFILE="${2:?}"; shift 2 ;;
    --target-node-major) TARGET_NODE_MAJOR="${2:?}"; shift 2 ;;
    --force-node-install) FORCE_NODE_INSTALL="true"; shift 1 ;;
    --skip-repo-update) SKIP_REPO_UPDATE="true"; shift 1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Please run this script with sudo or as root." >&2
    exit 1
  fi
}

detect_system() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "This bootstrap script currently supports Linux servers only." >&2
    exit 1
  fi

  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    OS_NAME="${PRETTY_NAME:-${NAME:-linux}}"
    OS_VERSION="${VERSION_ID:-unknown}"
  else
    OS_NAME="linux"
    OS_VERSION="unknown"
  fi

  if command -v apt-get >/dev/null 2>&1; then
    PKG_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG_MANAGER="yum"
  elif command -v zypper >/dev/null 2>&1; then
    PKG_MANAGER="zypper"
  elif command -v pacman >/dev/null 2>&1; then
    PKG_MANAGER="pacman"
  else
    PKG_MANAGER=""
  fi
}

ensure_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd is required because the monitor server is deployed as a background service." >&2
    exit 1
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

install_packages() {
  local packages=("$@")
  if [[ "${#packages[@]}" -eq 0 ]]; then
    return
  fi

  case "${PKG_MANAGER}" in
    apt)
      apt-get update -y
      DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
      ;;
    dnf)
      dnf install -y "${packages[@]}"
      ;;
    yum)
      yum install -y "${packages[@]}"
      ;;
    zypper)
      zypper --non-interactive install "${packages[@]}"
      ;;
    pacman)
      pacman -Sy --noconfirm "${packages[@]}"
      ;;
    *)
      echo "Unable to install missing packages automatically because no supported package manager was detected." >&2
      echo "Please install these commands manually: ${packages[*]}" >&2
      exit 1
      ;;
  esac
}

ensure_bootstrap_dependencies() {
  local missing=()

  command_exists git || missing+=("git")
  command_exists curl || missing+=("curl")
  command_exists tar || missing+=("tar")
  command_exists xz || missing+=("xz")
  command_exists sha256sum || missing+=("sha256sum")

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return
  fi

  case "${PKG_MANAGER}" in
    apt)
      install_packages git curl tar xz-utils ca-certificates coreutils
      ;;
    dnf)
      install_packages git curl tar xz ca-certificates coreutils
      ;;
    yum)
      install_packages git curl tar xz ca-certificates coreutils
      ;;
    zypper)
      install_packages git curl tar xz ca-certificates coreutils
      ;;
    pacman)
      install_packages git curl tar xz ca-certificates coreutils
      ;;
    *)
      echo "Missing required commands: ${missing[*]}" >&2
      exit 1
      ;;
  esac
}

ensure_repo() {
  if [[ -d "${REPO_DIR}/.git" ]]; then
    if [[ "${SKIP_REPO_UPDATE}" == "true" ]]; then
      return
    fi

    git -C "${REPO_DIR}" fetch origin "${REPO_BRANCH}"
    git -C "${REPO_DIR}" checkout "${REPO_BRANCH}"
    git -C "${REPO_DIR}" pull --ff-only origin "${REPO_BRANCH}"
    return
  fi

  if [[ -e "${REPO_DIR}" && ! -d "${REPO_DIR}" ]]; then
    echo "Target repo path exists but is not a directory: ${REPO_DIR}" >&2
    exit 1
  fi

  if [[ -d "${REPO_DIR}" ]] && [[ -n "$(find "${REPO_DIR}" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
    echo "Target repo directory is not empty and is not a git repository: ${REPO_DIR}" >&2
    exit 1
  fi

  mkdir -p "$(dirname "${REPO_DIR}")"
  git clone --branch "${REPO_BRANCH}" "${REPO_URL}" "${REPO_DIR}"
}

node_major() {
  local binary="$1"
  "${binary}" -p "Number(process.versions.node.split('.')[0])"
}

resolve_local_runtime_node() {
  local candidate="${REPO_DIR}/.runtime/node/current/bin/node"
  if [[ -x "${candidate}" ]]; then
    printf '%s' "${candidate}"
  fi
}

map_node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf '%s' "x64" ;;
    aarch64|arm64) printf '%s' "arm64" ;;
    armv7l) printf '%s' "armv7l" ;;
    *)
      echo "Unsupported CPU architecture for automatic Node installation: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

install_node_runtime() {
  local install_root="${REPO_DIR}/.runtime/node"
  local node_arch
  local base_url
  local shasums
  local tarball
  local version_dir
  local tmp_dir

  node_arch="$(map_node_arch)"
  base_url="https://nodejs.org/dist/latest-v${TARGET_NODE_MAJOR}.x"
  shasums="$(curl -fsSL "${base_url}/SHASUMS256.txt")"
  tarball="$(printf '%s\n' "${shasums}" | awk -v suffix="linux-${node_arch}.tar.xz" '$2 ~ suffix"$" { print $2; exit }')"

  if [[ -z "${tarball}" ]]; then
    echo "Unable to find a Node ${TARGET_NODE_MAJOR} runtime for linux-${node_arch}." >&2
    exit 1
  fi

  version_dir="${tarball%.tar.xz}"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' RETURN

  curl -fsSL "${base_url}/${tarball}" -o "${tmp_dir}/${tarball}"
  printf '%s\n' "${shasums}" | grep " ${tarball}\$" | sha256sum -c -

  mkdir -p "${install_root}"
  rm -rf "${install_root:?}/${version_dir}"
  tar -xJf "${tmp_dir}/${tarball}" -C "${install_root}"
  ln -sfn "${install_root}/${version_dir}" "${install_root}/current"
  chmod -R a+rX "${install_root}"

  NODE_BIN="${install_root}/current/bin/node"
}

ensure_node_runtime() {
  local candidate=""

  if [[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]]; then
    local configured_major
    configured_major="$(node_major "${NODE_BIN}")"
    if [[ "${configured_major}" -ge "${TARGET_NODE_MAJOR}" ]]; then
      return
    fi
  fi

  if [[ "${FORCE_NODE_INSTALL}" != "true" ]] && command_exists node; then
    candidate="$(command -v node)"
    if [[ "$(node_major "${candidate}")" -ge "${TARGET_NODE_MAJOR}" ]]; then
      NODE_BIN="${candidate}"
      return
    fi
  fi

  if [[ "${FORCE_NODE_INSTALL}" != "true" ]]; then
    candidate="$(resolve_local_runtime_node || true)"
    if [[ -n "${candidate}" ]] && [[ "$(node_major "${candidate}")" -ge "${TARGET_NODE_MAJOR}" ]]; then
      NODE_BIN="${candidate}"
      return
    fi
  fi

  install_node_runtime
}

run_server_install() {
  local installer="${REPO_DIR}/deploy/scripts/install-server.sh"
  if [[ ! -f "${installer}" ]]; then
    echo "Cannot find install-server.sh in ${REPO_DIR}" >&2
    exit 1
  fi

  local args=(
    --repo-dir "${REPO_DIR}"
    --mode "${MODE}"
    --data-dir "${DATA_DIR}"
    --service-name "${SERVICE_NAME}"
    --app-user "${APP_USER}"
    --app-group "${APP_GROUP}"
    --env-file "${ENV_FILE}"
    --node-bin "${NODE_BIN}"
    --caddyfile "${CADDYFILE}"
  )

  if [[ -n "${PUBLIC_HOST}" ]]; then
    args+=(--public-host "${PUBLIC_HOST}")
  fi
  if [[ -n "${PUBLIC_PORT}" ]]; then
    args+=(--public-port "${PUBLIC_PORT}")
  fi
  if [[ -n "${LISTEN_PORT}" ]]; then
    args+=(--listen-port "${LISTEN_PORT}")
  fi
  if [[ -n "${INGEST_TOKEN}" ]]; then
    args+=(--ingest-token "${INGEST_TOKEN}")
  fi

  bash "${installer}" "${args[@]}"
}

print_summary() {
  echo
  echo "Bootstrap complete."
  echo "Detected system: ${OS_NAME} (${OS_VERSION})"
  echo "Repo directory: ${REPO_DIR}"
  echo "Node binary: ${NODE_BIN}"
  echo "Node version: $(${NODE_BIN} -p "process.versions.node")"
  echo "Service name: ${SERVICE_NAME}"
}

require_root
detect_system
ensure_systemd
ensure_bootstrap_dependencies
ensure_repo
ensure_node_runtime
run_server_install
print_summary
