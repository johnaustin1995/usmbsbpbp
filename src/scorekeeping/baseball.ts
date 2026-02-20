import type {
  FinalPlayByPlayEvent,
  FinalScoringPlay,
  StatBroadcastFinalGame,
  StatsTable,
  StatsTableRow,
} from "../types";

type TeamSide = "away" | "home";

export interface BaseballScorekeepingData {
  schemaVersion: "2.0.0";
  parserVersion: string;
  generatedAt: string;
  game: {
    id: number;
    status: StatBroadcastFinalGame["status"];
    title: string;
    date: string | null;
    time: string | null;
    venue: string | null;
    location: string | null;
    attendance: number | null;
    duration: string | null;
    umpires: {
      hp: string | null;
      firstBase: string | null;
      secondBase: string | null;
      thirdBase: string | null;
      raw: string | null;
    };
  };
  teams: {
    away: BaseballTeamSnapshot;
    home: BaseballTeamSnapshot;
  };
  participants: {
    players: Record<string, BaseballPlayer>;
  };
  decisions: {
    winningPitcher: StatBroadcastFinalGame["pitcherDecisions"]["winning"];
    losingPitcher: StatBroadcastFinalGame["pitcherDecisions"]["losing"];
    savePitcher: StatBroadcastFinalGame["pitcherDecisions"]["save"];
  };
  plays: BaseballUnifiedPlay[];
  indexes: {
    scoringPlayIds: string[];
    playIdsByInning: Record<string, string[]>;
  };
  warnings: string[];
}

export interface BaseballTeamSnapshot {
  teamId: string;
  side: TeamSide;
  name: string;
  shortName: string | null;
  finalScore: number | null;
  isWinner: boolean;
  lineScore: {
    innings: number[];
    runsByInning: Array<number | null>;
    totals: {
      runs: number | null;
      hits: number | null;
      errors: number | null;
      leftOnBase: number | null;
    };
  };
  boxScore: {
    batting: BaseballBattingLine[];
    pitching: BaseballPitchingLine[];
  };
}

export interface BaseballPlayer {
  playerId: string;
  name: string;
  normalizedName: string;
  sides: TeamSide[];
  jerseyNumbers: number[];
  positions: string[];
}

export interface BaseballUnifiedPlay {
  playId: string;
  source: "play_by_play" | "scoring_summary";
  inning: number | null;
  half: "top" | "bottom" | null;
  order: number | null;
  battingSide: TeamSide | null;
  battingTeam: string | null;
  text: string;
  participants: {
    batterId: string | null;
    batterName: string | null;
    pitcherId: string | null;
    pitcherName: string | null;
  };
  pitchContext: BaseballPitchContext | null;
  result: {
    outcome: BaseballPlayOutcome;
    tags: string[];
    runsScored: number;
    isScoringPlay: boolean;
    outsAfterPlay: number | null;
  };
  scoring: {
    decisionRaw: string | null;
    decisionContext: BaseballScoringDecisionContext | null;
  };
  battedBall: {
    fielderCodes: number[];
    fieldLocations: BaseballFieldLocation[];
    locationSource: "text" | "scorecard" | "none";
    locationConfidence: number;
  };
}

interface ParsedLineScore {
  innings: number[];
  awayByInning: Array<number | null>;
  homeByInning: Array<number | null>;
  totals: {
    away: { runs: number | null; hits: number | null; errors: number | null; leftOnBase: number | null };
    home: { runs: number | null; hits: number | null; errors: number | null; leftOnBase: number | null };
  };
}

export interface BaseballBattingLine {
  playerId: string | null;
  jersey: number | null;
  player: string;
  position: string | null;
  ab: number | null;
  r: number | null;
  h: number | null;
  rbi: number | null;
  bb: number | null;
  k: number | null;
  lob: number | null;
  sb: number | null;
  cs: number | null;
  avg: string | null;
  isTeamTotal: boolean;
}

export interface BaseballPitchingLine {
  playerId: string | null;
  jersey: number | null;
  player: string;
  decision: string | null;
  decisionCode: "W" | "L" | "S" | null;
  decisionRecord: string | null;
  ip: number | null;
  h: number | null;
  r: number | null;
  er: number | null;
  bb: number | null;
  k: number | null;
  wp: number | null;
  bk: number | null;
  hbp: number | null;
  battersFaced: number | null;
  pitches: number | null;
  strikes: number | null;
  era: number | null;
  rawCells: Array<string | number | null>;
}

export interface BaseballScoringEvent {
  inningNumber: number | null;
  half: "top" | "bottom" | null;
  battingTeam: string | null;
  batter: string | null;
  pitcher: string | null;
  outs: number | null;
  text: string;
  scoringDecision: string | null;
  scoringDecisionContext: BaseballScoringDecisionContext | null;
  outcome: BaseballPlayOutcome;
  tags: string[];
  pitchContext: BaseballPitchContext | null;
  runsScoredOnPlay: number;
}

export interface BaseballScoringDecisionContext {
  playCode: string | null;
  fielderCodes: number[];
  fieldLocations: BaseballFieldLocation[];
  rbi: number | null;
  locationSource: "text" | "scorecard" | "none";
  locationConfidence: number;
}

export interface BaseballFieldLocation {
  code: number;
  abbreviation: string;
  name: string;
}

export interface BaseballPitchContext {
  finalCount: {
    balls: number;
    strikes: number;
  } | null;
  rawSequence: string | null;
  pitches: BaseballPitchToken[];
}

export interface BaseballPitchToken {
  pitchNumber: number;
  code: string;
  description: BaseballPitchDescription;
}

export type BaseballPitchDescription =
  | "ball"
  | "called_strike"
  | "swinging_strike"
  | "foul"
  | "in_play"
  | "hit_by_pitch"
  | "intentional_ball"
  | "pitchout_ball"
  | "pitchout_strike"
  | "unknown";

export type BaseballPlayOutcome =
  | "single"
  | "double"
  | "triple"
  | "home_run"
  | "walk"
  | "intentional_walk"
  | "hit_by_pitch"
  | "strikeout"
  | "ground_out"
  | "fly_out"
  | "line_out"
  | "foul_out"
  | "sacrifice"
  | "fielder_choice"
  | "reached_on_error"
  | "stolen_base"
  | "caught_stealing"
  | "pickoff"
  | "wild_pitch"
  | "passed_ball"
  | "balk"
  | "other";

export function buildBaseballScorekeepingData(finalGame: StatBroadcastFinalGame): BaseballScorekeepingData {
  const warnings: string[] = [];
  const gameInfo = finalGame.notesDocs.gameInformation ?? {};
  const attendance = parseInteger(gameInfo.Attendance ?? gameInfo.attendance ?? null);
  const duration = toStringValue(gameInfo.Duration ?? gameInfo.duration ?? null);
  const rawUmpires = toStringValue(gameInfo.Umpires ?? gameInfo.umpires ?? null);

  const lineScore = buildLineScore(finalGame);
  const awayShortName = cleanTeamShortName(finalGame.summary.lineScore?.rows[0]?.team ?? null);
  const homeShortName = cleanTeamShortName(finalGame.summary.lineScore?.rows[1]?.team ?? null);
  const playerRegistry = createPlayerRegistry();

  const awayBatting = parseBattingTable(finalGame.visitorStats.boxScore, "away", playerRegistry);
  const homeBatting = parseBattingTable(finalGame.homeStats.boxScore, "home", playerRegistry);
  const awayPitching = parsePitchingTable(finalGame.visitorStats.pitching, "away", playerRegistry);
  const homePitching = parsePitchingTable(finalGame.homeStats.pitching, "home", playerRegistry);

  const awayTeam: BaseballTeamSnapshot = {
    teamId: `away:${slugForId(finalGame.finalScore.visitorTeam)}`,
    side: "away",
    name: finalGame.finalScore.visitorTeam,
    shortName: awayShortName,
    finalScore: finalGame.finalScore.visitorScore,
    isWinner: finalGame.finalScore.winner === "visitor",
    lineScore: {
      innings: lineScore.innings,
      runsByInning: lineScore.awayByInning,
      totals: lineScore.totals.away,
    },
    boxScore: {
      batting: awayBatting,
      pitching: awayPitching,
    },
  };

  const homeTeam: BaseballTeamSnapshot = {
    teamId: `home:${slugForId(finalGame.finalScore.homeTeam)}`,
    side: "home",
    name: finalGame.finalScore.homeTeam,
    shortName: homeShortName,
    finalScore: finalGame.finalScore.homeScore,
    isWinner: finalGame.finalScore.winner === "home",
    lineScore: {
      innings: lineScore.innings,
      runsByInning: lineScore.homeByInning,
      totals: lineScore.totals.home,
    },
    boxScore: {
      batting: homeBatting,
      pitching: homePitching,
    },
  };

  const scoringTimeline = finalGame.scoringPlays.map((play) => parseScoringEvent(play));
  const teamTokenLookup = buildTeamTokenLookup(awayTeam, homeTeam, finalGame);
  const plays = buildUnifiedPlays(finalGame, scoringTimeline, playerRegistry, teamTokenLookup, warnings);
  const players = playerRegistry.toRecord();
  const playIdsByInning = buildPlayIdsByInning(plays);
  const scoringPlayIds = plays
    .filter((play) => play.result.isScoringPlay)
    .map((play) => play.playId);

  return {
    schemaVersion: "2.0.0",
    parserVersion: "2.0.0",
    generatedAt: new Date().toISOString(),
    game: {
      id: finalGame.id,
      status: finalGame.status,
      title: finalGame.event.title,
      date: finalGame.event.date,
      time: finalGame.event.time,
      venue: finalGame.event.venue,
      location: finalGame.event.location,
      attendance,
      duration,
      umpires: {
        hp: toStringValue(gameInfo.HP ?? gameInfo.hp ?? null),
        firstBase: toStringValue(gameInfo["1B"] ?? null),
        secondBase: toStringValue(gameInfo["2B"] ?? null),
        thirdBase: toStringValue(gameInfo["3B"] ?? null),
        raw: rawUmpires,
      },
    },
    teams: {
      away: awayTeam,
      home: homeTeam,
    },
    participants: {
      players,
    },
    decisions: {
      winningPitcher: normalizePitcherDecision(finalGame.pitcherDecisions.winning),
      losingPitcher: normalizePitcherDecision(finalGame.pitcherDecisions.losing),
      savePitcher: normalizePitcherDecision(finalGame.pitcherDecisions.save),
    },
    plays,
    indexes: {
      scoringPlayIds,
      playIdsByInning,
    },
    warnings,
  };
}

function buildLineScore(finalGame: StatBroadcastFinalGame): ParsedLineScore {
  const summary = finalGame.summary.lineScore;
  if (!summary || summary.rows.length < 2) {
    return {
      innings: [],
      awayByInning: [],
      homeByInning: [],
      totals: {
        away: { runs: null, hits: null, errors: null, leftOnBase: null },
        home: { runs: null, hits: null, errors: null, leftOnBase: null },
      },
    };
  }

  const innings = summary.headers
    .map((header) => parseInteger(header))
    .filter((value): value is number => value !== null)
    .filter((value) => value > 0 && value < 30);

  const away = summary.rows[0];
  const home = summary.rows[1];

  return {
    innings,
    awayByInning: innings.map((inning) => parseInteger(away.columns[`inning_${inning}`] ?? null)),
    homeByInning: innings.map((inning) => parseInteger(home.columns[`inning_${inning}`] ?? null)),
    totals: {
      away: {
        runs: parseInteger(away.columns.r ?? away.columns.runs ?? null),
        hits: parseInteger(away.columns.h ?? away.columns.hits ?? null),
        errors: parseInteger(away.columns.e ?? away.columns.errors ?? null),
        leftOnBase: parseInteger(away.columns.lob ?? away.columns.l ?? null),
      },
      home: {
        runs: parseInteger(home.columns.r ?? home.columns.runs ?? null),
        hits: parseInteger(home.columns.h ?? home.columns.hits ?? null),
        errors: parseInteger(home.columns.e ?? home.columns.errors ?? null),
        leftOnBase: parseInteger(home.columns.lob ?? home.columns.l ?? null),
      },
    },
  };
}

function parseBattingTable(
  table: StatsTable | null,
  side: TeamSide,
  playerRegistry: PlayerRegistry
): BaseballBattingLine[] {
  if (!table) {
    return [];
  }

  return table.rows
    .map((row) => {
      const rawPlayer = toStringValue(row.values.player ?? row.values.col_3 ?? null);
      if (!rawPlayer) {
        return null;
      }
      const player = normalizePlayerDisplayName(rawPlayer) ?? rawPlayer;

      const jersey = parseInteger(row.values.col_2 ?? row.values["#"] ?? null);
      const position = toStringValue(row.values.pos ?? null);
      const playerId = /^totals?$/i.test(rawPlayer)
        ? null
        : playerRegistry.register(side, rawPlayer, jersey, position);

      return {
        playerId,
        jersey,
        player,
        position,
        ab: parseInteger(row.values.ab ?? null),
        r: parseInteger(row.values.r ?? null),
        h: parseInteger(row.values.h ?? null),
        rbi: parseInteger(row.values.rbi ?? null),
        bb: parseInteger(row.values.bb ?? null),
        k: parseInteger(row.values.k ?? null),
        lob: parseInteger(row.values.lob ?? row.values.l ?? null),
        sb: parseInteger(row.values.sb ?? null),
        cs: parseInteger(row.values.cs ?? null),
        avg: toStringValue(row.values.avg ?? null),
        isTeamTotal: /^totals?$/i.test(rawPlayer),
      };
    })
    .filter((entry): entry is BaseballBattingLine => entry !== null);
}

function parsePitchingTable(
  table: StatsTable | null,
  side: TeamSide,
  playerRegistry: PlayerRegistry
): BaseballPitchingLine[] {
  if (!table) {
    return [];
  }

  return table.rows
    .map((row) => parsePitchingRow(table, row, side, playerRegistry))
    .filter((entry): entry is BaseballPitchingLine => entry !== null);
}

function parsePitchingRow(
  table: StatsTable,
  row: StatsTableRow,
  side: TeamSide,
  playerRegistry: PlayerRegistry
): BaseballPitchingLine | null {
  const rawCells = row.cells;
  const jersey = parseInteger(rawCells[0] ?? null);
  const rawPlayer = toStringValue(rawCells[1] ?? null);
  if (!rawPlayer) {
    return null;
  }
  const player = normalizePlayerDisplayName(rawPlayer) ?? rawPlayer;

  let index = 2;
  let decision: string | null = null;
  const maybeDecision = toStringValue(rawCells[index] ?? null);
  if (maybeDecision && /^[WLS]\b/i.test(maybeDecision)) {
    decision = maybeDecision;
    index += 1;
  }

  const ip = parseNumber(rawCells[index++]);
  const h = parseInteger(rawCells[index++] ?? null);
  const r = parseInteger(rawCells[index++] ?? null);
  const er = parseInteger(rawCells[index++] ?? null);
  const bb = parseInteger(rawCells[index++] ?? null);
  const k = parseInteger(rawCells[index++] ?? null);
  const wp = parseInteger(rawCells[index++] ?? null);
  const bk = parseInteger(rawCells[index++] ?? null);
  const hbp = parseInteger(rawCells[index++] ?? null);
  const battersFaced = parseInteger(rawCells[index++] ?? null);

  const trailing = rawCells.slice(index).map((cell) => parseNumber(cell)).filter((value): value is number => value !== null);
  const inferred = inferPitchCountAndEra(trailing);
  const playerId = playerRegistry.register(side, rawPlayer, jersey, "p");

  return {
    playerId,
    jersey,
    player,
    decision,
    decisionCode: parseDecisionCode(decision),
    decisionRecord: parseDecisionRecord(decision),
    ip,
    h,
    r,
    er,
    bb,
    k,
    wp,
    bk,
    hbp,
    battersFaced,
    pitches: inferred.pitches,
    strikes: inferred.strikes,
    era: inferred.era,
    rawCells: rawCells.map((cell) => normalizeCell(cell)),
  };
}

function inferPitchCountAndEra(values: number[]): { pitches: number | null; strikes: number | null; era: number | null } {
  if (values.length === 0) {
    return { pitches: null, strikes: null, era: null };
  }

  const last = values[values.length - 1];
  const secondLast = values.length >= 2 ? values[values.length - 2] : null;
  const thirdLast = values.length >= 3 ? values[values.length - 3] : null;

  if (secondLast !== null && thirdLast !== null && last <= 30 && !Number.isInteger(last)) {
    return {
      pitches: thirdLast >= secondLast ? thirdLast : secondLast,
      strikes: thirdLast >= secondLast ? secondLast : thirdLast,
      era: last,
    };
  }

  if (secondLast !== null && secondLast >= last && secondLast <= 250) {
    return {
      pitches: secondLast,
      strikes: last,
      era: null,
    };
  }

  return {
    pitches: null,
    strikes: null,
    era: last <= 30 ? last : null,
  };
}

function parseScoringEvent(play: FinalScoringPlay): BaseballScoringEvent {
  const inning = parseHalfInning(play.inning);
  const parsed = parsePlayDescription(play.play);
  const pitchContext = parsePitchContextFromText(play.play);
  const scoringDecisionContext = resolveScoringDecisionContext(play.scoringDecision, play.play);

  return {
    inningNumber: inning.inning,
    half: inning.half,
    battingTeam: play.team,
    batter: normalizePlayerDisplayName(play.batter),
    pitcher: normalizePlayerDisplayName(play.pitcher),
    outs: play.outs,
    text: play.play,
    scoringDecision: play.scoringDecision,
    scoringDecisionContext,
    outcome: parsed.outcome,
    tags: parsed.tags,
    pitchContext,
    runsScoredOnPlay: countRunsScored(play.play),
  };
}

function buildUnifiedPlays(
  finalGame: StatBroadcastFinalGame,
  scoringTimeline: BaseballScoringEvent[],
  playerRegistry: PlayerRegistry,
  teamTokenLookup: TeamTokenLookup,
  warnings: string[]
): BaseballUnifiedPlay[] {
  const plays: BaseballUnifiedPlay[] = [];
  const usedScoring = new Set<number>();

  finalGame.playByPlayByInning.forEach((inningBlock) => {
    let currentHalf: "top" | "bottom" | null = null;
    let order = 0;

    inningBlock.events.forEach((event) => {
      if (event.type === "half") {
        currentHalf = event.half;
      }

      if (event.type !== "play") {
        return;
      }

      order += 1;
      const battingSide = currentHalf === "top" ? "away" : currentHalf === "bottom" ? "home" : null;
      const battingTeam =
        battingSide === "away"
          ? finalGame.finalScore.visitorTeam
          : battingSide === "home"
            ? finalGame.finalScore.homeTeam
            : null;
      const pitchingSide = battingSide === "away" ? "home" : battingSide === "home" ? "away" : null;

      const batterId =
        event.batter && battingSide
          ? playerRegistry.register(battingSide, event.batter, null, null)
          : null;
      const pitcherId =
        event.pitcher && pitchingSide
          ? playerRegistry.register(pitchingSide, event.pitcher, null, "p")
          : null;
      const batterName = normalizePlayerDisplayName(event.batter);
      const pitcherName = normalizePlayerDisplayName(event.pitcher);

      const parsed = parsePlayDescription(event.text);
      const runsScored = countRunsScored(event.text);
      const scoringMatchIndex = findMatchingScoringEventIndex(
        scoringTimeline,
        usedScoring,
        inningBlock.inning,
        currentHalf,
        event
      );
      const scoringMatch = scoringMatchIndex !== null ? scoringTimeline[scoringMatchIndex] : null;
      if (scoringMatchIndex !== null) {
        usedScoring.add(scoringMatchIndex);
      }

      const scoringDecisionRaw = scoringMatch?.scoringDecision ?? null;
      const scoringDecisionContext =
        scoringMatch?.scoringDecisionContext ?? resolveScoringDecisionContext(null, event.text);
      const locationSource = scoringDecisionContext?.locationSource ?? "none";
      const locationConfidence = scoringDecisionContext?.locationConfidence ?? 0;
      const isScoringPlay = scoringMatch !== null || runsScored > 0;

      plays.push({
        playId: `P-${inningBlock.inning}-${currentHalf ?? "u"}-${order}`,
        source: "play_by_play",
        inning: inningBlock.inning,
        half: currentHalf,
        order,
        battingSide,
        battingTeam,
        text: event.text,
        participants: {
          batterId,
          batterName,
          pitcherId,
          pitcherName,
        },
        pitchContext: parsePitchContextFromText(event.text),
        result: {
          outcome: parsed.outcome,
          tags: parsed.tags,
          runsScored,
          isScoringPlay,
          outsAfterPlay: event.outs ?? null,
        },
        scoring: {
          decisionRaw: scoringDecisionRaw,
          decisionContext: scoringDecisionContext,
        },
        battedBall: {
          fielderCodes: scoringDecisionContext?.fielderCodes ?? [],
          fieldLocations: scoringDecisionContext?.fieldLocations ?? [],
          locationSource,
          locationConfidence,
        },
      });
    });
  });

  scoringTimeline.forEach((scoringPlay, index) => {
    if (usedScoring.has(index)) {
      return;
    }

    const battingSide = resolveSideFromTeamToken(scoringPlay.battingTeam, teamTokenLookup);
    const pitchingSide = battingSide === "away" ? "home" : battingSide === "home" ? "away" : null;
    const batterId =
      scoringPlay.batter && battingSide
        ? playerRegistry.register(battingSide, scoringPlay.batter, null, null)
        : null;
    const pitcherId =
      scoringPlay.pitcher && pitchingSide
        ? playerRegistry.register(pitchingSide, scoringPlay.pitcher, null, "p")
        : null;
    const batterName = normalizePlayerDisplayName(scoringPlay.batter);
    const pitcherName = normalizePlayerDisplayName(scoringPlay.pitcher);

    if (!scoringPlay.scoringDecisionContext?.fieldLocations.length && /(?:to|into|toward)\s+[a-z0-9]+/i.test(scoringPlay.text)) {
      warnings.push(
        `Scoring summary play ${index + 1} had textual location but no parsed location: "${scoringPlay.text}"`
      );
    }

    plays.push({
      playId: `S-${index + 1}`,
      source: "scoring_summary",
      inning: scoringPlay.inningNumber,
      half: scoringPlay.half,
      order: null,
      battingSide,
      battingTeam: scoringPlay.battingTeam,
      text: scoringPlay.text,
      participants: {
        batterId,
        batterName,
        pitcherId,
        pitcherName,
      },
      pitchContext: scoringPlay.pitchContext,
      result: {
        outcome: scoringPlay.outcome,
        tags: scoringPlay.tags,
        runsScored: scoringPlay.runsScoredOnPlay,
        isScoringPlay: true,
        outsAfterPlay: scoringPlay.outs,
      },
      scoring: {
        decisionRaw: scoringPlay.scoringDecision,
        decisionContext: scoringPlay.scoringDecisionContext,
      },
      battedBall: {
        fielderCodes: scoringPlay.scoringDecisionContext?.fielderCodes ?? [],
        fieldLocations: scoringPlay.scoringDecisionContext?.fieldLocations ?? [],
        locationSource: scoringPlay.scoringDecisionContext?.locationSource ?? "none",
        locationConfidence: scoringPlay.scoringDecisionContext?.locationConfidence ?? 0,
      },
    });
  });

  return plays;
}

function buildPlayIdsByInning(plays: BaseballUnifiedPlay[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  plays.forEach((play) => {
    const key = play.inning === null ? "unknown" : String(play.inning);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(play.playId);
  });
  return result;
}

function findMatchingScoringEventIndex(
  scoringTimeline: BaseballScoringEvent[],
  usedScoring: Set<number>,
  inning: number,
  half: "top" | "bottom" | null,
  event: FinalPlayByPlayEvent
): number | null {
  const eventText = normalizePlayText(event.text);
  const eventBatter = normalizeName(event.batter);
  const eventPitcher = normalizeName(event.pitcher);
  const eventRuns = countRunsScored(event.text);

  for (let index = 0; index < scoringTimeline.length; index += 1) {
    if (usedScoring.has(index)) {
      continue;
    }
    const scoring = scoringTimeline[index];
    if (scoring.inningNumber !== inning || scoring.half !== half) {
      continue;
    }
    if (normalizePlayText(scoring.text) === eventText) {
      return index;
    }
  }

  for (let index = 0; index < scoringTimeline.length; index += 1) {
    if (usedScoring.has(index)) {
      continue;
    }
    const scoring = scoringTimeline[index];
    if (scoring.inningNumber !== inning || scoring.half !== half) {
      continue;
    }
    if (
      normalizeName(scoring.batter) === eventBatter &&
      normalizeName(scoring.pitcher) === eventPitcher &&
      scoring.runsScoredOnPlay === eventRuns
    ) {
      return index;
    }
  }

  return null;
}

type TeamTokenLookup = Map<string, TeamSide>;

interface PlayerRegistry {
  register: (side: TeamSide, name: string, jersey: number | null, position: string | null) => string;
  toRecord: () => Record<string, BaseballPlayer>;
}

function createPlayerRegistry(): PlayerRegistry {
  const playersById = new Map<string, BaseballPlayer>();
  const idBySideAndName = new Map<string, string>();

  function register(side: TeamSide, name: string, jersey: number | null, position: string | null): string {
    const displayName = normalizePlayerDisplayName(name) ?? name;
    const normalizedName = normalizeName(name);
    const sideNameKey = `${side}|${normalizedName}`;
    const existingByName = idBySideAndName.get(sideNameKey);
    if (existingByName) {
      const existing = playersById.get(existingByName);
      if (existing) {
        if (jersey !== null && !existing.jerseyNumbers.includes(jersey)) {
          existing.jerseyNumbers.push(jersey);
        }
        if (position && !existing.positions.includes(position)) {
          existing.positions.push(position);
        }
        if (!existing.sides.includes(side)) {
          existing.sides.push(side);
        }
      }
      return existingByName;
    }

    const jerseyPart = jersey === null ? "na" : String(jersey);
    const baseId = `${side}:${jerseyPart}:${slugForId(displayName)}`;
    const playerId = uniqueId(baseId, playersById);
    const player: BaseballPlayer = {
      playerId,
      name: displayName,
      normalizedName,
      sides: [side],
      jerseyNumbers: jersey === null ? [] : [jersey],
      positions: position ? [position] : [],
    };
    playersById.set(playerId, player);
    idBySideAndName.set(sideNameKey, playerId);
    return playerId;
  }

  return {
    register,
    toRecord: () => Object.fromEntries(playersById.entries()),
  };
}

function uniqueId(baseId: string, map: Map<string, unknown>): string {
  if (!map.has(baseId)) {
    return baseId;
  }

  let index = 2;
  while (map.has(`${baseId}:${index}`)) {
    index += 1;
  }
  return `${baseId}:${index}`;
}

function buildTeamTokenLookup(
  awayTeam: BaseballTeamSnapshot,
  homeTeam: BaseballTeamSnapshot,
  finalGame: StatBroadcastFinalGame
): TeamTokenLookup {
  const lookup: TeamTokenLookup = new Map();

  const add = (token: string | null | undefined, side: TeamSide): void => {
    const normalized = normalizeTeamToken(token);
    if (!normalized) {
      return;
    }
    lookup.set(normalized, side);
  };

  add(awayTeam.name, "away");
  add(homeTeam.name, "home");
  add(awayTeam.shortName, "away");
  add(homeTeam.shortName, "home");
  add(finalGame.event.visitorName, "away");
  add(finalGame.event.homeName, "home");
  add(finalGame.summary.lineScore?.rows[0]?.team ?? null, "away");
  add(finalGame.summary.lineScore?.rows[1]?.team ?? null, "home");

  return lookup;
}

function resolveSideFromTeamToken(token: string | null, lookup: TeamTokenLookup): TeamSide | null {
  const normalized = normalizeTeamToken(token);
  if (!normalized) {
    return null;
  }
  return lookup.get(normalized) ?? null;
}

function normalizePlayText(value: string | null): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\w]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePitcherDecision(
  decision: StatBroadcastFinalGame["pitcherDecisions"]["winning"]
): StatBroadcastFinalGame["pitcherDecisions"]["winning"] {
  if (!decision) {
    return null;
  }
  const player = normalizePlayerDisplayName(decision.player) ?? decision.player;
  return player === decision.player ? decision : { ...decision, player };
}

function normalizeName(value: string | null): string {
  const display = normalizePlayerDisplayName(value) ?? String(value ?? "");
  return display
    .toLowerCase()
    .replace(/[^\w]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePlayerDisplayName(value: string | null): string | null {
  const clean = toStringValue(value);
  if (!clean) {
    return null;
  }

  if (!clean.includes(",")) {
    return clean.replace(/\s+/g, " ").trim();
  }

  const commaIndex = clean.indexOf(",");
  const lastName = clean.slice(0, commaIndex).trim();
  const firstName = clean.slice(commaIndex + 1).trim();
  if (!firstName || !lastName) {
    return clean.replace(/\s+/g, " ").trim();
  }

  return `${firstName} ${lastName}`.replace(/\s+/g, " ").trim();
}

function normalizeTeamToken(value: string | null | undefined): string {
  const normalized = normalizeName(value ?? null);
  return normalized.length > 0 ? normalized : "";
}

function cleanTeamShortName(value: string | null): string | null {
  const clean = toStringValue(value);
  return clean ? clean.replace(/^#\d+\s+/, "").trim() : null;
}

function slugForId(value: string): string {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export function parsePlayDescription(text: string): { outcome: BaseballPlayOutcome; tags: string[] } {
  const lower = text.toLowerCase();
  const tags = new Set<string>();

  const addTag = (value: string): void => {
    tags.add(value);
  };

  if (/\bdouble play\b/.test(lower)) {
    addTag("double_play");
  }
  if (/\btriple play\b/.test(lower)) {
    addTag("triple_play");
  }
  if (/\bscored\b|\bscores\b/.test(lower)) {
    addTag("run_scored");
  }
  if (/\brbi\b/.test(lower)) {
    addTag("rbi");
  }

  const orderedMatchers: Array<[BaseballPlayOutcome, RegExp, string]> = [
    ["home_run", /\bhomered\b|\bhome run\b/, "home_run"],
    ["triple", /\btripled\b|\btriple(?!\s+play)\b/, "triple"],
    ["double", /\bdoubled\b|\bdouble(?!\s+play)\b/, "double"],
    ["single", /\bsingled\b|\bsingle\b/, "single"],
    ["intentional_walk", /\bintentionally walked\b/, "intentional_walk"],
    ["walk", /\bwalked\b|\bwalk\b/, "walk"],
    ["hit_by_pitch", /\bhit by pitch\b|\bhbp\b/, "hit_by_pitch"],
    ["caught_stealing", /\bcaught stealing\b/, "caught_stealing"],
    ["pickoff", /\bpicked off\b|\bpickoff\b/, "pickoff"],
    ["stolen_base", /\bstole\b|\bstolen base\b/, "stolen_base"],
    ["strikeout", /\bstruck out\b|\bstrikeout\b/, "strikeout"],
    ["ground_out", /\bgrounded out\b|\bground out\b|\bgroundout\b/, "ground_out"],
    ["fly_out", /\bflied out\b|\bfly out\b|\bpopped out\b/, "fly_out"],
    ["line_out", /\blined out\b|\bline out\b/, "line_out"],
    ["foul_out", /\bfouled out\b|\bfoul out\b/, "foul_out"],
    ["sacrifice", /\bsacrifice\b|\bsac fly\b|\bsac bunt\b/, "sacrifice"],
    ["fielder_choice", /\bfielder'?s choice\b/, "fielder_choice"],
    ["reached_on_error", /\breached on an error\b|\breached on a throwing error\b|\breached on error\b/, "error"],
    ["wild_pitch", /\bwild pitch\b/, "wild_pitch"],
    ["passed_ball", /\bpassed ball\b/, "passed_ball"],
    ["balk", /\bbalk\b/, "balk"],
  ];

  for (const [outcome, pattern, tag] of orderedMatchers) {
    if (pattern.test(lower)) {
      addTag(tag);
      return {
        outcome,
        tags: Array.from(tags),
      };
    }
  }

  return {
    outcome: "other",
    tags: Array.from(tags),
  };
}

export function parsePitchContextFromText(text: string): BaseballPitchContext | null {
  const matches = Array.from(text.matchAll(/\((\d)\s*-\s*(\d)(?:\s+([A-Z]+))?\)/g));
  if (matches.length === 0) {
    return null;
  }

  // Prefer the last (balls-strikes + pitch string) sequence in the play text.
  const selected = matches[matches.length - 1];
  const balls = Number.parseInt(selected[1], 10);
  const strikes = Number.parseInt(selected[2], 10);
  const rawSequence = selected[3] ? selected[3].trim().toUpperCase() : null;

  const pitches = rawSequence
    ? rawSequence.split("").map((code, index) => ({
        pitchNumber: index + 1,
        code,
        description: mapPitchCode(code),
      }))
    : [];

  return {
    finalCount: Number.isFinite(balls) && Number.isFinite(strikes) ? { balls, strikes } : null,
    rawSequence,
    pitches,
  };
}

function mapPitchCode(code: string): BaseballPitchDescription {
  switch (code.toUpperCase()) {
    case "B":
      return "ball";
    case "I":
      return "intentional_ball";
    case "P":
      return "pitchout_ball";
    case "Q":
      return "pitchout_strike";
    case "K":
    case "C":
      return "called_strike";
    case "S":
    case "M":
      return "swinging_strike";
    case "F":
    case "L":
    case "T":
      return "foul";
    case "X":
      return "in_play";
    case "H":
      return "hit_by_pitch";
    default:
      return "unknown";
  }
}

export function parseScoringDecisionContext(
  scoringDecision: string | null
): BaseballScoringDecisionContext | null {
  const clean = toStringValue(scoringDecision);
  if (!clean) {
    return null;
  }

  const normalized = clean.toUpperCase();
  const parts = normalized.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }

  const playCodeCandidate = parts[0];
  const playCode =
    /^[A-Z0-9]+$/.test(playCodeCandidate) && !/^\d+RBI$/.test(playCodeCandidate)
      ? playCodeCandidate
      : null;
  const locationToken = parts.find((part) => /^\d+$/.test(part)) ?? null;
  const fielderCodes = locationToken ? locationToken.split("").map((digit) => Number.parseInt(digit, 10)) : [];
  const validFielderCodes = fielderCodes.filter((code) => Number.isInteger(code) && code >= 1 && code <= 9);
  const fieldLocations = validFielderCodes.map((code) => mapFielderCodeToLocation(code));

  const rbiMatch = normalized.match(/(\d+)\s*RBI\b/);
  const rbi = rbiMatch ? Number.parseInt(rbiMatch[1], 10) : /\bRBI\b/.test(normalized) ? 1 : null;

  return {
    playCode,
    fielderCodes: validFielderCodes,
    fieldLocations,
    rbi,
    locationSource: validFielderCodes.length > 0 ? "scorecard" : "none",
    locationConfidence: validFielderCodes.length > 0 ? 0.9 : 0,
  };
}

export function resolveScoringDecisionContext(
  scoringDecision: string | null,
  playText: string
): BaseballScoringDecisionContext | null {
  const base = parseScoringDecisionContext(scoringDecision);
  const textLocations = parseFieldLocationsFromText(playText);

  // Play text location is treated as the source of truth when present.
  if (textLocations.length > 0) {
    const fielderCodes = textLocations.map((location) => location.code);
    if (base) {
      return {
        ...base,
        fielderCodes,
        fieldLocations: textLocations,
        locationSource: "text",
        locationConfidence: 1,
      };
    }

    return {
      playCode: null,
      fielderCodes,
      fieldLocations: textLocations,
      rbi: null,
      locationSource: "text",
      locationConfidence: 1,
    };
  }

  return base;
}

function mapFielderCodeToLocation(code: number): BaseballFieldLocation {
  switch (code) {
    case 1:
      return { code, abbreviation: "P", name: "pitcher" };
    case 2:
      return { code, abbreviation: "C", name: "catcher" };
    case 3:
      return { code, abbreviation: "1B", name: "first base" };
    case 4:
      return { code, abbreviation: "2B", name: "second base" };
    case 5:
      return { code, abbreviation: "3B", name: "third base" };
    case 6:
      return { code, abbreviation: "SS", name: "shortstop" };
    case 7:
      return { code, abbreviation: "LF", name: "left field" };
    case 8:
      return { code, abbreviation: "CF", name: "center field" };
    case 9:
      return { code, abbreviation: "RF", name: "right field" };
    default:
      return { code, abbreviation: "UNK", name: "unknown" };
  }
}

function parseFieldLocationsFromText(playText: string): BaseballFieldLocation[] {
  const lower = playText.toLowerCase();
  const matches: Array<{ code: number; index: number }> = [];

  const addMatches = (pattern: RegExp, code: number): void => {
    const match = lower.match(pattern);
    if (match && typeof match.index === "number") {
      matches.push({ code, index: match.index });
    }
  };

  // Outfield references
  addMatches(/\b(?:to|into|toward|towards|down)\s+(?:deep\s+)?(?:right field|rf)\b/, 9);
  addMatches(/\b(?:to|into|toward|towards|down)\s+(?:deep\s+)?(?:center field|cf)\b/, 8);
  addMatches(/\b(?:to|into|toward|towards|down)\s+(?:deep\s+)?(?:left field|lf)\b/, 7);

  // Infield references
  addMatches(/\b(?:to|toward|towards)\s+(?:pitcher|p)\b/, 1);
  addMatches(/\b(?:to|toward|towards)\s+(?:catcher|c)\b/, 2);
  addMatches(/\b(?:to|toward|towards)\s+(?:first base|1b)\b/, 3);
  addMatches(/\b(?:to|toward|towards)\s+(?:second base|2b)\b/, 4);
  addMatches(/\b(?:to|toward|towards)\s+(?:third base|3b)\b/, 5);
  addMatches(/\b(?:to|toward|towards)\s+(?:shortstop|ss)\b/, 6);

  if (matches.length === 0) {
    return [];
  }

  // Use first textual location mention as primary batted-ball location.
  const sorted = matches.sort((a, b) => a.index - b.index);
  const first = sorted[0];
  return [mapFielderCodeToLocation(first.code)];
}

function parseHalfInning(value: string | null): { half: "top" | "bottom" | null; inning: number | null } {
  if (!value) {
    return { half: null, inning: null };
  }

  const match = value.match(/\b(top|bot|bottom)\s*(\d+)/i);
  if (!match) {
    return { half: null, inning: null };
  }

  return {
    half: /^top/i.test(match[1]) ? "top" : "bottom",
    inning: Number.parseInt(match[2], 10),
  };
}

function countRunsScored(text: string): number {
  const normalized = text.toLowerCase();
  let runs = 0;
  runs += (normalized.match(/\bscored\b/g) ?? []).length;
  runs += (normalized.match(/\bscores\b/g) ?? []).length;
  if (/\bhomered\b/.test(normalized) || /\bhome run\b/.test(normalized)) {
    runs += 1;
  }
  return runs;
}

function parseDecisionCode(value: string | null): "W" | "L" | "S" | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^([WLS])\b/i);
  return match ? (match[1].toUpperCase() as "W" | "L" | "S") : null;
}

function parseDecisionRecord(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^[WLS]\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function parseInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : null;
  }

  const text = String(value).trim();
  if (!text || text === "-") {
    return null;
  }
  if (!/^-?\d+$/.test(text)) {
    return null;
  }
  return Number.parseInt(text, 10);
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const text = String(value).trim();
  if (!text || text === "-") {
    return null;
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return null;
  }
  return Number.parseFloat(text);
}

function toStringValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 && text !== "-" ? text : null;
}

function normalizeCell(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}
