const TEAM_NAME = "Southern Miss";
const EMPTY_PHOTO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 220'%3E%3Crect width='320' height='220' fill='%23101825'/%3E%3Ccircle cx='160' cy='78' r='38' fill='%23212f46'/%3E%3Crect x='82' y='128' width='156' height='62' rx='30' fill='%23212f46'/%3E%3C/svg%3E";

const params = new URLSearchParams(window.location.search);
const season = params.get("season") || "2026";
const page = document.body?.dataset?.page || "home";

const state = {
  rosterPlayers: [],
  filteredPlayers: [],
};

const elements = {
  siteLogo: document.getElementById("site-logo"),
  upcomingMeta: document.getElementById("upcoming-meta"),
  upcomingList: document.getElementById("upcoming-list"),
  newsMeta: document.getElementById("news-meta"),
  newsGrid: document.getElementById("news-grid"),
  scheduleMeta: document.getElementById("schedule-meta"),
  scheduleBody: document.getElementById("schedule-body"),
  rosterSearch: document.getElementById("roster-search"),
  rosterMeta: document.getElementById("roster-meta"),
  rosterGrid: document.getElementById("roster-grid"),
  statsMeta: document.getElementById("stats-meta"),
  teamRecord: document.getElementById("team-record"),
  teamAvg: document.getElementById("team-avg"),
  teamOps: document.getElementById("team-ops"),
  teamEra: document.getElementById("team-era"),
  teamWhip: document.getElementById("team-whip"),
  statsHittingBody: document.getElementById("stats-hitting-body"),
  statsPitchingBody: document.getElementById("stats-pitching-body"),
};

init();

async function init() {
  setActiveNav();

  try {
    await window.ncaabsbBranding?.load?.();
  } catch {
    // Continue with fallback logo behavior.
  }

  renderLogo();

  if (page === "home") {
    await Promise.all([loadHomeUpcomingGames(), loadHomeNews()]);
    return;
  }

  if (page === "schedule") {
    await loadSchedulePage();
    return;
  }

  if (page === "roster") {
    await loadRosterPage();
    return;
  }

  if (page === "stats") {
    await loadStatsPage();
  }
}

function setActiveNav() {
  const active = document.querySelector(`[data-nav="${page}"]`);
  active?.classList.add("is-active");
}

function renderLogo() {
  if (!elements.siteLogo) {
    return;
  }

  const branding = window.ncaabsbBranding?.lookup?.(TEAM_NAME) || null;
  const logo = window.ncaabsbBranding?.chooseLogo?.(branding, { preferDark: false }) || null;
  if (logo) {
    elements.siteLogo.src = logo;
  } else {
    elements.siteLogo.hidden = true;
  }
}

async function loadHomeUpcomingGames() {
  if (!elements.upcomingMeta || !elements.upcomingList) {
    return;
  }

  try {
    const payload = await fetchJson("/api/usm/schedule");
    const games = Array.isArray(payload?.games) ? payload.games : [];
    const upcoming = pickUpcomingGames(games, 5);

    if (upcoming.length === 0) {
      elements.upcomingMeta.textContent = "No upcoming games found.";
      elements.upcomingList.innerHTML = `<p class="empty-state">Schedule data is available but no future games were detected.</p>`;
      return;
    }

    elements.upcomingMeta.textContent = `${upcoming.length} upcoming game${upcoming.length === 1 ? "" : "s"}`;
    const fragment = document.createDocumentFragment();

    for (const game of upcoming) {
      const card = document.createElement("article");
      card.className = "game-card";

      const date = document.createElement("p");
      date.className = "game-date";
      date.textContent = formatGameDate(game);
      card.appendChild(date);

      const matchup = document.createElement("p");
      matchup.className = "game-matchup";
      matchup.textContent = `${cleanTeamName(game.awayTeam)} at ${cleanTeamName(game.homeTeam)}`;
      card.appendChild(matchup);

      const status = document.createElement("p");
      status.className = "game-status";
      status.textContent = cleanText(game.statusText) || "Scheduled";
      card.appendChild(status);

      if (toPositiveInt(game.gameId)) {
        const link = document.createElement("a");
        link.className = "game-link";
        link.href = `/usm-live-169.html?id=${game.gameId}`;
        link.textContent = "Open Live Viewer";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.appendChild(link);
      }

      fragment.appendChild(card);
    }

    elements.upcomingList.innerHTML = "";
    elements.upcomingList.appendChild(fragment);
  } catch (error) {
    const message = getErrorMessage(error);
    elements.upcomingMeta.textContent = "Failed to load upcoming games.";
    elements.upcomingList.innerHTML = `<p class="empty-state">${escapeHtml(message)}</p>`;
  }
}

async function loadHomeNews() {
  if (!elements.newsMeta || !elements.newsGrid) {
    return;
  }

  try {
    const payload = await fetchJson("/api/usm/news?limit=8");
    const items = Array.isArray(payload?.items) ? payload.items : [];

    if (items.length === 0) {
      elements.newsMeta.textContent = "No recent news detected.";
      elements.newsGrid.innerHTML = `<p class="empty-state">No recent baseball news was found.</p>`;
      return;
    }

    elements.newsMeta.textContent = `Showing ${items.length} recent story${items.length === 1 ? "" : "ies"}`;
    const fragment = document.createDocumentFragment();

    for (const item of items) {
      const card = document.createElement("article");
      card.className = "news-card";

      const link = document.createElement("a");
      link.className = "news-link";
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      const imageWrap = document.createElement("div");
      imageWrap.className = "news-image-wrap";
      const image = document.createElement("img");
      image.className = "news-image";
      image.loading = "lazy";
      image.alt = item.title || "Southern Miss news";
      image.src = item.imageUrl || EMPTY_PHOTO;
      image.onerror = () => {
        image.src = EMPTY_PHOTO;
      };
      imageWrap.appendChild(image);
      link.appendChild(imageWrap);

      const body = document.createElement("div");
      body.className = "news-body";

      const date = document.createElement("p");
      date.className = "news-date";
      date.textContent = formatNewsDate(item);
      body.appendChild(date);

      const title = document.createElement("p");
      title.className = "news-title";
      title.textContent = item.title || "Untitled Story";
      body.appendChild(title);

      link.appendChild(body);
      card.appendChild(link);
      fragment.appendChild(card);
    }

    elements.newsGrid.innerHTML = "";
    elements.newsGrid.appendChild(fragment);
  } catch (error) {
    const message = getErrorMessage(error);
    elements.newsMeta.textContent = "Failed to load baseball news.";
    elements.newsGrid.innerHTML = `<p class="empty-state">${escapeHtml(message)}</p>`;
  }
}

async function loadSchedulePage() {
  if (!elements.scheduleMeta || !elements.scheduleBody) {
    return;
  }

  try {
    const payload = await fetchJson("/api/usm/schedule");
    const games = Array.isArray(payload?.games) ? payload.games : [];

    elements.scheduleBody.innerHTML = "";
    if (games.length === 0) {
      elements.scheduleMeta.textContent = "No games available.";
      elements.scheduleBody.innerHTML = `<tr><td colspan="5">No schedule entries found.</td></tr>`;
      return;
    }

    elements.scheduleMeta.textContent = `${games.length} total games`;

    const fragment = document.createDocumentFragment();
    for (const game of games) {
      const tr = document.createElement("tr");

      const dateCell = document.createElement("td");
      dateCell.textContent = formatGameDate(game);
      tr.appendChild(dateCell);

      const matchupCell = document.createElement("td");
      matchupCell.textContent = `${cleanTeamName(game.awayTeam)} at ${cleanTeamName(game.homeTeam)}`;
      tr.appendChild(matchupCell);

      const statusCell = document.createElement("td");
      statusCell.textContent = cleanText(game.statusText) || "Scheduled";
      tr.appendChild(statusCell);

      const resultCell = document.createElement("td");
      resultCell.textContent = cleanText(game.resultText) || "--";
      tr.appendChild(resultCell);

      const gameIdCell = document.createElement("td");
      if (toPositiveInt(game.gameId)) {
        const link = document.createElement("a");
        link.className = "game-link";
        link.href = `/usm-live-169.html?id=${game.gameId}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = String(game.gameId);
        gameIdCell.appendChild(link);
      } else {
        gameIdCell.textContent = "--";
      }
      tr.appendChild(gameIdCell);

      fragment.appendChild(tr);
    }

    elements.scheduleBody.appendChild(fragment);
  } catch (error) {
    const message = getErrorMessage(error);
    elements.scheduleMeta.textContent = `Failed to load games: ${message}`;
    elements.scheduleBody.innerHTML = `<tr><td colspan="5">${escapeHtml(message)}</td></tr>`;
  }
}

async function loadRosterPage() {
  if (!elements.rosterGrid || !elements.rosterMeta) {
    return;
  }

  if (elements.rosterSearch) {
    elements.rosterSearch.addEventListener("input", () => {
      applyRosterFilter(elements.rosterSearch.value);
      renderRoster();
    });
  }

  try {
    const url = `/api/roster?team=${encodeURIComponent(TEAM_NAME)}&sport=baseball&season=${encodeURIComponent(season)}`;
    const payload = await fetchJson(url);
    const players = Array.isArray(payload?.roster?.players) ? payload.roster.players : [];
    state.rosterPlayers = [...players].sort(compareRosterPlayers);
    state.filteredPlayers = [...state.rosterPlayers];
    renderRoster();
  } catch (error) {
    const message = getErrorMessage(error);
    elements.rosterMeta.textContent = "Failed to load roster.";
    elements.rosterGrid.innerHTML = `<p class="empty-state">${escapeHtml(message)}</p>`;
  }
}

function applyRosterFilter(searchRaw) {
  const search = String(searchRaw || "").trim().toLowerCase();
  if (!search) {
    state.filteredPlayers = [...state.rosterPlayers];
    return;
  }

  state.filteredPlayers = state.rosterPlayers.filter((player) => {
    const haystack = [
      player?.name,
      [player?.firstName, player?.lastName].filter(Boolean).join(" "),
      player?.position,
      player?.classYear,
      player?.hometown,
      player?.from,
      player?.previousSchool,
      player?.lastSchool,
    ]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");
    return haystack.includes(search);
  });
}

function renderRoster() {
  if (!elements.rosterGrid || !elements.rosterMeta) {
    return;
  }

  const allPlayers = state.rosterPlayers;
  const players = state.filteredPlayers;

  elements.rosterGrid.innerHTML = "";

  if (allPlayers.length === 0) {
    elements.rosterMeta.textContent = "No roster data found.";
    elements.rosterGrid.innerHTML = `<p class="empty-state">No roster data available.</p>`;
    return;
  }

  elements.rosterMeta.textContent = `${players.length} of ${allPlayers.length} players`;

  if (players.length === 0) {
    elements.rosterGrid.innerHTML = `<p class="empty-state">No players match your search.</p>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const player of players) {
    const card = document.createElement("article");
    card.className = "roster-card";

    const photo = document.createElement("img");
    photo.className = "roster-photo";
    photo.loading = "lazy";
    photo.alt = `${formatPlayerName(player)} photo`;
    photo.src = player?.photoUrl || EMPTY_PHOTO;
    photo.onerror = () => {
      photo.src = EMPTY_PHOTO;
    };
    card.appendChild(photo);

    const body = document.createElement("div");

    const name = document.createElement("p");
    name.className = "roster-name";
    name.textContent = [formatPlayerName(player), formatNumber(player?.number)].filter(Boolean).join(" ");
    body.appendChild(name);

    const sub = document.createElement("p");
    sub.className = "roster-sub";
    sub.textContent = [player?.position, normalizeClassYear(player?.classYear)].filter(Boolean).join(" | ") || "No position data";
    body.appendChild(sub);

    const metaLineOne = document.createElement("p");
    metaLineOne.className = "roster-meta";
    metaLineOne.textContent = [formatBatsThrows(player), formatHeightWeight(player)].filter(Boolean).join(" | ") || "";
    body.appendChild(metaLineOne);

    const metaLineTwo = document.createElement("p");
    metaLineTwo.className = "roster-meta";
    metaLineTwo.textContent = player?.hometown || player?.from || "";
    body.appendChild(metaLineTwo);

    card.appendChild(body);
    fragment.appendChild(card);
  }

  elements.rosterGrid.appendChild(fragment);
}

async function loadStatsPage() {
  if (!elements.statsMeta) {
    return;
  }

  try {
    const payload = await fetchJson(`/api/usm/stats?season=${encodeURIComponent(season)}`);
    const teamStats = payload?.teamStats || {};
    const hitters = Array.isArray(payload?.individual?.hitting) ? payload.individual.hitting : [];
    const pitchers = Array.isArray(payload?.individual?.pitching) ? payload.individual.pitching : [];

    if (elements.teamRecord) {
      elements.teamRecord.textContent = cleanText(payload?.record) || "--";
    }
    if (elements.teamAvg) {
      elements.teamAvg.textContent = cleanCell(teamStats.ourBattingAverage) || "--";
    }
    if (elements.teamOps) {
      elements.teamOps.textContent = cleanCell(teamStats.ourOps) || "--";
    }
    if (elements.teamWhip) {
      elements.teamWhip.textContent = cleanCell(teamStats.ourWhip) || "--";
    }
    if (elements.teamEra) {
      const era = computeEra(cleanCell(teamStats.ourInningsPitched), cleanCell(teamStats.ourEarnedRunsAllowed));
      elements.teamEra.textContent = era || "--";
    }

    renderTopHitters(hitters);
    renderTopPitchers(pitchers);

    const title = cleanText(payload?.pageTitle) || "Official Southern Miss cumulative stats";
    const updated = payload?.fetchedAt ? new Date(payload.fetchedAt).toLocaleString() : "";
    elements.statsMeta.textContent = [title, updated ? `Updated ${updated}` : ""].filter(Boolean).join(" | ");
  } catch (error) {
    const message = getErrorMessage(error);
    elements.statsMeta.textContent = `Failed to load stats: ${message}`;
    renderStatsFallback();
  }
}

function renderTopHitters(rows) {
  if (!elements.statsHittingBody) {
    return;
  }

  const sorted = rows
    .map((row) => ({
      name: normalizePlayerName(row?.playerName),
      average: parseNum(row?.values?.battingAverage),
      homeRuns: cleanCell(row?.values?.homeRuns),
      rbis: cleanCell(row?.values?.runsBattedIn),
      atBats: parseNum(row?.values?.atBats),
    }))
    .filter((row) => row.name && Number.isFinite(row.average) && Number.isFinite(row.atBats) && row.atBats >= 10)
    .sort((a, b) => {
      if (b.average !== a.average) {
        return b.average - a.average;
      }
      return (b.atBats || 0) - (a.atBats || 0);
    })
    .slice(0, 10);

  elements.statsHittingBody.innerHTML = "";

  if (sorted.length === 0) {
    elements.statsHittingBody.innerHTML = `<tr><td colspan="4">No hitter data available.</td></tr>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of sorted) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(row.name)}</td><td>${formatAverage(row.average)}</td><td>${escapeHtml(
      row.homeRuns || "0"
    )}</td><td>${escapeHtml(row.rbis || "0")}</td>`;
    fragment.appendChild(tr);
  }

  elements.statsHittingBody.appendChild(fragment);
}

function renderTopPitchers(rows) {
  if (!elements.statsPitchingBody) {
    return;
  }

  const sorted = rows
    .map((row) => ({
      name: normalizePlayerName(row?.playerName),
      era: parseNum(row?.values?.earnedRunAverage),
      innings: parseNum(row?.values?.inningsPitched),
      strikeouts: cleanCell(row?.values?.strikeOuts),
    }))
    .filter((row) => row.name && Number.isFinite(row.era) && Number.isFinite(row.innings) && row.innings >= 5)
    .sort((a, b) => {
      if (a.era !== b.era) {
        return a.era - b.era;
      }
      return (b.innings || 0) - (a.innings || 0);
    })
    .slice(0, 10);

  elements.statsPitchingBody.innerHTML = "";

  if (sorted.length === 0) {
    elements.statsPitchingBody.innerHTML = `<tr><td colspan="4">No pitcher data available.</td></tr>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of sorted) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(row.name)}</td><td>${Number.isFinite(row.era) ? row.era.toFixed(2) : "--"}</td><td>${
      Number.isFinite(row.innings) ? row.innings.toFixed(1) : "--"
    }</td><td>${escapeHtml(row.strikeouts || "0")}</td>`;
    fragment.appendChild(tr);
  }

  elements.statsPitchingBody.appendChild(fragment);
}

function renderStatsFallback() {
  if (elements.statsHittingBody) {
    elements.statsHittingBody.innerHTML = `<tr><td colspan="4">Stats unavailable.</td></tr>`;
  }
  if (elements.statsPitchingBody) {
    elements.statsPitchingBody.innerHTML = `<tr><td colspan="4">Stats unavailable.</td></tr>`;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = await safeJson(response);
    throw new Error(body?.error || `Request failed (${response.status})`);
  }
  return response.json();
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function pickUpcomingGames(games, limit) {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const rows = Array.isArray(games) ? games : [];

  const upcoming = rows
    .filter((game) => {
      const status = cleanText(game?.resultText || game?.statusText) || "";
      if (isFinalStatus(status)) {
        return false;
      }

      const epoch = toEpoch(game);
      if (!Number.isFinite(epoch)) {
        return true;
      }

      return epoch >= nowEpoch - 4 * 60 * 60;
    })
    .sort((a, b) => {
      const aEpoch = toEpoch(a);
      const bEpoch = toEpoch(b);
      if (Number.isFinite(aEpoch) && Number.isFinite(bEpoch) && aEpoch !== bEpoch) {
        return aEpoch - bEpoch;
      }

      if (Number.isFinite(aEpoch) && !Number.isFinite(bEpoch)) {
        return -1;
      }
      if (!Number.isFinite(aEpoch) && Number.isFinite(bEpoch)) {
        return 1;
      }

      const aDate = cleanText(a?.date);
      const bDate = cleanText(b?.date);
      if (aDate && bDate && aDate !== bDate) {
        return aDate.localeCompare(bDate);
      }

      const aGameId = toPositiveInt(a?.gameId);
      const bGameId = toPositiveInt(b?.gameId);
      if (Number.isFinite(aGameId) && Number.isFinite(bGameId) && aGameId !== bGameId) {
        return aGameId - bGameId;
      }

      return cleanTeamName(a?.awayTeam).localeCompare(cleanTeamName(b?.awayTeam));
    });

  return upcoming.slice(0, Math.max(1, limit));
}

function toEpoch(game) {
  const et = Number(game?.startTimeEpochEt);
  if (Number.isFinite(et) && et > 0) {
    return et;
  }

  const utc = Number(game?.startTimeEpoch);
  if (Number.isFinite(utc) && utc > 0) {
    return utc;
  }

  return Number.NaN;
}

function isFinalStatus(status) {
  const text = cleanText(status).toLowerCase();
  return /^w[,\s]/.test(text) || /^l[,\s]/.test(text) || text.includes("final");
}

function formatGameDate(game) {
  const epoch = toEpoch(game);
  if (Number.isFinite(epoch)) {
    return new Date(epoch * 1000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const dateText = cleanText(game?.date);
  if (dateText) {
    const timestamp = Date.parse(`${dateText}T12:00:00Z`);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  }

  return "TBD";
}

function formatNewsDate(item) {
  const dateLabel = cleanText(item?.dateLabel);
  if (dateLabel) {
    return dateLabel;
  }

  const path = cleanText(item?.path);
  const match = path.match(/\/news\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//i);
  if (!match) {
    return "Southern Miss Baseball";
  }

  const [_, year, month, day] = match;
  const stamp = Date.parse(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T12:00:00Z`);
  if (!Number.isFinite(stamp)) {
    return "Southern Miss Baseball";
  }

  return new Date(stamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function compareRosterPlayers(a, b) {
  const aNumber = toPositiveInt(a?.number);
  const bNumber = toPositiveInt(b?.number);
  const aHas = Number.isFinite(aNumber);
  const bHas = Number.isFinite(bNumber);

  if (aHas && bHas && aNumber !== bNumber) {
    return aNumber - bNumber;
  }
  if (aHas && !bHas) {
    return -1;
  }
  if (!aHas && bHas) {
    return 1;
  }

  return formatPlayerName(a).localeCompare(formatPlayerName(b));
}

function formatPlayerName(player) {
  const full = [cleanText(player?.firstName), cleanText(player?.lastName)].filter(Boolean).join(" ");
  return full || cleanText(player?.name) || "Unknown Player";
}

function formatNumber(value) {
  const text = cleanText(value);
  return text ? `#${text}` : "";
}

function normalizeClassYear(value) {
  return cleanText(value).replace(/\./g, "").toUpperCase();
}

function formatBatsThrows(player) {
  const bats = cleanText(player?.bats).toUpperCase();
  const throwsHand = cleanText(player?.throws).toUpperCase();
  if (!bats && !throwsHand) {
    return "";
  }
  return `B/T: ${bats || "-"}/${throwsHand || "-"}`;
}

function formatHeightWeight(player) {
  const height = cleanText(player?.height);
  const weight = cleanText(player?.weight);
  return [height, weight].filter(Boolean).join(" | ");
}

function normalizePlayerName(value) {
  const text = cleanText(value);
  if (!text) {
    return "";
  }

  if (text.includes(",")) {
    const [last, first] = text.split(",").map((part) => cleanText(part));
    return [first, last].filter(Boolean).join(" ");
  }

  return text;
}

function formatAverage(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(3).replace(/^0(?=\.)/u, "");
}

function cleanCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  return cleanText(String(value));
}

function parseNum(value) {
  const text = cleanCell(value).replace(/,/g, "");
  if (!text) {
    return Number.NaN;
  }
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function inningsToOuts(inningsValue) {
  const text = cleanText(inningsValue);
  if (!text) {
    return Number.NaN;
  }

  if (/^\d+$/.test(text)) {
    return Number.parseInt(text, 10) * 3;
  }

  const match = text.match(/^(\d+)\.(\d)$/);
  if (!match) {
    return Number.NaN;
  }

  const whole = Number.parseInt(match[1], 10);
  const frac = Number.parseInt(match[2], 10);
  if (!Number.isFinite(whole) || !Number.isFinite(frac) || frac < 0 || frac > 2) {
    return Number.NaN;
  }

  return whole * 3 + frac;
}

function computeEra(inningsPitched, earnedRuns) {
  const outs = inningsToOuts(inningsPitched);
  const er = parseNum(earnedRuns);
  if (!Number.isFinite(outs) || outs <= 0 || !Number.isFinite(er)) {
    return "";
  }

  return ((er * 27) / outs).toFixed(2);
}

function cleanTeamName(value) {
  return cleanText(value).replace(/^#\d+\s+/u, "");
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.NaN;
  }
  return parsed;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
