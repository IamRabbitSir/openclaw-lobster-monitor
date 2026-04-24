const fields = {
  deployMode: document.getElementById("deploy-mode"),
  publicHost: document.getElementById("public-host"),
  publicPort: document.getElementById("public-port"),
  listenPort: document.getElementById("listen-port"),
  repoDir: document.getElementById("repo-dir"),
  ingestToken: document.getElementById("ingest-token"),
  sourceId: document.getElementById("source-id"),
  sourceLabel: document.getElementById("source-label"),
  openclawConfig: document.getElementById("openclaw-config"),
  accessPreview: document.getElementById("access-preview"),
  serverEnvPreview: document.getElementById("server-env-preview"),
  serverCommand: document.getElementById("server-command"),
  linuxClientCommand: document.getElementById("linux-client-command"),
  windowsClientCommand: document.getElementById("windows-client-command"),
  configSnippet: document.getElementById("config-snippet"),
  tokenOriginBadge: document.getElementById("token-origin-badge"),
  tokenOriginText: document.getElementById("token-origin-text"),
};

const runtimeState = {
  repoCloneUrl: "https://github.com/GreenhandTan/openclaw-lobster-monitor.git",
  bootstrapScriptUrl: "https://raw.githubusercontent.com/GreenhandTan/openclaw-lobster-monitor/main/deploy/scripts/bootstrap-server.sh",
  defaultRepoDir: "/opt/openclaw-lobster-monitor",
  ingestToken: "",
  tokenOrigin: "loading",
};

bindFieldEvents();
bindCopyButtons();

init();

async function init() {
  prefillDefaults();
  await hydrateSetupState();
  render();
}

function bindFieldEvents() {
  for (const field of Object.values(fields)) {
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
      field.addEventListener("input", render);
      field.addEventListener("change", render);
    }
  }
}

function bindCopyButtons() {
  for (const button of document.querySelectorAll("[data-copy-target]")) {
    button.addEventListener("click", async () => {
      const targetId = button.getAttribute("data-copy-target");
      const target = document.getElementById(targetId);
      const originalLabel = button.textContent;

      try {
        await copyFieldValue(target);
        button.textContent = "已复制";
      } catch {
        button.textContent = "复制失败";
      }

      setTimeout(() => {
        button.textContent = originalLabel;
      }, 1600);
    });
  }
}

async function hydrateSetupState() {
  try {
    const response = await fetch("/api/setup/state", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Setup state request failed with ${response.status}`);
    }

    const payload = await response.json();
    runtimeState.repoCloneUrl = sanitize(payload.repoCloneUrl || runtimeState.repoCloneUrl);
    runtimeState.bootstrapScriptUrl = sanitize(payload.bootstrapScriptUrl || runtimeState.bootstrapScriptUrl);
    runtimeState.defaultRepoDir = sanitize(payload.defaultRepoDir || runtimeState.defaultRepoDir);
    runtimeState.ingestToken = sanitize(payload.ingestToken || generateBrowserToken());
    runtimeState.tokenOrigin = sanitize(payload.ingestTokenSource || "generated");
  } catch (error) {
    console.warn(error);
    runtimeState.ingestToken = generateBrowserToken();
    runtimeState.tokenOrigin = "browser-generated";
  }

  if (!fields.repoDir.value) {
    fields.repoDir.value = runtimeState.defaultRepoDir;
  }

  fields.ingestToken.value = runtimeState.ingestToken;
  updateTokenOriginMeta();
}

function prefillDefaults() {
  const host = window.location.hostname || "127.0.0.1";
  const protocol = window.location.protocol === "https:" ? "https" : "http";
  const port = window.location.port || (protocol === "https" ? "443" : "80");

  if (!fields.publicHost.value) {
    fields.publicHost.value = host;
  }

  if (!fields.repoDir.value) {
    fields.repoDir.value = runtimeState.defaultRepoDir;
  }

  if (protocol === "https") {
    fields.deployMode.value = "caddy-https";
    fields.publicPort.value = "443";
    fields.listenPort.value = "8787";
  } else {
    fields.deployMode.value = "direct-http";
    fields.publicPort.value = port;
    fields.listenPort.value = port;
  }
}

function render() {
  const mode = fields.deployMode.value;
  const publicHost = sanitize(fields.publicHost.value || "127.0.0.1");
  const listenPort = sanitize(resolveListenPort(mode, fields.listenPort.value));
  const publicPort = sanitize(resolvePublicPort(mode, fields.publicPort.value, listenPort));
  const repoDir = sanitize(fields.repoDir.value || runtimeState.defaultRepoDir);
  const ingestToken = sanitize(runtimeState.ingestToken || fields.ingestToken.value || generateBrowserToken());
  const sourceId = sanitize(fields.sourceId.value || "home-gateway");
  const sourceLabel = sanitize(fields.sourceLabel.value || sourceId);
  const openclawConfig = fields.openclawConfig.value || "$HOME/.openclaw/openclaw.json";
  const linuxConfigPath = normalizeLinuxPathForCommand(openclawConfig);
  const windowsConfigPath = normalizeWindowsPathForCommand(openclawConfig);
  const baseUrl = buildBaseUrl(mode, publicHost, publicPort);

  fields.publicPort.value = publicPort;
  fields.listenPort.value = listenPort;
  fields.repoDir.value = repoDir;
  fields.ingestToken.value = ingestToken;
  fields.publicPort.disabled = mode === "caddy-https";
  fields.listenPort.disabled = mode === "direct-http";
  fields.accessPreview.textContent = baseUrl;

  fields.serverEnvPreview.value = buildServerEnvPreview({
    mode,
    publicPort,
    listenPort,
    ingestToken,
    baseUrl,
  });

  fields.serverCommand.value = buildServerCommand({
    mode,
    publicHost,
    publicPort,
    listenPort,
    repoDir,
    ingestToken,
    baseUrl,
  });

  fields.linuxClientCommand.value = buildLinuxClientCommand({
    baseUrl,
    ingestToken,
    sourceId,
    sourceLabel,
    openclawConfig: linuxConfigPath,
  });

  fields.windowsClientCommand.value = buildWindowsClientCommand({
    baseUrl,
    ingestToken,
    sourceId,
    sourceLabel,
    openclawConfig: windowsConfigPath,
  });

  fields.configSnippet.value = JSON.stringify(
    {
      plugins: {
        load: {
          paths: ["/absolute/path/to/plugins/openclaw-lobster-monitor"],
        },
        entries: {
          "openclaw-lobster-monitor": {
            enabled: true,
            config: {
              serverUrl: baseUrl,
              ingestToken,
              sourceId,
              sourceLabel,
              pollIntervalMs: 15000,
              eventDebounceMs: 150,
              requestTimeoutMs: 4000,
              cliTimeoutMs: 2500,
              enableCli: true,
            },
          },
        },
      },
    },
    null,
    2,
  );
}

function updateTokenOriginMeta() {
  const mapping = {
    configured: {
      badge: "Configured token",
      className: "hero-pill hero-pill-live",
      description: "当前 token 来自服务端环境变量，页面直接复用它生成客户端安装命令。",
    },
    persisted: {
      badge: "Persisted token",
      className: "hero-pill hero-pill-live",
      description: "当前 token 来自服务端已持久化文件，重新部署时会自动复用，不需要手填。",
    },
    generated: {
      badge: "Generated token",
      className: "hero-pill hero-pill-safe",
      description: "当前 token 由服务端自动生成并已保存，客户端安装命令会直接带上它。",
    },
    "generated-ephemeral": {
      badge: "Temp token",
      className: "hero-pill hero-pill-error",
      description: "服务端生成了临时 token，但未能持久化，建议尽快检查数据目录权限。",
    },
    "browser-generated": {
      badge: "Browser fallback",
      className: "hero-pill hero-pill-fallback",
      description: "浏览器临时生成了 token。当前服务端部署命令会把这个 token 一并写入，避免不一致。",
    },
  };

  const meta = mapping[runtimeState.tokenOrigin] || mapping.generated;
  fields.tokenOriginBadge.textContent = meta.badge;
  fields.tokenOriginBadge.className = meta.className;
  fields.tokenOriginText.textContent = meta.description;
}

function buildBaseUrl(mode, host, port) {
  if (mode === "caddy-https") {
    return `https://${host}`;
  }

  if (port === "80") {
    return `http://${host}`;
  }

  return `http://${host}:${port}`;
}

function resolvePublicPort(mode, rawPort, listenPort) {
  if (mode === "direct-http") {
    return listenPort || "80";
  }

  if (mode === "caddy-https") {
    return "443";
  }

  return rawPort || "80";
}

function resolveListenPort(mode, rawPort) {
  if (mode === "direct-http") {
    return rawPort || "80";
  }

  return rawPort && rawPort !== "80" ? rawPort : "8787";
}

function buildServerEnvPreview({ mode, publicPort, listenPort, ingestToken, baseUrl }) {
  const host = mode === "caddy-https" ? "127.0.0.1" : "0.0.0.0";
  const port = mode === "caddy-https" ? listenPort : publicPort;

  return [
    `HOST=${host}`,
    `PORT=${port}`,
    "DATA_DIR=/var/lib/openclaw-lobster-monitor",
    `INGEST_TOKEN=${ingestToken}`,
    `PUBLIC_BASE_URL=${baseUrl}`,
    "SOURCE_TTL_MS=30000",
    "MAX_BODY_BYTES=1048576",
  ].join("\n");
}

function buildServerCommand({ mode, publicHost, publicPort, listenPort, repoDir, ingestToken, baseUrl }) {
  const args = [
    `--repo-dir ${quoteShell(repoDir)}`,
    `--mode ${quoteShell(mode)}`,
    `--public-host ${quoteShell(publicHost)}`,
    `--public-port ${quoteShell(publicPort)}`,
    `--listen-port ${quoteShell(listenPort)}`,
    "--target-node-major 22",
    `--ingest-token ${quoteShell(ingestToken)}`,
  ];

  return [
    `curl -fsSL ${quoteShell(runtimeState.bootstrapScriptUrl)} -o /tmp/openclaw-lobster-bootstrap.sh`,
    `sudo bash /tmp/openclaw-lobster-bootstrap.sh ${args.join(" ")}`,
    `# 脚本会自动检测系统、准备 Node 22、创建 systemd 常驻服务`,
    `# 部署完成后访问 ${baseUrl}/setup 继续安装 OpenClaw 客户端`,
  ].join("\n");
}

function buildLinuxClientCommand({ baseUrl, ingestToken, sourceId, sourceLabel, openclawConfig }) {
  return [
    `MONITOR_URL=${quoteShell(baseUrl)}`,
    `INGEST_TOKEN=${quoteShell(ingestToken)}`,
    `SOURCE_ID=${quoteShell(sourceId)}`,
    `SOURCE_LABEL=${quoteShell(sourceLabel)}`,
    `OPENCLAW_CONFIG_PATH=${quoteShellEnvValue(openclawConfig)}`,
    "POLL_INTERVAL_MS=15000",
    "EVENT_DEBOUNCE_MS=150",
    "REQUEST_TIMEOUT_MS=4000",
    "CLI_TIMEOUT_MS=2500",
    `bash -c "$(curl -fsSL ${baseUrl}/api/setup/install/openclaw.sh)"`,
  ].join(" ");
}

function buildWindowsClientCommand({ baseUrl, ingestToken, sourceId, sourceLabel, openclawConfig }) {
  return [
    `$env:MONITOR_URL=${quotePowerShellValue(baseUrl)}`,
    `$env:INGEST_TOKEN=${quotePowerShellValue(ingestToken)}`,
    `$env:SOURCE_ID=${quotePowerShellValue(sourceId)}`,
    `$env:SOURCE_LABEL=${quotePowerShellValue(sourceLabel)}`,
    `$env:OPENCLAW_CONFIG_PATH=${quotePowerShellEnvValue(openclawConfig)}`,
    "$env:POLL_INTERVAL_MS='15000'",
    "$env:EVENT_DEBOUNCE_MS='150'",
    "$env:REQUEST_TIMEOUT_MS='4000'",
    "$env:CLI_TIMEOUT_MS='2500'",
    `Invoke-Expression ((Invoke-WebRequest -UseBasicParsing '${baseUrl}/api/setup/install/openclaw.ps1').Content)`,
  ].join("; ");
}

async function copyFieldValue(target) {
  if (!target) {
    throw new Error("Missing copy target");
  }

  const value = "value" in target ? target.value : target.textContent || "";
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.focus();
    target.select();
    document.execCommand("copy");
    return;
  }

  const helper = document.createElement("textarea");
  helper.value = value;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.append(helper);
  helper.focus();
  helper.select();
  document.execCommand("copy");
  helper.remove();
}

function generateBrowserToken() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sanitize(value) {
  return String(value).trim();
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function quoteShellEnvValue(value) {
  const raw = String(value);
  if (raw.includes("$HOME")) {
    return `"${raw.replaceAll('"', '\\"')}"`;
  }
  return quoteShell(raw);
}

function escapePowerShell(value) {
  return String(value).replaceAll("'", "''");
}

function quotePowerShellValue(value) {
  return `'${escapePowerShell(value)}'`;
}

function quotePowerShellEnvValue(value) {
  const raw = String(value);
  if (raw.includes("$env:")) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return quotePowerShellValue(raw);
}

function normalizeLinuxPathForCommand(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "$HOME/.openclaw/openclaw.json";
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return `$HOME/${raw.slice(2).replaceAll("\\", "/")}`;
  }
  if (raw.includes("$HOME")) {
    return raw;
  }
  return raw;
}

function normalizeWindowsPathForCommand(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("$HOME") || raw.startsWith("~/") || raw.startsWith("~\\")) {
    return "$env:USERPROFILE\\.openclaw\\openclaw.json";
  }
  return raw.replaceAll("/", "\\");
}
