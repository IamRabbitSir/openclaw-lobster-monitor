#!/usr/bin/env bash
set -euo pipefail

MODE="direct-http"
REPO_DIR=""
PUBLIC_HOST=""
PUBLIC_PORT=""
LISTEN_PORT="80"
INGEST_TOKEN=""
DATA_DIR="/var/lib/openclaw-lobster-monitor"
SERVICE_NAME="openclaw-lobster-monitor"
APP_USER="openclaw-monitor"
APP_GROUP="openclaw-monitor"
ENV_FILE="/etc/openclaw-lobster-monitor/dashboard.env"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
CADDYFILE="/etc/caddy/Caddyfile"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  sudo bash deploy/scripts/install-server.sh [options]

Options:
  --repo-dir PATH
  --mode MODE              direct-http | caddy-http | caddy-https
  --public-host HOST
  --public-port PORT
  --listen-port PORT
  --ingest-token TOKEN
  --data-dir PATH
  --service-name NAME
  --app-user USER
  --app-group GROUP
  --env-file PATH
  --node-bin PATH
  --caddyfile PATH
  --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --node-bin) NODE_BIN="${2:?}"; shift 2 ;;
    --caddyfile) CADDYFILE="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

REPO_DIR="${REPO_DIR:-$DEFAULT_REPO_DIR}"

if [[ -z "${PUBLIC_HOST}" ]]; then
  PUBLIC_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
PUBLIC_HOST="${PUBLIC_HOST:-127.0.0.1}"

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
    return
  fi

  if [[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]]; then
    "${NODE_BIN}" -e "console.log(require('crypto').randomBytes(24).toString('hex'));"
    return
  fi

  tr -dc 'a-f0-9' < /dev/urandom | head -c 48
}

read_existing_token() {
  if [[ -f "${ENV_FILE}" ]]; then
    awk -F= '/^INGEST_TOKEN=/{print substr($0, index($0, "=") + 1); exit}' "${ENV_FILE}"
  fi
}

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "Node.js was not found. Please install Node.js 18+ first." >&2
  exit 1
fi

if [[ ! -f "${REPO_DIR}/apps/dashboard-server/server.js" ]]; then
  echo "Cannot find apps/dashboard-server/server.js under ${REPO_DIR}" >&2
  exit 1
fi

if [[ -z "${INGEST_TOKEN}" ]]; then
  INGEST_TOKEN="$(read_existing_token || true)"
fi

if [[ -z "${INGEST_TOKEN}" ]]; then
  INGEST_TOKEN="$(generate_token)"
fi

case "${MODE}" in
  direct-http)
    PUBLIC_PORT="${PUBLIC_PORT:-80}"
    BIND_HOST="0.0.0.0"
    LISTEN_PORT="${PUBLIC_PORT}"
    if [[ "${PUBLIC_PORT}" == "80" ]]; then
      PUBLIC_BASE_URL="http://${PUBLIC_HOST}"
    else
      PUBLIC_BASE_URL="http://${PUBLIC_HOST}:${PUBLIC_PORT}"
    fi
    ;;
  caddy-http)
    PUBLIC_PORT="${PUBLIC_PORT:-80}"
    BIND_HOST="127.0.0.1"
    if ! command -v caddy >/dev/null 2>&1; then
      echo "Caddy is required for --mode caddy-http." >&2
      exit 1
    fi
    if [[ "${PUBLIC_PORT}" == "80" ]]; then
      PUBLIC_BASE_URL="http://${PUBLIC_HOST}"
      CADDY_SITE="http://${PUBLIC_HOST}"
    else
      PUBLIC_BASE_URL="http://${PUBLIC_HOST}:${PUBLIC_PORT}"
      CADDY_SITE="http://${PUBLIC_HOST}:${PUBLIC_PORT}"
    fi
    ;;
  caddy-https)
    BIND_HOST="127.0.0.1"
    if ! command -v caddy >/dev/null 2>&1; then
      echo "Caddy is required for --mode caddy-https." >&2
      exit 1
    fi
    if [[ "${PUBLIC_HOST}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "A domain name is required for --mode caddy-https. Use direct-http for IP access." >&2
      exit 1
    fi
    PUBLIC_BASE_URL="https://${PUBLIC_HOST}"
    CADDY_SITE="${PUBLIC_HOST}"
    ;;
  *)
    echo "Unsupported mode: ${MODE}" >&2
    exit 1
    ;;
esac

install -d -m 0755 "$(dirname "${ENV_FILE}")"
install -d -m 0755 "${DATA_DIR}"
chmod -R a+rX "${REPO_DIR}"

if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${APP_GROUP}"
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home "${REPO_DIR}" --shell /usr/sbin/nologin --gid "${APP_GROUP}" "${APP_USER}"
fi

chown -R "${APP_USER}:${APP_GROUP}" "${DATA_DIR}"

cat > "${ENV_FILE}" <<EOF
HOST=${BIND_HOST}
PORT=${LISTEN_PORT}
DATA_DIR=${DATA_DIR}
INGEST_TOKEN=${INGEST_TOKEN}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
SOURCE_TTL_MS=30000
MAX_BODY_BYTES=1048576
EOF

SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "${SERVICE_PATH}" <<EOF
[Unit]
Description=OpenClaw Lobster Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${REPO_DIR}/apps/dashboard-server
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${REPO_DIR}/apps/dashboard-server/server.js
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

if [[ "${MODE}" == "caddy-http" || "${MODE}" == "caddy-https" ]]; then
  install -d -m 0755 "$(dirname "${CADDYFILE}")"
  if [[ "${MODE}" == "caddy-http" ]]; then
    cat > "${CADDYFILE}" <<EOF
${CADDY_SITE} {
  auto_https off
  encode gzip zstd
  reverse_proxy 127.0.0.1:${LISTEN_PORT}
}
EOF
  else
    cat > "${CADDYFILE}" <<EOF
${CADDY_SITE} {
  encode gzip zstd
  reverse_proxy 127.0.0.1:${LISTEN_PORT}
}
EOF
  fi
fi

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

if [[ "${MODE}" == "caddy-http" || "${MODE}" == "caddy-https" ]]; then
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy
fi

echo
echo "Deployment complete."
echo "Dashboard URL: ${PUBLIC_BASE_URL}"
echo "Health check: ${PUBLIC_BASE_URL}/api/health"
echo "Setup guide: ${PUBLIC_BASE_URL}/setup"
echo "INGEST_TOKEN: ${INGEST_TOKEN}"
echo "Token source: stored in ${ENV_FILE}"
echo "systemd status: sudo systemctl status ${SERVICE_NAME}"
echo "Logs: sudo journalctl -u ${SERVICE_NAME} -f"
