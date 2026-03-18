import crypto from "crypto";
import axios from "axios";
import { deriveLivePlayStates, type LivePlayEvent } from "../pipelines/live-play-feed";
import type {
  LineScore,
  LineScoreRow,
  LiveBases,
  LiveSituation,
  StatBroadcastEventMeta,
  StatBroadcastLiveSummary,
  StatsSection,
  StatsTableRow,
} from "../types";
import { TtlCache } from "../utils/cache";
import { cleanText, parseInteger } from "../utils/text";

const SIDARM_STATS_BASE_URL = "https://sidearmstats.com";
const CACHE_TTL_MS = 15_000;
const configCache = new TtlCache<string, SidearmSiteConfig>();
const payloadCache = new TtlCache<string, SidearmResolvedPayload>();
const gameCache = new TtlCache<string, SidearmLiveGameStatus>();
const dashboardCache = new TtlCache<string, SidearmLiveDashboard>();

export interface SidearmSiteConfig {
  folder: string;
  sport: string;
}

interface SidearmPlayerRef {
  Team?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
  UniformNumber?: string | null;
  Photo?: string | null;
  PersonId?: string | null;
}

interface SidearmBatOrderEntry {
  Player?: SidearmPlayerRef | null;
  Position?: string | null;
}

interface SidearmTeamState {
  Id?: number | string | null;
  Name?: string | null;
  Score?: number | string | null;
  CurrentRecord?: string | null;
  PostgameRecord?: string | null;
  NcaaSchoolCode?: string | null;
  Color?: string | null;
  TextColor?: string | null;
  Logo?: string | null;
  Url?: string | null;
  PeriodScores?: Array<number | string | null> | null;
  Starters?: SidearmBatOrderEntry[] | null;
  BatOrder?: SidearmBatOrderEntry[] | null;
}

interface SidearmStatTotals {
  Key?: Record<string, string>;
  FullKey?: Record<string, string>;
  Values?: Record<string, string>;
}

interface SidearmStatGroup {
  Title?: string | null;
  Key?: Record<string, string>;
  Descriptions?: Record<string, string>;
  Values?: Array<Record<string, string>>;
}

interface SidearmPeriodStat {
  Key?: Record<string, string>;
  FullKey?: Record<string, string>;
  Values?: Record<string, string>;
}

interface SidearmTeamStats {
  TopPerformer?: SidearmPlayerRef | null;
  Players?: SidearmPlayerRef[] | null;
  PlayerGroups?: Record<string, SidearmStatGroup> | null;
  Totals?: SidearmStatTotals | null;
  PeriodStats?: SidearmPeriodStat[] | null;
}

interface SidearmSituationState {
  PitchingTeam?: string | null;
  BattingTeam?: string | null;
  Pitcher?: SidearmPlayerRef | null;
  PitcherPitchCount?: number | string | null;
  PitcherHandedness?: string | null;
  Batter?: SidearmPlayerRef | null;
  BatterHandedness?: string | null;
  OnDeck?: SidearmPlayerRef | null;
  OnDeckHandedness?: string | null;
  OnFirst?: SidearmPlayerRef | null;
  OnSecond?: SidearmPlayerRef | null;
  OnThird?: SidearmPlayerRef | null;
  WinPitcher?: SidearmPlayerRef | null;
  LossPitcher?: SidearmPlayerRef | null;
  SavePitcher?: SidearmPlayerRef | null;
  Balls?: number | string | null;
  Strikes?: number | string | null;
  Outs?: number | string | null;
  Inning?: number | string | null;
}

interface SidearmGameState {
  HasStarted?: boolean;
  IsComplete?: boolean;
  Period?: number | string | null;
  Date?: string | null;
  DateUTC?: string | null;
  StartTime?: string | null;
  EndTime?: string | null;
  Location?: string | null;
  GlobalSportShortname?: string | null;
  ClientLiveStatsUrl?: string | null;
  ClientHostname?: string | null;
  Context?: string | null;
  HomeTeam?: SidearmTeamState | null;
  VisitingTeam?: SidearmTeamState | null;
  Situation?: SidearmSituationState | null;
}

interface SidearmPlayScore {
  HomeTeam?: number | string | null;
  VisitingTeam?: number | string | null;
}

interface SidearmPlay {
  Player?: SidearmPlayerRef | null;
  InvolvedPlayers?: SidearmPlayerRef[] | null;
  Team?: string | null;
  Narrative?: string | null;
  Context?: string | null;
  Id?: string | null;
  Type?: string | null;
  Action?: string | null;
  Period?: number | string | null;
  ClockSeconds?: number | string | null;
  Coordinate?: unknown;
  Score?: SidearmPlayScore | null;
}

interface SidearmGameResponse {
  Game?: SidearmGameState | null;
  Plays?: SidearmPlay[] | null;
  Stats?: {
    HomeTeam?: SidearmTeamStats | null;
    VisitingTeam?: SidearmTeamStats | null;
  } | null;
}

interface SidearmResolvedPayload {
  payload: SidearmGameResponse;
  fetchedAt: string;
}

interface SidearmPlayProjection {
  event: LivePlayEvent;
  awayScore: number | null;
  homeScore: number | null;
}

export interface SidearmDashboardPlay {
  key: string;
  order: number;
  inning: number | null;
  half: "top" | "bottom" | null;
  text: string;
  batter: string | null;
  pitcher: string | null;
  scoringDecision: string | null;
  isSubstitution: boolean;
  outsAfterPlay: number | null;
  awayScore: number | null;
  homeScore: number | null;
}

export interface SidearmLiveDashboard {
  summary: StatBroadcastLiveSummary;
  plays: SidearmDashboardPlay[];
  playsSections: StatsSection[];
  lineupsSections: StatsSection[];
}

export interface SidearmLiveGameStatus {
  statusText: string;
  inProgress: boolean;
  isOver: boolean;
  roadScore: number | null;
  homeScore: number | null;
  location: string | null;
}

export async function getSidearmLiveGameStatus(liveStatsUrl: string): Promise<SidearmLiveGameStatus | null> {
  const cacheKey = normalizeCacheKey(liveStatsUrl);
  if (!cacheKey) {
    return null;
  }

  const cached = gameCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const resolved = await getSidearmGamePayload(liveStatsUrl);
  if (!resolved?.payload.Game) {
    return null;
  }

  const parsed = parseSidearmLiveGameStatus(resolved.payload);
  if (!parsed) {
    return null;
  }

  gameCache.set(cacheKey, parsed, CACHE_TTL_MS);
  return parsed;
}

export async function getSidearmLiveDashboard(liveStatsUrl: string): Promise<SidearmLiveDashboard | null> {
  const cacheKey = normalizeCacheKey(liveStatsUrl);
  if (!cacheKey) {
    return null;
  }

  const cached = dashboardCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const resolved = await getSidearmGamePayload(liveStatsUrl);
  if (!resolved) {
    return null;
  }

  const parsed = parseSidearmLiveDashboard(resolved.payload, liveStatsUrl, resolved.fetchedAt);
  if (!parsed) {
    return null;
  }

  dashboardCache.set(cacheKey, parsed, CACHE_TTL_MS);
  return parsed;
}

export function parseSidearmSiteConfig(rawHtml: string, liveStatsUrl: string): SidearmSiteConfig | null {
  const liveStatsFolder = cleanText(
    rawHtml.match(/window\.livestats_foldername\s*=\s*"([^"]+)"/i)?.[1] ?? ""
  );
  const clientShortname = cleanText(
    rawHtml.match(/window\.client_shortname\s*=\s*"([^"]+)"/i)?.[1] ?? ""
  );
  const folder = liveStatsFolder || clientShortname;
  if (!folder) {
    return null;
  }

  const sport = extractSportFromLiveStatsUrl(liveStatsUrl);
  if (!sport) {
    return null;
  }

  return {
    folder,
    sport,
  };
}

export function parseSidearmLiveGameStatus(payload: SidearmGameResponse): SidearmLiveGameStatus | null {
  const game = payload.Game;
  if (!game) {
    return null;
  }

  const hasStarted = game.HasStarted === true;
  const isOver = game.IsComplete === true;
  const roadScore = toNullableNumber(game.VisitingTeam?.Score);
  const homeScore = toNullableNumber(game.HomeTeam?.Score);
  const location = cleanText(game.Location ?? "") || null;

  return {
    statusText: deriveSidearmStatusText(game),
    inProgress: hasStarted && !isOver,
    isOver,
    roadScore,
    homeScore,
    location,
  };
}

export function parseSidearmLiveDashboard(
  payload: SidearmGameResponse,
  liveStatsUrl: string,
  fetchedAt = new Date().toISOString()
): SidearmLiveDashboard | null {
  const summary = buildSidearmSummary(payload, liveStatsUrl, fetchedAt);
  if (!summary) {
    return null;
  }

  return {
    summary,
    plays: buildSidearmDashboardPlays(payload, summary),
    playsSections: [],
    lineupsSections: buildSidearmLineupSections(payload),
  };
}

async function getSidearmGamePayload(liveStatsUrl: string): Promise<SidearmResolvedPayload | null> {
  const cacheKey = normalizeCacheKey(liveStatsUrl);
  if (!cacheKey) {
    return null;
  }

  const cached = payloadCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const config = await getSidearmSiteConfig(liveStatsUrl);
  if (!config) {
    return null;
  }

  const endpoint = `${SIDARM_STATS_BASE_URL}/${config.folder}/${config.sport}/game.json`;
  const response = await axios.get<SidearmGameResponse>(endpoint, {
    params: { detail: "full" },
    timeout: 20_000,
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status >= 400 || !response.data?.Game) {
    return null;
  }

  const resolved: SidearmResolvedPayload = {
    payload: response.data,
    fetchedAt: new Date().toISOString(),
  };

  payloadCache.set(cacheKey, resolved, CACHE_TTL_MS);
  return resolved;
}

async function getSidearmSiteConfig(liveStatsUrl: string): Promise<SidearmSiteConfig | null> {
  const cacheKey = normalizeCacheKey(liveStatsUrl);
  if (!cacheKey) {
    return null;
  }

  const cached = configCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await axios.get<string>(liveStatsUrl, {
    timeout: 20_000,
    responseType: "text",
    transformResponse: [(value) => value],
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status >= 400) {
    return null;
  }

  const parsed = parseSidearmSiteConfig(String(response.data ?? ""), liveStatsUrl);
  if (!parsed) {
    return null;
  }

  configCache.set(cacheKey, parsed, CACHE_TTL_MS);
  return parsed;
}

function buildSidearmSummary(
  payload: SidearmGameResponse,
  liveStatsUrl: string,
  fetchedAt: string
): StatBroadcastLiveSummary | null {
  const game = payload.Game;
  if (!game) {
    return null;
  }

  const visitorTeam = cleanText(game.VisitingTeam?.Name ?? "") || "Away";
  const homeTeam = cleanText(game.HomeTeam?.Name ?? "") || "Home";
  const id = hashStringToPositiveInt(liveStatsUrl);
  const sport = extractSportFromLiveStatsUrl(liveStatsUrl) ?? (cleanText(game.GlobalSportShortname ?? "") || "baseball");

  const event: StatBroadcastEventMeta = {
    id,
    title: `${visitorTeam} at ${homeTeam}`,
    sport,
    xmlFile: `sidearm:${liveStatsUrl}`,
    date: cleanText(game.DateUTC ?? game.Date ?? "") || null,
    time: cleanText(game.StartTime ?? "") || null,
    venue: cleanText(game.Location ?? "") || null,
    location: cleanText(game.Location ?? "") || null,
    homeName: homeTeam,
    visitorName: visitorTeam,
    completed: game.IsComplete === true,
  };

  const summary: StatBroadcastLiveSummary = {
    id,
    event,
    statusText: deriveSidearmStatusText(game),
    visitorTeam,
    homeTeam,
    visitorScore: toNullableNumber(game.VisitingTeam?.Score),
    homeScore: toNullableNumber(game.HomeTeam?.Score),
    lineScore: buildSidearmLineScore(payload),
    situation: buildSidearmSituation(payload),
    thisInning: buildSidearmThisInning(payload),
    fetchedAt,
  };

  return summary;
}

function buildSidearmLineScore(payload: SidearmGameResponse): LineScore | null {
  const game = payload.Game;
  if (!game) {
    return null;
  }

  const awayInnings = normalizePeriodScores(game.VisitingTeam?.PeriodScores);
  const homeInnings = normalizePeriodScores(game.HomeTeam?.PeriodScores);
  const inningCount = Math.max(awayInnings.length, homeInnings.length, 0);

  const awayTotals = buildLineScoreTotals(
    payload.Stats?.VisitingTeam ?? null,
    toNullableNumber(game.VisitingTeam?.Score),
    game.VisitingTeam?.CurrentRecord ?? null
  );
  const homeTotals = buildLineScoreTotals(
    payload.Stats?.HomeTeam ?? null,
    toNullableNumber(game.HomeTeam?.Score),
    game.HomeTeam?.CurrentRecord ?? null
  );

  if (inningCount === 0 && !hasVisibleTotals(awayTotals) && !hasVisibleTotals(homeTotals)) {
    return null;
  }

  const headers = ["Team", ...Array.from({ length: inningCount }, (_, index) => String(index + 1)), "R", "H", "E", "LOB"];
  const rows: LineScoreRow[] = [
    {
      team: buildLineScoreTeamLabel(cleanText(game.VisitingTeam?.Name ?? "") || "Away"),
      innings: buildInningCells(awayInnings, inningCount),
      totals: awayTotals,
      columns: awayTotals,
    },
    {
      team: buildLineScoreTeamLabel(cleanText(game.HomeTeam?.Name ?? "") || "Home"),
      innings: buildInningCells(homeInnings, inningCount),
      totals: homeTotals,
      columns: homeTotals,
    },
  ];

  return {
    headers,
    rows,
  };
}

function buildLineScoreTotals(
  teamStats: SidearmTeamStats | null,
  scoreFallback: number | null,
  record: string | null
): Record<string, number | null | string> {
  const values = teamStats?.Totals?.Values ?? {};
  const runs = parseInteger(values.Runs) ?? scoreFallback;
  const hits = parseInteger(values.Hits);
  const errors = parseInteger(values.Errors);
  const leftOnBase = parseInteger(values.LeftOnBase);

  return {
    r: runs,
    h: hits,
    e: errors,
    lob: leftOnBase,
    record: cleanText(record ?? "") || null,
  };
}

function buildInningCells(values: Array<number | null>, inningCount: number): Array<{ inning: number; value: number | null }> {
  return Array.from({ length: inningCount }, (_, index) => ({
    inning: index + 1,
    value: values[index] ?? null,
  }));
}

function hasVisibleTotals(totals: Record<string, number | null | string>): boolean {
  return ["r", "h", "e", "lob"].some((key) => typeof totals[key] === "number");
}

function buildSidearmSituation(payload: SidearmGameResponse): LiveSituation | null {
  const game = payload.Game;
  const situation = game?.Situation;
  if (!game || !situation) {
    return null;
  }

  const battingSide = mapSidearmTeamMarker(situation.BattingTeam);
  const half = battingSide === "away" ? "top" : battingSide === "home" ? "bottom" : null;
  const rawInning = toNullableNumber(situation.Inning) ?? toNullableNumber(game.Period);
  const inning = rawInning !== null ? normalizeInningNumber(rawInning, situation.BattingTeam ?? "") : null;

  const battingStats = getTeamStatsForMarker(payload, situation.BattingTeam);
  const batterStats = findPlayerGroupRow(
    battingStats?.PlayerGroups?.Batting ?? null,
    situation.Batter ?? null
  );

  return {
    inningText: half && inning ? `${half === "top" ? "Top" : "Bot"} ${inning}` : null,
    half,
    inning,
    count: {
      balls: toNullableNumber(situation.Balls),
      strikes: toNullableNumber(situation.Strikes),
    },
    outs: toNullableNumber(situation.Outs),
    bases: buildLiveBases(situation),
    battingTeam: battingSide,
    batter: {
      name: displayPlayerName(situation.Batter),
      ab: parseInteger(batterStats?.AtBats),
      hits: parseInteger(batterStats?.Hits),
      summary: buildTodaySummary(batterStats),
    },
    pitcher: {
      name: displayPlayerName(situation.Pitcher),
      pitchCount: toNullableNumber(situation.PitcherPitchCount),
    },
  };
}

function buildLiveBases(situation: SidearmSituationState): LiveBases {
  return {
    first: Boolean(situation.OnFirst),
    second: Boolean(situation.OnSecond),
    third: Boolean(situation.OnThird),
    mask:
      (situation.OnFirst ? 1 : 0) +
      (situation.OnSecond ? 2 : 0) +
      (situation.OnThird ? 4 : 0),
    firstRunner: displayPlayerName(situation.OnFirst),
    secondRunner: displayPlayerName(situation.OnSecond),
    thirdRunner: displayPlayerName(situation.OnThird),
  };
}

function buildSidearmThisInning(payload: SidearmGameResponse): StatBroadcastLiveSummary["thisInning"] {
  const game = payload.Game;
  const battingMarker = cleanText(game?.Situation?.BattingTeam ?? "");
  const rawInning = toNullableNumber(game?.Situation?.Inning) ?? toNullableNumber(game?.Period);
  const inning = rawInning !== null ? normalizeInningNumber(rawInning, battingMarker) : null;
  if (!inning || !battingMarker) {
    return null;
  }

  const periodStats = getTeamStatsForMarker(payload, battingMarker)?.PeriodStats;
  const period = Array.isArray(periodStats) ? periodStats[inning - 1] ?? null : null;
  const values = period?.Values ?? null;
  if (!values) {
    return null;
  }

  return {
    label: deriveSidearmStatusText(game ?? {}),
    runs: parseInteger(values.Runs),
    hits: parseInteger(values.Hits),
    errors: parseInteger(values.Errors),
  };
}

function buildSidearmLineupSections(payload: SidearmGameResponse): StatsSection[] {
  const game = payload.Game;
  if (!game) {
    return [];
  }

  const sections = [
    buildSidearmLineupSection(
      cleanText(game.VisitingTeam?.Name ?? "") || "Away",
      game.VisitingTeam ?? null,
      payload.Stats?.VisitingTeam ?? null
    ),
    buildSidearmLineupSection(
      cleanText(game.HomeTeam?.Name ?? "") || "Home",
      game.HomeTeam ?? null,
      payload.Stats?.HomeTeam ?? null
    ),
  ].filter((section): section is StatsSection => Boolean(section));

  return sections;
}

function buildSidearmLineupSection(
  teamName: string,
  team: SidearmTeamState | null,
  teamStats: SidearmTeamStats | null
): StatsSection | null {
  const order = normalizeBattingOrder(team);
  if (order.length === 0) {
    return null;
  }

  const battingLookup = buildStatRowLookup(teamStats?.PlayerGroups?.Batting ?? null);
  const seasonLookup = buildStatRowLookup(teamStats?.PlayerGroups?.BattingSeason ?? null);
  const headers = ["Spot", "# Player", "Pos", "Today", "Avg"];

  const rows: StatsTableRow[] = order.map((entry, index) => {
    const player = entry.Player ?? null;
    const battingRow = findStatRowByLookup(player, battingLookup);
    const seasonRow = findStatRowByLookup(player, seasonLookup);
    const number = cleanText(player?.UniformNumber ?? "");
    const displayName = displayPlayerName(player) ?? `Player ${index + 1}`;
    const playerCell = [number, displayName].filter((value) => value.length > 0).join(" ").trim();
    const today = buildTodaySummary(battingRow);
    const avg = cleanText(seasonRow?.Avg ?? battingRow?.Avg ?? "") || null;
    const position = cleanText(entry.Position ?? "") || cleanText(battingRow?.Position ?? "") || null;

    return {
      cells: [index + 1, playerCell || displayName, position, today, avg],
      values: {
        spot: index + 1,
        "# player": playerCell || displayName,
        pos: position,
        today,
        avg,
      },
    };
  });

  return {
    title: `${teamName} Batting Order`,
    tables: [
      {
        headers,
        rows,
      },
    ],
  };
}

function buildSidearmDashboardPlays(
  payload: SidearmGameResponse,
  summary: StatBroadcastLiveSummary
): SidearmDashboardPlay[] {
  const plays = Array.isArray(payload.Plays) ? payload.Plays : [];
  const parsed = plays
    .map((play, index) => parseSidearmPlay(play, index))
    .filter((entry): entry is SidearmPlayProjection => Boolean(entry));

  if (parsed.length === 0) {
    return [];
  }

  const events = parsed.map((entry) => entry.event);
  const states = deriveLivePlayStates(events, summary);

  return parsed.map((entry) => {
    const state = states.get(entry.event.key);
    return {
      key: entry.event.key,
      order: entry.event.order,
      inning: entry.event.inning,
      half: entry.event.half,
      text: entry.event.text,
      batter: entry.event.batter,
      pitcher: entry.event.pitcher,
      scoringDecision: entry.event.scoringDecision,
      isSubstitution: entry.event.isSubstitution,
      outsAfterPlay: state?.outsAfterPlay ?? entry.event.outs ?? null,
      awayScore: entry.awayScore ?? state?.awayScore ?? summary.visitorScore,
      homeScore: entry.homeScore ?? state?.homeScore ?? summary.homeScore,
    };
  });
}

function parseSidearmPlay(play: SidearmPlay, index: number): SidearmPlayProjection | null {
  const text = cleanText(play.Narrative ?? "");
  const context = cleanText(play.Context ?? "");
  if (!text) {
    return null;
  }

  if (isSidearmSummaryPlay(play, text, context)) {
    return null;
  }

  const battingSide = mapSidearmTeamMarker(play.Team);
  const half = battingSide === "away" ? "top" : battingSide === "home" ? "bottom" : null;
  const rawInning = toNullableNumber(play.Period);
  const inning = rawInning !== null && half ? normalizeInningNumber(rawInning, half === "top" ? "VisitingTeam" : "HomeTeam") : rawInning;
  const playerName = displayPlayerName(play.Player);
  const pitcherName =
    findOpposingPlayerName(play.InvolvedPlayers, play.Team) ??
    expandScorebookName(parseTaggedContextValue(context, "P")) ??
    null;
  const batterName = playerName ?? expandScorebookName(parseTaggedContextValue(context, "B")) ?? null;
  const scoringDecision = cleanText(play.Action ?? play.Type ?? "") || null;
  const event: LivePlayEvent = {
    key: buildSidearmPlayKey(play, index, text),
    order: index + 1,
    inning: inning ?? null,
    half,
    isSubstitution: isSidearmSubstitution(play, text),
    text,
    scoringDecision,
    batter: batterName,
    pitcher: pitcherName,
    outs: parseOutsFromContext(context),
    sectionTitle: "Play-by-Play",
  };

  return {
    event,
    awayScore: toNullableNumber(play.Score?.VisitingTeam),
    homeScore: toNullableNumber(play.Score?.HomeTeam),
  };
}

function buildStatRowLookup(group: SidearmStatGroup | null): Map<string, Record<string, string>> {
  const lookup = new Map<string, Record<string, string>>();
  const rows = Array.isArray(group?.Values) ? group?.Values ?? [] : [];

  for (const row of rows) {
    buildStatLookupKeys({
      number: cleanText(row.Uni ?? ""),
      name: cleanText(row.Name ?? ""),
    }).forEach((key) => lookup.set(key, row));
  }

  return lookup;
}

function findStatRowByLookup(
  player: SidearmPlayerRef | null | undefined,
  lookup: Map<string, Record<string, string>>
): Record<string, string> | null {
  if (!player) {
    return null;
  }

  for (const key of buildStatLookupKeys({
    number: cleanText(player.UniformNumber ?? ""),
    name: displayPlayerName(player) ?? "",
  })) {
    const match = lookup.get(key);
    if (match) {
      return match;
    }
  }

  return null;
}

function findPlayerGroupRow(group: SidearmStatGroup | null, player: SidearmPlayerRef | null | undefined): Record<string, string> | null {
  return findStatRowByLookup(player, buildStatRowLookup(group));
}

function buildStatLookupKeys(input: { number: string; name: string }): string[] {
  const number = cleanText(input.number);
  const fullName = normalizePlayerNameKey(input.name);
  const compactName = normalizePlayerNameKey(abbreviateScorebookName(input.name));
  const keys = new Set<string>();

  if (number) {
    keys.add(`number:${number}`);
  }
  if (fullName) {
    keys.add(`name:${fullName}`);
  }
  if (compactName) {
    keys.add(`name:${compactName}`);
  }
  if (number && fullName) {
    keys.add(`number:${number}|name:${fullName}`);
  }
  if (number && compactName) {
    keys.add(`number:${number}|name:${compactName}`);
  }

  return Array.from(keys);
}

function buildTodaySummary(row: Record<string, string> | null): string | null {
  if (!row) {
    return null;
  }

  const hits = parseInteger(row.Hits);
  const atBats = parseInteger(row.AtBats);
  const strikeouts = parseInteger(row.Strikeouts);
  const walks = parseInteger(row.Walks);
  const runsBattedIn = parseInteger(row.RunsBattedIn);

  const parts: string[] = [];
  if (hits !== null && atBats !== null) {
    parts.push(`${hits}-${atBats}`);
  }
  if (strikeouts !== null && strikeouts > 0) {
    parts.push(`${strikeouts} K`);
  } else if (walks !== null && walks > 0) {
    parts.push(`${walks} BB`);
  } else if (runsBattedIn !== null && runsBattedIn > 0) {
    parts.push(`${runsBattedIn} RBI`);
  }

  return parts.join(", ") || null;
}

function normalizeBattingOrder(team: SidearmTeamState | null): SidearmBatOrderEntry[] {
  if (Array.isArray(team?.BatOrder) && team.BatOrder.length > 0) {
    return team.BatOrder;
  }
  if (Array.isArray(team?.Starters) && team.Starters.length > 0) {
    return team.Starters;
  }
  return [];
}

function normalizePeriodScores(scores: Array<number | string | null> | null | undefined): Array<number | null> {
  if (!Array.isArray(scores)) {
    return [];
  }

  return scores.map((value) => toNullableNumber(value));
}

function getTeamStatsForMarker(payload: SidearmGameResponse, marker: string | null | undefined): SidearmTeamStats | null {
  const normalized = cleanText(marker ?? "").toLowerCase();
  if (normalized === "visitingteam") {
    return payload.Stats?.VisitingTeam ?? null;
  }
  if (normalized === "hometeam") {
    return payload.Stats?.HomeTeam ?? null;
  }
  return null;
}

function deriveSidearmStatusText(game: Partial<SidearmGameState>): string {
  if (game.IsComplete === true) {
    return "Final";
  }

  if (game.HasStarted === true) {
    const battingTeam = cleanText(game.Situation?.BattingTeam ?? "").toLowerCase();
    const rawInning = toNullableNumber(game.Situation?.Inning) ?? toNullableNumber(game.Period);
    if (rawInning !== null) {
      const inningNumber = normalizeInningNumber(rawInning, battingTeam);
      if (inningNumber !== null) {
        if (battingTeam === "visitingteam") {
          return `Top ${inningNumber}`;
        }
        if (battingTeam === "hometeam") {
          return `Bot ${inningNumber}`;
        }
      }
    }

    return "Live";
  }

  const startTime = cleanText(game.StartTime ?? "");
  return startTime || "Scheduled";
}

function normalizeInningNumber(rawInning: number, battingTeam: string): number | null {
  if (!Number.isFinite(rawInning) || rawInning <= 0) {
    return null;
  }

  if (Number.isInteger(rawInning)) {
    return rawInning;
  }

  if (battingTeam.toLowerCase() === "hometeam") {
    return Math.floor(rawInning);
  }

  if (battingTeam.toLowerCase() === "visitingteam") {
    return Math.ceil(rawInning);
  }

  return Math.floor(rawInning);
}

function normalizeCacheKey(liveStatsUrl: string): string | null {
  try {
    return new URL(liveStatsUrl).toString();
  } catch {
    return null;
  }
}

function extractSportFromLiveStatsUrl(liveStatsUrl: string): string | null {
  try {
    const parsed = new URL(liveStatsUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const sidearmIndex = segments.findIndex((segment) => segment.toLowerCase() === "sidearmstats");
    const sport = cleanText(segments[sidearmIndex + 1] ?? "");
    return sport || null;
  } catch {
    return null;
  }
}

function mapSidearmTeamMarker(value: string | null | undefined): "away" | "home" | null {
  const normalized = cleanText(value ?? "").toLowerCase();
  if (normalized === "visitingteam") {
    return "away";
  }
  if (normalized === "hometeam") {
    return "home";
  }
  return null;
}

function displayPlayerName(player: SidearmPlayerRef | null | undefined): string | null {
  if (!player) {
    return null;
  }

  const first = cleanText(player.FirstName ?? "");
  const last = cleanText(player.LastName ?? "");
  const full = [first, last].filter((value) => value.length > 0).join(" ").trim();
  return full || null;
}

function normalizePlayerNameKey(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function abbreviateScorebookName(value: string): string {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return "";
  }

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return cleaned;
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  return `${first.charAt(0)} ${last}`.trim();
}

function expandScorebookName(value: string | null): string | null {
  const cleaned = cleanText(value ?? "");
  if (!cleaned) {
    return null;
  }

  return cleaned
    .split(/\s+/)
    .map((part) =>
      part
        .replace(/\./g, "")
        .toLowerCase()
        .replace(/^[a-z]/, (letter) => letter.toUpperCase())
    )
    .join(" ");
}

function parseTaggedContextValue(context: string, tag: "P" | "B"): string | null {
  const expression = new RegExp(`${tag}:\\s*([^;]+)`, "i");
  const match = context.match(expression);
  return cleanText(match?.[1] ?? "") || null;
}

function parseOutsFromContext(context: string): number | null {
  const match = context.match(/(?:^|;)\s*(\d)\s+out(?:s)?\b/i);
  const parsed = parseInteger(match?.[1] ?? null);
  if (parsed === null || parsed < 0 || parsed > 3) {
    return null;
  }
  return parsed;
}

function findOpposingPlayerName(
  players: SidearmPlayerRef[] | null | undefined,
  battingTeamMarker: string | null | undefined
): string | null {
  if (!Array.isArray(players) || players.length === 0) {
    return null;
  }

  const battingTeam = cleanText(battingTeamMarker ?? "").toLowerCase();
  const opponent = players.find((player) => cleanText(player.Team ?? "").toLowerCase() !== battingTeam) ?? players[0];
  return displayPlayerName(opponent);
}

function isSidearmSummaryPlay(play: SidearmPlay, text: string, context: string): boolean {
  if (/^summary$/i.test(cleanText(play.Type ?? ""))) {
    return true;
  }
  if (/^summary,/i.test(context)) {
    return true;
  }
  return /^\d+\s+runs?,\s+\d+\s+hits?/i.test(text);
}

function isSidearmSubstitution(play: SidearmPlay, text: string): boolean {
  const type = cleanText(play.Type ?? "");
  const action = cleanText(play.Action ?? "");
  return (
    /\bsub/i.test(type) ||
    /\bsub/i.test(action) ||
    /\bpinch hit\b|\bpinch ran\b|\bto [a-z0-9]+ for\b|\bsubstitution\b/i.test(text)
  );
}

function buildSidearmPlayKey(play: SidearmPlay, index: number, text: string): string {
  const explicitId = cleanText(play.Id ?? "");
  if (explicitId) {
    return explicitId;
  }

  return crypto
    .createHash("sha1")
    .update(`${index}|${cleanText(play.Team ?? "")}|${cleanText(play.Context ?? "")}|${text}`)
    .digest("hex");
}

function buildLineScoreTeamLabel(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((part) => cleanText(part))
    .filter(Boolean);

  if (parts.length === 0) {
    return "TEAM";
  }

  if (parts.length === 1) {
    return parts[0].toUpperCase().slice(0, 4);
  }

  const initials = parts
    .filter((part) => !/^(of|the|at|and)$/i.test(part))
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  if (initials.length >= 2 && initials.length <= 4) {
    return initials;
  }

  return parts[parts.length - 1].toUpperCase().slice(0, 4);
}

function hashStringToPositiveInt(value: string): number {
  const digest = crypto.createHash("md5").update(value).digest("hex").slice(0, 8);
  const parsed = Number.parseInt(digest, 16);
  return Math.max(1, parsed & 0x7fffffff);
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
