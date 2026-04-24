const elements = {
  agentsGrid: document.getElementById("agents-grid"),
  signalsCounter: document.querySelector(".voxyz-signals-counter"),
  toggleButton: document.getElementById("toggle-demo"),
};

const agentRoles = {
  Nexus: "Coordinator",
  Scout: "Growth & Distribution",
  Quill: "Content & Brand",
  Forge: "Engineering",
  Guide: "Community & Support"
};

const demoData = {
  summary: {
    agentCount: 5,
    runningCount: 2,
    waitingCount: 1,
    errorCount: 0,
    tokenTotals: { total: 1234 },
    sourceCount: 1,
    freshSourceCount: 1
  },
  agents: [
    { id: "nexus-1", name: "Nexus", status: "Resting" },
    { id: "scout-1", name: "Scout", status: "Researching" },
    { id: "quill-1", name: "Quill", status: "Writing" },
    { id: "forge-1", name: "Forge", status: "Analyzing" },
    { id: "guide-1", name: "Guide", status: "Resting" }
  ]
};

const appState = {
  snapshot: null,
  connection: "connecting",
  useDemo: false,
};

init();

async function init() {
  // Add event listener for toggle button
  if (elements.toggleButton) {
    elements.toggleButton.addEventListener("click", toggleDemoMode);
  }
  
  await refreshSnapshot();
  connectToEvents();
}

async function refreshSnapshot() {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Snapshot request failed with ${response.status}`);
    }

    appState.useDemo = false;
    updateToggleButton();
    applySnapshot(await response.json());
  } catch (error) {
    appState.connection = "offline";
    appState.useDemo = true;
    updateToggleButton();
    applySnapshot(demoData);
    console.error(error);
  }
}

function connectToEvents() {
  const events = new EventSource("/api/events");

  events.onopen = () => {
    appState.connection = "live";
    appState.useDemo = false;
    updateToggleButton();
  };

  events.addEventListener("snapshot", (event) => {
    appState.connection = "live";
    appState.useDemo = false;
    updateToggleButton();
    applySnapshot(JSON.parse(event.data));
  });

  events.addEventListener("heartbeat", (event) => {
    applySnapshot(JSON.parse(event.data));
  });

  events.onerror = () => {
    appState.connection = "reconnecting";
    if (!appState.useDemo) {
      appState.useDemo = true;
      updateToggleButton();
      applySnapshot(demoData);
    }
  };
}

function toggleDemoMode() {
  appState.useDemo = !appState.useDemo;
  updateToggleButton();
  
  if (appState.useDemo) {
    applySnapshot(demoData);
  } else {
    refreshSnapshot();
  }
}

function updateToggleButton() {
  if (elements.toggleButton) {
    elements.toggleButton.textContent = appState.useDemo ? "Connect to OpenClaw" : "Use Demo Data";
  }
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
