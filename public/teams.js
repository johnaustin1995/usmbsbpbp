const metaEl = document.getElementById("teams-meta");
const filtersForm = document.getElementById("teams-filters");
const searchInput = document.getElementById("teams-search");
const conferenceSelect = document.getElementById("teams-conference");
const clearBtn = document.getElementById("teams-clear");
const countEl = document.getElementById("teams-count");
const listRoot = document.getElementById("teams-list");
const detailRoot = document.getElementById("team-detail");

let directoryPayload = null;
let teams = [];
let filteredTeams = [];
let selectedTeamKey = null;
const teamCache = new Map();

init();

function init() {
  preloadBranding();

  searchInput.addEventListener("input", () => {
    applyFilters();
    syncUrl();
  });

  conferenceSelect.addEventListener("change", () => {
    applyFilters();
    syncUrl();
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    conferenceSelect.value = "";
    applyFilters();
    syncUrl();
  });

  filtersForm.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  hydrateFiltersFromUrl();
  loadTeamsDirectory();
}

function preloadBranding() {
  if (!window.ncaabsbBranding?.load) {
    return;
  }

  window.ncaabsbBranding.load().then(() => {
    if (directoryPayload) {
      renderDirectoryList();
    }
  });
}

function hydrateFiltersFromUrl() {
  const params = new URLSearchParams(window.location.search);
  searchInput.value = params.get("q") || "";
}

async function loadTeamsDirectory() {
  setMeta("Loading teams data...");
  setStateMessage(detailRoot, "Loading team details...");

  try {
    const response = await fetch(`/api/teams?slim=true&_=${Date.now()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Teams request failed (${response.status})`);
    }

    directoryPayload = await response.json();
    teams = Array.isArray(directoryPayload.teams) ? directoryPayload.teams : [];
    hydrateConferenceSelect(directoryPayload.conferences);
    applyFilters();

    const urlTeam = new URLSearchParams(window.location.search).get("team");
    const initialKey = urlTeam || (filteredTeams[0] ? getTeamKey(filteredTeams[0]) : null);
    if (initialKey) {
      selectTeam(initialKey, { sync: false });
    } else {
      setStateMessage(detailRoot, "No teams matched your filters.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load teams";
    setMeta(`Error: ${message}`);
    setStateMessage(detailRoot, "Could not load teams data.");
  }
}

function hydrateConferenceSelect(conferences) {
  const options = Array.isArray(conferences) ? conferences : [];
  const current = new URLSearchParams(window.location.search).get("conference") || "";

  conferenceSelect.innerHTML = `<option value="">All conferences</option>`;
  options
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .forEach((conference) => {
      const option = document.createElement("option");
      option.value = String(conference.slug || "");
      option.textContent = String(conference.name || "Unknown");
      conferenceSelect.appendChild(option);
    });

  if (current && Array.from(conferenceSelect.options).some((option) => option.value === current)) {
    conferenceSelect.value = current;
  }
}

function applyFilters() {
  const query = normalizeSearch(searchInput.value);
  const conferenceSlug = conferenceSelect.value.trim().toLowerCase();

  filteredTeams = teams
    .filter((team) => {
      const conferenceMatch =
        !conferenceSlug ||
        String(team?.conference?.slug || "")
          .toLowerCase()
          .trim() === conferenceSlug;
      if (!conferenceMatch) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystacks = [
        team?.name,
        team?.conference?.name,
        team?.slug,
        String(team?.id ?? ""),
      ];
      return haystacks.some((value) => normalizeSearch(value).includes(query));
    })
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

  renderDirectoryList();

  if (!filteredTeams.some((team) => getTeamKey(team) === selectedTeamKey)) {
    if (filteredTeams[0]) {
      selectTeam(getTeamKey(filteredTeams[0]), { sync: false });
    } else {
      selectedTeamKey = null;
      setStateMessage(detailRoot, "No teams matched your filters.");
    }
  }
}

function renderDirectoryList() {
  listRoot.innerHTML = "";
  countEl.textContent = `${filteredTeams.length} team${filteredTeams.length === 1 ? "" : "s"}`;

  const season = directoryPayload?.season || "Unknown season";
  const file = directoryPayload?.file ? ` • ${directoryPayload.file}` : "";
  setMeta(`Season ${season} • ${teams.length} total teams${file}`);

  if (filteredTeams.length === 0) {
    setStateMessage(listRoot, "No teams matched your filters.");
    return;
  }

  const fragment = document.createDocumentFragment();
  filteredTeams.forEach((team) => {
    const key = getTeamKey(team);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "teams-list-item";
    if (key === selectedTeamKey) {
      button.classList.add("active");
    }
    button.dataset.teamKey = key;

    const branding = resolveTeamBranding(team.name);
    applyTeamBadgeBranding(button, branding);

    const logo = pickLogoPath(team, branding);
    if (logo) {
      const logoImg = document.createElement("img");
      logoImg.className = "teams-list-logo";
      logoImg.loading = "lazy";
      logoImg.decoding = "async";
      logoImg.referrerPolicy = "no-referrer";
      logoImg.src = logo;
      logoImg.alt = `${team.name || "Team"} logo`;
      button.appendChild(logoImg);
    }

    const textWrap = document.createElement("span");
    textWrap.className = "teams-list-text";

    const nameEl = document.createElement("span");
    nameEl.className = "teams-list-name";
    nameEl.textContent = team.name || "Unknown Team";
    textWrap.appendChild(nameEl);

    const metaEl = document.createElement("span");
    metaEl.className = "teams-list-meta";
    const conferenceName = team?.conference?.name || "Independent";
    metaEl.textContent = `${conferenceName} • ${team.scheduleCount || 0} games`;
    textWrap.appendChild(metaEl);

    button.appendChild(textWrap);
    button.addEventListener("click", () => {
      selectTeam(key);
    });

    fragment.appendChild(button);
  });

  listRoot.appendChild(fragment);
}

async function selectTeam(teamKey, options = {}) {
  const { sync = true } = options;
  selectedTeamKey = teamKey;
  highlightSelectedTeam();

  try {
    const team = await loadTeam(teamKey);
    renderTeamDetail(team);
    if (sync) {
      syncUrl();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load team details";
    setStateMessage(detailRoot, message);
  }
}

function highlightSelectedTeam() {
  listRoot.querySelectorAll(".teams-list-item").forEach((node) => {
    node.classList.toggle("active", node.dataset.teamKey === selectedTeamKey);
  });
}

async function loadTeam(teamKey) {
  const cached = teamCache.get(teamKey);
  if (cached) {
    return cached;
  }

  setStateMessage(detailRoot, "Loading team details...");
  const response = await fetch(`/api/teams?team=${encodeURIComponent(teamKey)}&_=${Date.now()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Team request failed (${response.status})`);
  }

  const payload = await response.json();
  if (!payload?.team) {
    throw new Error("Team payload was empty.");
  }

  const resolvedKey = getTeamKey(payload.team);
  teamCache.set(resolvedKey, payload.team);
  teamCache.set(teamKey, payload.team);
  return payload.team;
}

function renderTeamDetail(team) {
  detailRoot.innerHTML = "";

  const header = document.createElement("header");
  header.className = "team-hero";

  const branding = resolveTeamBranding(team.name);
  applyTeamBadgeBranding(header, branding);

  const logo = pickLogoPath(team, branding);
  if (logo) {
    const logoImg = document.createElement("img");
    logoImg.className = "team-hero-logo";
    logoImg.loading = "lazy";
    logoImg.decoding = "async";
    logoImg.referrerPolicy = "no-referrer";
    logoImg.src = logo;
    logoImg.alt = `${team.name || "Team"} logo`;
    header.appendChild(logoImg);
  }

  const titleWrap = document.createElement("div");
  titleWrap.className = "team-hero-title";

  const title = document.createElement("h2");
  title.textContent = team.name || "Unknown Team";
  titleWrap.appendChild(title);

  const conference = document.createElement("p");
  conference.className = "team-hero-conference";
  conference.textContent = team?.conference?.name || "Independent";
  titleWrap.appendChild(conference);
  header.appendChild(titleWrap);

  const links = document.createElement("div");
  links.className = "team-hero-links";
  links.appendChild(makeExternalLink(team.teamUrl, "Overview"));
  links.appendChild(makeExternalLink(team.scheduleUrl, "Full Schedule"));
  links.appendChild(makeExternalLink(team.statsUrl, "D1 Stats"));
  header.appendChild(links);

  detailRoot.appendChild(header);

  const summary = document.createElement("section");
  summary.className = "team-summary-grid";
  summary.appendChild(makeSummaryItem("Season", team.season || "-"));
  summary.appendChild(makeSummaryItem("Schedule Games", String(team.schedule?.length || 0)));
  summary.appendChild(makeSummaryItem("Stats Tables", String(team.statsTables?.length || 0)));
  summary.appendChild(makeSummaryItem("Scrape Errors", String(team.errors?.length || 0)));
  detailRoot.appendChild(summary);

  if (Array.isArray(team.errors) && team.errors.length > 0) {
    const errorList = document.createElement("ul");
    errorList.className = "team-errors";
    team.errors.forEach((errorMessage) => {
      const li = document.createElement("li");
      li.textContent = errorMessage;
      errorList.appendChild(li);
    });
    detailRoot.appendChild(errorList);
  }

  detailRoot.appendChild(renderScheduleSection(team.schedule));
  detailRoot.appendChild(renderStatsSection(team.statsTables));
}

function renderScheduleSection(schedule) {
  const section = document.createElement("section");
  section.className = "team-block";

  const heading = document.createElement("h3");
  heading.textContent = "Schedule";
  section.appendChild(heading);

  if (!Array.isArray(schedule) || schedule.length === 0) {
    const empty = document.createElement("p");
    empty.className = "state-message";
    empty.textContent = "No schedule rows were available.";
    section.appendChild(empty);
    return section;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "stats-table-wrap";
  const table = document.createElement("table");
  table.className = "stats-table";

  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>Date</th><th>Loc</th><th>Opponent</th><th>Result</th><th>Notes</th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  schedule.forEach((game) => {
    const tr = document.createElement("tr");

    tr.appendChild(makeCell(game.dateLabel));
    tr.appendChild(makeCell(game.locationType));

    const opponentCell = document.createElement("td");
    if (game.opponentSlug) {
      const link = document.createElement("a");
      link.href = `/teams.html?team=${encodeURIComponent(game.opponentSlug)}`;
      link.textContent = game.opponentName || game.opponentSlug;
      opponentCell.appendChild(link);
    } else {
      opponentCell.textContent = game.opponentName || "-";
    }
    tr.appendChild(opponentCell);

    const resultCell = document.createElement("td");
    resultCell.className = `schedule-outcome ${game.outcome || "unknown"}`;
    if (game.resultUrl) {
      const resultLink = document.createElement("a");
      resultLink.href = game.resultUrl;
      resultLink.target = "_blank";
      resultLink.rel = "noopener noreferrer";
      resultLink.textContent = game.resultText || "-";
      resultCell.appendChild(resultLink);
    } else {
      resultCell.textContent = game.resultText || "-";
    }
    tr.appendChild(resultCell);

    tr.appendChild(makeCell(game.notes));
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  section.appendChild(tableWrap);
  return section;
}

function renderStatsSection(statsTables) {
  const section = document.createElement("section");
  section.className = "team-block";

  const heading = document.createElement("h3");
  heading.textContent = "Season Stats";
  section.appendChild(heading);

  if (!Array.isArray(statsTables) || statsTables.length === 0) {
    const empty = document.createElement("p");
    empty.className = "state-message";
    empty.textContent = "No stats tables were available.";
    section.appendChild(empty);
    return section;
  }

  const groups = groupTables(statsTables);
  groups.forEach((group) => {
    const groupBlock = document.createElement("article");
    groupBlock.className = "team-stats-group";

    const groupTitle = document.createElement("h4");
    groupTitle.textContent = group.name;
    groupBlock.appendChild(groupTitle);

    group.tables.forEach((table) => {
      const wrap = document.createElement("details");
      wrap.className = "team-stats-table";
      wrap.open = false;

      const summary = document.createElement("summary");
      summary.textContent = formatTableLabel(table);
      wrap.appendChild(summary);

      const tableWrap = document.createElement("div");
      tableWrap.className = "stats-table-wrap";

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
        (Array.isArray(row.cells) ? row.cells : []).forEach((cell) => {
          tr.appendChild(makeCell(cell));
        });
        tbody.appendChild(tr);
      });
      tableEl.appendChild(tbody);

      tableWrap.appendChild(tableEl);
      wrap.appendChild(tableWrap);
      groupBlock.appendChild(wrap);
    });

    section.appendChild(groupBlock);
  });

  return section;
}

function groupTables(statsTables) {
  const map = new Map();
  statsTables.forEach((table) => {
    const name = (table?.group || "Other").trim() || "Other";
    if (!map.has(name)) {
      map.set(name, []);
    }
    map.get(name).push(table);
  });

  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, tables]) => ({
      name,
      tables,
    }));
}

function formatTableLabel(table) {
  const parts = [];
  if (table.id) {
    parts.push(table.id);
  }
  if (table.section && table.section !== table.id) {
    parts.push(table.section);
  }
  const count = Array.isArray(table.rows) ? table.rows.length : 0;
  parts.push(`${count} row${count === 1 ? "" : "s"}`);
  return parts.join(" • ");
}

function makeSummaryItem(label, value) {
  const block = document.createElement("div");
  block.className = "team-summary-item";

  const labelEl = document.createElement("p");
  labelEl.className = "team-summary-label";
  labelEl.textContent = label;
  block.appendChild(labelEl);

  const valueEl = document.createElement("p");
  valueEl.className = "team-summary-value";
  valueEl.textContent = value;
  block.appendChild(valueEl);
  return block;
}

function makeExternalLink(href, text) {
  const link = document.createElement("a");
  link.className = "ghost-btn game-action-link";
  link.href = href || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = text;
  return link;
}

function makeCell(value) {
  const td = document.createElement("td");
  td.textContent = value === null || value === undefined || value === "" ? "-" : String(value);
  return td;
}

function setStateMessage(root, message) {
  root.innerHTML = "";
  const node = document.createElement("p");
  node.className = "state-message";
  node.textContent = message;
  root.appendChild(node);
}

function setMeta(text) {
  metaEl.textContent = text;
}

function syncUrl() {
  const params = new URLSearchParams();
  const query = searchInput.value.trim();
  const conference = conferenceSelect.value.trim();
  if (query) {
    params.set("q", query);
  }
  if (conference) {
    params.set("conference", conference);
  }
  if (selectedTeamKey) {
    params.set("team", selectedTeamKey);
  }

  const queryString = params.toString();
  const nextUrl = queryString ? `/teams.html?${queryString}` : "/teams.html";
  window.history.replaceState(null, "", nextUrl);
}

function getTeamKey(team) {
  if (team?.slug) {
    return String(team.slug);
  }
  if (Number.isFinite(team?.id)) {
    return String(team.id);
  }
  return normalizeSearch(team?.name || "");
}

function pickLogoPath(team, branding) {
  const chooseLogo = window.ncaabsbBranding?.chooseLogo;
  const logoFromBranding = chooseLogo ? chooseLogo(branding) : null;
  return logoFromBranding || team?.logoUrl || null;
}

function resolveTeamBranding(teamName) {
  const lookup = window.ncaabsbBranding?.lookup;
  return lookup ? lookup(teamName || "") : null;
}

function applyTeamBadgeBranding(node, branding) {
  if (!node || !branding || !window.ncaabsbBranding?.safeColor) {
    return;
  }

  const safeColor = window.ncaabsbBranding.safeColor(branding.color?.primary);
  if (!safeColor) {
    return;
  }

  node.style.setProperty("--team-color", safeColor);
  node.style.setProperty("--team-color-soft", `${safeColor}20`);
  node.classList.add("team-branded");
}

function normalizeSearch(value) {
  if (window.ncaabsbBranding?.normalizeTeamName) {
    return window.ncaabsbBranding.normalizeTeamName(value || "");
  }
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
