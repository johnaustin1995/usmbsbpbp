const gameTitle = document.getElementById("game-title");
const gameMeta = document.getElementById("game-meta");
const backLink = document.getElementById("back-link");
const refreshBtn = document.getElementById("refresh-btn");
const autoRefresh = document.getElementById("auto-refresh");
const playViewerLink = document.getElementById("play-viewer-link");
const scoreStrip = document.getElementById("score-strip");
const viewControls = document.getElementById("view-controls");
const statsRoot = document.getElementById("stats-root");

let gameId = null;
let currentView = "all";
let availableViews = [];
let refreshTimer = null;
let currentSummary = null;
let currentEvent = null;

init();

function init() {
  const params = new URLSearchParams(window.location.search);
  gameId = Number.parseInt(params.get("id") || "", 10);

  const date = params.get("date");
  if (date) {
    backLink.href = `/?date=${encodeURIComponent(normalizeDateInput(date) || date)}`;
  }

  if (!Number.isFinite(gameId)) {
    gameTitle.textContent = "Invalid Game";
    gameMeta.textContent = "A valid statbroadcast id is required.";
    renderStateMessage("Please open this page from a game card with live stats.");
    if (playViewerLink) {
      playViewerLink.hidden = true;
    }
    return;
  }

  refreshBtn.addEventListener("click", () => loadDashboard(currentView));
  autoRefresh.addEventListener("change", resetAutoRefresh);

  if (playViewerLink) {
    const params = new URLSearchParams({ id: String(gameId) });
    if (date) {
      params.set("date", normalizeDateInput(date) || date);
    }
    playViewerLink.href = `/play-by-play.html?${params.toString()}`;
  }

  preloadBranding();
  loadDashboard(currentView);
  resetAutoRefresh();
}

function preloadBranding() {
  if (!window.ncaabsbBranding?.load) {
    return;
  }

  window.ncaabsbBranding.load().then(() => {
    if (currentSummary) {
      renderHeader(currentSummary, currentEvent);
      renderScoreStrip(currentSummary);
    }
  });
}

async function loadDashboard(view) {
  setLoading(true);

  try {
    const payloads = await fetchViewPayloads(view);

    if (payloads.length === 0) {
      renderStateMessage("No stat sections available for this game yet.");
      return;
    }

    const summary = payloads[0].summary;
    currentSummary = summary;
    currentEvent = payloads[0].event;
    renderHeader(summary, payloads[0].event);
    renderScoreStrip(summary);

    const firstAvailable = payloads[0].availableViews || [];
    if (firstAvailable.length > 0) {
      availableViews = firstAvailable;
      renderViewControls();
    }

    renderStatsBlocks(payloads);
  } catch (error) {
    gameMeta.textContent = `Error: ${error instanceof Error ? error.message : "Failed to load"}`;
    renderStateMessage("Could not fetch game stats. Try refreshing.");
  } finally {
    setLoading(false);
  }
}

async function fetchViewPayloads(view) {
  if (view !== "all") {
    const single = await fetchStatsView(view);
    return [single];
  }

  const first = await fetchStatsView("game");
  const supported = Array.isArray(first.availableViews) ? first.availableViews : [];
  const views = supported.filter((name) => name !== "notes");

  if (views.length === 0) {
    return [first];
  }

  const others = await Promise.all(
    views
      .filter((name) => name !== "game")
      .map(async (name) => {
        try {
          return await fetchStatsView(name);
        } catch {
          return null;
        }
      })
  );

  return [first, ...others.filter((entry) => entry !== null)];
}

async function fetchStatsView(view) {
  const params = new URLSearchParams({
    view,
    _: String(Date.now()),
  });

  const response = await fetch(
    `/api/live/${encodeURIComponent(String(gameId))}/stats?${params.toString()}`,
    {
      headers: { Accept: "application/json" },
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new Error(`Stats request failed (${response.status})`);
  }

  return response.json();
}

function renderHeader(summary, event) {
  const away = summary?.visitorTeam || event?.visitorName || "Away";
  const home = summary?.homeTeam || event?.homeName || "Home";

  gameTitle.textContent = `${away} at ${home}`;
  const fetchedAt = summary?.fetchedAt ? new Date(summary.fetchedAt).toLocaleTimeString() : "";
  const status = summary?.statusText || "Live";
  gameMeta.textContent = fetchedAt ? `${status} • Updated ${fetchedAt}` : status;
}

function renderScoreStrip(summary) {
  scoreStrip.innerHTML = "";

  const teams = [
    { label: "Away", name: summary.visitorTeam, score: summary.visitorScore },
    { label: "Home", name: summary.homeTeam, score: summary.homeScore },
  ];

  teams.forEach((team) => {
    const branding = resolveTeamBranding(team.name);
    scoreStrip.appendChild(renderScoreTeamBlock(team, branding));
  });

  const status = document.createElement("div");
  status.className = "score-status";
  status.innerHTML = `
    <p class="score-label">Status</p>
    <p class="score-name">${escapeHtml(summary.statusText || "Live")}</p>
    <p class="score-value small">${escapeHtml(summary.thisInning?.label || "")}</p>
  `;
  scoreStrip.appendChild(status);
}

function renderScoreTeamBlock(team, branding) {
  const block = document.createElement("div");
  block.className = "score-team";

  const label = document.createElement("p");
  label.className = "score-label";
  label.textContent = team.label;

  const nameWrap = document.createElement("div");
  nameWrap.className = "score-name-wrap";

  const logoPath = window.ncaabsbBranding?.chooseLogo
    ? window.ncaabsbBranding.chooseLogo(branding)
    : null;
  if (logoPath) {
    const logo = document.createElement("img");
    logo.className = "score-team-logo";
    logo.loading = "lazy";
    logo.decoding = "async";
    logo.referrerPolicy = "no-referrer";
    logo.src = logoPath;
    logo.alt = `${team.name || "Team"} logo`;
    nameWrap.appendChild(logo);
  }

  const name = document.createElement("p");
  name.className = "score-name";
  name.textContent = team.name || "-";
  nameWrap.appendChild(name);

  const value = document.createElement("p");
  value.className = "score-value";
  value.textContent = Number.isFinite(team.score) ? String(team.score) : "-";

  block.appendChild(label);
  block.appendChild(nameWrap);
  block.appendChild(value);

  applyScoreTeamBranding(block, branding);
  return block;
}

function renderViewControls() {
  viewControls.innerHTML = "";

  const allButton = makeViewButton("all", "All Views");
  viewControls.appendChild(allButton);

  availableViews.forEach((viewName) => {
    const label = viewName.replace(/_/g, " ");
    viewControls.appendChild(makeViewButton(viewName, toTitleCase(label)));
  });
}

function makeViewButton(value, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `view-btn ${currentView === value ? "active" : ""}`;
  button.textContent = label;
  button.addEventListener("click", () => {
    if (currentView === value) {
      return;
    }

    currentView = value;
    renderViewControls();
    loadDashboard(currentView);
  });

  return button;
}

function renderStatsBlocks(payloads) {
  statsRoot.innerHTML = "";

  payloads.forEach((payload) => {
    const viewBlock = document.createElement("section");
    viewBlock.className = "stats-view-block";

    const viewTitle = document.createElement("h3");
    viewTitle.className = "view-title";
    viewTitle.textContent = toTitleCase((payload.view || "stats").replace(/_/g, " "));
    viewBlock.appendChild(viewTitle);

    const sections = Array.isArray(payload.sections) ? payload.sections : [];
    if (sections.length === 0) {
      const empty = document.createElement("p");
      empty.className = "state-message";
      empty.textContent = "No tables available for this view yet.";
      viewBlock.appendChild(empty);
      statsRoot.appendChild(viewBlock);
      return;
    }

    sections.forEach((section) => {
      const sectionEl = document.createElement("article");
      sectionEl.className = "stats-section";

      const title = document.createElement("h4");
      title.className = "stats-section-title";
      title.textContent = section.title;
      sectionEl.appendChild(title);

      const tables = Array.isArray(section.tables) ? section.tables : [];
      tables.forEach((table) => {
        sectionEl.appendChild(renderTable(table));
      });

      viewBlock.appendChild(sectionEl);
    });

    statsRoot.appendChild(viewBlock);
  });
}

function renderTable(table) {
  const wrap = document.createElement("div");
  wrap.className = "stats-table-wrap";

  const tableEl = document.createElement("table");
  tableEl.className = "stats-table";

  if (Array.isArray(table.headers) && table.headers.length > 0) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    table.headers.forEach((header) => {
      const th = document.createElement("th");
      th.textContent = header || "";
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    tableEl.appendChild(thead);
  }

  const tbody = document.createElement("tbody");
  const rows = Array.isArray(table.rows) ? table.rows : [];
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const cells = Array.isArray(row.cells) ? row.cells : [];
    cells.forEach((cell) => {
      const td = document.createElement("td");
      td.textContent = cell === null || typeof cell === "undefined" ? "" : String(cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tableEl.appendChild(tbody);

  wrap.appendChild(tableEl);
  return wrap;
}

function renderStateMessage(message) {
  statsRoot.innerHTML = "";
  const box = document.createElement("div");
  box.className = "state-message";
  box.textContent = message;
  statsRoot.appendChild(box);
}

function setLoading(isLoading) {
  refreshBtn.disabled = isLoading;
  if (isLoading) {
    refreshBtn.textContent = "Loading...";
  } else {
    refreshBtn.textContent = "Refresh Now";
  }
}

function resetAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  if (autoRefresh.checked) {
    refreshTimer = setInterval(() => loadDashboard(currentView), 20000);
  }
}

function toTitleCase(value) {
  return String(value)
    .split(" ")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function normalizeDateInput(value) {
  if (!value) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }

  return null;
}

function resolveTeamBranding(teamName) {
  if (!window.ncaabsbBranding?.lookup) {
    return null;
  }

  return window.ncaabsbBranding.lookup(teamName);
}

function applyScoreTeamBranding(block, branding) {
  const safeColor = window.ncaabsbBranding?.safeColor;
  const primary = safeColor ? safeColor(branding?.colors?.primary) : null;
  const secondary = safeColor ? safeColor(branding?.colors?.secondary) : null;

  if (!primary) {
    block.classList.remove("team-branded");
    block.style.removeProperty("--team-color");
    block.style.removeProperty("--team-color-soft");
    return;
  }

  block.classList.add("team-branded");
  block.style.setProperty("--team-color", primary);
  block.style.setProperty(
    "--team-color-soft",
    toRgba(secondary || primary, secondary ? 0.14 : 0.12)
  );
}

function toRgba(hex, alpha) {
  const clean = String(hex || "").replace(/^#/u, "");
  if (!/^[0-9a-fA-F]{6}$/u.test(clean)) {
    return "transparent";
  }

  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
