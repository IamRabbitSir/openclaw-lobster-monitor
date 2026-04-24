import { collectSnapshot, getConfiguredAgents } from "./lib/collector.js";

function normalizeConfig(rawConfig, apiConfig) {
  const safe = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const sourceId = safe.sourceId || inferSourceId(apiConfig);
  const reconcileIntervalMs = clampNumber(safe.pollIntervalMs, 15000, 1000, 600000);
  return {
    serverUrl: String(safe.serverUrl || "").replace(/\/+$/, ""),
    ingestToken: String(safe.ingestToken || "").trim(),
    sourceId,
    sourceLabel: String(safe.sourceLabel || sourceId),
    pollIntervalMs: reconcileIntervalMs,
    eventDebounceMs: clampNumber(safe.eventDebounceMs, 150, 0, 5000),
    requestTimeoutMs: clampNumber(safe.requestTimeoutMs, 4000, 500, 60000),
    cliTimeoutMs: clampNumber(safe.cliTimeoutMs, 2500, 500, 60000),
    cliPath: String(safe.cliPath || ""),
    enableCli: safe.enableCli !== false,
    tags: Array.isArray(safe.tags) ? safe.tags.slice(0, 8).map((tag) => String(tag).trim()).filter(Boolean) : [],
    eventFreshWindowMs: clampNumber(
      safe.eventFreshWindowMs,
      Math.max(5000, Math.round(reconcileIntervalMs / 2)),
      1000,
      600000,
    ),
  };
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function inferSourceId(config) {
  const gatewayPort = config?.gateway?.port || "gateway";
  return `openclaw-${gatewayPort}`;
}

async function postSnapshot(api, config, snapshot) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const url = `${config.serverUrl}/api/ingest`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ingestToken}`,
      },
      body: JSON.stringify(snapshot),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Upload failed with ${response.status}: ${detail}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function startMonitor(api, config) {
  let active = true;
  const runtime = createRuntime(api, config);
  const uploadSnapshot = createUploadScheduler(api, config, runtime, () => active);
  runtime.queueUpload = uploadSnapshot;
  const cleanupRealtimeSignals = registerRealtimeSignals(api, runtime);
  const stopReconciliation = startReconciliationLoop(api, config, runtime, uploadSnapshot, () => active);
  uploadSnapshot("startup", true);

  return () => {
    active = false;
    stopReconciliation();
    cleanupRealtimeSignals();
    uploadSnapshot.cancel();
  };
}

function createRuntime(api, config) {
  const configuredAgents = getConfiguredAgents(api.config);
  const snapshot = buildBootstrapSnapshot(api, config, configuredAgents);
  const agentMeta = new Map(
    snapshot.agents.map((agent) => [
      agent.id,
      {
        lastEventAtMs: 0,
        lastEventStatus: agent.status,
        lastEventNote: agent.note,
      },
    ]),
  );

  return {
    api,
    config,
    configuredAgents,
    snapshot,
    agentMeta,
    conversationBindings: new Map(),
    sessionBindings: new Map(),
    lastCalibrationAtMs: 0,
    lastLiveCalibrationAtMs: 0,
    lastCalibrationError: "",
    lastCalibrationDiagnostics: [],
    queueUpload: null,
  };
}

function buildBootstrapSnapshot(api, config, configuredAgents) {
  const agents = configuredAgents
    .map((agent) => toPublicAgent(agent))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    sourceId: config.sourceId,
    sourceLabel: config.sourceLabel,
    sourceMode: "fallback",
    collectedAt: new Date().toISOString(),
    gateway: {
      status: "starting",
      version: "",
      mode: String(api.config?.gateway?.mode || "local"),
      note: "Hybrid mode armed. Event hooks drive status changes and low-frequency CLI reconciliation fills health and tokens.",
    },
    diagnostics: buildDiagnostics(config, [], ""),
    meta: {
      tags: config.tags,
    },
    tokenTotals: sumTokenBlocks(agents.map((agent) => agent.tokens)),
    agents,
  };
}

function buildDiagnostics(config, baseDiagnostics, calibrationError) {
  const diagnostics = [
    "Hybrid mode active: event hooks drive near-real-time status updates.",
    `CLI reconciliation interval: ${config.pollIntervalMs}ms.`,
  ];

  if (calibrationError) {
    diagnostics.push(`Last CLI reconciliation error: ${calibrationError}`);
  }

  for (const item of baseDiagnostics || []) {
    if (typeof item !== "string") {
      continue;
    }

    const normalized = item.trim();
    if (!normalized || diagnostics.includes(normalized)) {
      continue;
    }
    diagnostics.push(normalized);
  }

  return diagnostics.slice(0, 8);
}

function createUploadScheduler(api, config, runtime, isActive) {
  let timer = null;
  let inFlight = false;
  let queued = false;
  let queuedImmediate = false;
  let queuedReason = "event";

  const schedule = (reason = "event", immediate = false) => {
    if (!isActive()) {
      return;
    }

    queued = true;
    queuedImmediate = queuedImmediate || immediate;
    queuedReason = reason || queuedReason;

    if (inFlight) {
      return;
    }

    if (timer) {
      if (!queuedImmediate) {
        return;
      }
      clearTimeout(timer);
      timer = null;
    }

    timer = setTimeout(async () => {
      timer = null;

      if (!queued || !isActive()) {
        return;
      }

      queued = false;
      queuedImmediate = false;
      queuedReason = "event";
      await flush();
    }, queuedImmediate ? 0 : config.eventDebounceMs);
  };

  async function flush() {
    if (!isActive() || inFlight) {
      return;
    }

    inFlight = true;

    try {
      const snapshot = buildUploadSnapshot(runtime);
      await postSnapshot(api, config, snapshot);
    } catch (error) {
      api.logger.warn?.(`lobster-monitor: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
      if (queued) {
        schedule(queuedReason, queuedImmediate);
      }
    }
  }

  schedule.cancel = () => {
    queued = false;
    queuedImmediate = false;
    queuedReason = "event";
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return schedule;
}

function buildUploadSnapshot(runtime) {
  const snapshot = structuredClone(runtime.snapshot);
  snapshot.collectedAt = new Date().toISOString();
  snapshot.sourceMode = inferSourceMode(runtime);
  snapshot.gateway = {
    ...snapshot.gateway,
    note: buildGatewayNote(runtime, snapshot.gateway?.note || ""),
  };
  snapshot.diagnostics = buildDiagnostics(runtime.config, runtime.lastCalibrationDiagnostics, runtime.lastCalibrationError);
  snapshot.meta = {
    tags: runtime.config.tags,
  };
  snapshot.agents = snapshot.agents
    .map((agent) => ({
      ...agent,
      tokens: normalizeTokens(agent.tokens),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  snapshot.tokenTotals = chooseLargestTokenBlock([
    normalizeTokens(snapshot.tokenTotals),
    sumTokenBlocks(snapshot.agents.map((agent) => agent.tokens)),
  ]);
  return snapshot;
}

function inferSourceMode(runtime) {
  if (!runtime.config.enableCli) {
    return "fallback";
  }

  if (!runtime.lastLiveCalibrationAtMs) {
    return "fallback";
  }

  const freshnessLimitMs = Math.max(runtime.config.pollIntervalMs * 2, runtime.config.eventFreshWindowMs);
  return Date.now() - runtime.lastLiveCalibrationAtMs <= freshnessLimitMs ? "live" : "fallback";
}

function buildGatewayNote(runtime, baseNote) {
  const parts = [
    "Hybrid mode active: event hooks drive agent states and CLI reconciliation refreshes token and health snapshots.",
  ];

  if (baseNote) {
    parts.push(baseNote);
  }

  if (runtime.lastCalibrationAtMs) {
    parts.push(`Last reconciliation: ${new Date(runtime.lastCalibrationAtMs).toISOString()}.`);
  }

  if (runtime.lastCalibrationError) {
    parts.push(`CLI reconcile degraded: ${runtime.lastCalibrationError}.`);
  }

  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function startReconciliationLoop(api, config, runtime, uploadSnapshot, isActive) {
  let timer = null;

  const tick = async () => {
    if (!isActive()) {
      return;
    }

    const startedAt = Date.now();

    try {
      const calibrationSnapshot = await collectSnapshot({
        api,
        pluginConfig: config,
      });
      mergeCalibrationSnapshot(runtime, calibrationSnapshot);
    } catch (error) {
      runtime.lastCalibrationError = error instanceof Error ? error.message : String(error);
      runtime.lastCalibrationDiagnostics = [];
      runtime.snapshot.gateway.status = runtime.snapshot.gateway.status === "error" ? "error" : "running";
    } finally {
      uploadSnapshot("reconcile", true);

      if (isActive()) {
        const elapsedMs = Date.now() - startedAt;
        const delayMs = Math.max(0, config.pollIntervalMs - elapsedMs);
        timer = setTimeout(tick, delayMs);
      }
    }
  };

  tick();

  return () => {
    if (timer) {
      clearTimeout(timer);
    }
  };
}

function mergeCalibrationSnapshot(runtime, calibrationSnapshot) {
  const now = Date.now();
  const incomingById = new Map(
    (calibrationSnapshot.agents || []).map((agent) => [agent.id, toPublicAgent(agent)]),
  );
  const mergedAgents = runtime.configuredAgents.map((configuredAgent) => {
    const currentAgent = findAgent(runtime.snapshot.agents, configuredAgent.id) || toPublicAgent(configuredAgent);
    const incomingAgent = incomingById.get(configuredAgent.id) || currentAgent;
    return applyRecentEventOverride(runtime, currentAgent, incomingAgent, now);
  });

  runtime.snapshot = {
    sourceId: calibrationSnapshot.sourceId || runtime.config.sourceId,
    sourceLabel: calibrationSnapshot.sourceLabel || runtime.config.sourceLabel,
    sourceMode: calibrationSnapshot.sourceMode || runtime.snapshot.sourceMode,
    collectedAt: calibrationSnapshot.collectedAt || new Date().toISOString(),
    gateway: {
      status: calibrationSnapshot.gateway?.status || runtime.snapshot.gateway.status,
      version: calibrationSnapshot.gateway?.version || runtime.snapshot.gateway.version,
      mode: calibrationSnapshot.gateway?.mode || runtime.snapshot.gateway.mode,
      note: calibrationSnapshot.gateway?.note || runtime.snapshot.gateway.note,
    },
    diagnostics: calibrationSnapshot.diagnostics || [],
    meta: {
      tags: runtime.config.tags,
    },
    tokenTotals: chooseLargestTokenBlock([
      normalizeTokens(calibrationSnapshot.tokenTotals),
      sumTokenBlocks(mergedAgents.map((agent) => agent.tokens)),
    ]),
    agents: mergedAgents.sort((left, right) => left.id.localeCompare(right.id)),
  };

  runtime.lastCalibrationAtMs = now;
  runtime.lastCalibrationDiagnostics = calibrationSnapshot.diagnostics || [];
  runtime.lastCalibrationError = "";

  if (calibrationSnapshot.sourceMode === "live") {
    runtime.lastLiveCalibrationAtMs = now;
  }
}

function applyRecentEventOverride(runtime, currentAgent, incomingAgent, now) {
  const normalizedIncoming = toPublicAgent(incomingAgent);
  const meta = runtime.agentMeta.get(normalizedIncoming.id);

  if (!meta?.lastEventAtMs) {
    return {
      ...normalizedIncoming,
      tokens: chooseLargestTokenBlock([normalizeTokens(normalizedIncoming.tokens), normalizeTokens(currentAgent.tokens)]),
    };
  }

  const eventIsFresh = now - meta.lastEventAtMs <= runtime.config.eventFreshWindowMs;
  if (!eventIsFresh || normalizedIncoming.status === "error") {
    return {
      ...normalizedIncoming,
      tokens: chooseLargestTokenBlock([normalizeTokens(normalizedIncoming.tokens), normalizeTokens(currentAgent.tokens)]),
    };
  }

  return {
    ...normalizedIncoming,
    status: currentAgent.status || meta.lastEventStatus || normalizedIncoming.status,
    note: currentAgent.note || meta.lastEventNote || normalizedIncoming.note,
    lastSeenAt: laterIsoString(currentAgent.lastSeenAt, normalizedIncoming.lastSeenAt),
    tokens: chooseLargestTokenBlock([normalizeTokens(normalizedIncoming.tokens), normalizeTokens(currentAgent.tokens)]),
  };
}

function registerRealtimeSignals(api, runtime) {
  const registeredSignals = [];

  const hookHandlers = [
    ["gateway:startup", (event, ctx) => handleGatewayStartup(runtime, event, ctx)],
    ["message:received", (event, ctx) => handleInboundMessage(runtime, event, ctx, "Inbound message received.")],
    ["message:preprocessed", (event, ctx) => handleInboundMessage(runtime, event, ctx, "Inbound message preprocessed.")],
    ["message:sent", (event, ctx) => handleMessageSent(runtime, event, ctx)],
    ["command:new", (event, ctx) => handleCommandEvent(runtime, event, ctx, "idle", "New command session created.")],
    ["command:reset", (event, ctx) => handleCommandEvent(runtime, event, ctx, "idle", "Command session reset.")],
    ["command:stop", (event, ctx) => handleCommandEvent(runtime, event, ctx, "idle", "Command run stopped.")],
  ];

  const lifecycleHandlers = [
    ["before_prompt_build", (event, ctx) => handleLifecycleEvent(runtime, event, ctx, "running", "Prompt build started.")],
    ["before_agent_start", (event, ctx) => handleLifecycleEvent(runtime, event, ctx, "running", "Agent execution started.")],
    ["before_tool_call", (event, ctx) => handleLifecycleEvent(runtime, event, ctx, "running", buildToolNote(event, ctx, "Tool call started."))],
    ["after_tool_call", (event, ctx) => handleLifecycleEvent(runtime, event, ctx, "running", buildToolNote(event, ctx, "Tool call finished."))],
    ["agent_end", (event, ctx) => handleAgentEnd(runtime, event, ctx)],
  ];

  for (const [hookName, handler] of hookHandlers) {
    if (safeRegisterHook(api, hookName, handler)) {
      registeredSignals.push(hookName);
    }
  }

  for (const [eventName, handler] of lifecycleHandlers) {
    if (safeRegisterLifecycle(api, eventName, handler)) {
      registeredSignals.push(eventName);
    }
  }

  if (registeredSignals.length) {
    api.logger.info?.(`lobster-monitor: realtime hybrid hooks armed (${registeredSignals.join(", ")})`);
  } else {
    api.logger.warn?.("lobster-monitor: no realtime hook API detected, staying on reconciliation-only mode");
  }

  return () => {};
}

function safeRegisterHook(api, hookName, handler) {
  if (typeof api.registerHook !== "function") {
    return false;
  }

  try {
    api.registerHook(hookName, async (event, ctx) => {
      try {
        await handler(event, ctx);
      } catch (error) {
        api.logger.warn?.(`lobster-monitor: realtime hook ${hookName} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return true;
  } catch (error) {
    api.logger.debug?.(`lobster-monitor: unable to register hook ${hookName}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function safeRegisterLifecycle(api, eventName, handler) {
  if (typeof api.on !== "function") {
    return false;
  }

  try {
    api.on(eventName, async (event, ctx) => {
      try {
        await handler(event, ctx);
      } catch (error) {
        api.logger.warn?.(`lobster-monitor: realtime lifecycle ${eventName} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return true;
  } catch (error) {
    api.logger.debug?.(`lobster-monitor: unable to register lifecycle ${eventName}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function handleGatewayStartup(runtime, event, ctx) {
  updateGateway(runtime, {
    status: "running",
    note: "Gateway startup event received. Realtime hybrid monitor is active.",
  });
  rememberAgentRouting(runtime, [], event, ctx);
  runtime.queueUpload?.("gateway:startup", true);
}

function handleInboundMessage(runtime, event, ctx, note) {
  const agentIds = resolveAgentIds(runtime, event, ctx, { preferBindings: true });
  if (!agentIds.length) {
    return;
  }

  rememberAgentRouting(runtime, agentIds, event, ctx);
  applyAgentPatch(runtime, agentIds, {
    status: "waiting",
    note: appendMessageContext(note, event, ctx),
    eventAtMs: Date.now(),
  });
  updateGateway(runtime, {
    status: "running",
  });
  runtime.queueUpload?.("message:received", false);
}

function handleMessageSent(runtime, event, ctx) {
  const agentIds = resolveAgentIds(runtime, event, ctx, { preferBindings: false });
  if (!agentIds.length) {
    return;
  }

  rememberAgentRouting(runtime, agentIds, event, ctx);
  const errorText = extractErrorText(event, ctx);
  applyAgentPatch(runtime, agentIds, {
    status: errorText ? "error" : "idle",
    note: errorText ? `Outbound delivery failed: ${errorText}` : appendMessageContext("Outbound message delivered.", event, ctx),
    tokens: extractUsageTokens(event, ctx),
    eventAtMs: Date.now(),
  });
  runtime.queueUpload?.("message:sent", false);
}

function handleCommandEvent(runtime, event, ctx, status, note) {
  const agentIds = resolveAgentIds(runtime, event, ctx, { preferBindings: false });
  if (!agentIds.length) {
    return;
  }

  rememberAgentRouting(runtime, agentIds, event, ctx);
  applyAgentPatch(runtime, agentIds, {
    status,
    note,
    eventAtMs: Date.now(),
  });
  runtime.queueUpload?.("command", false);
}

function handleLifecycleEvent(runtime, event, ctx, status, note) {
  const agentIds = resolveAgentIds(runtime, event, ctx, { preferBindings: false });
  if (!agentIds.length) {
    return;
  }

  rememberAgentRouting(runtime, agentIds, event, ctx);
  applyAgentPatch(runtime, agentIds, {
    status,
    note,
    eventAtMs: Date.now(),
  });
  runtime.queueUpload?.("lifecycle", false);
}

function handleAgentEnd(runtime, event, ctx) {
  const agentIds = resolveAgentIds(runtime, event, ctx, { preferBindings: false });
  if (!agentIds.length) {
    return;
  }

  rememberAgentRouting(runtime, agentIds, event, ctx);
  const errorText = extractErrorText(event, ctx);
  applyAgentPatch(runtime, agentIds, {
    status: errorText ? "error" : "idle",
    note: errorText ? `Agent execution failed: ${errorText}` : "Agent execution finished.",
    tokens: extractUsageTokens(event, ctx),
    eventAtMs: Date.now(),
  });
  runtime.queueUpload?.("agent_end", false);
}

function rememberAgentRouting(runtime, agentIds, event, ctx) {
  if (!agentIds.length) {
    return;
  }

  const sessionKey = extractSessionKey(event, ctx);
  if (sessionKey) {
    runtime.sessionBindings.set(sessionKey, {
      agentIds: [...agentIds],
      updatedAtMs: Date.now(),
    });
  }

  const conversationKeys = extractConversationKeys(event, ctx);
  const updatedAtMs = Date.now();
  for (const key of conversationKeys) {
    runtime.conversationBindings.set(key, {
      agentIds: [...agentIds],
      updatedAtMs,
    });
  }

  pruneBindingMap(runtime.sessionBindings, runtime.config.pollIntervalMs * 4);
  pruneBindingMap(runtime.conversationBindings, runtime.config.pollIntervalMs * 4);
}

function pruneBindingMap(bindingMap, ttlMs) {
  const now = Date.now();
  for (const [key, entry] of bindingMap.entries()) {
    if (!entry || now - entry.updatedAtMs > ttlMs) {
      bindingMap.delete(key);
    }
  }
}

function resolveAgentIds(runtime, event, ctx, { preferBindings }) {
  const explicitAgentIds = extractExplicitAgentIds(runtime, event, ctx);
  if (explicitAgentIds.length) {
    return explicitAgentIds;
  }

  const workspaceAgentIds = findAgentIdsByWorkspace(runtime, extractWorkspaceHints(event, ctx));
  if (workspaceAgentIds.length) {
    return workspaceAgentIds;
  }

  const sessionKey = extractSessionKey(event, ctx);
  if (sessionKey) {
    const sessionEntry = runtime.sessionBindings.get(sessionKey);
    if (sessionEntry?.agentIds?.length) {
      return uniqueStrings(sessionEntry.agentIds);
    }
  }

  const conversationIds = resolveConversationBoundAgents(runtime, extractConversationKeys(event, ctx));
  if (conversationIds.length) {
    return conversationIds;
  }

  if (preferBindings) {
    const bindingMatchedIds = matchAgentsByBindings(runtime, event, ctx);
    if (bindingMatchedIds.length) {
      return bindingMatchedIds;
    }
  }

  const activeAgentIds = findRecentlyActiveAgentIds(runtime);
  if (activeAgentIds.length === 1) {
    return activeAgentIds;
  }

  if (runtime.snapshot.agents.length === 1) {
    return [runtime.snapshot.agents[0].id];
  }

  return [];
}

function resolveConversationBoundAgents(runtime, keys) {
  const agentIds = [];
  for (const key of keys) {
    const entry = runtime.conversationBindings.get(key);
    if (entry?.agentIds?.length) {
      agentIds.push(...entry.agentIds);
    }
  }
  return uniqueStrings(agentIds);
}

function findRecentlyActiveAgentIds(runtime) {
  const now = Date.now();
  const activeAgentIds = [];

  for (const agent of runtime.snapshot.agents) {
    const meta = runtime.agentMeta.get(agent.id);
    if (!meta?.lastEventAtMs) {
      continue;
    }

    if (now - meta.lastEventAtMs > runtime.config.eventFreshWindowMs) {
      continue;
    }

    if (["waiting", "running", "error"].includes(agent.status)) {
      activeAgentIds.push(agent.id);
    }
  }

  return uniqueStrings(activeAgentIds);
}

function extractExplicitAgentIds(runtime, event, ctx) {
  const candidates = uniqueStrings([
    event?.agentId,
    event?.agent?.id,
    event?.context?.agentId,
    event?.context?.agent?.id,
    event?.payload?.agentId,
    ctx?.agentId,
    ctx?.agent?.id,
    ctx?.run?.agentId,
    ctx?.result?.agentId,
  ]);

  return candidates.filter((candidate) => runtime.agentMeta.has(candidate));
}

function findAgentIdsByWorkspace(runtime, workspaces) {
  const normalizedHints = uniqueStrings(workspaces);
  if (!normalizedHints.length) {
    return [];
  }

  return uniqueStrings(
    runtime.configuredAgents
      .filter((agent) => normalizedHints.includes(agent.workspace))
      .map((agent) => agent.id),
  );
}

function extractWorkspaceHints(event, ctx) {
  return [
    event?.workspace,
    event?.workspaceDir,
    event?.agentDir,
    event?.context?.workspace,
    event?.context?.workspaceDir,
    ctx?.workspace,
    ctx?.workspaceDir,
    ctx?.agentDir,
    ctx?.run?.workspace,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function matchAgentsByBindings(runtime, event, ctx) {
  const details = extractMessageRoutingDetails(event, ctx);
  if (!details.channel) {
    return [];
  }

  const scoredMatches = [];

  for (const agent of runtime.configuredAgents) {
    let bestScore = 0;

    for (const binding of agent.bindings || []) {
      const score = scoreBindingMatch(binding, details);
      if (score > bestScore) {
        bestScore = score;
      }
    }

    if (bestScore > 0) {
      scoredMatches.push({ agentId: agent.id, score: bestScore });
    }
  }

  if (!scoredMatches.length) {
    return [];
  }

  const highestScore = Math.max(...scoredMatches.map((match) => match.score));
  return scoredMatches
    .filter((match) => match.score === highestScore)
    .map((match) => match.agentId);
}

function scoreBindingMatch(binding, details) {
  const { channel, tail, accountId, peerId } = parseBinding(binding);
  if (!channel || channel !== details.channel) {
    return 0;
  }

  let score = 1;

  if (accountId) {
    if (details.accountId !== accountId) {
      return 0;
    }
    score += 2;
  }

  if (peerId) {
    if (!details.peerCandidates.includes(peerId)) {
      return 0;
    }
    score += 4;
  }

  if (tail) {
    if (details.accountId === tail) {
      score += 2;
    } else if (details.peerCandidates.includes(tail)) {
      score += 4;
    } else {
      return 0;
    }
  }

  return score;
}

function parseBinding(binding) {
  const parts = String(binding || "").split(":").filter(Boolean);
  const channel = parts.shift() || "";

  if (parts.length <= 1) {
    return {
      channel,
      tail: parts[0] || "",
      accountId: "",
      peerId: "",
    };
  }

  return {
    channel,
    tail: "",
    accountId: parts.shift() || "",
    peerId: parts.join(":"),
  };
}

function extractMessageRoutingDetails(event, ctx) {
  const channel = firstString(
    event?.channel,
    event?.channelId,
    event?.context?.channel,
    event?.context?.channelId,
    event?.message?.channel,
    ctx?.channel,
    ctx?.channelId,
    ctx?.message?.channel,
  );
  const accountId = firstString(
    event?.accountId,
    event?.context?.accountId,
    event?.message?.accountId,
    ctx?.accountId,
    ctx?.message?.accountId,
    ctx?.account?.id,
  );
  const peerCandidates = uniqueStrings([
    event?.peerId,
    event?.peer?.id,
    event?.from,
    event?.to,
    event?.conversationId,
    event?.threadId,
    event?.groupId,
    event?.chatId,
    event?.userId,
    event?.senderId,
    event?.recipientId,
    event?.message?.from,
    event?.message?.to,
    event?.message?.conversationId,
    event?.context?.peer?.id,
    event?.context?.from,
    event?.context?.to,
    event?.context?.conversationId,
    ctx?.peerId,
    ctx?.peer?.id,
    ctx?.from,
    ctx?.to,
    ctx?.conversationId,
    ctx?.threadId,
    ctx?.groupId,
    ctx?.message?.from,
    ctx?.message?.to,
    ctx?.message?.conversationId,
  ]);

  return {
    channel,
    accountId,
    peerCandidates,
  };
}

function extractConversationKeys(event, ctx) {
  const details = extractMessageRoutingDetails(event, ctx);
  const rawConversationIds = uniqueStrings([
    event?.conversationId,
    event?.threadId,
    event?.groupId,
    event?.chatId,
    event?.message?.conversationId,
    event?.context?.conversationId,
    ctx?.conversationId,
    ctx?.threadId,
    ctx?.groupId,
    ctx?.chatId,
    ctx?.message?.conversationId,
  ]);
  const rawPeerIds = details.peerCandidates;
  const keys = [];

  for (const id of rawConversationIds) {
    keys.push(`${details.channel || "channel"}:${details.accountId || "account"}:${id}`);
  }

  for (const id of rawPeerIds) {
    keys.push(`${details.channel || "channel"}:${details.accountId || "account"}:${id}`);
  }

  if (details.channel && details.accountId) {
    keys.push(`${details.channel}:${details.accountId}`);
  }

  return uniqueStrings(keys);
}

function extractSessionKey(event, ctx) {
  return firstString(
    event?.sessionKey,
    event?.context?.sessionKey,
    event?.payload?.sessionKey,
    ctx?.sessionKey,
    ctx?.session?.key,
    ctx?.run?.sessionKey,
  );
}

function updateGateway(runtime, patch) {
  runtime.snapshot.gateway = {
    ...runtime.snapshot.gateway,
    ...patch,
  };
}

function applyAgentPatch(runtime, agentIds, patch) {
  const eventAtMs = patch.eventAtMs || Date.now();
  const lastSeenAt = new Date(eventAtMs).toISOString();

  for (const agentId of agentIds) {
    const agent = ensureAgent(runtime, agentId);
    agent.status = patch.status || agent.status;
    agent.note = typeof patch.note === "string" && patch.note.trim() ? patch.note.trim() : agent.note;
    agent.lastSeenAt = lastSeenAt;
    agent.tokens = chooseLargestTokenBlock([normalizeTokens(agent.tokens), normalizeTokens(patch.tokens)]);

    runtime.agentMeta.set(agentId, {
      lastEventAtMs: eventAtMs,
      lastEventStatus: agent.status,
      lastEventNote: agent.note,
    });
  }

  runtime.snapshot.tokenTotals = chooseLargestTokenBlock([
    normalizeTokens(runtime.snapshot.tokenTotals),
    sumTokenBlocks(runtime.snapshot.agents.map((agent) => agent.tokens)),
  ]);
}

function ensureAgent(runtime, agentId) {
  let agent = findAgent(runtime.snapshot.agents, agentId);
  if (agent) {
    return agent;
  }

  const configuredAgent = runtime.configuredAgents.find((candidate) => candidate.id === agentId) || {
    id: agentId,
    name: agentId,
    workspace: "",
    runtime: "",
    bindings: [],
    status: "idle",
    note: "",
    lastSeenAt: null,
    tokens: { prompt: 0, completion: 0, total: 0 },
  };

  agent = toPublicAgent(configuredAgent);
  runtime.snapshot.agents.push(agent);
  runtime.snapshot.agents.sort((left, right) => left.id.localeCompare(right.id));
  if (!runtime.agentMeta.has(agentId)) {
    runtime.agentMeta.set(agentId, {
      lastEventAtMs: 0,
      lastEventStatus: agent.status,
      lastEventNote: agent.note,
    });
  }
  return agent;
}

function findAgent(agents, agentId) {
  return (agents || []).find((agent) => agent.id === agentId) || null;
}

function toPublicAgent(agent) {
  const safeAgent = agent && typeof agent === "object" ? agent : {};
  return {
    id: String(safeAgent.id || "agent"),
    name: String(safeAgent.name || safeAgent.id || "Agent"),
    workspace: String(safeAgent.workspace || ""),
    runtime: String(safeAgent.runtime || ""),
    bindings: Array.isArray(safeAgent.bindings) ? safeAgent.bindings.map((binding) => String(binding)) : [],
    status: normalizeAgentStatus(safeAgent.status || "idle"),
    note: String(safeAgent.note || ""),
    lastSeenAt: safeAgent.lastSeenAt || null,
    tokens: normalizeTokens(safeAgent.tokens),
  };
}

function normalizeAgentStatus(value) {
  const status = String(value || "idle").trim().toLowerCase();
  if (["running", "waiting", "error", "offline", "idle"].includes(status)) {
    return status;
  }
  if (["busy", "active", "processing", "working"].includes(status)) {
    return "running";
  }
  if (["queued", "pending", "paused"].includes(status)) {
    return "waiting";
  }
  if (["failed", "degraded", "crashed"].includes(status)) {
    return "error";
  }
  if (["stopped", "disconnected", "missing"].includes(status)) {
    return "offline";
  }
  return "idle";
}

function normalizeTokens(rawTokens) {
  const safeTokens = rawTokens && typeof rawTokens === "object" ? rawTokens : {};
  const prompt = numberValue(
    safeTokens.prompt ??
      safeTokens.input ??
      safeTokens.inputTokens ??
      safeTokens.promptTokens,
  );
  const completion = numberValue(
    safeTokens.completion ??
      safeTokens.output ??
      safeTokens.outputTokens ??
      safeTokens.completionTokens,
  );
  const total = numberValue(
    safeTokens.total ??
      safeTokens.totalTokens ??
      prompt + completion,
  );

  return {
    prompt,
    completion,
    total: total > 0 ? total : prompt + completion,
  };
}

function chooseLargestTokenBlock(blocks) {
  return (blocks || []).reduce(
    (largest, current) => {
      const normalized = normalizeTokens(current);
      return normalized.total > largest.total ? normalized : largest;
    },
    { prompt: 0, completion: 0, total: 0 },
  );
}

function sumTokenBlocks(blocks) {
  return (blocks || []).reduce(
    (accumulator, current) => {
      const normalized = normalizeTokens(current);
      accumulator.prompt += normalized.prompt;
      accumulator.completion += normalized.completion;
      accumulator.total += normalized.total;
      return accumulator;
    },
    { prompt: 0, completion: 0, total: 0 },
  );
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function laterIsoString(left, right) {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");

  if (Number.isNaN(leftTime)) {
    return right || null;
  }
  if (Number.isNaN(rightTime)) {
    return left || null;
  }
  return leftTime >= rightTime ? left : right;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      (values || [])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()),
    ),
  );
}

function appendMessageContext(baseNote, event, ctx) {
  const details = extractMessageRoutingDetails(event, ctx);
  if (!details.channel) {
    return baseNote;
  }

  const suffix = [details.channel, details.accountId || details.peerCandidates[0] || ""]
    .filter(Boolean)
    .join(" / ");
  return suffix ? `${baseNote} ${suffix}` : baseNote;
}

function buildToolNote(event, ctx, fallback) {
  const toolName = firstString(
    event?.toolName,
    event?.tool?.name,
    event?.payload?.toolName,
    ctx?.toolName,
    ctx?.tool?.name,
  );
  return toolName ? `${fallback.replace(/\.$/, "")}: ${toolName}.` : fallback;
}

function extractUsageTokens(event, ctx) {
  return chooseLargestTokenBlock([
    event?.usage,
    event?.result?.usage,
    event?.payload?.usage,
    ctx?.usage,
    ctx?.result?.usage,
    ctx?.response?.usage,
  ]);
}

function extractErrorText(event, ctx) {
  return firstString(
    event?.error?.message,
    event?.payload?.error?.message,
    event?.reason,
    event?.message,
    ctx?.error?.message,
    ctx?.result?.error?.message,
  ).slice(0, 120);
}

export default {
  id: "openclaw-lobster-monitor",
  name: "OpenClaw Lobster Monitor",
  description: "Read-only exporter for the lobster dashboard.",
  register(api) {
    const config = normalizeConfig(api.pluginConfig, api.config);
    let stopLoop = null;

    api.registerService({
      id: "openclaw-lobster-monitor.service",
      start() {
        if (!config.serverUrl || !config.ingestToken) {
          api.logger.warn?.("lobster-monitor: serverUrl / ingestToken missing, monitor upload loop will not start");
          return;
        }

        stopLoop = startMonitor(api, config);
        api.logger.info?.(`lobster-monitor: hybrid exporter started for ${config.serverUrl}`);
      },
      stop() {
        stopLoop?.();
        stopLoop = null;
        api.logger.info?.("lobster-monitor: exporter stopped");
      },
    });
  },
};
