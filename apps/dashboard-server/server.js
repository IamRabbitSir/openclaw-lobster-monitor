import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const repoRoot = path.resolve(__dirname, "..", "..");
const pluginRootDir = path.join(repoRoot, "plugins", "openclaw-lobster-monitor");
const deployScriptsDir = path.join(repoRoot, "deploy", "scripts");
const defaultDataDir = path.join(__dirname, "data");
const repoCloneUrl = "https://github.com/GreenhandTan/openclaw-lobster-monitor.git";
const bootstrapScriptUrl = "https://raw.githubusercontent.com/GreenhandTan/openclaw-lobster-monitor/main/deploy/scripts/bootstrap-server.sh";
const defaultRepoDir = "/opt/openclaw-lobster-monitor";
const setupPluginFiles = new Map([
  ["package.json", path.join(pluginRootDir, "package.json")],
  ["openclaw.plugin.json", path.join(pluginRootDir, "openclaw.plugin.json")],
  ["index.js", path.join(pluginRootDir, "index.js")],
  ["lib/collector.js", path.join(pluginRootDir, "lib", "collector.js")],
]);
const resolvedDataDir = path.resolve(process.env.DATA_DIR || defaultDataDir);
const ingestTokenState = resolveIngestToken(process.env.INGEST_TOKEN, resolvedDataDir);

const env = {
  host: process.env.HOST || "0.0.0.0",
  port: clampNumber(process.env.PORT, 80, 1, 65535),
  dataDir: resolvedDataDir,
  ingestToken: ingestTokenState.value,
  ingestTokenSource: ingestTokenState.source,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  sourceTtlMs: clampNumber(process.env.SOURCE_TTL_MS, 30000, 5000, 300000),
  maxBodyBytes: clampNumber(process.env.MAX_BODY_BYTES, 1024 * 1024, 1024, 5 * 1024 * 1024),
};
const dataFile = path.join(env.dataDir, "snapshot-store.json");

const state = loadState();
const sseClients = new Set();

normalizeState(state);

const pruneTimer = setInterval(() => {
  pruneStaleSources();
  broadcastSnapshot("heartbeat");
}, 10000);
pruneTimer.unref?.();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        now: new Date().toISOString(),
        sourceCount: Object.keys(state.sources).length,
      });
    }

    if (req.method === "GET" && pathname === "/api/snapshot") {
      return sendJson(res, 200, buildAggregateSnapshot());
    }

    if (req.method === "GET" && pathname === "/api/setup/state") {
      return sendJson(res, 200, buildSetupState(req));
    }

    if (req.method === "GET" && pathname === "/api/events") {
      return handleSse(req, res);
    }

    if (req.method === "POST" && pathname === "/api/ingest") {
      return handleIngest(req, res);
    }

    if (req.method === "GET" && pathname === "/api/setup/install/server.sh") {
      return sendRepoFile(res, path.join(deployScriptsDir, "install-server.sh"));
    }

    if (req.method === "GET" && pathname === "/api/setup/install/bootstrap.sh") {
      return sendRepoFile(res, path.join(deployScriptsDir, "bootstrap-server.sh"));
    }

    if (req.method === "GET" && pathname === "/api/setup/install/openclaw.sh") {
      return sendRepoFile(res, path.join(deployScriptsDir, "install-openclaw-plugin.sh"));
    }

    if (req.method === "GET" && pathname === "/api/setup/install/openclaw.ps1") {
      return sendRepoFile(res, path.join(deployScriptsDir, "install-openclaw-plugin.ps1"));
    }

    if (req.method === "GET" && pathname.startsWith("/api/setup/plugin/")) {
      return serveSetupPlugin(pathname, res);
    }

    if (req.method === "GET") {
      return serveStatic(pathname, res);
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, {
      error: "Internal server error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(env.port, env.host, () => {
  console.log(`OpenClaw Lobster Monitor listening on http://${env.host}:${env.port}`);
  console.log(`Ingest token ready (${env.ingestTokenSource})`);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function normalizeState(currentState) {
  if (!currentState.sources || typeof currentState.sources !== "object") {
    currentState.sources = {};
  }
  if (!currentState.createdAt) {
    currentState.createdAt = new Date().toISOString();
  }
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function resolveIngestToken(configuredToken, dataDir) {
  const directToken = `${configuredToken || ""}`.trim();
  if (directToken) {
    return {
      value: directToken,
      source: "configured",
    };
  }

  const tokenFile = path.join(dataDir, "ingest-token.txt");

  try {
    if (fs.existsSync(tokenFile)) {
      const storedToken = fs.readFileSync(tokenFile, "utf8").trim();
      if (storedToken) {
        return {
          value: storedToken,
          source: "persisted",
        };
      }
    }
  } catch {
    // Fall through to generate a replacement token.
  }

  const generatedToken = crypto.randomBytes(24).toString("hex");

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, `${generatedToken}\n`, { encoding: "utf8", mode: 0o600 });
    return {
      value: generatedToken,
      source: "generated",
    };
  } catch {
    return {
      value: generatedToken,
      source: "generated-ephemeral",
    };
  }
}

function loadState() {
  try {
    if (!fs.existsSync(dataFile)) {
      return { createdAt: new Date().toISOString(), sources: {} };
    }
    const raw = fs.readFileSync(dataFile, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : { createdAt: new Date().toISOString(), sources: {} };
  } catch {
    return { createdAt: new Date().toISOString(), sources: {} };
  }
}

function persistState() {
  fs.mkdirSync(env.dataDir, { recursive: true });
  const tmpFile = `${dataFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpFile, dataFile);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  let resolved = path.join(publicDir, cleanPath);

  if (!path.extname(cleanPath) && (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory())) {
    resolved = path.join(publicDir, `${cleanPath}.html`);
  }

  if (!resolved.startsWith(publicDir) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    return sendJson(res, 404, { error: "Not found" });
  }

  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    "Content-Type": mimeType(resolved),
    "Cache-Control": cleanPath === "/index.html" ? "no-cache" : "public, max-age=300",
    "Content-Length": body.length,
  });
  res.end(body);
}

function mimeType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }
  if (filePath.endsWith(".sh")) {
    return "text/x-shellscript; charset=utf-8";
  }
  if (filePath.endsWith(".ps1")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function sendRepoFile(res, absolutePath) {
  if (!absolutePath.startsWith(repoRoot) || !fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) {
    return sendJson(res, 404, { error: "Not found" });
  }

  const body = fs.readFileSync(absolutePath);
  res.writeHead(200, {
    "Content-Type": mimeType(absolutePath),
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  res.end(body);
}

function serveSetupPlugin(pathname, res) {
  const relativePath = decodeURIComponent(pathname.replace("/api/setup/plugin/", "")).replace(/^\/+/, "");
  const absolutePath = setupPluginFiles.get(relativePath);

  if (!absolutePath) {
    return sendJson(res, 404, { error: "Plugin file not found" });
  }

  return sendRepoFile(res, absolutePath);
}

function buildSetupState(req) {
  return {
    ok: true,
    ingestToken: env.ingestToken,
    ingestTokenSource: env.ingestTokenSource,
    publicBaseUrl: inferPublicBaseUrl(req),
    defaultRepoDir,
    repoCloneUrl,
    bootstrapScriptUrl,
    modes: ["direct-http", "caddy-https"],
  };
}

async function handleIngest(req, res) {
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  const body = await readJsonBody(req, env.maxBodyBytes);
  const snapshot = sanitizeIncomingSnapshot(body);

  state.sources[snapshot.sourceId] = snapshot;

  persistState();
  broadcastSnapshot("snapshot");

  return sendJson(res, 202, {
    ok: true,
    sourceId: snapshot.sourceId,
    receivedAt: snapshot.receivedAt,
  });
}

function isAuthorized(req) {
  const authHeader = req.headers.authorization || "";
  const headerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const fallbackToken = `${req.headers["x-ingest-token"] || ""}`.trim();
  const token = headerToken || fallbackToken;
  return token.length > 0 && token === env.ingestToken;
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Payload too large. Limit: ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`));
      }
    });

    req.on("error", reject);
  });
}

function sanitizeIncomingSnapshot(body) {
  const safeBody = body && typeof body === "object" ? body : {};
  const sourceId = slugify(safeBody.sourceId || safeBody.host || safeBody.gateway?.id || "openclaw-source");
  const agents = Array.isArray(safeBody.agents)
    ? safeBody.agents.slice(0, 48).map((agent, index) => sanitizeAgent(agent, index))
    : [];
  const tokenTotals = sanitizeTokens(safeBody.tokenTotals || safeBody.tokens);
  const derivedTotals = sumTokenBlocks(agents.map((agent) => agent.tokens));
  const receivedAt = new Date().toISOString();

  return {
    sourceId,
    sourceLabel: sanitizeText(safeBody.sourceLabel || sourceId, 48),
    sourceMode: oneOf(safeBody.sourceMode, ["live", "fallback"], "live"),
    collectedAt: toIsoString(safeBody.collectedAt, receivedAt),
    receivedAt,
    gateway: {
      status: sanitizeGatewayStatus(safeBody.gateway?.status || "running"),
      version: sanitizeText(safeBody.gateway?.version, 48),
      mode: sanitizeText(safeBody.gateway?.mode, 32),
      note: sanitizeText(safeBody.gateway?.note, 160),
    },
    diagnostics: sanitizeStringArray(safeBody.diagnostics, 10, 180),
    tokenTotals: tokenTotals.total > 0 ? tokenTotals : derivedTotals,
    meta: {
      publicBaseUrl: sanitizeText(env.publicBaseUrl, 160),
      tags: sanitizeStringArray(safeBody.meta?.tags, 6, 40),
    },
    agents,
  };
}

function sanitizeAgent(agent, index) {
  const safeAgent = agent && typeof agent === "object" ? agent : {};
  const id = slugify(safeAgent.id || safeAgent.agentId || `agent-${index + 1}`);
  const tokens = sanitizeTokens(safeAgent.tokens || safeAgent.usage);

  return {
    id,
    name: sanitizeText(safeAgent.name || safeAgent.label || id, 48),
    status: normalizeAgentStatus(safeAgent.status),
    runtime: sanitizeText(safeAgent.runtime, 40),
    workspace: sanitizeText(safeAgent.workspace, 120),
    note: sanitizeText(safeAgent.note || safeAgent.activity || safeAgent.summary, 160),
    bindings: sanitizeStringArray(safeAgent.bindings, 8, 80),
    tokens,
    lastSeenAt: toIsoString(safeAgent.lastSeenAt, null),
  };
}

function sanitizeTokens(raw) {
  const safeRaw = raw && typeof raw === "object" ? raw : {};
  const prompt = numericValue(
    safeRaw.prompt ??
      safeRaw.input ??
      safeRaw.inputTokens ??
      safeRaw.promptTokens ??
      safeRaw.tokensIn,
  );
  const completion = numericValue(
    safeRaw.completion ??
      safeRaw.output ??
      safeRaw.outputTokens ??
      safeRaw.completionTokens ??
      safeRaw.tokensOut,
  );
  const total = numericValue(
    safeRaw.total ??
      safeRaw.totalTokens ??
      safeRaw.tokens ??
      prompt + completion,
  );

  return {
    prompt,
    completion,
    total: total > 0 ? total : prompt + completion,
  };
}

function numericValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function sanitizeText(value, maxLength = 120) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeStringArray(value, maxItems, itemMaxLength) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, maxItems)
    .map((item) => sanitizeText(String(item), itemMaxLength))
    .filter(Boolean);
}

function slugify(value) {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "openclaw-source";
}

function toIsoString(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function sanitizeGatewayStatus(value) {
  return sanitizeText(String(value || "running"), 20).toLowerCase() || "running";
}

function normalizeAgentStatus(value) {
  const normalized = sanitizeText(String(value || "idle"), 20).toLowerCase();
  if (["running", "busy", "active", "processing", "working"].includes(normalized)) {
    return "running";
  }
  if (["waiting", "queued", "pending", "paused"].includes(normalized)) {
    return "waiting";
  }
  if (["error", "failed", "crashed", "degraded"].includes(normalized)) {
    return "error";
  }
  if (["offline", "stopped", "disconnected"].includes(normalized)) {
    return "offline";
  }
  return "idle";
}

function sumTokenBlocks(blocks) {
  return blocks.reduce(
    (accumulator, current) => {
      accumulator.prompt += current.prompt || 0;
      accumulator.completion += current.completion || 0;
      accumulator.total += current.total || 0;
      return accumulator;
    },
    { prompt: 0, completion: 0, total: 0 },
  );
}

function buildAggregateSnapshot() {
  const now = Date.now();
  const sources = Object.values(state.sources)
    .map((source) => decorateSource(source, now))
    .sort((left, right) => left.sourceLabel.localeCompare(right.sourceLabel));
  const agents = sources.flatMap((source) =>
    source.agents.map((agent) => ({
      ...agent,
      sourceId: source.sourceId,
      sourceLabel: source.sourceLabel,
      gatewayStatus: source.gateway.status,
      sourceMode: source.sourceMode,
      stale: source.stale,
    })),
  );

  const summary = {
    sourceCount: sources.length,
    freshSourceCount: sources.filter((source) => !source.stale).length,
    agentCount: agents.length,
    runningCount: agents.filter((agent) => agent.status === "running").length,
    idleCount: agents.filter((agent) => agent.status === "idle").length,
    waitingCount: agents.filter((agent) => agent.status === "waiting").length,
    errorCount: agents.filter((agent) => agent.status === "error").length,
    offlineCount: agents.filter((agent) => agent.status === "offline").length,
    tokenTotals: sumTokenBlocks(sources.map((source) => source.tokenTotals || { prompt: 0, completion: 0, total: 0 })),
  };

  return {
    updatedAt: new Date().toISOString(),
    summary,
    sources,
    agents,
  };
}

function inferPublicBaseUrl(req) {
  if (env.publicBaseUrl) {
    return env.publicBaseUrl;
  }

  const forwardedProto = `${req.headers["x-forwarded-proto"] || ""}`.split(",")[0].trim();
  const forwardedHost = `${req.headers["x-forwarded-host"] || ""}`.split(",")[0].trim();
  const requestHost = forwardedHost || `${req.headers.host || ""}`.trim() || `127.0.0.1:${env.port}`;
  const requestProto = forwardedProto || (env.port === 443 ? "https" : "http");

  return `${requestProto}://${requestHost}`;
}

function decorateSource(source, now) {
  const lastSeen = new Date(source.receivedAt || source.collectedAt || 0).getTime();
  const ageMs = Number.isFinite(lastSeen) ? Math.max(0, now - lastSeen) : env.sourceTtlMs + 1;
  const stale = ageMs > env.sourceTtlMs;
  const agents = Array.isArray(source.agents) ? source.agents : [];
  const decoratedAgents = agents.map((agent) => {
    if (!stale) {
      return agent;
    }
    return {
      ...agent,
      status: agent.status === "error" ? "error" : "offline",
    };
  });

  return {
    ...source,
    stale,
    ageMs,
    gateway: {
      ...source.gateway,
      status: stale ? "stale" : source.gateway?.status || "running",
    },
    tokenTotals: source.tokenTotals?.total > 0 ? source.tokenTotals : sumTokenBlocks(decoratedAgents.map((agent) => agent.tokens)),
    agents: decoratedAgents,
  };
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write("retry: 4000\n");
  writeSseEvent(res, "snapshot", buildAggregateSnapshot());

  const client = { res };
  sseClients.add(client);

  req.on("close", () => {
    sseClients.delete(client);
  });
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastSnapshot(eventName) {
  const payload = buildAggregateSnapshot();
  for (const client of sseClients) {
    try {
      writeSseEvent(client.res, eventName, payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function pruneStaleSources() {
  const now = Date.now();
  let changed = false;

  for (const [sourceId, source] of Object.entries(state.sources)) {
    const lastSeen = new Date(source.receivedAt || source.collectedAt || 0).getTime();
    if (!Number.isFinite(lastSeen) || now - lastSeen > env.sourceTtlMs * 24) {
      delete state.sources[sourceId];
      changed = true;
    }
  }

  if (changed) {
    persistState();
  }
}

function shutdown(signal) {
  clearInterval(pruneTimer);
  persistState();

  for (const client of sseClients) {
    try {
      client.res.end();
    } catch {
      // Ignore connection shutdown errors.
    }
  }
  sseClients.clear();

  server.close(() => {
    console.log(`OpenClaw Lobster Monitor stopped on ${signal}`);
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 3000).unref?.();
}
