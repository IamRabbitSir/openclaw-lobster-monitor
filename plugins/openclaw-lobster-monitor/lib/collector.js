import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function collectSnapshot({ api, pluginConfig }) {
  const diagnostics = [];
  const configuredAgents = getConfiguredAgents(api.config);
  const knownAgentIds = new Set(configuredAgents.map((agent) => agent.id));

  let statusPayload = null;
  let healthPayload = null;

  if (pluginConfig.enableCli) {
    const [statusResult, healthResult] = await Promise.allSettled([
      runOpenClawJson(pluginConfig.cliPath, ["status", "--json", "--usage"], pluginConfig.cliTimeoutMs),
      runOpenClawJson(pluginConfig.cliPath, ["health", "--json"], pluginConfig.cliTimeoutMs),
    ]);

    if (statusResult.status === "fulfilled") {
      statusPayload = statusResult.value;
      diagnostics.push("Collected status via openclaw status --json --usage");
    } else {
      diagnostics.push(`status command unavailable: ${errorMessage(statusResult.reason)}`);
    }

    if (healthResult.status === "fulfilled") {
      healthPayload = healthResult.value;
      diagnostics.push("Collected health via openclaw health --json");
    } else {
      diagnostics.push(`health command unavailable: ${errorMessage(healthResult.reason)}`);
    }
  } else {
    diagnostics.push("CLI collection disabled; reporting config-derived data only.");
  }

  const mergedAgents = buildAgentSnapshots({
    configuredAgents,
    knownAgentIds,
    statusPayload,
    healthPayload,
  });

  const agentTotals = sumTokenBlocks(mergedAgents.map((agent) => agent.tokens));
  const statusTotals = extractLargestUsageBlock(statusPayload);
  const healthTotals = extractLargestUsageBlock(healthPayload);
  const tokenTotals = chooseLargestTokenBlock([agentTotals, statusTotals, healthTotals]);
  const gatewayStatus = inferGatewayStatus(statusPayload, healthPayload);
  const gatewayVersion = inferGatewayVersion(statusPayload, healthPayload);
  const gatewayMode = inferGatewayMode(api.config);
  const sourceMode = statusPayload || healthPayload ? "live" : "fallback";

  return {
    sourceId: pluginConfig.sourceId,
    sourceLabel: pluginConfig.sourceLabel,
    sourceMode,
    collectedAt: new Date().toISOString(),
    gateway: {
      status: gatewayStatus,
      version: gatewayVersion,
      mode: gatewayMode,
      note: sourceMode === "fallback"
        ? "Using config-derived agent snapshot because OpenClaw CLI data was unavailable."
        : "Using live OpenClaw CLI snapshots.",
    },
    diagnostics: diagnostics.slice(0, 8),
    meta: {
      tags: pluginConfig.tags,
    },
    tokenTotals,
    agents: mergedAgents,
  };
}

async function runOpenClawJson(configuredPath, args, timeoutMs) {
  const cliCandidates = buildCliCandidates(configuredPath);
  let lastError = null;

  for (const cliPath of cliCandidates) {
    try {
      const { stdout } = await execFileAsync(cliPath, args, {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs,
      });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to execute OpenClaw CLI.");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildCliCandidates(configuredPath) {
  if (configuredPath) {
    return [configuredPath];
  }
  if (process.platform === "win32") {
    return ["openclaw.cmd", "openclaw.exe", "openclaw"];
  }
  return ["openclaw"];
}

export function getConfiguredAgents(config) {
  const agents = Array.isArray(config?.agents?.list) && config.agents.list.length
    ? config.agents.list
    : [{ id: "main", name: "Main Agent", workspace: config?.agents?.defaults?.workspace || "" }];
  const bindings = Array.isArray(config?.bindings) ? config.bindings : [];

  return agents.map((agent) => ({
    id: String(agent.id || "main"),
    name: String(agent.name || agent.identity?.name || agent.id || "Agent"),
    workspace: String(agent.workspace || config?.agents?.defaults?.workspace || ""),
    runtime: String(agent.runtime?.type || "builtin"),
    bindings: bindings
      .filter((binding) => binding?.agentId === agent.id)
      .map(formatBinding)
      .filter(Boolean),
    status: "idle",
    note: "",
    lastSeenAt: null,
    tokens: { prompt: 0, completion: 0, total: 0 },
  }));
}

function formatBinding(binding) {
  const channel = binding?.match?.channel;
  const accountId = binding?.match?.accountId;
  const peer = binding?.match?.peer?.id;

  if (!channel) {
    return "";
  }

  const parts = [channel];
  if (accountId) {
    parts.push(accountId);
  }
  if (peer) {
    parts.push(peer);
  }
  return parts.join(":");
}

function buildAgentSnapshots({ configuredAgents, knownAgentIds, statusPayload, healthPayload }) {
  const merged = new Map(configuredAgents.map((agent) => [agent.id, structuredCloneAgent(agent)]));

  const candidates = [
    ...findAgentCandidates(statusPayload, knownAgentIds),
    ...findAgentCandidates(healthPayload, knownAgentIds),
  ];

  for (const candidate of candidates) {
    const existing = merged.get(candidate.id) || {
      id: candidate.id,
      name: candidate.name || candidate.id,
      workspace: "",
      runtime: "",
      bindings: [],
      status: "idle",
      note: "",
      lastSeenAt: null,
      tokens: { prompt: 0, completion: 0, total: 0 },
    };
    merged.set(candidate.id, mergeAgents(existing, candidate));
  }

  return Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function structuredCloneAgent(agent) {
  return {
    ...agent,
    bindings: [...(agent.bindings || [])],
    tokens: { ...agent.tokens },
  };
}

function mergeAgents(base, incoming) {
  const baseScore = statusPriority(base.status);
  const incomingScore = statusPriority(incoming.status);

  return {
    ...base,
    name: incoming.name || base.name,
    workspace: incoming.workspace || base.workspace,
    runtime: incoming.runtime || base.runtime,
    bindings: mergeStringArrays(base.bindings, incoming.bindings),
    status: incomingScore >= baseScore ? incoming.status : base.status,
    note: incoming.note || base.note,
    lastSeenAt: incoming.lastSeenAt || base.lastSeenAt,
    tokens: chooseLargestTokenBlock([base.tokens, incoming.tokens]),
  };
}

function statusPriority(status) {
  if (status === "error") {
    return 5;
  }
  if (status === "running") {
    return 4;
  }
  if (status === "waiting") {
    return 3;
  }
  if (status === "offline") {
    return 2;
  }
  return 1;
}

function mergeStringArrays(left, right) {
  return Array.from(new Set([...(left || []), ...(right || [])].filter(Boolean))).slice(0, 8);
}

function findAgentCandidates(payload, knownAgentIds) {
  const candidates = [];

  walk(payload, (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }

    const id = resolveAgentId(node, knownAgentIds);
    if (!id) {
      return;
    }

    candidates.push({
      id,
      name: stringValue(node.name || node.label || node.agentName || id),
      status: inferAgentStatus(node),
      workspace: stringValue(node.workspace || node.agentDir || ""),
      runtime: stringValue(node.runtime?.type || node.runtime || ""),
      note: stringValue(
        node.note ||
          node.activity ||
          node.summary ||
          node.message ||
          node.lastAction ||
          node.stateText,
      ),
      bindings: extractBindings(node),
      lastSeenAt: toIsoString(
        node.lastSeenAt ||
          node.lastActiveAt ||
          node.updatedAt ||
          node.timestamp ||
          node.collectedAt,
      ),
      tokens: extractLargestUsageBlock(node),
    });
  });

  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates) {
  const merged = new Map();
  for (const candidate of candidates) {
    if (!merged.has(candidate.id)) {
      merged.set(candidate.id, candidate);
      continue;
    }
    merged.set(candidate.id, mergeAgents(merged.get(candidate.id), candidate));
  }
  return Array.from(merged.values());
}

function resolveAgentId(node, knownAgentIds) {
  const explicit = stringValue(node.agentId || node.id);
  if (explicit && knownAgentIds.has(explicit)) {
    return explicit;
  }

  if (explicit && /agent/i.test(stringValue(node.kind || node.type || ""))) {
    return explicit;
  }

  if (explicit && (node.workspace || node.agentDir || node.identity || node.model || node.runtime)) {
    return explicit;
  }

  return "";
}

function inferAgentStatus(node) {
  const raw = stringValue(
    node.status ||
      node.state ||
      node.runtimeState ||
      node.health ||
      (node.active === true ? "running" : "") ||
      (node.connected === false ? "offline" : ""),
  ).toLowerCase();

  if (["running", "busy", "active", "working", "processing", "in_progress"].includes(raw)) {
    return "running";
  }
  if (["waiting", "queued", "pending", "paused"].includes(raw)) {
    return "waiting";
  }
  if (["error", "failed", "degraded", "crashed"].includes(raw)) {
    return "error";
  }
  if (["offline", "stopped", "disconnected", "missing"].includes(raw)) {
    return "offline";
  }
  return "idle";
}

function extractBindings(node) {
  const bindings = [];

  if (Array.isArray(node.bindings)) {
    for (const binding of node.bindings) {
      if (typeof binding === "string") {
        bindings.push(binding);
      } else if (binding && typeof binding === "object") {
        const formatted = formatBinding(binding);
        if (formatted) {
          bindings.push(formatted);
        }
      }
    }
  }

  return Array.from(new Set(bindings)).slice(0, 8);
}

function inferGatewayStatus(statusPayload, healthPayload) {
  const statuses = [
    statusPayload?.overview?.gateway?.status,
    healthPayload?.gateway?.status,
    healthPayload?.status,
    statusPayload?.status,
  ]
    .map((value) => stringValue(value).toLowerCase())
    .filter(Boolean);

  if (statuses.some((status) => status.includes("error") || status.includes("fail"))) {
    return "degraded";
  }
  if (statuses.some((status) => status.includes("run") || status.includes("ok") || status.includes("healthy"))) {
    return "running";
  }
  if (statuses.some((status) => status.includes("stop") || status.includes("off"))) {
    return "offline";
  }
  return statusPayload || healthPayload ? "running" : "degraded";
}

function inferGatewayVersion(statusPayload, healthPayload) {
  return stringValue(
    statusPayload?.overview?.version ||
      statusPayload?.overview?.update?.version ||
      healthPayload?.version,
  );
}

function inferGatewayMode(config) {
  return stringValue(config?.gateway?.mode || "local");
}

function extractLargestUsageBlock(payload) {
  const blocks = [];

  walk(payload, (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }

    const block = maybeTokenBlock(node);
    if (block.total > 0) {
      blocks.push(block);
    }
  });

  return chooseLargestTokenBlock(blocks);
}

function maybeTokenBlock(node) {
  const prompt = numberValue(
    node.prompt ??
      node.input ??
      node.inputTokens ??
      node.promptTokens ??
      node.usage?.prompt ??
      node.usage?.input ??
      node.usage?.inputTokens ??
      node.usage?.promptTokens,
  );
  const completion = numberValue(
    node.completion ??
      node.output ??
      node.outputTokens ??
      node.completionTokens ??
      node.usage?.completion ??
      node.usage?.output ??
      node.usage?.outputTokens ??
      node.usage?.completionTokens,
  );
  const total = numberValue(
    node.total ??
      node.totalTokens ??
      node.tokens ??
      node.usage?.total ??
      node.usage?.totalTokens ??
      prompt + completion,
  );

  return {
    prompt,
    completion,
    total: total > 0 ? total : prompt + completion,
  };
}

function chooseLargestTokenBlock(blocks) {
  return blocks.reduce(
    (largest, current) => (current.total > largest.total ? current : largest),
    { prompt: 0, completion: 0, total: 0 },
  );
}

function sumTokenBlocks(blocks) {
  return blocks.reduce(
    (accumulator, block) => {
      accumulator.prompt += block.prompt || 0;
      accumulator.completion += block.completion || 0;
      accumulator.total += block.total || 0;
      return accumulator;
    },
    { prompt: 0, completion: 0, total: 0 },
  );
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toIsoString(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function walk(value, visitor) {
  if (value === null || value === undefined) {
    return;
  }
  visitor(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visitor);
    }
    return;
  }

  if (typeof value === "object") {
    for (const child of Object.values(value)) {
      walk(child, visitor);
    }
  }
}
