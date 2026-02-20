const titleEl = document.getElementById("pbp-title");
const metaEl = document.getElementById("pbp-meta");
const scoreboardEl = document.getElementById("pbp-scoreboard");
const feedEl = document.getElementById("pbp-feed");
const ballLayerEl = document.getElementById("pbp-ball-layer");
const runnerLayerEl = document.getElementById("pbp-runner-layer");
const playIndexEl = document.getElementById("pbp-play-index");
const inningEl = document.getElementById("pbp-inning");
const matchupEl = document.getElementById("pbp-matchup");
const atBatEl = document.getElementById("pbp-atbat");
const countEl = document.getElementById("pbp-count");
const playTextEl = document.getElementById("pbp-play-text");
const pitchesEl = document.getElementById("pbp-pitches");
const backLinkEl = document.getElementById("pbp-back-link");
const prevBtn = document.getElementById("pbp-prev");
const nextBtn = document.getElementById("pbp-next");
const autoplayBtn = document.getElementById("pbp-autoplay");
const refreshBtn = document.getElementById("pbp-refresh");
const ballLineEl = document.getElementById("pbp-ball-line");
const ballLabelEl = document.getElementById("pbp-ball-label");

const BASE_COORDS = {
  home: { x: 300, y: 520 },
  first: { x: 454, y: 370 },
  second: { x: 300, y: 216 },
  third: { x: 146, y: 370 },
  out: { x: 552, y: 546 },
};

const FIELD_COORDS = {
  1: { x: 300, y: 360, label: "P" },
  2: { x: 300, y: 555, label: "C" },
  3: { x: 454, y: 370, label: "1B" },
  4: { x: 360, y: 306, label: "2B" },
  5: { x: 146, y: 370, label: "3B" },
  6: { x: 240, y: 306, label: "SS" },
  7: { x: 120, y: 210, label: "LF" },
  8: { x: 300, y: 132, label: "CF" },
  9: { x: 480, y: 210, label: "RF" },
};

const OUTCOME_LABELS = {
  single: "Single",
  double: "Double",
  triple: "Triple",
  home_run: "Home Run",
  walk: "Walk",
  intentional_walk: "Intentional Walk",
  strikeout: "Strikeout",
  fly_out: "Fly Out",
  line_out: "Line Out",
  ground_out: "Ground Out",
  foul_out: "Foul Out",
  sacrifice: "Sacrifice",
  stolen_base: "Stolen Base",
  wild_pitch: "Wild Pitch",
  caught_stealing: "Caught Stealing",
  fielder_choice: "Fielder's Choice",
  other: "Play",
};

const COLOR_FALLBACK = {
  away: "#B6262F",
  home: "#103F88",
};

const RUNNER_LEG_DURATION_MS = 260;
const RUNNER_LEG_PAUSE_MS = 30;
const BALL_LEG_DURATION_MS = 250;
const BALL_LEG_PAUSE_MS = 35;

let gameId = null;
let gameDate = null;
let snapshots = [];
let currentIndex = 0;
let autoplayTimer = null;
let playerDirectory = null;
let teamContext = null;

init();

function init() {
  const params = new URLSearchParams(window.location.search);
  gameId = Number.parseInt(params.get("id") || "", 10);
  gameDate = params.get("date");

  if (Number.isFinite(gameId)) {
    const gameParams = new URLSearchParams({ id: String(gameId) });
    if (gameDate) {
      gameParams.set("date", gameDate);
    }
    backLinkEl.href = `/game.html?${gameParams.toString()}`;
  }

  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  autoplayBtn.addEventListener("click", toggleAutoplay);
  refreshBtn.addEventListener("click", loadViewer);

  if (!Number.isFinite(gameId)) {
    titleEl.textContent = "Invalid Game";
    metaEl.textContent = "A valid statbroadcast id is required (e.g. /play-by-play.html?id=635076).";
    return;
  }

  loadViewer();
}

async function loadViewer() {
  stopAutoplay();
  setControlsDisabled(true);
  titleEl.textContent = "Loading Play By Play...";
  metaEl.textContent = "Fetching scorekeeping data";

  try {
    if (window.ncaabsbBranding?.load) {
      await window.ncaabsbBranding.load();
    }

    const response = await fetch(
      `/api/live/${encodeURIComponent(String(gameId))}/pdf-json?includeFinalGame=true&_=${Date.now()}`,
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }

    const payload = await response.json();
    hydrate(payload);
  } catch (error) {
    titleEl.textContent = "Play Viewer Unavailable";
    metaEl.textContent = error instanceof Error ? error.message : "Failed to load play data";
    scoreboardEl.innerHTML = "";
    feedEl.innerHTML = "";
    runnerLayerEl.innerHTML = "";
  } finally {
    setControlsDisabled(false);
  }
}

function hydrate(payload) {
  const scorekeeping = payload?.baseballScorekeeping;
  if (!scorekeeping || !Array.isArray(scorekeeping.plays) || scorekeeping.plays.length === 0) {
    throw new Error("No scorekeeping plays are available for this game.");
  }

  const allPlays = selectPlayableEvents(scorekeeping.plays);
  if (allPlays.length === 0) {
    throw new Error("The feed does not include renderable play-by-play events yet.");
  }

  const awayTeam = scorekeeping?.teams?.away?.name || payload?.finalGame?.finalScore?.visitorTeam || "Away";
  const homeTeam = scorekeeping?.teams?.home?.name || payload?.finalGame?.finalScore?.homeTeam || "Home";
  teamContext = {
    awayName: awayTeam,
    homeName: homeTeam,
    awayColor: resolveTeamColor(awayTeam, COLOR_FALLBACK.away),
    homeColor: resolveTeamColor(homeTeam, COLOR_FALLBACK.home),
  };

  playerDirectory = buildPlayerDirectory(scorekeeping, teamContext);
  snapshots = buildSnapshots(allPlays);
  currentIndex = 0;

  titleEl.textContent = `${awayTeam} at ${homeTeam}`;
  metaEl.textContent = `${String(scorekeeping.game.status || "").toUpperCase()} | ${snapshots.length} plays`;
  matchupEl.textContent = `${awayTeam} at ${homeTeam}`;

  renderScoreboard(teamContext);
  renderFeed();
  renderCurrent(false);
}

function selectPlayableEvents(plays) {
  const filtered = plays.filter((play) => {
    const text = String(play?.text ?? "").trim();
    if (!text) {
      return false;
    }
    if (/^\d+$/.test(text)) {
      return false;
    }
    return true;
  });

  const pbp = filtered.filter((play) => play.source === "play_by_play");
  return pbp.length > 0 ? pbp : filtered;
}

function buildPlayerDirectory(scorekeeping, teams) {
  const byId = new Map();
  const bySideName = {
    away: new Map(),
    home: new Map(),
  };
  const unknownBySideName = {
    away: new Map(),
    home: new Map(),
    none: new Map(),
  };

  const players = scorekeeping?.participants?.players || {};
  Object.values(players).forEach((player) => {
    const side = inferPrimarySide(player);
    const teamColor = side === "away" ? teams.awayColor : side === "home" ? teams.homeColor : null;
    const ref = {
      key: String(player.playerId || `${side || "none"}:${nameKey(player.name)}`),
      playerId: player.playerId || null,
      name: normalizePlayerName(player.name || "Unknown"),
      side,
      jersey: parseJersey(player.jerseyNumbers),
      color: teamColor,
    };

    if (ref.playerId) {
      byId.set(ref.playerId, ref);
    }

    if (side === "away" || side === "home") {
      bySideName[side].set(nameKey(ref.name), ref);
    }
  });

  return {
    byId,
    bySideName,
    unknownBySideName,
    teams,
  };
}

function inferPrimarySide(player) {
  const sides = Array.isArray(player?.sides) ? player.sides : [];
  if (sides.includes("away")) {
    return "away";
  }
  if (sides.includes("home")) {
    return "home";
  }

  const sideFromId = parseSideFromPlayerId(player?.playerId || null);
  return sideFromId || null;
}

function parseJersey(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const first = Number(values[0]);
  return Number.isFinite(first) ? first : null;
}

function buildSnapshots(playList) {
  const allSnapshots = [];
  let state = {
    inning: null,
    half: null,
    outs: 0,
    battingSide: null,
    battingTeam: null,
    score: { away: 0, home: 0 },
    bases: emptyBases(),
  };
  const pitchCountByPitcher = new Map();

  for (const play of playList) {
    const incomingInning = Number.isFinite(play?.inning) ? play.inning : state.inning;
    const incomingHalf = play?.half || state.half;

    if (
      state.half !== null &&
      (incomingInning !== state.inning || incomingHalf !== state.half)
    ) {
      state = {
        ...state,
        inning: incomingInning,
        half: incomingHalf,
        outs: 0,
        bases: emptyBases(),
      };
    }

    state = {
      ...state,
      inning: incomingInning,
      half: incomingHalf,
      battingSide: play?.battingSide || state.battingSide,
      battingTeam: play?.battingTeam || state.battingTeam,
    };

    const battingSide = state.battingSide === "away" || state.battingSide === "home" ? state.battingSide : null;
    const pitcherSide = battingSide === "away" ? "home" : battingSide === "home" ? "away" : null;

    const batterRef = resolvePlayerRef(
      play?.participants?.batterId || null,
      play?.participants?.batterName || null,
      battingSide
    );
    const pitcherRef = resolvePlayerRef(
      play?.participants?.pitcherId || null,
      play?.participants?.pitcherName || null,
      pitcherSide
    );

    const before = cloneState(state);
    const applied = applyPlay(state, play, batterRef);
    state = applied.nextState;

    const pitchesInPlay = Array.isArray(play?.pitchContext?.pitches) ? play.pitchContext.pitches.length : 0;
    if (pitcherRef && pitchesInPlay > 0) {
      const existing = pitchCountByPitcher.get(pitcherRef.key) || 0;
      pitchCountByPitcher.set(pitcherRef.key, existing + pitchesInPlay);
    }

    allSnapshots.push({
      play,
      before,
      after: cloneState(state),
      animation: applied.animation,
      batterRef,
      pitcherRef,
      pitcherPitchCount: pitcherRef ? pitchCountByPitcher.get(pitcherRef.key) || 0 : 0,
    });
  }

  return allSnapshots;
}

function applyPlay(currentState, play, batterRef) {
  const next = cloneState(currentState);
  const text = String(play?.text ?? "").trim();
  const outcome = play?.result?.outcome || inferOutcomeFromText(text);
  const moves = [];
  const handledRunnerKeys = new Set();

  const runnerEvents = extractRunnerEvents(text);
  for (const event of runnerEvents) {
    const runnerRef = resolveRunnerForEvent(event.runner, next.battingSide, batterRef, next.bases);
    if (!runnerRef) {
      continue;
    }

    handledRunnerKeys.add(runnerRef.key);

    if (event.kind === "out") {
      applyRunnerOut(next, moves, runnerRef, event.base);
      continue;
    }

    applyRunnerMovement(next, moves, runnerRef, event.toBase, {
      fromHint: event.fromBase,
      eventKind: event.kind,
    });
  }

  const batterHandled = Boolean(batterRef && handledRunnerKeys.has(batterRef.key));
  applyDefaultBatter(next, moves, batterRef, batterHandled, outcome, text);

  const runsScored = Number.isFinite(play?.result?.runsScored) ? play.result.runsScored : 0;
  if (runsScored > 0 && (next.battingSide === "away" || next.battingSide === "home")) {
    next.score[next.battingSide] += runsScored;
  }

  if (Number.isFinite(play?.result?.outsAfterPlay)) {
    next.outs = clampOuts(play.result.outsAfterPlay);
  } else {
    next.outs = inferOuts(next.outs, outcome, text);
  }

  if (next.outs >= 3) {
    next.bases = emptyBases();
  }

  return {
    nextState: next,
    animation: {
      moves,
      outcomeLabel: OUTCOME_LABELS[outcome] || toTitleCase(String(outcome || "Play").replace(/_/g, " ")),
      ballTarget: resolveBallTarget(play, text),
    },
  };
}

function applyDefaultBatter(next, moves, batterRef, batterHandled, outcome, text) {
  if (!batterRef) {
    return;
  }

  if (outcome === "home_run") {
    if (!batterHandled) {
      for (const base of ["third", "second", "first"]) {
        const runner = next.bases[base];
        if (!runner) {
          continue;
        }

        applyRunnerMovement(next, moves, runner, "home", {
          fromHint: base,
          eventKind: "advance",
        });
      }

      applyRunnerMovement(next, moves, batterRef, "home", {
        fromHint: "home",
        defaultStart: "home",
        eventKind: "batter_reach",
      });
    }
    return;
  }

  if (batterHandled) {
    return;
  }

  if (outcome === "walk" || outcome === "intentional_walk") {
    forceAdvanceForWalk(next, moves);
    applyRunnerMovement(next, moves, batterRef, "first", {
      fromHint: "home",
      defaultStart: "home",
      eventKind: "batter_reach",
    });
    return;
  }

  if (outcome === "single") {
    applyRunnerMovement(next, moves, batterRef, "first", {
      fromHint: "home",
      defaultStart: "home",
      eventKind: "batter_reach",
    });
    return;
  }

  if (outcome === "double") {
    applyRunnerMovement(next, moves, batterRef, "second", {
      fromHint: "home",
      defaultStart: "home",
      eventKind: "batter_reach",
    });
    return;
  }

  if (outcome === "triple") {
    applyRunnerMovement(next, moves, batterRef, "third", {
      fromHint: "home",
      defaultStart: "home",
      eventKind: "batter_reach",
    });
    return;
  }

  if (outcome === "fielder_choice") {
    applyRunnerMovement(next, moves, batterRef, "first", {
      fromHint: "home",
      defaultStart: "home",
      eventKind: "batter_reach",
    });
    return;
  }

  if (inferBatterOutAtFirst(text, outcome)) {
    applyRunnerOut(next, moves, batterRef, "first");
    return;
  }

  if (outcome === "other" && /\breached\b/i.test(text)) {
    applyRunnerMovement(next, moves, batterRef, "first", {
      fromHint: "home",
      defaultStart: "home",
      eventKind: "batter_reach",
    });
  }
}

function forceAdvanceForWalk(next, moves) {
  if (next.bases.third && next.bases.second && next.bases.first) {
    applyRunnerMovement(next, moves, next.bases.third, "home", {
      fromHint: "third",
      eventKind: "advance",
    });
  }

  if (next.bases.second && next.bases.first) {
    applyRunnerMovement(next, moves, next.bases.second, "third", {
      fromHint: "second",
      eventKind: "advance",
    });
  }

  if (next.bases.first) {
    applyRunnerMovement(next, moves, next.bases.first, "second", {
      fromHint: "first",
      eventKind: "advance",
    });
  }
}

function extractRunnerEvents(text) {
  const events = [];
  const NAME = "([A-Z][A-Za-z'.-]+(?:,[A-Z][A-Za-z'.-]+|\\s+[A-Z][A-Za-z'.-]+)?)";
  const throwBases = parseThrowChainTokens(text)
    .slice(1)
    .map((token) => tokenToBase(token))
    .filter((base) => Boolean(base));

  collectMatches(
    events,
    new RegExp(
      `${NAME}\\s+advanced from\\s+(first|second|third|1st|2nd|3rd)(?:\\s+base)?\\s+to\\s+(second|third|home|1st|2nd|3rd)(?:\\s+base)?`,
      "gi"
    ),
    text,
    (match) => ({
      kind: "advance",
      runner: match[1],
      fromBase: canonicalBase(match[2]),
      toBase: canonicalBase(match[3]),
    })
  );

  collectMatches(
    events,
    new RegExp(`${NAME}\\s+advanced from\\s+to\\s+(first|second|third|home)\\s+base`, "gi"),
    text,
    (match) => ({
      kind: "advance",
      runner: match[1],
      fromBase: null,
      toBase: canonicalBase(match[2]),
    })
  );

  collectMatches(
    events,
    new RegExp(`${NAME}\\s+advanced to\\s+(first|second|third|home|1st|2nd|3rd)(?:\\s+base)?\\b`, "gi"),
    text,
    (match) => ({
      kind: "advance",
      runner: match[1],
      fromBase: null,
      toBase: canonicalBase(match[2]),
    })
  );

  collectMatches(
    events,
    new RegExp(`${NAME}\\s+stole\\s+(second|third|home)\\s+base`, "gi"),
    text,
    (match) => ({
      kind: "steal",
      runner: match[1],
      fromBase: null,
      toBase: canonicalBase(match[2]),
    })
  );

  collectMatches(
    events,
    new RegExp(`${NAME}\\s+scored(?:\\s+from\\s+(first|second|third)\\s+base)?`, "gi"),
    text,
    (match) => ({
      kind: "score",
      runner: match[1],
      fromBase: canonicalBase(match[2]),
      toBase: "home",
    })
  );

  collectMatches(
    events,
    new RegExp(`${NAME}\\s+(?:is\\s+)?out(?:[^;,]*?)\\s+at\\s+(first|second|third|home)\\s+base`, "gi"),
    text,
    (match) => ({
      kind: "out",
      runner: match[1],
      base: canonicalBase(match[2]),
      toBase: "out",
    })
  );

  collectMatches(
    events,
    new RegExp(`${NAME}\\s+(?:is\\s+)?out\\s+on\\s+the\\s+play`, "gi"),
    text,
    (match) => ({
      kind: "out",
      runner: match[1],
      base: throwBases[0] || null,
      toBase: "out",
    })
  );

  events.sort((a, b) => a.index - b.index);
  return events;
}

function collectMatches(events, regex, text, toEvent) {
  for (const match of text.matchAll(regex)) {
    const event = toEvent(match);
    if (!event) {
      continue;
    }
    events.push({ ...event, index: Number.isFinite(match.index) ? match.index : 0 });
  }
}

function resolveRunnerForEvent(rawName, defaultSide, batterRef, bases) {
  const normalized = normalizePlayerName(rawName || "");
  if (!normalized) {
    return null;
  }

  if (batterRef && nameKey(batterRef.name) === nameKey(normalized)) {
    return batterRef;
  }

  const baseMatched = matchRunnerFromBasesByShortName(normalized, bases);
  if (baseMatched) {
    return baseMatched;
  }

  return resolvePlayerRef(null, normalized, defaultSide);
}

function matchRunnerFromBasesByShortName(rawName, bases) {
  const token = nameKey(rawName || "");
  if (!token || token.includes(" ")) {
    return null;
  }

  const occupied = [bases?.first, bases?.second, bases?.third].filter(Boolean);
  const candidates = occupied.filter((runner) => lastNameKey(runner?.name || "") === token);
  if (candidates.length === 1) {
    return candidates[0];
  }
  return null;
}

function resolvePlayerRef(playerId, playerName, preferredSide) {
  if (!playerDirectory) {
    return null;
  }

  if (playerId && playerDirectory.byId.has(playerId)) {
    return playerDirectory.byId.get(playerId);
  }

  const normalizedName = normalizePlayerName(playerName || "");
  if (!normalizedName) {
    return null;
  }

  const key = nameKey(normalizedName);
  if (preferredSide === "away" || preferredSide === "home") {
    const bySide = playerDirectory.bySideName[preferredSide].get(key);
    if (bySide) {
      return bySide;
    }
  }

  for (const side of ["away", "home"]) {
    const found = playerDirectory.bySideName[side].get(key);
    if (found) {
      return found;
    }
  }

  return createUnknownPlayer(normalizedName, preferredSide);
}

function createUnknownPlayer(name, preferredSide) {
  const bucket = preferredSide === "away" || preferredSide === "home" ? preferredSide : "none";
  const key = nameKey(name);
  const cache = playerDirectory.unknownBySideName[bucket];
  if (cache.has(key)) {
    return cache.get(key);
  }

  const side = bucket === "none" ? null : bucket;
  const ref = {
    key: `unknown:${bucket}:${key}`,
    playerId: null,
    name,
    side,
    jersey: null,
    color: side === "away" ? teamContext.awayColor : side === "home" ? teamContext.homeColor : "#555555",
  };
  cache.set(key, ref);
  return ref;
}

function applyRunnerOut(next, moves, runnerRef, baseHint) {
  let startBase = locateRunnerBase(next.bases, runnerRef);
  const normalizedBase = canonicalBase(baseHint || null);
  if (!startBase && normalizedBase) {
    startBase = normalizedBase === "first" ? "home" : normalizedBase;
  }
  const outBase = normalizedBase;

  if (startBase && isSameRunner(next.bases[startBase], runnerRef)) {
    next.bases[startBase] = null;
  }

  moves.push({
    runner: runnerRef,
    startBase: startBase || null,
    endBase: "out",
    outBase,
    kind: "out",
  });
}

function applyRunnerMovement(next, moves, runnerRef, targetBase, options = {}) {
  const destination = canonicalBase(targetBase);
  const fromHint = canonicalBase(options.fromHint);
  const defaultStart = canonicalBase(options.defaultStart);

  let startBase = locateRunnerBase(next.bases, runnerRef);
  if (!startBase && fromHint) {
    startBase = fromHint;
  }
  if (!startBase && defaultStart) {
    startBase = defaultStart;
  }

  if (startBase && isSameRunner(next.bases[startBase], runnerRef)) {
    next.bases[startBase] = null;
  }

  if (destination === "first" || destination === "second" || destination === "third") {
    next.bases[destination] = runnerRef;
  }

  moves.push({
    runner: runnerRef,
    startBase: startBase || null,
    endBase: destination,
    kind: options.eventKind || "advance",
  });
}

function locateRunnerBase(bases, runnerRef) {
  if (!runnerRef) {
    return null;
  }

  for (const base of ["first", "second", "third"]) {
    if (isSameRunner(bases[base], runnerRef)) {
      return base;
    }
  }

  return null;
}

function isSameRunner(a, b) {
  if (!a || !b) {
    return false;
  }

  if (a.key && b.key && a.key === b.key) {
    return true;
  }

  const aName = nameKey(a.name || "");
  const bName = nameKey(b.name || "");
  return Boolean(aName) && aName === bName;
}

function resolveBallTarget(play, text) {
  const code = Number(play?.battedBall?.fieldLocations?.[0]?.code ?? NaN);
  if (Number.isFinite(code) && FIELD_COORDS[code]) {
    return FIELD_COORDS[code];
  }

  const lower = String(text || "").toLowerCase();
  const patterns = [
    { regex: /\bright\s*center\b/, coord: { x: 390, y: 160, label: "RC" } },
    { regex: /\bleft\s*center\b/, coord: { x: 210, y: 160, label: "LC" } },
    { regex: /\bcenter\s+field\b|\bcf\b/, coord: FIELD_COORDS[8] },
    { regex: /\bleft\s+field\b|\blf\b/, coord: FIELD_COORDS[7] },
    { regex: /\bright\s+field\b|\brf\b/, coord: FIELD_COORDS[9] },
    { regex: /\bshortstop\b|\bss\b|\bshort\b/, coord: FIELD_COORDS[6] },
    { regex: /\bsecond\s+base\b|\b2b\b/, coord: FIELD_COORDS[4] },
    { regex: /\bthird\s+base\b|\b3b\b/, coord: FIELD_COORDS[5] },
    { regex: /\bfirst\s+base\b|\b1b\b/, coord: FIELD_COORDS[3] },
    { regex: /\bpitcher\b/, coord: FIELD_COORDS[1] },
    { regex: /\bcatcher\b/, coord: FIELD_COORDS[2] },
  ];

  for (const entry of patterns) {
    if (entry.regex.test(lower)) {
      return entry.coord;
    }
  }

  return null;
}

function inferOutcomeFromText(text) {
  const lower = String(text || "").toLowerCase();

  if (lower.includes("homered") || lower.includes("home run")) {
    return "home_run";
  }
  if (lower.includes("tripled")) {
    return "triple";
  }
  if (lower.includes("doubled")) {
    return "double";
  }
  if (lower.includes("singled")) {
    return "single";
  }
  if (lower.includes("intentionally walked")) {
    return "intentional_walk";
  }
  if (lower.includes("walked")) {
    return "walk";
  }
  if (lower.includes("struck out")) {
    return "strikeout";
  }
  if (lower.includes("grounded out")) {
    return "ground_out";
  }
  if (lower.includes("flied out")) {
    return "fly_out";
  }
  if (lower.includes("lined out")) {
    return "line_out";
  }

  return "other";
}

function inferOuts(currentOuts, outcome, text) {
  let outs = Number.isFinite(currentOuts) ? currentOuts : 0;
  const lower = String(text || "").toLowerCase();

  if (["strikeout", "ground_out", "fly_out", "line_out", "foul_out", "sacrifice"].includes(outcome)) {
    outs += 1;
  }

  if (outcome === "caught_stealing") {
    outs += 1;
  }

  if (/\bdouble play\b/.test(lower)) {
    outs += 1;
  }
  if (/\btriple play\b/.test(lower)) {
    outs += 2;
  }

  return clampOuts(outs);
}

function renderScoreboard(teams) {
  const awaySoft = toRgba(teams.awayColor, 0.16);
  const homeSoft = toRgba(teams.homeColor, 0.16);
  scoreboardEl.innerHTML = `
    <div class="pbp-team pbp-away" style="--pbp-team-color:${escapeHtml(teams.awayColor)};--pbp-team-soft:${escapeHtml(awaySoft)}">
      <p class="score-label">Away</p>
      <p class="score-name">${escapeHtml(teams.awayName)}</p>
      <p id="pbp-away-score" class="score-value">0</p>
    </div>

    <div class="pbp-status">
      <p id="pbp-status-inning" class="pbp-score-inning">-</p>
      <div class="pbp-mini-counts">
        <div class="pbp-mini-count"><span>B</span><strong id="pbp-balls">-</strong></div>
        <div class="pbp-mini-count"><span>S</span><strong id="pbp-strikes">-</strong></div>
        <div class="pbp-mini-count"><span>O</span><strong id="pbp-outs">0</strong></div>
      </div>
      <p id="pbp-status-atbat" class="pbp-score-line">At Bat: -</p>
      <p id="pbp-status-batter" class="pbp-score-line">Batter: -</p>
      <p id="pbp-status-pitcher" class="pbp-score-line">Pitcher: -</p>
      <p id="pbp-status-pitchcount" class="pbp-score-line">Pitch Count: -</p>
    </div>

    <div class="pbp-team pbp-home" style="--pbp-team-color:${escapeHtml(teams.homeColor)};--pbp-team-soft:${escapeHtml(homeSoft)}">
      <p class="score-label">Home</p>
      <p class="score-name">${escapeHtml(teams.homeName)}</p>
      <p id="pbp-home-score" class="score-value">0</p>
    </div>
  `;
}

function renderFeed() {
  feedEl.innerHTML = "";

  snapshots.forEach((snapshot, index) => {
    const item = document.createElement("li");
    item.className = "pbp-feed-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "pbp-feed-btn";
    button.dataset.index = String(index);
    button.innerHTML = `
      <span class="pbp-feed-inning">${formatInning(snapshot.play?.half, snapshot.play?.inning)}</span>
      <span class="pbp-feed-text">${escapeHtml(normalizeNamesInText(snapshot.play?.text || ""))}</span>
    `;

    button.addEventListener("click", () => {
      currentIndex = index;
      renderCurrent(true);
    });

    item.appendChild(button);
    feedEl.appendChild(item);
  });
}

function renderCurrent(animate) {
  if (snapshots.length === 0) {
    return;
  }

  currentIndex = Math.max(0, Math.min(snapshots.length - 1, currentIndex));
  const snapshot = snapshots[currentIndex];

  playIndexEl.textContent = `Play ${currentIndex + 1} / ${snapshots.length}`;
  inningEl.textContent = formatInning(snapshot.play?.half, snapshot.play?.inning);

  setText("pbp-away-score", snapshot.after.score.away);
  setText("pbp-home-score", snapshot.after.score.home);
  setText("pbp-status-inning", formatInning(snapshot.after.half, snapshot.after.inning));
  setText("pbp-outs", snapshot.after.outs);

  const pitchContext = snapshot.play?.pitchContext;
  const balls = Number.isFinite(pitchContext?.finalCount?.balls) ? pitchContext.finalCount.balls : "-";
  const strikes = Number.isFinite(pitchContext?.finalCount?.strikes) ? pitchContext.finalCount.strikes : "-";
  setText("pbp-balls", balls);
  setText("pbp-strikes", strikes);

  const batterLabel = formatPlayerLabel(snapshot.batterRef, snapshot.play?.participants?.batterName || "Unknown Batter");
  const pitcherLabel = formatPlayerLabel(snapshot.pitcherRef, snapshot.play?.participants?.pitcherName || "Unknown Pitcher");
  const battingTeam = snapshot.play?.battingTeam || (snapshot.play?.battingSide === "away" ? teamContext.awayName : teamContext.homeName);

  setText("pbp-status-atbat", `At Bat: ${battingTeam || "-"}`);
  setText("pbp-status-batter", `Batter: ${batterLabel}`);
  setText("pbp-status-pitcher", `Pitcher: ${pitcherLabel}`);
  setText(
    "pbp-status-pitchcount",
    `Pitch Count: ${snapshot.pitcherRef ? snapshot.pitcherPitchCount : "-"}`
  );

  atBatEl.textContent = `${battingTeam} batting: ${batterLabel} vs ${pitcherLabel}`;
  playTextEl.textContent = normalizeNamesInText(snapshot.play?.text || "");
  countEl.textContent = `Count: ${balls}-${strikes}`;

  renderPitches(pitchContext?.pitches || []);

  if (animate) {
    animateRunners(snapshot);
  } else {
    renderBaseRunners(snapshot.after.bases);
  }
  renderBallTrajectory(snapshot, animate);

  feedEl.querySelectorAll(".pbp-feed-btn").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.index) === currentIndex);
  });

  const activeButton = feedEl.querySelector(`.pbp-feed-btn[data-index="${currentIndex}"]`);
  if (activeButton) {
    activeButton.scrollIntoView({ block: "nearest" });
  }

  prevBtn.disabled = currentIndex <= 0;
  nextBtn.disabled = currentIndex >= snapshots.length - 1;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = String(value ?? "-");
}

function renderPitches(pitches) {
  pitchesEl.innerHTML = "";
  if (!Array.isArray(pitches) || pitches.length === 0) {
    const empty = document.createElement("span");
    empty.className = "pbp-pitch-chip pbp-pitch-empty";
    empty.textContent = "No pitch sequence";
    pitchesEl.appendChild(empty);
    return;
  }

  pitches.forEach((pitch) => {
    const chip = document.createElement("span");
    chip.className = "pbp-pitch-chip";
    chip.textContent = `${pitch.code}: ${String(pitch.description || "").replace(/_/g, " ")}`;
    pitchesEl.appendChild(chip);
  });
}

function renderBallTrajectory(snapshot, animate) {
  if (!ballLayerEl) {
    return;
  }

  ballLayerEl.innerHTML = "";

  const plan = buildBallAnimationPlan(snapshot);
  if (!plan || plan.points.length < 2) {
    ballLineEl.setAttribute("opacity", "0");
    ballLabelEl.setAttribute("opacity", "0");
    return;
  }

  const firstPoint = plan.points[0];
  const lastPoint = plan.points[plan.points.length - 1];
  const contactPoint = plan.contactPoint || plan.points[1] || lastPoint;
  ballLineEl.setAttribute("x1", String(firstPoint.x));
  ballLineEl.setAttribute("y1", String(firstPoint.y));
  ballLineEl.setAttribute("x2", String(contactPoint.x));
  ballLineEl.setAttribute("y2", String(contactPoint.y));
  ballLineEl.setAttribute("opacity", "1");

  ballLabelEl.setAttribute("x", String((firstPoint.x + contactPoint.x) / 2));
  ballLabelEl.setAttribute("y", String((firstPoint.y + contactPoint.y) / 2 - 10));
  ballLabelEl.textContent = plan.label;
  ballLabelEl.setAttribute("opacity", "1");

  ballLineEl.classList.remove("animate");
  ballLabelEl.classList.remove("animate");
  void ballLineEl.getBoundingClientRect();
  ballLineEl.classList.add("animate");
  ballLabelEl.classList.add("animate");

  const ball = document.createElement("div");
  ball.className = "pbp-ball-token";
  ball.style.setProperty("--ball-step-ms", `${BALL_LEG_DURATION_MS}ms`);
  setOverlayPosition(ball, firstPoint);
  ballLayerEl.appendChild(ball);

  if (!animate) {
    setOverlayPosition(ball, lastPoint);
    ball.classList.add("fade");
    return;
  }

  animateOverlayAlongPoints(ball, plan.points, BALL_LEG_DURATION_MS, BALL_LEG_PAUSE_MS);
  plan.outCalls.forEach((call) => {
    window.setTimeout(() => spawnOutCall(call.base), call.delayMs);
  });

  const totalMs = estimatePathDuration(plan.points, BALL_LEG_DURATION_MS, BALL_LEG_PAUSE_MS);
  window.setTimeout(() => ball.classList.add("fade"), Math.max(120, totalMs + 120));
}

function buildBallAnimationPlan(snapshot) {
  const play = snapshot?.play || null;
  const text = String(play?.text || "");
  const throwChain = parseThrowChainTokens(text);
  const points = [{ ...BASE_COORDS.home, label: "Home", base: "home" }];
  let contactPoint = null;

  if (throwChain.length > 0) {
    const firstTouch = mapThrowTokenToPoint(throwChain[0]);
    if (firstTouch) {
      contactPoint = firstTouch;
    }

    throwChain.forEach((token) => {
      const point = mapThrowTokenToPoint(token);
      if (!point) {
        return;
      }
      const last = points[points.length - 1];
      if (last && last.x === point.x && last.y === point.y) {
        return;
      }
      points.push(point);
    });
  } else {
    const target = snapshot?.animation?.ballTarget || null;
    if (target) {
      const point = { x: target.x, y: target.y, label: target.label || null, base: null };
      contactPoint = point;
      points.push(point);
    }
  }

  if (!contactPoint && points.length > 1) {
    contactPoint = points[1];
  }

  const outBases = deriveOutBases(snapshot, text, throwChain);
  const outCalls = [];
  let searchStart = 1;
  outBases.forEach((base) => {
    let foundIndex = -1;
    for (let index = searchStart; index < points.length; index += 1) {
      if (points[index]?.base === base) {
        foundIndex = index;
        break;
      }
    }
    if (foundIndex === -1) {
      return;
    }

    searchStart = foundIndex + 1;
    outCalls.push({
      base,
      delayMs: estimatePathDuration(points.slice(0, foundIndex + 1), BALL_LEG_DURATION_MS, BALL_LEG_PAUSE_MS),
    });
  });

  return {
    points,
    contactPoint,
    label: snapshot?.animation?.outcomeLabel || "Play",
    outCalls,
  };
}

function deriveOutBases(snapshot, text, throwChain) {
  const fromMoves = [];
  const moves = Array.isArray(snapshot?.animation?.moves) ? snapshot.animation.moves : [];
  moves.forEach((move) => {
    if (move?.kind !== "out") {
      return;
    }
    const base = canonicalBase(move.outBase || null);
    if (!base) {
      return;
    }
    if (!fromMoves.includes(base)) {
      fromMoves.push(base);
    }
  });
  const throwTargets = throwChain
    .slice(1)
    .map((token) => tokenToBase(token))
    .filter((base) => Boolean(base));

  const lower = String(text || "").toLowerCase();
  let outCount = 0;
  if (/\btriple play\b/.test(lower)) {
    outCount = 3;
  } else if (/\bdouble play\b/.test(lower)) {
    outCount = 2;
  } else {
    const outcome = snapshot?.play?.result?.outcome || "";
    if (
      ["strikeout", "ground_out", "fly_out", "line_out", "foul_out", "caught_stealing"].includes(outcome)
    ) {
      outCount = 1;
    }
  }

  if (outCount <= 0) {
    return fromMoves;
  }

  const ordered = [...fromMoves];
  if (ordered.length >= outCount || throwTargets.length === 0) {
    return ordered.slice(0, outCount);
  }

  for (const base of throwTargets) {
    if (!ordered.includes(base)) {
      ordered.push(base);
    }
    if (ordered.length >= outCount) {
      break;
    }
  }

  return ordered.slice(0, outCount);
}

function parseThrowChainTokens(text) {
  const lower = String(text || "").toLowerCase();
  const match = lower.match(/\b(?:p|c|1b|2b|3b|ss|lf|cf|rf)(?:\s+to\s+(?:p|c|1b|2b|3b|ss|lf|cf|rf))+\b/);
  if (!match) {
    return [];
  }

  return match[0]
    .split(/\s+to\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function mapThrowTokenToPoint(token) {
  const normalized = String(token || "").toLowerCase().trim();
  if (!normalized) {
    return null;
  }

  if (normalized === "1b") {
    return { ...BASE_COORDS.first, label: "1B", base: "first" };
  }
  if (normalized === "2b") {
    return { ...BASE_COORDS.second, label: "2B", base: "second" };
  }
  if (normalized === "3b") {
    return { ...BASE_COORDS.third, label: "3B", base: "third" };
  }
  if (normalized === "c") {
    return { ...BASE_COORDS.home, label: "C", base: "home" };
  }
  if (normalized === "ss") {
    return { ...FIELD_COORDS[6], label: "SS", base: null };
  }
  if (normalized === "p") {
    return { ...FIELD_COORDS[1], label: "P", base: null };
  }
  if (normalized === "lf") {
    return { ...FIELD_COORDS[7], label: "LF", base: null };
  }
  if (normalized === "cf") {
    return { ...FIELD_COORDS[8], label: "CF", base: null };
  }
  if (normalized === "rf") {
    return { ...FIELD_COORDS[9], label: "RF", base: null };
  }

  return null;
}

function tokenToBase(token) {
  const normalized = String(token || "").toLowerCase().trim();
  if (normalized === "1b") {
    return "first";
  }
  if (normalized === "2b") {
    return "second";
  }
  if (normalized === "3b") {
    return "third";
  }
  if (normalized === "c") {
    return "home";
  }
  return null;
}

function animateOverlayAlongPoints(node, points, legDurationMs, legPauseMs) {
  const path = Array.isArray(points) ? points : [];
  if (path.length <= 1) {
    return;
  }

  node.style.setProperty("--ball-step-ms", `${legDurationMs}ms`);
  let delay = 0;
  for (let index = 1; index < path.length; index += 1) {
    const point = path[index];
    delay += index === 1 ? 16 : legDurationMs + legPauseMs;
    window.setTimeout(() => setOverlayPosition(node, point), delay);
  }
}

function setOverlayPosition(node, point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }
  node.style.left = `${(x / 600) * 100}%`;
  node.style.top = `${(y / 600) * 100}%`;
}

function spawnOutCall(base) {
  if (!ballLayerEl) {
    return;
  }

  const point = BASE_COORDS[base];
  if (!point) {
    return;
  }

  const call = document.createElement("div");
  call.className = "pbp-out-call";
  call.textContent = `Out @ ${baseLabel(base)}`;
  setOverlayPosition(call, {
    x: point.x,
    y: point.y - 24,
  });
  ballLayerEl.appendChild(call);

  window.setTimeout(() => {
    if (call.parentNode === ballLayerEl) {
      ballLayerEl.removeChild(call);
    }
  }, 950);
}

function baseLabel(base) {
  if (base === "first") {
    return "1B";
  }
  if (base === "second") {
    return "2B";
  }
  if (base === "third") {
    return "3B";
  }
  if (base === "home") {
    return "Home";
  }
  return String(base || "").toUpperCase();
}

function renderBaseRunners(bases, options = {}) {
  const excludeRunnerKeys =
    options.excludeRunnerKeys instanceof Set ? options.excludeRunnerKeys : new Set();
  const excludeRunnerNames =
    options.excludeRunnerNames instanceof Set ? options.excludeRunnerNames : new Set();

  runnerLayerEl.innerHTML = "";

  for (const base of ["third", "second", "first"]) {
    const runner = bases[base];
    if (!runner) {
      continue;
    }
    if (excludeRunnerKeys.has(runner.key)) {
      continue;
    }
    if (excludeRunnerNames.has(nameKey(runner.name || ""))) {
      continue;
    }

    const token = makeRunnerToken(runner, "static");
    setTokenPosition(token, base);
    runnerLayerEl.appendChild(token);
  }
}

function animateRunners(snapshot) {
  runnerLayerEl.innerHTML = "";

  const baseMoves = Array.isArray(snapshot.animation.moves)
    ? snapshot.animation.moves.filter((move) => Boolean(move?.endBase))
    : [];

  const transitions = baseMoves
    .map((move) => {
      const outBase = canonicalBase(move.outBase || null);
      const resolvedStart = move.startBase || locateRunnerBase(snapshot.before.bases, move.runner);
      const path =
        move.kind === "out" && outBase
          ? buildRunnerPath(resolvedStart || "home", outBase)
          : buildRunnerPath(resolvedStart || "home", move.endBase || "out");
      return {
        move,
        outBase,
        resolvedStart,
        path,
      };
    })
    .filter((entry) => Array.isArray(entry.path) && entry.path.length > 1);

  const movingRunnerKeys = new Set(
    transitions
      .map((entry) => entry.move?.runner?.key || null)
      .filter((key) => Boolean(key))
  );
  const movingRunnerNames = new Set(
    transitions
      .map((entry) => nameKey(entry.move?.runner?.name || ""))
      .filter((value) => Boolean(value))
  );

  renderBaseRunners(snapshot.before.bases, {
    excludeRunnerKeys: movingRunnerKeys,
    excludeRunnerNames: movingRunnerNames,
  });

  if (transitions.length === 0) {
    renderBaseRunners(snapshot.after.bases);
    return;
  }

  const floating = transitions.map((entry) => {
    const token = makeRunnerToken(entry.move.runner, "moving");
    const path = entry.path;
    setTokenPosition(token, path[0] || "home");
    runnerLayerEl.appendChild(token);
    return { token, path, move: entry.move };
  });

  const maxDurationMs = floating.reduce((max, entry) => {
    return Math.max(max, estimatePathDuration(entry.path, RUNNER_LEG_DURATION_MS, RUNNER_LEG_PAUSE_MS));
  }, 0);

  requestAnimationFrame(() => {
    floating.forEach(({ token, path, move }) => {
      animateTokenAlongPath(token, path, RUNNER_LEG_DURATION_MS, RUNNER_LEG_PAUSE_MS);
      const endBase = path[path.length - 1] || "out";
      if (move.kind === "out" || endBase === "home" || endBase === "out") {
        const fadeDelay = Math.max(
          80,
          estimatePathDuration(path, RUNNER_LEG_DURATION_MS, RUNNER_LEG_PAUSE_MS) - 120
        );
        window.setTimeout(() => token.classList.add("fade-after-run"), fadeDelay);
      }
    });
  });

  window.setTimeout(() => {
    renderBaseRunners(snapshot.after.bases);
  }, Math.max(220, maxDurationMs + 120));
}

function makeRunnerToken(runner, mode) {
  const token = document.createElement("div");
  token.className = `pbp-runner-token ${mode === "moving" ? "moving" : ""}`;

  const color = safeColor(runner?.color) || "#103F88";
  const textColor = contrastTextColor(color);
  token.style.setProperty("--runner-color", color);
  token.style.setProperty("--runner-ink", textColor);

  token.title = formatPlayerLabel(runner, runner?.name || "Runner");
  token.textContent = Number.isFinite(runner?.jersey) ? String(runner.jersey) : "--";
  return token;
}

function setTokenPosition(token, base) {
  const position = BASE_COORDS[base] || BASE_COORDS.home;
  token.style.left = `${(position.x / 600) * 100}%`;
  token.style.top = `${(position.y / 600) * 100}%`;
}

function buildRunnerPath(startBase, endBase) {
  const start = canonicalBase(startBase) || "home";
  const end = canonicalBase(endBase) || "out";

  if (start === "home" && end === "home") {
    return ["home", "first", "second", "third", "home"];
  }

  if (start === end) {
    return [start];
  }

  if (end === "out") {
    return [start, "out"];
  }

  const ringIndex = {
    home: 0,
    first: 1,
    second: 2,
    third: 3,
  };

  const startIndex = ringIndex[start];
  const endIndexRaw = ringIndex[end];
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndexRaw)) {
    return [start, end];
  }

  const endIndex = end === "home" ? 4 : endIndexRaw;
  if (endIndex <= startIndex) {
    return [start, end];
  }

  const ring = ["home", "first", "second", "third", "home"];
  const path = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    path.push(ring[index]);
  }
  return path;
}

function inferBatterOutAtFirst(text, outcome) {
  const lower = String(text || "").toLowerCase();
  if (outcome !== "ground_out" && outcome !== "other") {
    return false;
  }

  if (/\bout(?:[^;,]*?)\sat\s+first\s+base\b/.test(lower)) {
    return true;
  }

  const throwChain = parseThrowChainTokens(lower);
  if (throwChain.length < 2) {
    return false;
  }

  return throwChain.includes("1b");
}

function estimatePathDuration(path, legDurationMs, legPauseMs) {
  const steps = Array.isArray(path) ? path.length : 0;
  if (steps <= 1) {
    return 0;
  }
  const legs = steps - 1;
  return legs * legDurationMs + Math.max(0, legs - 1) * legPauseMs;
}

function animateTokenAlongPath(token, path, legDurationMs, legPauseMs) {
  const points = Array.isArray(path) ? path : [];
  if (points.length <= 1) {
    return;
  }

  token.style.setProperty("--runner-step-ms", `${legDurationMs}ms`);

  let delay = 0;
  for (let index = 1; index < points.length; index += 1) {
    const waypoint = points[index];
    delay += index === 1 ? 16 : legDurationMs + legPauseMs;
    window.setTimeout(() => setTokenPosition(token, waypoint), delay);
  }
}

function step(delta) {
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= snapshots.length) {
    stopAutoplay();
    return;
  }

  currentIndex = nextIndex;
  renderCurrent(true);
}

function toggleAutoplay() {
  if (autoplayTimer) {
    stopAutoplay();
    return;
  }

  autoplayTimer = window.setInterval(() => {
    if (currentIndex >= snapshots.length - 1) {
      stopAutoplay();
      return;
    }
    step(1);
  }, 2200);

  autoplayBtn.textContent = "Pause";
  autoplayBtn.classList.add("active");
}

function stopAutoplay() {
  if (autoplayTimer) {
    clearInterval(autoplayTimer);
    autoplayTimer = null;
  }
  autoplayBtn.textContent = "Autoplay";
  autoplayBtn.classList.remove("active");
}

function setControlsDisabled(disabled) {
  prevBtn.disabled = disabled;
  nextBtn.disabled = disabled;
  autoplayBtn.disabled = disabled;
  refreshBtn.disabled = disabled;
}

function canonicalBase(raw) {
  const value = String(raw || "").toLowerCase().trim();
  if (value === "first" || value === "1b" || value === "1st") {
    return "first";
  }
  if (value === "second" || value === "2b" || value === "2nd") {
    return "second";
  }
  if (value === "third" || value === "3b" || value === "3rd") {
    return "third";
  }
  if (value === "home" || value === "home plate") {
    return "home";
  }
  if (value === "out") {
    return "out";
  }
  return value || null;
}

function parseSideFromPlayerId(playerId) {
  const raw = String(playerId || "").trim();
  if (raw.startsWith("away:")) {
    return "away";
  }
  if (raw.startsWith("home:")) {
    return "home";
  }
  return null;
}

function normalizePlayerName(value) {
  const clean = String(value || "").trim();
  if (!clean) {
    return "";
  }

  if (!clean.includes(",")) {
    return clean.replace(/\s+/g, " ").trim();
  }

  const commaIndex = clean.indexOf(",");
  const last = clean.slice(0, commaIndex).trim();
  const first = clean.slice(commaIndex + 1).trim();
  if (!first || !last) {
    return clean.replace(/\s+/g, " ").trim();
  }

  return `${first} ${last}`.replace(/\s+/g, " ").trim();
}

function normalizeNamesInText(value) {
  return String(value || "").replace(
    /\b([A-Z][A-Za-z'.-]+),\s*([A-Z][A-Za-z'.-]+)\b/g,
    (_match, last, first) => `${first} ${last}`
  );
}

function nameKey(value) {
  return normalizePlayerName(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastNameKey(value) {
  const normalized = normalizePlayerName(value || "");
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  return nameKey(parts[parts.length - 1]);
}

function resolveTeamColor(teamName, fallback) {
  const safe = window.ncaabsbBranding?.safeColor;
  const lookup = window.ncaabsbBranding?.lookup;
  if (!safe || !lookup) {
    return fallback;
  }

  const branding = lookup(teamName);
  return safe(branding?.colors?.primary) || safe(branding?.colors?.secondary) || fallback;
}

function formatInning(half, inning) {
  const halfLabel = half === "top" ? "Top" : half === "bottom" ? "Bot" : "-";
  const inningLabel = Number.isFinite(inning) ? String(inning) : "-";
  return `${halfLabel} ${inningLabel}`;
}

function formatPlayerLabel(playerRef, fallbackName) {
  const name = playerRef?.name || normalizePlayerName(fallbackName || "") || "Unknown";
  const jersey = Number.isFinite(playerRef?.jersey) ? ` #${playerRef.jersey}` : "";
  return `${name}${jersey}`;
}

function emptyBases() {
  return {
    first: null,
    second: null,
    third: null,
  };
}

function cloneState(state) {
  return {
    inning: state.inning,
    half: state.half,
    outs: state.outs,
    battingSide: state.battingSide,
    battingTeam: state.battingTeam,
    score: {
      away: state.score.away,
      home: state.score.home,
    },
    bases: {
      first: state.bases.first,
      second: state.bases.second,
      third: state.bases.third,
    },
  };
}

function clampOuts(value) {
  const n = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(3, n));
}

function safeColor(value) {
  const raw = String(value || "").trim().replace(/^#/u, "");
  if (!/^[0-9a-fA-F]{6}$/u.test(raw)) {
    return null;
  }
  return `#${raw.toUpperCase()}`;
}

function contrastTextColor(hex) {
  const clean = String(hex || "").replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return "#FFFFFF";
  }

  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#0E182A" : "#FFFFFF";
}

function toRgba(hex, alpha) {
  const clean = String(hex || "").replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return "rgba(0,0,0,0.08)";
  }

  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function toTitleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
