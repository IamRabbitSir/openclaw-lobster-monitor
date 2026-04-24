const elements = {
  agentCount: document.getElementById("metric-agents"),
  runningCount: document.getElementById("metric-running"),
  waitingCount: document.getElementById("metric-waiting"),
  errorCount: document.getElementById("metric-errors"),
  tokenCount: document.getElementById("metric-tokens"),
  sourceCount: document.getElementById("metric-sources"),
  connectionBadge: document.getElementById("connection-badge"),
  modeBadge: document.getElementById("mode-badge"),
  sceneCaption: document.getElementById("scene-caption"),
  sceneSummary: document.getElementById("scene-summary"),
  lastUpdated: document.getElementById("last-updated"),
  sourceList: document.getElementById("source-list"),
  agentList: document.getElementById("agent-list"),
  canvas: document.getElementById("pixel-scene"),
};

const context = elements.canvas.getContext("2d");
context.imageSmoothingEnabled = false;

const sceneSlots = [
  { x: 92, y: 270 },
  { x: 170, y: 286 },
  { x: 250, y: 266 },
  { x: 332, y: 286 },
  { x: 412, y: 266 },
  { x: 112, y: 206 },
  { x: 230, y: 210 },
  { x: 362, y: 206 },
  { x: 182, y: 150 },
  { x: 326, y: 150 },
];

const appState = {
  snapshot: null,
  connection: "connecting",
  sceneAgents: [],
};

init();

async function init() {
  updateConnectionBadge();
  await refreshSnapshot();
  connectToEvents();
  requestAnimationFrame(renderLoop);
}

async function refreshSnapshot() {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Snapshot request failed with ${response.status}`);
    }

    applySnapshot(await response.json());
  } catch (error) {
    appState.connection = "offline";
    updateConnectionBadge();
    console.error(error);
  }
}

function connectToEvents() {
  const events = new EventSource("/api/events");

  events.onopen = () => {
    appState.connection = "live";
    updateConnectionBadge();
  };

  events.addEventListener("snapshot", (event) => {
    appState.connection = "live";
    updateConnectionBadge();
    applySnapshot(JSON.parse(event.data));
  });

  events.addEventListener("heartbeat", (event) => {
    applySnapshot(JSON.parse(event.data));
  });

  events.onerror = () => {
    appState.connection = "reconnecting";
    updateConnectionBadge();
  };
}

function applySnapshot(snapshot) {
  appState.snapshot = snapshot;
  appState.sceneAgents = hydrateSceneAgents(snapshot.agents || []);

  const summary = snapshot.summary || {
    agentCount: 0,
    runningCount: 0,
    waitingCount: 0,
    errorCount: 0,
    tokenTotals: { total: 0 },
    sourceCount: 0,
    freshSourceCount: 0,
  };

  elements.agentCount.textContent = String(summary.agentCount || 0);
  elements.runningCount.textContent = String(summary.runningCount || 0);
  elements.waitingCount.textContent = String(summary.waitingCount || 0);
  elements.errorCount.textContent = String(summary.errorCount || 0);
  elements.tokenCount.textContent = formatNumber(summary.tokenTotals?.total || 0);
  elements.sourceCount.textContent = String(summary.sourceCount || 0);

  elements.lastUpdated.textContent = snapshot.sources?.length
    ? `最近更新: ${formatTime(snapshot.updatedAt)}`
    : "等待首次快照...";

  const mode = pickMode(snapshot);
  elements.modeBadge.textContent = mode.label;
  elements.modeBadge.className = `hero-pill ${mode.className}`;

  elements.sceneCaption.textContent = buildSceneCaption(summary);
  elements.sceneSummary.textContent = buildSceneSummary(summary, snapshot.sources || []);

  renderSources(snapshot.sources || []);
  renderAgents(snapshot.agents || []);
}

function pickMode(snapshot) {
  if (!snapshot.sources || snapshot.sources.length === 0) {
    return { label: "No Data", className: "hero-pill-muted" };
  }

  if (snapshot.sources.some((source) => source.sourceMode === "fallback")) {
    return { label: "Fallback", className: "hero-pill-fallback" };
  }

  return { label: "Live", className: "hero-pill-live" };
}

function buildSceneCaption(summary) {
  if (!summary.agentCount) {
    return "等待第一个 OpenClaw 节点接入";
  }

  return `${summary.agentCount} 只龙虾在线值守 · ${summary.freshSourceCount || summary.sourceCount} 个节点在线`;
}

function buildSceneSummary(summary, sources) {
  if (!summary.agentCount) {
    return "暂无 agent 状态。接入后这里会显示运行中的龙虾数量、等待和告警数量，以及整个家庭工作舱的 token 消耗。";
  }

  const staleCount = sources.filter((source) => source.stale).length;
  const staleText = staleCount ? `，另有 ${staleCount} 个节点已过期` : "";

  return `当前有 ${summary.runningCount} 只龙虾正在工作，${summary.waitingCount} 只在等待，${summary.errorCount} 只触发告警。累计 token ${formatNumber(summary.tokenTotals?.total || 0)}${staleText}。`;
}

function updateConnectionBadge() {
  let label = "Connecting";
  let className = "hero-pill hero-pill-muted";

  if (appState.connection === "live") {
    label = "Live SSE";
    className = "hero-pill hero-pill-live";
  } else if (appState.connection === "reconnecting") {
    label = "Reconnecting";
    className = "hero-pill hero-pill-fallback";
  } else if (appState.connection === "offline") {
    label = "Offline";
    className = "hero-pill hero-pill-error";
  }

  elements.connectionBadge.textContent = label;
  elements.connectionBadge.className = className;
}

function renderSources(sources) {
  if (!sources.length) {
    elements.sourceList.className = "stack-list empty-state";
    elements.sourceList.textContent = "等待数据源接入...";
    return;
  }

  elements.sourceList.className = "stack-list";
  elements.sourceList.innerHTML = sources
    .map((source) => {
      const gatewayStatus = source.gateway?.status || "unknown";
      const statusClass = `status-pill status-${normalizeStatusClass(gatewayStatus)}`;
      const diagnostics = (source.diagnostics || []).slice(0, 3);

      return `
        <article class="source-card">
          <header class="card-header">
            <div>
              <h3>${escapeHtml(source.sourceLabel)}</h3>
              <p class="card-kicker">${escapeHtml(source.sourceId)} · ${escapeHtml(source.sourceMode || "live")}</p>
            </div>
            <span class="${statusClass}">${escapeHtml(formatStatusText(gatewayStatus))}</span>
          </header>
          <p class="card-copy">${escapeHtml(describeSource(source))}</p>
          <div class="detail-grid">
            <div>
              <span>Agent</span>
              <strong>${formatNumber(source.agents?.length || 0)}</strong>
            </div>
            <div>
              <span>Token</span>
              <strong>${formatNumber(source.tokenTotals?.total || 0)}</strong>
            </div>
            <div>
              <span>更新时间</span>
              <strong>${escapeHtml(formatTime(source.receivedAt || source.collectedAt))}</strong>
            </div>
            <div>
              <span>Gateway</span>
              <strong>${escapeHtml(source.gateway?.mode || source.gateway?.version || "running")}</strong>
            </div>
          </div>
          <div class="tag-row">
            ${diagnostics.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderAgents(agents) {
  if (!agents.length) {
    elements.agentList.className = "stack-list empty-state";
    elements.agentList.textContent = "等待 agent 快照...";
    return;
  }

  elements.agentList.className = "stack-list";
  elements.agentList.innerHTML = agents
    .map((agent) => {
      const statusClass = `status-pill status-${normalizeStatusClass(agent.status)}`;
      const bindings = (agent.bindings || []).length ? agent.bindings.join(", ") : "未发现 bindings";

      return `
        <article class="agent-card">
          <header class="card-header">
            <div>
              <h3>${escapeHtml(agent.name)}</h3>
              <p class="card-kicker">${escapeHtml(agent.sourceLabel || agent.sourceId || "-")}</p>
            </div>
            <span class="${statusClass}">${escapeHtml(formatStatusText(agent.status))}</span>
          </header>
          <p class="card-copy">${escapeHtml(describeAgent(agent))}</p>
          <div class="detail-grid">
            <div>
              <span>Token 总量</span>
              <strong>${formatNumber(agent.tokens?.total || 0)}</strong>
            </div>
            <div>
              <span>Prompt / Completion</span>
              <strong>${formatNumber(agent.tokens?.prompt || 0)} / ${formatNumber(agent.tokens?.completion || 0)}</strong>
            </div>
            <div>
              <span>Bindings</span>
              <strong>${escapeHtml(bindings)}</strong>
            </div>
            <div>
              <span>Workspace / Runtime</span>
              <strong>${escapeHtml(agent.workspace || agent.runtime || "未上报")}</strong>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function describeSource(source) {
  if (source.stale) {
    return "该节点长时间未更新，画面中的龙虾会被切换为离线状态。";
  }

  if (source.gateway?.note) {
    return source.gateway.note;
  }

  const version = source.gateway?.version ? `Gateway ${source.gateway.version}` : "Gateway 正在运行";
  const mode = source.gateway?.mode ? `模式 ${source.gateway.mode}` : "实时模式";
  return `${version}，${mode}，最近一次快照已经同步到观测面板。`;
}

function describeAgent(agent) {
  if (agent.note) {
    return agent.note;
  }

  if (agent.status === "running") {
    return "这只龙虾正在执行任务，画面中会有轻微移动和工作提示。";
  }

  if (agent.status === "waiting") {
    return "这只龙虾正在等待调度或外部条件满足。";
  }

  if (agent.status === "error") {
    return "这只龙虾报告了异常状态，建议查看对应 OpenClaw 节点日志。";
  }

  if (agent.status === "offline") {
    return "该 agent 所属节点已经过期或离线。";
  }

  return "这只龙虾处于待机状态，正在保留 bindings 和上下文。";
}

function hydrateSceneAgents(agents) {
  return agents.map((agent, index) => ({
    ...agent,
    slot: pickSceneSlot(index),
    seed: stringHash(`${agent.sourceId || ""}:${agent.id}`),
  }));
}

function pickSceneSlot(index) {
  if (index < sceneSlots.length) {
    return sceneSlots[index];
  }

  const overflow = index - sceneSlots.length;
  const columns = 4;
  const column = overflow % columns;
  const row = Math.floor(overflow / columns);

  return {
    x: 94 + column * 86,
    y: 304 - row * 30,
  };
}

function renderLoop(timestamp) {
  drawScene(timestamp / 1000, appState.sceneAgents);
  requestAnimationFrame(renderLoop);
}

function drawScene(time, agents) {
  const scale = 4;
  const width = 128;
  const height = 88;

  context.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  context.save();
  context.scale(scale, scale);

  rect(0, 0, width, height, "#05070f");
  rect(0, 0, width, 22, "#0a1226");
  rect(0, 22, width, 36, "#4a3558");
  rect(0, 58, width, 20, "#9b6a42");
  rect(0, 78, width, 10, "#5a341f");

  drawObservationWindow(6, 7, 28, 21, time);
  drawObservationWindow(96, 8, 18, 16, time + 5.4, true);

  rect(38, 16, 26, 4, "#6b507d");
  rect(40, 20, 22, 10, "#2f415d");
  rect(42, 22, 18, 6, "#88dbff");
  rect(42, 30, 18, 1, "#d0efff");
  rect(36, 31, 30, 3, "#251a2f");

  rect(72, 20, 16, 16, "#7a4e60");
  rect(70, 32, 20, 6, "#593245");
  rect(74, 18, 4, 4, "#efdbb9");
  rect(82, 18, 4, 4, "#efdbb9");

  rect(16, 56, 84, 14, "#d29c66");
  rect(22, 60, 72, 10, "#944f4d");
  rect(28, 62, 12, 6, "#f0debb");
  rect(70, 62, 12, 6, "#f0debb");
  rect(46, 55, 24, 3, "#76492b");

  rect(6, 50, 24, 10, "#446d78");
  rect(8, 52, 20, 6, "#92d7df");
  rect(10, 49, 16, 1, "#d4f5ff");

  rect(102, 48, 14, 16, "#3f567b");
  rect(104, 50, 10, 8, "#091220");
  rect(106, 52, 6, 3, twinkleColor(time, "#8af0ff", "#4ca5ff"));
  rect(106, 57, 6, 1, "#8df1be");

  rect(90, 48, 2, 12, "#a8895d");
  rect(87, 44, 8, 5, twinkleColor(time * 1.2, "#ffd580", "#ffc04d"));

  rect(42, 42, 18, 3, "#7c6a4b");
  rect(44, 45, 2, 7, "#4c351f");
  rect(56, 45, 2, 7, "#4c351f");
  rect(46, 40, 10, 2, "#87cdb8");

  rect(112, 63, 4, 9, "#416740");
  rect(110, 60, 8, 5, "#8cd89b");
  rect(111, 58, 6, 3, "#6fbe79");

  rect(32, 69, 28, 4, "#a05d4f");
  rect(34, 71, 24, 2, "#ecb177");

  for (const agent of agents) {
    drawLobster(agent, time);
  }

  context.restore();
}

function drawObservationWindow(x, y, width, height, time, compact = false) {
  rect(x, y, width, height, "#92aee9");
  rect(x + 1, y + 1, width - 2, height - 2, "#0a1730");
  rect(x + 2, y + 2, width - 4, height - 4, "#081221");

  const stars = compact
    ? [
        [3, 3, "#fff6df", 0],
        [9, 5, "#8fe7ff", 1],
        [11, 9, "#fff6df", 2],
      ]
    : [
        [4, 4, "#fff6df", 0],
        [8, 8, "#8fe7ff", 1],
        [14, 5, "#fff6df", 2],
        [18, 9, "#7ebcff", 1],
        [10, 12, "#fff6df", 0],
        [20, 4, "#8fe7ff", 2],
      ];

  for (const [sx, sy, color, phase] of stars) {
    if ((Math.floor(time * 3) + phase) % 2 === 0) {
      rect(x + sx, y + sy, 1, 1, color);
    }
  }

  rect(x + 1, y + Math.floor(height / 2), width - 2, 1, "#8ea6dd");
  rect(x + Math.floor(width / 2), y + 1, 1, height - 2, "#8ea6dd");
}

function drawLobster(agent, time) {
  const x = Math.round(agent.slot.x / 4);
  const y = Math.round(agent.slot.y / 4);
  const motion = agent.status === "running" ? Math.sin(time * 8 + agent.seed) * 1.4 : Math.sin(time * 2.4 + agent.seed) * 0.6;
  const pulse = Math.sin(time * 9 + agent.seed) > 0 ? 1 : 0;
  const yPos = Math.round(y + motion);
  const bodyColor = pickBodyColor(agent.status);
  const outline = agent.status === "error" ? "#5f1d24" : "#1e1824";

  rect(x - 6, yPos + 5, 16, 2, "rgba(8, 9, 16, 0.55)");
  rect(x - 1, yPos - 2, 6, 6, bodyColor);
  rect(x - 5, yPos - 1, 4, 4, bodyColor);
  rect(x + 5, yPos - 1, 4, 4, bodyColor);
  rect(x - 7, yPos - 4, 4, 3, bodyColor);
  rect(x + 7, yPos - 4, 4, 3, bodyColor);
  rect(x - 3, yPos - 3, 2, 1, "#ffe1c9");
  rect(x + 2, yPos - 3, 2, 1, "#ffe1c9");
  rect(x - 2, yPos - 2, 1, 1, outline);
  rect(x + 2, yPos - 2, 1, 1, outline);

  rect(x - 2, yPos + 4, 1, 2 + pulse, bodyColor);
  rect(x + 1, yPos + 4, 1, 3 - pulse, bodyColor);
  rect(x + 4, yPos + 4, 1, 2 + pulse, bodyColor);

  drawStatusBubble(agent.status, x + 10, yPos - 12, time, agent.seed);

  const label = agent.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "AGENT";
  pixelText(label, x - Math.max(8, label.length * 2), yPos - 11, "#f5f1d9");
}

function drawStatusBubble(status, x, y, time, seed) {
  const bubbleWidth =
    status === "running" ? 10 : status === "error" ? 13 : status === "offline" ? 14 : 18;
  rect(x, y, bubbleWidth, 6, "#0e1528");
  rect(x + 1, y + 1, bubbleWidth - 2, 4, bubbleFill(status, time, seed));
  rect(x - 1, y + 5, 2, 2, "#0e1528");

  if (status === "running") {
    pixelText("GO", x + 2, y + 1, "#fff2c4");
    return;
  }

  if (status === "waiting") {
    pixelText("WAIT", x + 1, y + 1, "#d6ebff");
    return;
  }

  if (status === "error") {
    pixelText("ERR", x + 2, y + 1, "#ffd8d2");
    return;
  }

  if (status === "offline") {
    pixelText("OFF", x + 2, y + 1, "#dde3f1");
    return;
  }

  pixelText("IDLE", x + 1, y + 1, "#e2ffe4");
}

function bubbleFill(status, time, seed) {
  if (status === "running") {
    return twinkleColor(time + seed, "#ffbf68", "#ff9e4e");
  }
  if (status === "waiting") {
    return "#5c84d9";
  }
  if (status === "error") {
    return twinkleColor(time + seed, "#c3454a", "#ff8064");
  }
  if (status === "offline") {
    return "#4d576b";
  }
  return "#4e7d55";
}

function pickBodyColor(status) {
  if (status === "running") {
    return "#f59f52";
  }
  if (status === "waiting") {
    return "#7ebcff";
  }
  if (status === "error") {
    return "#ff8064";
  }
  if (status === "offline") {
    return "#7e8ca8";
  }
  return "#8fe39d";
}

function twinkleColor(time, colorA, colorB) {
  return Math.sin(time * 3.2) > 0 ? colorA : colorB;
}

function pixelText(text, x, y, color) {
  const chars = {
    A: ["010", "101", "111", "101", "101"],
    B: ["110", "101", "110", "101", "110"],
    C: ["011", "100", "100", "100", "011"],
    D: ["110", "101", "101", "101", "110"],
    E: ["111", "100", "110", "100", "111"],
    F: ["111", "100", "110", "100", "100"],
    G: ["011", "100", "101", "101", "011"],
    H: ["101", "101", "111", "101", "101"],
    I: ["111", "010", "010", "010", "111"],
    J: ["001", "001", "001", "101", "010"],
    K: ["101", "101", "110", "101", "101"],
    L: ["100", "100", "100", "100", "111"],
    M: ["101", "111", "111", "101", "101"],
    N: ["101", "111", "111", "111", "101"],
    O: ["111", "101", "101", "101", "111"],
    P: ["110", "101", "110", "100", "100"],
    Q: ["111", "101", "101", "111", "001"],
    R: ["110", "101", "110", "101", "101"],
    S: ["011", "100", "111", "001", "110"],
    T: ["111", "010", "010", "010", "010"],
    U: ["101", "101", "101", "101", "111"],
    V: ["101", "101", "101", "101", "010"],
    W: ["101", "101", "111", "111", "101"],
    X: ["101", "101", "010", "101", "101"],
    Y: ["101", "101", "010", "010", "010"],
    Z: ["111", "001", "010", "100", "111"],
    "0": ["111", "101", "101", "101", "111"],
    "1": ["010", "110", "010", "010", "111"],
    "2": ["111", "001", "111", "100", "111"],
    "3": ["111", "001", "111", "001", "111"],
    "4": ["101", "101", "111", "001", "001"],
    "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"],
    "7": ["111", "001", "001", "010", "010"],
    "8": ["111", "101", "111", "101", "111"],
    "9": ["111", "101", "111", "001", "111"],
  };

  let offset = 0;
  for (const character of text) {
    const pattern = chars[character] || chars.R;
    for (let row = 0; row < pattern.length; row += 1) {
      for (let column = 0; column < pattern[row].length; column += 1) {
        if (pattern[row][column] === "1") {
          rect(x + offset + column, y + row, 1, 1, color);
        }
      }
    }
    offset += 4;
  }
}

function rect(x, y, width, height, color) {
  context.fillStyle = color;
  context.fillRect(x, y, width, height);
}

function formatStatusText(value) {
  const normalized = normalizeStatusClass(value);
  if (normalized === "running") {
    return "running";
  }
  if (normalized === "waiting") {
    return "waiting";
  }
  if (normalized === "error") {
    return "error";
  }
  if (normalized === "offline") {
    return "offline";
  }
  return "idle";
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeStatusClass(value) {
  const normalized = String(value || "offline").toLowerCase();
  if (normalized.includes("run") || normalized.includes("active") || normalized.includes("busy")) {
    return "running";
  }
  if (normalized.includes("wait") || normalized.includes("queue")) {
    return "waiting";
  }
  if (normalized.includes("error") || normalized.includes("fail") || normalized.includes("degraded")) {
    return "error";
  }
  if (normalized.includes("stale") || normalized.includes("off")) {
    return "offline";
  }
  return "idle";
}

function stringHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 997;
  }
  return hash;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
