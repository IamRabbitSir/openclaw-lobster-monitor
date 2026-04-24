#!/usr/bin/env bash
set -euo pipefail

MONITOR_URL="${MONITOR_URL:-}"
INGEST_TOKEN="${INGEST_TOKEN:-}"
SOURCE_ID="${SOURCE_ID:-}"
SOURCE_LABEL="${SOURCE_LABEL:-}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-}"
PLUGIN_INSTALL_DIR="${PLUGIN_INSTALL_DIR:-}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-15000}"
EVENT_DEBOUNCE_MS="${EVENT_DEBOUNCE_MS:-150}"
REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-4000}"
CLI_TIMEOUT_MS="${CLI_TIMEOUT_MS:-2500}"
ENABLE_CLI="${ENABLE_CLI:-true}"
RESTART_OPENCLAW_COMMAND="${RESTART_OPENCLAW_COMMAND:-}"

usage() {
  cat <<'EOF'
Usage:
  MONITOR_URL=http://SERVER INGEST_TOKEN=token SOURCE_ID=node-1 SOURCE_LABEL="Node 1" bash install-openclaw-plugin.sh

Optional environment variables:
  OPENCLAW_CONFIG_PATH
  PLUGIN_INSTALL_DIR
  POLL_INTERVAL_MS
  EVENT_DEBOUNCE_MS
  REQUEST_TIMEOUT_MS
  CLI_TIMEOUT_MS
  ENABLE_CLI
  RESTART_OPENCLAW_COMMAND
EOF
}

download() {
  local url="$1"
  local destination="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$destination"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
    return
  fi

  echo "curl or wget is required to download plugin files." >&2
  exit 1
}

resolve_config_path() {
  if [[ -n "${OPENCLAW_CONFIG_PATH}" ]]; then
    printf '%s' "$(expand_user_path "${OPENCLAW_CONFIG_PATH}")"
    return
  fi

  if command -v openclaw >/dev/null 2>&1; then
    local cli_path
    cli_path="$(openclaw config file 2>/dev/null || true)"
    if [[ -n "${cli_path}" ]]; then
      printf '%s' "${cli_path}"
      return
    fi
  fi

  if [[ -f "${HOME}/.openclaw/openclaw.json" ]]; then
    printf '%s' "${HOME}/.openclaw/openclaw.json"
    return
  fi

  if [[ -f "${HOME}/.config/openclaw/openclaw.json" ]]; then
    printf '%s' "${HOME}/.config/openclaw/openclaw.json"
    return
  fi

  printf '%s' "${HOME}/.openclaw/openclaw.json"
}

expand_user_path() {
  local value="$1"
  value="${value/#\~/$HOME}"
  value="${value//\$HOME/$HOME}"
  printf '%s' "${value}"
}

apply_patch_with_node() {
  node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const configPath = process.env.OPENCLAW_CONFIG_PATH;
const pluginInstallDir = process.env.PLUGIN_INSTALL_DIR;
const serverUrl = process.env.MONITOR_URL;
const ingestToken = process.env.INGEST_TOKEN;
const sourceId = process.env.SOURCE_ID;
const sourceLabel = process.env.SOURCE_LABEL || sourceId;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || "15000");
const eventDebounceMs = Number(process.env.EVENT_DEBOUNCE_MS || "150");
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || "4000");
const cliTimeoutMs = Number(process.env.CLI_TIMEOUT_MS || "2500");
const enableCli = `${process.env.ENABLE_CLI || "true"}`.toLowerCase() !== "false";

let root = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, "utf8").trim();
  if (raw) {
    root = JSON.parse(raw);
  }
}

if (!root || typeof root !== "object" || Array.isArray(root)) {
  root = {};
}

root.plugins ??= {};
root.plugins.load ??= {};
root.plugins.load.paths = Array.isArray(root.plugins.load.paths) ? root.plugins.load.paths : [];
if (!root.plugins.load.paths.includes(pluginInstallDir)) {
  root.plugins.load.paths.push(pluginInstallDir);
}

root.plugins.entries ??= {};
root.plugins.entries["openclaw-lobster-monitor"] = {
  enabled: true,
  config: {
    serverUrl,
    ingestToken,
    sourceId,
    sourceLabel,
    pollIntervalMs,
    eventDebounceMs,
    requestTimeoutMs,
    cliTimeoutMs,
    enableCli,
  },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
EOF
}

apply_patch_with_python() {
  python3 <<'EOF'
import json
import os
from pathlib import Path

config_path = Path(os.environ["OPENCLAW_CONFIG_PATH"])
plugin_install_dir = os.environ["PLUGIN_INSTALL_DIR"]
server_url = os.environ["MONITOR_URL"]
ingest_token = os.environ["INGEST_TOKEN"]
source_id = os.environ["SOURCE_ID"]
source_label = os.environ.get("SOURCE_LABEL") or source_id
poll_interval_ms = int(os.environ.get("POLL_INTERVAL_MS", "15000"))
event_debounce_ms = int(os.environ.get("EVENT_DEBOUNCE_MS", "150"))
request_timeout_ms = int(os.environ.get("REQUEST_TIMEOUT_MS", "4000"))
cli_timeout_ms = int(os.environ.get("CLI_TIMEOUT_MS", "2500"))
enable_cli = os.environ.get("ENABLE_CLI", "true").lower() != "false"

data = {}
if config_path.exists():
    raw = config_path.read_text(encoding="utf-8").strip()
    if raw:
        data = json.loads(raw)

if not isinstance(data, dict):
    data = {}

plugins = data.setdefault("plugins", {})
load = plugins.setdefault("load", {})
paths = load.setdefault("paths", [])
if plugin_install_dir not in paths:
    paths.append(plugin_install_dir)

entries = plugins.setdefault("entries", {})
entries["openclaw-lobster-monitor"] = {
    "enabled": True,
    "config": {
        "serverUrl": server_url,
        "ingestToken": ingest_token,
        "sourceId": source_id,
        "sourceLabel": source_label,
        "pollIntervalMs": poll_interval_ms,
        "eventDebounceMs": event_debounce_ms,
        "requestTimeoutMs": request_timeout_ms,
        "cliTimeoutMs": cli_timeout_ms,
        "enableCli": enable_cli,
    },
}

config_path.parent.mkdir(parents=True, exist_ok=True)
config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
EOF
}

if [[ -z "${MONITOR_URL}" || -z "${INGEST_TOKEN}" || -z "${SOURCE_ID}" ]]; then
  usage >&2
  exit 1
fi

MONITOR_URL="${MONITOR_URL%/}"
OPENCLAW_CONFIG_PATH="$(resolve_config_path)"

if [[ -z "${SOURCE_LABEL}" ]]; then
  SOURCE_LABEL="${SOURCE_ID}"
fi

if [[ -z "${PLUGIN_INSTALL_DIR}" ]]; then
  PLUGIN_INSTALL_DIR="$(dirname "${OPENCLAW_CONFIG_PATH}")/plugins/openclaw-lobster-monitor"
else
  PLUGIN_INSTALL_DIR="$(expand_user_path "${PLUGIN_INSTALL_DIR}")"
fi

mkdir -p "${PLUGIN_INSTALL_DIR}/lib"

download "${MONITOR_URL}/api/setup/plugin/package.json" "${PLUGIN_INSTALL_DIR}/package.json"
download "${MONITOR_URL}/api/setup/plugin/openclaw.plugin.json" "${PLUGIN_INSTALL_DIR}/openclaw.plugin.json"
download "${MONITOR_URL}/api/setup/plugin/index.js" "${PLUGIN_INSTALL_DIR}/index.js"
download "${MONITOR_URL}/api/setup/plugin/lib/collector.js" "${PLUGIN_INSTALL_DIR}/lib/collector.js"

if [[ -f "${OPENCLAW_CONFIG_PATH}" ]]; then
  cp "${OPENCLAW_CONFIG_PATH}" "${OPENCLAW_CONFIG_PATH}.bak.$(date +%Y%m%d%H%M%S)"
fi

export OPENCLAW_CONFIG_PATH PLUGIN_INSTALL_DIR MONITOR_URL INGEST_TOKEN SOURCE_ID SOURCE_LABEL
export POLL_INTERVAL_MS EVENT_DEBOUNCE_MS REQUEST_TIMEOUT_MS CLI_TIMEOUT_MS ENABLE_CLI

if command -v node >/dev/null 2>&1; then
  apply_patch_with_node
elif command -v python3 >/dev/null 2>&1; then
  apply_patch_with_python
else
  echo "Node.js or python3 is required to patch openclaw.json automatically." >&2
  exit 1
fi

if command -v openclaw >/dev/null 2>&1; then
  openclaw plugins install "${PLUGIN_INSTALL_DIR}" >/dev/null 2>&1 || true
fi

if [[ -n "${RESTART_OPENCLAW_COMMAND}" ]]; then
  sh -lc "${RESTART_OPENCLAW_COMMAND}"
fi

echo
echo "OpenClaw lobster monitor plugin installed."
echo "Plugin directory: ${PLUGIN_INSTALL_DIR}"
echo "OpenClaw config: ${OPENCLAW_CONFIG_PATH}"
echo "Source ID: ${SOURCE_ID}"
echo "Server URL: ${MONITOR_URL}"
echo "Restart OpenClaw Gateway if it is not already auto-reloading plugins."
