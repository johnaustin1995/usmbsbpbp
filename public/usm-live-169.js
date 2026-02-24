const REFRESH_INTERVAL_MS = 12000;
const EMPTY_PHOTO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 220 220'%3E%3Crect width='220' height='220' fill='%23d8d8d8'/%3E%3Ccircle cx='110' cy='84' r='42' fill='%23bcbcbc'/%3E%3Crect x='48' y='140' width='124' height='58' rx='28' fill='%23bcbcbc'/%3E%3C/svg%3E";

const state = {
  selectedGameId: null,
  refreshTimer: null,
  rosterCache: new Map(),
};

const elements = {
  bodyGrid: document.querySelector(".body-grid"),
  awayLogo: document.getElementById("away-logo"),
  homeLogo: document.getElementById("home-logo"),
  awayScore: document.getElementById("away-score"),
  homeScore: document.getElementById("home-score"),
  inningArrow: document.getElementById("inning-arrow"),
  inningValue: document.getElementById("inning-value"),
  baseFirst: document.getElementById("base-first"),
  baseSecond: document.getElementById("base-second"),
  baseThird: document.getElementById("base-third"),
  countStatus: document.getElementById("count-status"),
  outsStatus: document.getElementById("outs-status"),
  awayStrip: document.getElementById("away-strip"),
  homeStrip: document.getElementById("home-strip"),
  pitcherPhoto: document.getElementById("pitcher-photo"),
  pitcherNumber: document.getElementById("pitcher-number"),
  pitcherName: document.getElementById("pitcher-name"),
  pitcherMeta: document.getElementById("pitcher-meta"),
  pitcherStats: document.getElementById("pitcher-stats"),
  batterPhoto: document.getElementById("batter-photo"),
  batterNumber: document.getElementById("batter-number"),
  batterName: document.getElementById("batter-name"),
  batterMeta: document.getElementById("batter-meta"),
  batterStats: document.getElementById("batter-stats"),
  runnerFirst: document.getElementById("runner-first"),
  runnerSecond: document.getElementById("runner-second"),
  runnerThird: document.getElementById("runner-third"),
  lineupTable: document.getElementById("lineup-table"),
  linescoreWrap: document.getElementById("linescore-wrap"),
  timeline: document.getElementById("timeline"),
  fieldLabels: document.getElementById("field-labels"),
};

init();

async function init() {
  const params = new URLSearchParams(window.location.search);
  const idParam = Number.parseInt(params.get("id") || "", 10);
  state.selectedGameId = Number.isFinite(idParam) ? idParam : null;

  try {
    await window.ncaabsbBranding?.load?.();
  } catch {
    // Branding is optional for rendering.
  }

  await fetchAndRender();
  state.refreshTimer = window.setInterval(fetchAndRender, REFRESH_INTERVAL_MS);
}

async function fetchAndRender() {
  try {
    const payload = await fetchLivePayload(state.selectedGameId);
    const selectedGameId = parseFiniteInt(payload.selectedGameId);
    if (selectedGameId) {
      state.selectedGameId = selectedGameId;
      updateQueryString(selectedGameId);
    }

    const summary = payload?.live?.summary ?? null;
    const selectedGame = payload?.selectedGame ?? null;
    const awayTeam = cleanTeamName(summary?.visitorTeam || selectedGame?.awayTeam || "Away");
    const homeTeam = cleanTeamName(summary?.homeTeam || selectedGame?.homeTeam || "Home");

    const [awayRoster, homeRoster] = await Promise.all([
      loadTeamRoster(awayTeam),
      loadTeamRoster(homeTeam),
    ]);

    renderDashboard(payload, {
      awayTeam,
      homeTeam,
      awayRoster,
      homeRoster,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderLoadFailure(message);
  }
}

async function fetchLivePayload(gameId) {
  const url = new URL("/api/usm/live", window.location.origin);
  if (gameId) {
    url.searchParams.set("id", String(gameId));
  }

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    const body = await safeJson(response);
    throw new Error(body?.error || `Request failed (${response.status})`);
  }

  return response.json();
}

async function loadTeamRoster(teamName) {
  const normalizedKey = normalizeTeamName(teamName);
  if (!normalizedKey) {
    return null;
  }

  if (state.rosterCache.has(normalizedKey)) {
    return state.rosterCache.get(normalizedKey);
  }

  const promise = fetchRosterByTeam(teamName)
    .then((payload) => payload)
    .catch(() => null);

  state.rosterCache.set(normalizedKey, promise);
  return promise;
}

async function fetchRosterByTeam(teamName) {
  const url = new URL("/api/roster", window.location.origin);
  url.searchParams.set("team", teamName);
  url.searchParams.set("sport", "baseball");

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  const body = await safeJson(response);
  if (!body?.roster || !Array.isArray(body.roster.players)) {
    return null;
  }

  return {
    teamName: body.roster.teamName || teamName,
    players: body.roster.players,
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function renderDashboard(payload, context) {
  const summary = payload?.live?.summary ?? null;
  const selectedGame = payload?.selectedGame ?? null;
  const gameSections = Array.isArray(payload?.live?.gameSections) ? payload.live.gameSections : [];
  const plays = Array.isArray(payload?.live?.plays) ? payload.live.plays : [];

  const gameData = parseGameSections(gameSections, summary, context.awayTeam, context.homeTeam);
  const lineScore = summary?.lineScore || gameData.lineScore || null;

  const inningContext = getInningContext(summary, plays);
  const battingSide = inferBattingSide(summary, plays, inningContext);
  const fieldingSide = battingSide === "away" ? "home" : battingSide === "home" ? "away" : null;

  const teamPack = {
    away: {
      side: "away",
      teamName: context.awayTeam,
      score: parseFiniteInt(summary?.visitorScore),
      roster: context.awayRoster,
      branding: lookupBranding(context.awayTeam),
      lineup: enrichLineupWithRoster(gameData.lineups.away, context.awayRoster),
      pitching: gameData.pitching.away,
      leaders: gameData.offensiveLeaders.away,
    },
    home: {
      side: "home",
      teamName: context.homeTeam,
      score: parseFiniteInt(summary?.homeScore),
      roster: context.homeRoster,
      branding: lookupBranding(context.homeTeam),
      lineup: enrichLineupWithRoster(gameData.lineups.home, context.homeRoster),
      pitching: gameData.pitching.home,
      leaders: gameData.offensiveLeaders.home,
    },
  };

  const recentPlay = findMostRecentPlay(plays, (play) => !play.isSubstitution);

  const activeBatterName =
    normalizePersonName(summary?.situation?.batter?.name) || normalizePersonName(recentPlay?.batter) || null;
  const activePitcherName =
    normalizePersonName(summary?.situation?.pitcher?.name) || normalizePersonName(recentPlay?.pitcher) || null;

  const batterSideKey = battingSide || inferSideFromPlay(recentPlay) || "home";
  const pitcherSideKey = fieldingSide || (batterSideKey === "away" ? "home" : "away");

  const batterTeam = teamPack[batterSideKey];
  const pitcherTeam = teamPack[pitcherSideKey];

  const batterEntry =
    findLineupEntry(batterTeam.lineup, activeBatterName) ||
    findLineupEntryByPlayOrder(batterTeam.lineup, recentPlay) ||
    batterTeam.lineup[0] ||
    null;

  const pitcherProfile = resolvePitcherProfile(pitcherTeam, activePitcherName, summary);
  const batterProfile = resolveBatterProfile(batterTeam, batterEntry, activeBatterName);

  applySideColumnSwap(battingSide);

  renderTopScoreboard({
    away: teamPack.away,
    home: teamPack.home,
    summary,
    inningContext,
    plays,
    battingSide,
    pitcherProfile,
    batterProfile,
  });

  renderPitcherCard(pitcherProfile);
  renderPitcherStats(pitcherProfile);

  renderBatterCard(batterProfile);
  renderBatterStats(batterProfile, batterTeam);

  renderRunnerNames(summary?.situation?.bases || null);
  renderLineupTable(batterTeam.lineup, batterEntry);
  renderFieldAlignment(pitcherTeam, pitcherProfile);
  renderLineScore(lineScore, selectedGame);
  renderTimeline(plays, teamPack);
}

function applySideColumnSwap(battingSide) {
  if (!elements.bodyGrid) {
    return;
  }

  const shouldSwap = battingSide === "away";
  elements.bodyGrid.classList.toggle("swap-side-panels", shouldSwap);
}

function renderTopScoreboard(input) {
  const { away, home, summary, inningContext, plays, battingSide, pitcherProfile, batterProfile } = input;

  elements.awayScore.textContent = formatScore(away.score);
  elements.homeScore.textContent = formatScore(home.score);

  renderTeamLogo(elements.awayLogo, away.teamName, away.branding);
  renderTeamLogo(elements.homeLogo, home.teamName, home.branding);

  renderInningContext(inningContext);
  renderBases(summary?.situation?.bases || null);
  renderCount(summary?.situation, plays);
  renderOuts(summary?.situation, plays);

  const awayMode = battingSide === "away" ? "batter" : "pitcher";
  const homeMode = battingSide === "home" ? "batter" : "pitcher";

  const awayStripText =
    awayMode === "batter" ? formatBatterStrip(batterProfile, away.side) : formatPitcherStrip(pitcherProfile, away.side);
  const homeStripText =
    homeMode === "batter" ? formatBatterStrip(batterProfile, home.side) : formatPitcherStrip(pitcherProfile, home.side);

  elements.awayStrip.textContent = awayStripText;
  elements.homeStrip.textContent = homeStripText;

  applyStripStyling(elements.awayStrip, away.branding?.colors?.primary, "#8f0a0c");
  applyStripStyling(elements.homeStrip, home.branding?.colors?.primary, "#f1c232");
}

function renderPitcherCard(profile) {
  elements.pitcherPhoto.src = profile.photoUrl || EMPTY_PHOTO;
  elements.pitcherName.textContent = profile.displayName || "-";
  elements.pitcherNumber.textContent = profile.number || "--";
  elements.pitcherMeta.textContent = profile.metaLine || "-";
}

function renderPitcherStats(profile) {
  const headers = [];
  const values = [];

  const ordered = ["IP", "H", "R", "ER", "BB", "K", "PC", "ERA"];
  ordered.forEach((key) => {
    const value = profile.statMap[key];
    if (value !== null && value !== undefined && value !== "") {
      headers.push(key);
      values.push(String(value));
    }
  });

  if (headers.length === 0) {
    elements.pitcherStats.innerHTML = '<tbody><tr><td class="placeholder">Pitching stats unavailable.</td></tr></tbody>';
    return;
  }

  elements.pitcherStats.innerHTML = "";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  headers.forEach((header) => {
    const th = document.createElement("th");
    th.textContent = header;
    hr.append(th);
  });
  thead.append(hr);

  const tbody = document.createElement("tbody");
  const vr = document.createElement("tr");
  values.forEach((value) => {
    const td = document.createElement("td");
    td.textContent = value;
    vr.append(td);
  });
  tbody.append(vr);

  elements.pitcherStats.append(thead, tbody);
}

function renderBatterCard(profile) {
  elements.batterPhoto.src = profile.photoUrl || EMPTY_PHOTO;
  elements.batterName.textContent = profile.displayName || "-";
  elements.batterNumber.textContent = profile.number || "--";
  elements.batterMeta.textContent = profile.metaLine || "-";
}

function renderBatterStats(profile, team) {
  const row = profile.lineupEntry;
  const today = parseTodayLine(row?.today || "");
  const highlights = (team.leaders.get(normalizePersonName(profile.fullName || profile.displayName)) || "").toUpperCase();

  const headers = ["AB", "H", "HR", "RBI", "AVG"];
  const values = [
    today.ab !== null ? String(today.ab) : "-",
    today.h !== null ? String(today.h) : "-",
    String(extractStatFromHighlights(highlights, "HR") ?? 0),
    String(extractStatFromHighlights(highlights, "RBI") ?? 0),
    row?.avg || "-",
  ];

  elements.batterStats.innerHTML = "";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((header) => {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.append(th);
  });
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  const valueRow = document.createElement("tr");
  values.forEach((value) => {
    const td = document.createElement("td");
    td.textContent = value;
    valueRow.append(td);
  });
  tbody.append(valueRow);

  elements.batterStats.append(thead, tbody);
}

function renderRunnerNames(bases) {
  const first = bases?.first ? toLastName(bases?.firstRunner) || "--" : "--";
  const second = bases?.second ? toLastName(bases?.secondRunner) || "--" : "--";
  const third = bases?.third ? toLastName(bases?.thirdRunner) || "--" : "--";

  elements.runnerFirst.textContent = first.toUpperCase();
  elements.runnerSecond.textContent = second.toUpperCase();
  elements.runnerThird.textContent = third.toUpperCase();
}

function renderLineupTable(lineup, activeEntry) {
  if (!Array.isArray(lineup) || lineup.length === 0) {
    elements.lineupTable.innerHTML = '<tbody><tr><td class="placeholder">Lineup unavailable.</td></tr></tbody>';
    return;
  }

  const sortedLineup = lineup
    .slice()
    .sort((a, b) => (a.spot ?? 99) - (b.spot ?? 99));

  const columnSizing = computeLineupColumnSizing(sortedLineup);
  applyLineupColumnSizing(elements.lineupTable, columnSizing);

  elements.lineupTable.innerHTML = "";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  [
    { label: "#", className: "spot" },
    { label: "POS", className: "pos" },
    { label: "B/T", className: "bats" },
    { label: "PLAYER", className: "player" },
    { label: "TOD", className: "today" },
    { label: "AVG", className: "avg" },
  ].forEach((column) => {
    const th = document.createElement("th");
    th.className = column.className;
    th.textContent = column.label;
    headRow.append(th);
  });
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  sortedLineup.forEach((entry) => {
    const tr = document.createElement("tr");
    if (activeEntry && isSamePlayer(activeEntry.name, entry.name)) {
      tr.classList.add("active");
    }

    tr.append(
      buildCell("spot", entry.spot !== null ? String(entry.spot) : "-"),
      buildCell("pos", normalizePosition(entry.position || entry.rosterPlayer?.position || "-")),
      buildCell("bats", formatBatsThrows(entry)),
      buildCell("player", toLastName(entry.fullName || entry.name || "-")),
      buildCell("today", entry.today || "-"),
      buildCell("avg", entry.avg || "-")
    );

    tbody.append(tr);
  });

  elements.lineupTable.append(thead, tbody);
}

function computeLineupColumnSizing(lineup) {
  const maxChars = {
    spot: 1,
    pos: 3,
    bats: 3,
    player: 6,
    today: 3,
    avg: 4,
  };

  lineup.forEach((entry) => {
    maxChars.spot = Math.max(maxChars.spot, String(entry.spot ?? "-").length);
    maxChars.pos = Math.max(maxChars.pos, normalizePosition(entry.position || entry.rosterPlayer?.position || "-").length);
    maxChars.bats = Math.max(maxChars.bats, formatBatsThrows(entry).length);
    maxChars.player = Math.max(maxChars.player, toLastName(entry.fullName || entry.name || "-").length);
    maxChars.today = Math.max(maxChars.today, String(entry.today || "-").length);
    maxChars.avg = Math.max(maxChars.avg, String(entry.avg || "-").length);
  });

  return {
    spot: `${Math.max(2, maxChars.spot)}ch`,
    pos: `${Math.max(3, maxChars.pos)}ch`,
    bats: `${Math.max(3, maxChars.bats)}ch`,
    player: `${Math.max(7, maxChars.player)}ch`,
    today: `${Math.max(3, maxChars.today)}ch`,
    avg: `${Math.max(4, maxChars.avg)}ch`,
  };
}

function applyLineupColumnSizing(table, sizing) {
  table.style.setProperty("--lineup-col-spot", sizing.spot);
  table.style.setProperty("--lineup-col-pos", sizing.pos);
  table.style.setProperty("--lineup-col-bats", sizing.bats);
  table.style.setProperty("--lineup-col-player", sizing.player);
  table.style.setProperty("--lineup-col-today", sizing.today);
  table.style.setProperty("--lineup-col-avg", sizing.avg);
}

function renderFieldAlignment(defenseTeam, pitcherProfile) {
  const labels = {
    p: toLastName(pitcherProfile.fullName || pitcherProfile.displayName) || "P",
    c: "C",
    '1b': "1B",
    '2b': "2B",
    ss: "SS",
    '3b': "3B",
    lf: "LF",
    cf: "CF",
    rf: "RF",
  };

  const assignments = assignDefensivePositions(defenseTeam.lineup, pitcherProfile);
  Object.keys(labels).forEach((position) => {
    const node = elements.fieldLabels.querySelector(`[data-pos="${position}"]`);
    if (!node) {
      return;
    }
    node.textContent = (assignments[position] || labels[position]).toUpperCase();
  });
}

function renderLineScore(lineScore, selectedGame) {
  if (!lineScore || !Array.isArray(lineScore.rows) || lineScore.rows.length === 0) {
    elements.linescoreWrap.innerHTML = '<p class="placeholder">Line score unavailable.</p>';
    return;
  }

  const inningNumbers = getLineInningHeaders(lineScore);
  const table = document.createElement("table");
  table.className = "line-table";

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.append(buildHeaderCell(""));
  inningNumbers.forEach((inning) => hr.append(buildHeaderCell(String(inning))));
  ["R", "H", "E", "LOB"].forEach((label) => hr.append(buildHeaderCell(label)));
  thead.append(hr);

  const tbody = document.createElement("tbody");
  lineScore.rows.forEach((row) => {
    const tr = document.createElement("tr");

    const teamCell = document.createElement("td");
    teamCell.className = "team-cell";
    teamCell.textContent = row.team || "-";
    tr.append(teamCell);

    inningNumbers.forEach((inning) => {
      const inningValue = row.innings?.find((entry) => entry.inning === inning)?.value;
      tr.append(buildValueCell(formatLineCell(inningValue)));
    });

    const totals = row.totals || {};
    tr.append(
      buildValueCell(formatLineCell(totals.r), "total-cell"),
      buildValueCell(formatLineCell(totals.h), "total-cell"),
      buildValueCell(formatLineCell(totals.e), "total-cell"),
      buildValueCell(formatLineCell(totals.lob ?? totals.l), "total-cell")
    );

    tbody.append(tr);
  });

  table.append(thead, tbody);
  elements.linescoreWrap.innerHTML = "";
  elements.linescoreWrap.append(table);
}

function renderTimeline(plays, teams) {
  if (!Array.isArray(plays) || plays.length === 0) {
    elements.timeline.innerHTML = '<p class="placeholder">No play-by-play events yet.</p>';
    return;
  }

  const recent = plays.slice(-18).reverse();
  const groups = [];

  recent.forEach((play) => {
    const label = formatHalfLabel(play.half, play.inning);
    const existing = groups[groups.length - 1];
    if (!existing || existing.label !== label) {
      groups.push({ label, half: play.half, inning: play.inning, plays: [play] });
      return;
    }
    existing.plays.push(play);
  });

  const scroll = document.createElement("div");
  scroll.className = "timeline-scroll";

  groups.forEach((group, groupIndex) => {
    const wrap = document.createElement("section");
    wrap.className = "inning-group";

    const heading = document.createElement("p");
    heading.className = "inning-label";
    heading.textContent = group.label;
    wrap.append(heading);

    group.plays.forEach((play) => {
      const badgeInfo = resolveTimelineBadge(play, teams, groupIndex === 0);

      const item = document.createElement("article");
      item.className = "timeline-item";

      const badge = document.createElement("span");
      badge.className = `timeline-badge ${groupIndex === 0 ? "current" : "previous"}`;
      badge.textContent = badgeInfo.value;
      if (badgeInfo.backgroundColor) {
        badge.style.backgroundColor = badgeInfo.backgroundColor;
        badge.style.color = badgeInfo.textColor;
      } else {
        badge.style.removeProperty("background-color");
        badge.style.removeProperty("color");
      }

      const text = document.createElement("p");
      text.className = "timeline-text";
      appendHighlightedPlayText(text, play.text || "", play.batter || null);

      item.append(badge, text);
      wrap.append(item);
    });

    scroll.append(wrap);
  });

  elements.timeline.innerHTML = "";
  elements.timeline.append(scroll);
}

function resolveTimelineBadge(play, teams, isCurrentGroup) {
  const defaultValue = "?";
  const defaultBackground = isCurrentGroup ? "#707070" : "#8e8e8e";

  const battingSide = inferSideFromPlay(play);
  const defensiveSide = battingSide === "away" ? "home" : battingSide === "home" ? "away" : null;
  const substitutionType = classifySubstitutionType(play?.text || "");

  let teamSide = battingSide;
  if (play?.isSubstitution && substitutionType === "defensive") {
    teamSide = defensiveSide;
  }

  const team = teamSide ? teams[teamSide] : null;
  const candidateNames = buildBadgeCandidateNames(play);
  const lineup = Array.isArray(team?.lineup) ? team.lineup : [];

  let lineupEntry = null;
  for (const name of candidateNames) {
    lineupEntry = findLineupEntry(lineup, name);
    if (lineupEntry) {
      break;
    }
  }

  let jerseyNumber = normalizeCell(lineupEntry?.number || lineupEntry?.rosterPlayer?.number) || null;
  if (!jerseyNumber && team?.roster?.players && candidateNames.length > 0) {
    for (const name of candidateNames) {
      const rosterMatch = findRosterPlayer(team.roster, {
        name,
        fullName: name,
        number: null,
      });
      const fromRoster = normalizeCell(rosterMatch?.number);
      if (fromRoster) {
        jerseyNumber = fromRoster;
        break;
      }
    }
  }

  const teamColor =
    safeHex(team?.branding?.colors?.primary) ||
    safeHex(team?.branding?.colors?.espnPrimary) ||
    defaultBackground;

  return {
    value: jerseyNumber || defaultValue,
    backgroundColor: teamColor,
    textColor: getReadableTextColor(teamColor),
  };
}

function buildBadgeCandidateNames(play) {
  const names = [];
  const entering = parseSubstitutionEnteringName(play?.text || "");
  const batter = normalizePersonName(play?.batter);
  const pitcher = normalizePersonName(play?.pitcher);

  if (entering) {
    names.push(entering);
  }
  if (batter) {
    names.push(batter);
  }
  if (pitcher) {
    names.push(pitcher);
  }

  return Array.from(new Set(names.filter(Boolean)));
}

function classifySubstitutionType(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) {
    return null;
  }

  if (/pinch\s*(hit|ran)|pinch[-\s]hitter|pinch[-\s]runner/.test(lower)) {
    return "offensive";
  }

  if (/\bto\s+(p|c|1b|2b|3b|ss|lf|cf|rf|of|dh)\b/.test(lower)) {
    return "defensive";
  }

  if (/defensive substitution|defensive switch/.test(lower)) {
    return "defensive";
  }

  return null;
}

function parseSubstitutionEnteringName(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const patterns = [
    /^(.+?)\s+to\s+[a-z0-9]+(?:\s+for\s+.+)?[.;]?$/i,
    /^(.+?)\s+pinch\s+(?:hit|ran)\s+for\s+.+[.;]?$/i,
    /^(.+?)\s+entered\s+the\s+game/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const parsed = normalizePersonName(match[1]);
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

function parseGameSections(sections, summary, awayTeamName, homeTeamName) {
  const result = {
    lineScore: null,
    pitching: {
      away: null,
      home: null,
    },
    lineups: {
      away: [],
      home: [],
    },
    offensiveLeaders: {
      away: new Map(),
      home: new Map(),
    },
  };

  const awayKey = normalizeTeamName(awayTeamName);
  const homeKey = normalizeTeamName(homeTeamName);
  const awayCode = normalizeTeamName(summary?.lineScore?.rows?.[0]?.team || abbreviateTeam(awayTeamName));
  const homeCode = normalizeTeamName(summary?.lineScore?.rows?.[1]?.team || abbreviateTeam(homeTeamName));

  sections.forEach((section) => {
    const title = String(section?.title || "");
    const lower = title.toLowerCase();

    if (/game line score/i.test(lower)) {
      result.lineScore = parseLineScoreSection(section);
      return;
    }

    if (/^pitching\s+for/i.test(lower)) {
      const side = resolveSectionSide(title, { awayKey, homeKey, awayCode, homeCode });
      if (!side) {
        return;
      }
      result.pitching[side] = parsePitchingSection(section);
      return;
    }

    if (/batting order/i.test(lower)) {
      const side = resolveSectionSide(title, { awayKey, homeKey, awayCode, homeCode });
      if (!side) {
        return;
      }
      result.lineups[side] = parseLineupSection(section);
      return;
    }

    if (/offensive leaders/i.test(lower)) {
      const side = resolveSectionSide(title, { awayKey, homeKey, awayCode, homeCode });
      if (!side) {
        return;
      }
      result.offensiveLeaders[side] = parseOffensiveLeaders(section);
    }
  });

  return result;
}

function parseLineScoreSection(section) {
  const table = section?.tables?.[0];
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) {
    return null;
  }

  const headers = table.headers.map((header) => String(header ?? "").trim()).filter(Boolean);
  const rows = table.rows
    .map((row) => {
      const cells = Array.isArray(row?.cells) ? row.cells : [];
      if (cells.length < 2) {
        return null;
      }

      const team = String(cells[0] ?? "").trim();
      const inningValues = [];
      const totals = { r: null, h: null, e: null, lob: null };

      let inningIndex = 0;
      for (let index = 1; index < headers.length; index += 1) {
        const header = headers[index];
        const value = cells[index] ?? null;

        if (/^\d+$/.test(header)) {
          inningValues.push({ inning: Number.parseInt(header, 10), value: parseLineNumeric(value) });
          inningIndex += 1;
          continue;
        }

        const normalized = header.toLowerCase();
        if (normalized === "r") totals.r = parseLineNumeric(value);
        if (normalized === "h") totals.h = parseLineNumeric(value);
        if (normalized === "e") totals.e = parseLineNumeric(value);
        if (normalized === "l" || normalized === "lob") totals.lob = parseLineNumeric(value);
      }

      return {
        team,
        innings: inningValues,
        totals,
      };
    })
    .filter(Boolean);

  if (rows.length === 0) {
    return null;
  }

  return {
    headers,
    rows,
  };
}

function parsePitchingSection(section) {
  const title = String(section?.title || "");
  const info = parsePitchingTitle(title);

  const table = section?.tables?.[0];
  const headers = Array.isArray(table?.headers) ? table.headers.map((value) => String(value || "").trim()) : [];
  const row = Array.isArray(table?.rows) ? table.rows[0] : null;
  const cells = Array.isArray(row?.cells) ? row.cells : [];

  const statMap = {};
  headers.forEach((header, index) => {
    const key = header.toUpperCase();
    if (!key) {
      return;
    }
    statMap[key] = cells[index] ?? null;
  });

  if (info.era !== null) {
    statMap.ERA = info.era;
  }

  return {
    ...info,
    statMap,
  };
}

function parsePitchingTitle(title) {
  const afterColon = title.includes(":") ? title.split(":").slice(1).join(":") : title;
  const eraMatch = afterColon.match(/([0-9]+\.[0-9]+)\s*ERA/i);
  const throwsMatch = afterColon.match(/TH:\s*([RLS])/i);

  const cleanedName = afterColon
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(WIN|LOSS|SAVE)\b.*$/i, " ")
    .replace(/^\s*#\d+\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    fullName: normalizePersonName(cleanedName),
    throws: throwsMatch ? throwsMatch[1].toUpperCase() : null,
    era: eraMatch ? eraMatch[1] : null,
  };
}

function parseLineupSection(section) {
  const table = section?.tables?.[0];
  if (!table || !Array.isArray(table.rows)) {
    return [];
  }

  return table.rows
    .map((row) => {
      const cells = Array.isArray(row?.cells) ? row.cells : [];
      const spot = parseFiniteInt(cells[0]);
      const parsedPlayer = parseLineupPlayerCell(cells[1]);

      return {
        spot,
        number: parsedPlayer.number,
        name: parsedPlayer.name,
        fullName: parsedPlayer.fullName,
        bats: normalizeCell(cells[2]),
        classYear: normalizeCell(cells[3]),
        today: normalizeCell(cells[4]),
        avg: normalizeCell(cells[5]),
        position: null,
        rosterPlayer: null,
      };
    })
    .filter((entry) => Boolean(entry.name));
}

function parseLineupPlayerCell(rawValue) {
  const value = normalizeCell(rawValue) || "";
  if (!value) {
    return { number: null, name: null, fullName: null };
  }

  let number = null;
  let namePart = value;

  const numberMatch = value.match(/^#(\d+)\s*(.+)$/i);
  if (numberMatch) {
    number = numberMatch[1];
    namePart = numberMatch[2];
  }

  const normalizedFull = normalizePersonName(namePart);
  const normalizedLast = toLastName(normalizedFull || namePart);

  return {
    number,
    name: normalizedLast || normalizedFull,
    fullName: normalizedFull,
  };
}

function parseOffensiveLeaders(section) {
  const map = new Map();
  const table = section?.tables?.[0];
  if (!table || !Array.isArray(table.rows)) {
    return map;
  }

  table.rows.forEach((row) => {
    const cells = Array.isArray(row?.cells) ? row.cells : [];
    const playerName = normalizePersonName(cells[0]);
    const highlights = normalizeCell(cells[2]) || "";
    if (!playerName) {
      return;
    }
    map.set(normalizePersonName(playerName), highlights);
    map.set(toLastName(playerName), highlights);
  });

  return map;
}

function enrichLineupWithRoster(lineup, roster) {
  if (!Array.isArray(lineup)) {
    return [];
  }

  return lineup.map((entry) => {
    const rosterPlayer = findRosterPlayer(roster, entry);
    return {
      ...entry,
      rosterPlayer,
      position: rosterPlayer?.position || null,
      fullName: rosterPlayer?.name || entry.fullName || entry.name,
    };
  });
}

function findRosterPlayer(roster, lineupEntry) {
  if (!roster || !Array.isArray(roster.players) || !lineupEntry) {
    return null;
  }

  const players = roster.players;
  const entryNumber = normalizeCell(lineupEntry.number);

  if (entryNumber) {
    const byNumber = players.find((player) => normalizeCell(player?.number) === entryNumber);
    if (byNumber) {
      return byNumber;
    }
  }

  const fullName = normalizePersonName(lineupEntry.fullName || lineupEntry.name);
  const lastName = toLastName(fullName || lineupEntry.name);

  const byName = players.find((player) => normalizePersonName(player?.name) === fullName);
  if (byName) {
    return byName;
  }

  if (lastName) {
    const matches = players.filter((player) => toLastName(player?.name) === lastName);
    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1 && fullName) {
      const firstInitial = (fullName.split(" ")[0] || "").charAt(0);
      const byInitial = matches.find((player) => {
        const playerFirst = normalizePersonName(player?.name).split(" ")[0] || "";
        return playerFirst.charAt(0) === firstInitial;
      });
      if (byInitial) {
        return byInitial;
      }
    }
  }

  return null;
}

function resolvePitcherProfile(team, activePitcherName, summary) {
  const pitching = team.pitching || null;
  const lineupMatch = findLineupEntry(team.lineup, activePitcherName);
  const rosterByPitchingName = findRosterPlayer(team.roster, {
    name: pitching?.fullName,
    fullName: pitching?.fullName,
    number: null,
  });

  const rosterPlayer =
    findRosterPlayer(team.roster, {
      name: activePitcherName,
      fullName: activePitcherName,
      number: null,
    }) ||
    rosterByPitchingName ||
    lineupMatch?.rosterPlayer ||
    null;

  const activeName = normalizePersonName(activePitcherName);
  const pitchingName = normalizePersonName(pitching?.fullName);
  const rosterName = normalizePersonName(rosterPlayer?.name);
  const shouldPreferRosterName = Boolean(rosterName && (!activeName || isSingleTokenName(activeName)));

  const fullName = shouldPreferRosterName
    ? rosterName
    : activeName || pitchingName || rosterName || "";
  const displayName = (formatFirstLastName(fullName) || "-").toUpperCase();
  const pitchCountFromSituation = summary?.situation?.pitcher?.pitchCount ?? null;
  const pitchCountFromTable = parseFiniteInt(pitching?.statMap?.PC);
  const pitchCount =
    pitchCountFromSituation !== null && pitchCountFromSituation !== undefined
      ? pitchCountFromSituation
      : pitchCountFromTable;

  const statMap = {
    ...pickPitchingStats(pitching?.statMap || {}),
    PC: pitchCount ?? "--",
    ERA: pitching?.statMap?.ERA ?? pitching?.era ?? null,
  };

  return {
    fullName,
    displayName,
    number: normalizeCell(rosterPlayer?.number) || "--",
    photoUrl: normalizeCell(rosterPlayer?.photoUrl) || EMPTY_PHOTO,
    metaLine: buildMetaLine(rosterPlayer, {
      fallbackPosition: "P",
      fallbackBats: pitching?.throws,
    }),
    side: team.side,
    statMap,
    pitchCount,
  };
}

function resolveBatterProfile(team, lineupEntry, fallbackBatterName) {
  const rosterPlayer = lineupEntry?.rosterPlayer || findRosterPlayer(team.roster, lineupEntry) || null;
  const fullName = normalizePersonName(lineupEntry?.fullName || fallbackBatterName || rosterPlayer?.name || "");

  return {
    fullName,
    displayName: (formatFirstLastName(fullName) || "-").toUpperCase(),
    number: normalizeCell(rosterPlayer?.number) || normalizeCell(lineupEntry?.number) || "--",
    photoUrl: normalizeCell(rosterPlayer?.photoUrl) || EMPTY_PHOTO,
    metaLine: buildMetaLine(rosterPlayer, {
      fallbackPosition: normalizePosition(lineupEntry?.position || "-"),
      fallbackBats: lineupEntry?.bats || null,
    }),
    lineupEntry,
    side: team.side,
  };
}

function pickPitchingStats(statMap) {
  const keys = ["IP", "H", "R", "ER", "BB", "K"];
  const result = {};
  keys.forEach((key) => {
    if (statMap[key] !== undefined && statMap[key] !== null && statMap[key] !== "") {
      result[key] = statMap[key];
    }
  });
  return result;
}

function buildMetaLine(player, options = {}) {
  const position = normalizePosition(player?.position || options.fallbackPosition || "-");
  const bats = normalizeCell(player?.bats || options.fallbackBats || "-");
  const throws = normalizeCell(player?.throws || options.fallbackThrows || player?.bats || "-");
  const classYear = normalizeCell(player?.classYear || "-");
  const hometown = normalizeCell(player?.hometown || player?.from || "-");

  return `${position} | ${bats}/${throws} | ${classYear} | ${hometown}`.toUpperCase();
}

function assignDefensivePositions(lineup, pitcherProfile) {
  const slots = {
    p: toLastName(pitcherProfile.fullName || pitcherProfile.displayName) || "P",
    c: null,
    '1b': null,
    '2b': null,
    ss: null,
    '3b': null,
    lf: null,
    cf: null,
    rf: null,
  };

  const pool = Array.isArray(lineup) ? [...lineup] : [];

  const takeByPredicate = (predicate) => {
    const index = pool.findIndex(predicate);
    if (index === -1) {
      return null;
    }
    return pool.splice(index, 1)[0];
  };

  const assign = (slot, entry) => {
    if (!entry) {
      return;
    }
    slots[slot] = toLastName(entry.fullName || entry.name) || slot.toUpperCase();
  };

  assign("c", takeByPredicate((entry) => /\bc\b|catcher/i.test(entry.position || "")));
  assign("1b", takeByPredicate((entry) => /1b|first/i.test(entry.position || "")));
  assign("2b", takeByPredicate((entry) => /2b|second/i.test(entry.position || "")));
  assign("ss", takeByPredicate((entry) => /ss|short/i.test(entry.position || "")));
  assign("3b", takeByPredicate((entry) => /3b|third/i.test(entry.position || "")));
  assign("lf", takeByPredicate((entry) => /lf|left field|\bof\b/i.test(entry.position || "")));
  assign("cf", takeByPredicate((entry) => /cf|center field|\bof\b/i.test(entry.position || "")));
  assign("rf", takeByPredicate((entry) => /rf|right field|\bof\b/i.test(entry.position || "")));

  ["c", "1b", "2b", "ss", "3b", "lf", "cf", "rf"].forEach((slot) => {
    if (slots[slot]) {
      return;
    }
    const fallback = pool.shift();
    if (fallback) {
      slots[slot] = toLastName(fallback.fullName || fallback.name) || slot.toUpperCase();
    }
  });

  return slots;
}

function renderInningContext(context) {
  if (!context || context.inning === null) {
    elements.inningArrow.textContent = "●";
    elements.inningValue.textContent = "-";
    return;
  }

  if (context.mode === "top") {
    elements.inningArrow.textContent = "▲";
    elements.inningValue.textContent = String(context.inning);
    return;
  }

  if (context.mode === "bottom") {
    elements.inningArrow.textContent = "▼";
    elements.inningValue.textContent = String(context.inning);
    return;
  }

  if (context.mode === "mid") {
    elements.inningArrow.textContent = "MID";
    elements.inningValue.textContent = String(context.inning);
    return;
  }

  if (context.mode === "end") {
    elements.inningArrow.textContent = "END";
    elements.inningValue.textContent = String(context.inning);
    return;
  }

  if (context.mode === "final") {
    elements.inningArrow.textContent = "F";
    elements.inningValue.textContent = "INAL";
    return;
  }

  elements.inningArrow.textContent = "●";
  elements.inningValue.textContent = String(context.inning);
}

function renderBases(bases) {
  const first = Boolean(bases?.first);
  const second = Boolean(bases?.second);
  const third = Boolean(bases?.third);

  setOccupied(elements.baseFirst, first);
  setOccupied(elements.baseSecond, second);
  setOccupied(elements.baseThird, third);
}

function setOccupied(node, occupied) {
  node.classList.toggle("occupied", Boolean(occupied));
}

function renderCount(situation, plays) {
  const balls = parseFiniteInt(situation?.count?.balls);
  const strikes = parseFiniteInt(situation?.count?.strikes);

  if (balls !== null && strikes !== null) {
    elements.countStatus.textContent = `${balls}-${strikes}`;
    return;
  }

  const fallback = parseCountFromPlay(findMostRecentPlay(plays, (play) => !play.isSubstitution)?.text || "");
  if (fallback) {
    elements.countStatus.textContent = `${fallback.balls}-${fallback.strikes}`;
    return;
  }

  elements.countStatus.textContent = "--";
}

function renderOuts(situation, plays) {
  let outs = parseFiniteInt(situation?.outs);
  if (outs === null) {
    outs = parseFiniteInt(findMostRecentPlay(plays, (play) => play.outsAfterPlay !== null)?.outsAfterPlay);
  }

  const clamped = Number.isFinite(outs) ? Math.max(0, Math.min(3, outs)) : 0;

  elements.outsStatus.innerHTML = "";
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.className = `out-dot ${index < clamped ? "active" : ""}`;
    elements.outsStatus.append(dot);
  }
}

function formatPitcherStrip(profile, side) {
  if (profile.side !== side) {
    return "PITCHER ---   P --";
  }

  const shortName = formatInitialLast(profile.fullName || profile.displayName || "---");
  const count = profile.pitchCount !== null && profile.pitchCount !== undefined ? String(profile.pitchCount) : "--";
  return `${shortName}   P ${count}`.toUpperCase();
}

function formatBatterStrip(profile, side) {
  if (profile.side !== side) {
    return "BATTER ---";
  }

  const shortName = formatInitialLast(profile.fullName || profile.displayName || "---");
  const today = normalizeCell(profile.lineupEntry?.today);
  if (today) {
    return `${shortName} (${today})`.toUpperCase();
  }

  return shortName.toUpperCase();
}

function applyStripStyling(node, preferredColor, fallbackColor) {
  const color = safeHex(preferredColor) || fallbackColor;
  node.style.backgroundColor = color;
  node.style.color = getReadableTextColor(color);
}

function renderTeamLogo(node, teamName, branding) {
  const logo =
    window.ncaabsbBranding?.chooseLogo?.(branding, { preferDark: false }) ||
    window.ncaabsbBranding?.chooseLogo?.(branding, { preferDark: true }) ||
    null;

  if (!logo) {
    node.hidden = true;
    node.removeAttribute("src");
    return;
  }

  node.hidden = false;
  node.src = logo;
  node.alt = `${teamName} logo`;
}

function appendHighlightedPlayText(node, text, batterName) {
  const clean = normalizePlayText(text);
  const highlightLastName = toLastName(batterName);

  if (!highlightLastName) {
    node.textContent = clean;
    return;
  }

  const lowerText = clean.toLowerCase();
  const lowerName = highlightLastName.toLowerCase();
  const start = lowerText.indexOf(lowerName);

  if (start === -1) {
    node.textContent = clean;
    return;
  }

  const before = clean.slice(0, start);
  const match = clean.slice(start, start + highlightLastName.length);
  const after = clean.slice(start + highlightLastName.length);

  if (before) {
    node.append(document.createTextNode(before));
  }

  const span = document.createElement("span");
  span.className = "name";
  span.textContent = match;
  node.append(span);

  if (after) {
    node.append(document.createTextNode(after));
  }
}

function normalizePlayText(text) {
  if (!text) {
    return "";
  }

  return String(text)
    .replace(/\((\d+\s*-\s*\d+)\s+([A-Za-z]+)\)/g, (_match, count, sequence) => {
      return `(${count} ${sequence.toUpperCase()})`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function parseTodayLine(todayText) {
  const match = String(todayText || "").match(/(\d+)\s*-\s*(\d+)/);
  if (!match) {
    return {
      h: null,
      ab: null,
    };
  }

  return {
    h: Number.parseInt(match[1], 10),
    ab: Number.parseInt(match[2], 10),
  };
}

function extractStatFromHighlights(highlights, label) {
  if (!highlights) {
    return null;
  }

  const pattern = new RegExp(`(\\d+)\\s*${label}\\b`, "i");
  const explicit = highlights.match(pattern);
  if (explicit) {
    return Number.parseInt(explicit[1], 10);
  }

  const anyMention = new RegExp(`\\b${label}\\b`, "i").test(highlights);
  if (anyMention) {
    return 1;
  }

  return null;
}

function buildCell(className, value) {
  const cell = document.createElement("td");
  cell.className = className;
  cell.textContent = value;
  return cell;
}

function buildHeaderCell(value) {
  const cell = document.createElement("th");
  cell.textContent = value;
  return cell;
}

function buildValueCell(value, className = "") {
  const cell = document.createElement("td");
  if (className) {
    cell.className = className;
  }
  cell.textContent = value;
  return cell;
}

function findLineupEntry(lineup, playerName) {
  if (!Array.isArray(lineup) || lineup.length === 0 || !playerName) {
    return null;
  }

  const normalizedTarget = normalizePersonName(playerName);
  const targetLast = toLastName(normalizedTarget);

  return (
    lineup.find((entry) => normalizePersonName(entry.fullName || entry.name) === normalizedTarget) ||
    lineup.find((entry) => toLastName(entry.fullName || entry.name) === targetLast) ||
    null
  );
}

function findLineupEntryByPlayOrder(lineup, play) {
  if (!play) {
    return null;
  }
  return findLineupEntry(lineup, play.batter);
}

function findMostRecentPlay(plays, predicate) {
  if (!Array.isArray(plays)) {
    return null;
  }

  for (let index = plays.length - 1; index >= 0; index -= 1) {
    const play = plays[index];
    if (!predicate || predicate(play)) {
      return play;
    }
  }

  return null;
}

function inferSideFromPlay(play) {
  if (!play?.half) {
    return null;
  }
  return play.half === "top" ? "away" : "home";
}

function inferBattingSide(summary, plays, inningContext) {
  const fromSituation = summary?.situation?.battingTeam;
  if (fromSituation === "away" || fromSituation === "home") {
    return fromSituation;
  }

  if (inningContext?.mode === "top") {
    return "away";
  }

  if (inningContext?.mode === "bottom") {
    return "home";
  }

  if (inningContext?.mode === "mid") {
    return "home";
  }

  if (inningContext?.mode === "end") {
    return "away";
  }

  const recent = findMostRecentPlay(plays, (play) => Boolean(play?.half));
  return inferSideFromPlay(recent);
}

function getInningContext(summary, plays) {
  const statusText = String(summary?.statusText || "");
  const inning =
    parseFiniteInt(summary?.situation?.inning) ||
    parseFiniteInt(extractMatch(statusText, /\b(?:top|bot|bottom|mid|middle|end)\s*(\d+)/i)) ||
    parseFiniteInt(findMostRecentPlay(plays, (play) => Number.isFinite(play?.inning))?.inning) ||
    null;

  const half = summary?.situation?.half || parseHalfFromText(summary?.situation?.inningText || "") || parseHalfFromText(statusText);

  if (/\bfinal\b/i.test(statusText)) {
    return {
      mode: "final",
      inning,
    };
  }

  if (/\bmid(?:dle)?\b/i.test(statusText)) {
    return {
      mode: "mid",
      inning,
    };
  }

  if (/\bend\b/i.test(statusText)) {
    return {
      mode: "end",
      inning,
    };
  }

  if (half === "top") {
    return {
      mode: "top",
      inning,
    };
  }

  if (half === "bottom") {
    return {
      mode: "bottom",
      inning,
    };
  }

  return {
    mode: "unknown",
    inning,
  };
}

function parseHalfFromText(text) {
  const normalized = String(text || "").toLowerCase();
  if (/\btop\b/.test(normalized)) {
    return "top";
  }
  if (/\bbot\b|\bbottom\b/.test(normalized)) {
    return "bottom";
  }
  return null;
}

function parseCountFromPlay(text) {
  const match = String(text || "").match(/\((\d+)\s*-\s*(\d+)\s+[A-Za-z]+\)/);
  if (!match) {
    return null;
  }

  return {
    balls: Number.parseInt(match[1], 10),
    strikes: Number.parseInt(match[2], 10),
  };
}

function getLineInningHeaders(lineScore) {
  if (!lineScore || !Array.isArray(lineScore.rows)) {
    return [];
  }

  const innings = new Set();
  lineScore.rows.forEach((row) => {
    (row.innings || []).forEach((entry) => {
      if (Number.isFinite(entry.inning)) {
        innings.add(entry.inning);
      }
    });
  });

  return [...innings].sort((a, b) => a - b);
}

function resolveSectionSide(title, context) {
  const normalizedTitle = normalizeTeamName(title);
  if (!normalizedTitle) {
    return null;
  }

  if (containsToken(normalizedTitle, context.awayCode) || containsToken(normalizedTitle, context.awayKey)) {
    return "away";
  }

  if (containsToken(normalizedTitle, context.homeCode) || containsToken(normalizedTitle, context.homeKey)) {
    return "home";
  }

  return null;
}

function containsToken(haystack, token) {
  if (!token) {
    return false;
  }

  return haystack.includes(token);
}

function parseLineNumeric(value) {
  if (value === "X") {
    return "X";
  }

  const parsed = parseFiniteInt(value);
  return parsed !== null ? parsed : normalizeCell(value);
}

function formatHalfLabel(half, inning) {
  if (!half || !Number.isFinite(inning)) {
    return "INNING";
  }

  return `${half === "top" ? "TOP" : "BOT"} ${inning}`;
}

function formatLineCell(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

function formatScore(score) {
  return Number.isFinite(score) ? String(score) : "-";
}

function formatBatsThrows(entry) {
  const bats = normalizeCell(entry?.rosterPlayer?.bats || entry?.bats || "-");
  const throws = normalizeCell(entry?.rosterPlayer?.throws || "-");
  if (throws && throws !== "-") {
    return `${bats}/${throws}`;
  }
  return bats;
}

function normalizePosition(value) {
  const text = normalizeCell(value);
  if (!text) {
    return "-";
  }

  const upper = text.toUpperCase();
  if (/RHP|LHP|PITCHER|\bP\b/.test(upper)) return "P";
  if (/CATCHER|\bC\b/.test(upper)) return "C";
  if (/1B|FIRST/.test(upper)) return "1B";
  if (/2B|SECOND/.test(upper)) return "2B";
  if (/SS|SHORT/.test(upper)) return "SS";
  if (/3B|THIRD/.test(upper)) return "3B";
  if (/LF|LEFT FIELD/.test(upper)) return "LF";
  if (/CF|CENTER FIELD/.test(upper)) return "CF";
  if (/RF|RIGHT FIELD/.test(upper)) return "RF";
  if (/OF/.test(upper)) return "OF";
  if (/INF/.test(upper)) return "INF";
  if (/DH/.test(upper)) return "DH";
  return upper.split(/[\s/]+/)[0] || upper;
}

function lookupBranding(teamName) {
  return window.ncaabsbBranding?.lookup?.(teamName) || null;
}

function cleanTeamName(value) {
  return String(value || "")
    .replace(/^#\d+\s+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTeamName(value) {
  if (window.ncaabsbBranding?.normalizeTeamName) {
    return window.ncaabsbBranding.normalizeTeamName(value);
  }

  return String(value || "")
    .toLowerCase()
    .replace(/^#\d+\s+/u, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeHex(value) {
  const color = window.ncaabsbBranding?.safeColor?.(value) || null;
  return color;
}

function getReadableTextColor(hexColor) {
  const value = String(hexColor || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    return "#ffffff";
  }

  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.58 ? "#111111" : "#ffffff";
}

function normalizePersonName(raw) {
  const value = normalizeCell(raw);
  if (!value) {
    return "";
  }

  const noNumber = value.replace(/^#\d+\s*/i, "").trim();
  if (!noNumber) {
    return "";
  }

  if (noNumber.includes(",")) {
    const [last, first] = noNumber.split(",").map((part) => part.trim()).filter(Boolean);
    if (first && last) {
      return `${toTitle(first)} ${toTitle(last)}`;
    }
  }

  return toTitle(noNumber);
}

function toTitle(value) {
  return String(value || "")
    .toLowerCase()
    .split(/(\s+|-|')/)
    .map((token) => {
      if (/^[\s-']+$/.test(token)) {
        return token;
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("")
    .trim();
}

function toLastName(name) {
  const normalized = normalizePersonName(name);
  if (!normalized) {
    return "";
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1].toUpperCase() : "";
}

function formatFirstLastName(name) {
  const normalized = normalizePersonName(name);
  if (!normalized) {
    return "";
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0];
  }

  return `${parts[0]} ${parts[parts.length - 1]}`;
}

function isSingleTokenName(name) {
  return String(name || "").trim().split(/\s+/).filter(Boolean).length === 1;
}

function formatInitialLast(name) {
  const normalized = normalizePersonName(name);
  if (!normalized) {
    return "---";
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].toUpperCase();
  }

  const firstInitial = parts[0].charAt(0).toUpperCase();
  const last = parts[parts.length - 1].toUpperCase();
  return `${firstInitial}. ${last}`;
}

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

function parseFiniteInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const text = normalizeCell(value);
  if (!text) {
    return null;
  }

  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractMatch(text, regex) {
  const match = String(text || "").match(regex);
  return match ? match[1] : null;
}

function abbreviateTeam(teamName) {
  const clean = cleanTeamName(teamName);
  if (!clean) {
    return "";
  }

  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 3).toUpperCase();
  }

  return parts
    .slice(0, 3)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function isSamePlayer(a, b) {
  return normalizePersonName(a) === normalizePersonName(b) || toLastName(a) === toLastName(b);
}

function renderLoadFailure(message) {
  elements.inningArrow.textContent = "!";
  elements.inningValue.textContent = "ERR";
  elements.countStatus.textContent = "--";
  elements.timeline.innerHTML = `<p class=\"placeholder\">Load failed: ${escapeHtml(message)}</p>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function updateQueryString(gameId) {
  const url = new URL(window.location.href);
  if (gameId) {
    url.searchParams.set("id", String(gameId));
  } else {
    url.searchParams.delete("id");
  }
  window.history.replaceState({}, "", url);
}
