const API_URL = "/api/usm/site";
const EMPTY_PHOTO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 220'%3E%3Crect width='320' height='220' fill='%23101825'/%3E%3Ccircle cx='160' cy='78' r='38' fill='%23212f46'/%3E%3Crect x='82' y='128' width='156' height='62' rx='30' fill='%23212f46'/%3E%3C/svg%3E";

const state = {
  payload: null,
  allPlayers: [],
  filteredPlayers: [],
  searchText: "",
};

const elements = {
  heroLogo: document.getElementById("hero-logo"),
  heroMeta: document.getElementById("hero-meta"),
  openLiveLink: document.getElementById("open-live-link"),
  refreshButton: document.getElementById("refresh-site"),
  summaryRecord: document.getElementById("summary-record"),
  summaryWinPct: document.getElementById("summary-win-pct"),
  summaryRuns: document.getElementById("summary-runs"),
  summaryRunDiff: document.getElementById("summary-run-diff"),
  summaryStreak: document.getElementById("summary-streak"),
  summaryLast10: document.getElementById("summary-last-10"),
  liveMeta: document.getElementById("live-meta"),
  liveFrame: document.getElementById("live-frame"),
  scheduleMeta: document.getElementById("schedule-meta"),
  scheduleBody: document.getElementById("schedule-body"),
  statsMeta: document.getElementById("stats-meta"),
  splitHome: document.getElementById("split-home"),
  splitAway: document.getElementById("split-away"),
  splitNeutral: document.getElementById("split-neutral"),
  splitRf: document.getElementById("split-rf"),
  splitRa: document.getElementById("split-ra"),
  officialAvg: document.getElementById("official-avg"),
  officialOps: document.getElementById("official-ops"),
  officialEra: document.getElementById("official-era"),
  officialWhip: document.getElementById("official-whip"),
  officialTopHitter: document.getElementById("official-top-hitter"),
  officialTopPitcher: document.getElementById("official-top-pitcher"),
  rosterSearch: document.getElementById("roster-search"),
  rosterMeta: document.getElementById("roster-meta"),
  rosterGrid: document.getElementById("roster-grid"),
};

init();

async function init() {
  elements.refreshButton?.addEventListener("click", () => {
    fetchAndRender();
  });
  elements.rosterSearch?.addEventListener("input", (event) => {
    state.searchText = String(event.target?.value || "").trim().toLowerCase();
    applyRosterFilter();
    renderRoster();
  });

  try {
    await window.ncaabsbBranding?.load?.();
  } catch {
    // Continue without branding metadata.
  }

  await fetchAndRender();
}

async function fetchAndRender() {
  setLoadingState();
  try {
    const payload = await requestSitePayload();
    state.payload = payload;
    state.allPlayers = Array.isArray(payload?.roster?.players)
      ? [...payload.roster.players].sort(comparePlayers)
      : [];
    applyRosterFilter();
    renderPage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderFailure(message);
  }
}

async function requestSitePayload() {
  const params = new URLSearchParams(window.location.search);
  const season = params.get("season");
  const gameId = params.get("id");

  const url = new URL(API_URL, window.location.origin);
  if (season) {
    url.searchParams.set("season", season);
  }
  if (gameId) {
    url.searchParams.set("id", gameId);
  }

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    const body = await safeJson(response);
    throw new Error(body?.error || `USM site request failed (${response.status})`);
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

function setLoadingState() {
  elements.heroMeta.textContent = "Loading season profile...";
  elements.scheduleMeta.textContent = "Loading games...";
  elements.liveMeta.textContent = "Waiting for game context...";
  elements.rosterMeta.textContent = "Loading players...";
  elements.statsMeta.textContent = "Season-level record splits and official Southern Miss cumulative stats.";
}

function renderFailure(message) {
  elements.heroMeta.textContent = `Failed to load: ${message}`;
  elements.scheduleMeta.textContent = "Unable to load schedule.";
  elements.liveMeta.textContent = "Unable to load live context.";
  elements.rosterMeta.textContent = "Unable to load roster.";
  elements.scheduleBody.innerHTML = "";
  elements.rosterGrid.innerHTML = `<p class="empty-state">Unable to render roster: ${escapeHtml(message)}</p>`;
}

function renderPage() {
  const payload = state.payload;
  if (!payload) {
    return;
  }

  renderHero(payload);
  renderSummary(payload.summary);
  renderLive(payload.live);
  renderSchedule(payload.schedule?.games || []);
  renderStats(payload.summary, payload.stats || null);
  renderRoster();
}

function renderHero(payload) {
  const teamName = payload?.team?.name || "Southern Miss";
  const season = payload?.season || "Current";
  const conferenceName = payload?.team?.conference?.name || "Conference";
  const record =
    payload?.summary && Number.isFinite(payload.summary.wins) && Number.isFinite(payload.summary.losses)
      ? `${payload.summary.wins}-${payload.summary.losses}`
      : "--";

  const branding = lookupBranding(teamName);
  const logo = branding?.logo || payload?.team?.logoUrl || null;
  if (logo) {
    elements.heroLogo.src = logo;
    elements.heroLogo.hidden = false;
  } else {
    elements.heroLogo.hidden = true;
  }

  elements.heroMeta.textContent = `${season} | ${conferenceName} | Record ${record}`;
}

function renderSummary(summary) {
  elements.summaryRecord.textContent = `${summary?.wins ?? 0}-${summary?.losses ?? 0}`;
  elements.summaryWinPct.textContent = summary?.winPct || "--";
  elements.summaryRuns.textContent = `${summary?.runsFor ?? 0} / ${summary?.runsAgainst ?? 0}`;
  elements.summaryRunDiff.textContent = formatRunDiff(summary?.runDifferential);
  elements.summaryStreak.textContent = summary?.streak || "--";
  elements.summaryLast10.textContent = summary?.last10 || "--";
}

function renderLive(livePayload) {
  const selectedGameId = parseFiniteInt(livePayload?.selectedGameId);
  const viewerUrl = String(livePayload?.viewerUrl || "/usm-live-169.html");
  const summary = livePayload?.summary || null;

  elements.openLiveLink.href = viewerUrl;
  const frameSrc = `${viewerUrl}${viewerUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
  elements.liveFrame.src = frameSrc;

  if (summary) {
    const away = cleanTeamName(summary.visitorTeam || "Away");
    const home = cleanTeamName(summary.homeTeam || "Home");
    const scoreAway = summary.visitorScore ?? 0;
    const scoreHome = summary.homeScore ?? 0;
    const status = summary.statusText || "Live";
    elements.liveMeta.textContent = `${away} ${scoreAway} - ${scoreHome} ${home} | ${status}${
      selectedGameId ? ` | Game ${selectedGameId}` : ""
    }`;
    return;
  }

  const selected = livePayload?.selectedGame;
  if (selected) {
    elements.liveMeta.textContent = `${selected.awayTeam} at ${selected.homeTeam}${
      selected.statusText ? ` | ${selected.statusText}` : ""
    }${selectedGameId ? ` | Game ${selectedGameId}` : ""}`;
    return;
  }

  elements.liveMeta.textContent = livePayload?.summaryError
    ? `Live data unavailable: ${livePayload.summaryError}`
    : "Live data unavailable.";
}

function renderSchedule(games) {
  const rows = Array.isArray(games) ? games : [];
  elements.scheduleBody.innerHTML = "";

  if (rows.length === 0) {
    elements.scheduleMeta.textContent = "No games available.";
    return;
  }

  const completed = rows.filter((game) => game?.isCompleted).length;
  const upcoming = rows.filter((game) => game?.isUpcoming).length;
  elements.scheduleMeta.textContent = `${rows.length} games | ${completed} completed | ${upcoming} upcoming`;

  const fragment = document.createDocumentFragment();
  for (const game of rows) {
    const tr = document.createElement("tr");
    tr.className = game.outcome === "win" ? "win-row" : game.outcome === "loss" ? "loss-row" : "upcoming-row";

    const dateCell = document.createElement("td");
    dateCell.textContent = formatDateLabel(game.dateIso, game.dateLabel);
    tr.appendChild(dateCell);

    const oppCell = document.createElement("td");
    oppCell.textContent = cleanTeamName(game.opponentName || "TBD");
    tr.appendChild(oppCell);

    const siteCell = document.createElement("td");
    siteCell.textContent = formatLocation(game.locationType);
    tr.appendChild(siteCell);

    const resultCell = document.createElement("td");
    resultCell.className = "result";
    resultCell.textContent = game.resultText || "Upcoming";
    tr.appendChild(resultCell);

    const gameIdCell = document.createElement("td");
    if (game.statbroadcastId) {
      const link = document.createElement("a");
      link.className = "game-id-chip";
      link.href = `/usm-live-169.html?id=${game.statbroadcastId}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = String(game.statbroadcastId);
      gameIdCell.appendChild(link);
    } else {
      gameIdCell.textContent = "--";
    }
    tr.appendChild(gameIdCell);

    fragment.appendChild(tr);
  }

  elements.scheduleBody.appendChild(fragment);
}

function renderStats(summary, statsPayload) {
  elements.splitHome.textContent = formatRecord(summary?.home);
  elements.splitAway.textContent = formatRecord(summary?.away);
  elements.splitNeutral.textContent = formatRecord(summary?.neutral);
  elements.splitRf.textContent = summary?.averageRunsFor ?? "--";
  elements.splitRa.textContent = summary?.averageRunsAgainst ?? "--";

  const official = statsPayload?.payload || null;
  const teamStats = official?.teamStats || null;
  const hitters = Array.isArray(official?.individual?.hitting) ? official.individual.hitting : [];
  const pitchers = Array.isArray(official?.individual?.pitching) ? official.individual.pitching : [];

  if (!teamStats) {
    elements.officialAvg.textContent = "--";
    elements.officialOps.textContent = "--";
    elements.officialEra.textContent = "--";
    elements.officialWhip.textContent = "--";
    elements.officialTopHitter.textContent = "--";
    elements.officialTopPitcher.textContent = "--";
    if (statsPayload?.error) {
      elements.statsMeta.textContent = `Official stats unavailable: ${statsPayload.error}`;
    }
    return;
  }

  const avg = cleanStatCell(teamStats.ourBattingAverage);
  const ops = cleanStatCell(teamStats.ourOps);
  const whip = cleanStatCell(teamStats.ourWhip);
  const innings = cleanStatCell(teamStats.ourInningsPitched);
  const earnedRuns = cleanStatCell(teamStats.ourEarnedRunsAllowed);
  const era = computeEra(innings, earnedRuns);

  elements.officialAvg.textContent = avg || "--";
  elements.officialOps.textContent = ops || "--";
  elements.officialWhip.textContent = whip || "--";
  elements.officialEra.textContent = era || "--";

  const topHitter = pickTopHitter(hitters);
  const topPitcher = pickTopPitcher(pitchers);
  elements.officialTopHitter.textContent = topHitter || "--";
  elements.officialTopPitcher.textContent = topPitcher || "--";

  const seasonText = official?.season ? `Season ${official.season}` : "Official cumulative stats";
  const recordText = official?.record ? `Record ${official.record}` : "";
  const refreshedText = official?.fetchedAt ? `Updated ${new Date(official.fetchedAt).toLocaleString()}` : "";
  elements.statsMeta.textContent = [seasonText, recordText, refreshedText].filter(Boolean).join(" | ");
}

function applyRosterFilter() {
  const search = state.searchText;
  if (!search) {
    state.filteredPlayers = [...state.allPlayers];
    return;
  }

  state.filteredPlayers = state.allPlayers.filter((player) => {
    const haystack = [
      player?.name,
      [player?.firstName, player?.lastName].filter(Boolean).join(" "),
      player?.position,
      player?.classYear,
      player?.hometown,
      player?.from,
      player?.lastSchool,
      player?.previousSchool,
    ]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");

    return haystack.includes(search);
  });
}

function renderRoster() {
  const players = state.filteredPlayers;
  elements.rosterGrid.innerHTML = "";

  if (state.allPlayers.length === 0) {
    elements.rosterMeta.textContent = "No roster data available.";
    elements.rosterGrid.innerHTML = `<p class="empty-state">Roster is unavailable for this team/season.</p>`;
    return;
  }

  elements.rosterMeta.textContent = `${players.length} of ${state.allPlayers.length} players`;
  if (players.length === 0) {
    elements.rosterGrid.innerHTML = `<p class="empty-state">No players match your search.</p>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const player of players) {
    const card = document.createElement("article");
    card.className = "roster-card";

    const image = document.createElement("img");
    image.className = "roster-photo";
    image.loading = "lazy";
    image.alt = `${formatPlayerName(player)} photo`;
    image.src = player?.photoUrl || EMPTY_PHOTO;
    image.onerror = () => {
      image.src = EMPTY_PHOTO;
    };
    card.appendChild(image);

    const body = document.createElement("div");
    body.className = "roster-card-body";

    const nameRow = document.createElement("div");
    nameRow.className = "roster-name-row";
    const name = document.createElement("p");
    name.className = "roster-name";
    name.textContent = formatPlayerName(player);
    const number = document.createElement("p");
    number.className = "roster-number";
    number.textContent = player?.number ? `#${player.number}` : "";
    nameRow.append(name, number);
    body.appendChild(nameRow);

    const line1 = document.createElement("p");
    line1.className = "roster-line";
    line1.textContent = [player?.position, normalizeClassYear(player?.classYear)].filter(Boolean).join(" | ") || "No position data";
    body.appendChild(line1);

    const line2 = document.createElement("p");
    line2.className = "roster-line";
    line2.textContent = [formatBatsThrows(player), formatHeightWeight(player)].filter(Boolean).join(" | ") || "No biographical data";
    body.appendChild(line2);

    const line3 = document.createElement("p");
    line3.className = "roster-line";
    line3.textContent = player?.hometown || player?.from || "Hometown not listed";
    body.appendChild(line3);

    if (player?.previousSchool || player?.lastSchool) {
      const line4 = document.createElement("p");
      line4.className = "roster-line";
      line4.textContent = `Prev: ${player.previousSchool || player.lastSchool}`;
      body.appendChild(line4);
    }

    card.appendChild(body);
    fragment.appendChild(card);
  }

  elements.rosterGrid.appendChild(fragment);
}

function comparePlayers(a, b) {
  const aNumber = Number.parseInt(String(a?.number || ""), 10);
  const bNumber = Number.parseInt(String(b?.number || ""), 10);
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
  const full = [player?.firstName, player?.lastName].filter(Boolean).join(" ").trim();
  return full || player?.name || "Unknown Player";
}

function normalizeClassYear(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return raw.replace(/\./g, "").toUpperCase();
}

function formatBatsThrows(player) {
  const bats = String(player?.bats || "").trim().toUpperCase();
  const throws = String(player?.throws || "").trim().toUpperCase();
  if (!bats && !throws) {
    return "";
  }
  return `B/T: ${bats || "-"} / ${throws || "-"}`;
}

function formatHeightWeight(player) {
  const height = String(player?.height || "").trim();
  const weight = String(player?.weight || "").trim();
  if (!height && !weight) {
    return "";
  }
  return [height, weight].filter(Boolean).join(" | ");
}

function formatDateLabel(dateIso, fallback) {
  if (dateIso) {
    const timestamp = Date.parse(`${dateIso}T00:00:00Z`);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  }
  return fallback || "TBD";
}

function formatLocation(locationType) {
  if (locationType === "@") {
    return "Away";
  }
  if (locationType === "vs") {
    return "Neutral";
  }
  return "Home";
}

function formatRecord(split) {
  if (!split) {
    return "--";
  }
  return `${split.wins ?? 0}-${split.losses ?? 0}`;
}

function formatRunDiff(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  if (number > 0) {
    return `+${number}`;
  }
  return String(number);
}

function parseFiniteInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanStatCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "";
    }
    return String(value);
  }
  return String(value).trim();
}

function parseNumber(value) {
  const text = cleanStatCell(value).replace(/,/g, "");
  if (!text) {
    return null;
  }
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function inningsToOuts(value) {
  const text = cleanStatCell(value);
  if (!text) {
    return null;
  }
  if (/^\d+$/.test(text)) {
    return Number.parseInt(text, 10) * 3;
  }
  const match = text.match(/^(\d+)\.(\d)$/);
  if (!match) {
    return null;
  }
  const whole = Number.parseInt(match[1], 10);
  const frac = Number.parseInt(match[2], 10);
  if (!Number.isFinite(whole) || !Number.isFinite(frac) || frac < 0 || frac > 2) {
    return null;
  }
  return whole * 3 + frac;
}

function computeEra(inningsPitched, earnedRunsAllowed) {
  const outs = inningsToOuts(inningsPitched);
  const er = parseNumber(earnedRunsAllowed);
  if (!Number.isFinite(outs) || outs <= 0 || !Number.isFinite(er)) {
    return "";
  }
  const era = (er * 27) / outs;
  return era.toFixed(2);
}

function pickTopHitter(rows) {
  const candidates = rows
    .map((row) => {
      const values = row?.values || {};
      return {
        name: cleanTeamName(row?.playerName || ""),
        average: parseNumber(values.battingAverage),
        atBats: parseNumber(values.atBats),
      };
    })
    .filter((row) => row.name && Number.isFinite(row.average) && Number.isFinite(row.atBats) && row.atBats >= 10)
    .sort((a, b) => {
      if (b.average !== a.average) {
        return b.average - a.average;
      }
      return b.atBats - a.atBats;
    });

  const top = candidates[0];
  if (!top) {
    return "";
  }
  return `${formatLastName(top.name)} ${top.average.toFixed(3).replace(/^0(?=\.)/u, "")}`;
}

function pickTopPitcher(rows) {
  const candidates = rows
    .map((row) => {
      const values = row?.values || {};
      return {
        name: cleanTeamName(row?.playerName || ""),
        era: parseNumber(values.earnedRunAverage),
        innings: parseNumber(values.inningsPitched),
      };
    })
    .filter((row) => row.name && Number.isFinite(row.era) && Number.isFinite(row.innings) && row.innings >= 5)
    .sort((a, b) => {
      if (a.era !== b.era) {
        return a.era - b.era;
      }
      return b.innings - a.innings;
    });

  const top = candidates[0];
  if (!top) {
    return "";
  }
  return `${formatLastName(top.name)} ${top.era.toFixed(2)} ERA`;
}

function formatLastName(name) {
  const text = String(name || "").trim();
  if (!text) {
    return "";
  }
  if (text.includes(",")) {
    return text.split(",")[0].trim();
  }
  const parts = text.split(/\s+/);
  return parts[parts.length - 1];
}

function cleanTeamName(value) {
  return String(value || "")
    .replace(/^#\d+\s+/u, "")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function lookupBranding(teamName) {
  const branding = window.ncaabsbBranding?.lookup?.(teamName) || null;
  if (!branding) {
    return null;
  }
  const logo = window.ncaabsbBranding?.chooseLogo?.(branding, { preferDark: false }) || null;
  return { ...branding, logo };
}
