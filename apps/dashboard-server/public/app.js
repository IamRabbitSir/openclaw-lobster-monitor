const elements = {
  agentsGrid: document.getElementById("agents-grid"),
  signalsCounter: document.querySelector(".voxyz-signals-counter"),
};

const agentRoles = {
  Nexus: "Coordinator",
  Scout: "Growth & Distribution",
  Quill: "Content & Brand",
  Forge: "Engineering",
  Guide: "Community & Support"
};

const appState = {
  snapshot: null,
  connection: "connecting",
};

init();

async function init() {
  await refreshSnapshot();
  connectToEvents();
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
    console.error(error);
  }
}

function connectToEvents() {
  const events = new EventSource("/api/events");

  events.onopen = () => {
    appState.connection = "live";
  };

  events.addEventListener("snapshot", (event) => {
    appState.connection = "live";
    applySnapshot(JSON.parse(event.data));
  });

  events.addEventListener("heartbeat", (event) => {
    applySnapshot(JSON.parse(event.data));
  });

  events.onerror = () => {
    appState.connection = "reconnecting";
  };
}

function applySnapshot(snapshot) {
  appState.snapshot = snapshot;

  const summary = snapshot.summary || {
    agentCount: 0,
    runningCount: 0,
    waitingCount: 0,
    errorCount: 0,
    tokenTotals: { total: 0 },
    sourceCount: 0,
    freshSourceCount: 0,
  };

  // Update signals counter
  elements.signalsCounter.textContent = `${summary.tokenTotals?.total || 0} signals processed today`;

  // Render agents
  renderAgents(snapshot.agents || []);
}

function renderAgents(agents) {
  if (!agents.length) {
    elements.agentsGrid.innerHTML = "<div class='voxyz-empty-state'>No agents available</div>";
    return;
  }

  // Map agent names to match the design
  const agentMap = {
    Nexus: { avatar: "https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=minion%20robot%20coordinator%20avatar&image_size=square", status: "Resting" },
    Scout: { avatar: "https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=minion%20robot%20scout%20avatar&image_size=square", status: "Researching" },
    Quill: { avatar: "https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=minion%20robot%20writer%20avatar&image_size=square", status: "Writing" },
    Forge: { avatar: "https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=minion%20robot%20engineer%20avatar&image_size=square", status: "Analyzing" },
    Guide: { avatar: "https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=minion%20robot%20guide%20avatar&image_size=square", status: "Resting" }
  };

  elements.agentsGrid.innerHTML = Object.entries(agentMap)
    .map(([name, data]) => {
      const role = agentRoles[name] || "Unknown";
      const status = data.status || "Resting";
      const avatar = data.avatar;
      
      // Generate random badge color based on agent name
      const badgeColors = ["#4caf50", "#2196f3", "#ff9800", "#9c27b0", "#f44336"];
      const badgeColor = badgeColors[hashCode(name) % badgeColors.length];
      
      return `
        <div class="voxyz-agent-card">
          <div class="voxyz-agent-avatar">
            <img src="${avatar}" alt="${name}">
            <div class="voxyz-agent-badge" style="background-color: ${badgeColor}">
              ${name.charAt(0)}
            </div>
          </div>
          <h3 class="voxyz-agent-name">${name}</h3>
          <p class="voxyz-agent-role">${role}</p>
          <span class="voxyz-agent-status ${status}">${status}</span>
          <div class="voxyz-agent-events">1 events</div>
        </div>
      `;
    })
    .join("");
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
