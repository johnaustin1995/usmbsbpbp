import axios from "axios";
import { load } from "cheerio";
import type { Element } from "domhandler";
import { runWithConcurrency } from "../utils/async";
import { TtlCache } from "../utils/cache";
import { cleanText, parseBoolean, parseInteger } from "../utils/text";
import type {
  FinalInningPlayByPlay,
  FinalLineupEntry,
  FinalNotesDocs,
  FinalPlayByPlayEvent,
  FinalScoringPlay,
  FinalTeamStats,
  LineScore,
  LineScoreRow,
  LiveSituation,
  PitcherDecision,
  PitcherDecisionCode,
  StatBroadcastFinalGame,
  StatBroadcastLiveStats,
  StatBroadcastEventMeta,
  StatBroadcastLiveSummary,
  StatsSection,
  StatsTable,
  StatsTableRow,
} from "../types";

const BASE_URL = "https://stats.statbroadcast.com/interface/webservice";
const EVENT_CACHE_TTL_MS = 5 * 60_000;
const LIVE_CACHE_TTL_MS = 15_000;
const LIVE_STATS_CACHE_TTL_MS = 15_000;
const FINAL_GAME_CACHE_TTL_MS = 30_000;

const eventCache = new TtlCache<number, StatBroadcastEventMeta>();
const liveCache = new TtlCache<number, StatBroadcastLiveSummary>();
const liveStatsCache = new TtlCache<string, StatBroadcastLiveStats>();
const finalGameCache = new TtlCache<number, StatBroadcastFinalGame>();

const XSL_BY_SPORT: Record<string, string> = {
  bsgame: "baseball/sb.bsgame.views.broadcast.xsl",
};

const BASEBALL_VIEW_XSL: Record<string, string> = {
  game: "baseball/sb.bsgame.views.broadcast.xsl",
  lineups: "baseball/sb.bsgame.views.lineups.xsl",
  away_box: 'baseball/sb.bsgame.views.box.xsl&params={"team":"V"}',
  home_box: 'baseball/sb.bsgame.views.box.xsl&params={"team":"H"}',
  compare: "baseball/sb.bsgame.views.teamcompare.xsl",
  scoring: "baseball/sb.bsgame.views.scoring.xsl",
  plays: "baseball/sb.bsgame.views.pxp.xsl",
  scorecard_away: 'baseball/sb.bsgame.views.scorecard.xsl&params={"team":"V"}',
  scorecard_home: 'baseball/sb.bsgame.views.scorecard.xsl&params={"team":"H"}',
  away_season: 'baseball/sb.bsgame.views.season.xsl&params={"team":"V"}',
  home_season: 'baseball/sb.bsgame.views.season.xsl&params={"team":"H"}',
  notes: "baseball/sb.bsgame.views.notes.xsl",
};

export async function getLiveSummary(id: number): Promise<StatBroadcastLiveSummary> {
  const cached = liveCache.get(id);
  if (cached) {
    return cached;
  }

  const event = await getEventMeta(id);
  const statsHtml = await getStatsHtml(event, "game");
  const parsed = parseStatsHtml(id, event, statsHtml);

  liveCache.set(id, parsed, LIVE_CACHE_TTL_MS);
  return parsed;
}

export async function getLiveStats(id: number, requestedView?: string): Promise<StatBroadcastLiveStats> {
  const view = normalizeViewKey(requestedView);
  const cacheKey = `${id}:${view}`;
  const cached = liveStatsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const event = await getEventMeta(id);
  const statsHtml = await getStatsHtml(event, view);
  const summary = parseStatsHtml(id, event, statsHtml);
  const sections = parseStatsSections(statsHtml);

  const payload: StatBroadcastLiveStats = {
    id,
    view,
    event,
    summary,
    sections,
    fetchedAt: new Date().toISOString(),
  };

  liveStatsCache.set(cacheKey, payload, LIVE_STATS_CACHE_TTL_MS);
  return payload;
}

export async function getFinalGame(id: number): Promise<StatBroadcastFinalGame> {
  const cached = finalGameCache.get(id);
  if (cached) {
    return cached;
  }

  const event = await getEventMeta(id);

  const [gameHtml, lineupsHtml, awayBoxHtml, homeBoxHtml, scoringHtml, notesHtml] =
    await Promise.all([
      getStatsHtml(event, "game"),
      getStatsHtml(event, "lineups"),
      getStatsHtml(event, "away_box"),
      getStatsHtml(event, "home_box"),
      getStatsHtml(event, "scoring"),
      getStatsHtml(event, "notes"),
    ]);

  const summary = parseStatsHtml(id, event, gameHtml);
  const lineupsSections = parseStatsSections(lineupsHtml);
  const awaySections = parseStatsSections(awayBoxHtml);
  const homeSections = parseStatsSections(homeBoxHtml);
  const scoringSections = parseStatsSections(scoringHtml);
  const notesSections = parseStatsSections(notesHtml);

  const lineups = parseLineups(lineupsSections, summary);
  const visitorStats = buildFinalTeamStats(awaySections);
  const homeStats = buildFinalTeamStats(homeSections);
  const scoringPlays = parseScoringPlays(scoringSections);
  const pitcherDecisions = parsePitcherDecisions(visitorStats, homeStats);
  const notesDocs = parseNotesDocs(notesHtml, notesSections);

  const innings = listGameInnings(summary.lineScore);
  const playByPlayByInning = await runWithConcurrency(innings, 4, async (inning) => {
    const html = await getStatsHtml(event, `plays_inning_${inning}`);
    return parseInningPlayByPlay(inning, html);
  });

  const payload: StatBroadcastFinalGame = {
    id,
    event,
    status: determineFinalStatus(summary, pitcherDecisions),
    summary,
    finalScore: {
      visitorTeam: summary.visitorTeam,
      homeTeam: summary.homeTeam,
      visitorScore: summary.visitorScore,
      homeScore: summary.homeScore,
      winner: determineWinner(summary.visitorScore, summary.homeScore),
    },
    pitcherDecisions,
    lineups,
    visitorStats,
    homeStats,
    scoringPlays,
    playByPlayByInning: playByPlayByInning.sort((a, b) => a.inning - b.inning),
    notesDocs,
    fetchedAt: new Date().toISOString(),
  };

  finalGameCache.set(id, payload, FINAL_GAME_CACHE_TTL_MS);
  return payload;
}

export function getAvailableViewsForSport(sport: string): string[] {
  if (sport === "bsgame") {
    return Object.keys(BASEBALL_VIEW_XSL);
  }

  return ["game"];
}

export async function getEventMeta(id: number): Promise<StatBroadcastEventMeta> {
  const cached = eventCache.get(id);
  if (cached) {
    return cached;
  }

  const xml = await serviceCall(`event/${id}`, "type=statbroadcast");
  const parsed = parseEventXml(id, xml);
  eventCache.set(id, parsed, EVENT_CACHE_TTL_MS);
  return parsed;
}

export function parseEventXml(id: number, xml: string): StatBroadcastEventMeta {
  const $ = load(xml, { xmlMode: true });
  const event = $("event").first();

  if (event.length === 0) {
    throw new Error(`No event element found for statbroadcast id ${id}.`);
  }

  const xmlFile = cleanText(event.find("xmlfile").text());
  const sport = cleanText(event.find("sport").text());
  if (!xmlFile || !sport) {
    throw new Error(`Missing xmlfile or sport for statbroadcast id ${id}.`);
  }

  return {
    id,
    title: cleanText(event.find("title").text()),
    sport,
    xmlFile,
    date: cleanText(event.find("date").text()) || null,
    time: cleanText(event.find("time").text()) || null,
    venue: cleanText(event.find("venue").text()) || null,
    location: cleanText(event.find("location").text()) || null,
    homeName: cleanText(event.attr("homename")) || cleanText(event.find("homename").text()),
    visitorName:
      cleanText(event.attr("visitorname")) || cleanText(event.find("visitorname").text()),
    completed: parseBoolean(event.attr("completed")),
  };
}

export function parseStatsHtml(
  id: number,
  event: StatBroadcastEventMeta,
  html: string
): StatBroadcastLiveSummary {
  const $ = load(html);

  const desktopStatus = $(".statusbar.d-none.d-md-block").first();
  const statusRoot = desktopStatus.length > 0 ? desktopStatus : $(".statusbar").first();

  const visitorTeam = cleanText(statusRoot.find(".sb-teamnameV").first().text());
  const homeTeam = cleanText(statusRoot.find(".sb-teamnameH").first().text());

  const scores = statusRoot
    .find(".sb-teamscore")
    .map((_, node) => parseInteger($(node).text()))
    .get()
    .filter((value) => value !== null) as number[];

  const statusText = cleanText(
    statusRoot.find(".sb-statusbar-clock .font-size-125").first().text()
  ) || null;

  const lineScore = parseLineScore($);
  const situation = parseLiveSituation($, statusRoot, event);
  const thisInning = parseThisInning($);

  return {
    id,
    event,
    statusText,
    visitorTeam: visitorTeam || event.visitorName,
    homeTeam: homeTeam || event.homeName,
    visitorScore: scores[0] ?? null,
    homeScore: scores[1] ?? null,
    lineScore,
    situation,
    thisInning,
    fetchedAt: new Date().toISOString(),
  };
}

async function getStatsHtml(event: StatBroadcastEventMeta, requestedView?: string): Promise<string> {
  const xsl = resolveXslForView(event.sport, requestedView);
  const data =
    `event=${event.id}` +
    `&xml=${event.xmlFile}` +
    `&xsl=${xsl}` +
    `&sport=${event.sport}` +
    "&filetime=1" +
    "&type=statbroadcast";

  return serviceCall("stats", data);
}

function parseLineScore($: ReturnType<typeof load>): LineScore | null {
  const card = $(".card")
    .filter((_, node) => {
      const title = cleanText($(node).find(".card-header").first().text()).toLowerCase();
      return title.includes("game line score");
    })
    .first();

  if (card.length === 0) {
    return null;
  }

  const table = card.find("table").first();
  if (table.length === 0) {
    return null;
  }

  const headers = table
    .find("thead th")
    .map((_, node) => cleanText($(node).text()))
    .get();

  if (headers.length === 0) {
    return null;
  }

  const rows = table
    .find("tbody tr")
    .map((_, node) => parseLineScoreRow($, node, headers))
    .get();

  return {
    headers,
    rows,
  };
}

function parseLineScoreRow(
  $: ReturnType<typeof load>,
  rowNode: Element,
  headers: string[]
): LineScoreRow {
  const rawCellValues = $(rowNode)
    .find("td")
    .map((_, node) => cleanText($(node).text()))
    .get();
  const cellValues = alignCellsToHeaders(headers, rawCellValues);

  const columns: Record<string, number | null | string> = {};
  headers.forEach((header, index) => {
    const key = normalizeColumnKey(header, index);
    const raw = cellValues[index] ?? "";
    columns[key] = coerceCell(raw);
  });

  const innings = Object.entries(columns)
    .filter(([key]) => key.startsWith("inning_"))
    .map(([key, value]) => ({
      inning: Number.parseInt(key.replace("inning_", ""), 10),
      value: typeof value === "number" ? value : null,
    }))
    .sort((a, b) => a.inning - b.inning);

  const totals: Record<string, number | null | string> = {};
  for (const key of ["r", "h", "e", "lob"]) {
    if (key in columns) {
      totals[key] = columns[key];
    }
  }

  return {
    team: String(columns.team ?? ""),
    innings,
    totals,
    columns,
  };
}

function parseThisInning($: ReturnType<typeof load>): {
  label: string;
  runs: number | null;
  hits: number | null;
  errors: number | null;
} | null {
  const row = $(".row.bg-primary.border-bottom.smaller")
    .filter((_, node) => cleanText($(node).text()).toLowerCase().includes("this inning"))
    .first();
  if (row.length === 0) {
    return null;
  }

  const label = cleanText(row.find(".sb-bsgame-thisinning").first().text());
  const detailText =
    cleanText(row.find(".sb-col.col-9.text-right").first().text()) || cleanText(row.text());

  const runs = parseMatch(detailText, /(\d+)\s*R\b/i);
  const hits = parseMatch(detailText, /(\d+)\s*H\b/i);
  const errors = parseMatch(detailText, /(\d+)\s*E\b/i);

  if (!label && runs === null && hits === null && errors === null) {
    return null;
  }

  return {
    label,
    runs,
    hits,
    errors,
  };
}

function parseLiveSituation(
  $: ReturnType<typeof load>,
  statusRoot: any,
  event: StatBroadcastEventMeta
): LiveSituation | null {
  const clock = statusRoot.find(".sb-statusbar-clock").first();
  if (clock.length === 0) {
    return null;
  }

  const clockLines = clock
    .find(".font-size-125")
    .map((_: number, node: Element) => cleanText($(node).text()))
    .get()
    .filter((entry: string) => entry.length > 0);

  const inningText = clockLines[0] || null;
  const countText = clockLines.find((entry: string) => /^\d+\s*-\s*\d+$/.test(entry)) || "";
  const countMatch = countText.match(/^(\d+)\s*-\s*(\d+)$/);
  const balls = countMatch ? Number.parseInt(countMatch[1], 10) : null;
  const strikes = countMatch ? Number.parseInt(countMatch[2], 10) : null;

  const inningMatch = (inningText ?? "").match(/\b(top|bot)\s*(\d+)/i);
  const half = inningMatch
    ? inningMatch[1].toLowerCase() === "top"
      ? "top"
      : "bottom"
    : null;
  const inning = inningMatch ? Number.parseInt(inningMatch[2], 10) : null;

  const outsText = cleanText(clock.find(".base-indicator .d-inline.d-sm-none").first().text());
  const outs = parseInteger(outsText);

  const baseMaskText = cleanText(clock.find(".base-indicator .sbicon.font-size-300").first().text());
  const baseMask = parseInteger(baseMaskText);

  const battingTeam = parseBattingTeam($, statusRoot, event);
  const batter = parseCurrentBatter($);
  const pitcherName = parseIndicatorPerson($, statusRoot, "On Mound");
  const pitcherPitchCount = pitcherName ? parsePitchCountForPitcher($, pitcherName) : null;

  const hasAnySituationData =
    inningText !== null ||
    balls !== null ||
    strikes !== null ||
    outs !== null ||
    baseMask !== null ||
    battingTeam !== null ||
    batter.name !== null ||
    pitcherName !== null ||
    pitcherPitchCount !== null;

  if (!hasAnySituationData) {
    return null;
  }

  return {
    inningText,
    half,
    inning,
    count: {
      balls,
      strikes,
    },
    outs,
    bases: {
      first: baseMask !== null ? (baseMask & 1) === 1 : false,
      second: baseMask !== null ? (baseMask & 2) === 2 : false,
      third: baseMask !== null ? (baseMask & 4) === 4 : false,
      mask: baseMask,
    },
    battingTeam,
    batter,
    pitcher: {
      name: pitcherName,
      pitchCount: pitcherPitchCount,
    },
  };
}

function parseBattingTeam(
  $: ReturnType<typeof load>,
  statusRoot: any,
  event: StatBroadcastEventMeta
): "away" | "home" | null {
  const awayNameNode = statusRoot.find(".sb-teamnameV").first();
  const homeNameNode = statusRoot.find(".sb-teamnameH").first();

  if (awayNameNode.find(".fa-caret-right").length > 0) {
    return "away";
  }

  if (homeNameNode.find(".fa-caret-right").length > 0) {
    return "home";
  }

  const atBatName = parseIndicatorPerson($, statusRoot, "At Bat");
  if (atBatName) {
    const away = cleanText(awayNameNode.text()) || event.visitorName;
    const home = cleanText(homeNameNode.text()) || event.homeName;

    if (sameName(atBatName, away)) {
      return "away";
    }
    if (sameName(atBatName, home)) {
      return "home";
    }
  }

  return null;
}

function parseCurrentBatter($: ReturnType<typeof load>): {
  name: string | null;
  ab: number | null;
  hits: number | null;
  summary: string | null;
} {
  const atBatCard = $(".card")
    .filter((_: number, node: Element) =>
      /^at bat\b/i.test(cleanText($(node).find(".card-header").first().text()))
    )
    .first();

  if (atBatCard.length === 0) {
    return {
      name: null,
      ab: null,
      hits: null,
      summary: null,
    };
  }

  const title = cleanText(atBatCard.find(".card-header").first().text());
  const name = parseNameFromAtBatTitle(title);

  const headers = atBatCard
    .find("thead th")
    .map((_, node) => cleanText($(node).text()).toUpperCase())
    .get();
  const values = atBatCard
    .find("tbody tr")
    .first()
    .find("td")
    .map((_, node) => cleanText($(node).text()))
    .get();

  const ab = parseColumnValue(headers, values, "AB");
  const hits = parseColumnValue(headers, values, "H");
  const summary =
    ab !== null && hits !== null
      ? `${hits}-${ab}`
      : null;

  return {
    name,
    ab,
    hits,
    summary,
  };
}

function parsePitchCountForPitcher(
  $: ReturnType<typeof load>,
  pitcherName: string | null
): number | null {
  const pitchingCards = $(".card")
    .filter((_: number, node: Element) =>
      /^pitching\s+for\b/i.test(cleanText($(node).find(".card-header").first().text()))
    )
    .toArray();

  if (pitchingCards.length === 0) {
    return null;
  }

  const selectedCard = selectPitchingCard($, pitchingCards, pitcherName);
  if (!selectedCard) {
    return null;
  }

  const headers = selectedCard
    .find("thead th")
    .map((_: number, node: Element) => cleanText($(node).text()).toUpperCase())
    .get();
  const values = selectedCard
    .find("tbody tr")
    .first()
    .find("td")
    .map((_: number, node: Element) => cleanText($(node).text()))
    .get();

  return parseColumnValue(headers, values, "PC");
}

function selectPitchingCard(
  $: ReturnType<typeof load>,
  cards: Element[],
  pitcherName: string | null
): any {
  if (!pitcherName) {
    return cards.length > 0 ? $(cards[0]) : null;
  }

  const target = normalizeNameForMatch(pitcherName);
  for (const cardNode of cards) {
    const headerText = cleanText($(cardNode).find(".card-header").first().text());
    if (normalizeNameForMatch(headerText).includes(target)) {
      return $(cardNode);
    }
  }

  return cards.length > 0 ? $(cards[0]) : null;
}

function parseIndicatorPerson(
  $: ReturnType<typeof load>,
  statusRoot: any,
  label: "At Bat" | "On Mound"
): string | null {
  const indicator = statusRoot
    .find(".sb-indicator-timeouts")
    .filter((_: number, node: Element) => cleanText($(node).text()).includes(`${label}:`))
    .first();

  if (indicator.length === 0) {
    return null;
  }

  const raw = cleanText(indicator.text());
  const match = raw.match(new RegExp(`${label}:\\s*(.+)$`, "i"));
  if (!match) {
    return null;
  }

  return cleanPlayerName(match[1]);
}

function parseNameFromAtBatTitle(title: string): string | null {
  const match = title.match(/:\s*#?\d*\s*([^\[]+)/);
  if (!match) {
    return null;
  }

  return cleanPlayerName(match[1]);
}

function parseColumnValue(headers: string[], values: string[], key: string): number | null {
  if (headers.length === 0 || values.length === 0) {
    return null;
  }

  const index = headers.findIndex((header) => header === key);
  if (index === -1) {
    return null;
  }

  const aligned = alignCellsToHeaders(headers, values);
  return parseInteger(String(aligned[index] ?? ""));
}

function cleanPlayerName(value: string): string | null {
  const clean = cleanText(value)
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^[#\d.\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim();

  return clean.length > 0 ? clean : null;
}

function sameName(a: string, b: string): boolean {
  return normalizeNameForMatch(a) === normalizeNameForMatch(b);
}

function normalizeNameForMatch(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseStatsSections(html: string): StatsSection[] {
  const $ = load(html);
  const sections: StatsSection[] = [];

  $(".card").each((_, cardNode) => {
    const card = $(cardNode);
    const title = cleanText(card.find(".card-header").first().text()) || "Stats";

    const tables = card
      .find("table")
      .map((__, tableNode) => parseStatsTable($, tableNode))
      .get()
      .filter((table) => table.rows.length > 0 || table.headers.length > 0);

    if (tables.length === 0) {
      return;
    }

    sections.push({
      title,
      tables,
    });
  });

  return sections;
}

function listGameInnings(lineScore: LineScore | null): number[] {
  const innings = new Set<number>();

  if (lineScore) {
    for (const header of lineScore.headers) {
      const inning = parseInteger(header);
      if (inning !== null && inning > 0 && inning < 40) {
        innings.add(inning);
      }
    }

    for (const row of lineScore.rows) {
      for (const inning of row.innings) {
        if (inning.inning > 0 && inning.inning < 40) {
          innings.add(inning.inning);
        }
      }
    }
  }

  if (innings.size === 0) {
    for (let inning = 1; inning <= 9; inning += 1) {
      innings.add(inning);
    }
  }

  return Array.from(innings).sort((a, b) => a - b);
}

function determineWinner(
  visitorScore: number | null,
  homeScore: number | null
): "visitor" | "home" | null {
  if (visitorScore === null || homeScore === null || visitorScore === homeScore) {
    return null;
  }

  return visitorScore > homeScore ? "visitor" : "home";
}

function determineFinalStatus(
  summary: StatBroadcastLiveSummary,
  decisions: {
    winning: PitcherDecision | null;
    losing: PitcherDecision | null;
    save: PitcherDecision | null;
  }
): "final" | "not_final" | "unknown" {
  const status = cleanText(summary.statusText).toLowerCase();

  if (/final|game over|ended/.test(status)) {
    return "final";
  }

  if (/(top|bot|middle|end)\s+\d/.test(status)) {
    return "not_final";
  }

  if (decisions.winning && decisions.losing) {
    return "final";
  }

  if (summary.situation) {
    return "not_final";
  }

  if (summary.visitorScore !== null && summary.homeScore !== null) {
    return "unknown";
  }

  return "unknown";
}

function parseLineups(
  sections: StatsSection[],
  summary: StatBroadcastLiveSummary
): { away: FinalLineupEntry[]; home: FinalLineupEntry[] } {
  const lineupSections = sections.filter((section) => /line\s*up/i.test(section.title));
  const fallback = lineupSections.map((section) => parseLineupTable(section.tables[0])).filter(Boolean);

  const awayHints = buildTeamHints(summary, "away");
  const homeHints = buildTeamHints(summary, "home");

  let away: FinalLineupEntry[] | null = null;
  let home: FinalLineupEntry[] | null = null;

  for (const section of lineupSections) {
    const parsed = parseLineupTable(section.tables[0]);
    if (parsed.length === 0) {
      continue;
    }

    const normalizedTitle = normalizeNameForMatch(section.title);
    if (!away && containsAnyHint(normalizedTitle, awayHints)) {
      away = parsed;
      continue;
    }

    if (!home && containsAnyHint(normalizedTitle, homeHints)) {
      home = parsed;
    }
  }

  if (!away && fallback[0]) {
    away = fallback[0];
  }

  if (!home && fallback[1]) {
    home = fallback[1];
  }

  return {
    away: away ?? [],
    home: home ?? [],
  };
}

function buildTeamHints(
  summary: StatBroadcastLiveSummary,
  side: "away" | "home"
): string[] {
  const hints = new Set<string>();
  const teamName = side === "away" ? summary.visitorTeam : summary.homeTeam;
  const normalized = normalizeNameForMatch(teamName);

  if (normalized) {
    hints.add(normalized);
  }

  const parts = normalized
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 1);

  for (let index = 0; index < parts.length - 1; index += 1) {
    hints.add(`${parts[index]} ${parts[index + 1]}`);
  }

  const rowIndex = side === "away" ? 0 : 1;
  const abbreviation = cleanText(summary.lineScore?.rows[rowIndex]?.team ?? "");
  const normalizedAbbreviation = normalizeNameForMatch(abbreviation);
  if (normalizedAbbreviation) {
    hints.add(normalizedAbbreviation);
  }

  return Array.from(hints);
}

function containsAnyHint(text: string, hints: string[]): boolean {
  return hints.some((hint) => hint.length > 0 && text.includes(hint));
}

function parseLineupTable(table: StatsTable | undefined): FinalLineupEntry[] {
  if (!table) {
    return [];
  }

  return table.rows
    .map((row) => {
      const spot = toNumber(readTableCellByHeader(table, row, /^spot$/i));
      const position = toOptionalString(readTableCellByHeader(table, row, /^pos$/i));
      const player = toOptionalString(
        readTableCellByHeader(table, row, /^#?\s*player$/i) ?? readTableCellByHeader(table, row, /^player$/i)
      );
      const bats = toOptionalString(readTableCellByHeader(table, row, /^bats$/i));
      const today = toOptionalString(readTableCellByHeader(table, row, /^today$/i));
      const avg = toOptionalString(readTableCellByHeader(table, row, /^avg$/i));

      if (!player) {
        return null;
      }

      return {
        spot,
        position,
        player,
        bats,
        today,
        avg,
      };
    })
    .filter((entry): entry is FinalLineupEntry => entry !== null);
}

function buildFinalTeamStats(sections: StatsSection[]): FinalTeamStats {
  const boxScore =
    sections.find((section) => /box score/i.test(section.title))?.tables[0] ?? null;
  const pitching =
    sections.find((section) => /pitching stats/i.test(section.title))?.tables[0] ?? null;

  return {
    sections,
    boxScore,
    pitching,
  };
}

function parsePitcherDecisions(
  visitorStats: FinalTeamStats,
  homeStats: FinalTeamStats
): {
  winning: PitcherDecision | null;
  losing: PitcherDecision | null;
  save: PitcherDecision | null;
} {
  const all = [
    ...extractPitcherDecisionsFromTable("away", visitorStats.pitching),
    ...extractPitcherDecisionsFromTable("home", homeStats.pitching),
  ];

  return {
    winning: all.find((decision) => decision.code === "W") ?? null,
    losing: all.find((decision) => decision.code === "L") ?? null,
    save: all.find((decision) => decision.code === "S") ?? null,
  };
}

function extractPitcherDecisionsFromTable(
  team: "away" | "home",
  table: StatsTable | null
): PitcherDecision[] {
  if (!table) {
    return [];
  }

  return table.rows
    .map((row) => {
      const player =
        toOptionalString(readTableCellByHeader(table, row, /^player$/i)) ??
        toOptionalString(row.cells[1]);
      const decisionRaw = findDecisionCell(table, row);
      if (!player || !decisionRaw) {
        return null;
      }

      const parsed = parseDecisionCode(decisionRaw);
      if (!parsed) {
        return null;
      }

      return {
        team,
        player,
        code: parsed.code,
        record: parsed.record,
        raw: decisionRaw,
      };
    })
    .filter((entry): entry is PitcherDecision => entry !== null);
}

function findDecisionCell(table: StatsTable, row: StatsTableRow): string | null {
  const direct = toOptionalString(readTableCellByHeader(table, row, /^dec$/i));
  if (direct && /^[wls]\b/i.test(direct)) {
    return direct;
  }

  for (const cell of row.cells) {
    const value = toOptionalString(cell);
    if (value && /^[wls]\b/i.test(value)) {
      return value;
    }
  }

  return null;
}

function parseDecisionCode(
  raw: string
): { code: PitcherDecisionCode; record: string | null } | null {
  const match = cleanText(raw).match(/^([WLS])\s*(.*)$/i);
  if (!match) {
    return null;
  }

  const code = match[1].toUpperCase() as PitcherDecisionCode;
  const record = cleanText(match[2]) || null;

  return {
    code,
    record,
  };
}

function parseScoringPlays(sections: StatsSection[]): FinalScoringPlay[] {
  const section = sections.find((entry) => /scoring summary/i.test(entry.title));
  const table = section?.tables[0];
  if (!table) {
    return [];
  }

  return table.rows
    .map((row) => {
      const play = toOptionalString(readTableCellByHeader(table, row, /^play$/i));
      if (!play || play.toLowerCase() === "play") {
        return null;
      }

      return {
        team: toOptionalString(readTableCellByHeader(table, row, /^team$/i)),
        inning: toOptionalString(readTableCellByHeader(table, row, /^inn$/i)),
        scoringDecision: toOptionalString(readTableCellByHeader(table, row, /^scoring dec\.?$/i)),
        play,
        batter: toOptionalString(readTableCellByHeader(table, row, /^batter$/i)),
        pitcher: toOptionalString(readTableCellByHeader(table, row, /^pitcher$/i)),
        outs: toNumber(readTableCellByHeader(table, row, /^outs$/i)),
      };
    })
    .filter((entry): entry is FinalScoringPlay => entry !== null);
}

function parseInningPlayByPlay(inning: number, html: string): FinalInningPlayByPlay {
  const sections = parseStatsSections(html);
  const section = sections.find((entry) => /inning play-by-play/i.test(entry.title));
  const table = section?.tables[0];

  if (!section || !table) {
    return {
      inning,
      title: `${inning}th Inning Play-by-play`,
      events: [],
    };
  }

  const events = table.rows
    .map((row) => parsePlayByPlayRow(table, row))
    .filter((entry): entry is FinalPlayByPlayEvent => entry !== null);

  return {
    inning,
    title: section.title,
    events,
  };
}

function parsePlayByPlayRow(table: StatsTable, row: StatsTableRow): FinalPlayByPlayEvent | null {
  if (isHeaderPlaceholderRow(table, row)) {
    return null;
  }

  const aligned = alignCellsToHeaders(table.headers, row.cells);
  const firstCell = toOptionalString(aligned[0] ?? row.cells[0] ?? null);
  const action = toOptionalString(aligned[0]);
  const play = toOptionalString(readTableCellByHeader(table, row, /^play$/i));
  const scoringDecision = toOptionalString(readTableCellByHeader(table, row, /^scoring dec\.?$/i));
  const batter = toOptionalString(readTableCellByHeader(table, row, /^batter$/i));
  const pitcher = toOptionalString(readTableCellByHeader(table, row, /^pitcher$/i));
  const outs = toNumber(readTableCellByHeader(table, row, /^outs$/i));

  if (firstCell && /^top of the|^bottom of the/i.test(firstCell)) {
    return {
      type: "half",
      half: /^top/i.test(firstCell) ? "top" : "bottom",
      text: firstCell,
      action: null,
      scoringDecision: null,
      batter: null,
      pitcher: null,
      outs: null,
    };
  }

  if (firstCell && /inning summary:/i.test(firstCell)) {
    return {
      type: "summary",
      half: null,
      text: firstCell,
      action: null,
      scoringDecision: null,
      batter: null,
      pitcher: null,
      outs: null,
    };
  }

  if (play) {
    return {
      type: "play",
      half: null,
      text: play,
      action: action && action !== play ? action : null,
      scoringDecision,
      batter,
      pitcher,
      outs,
    };
  }

  if (firstCell) {
    return {
      type: "note",
      half: null,
      text: firstCell,
      action: null,
      scoringDecision: null,
      batter: null,
      pitcher: null,
      outs: null,
    };
  }

  return null;
}

function isHeaderPlaceholderRow(table: StatsTable, row: StatsTableRow): boolean {
  const play = toOptionalString(readTableCellByHeader(table, row, /^play$/i));
  const scoring = toOptionalString(readTableCellByHeader(table, row, /^scoring dec\.?$/i));
  const batter = toOptionalString(readTableCellByHeader(table, row, /^batter$/i));
  const pitcher = toOptionalString(readTableCellByHeader(table, row, /^pitcher$/i));
  const outs = toOptionalString(readTableCellByHeader(table, row, /^outs$/i));

  return (
    play === "Play" &&
    scoring === "Scoring Dec." &&
    batter === "Batter" &&
    pitcher === "Pitcher" &&
    outs === "Outs"
  );
}

function parseNotesDocs(notesHtml: string, sections: StatsSection[]): FinalNotesDocs {
  return {
    sections,
    gameInformation: extractGameInformation(sections),
    notes: extractScorerNotes(sections),
    documents: extractDocumentLinks(notesHtml),
  };
}

function extractGameInformation(sections: StatsSection[]): Record<string, string | number | null> {
  const infoSection = sections.find((section) => /game information/i.test(section.title));
  const table = infoSection?.tables[0];
  const data: Record<string, string | number | null> = {};

  if (!table) {
    return data;
  }

  for (const row of table.rows) {
    const keyRaw = toOptionalString(row.cells[0]);
    if (!keyRaw) {
      continue;
    }

    const key = keyRaw.replace(/:\s*$/, "");
    data[key] = (row.cells[1] ?? null) as string | number | null;
  }

  return data;
}

function extractScorerNotes(sections: StatsSection[]): string[] {
  const notes = new Set<string>();

  sections.forEach((section) => {
    const isNoteSection = /notes?/i.test(section.title);
    if (!isNoteSection && !/game information/i.test(section.title)) {
      return;
    }

    section.tables.forEach((table) => {
      table.rows.forEach((row) => {
        row.cells.forEach((cell) => {
          const text = toOptionalString(cell);
          if (!text) {
            return;
          }

          if (/scorer'?s notes?/i.test(text) || (isNoteSection && text.length > 0)) {
            notes.add(text);
          }
        });
      });
    });
  });

  return Array.from(notes);
}

function extractDocumentLinks(html: string): Array<{ label: string; url: string }> {
  const $ = load(html);
  const links = new Map<string, { label: string; url: string }>();

  $(".card a[href]").each((_, node) => {
    const href = cleanText($(node).attr("href"));
    if (!href || href === "#" || href.toLowerCase().startsWith("javascript:")) {
      return;
    }

    let url = href;
    try {
      url = new URL(href, "https://stats.statbroadcast.com").toString();
    } catch {
      return;
    }

    const label = cleanText($(node).text()) || url;
    const key = `${label}|${url}`;
    if (!links.has(key)) {
      links.set(key, { label, url });
    }
  });

  return Array.from(links.values());
}

function readTableCellByHeader(
  table: StatsTable,
  row: StatsTableRow,
  headerPattern: RegExp
): string | number | null {
  const index = table.headers.findIndex((header) => headerPattern.test(cleanText(header)));
  if (index === -1) {
    return null;
  }

  const aligned = alignCellsToHeaders(table.headers, row.cells);
  return (aligned[index] ?? null) as string | number | null;
}

function toOptionalString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = cleanText(String(value));
  return text.length > 0 ? text : null;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return parseInteger(value === null || value === undefined ? null : String(value));
}

function parseStatsTable($: ReturnType<typeof load>, tableNode: Element): StatsTable {
  const table = $(tableNode);
  let headers = table
    .find("thead th")
    .map((_, node) => cleanText($(node).text()))
    .get();

  const rowNodes = table.find("tbody tr");
  const rowsSource = rowNodes.length > 0 ? rowNodes : table.find("tr");

  const rows = rowsSource
    .map((_, rowNode) => {
      const row = $(rowNode);
      const cells = row
        .find("th, td")
        .map((__, cellNode) => coerceCellValue(cleanText($(cellNode).text())))
        .get();

      if (cells.length === 0) {
        return null;
      }

      if (headers.length === 0 && row.find("th").length > 0 && row.find("td").length === 0) {
        headers = cells.map((value) => String(value ?? ""));
        return null;
      }

      return buildStatsTableRow(headers, cells);
    })
    .get()
    .filter((row): row is StatsTableRow => row !== null);

  if (headers.length === 0 && rows.length > 0) {
    headers = rows[0].cells.map((_, index) => `col_${index + 1}`);
    rows.forEach((row) => {
      row.values = buildColumnMap(headers, row.cells);
    });
  }

  return {
    headers,
    rows,
  };
}

function buildStatsTableRow(headers: string[], cells: Array<string | number | null>): StatsTableRow {
  const normalizedHeaders =
    headers.length > 0 ? headers : cells.map((_, index) => `col_${index + 1}`);

  return {
    cells,
    values: buildColumnMap(normalizedHeaders, cells),
  };
}

function buildColumnMap(
  headers: string[],
  cells: Array<string | number | null>
): Record<string, string | number | null> {
  const nonBlankHeaders = headers
    .map((header, index) => ({ header, index }))
    .filter((entry) => cleanText(entry.header) !== "");

  if (nonBlankHeaders.length > 0 && nonBlankHeaders.length === cells.length) {
    const compactMap: Record<string, string | number | null> = {};
    nonBlankHeaders.forEach((entry, compactIndex) => {
      const key = normalizeStatColumnKey(entry.header, entry.index);
      compactMap[key] = cells[compactIndex] ?? null;
    });
    return compactMap;
  }

  const alignedCells = alignCellsToHeaders(headers, cells);
  const map: Record<string, string | number | null> = {};
  headers.forEach((header, index) => {
    const key = normalizeStatColumnKey(header, index);
    map[key] = alignedCells[index] ?? null;
  });

  return map;
}

function alignCellsToHeaders<T>(
  headers: string[],
  cells: Array<T | null>
): Array<T | null> {
  if (headers.length === cells.length) {
    return cells;
  }

  if (headers.length === cells.length + 1 && cleanText(headers[0]) === "") {
    return [null, ...cells];
  }

  if (
    headers.length === cells.length + 1 &&
    cleanText(headers[headers.length - 1]) === ""
  ) {
    return [...cells, null];
  }

  return cells;
}

function parseMatch(input: string, pattern: RegExp): number | null {
  const match = input.match(pattern);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

function coerceCell(raw: string): number | null | string {
  const numeric = parseInteger(raw);
  if (numeric !== null) {
    return numeric;
  }

  return raw;
}

function normalizeColumnKey(header: string, index: number): string {
  const text = header.toLowerCase();

  if (/^\d+$/.test(text)) {
    return `inning_${text}`;
  }

  if (text === "team") {
    return "team";
  }

  if (text === "r" || text === "h" || text === "e" || text === "lob") {
    return text;
  }

  if (text.length === 0) {
    return `blank_${index}`;
  }

  return text.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeStatColumnKey(header: string, index: number): string {
  const clean = cleanText(header).toLowerCase();
  if (!clean) {
    return `col_${index + 1}`;
  }

  if (/^\d+$/.test(clean)) {
    return `inning_${clean}`;
  }

  return clean.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `col_${index + 1}`;
}

function coerceCellValue(raw: string): string | number | null {
  if (raw.length === 0) {
    return null;
  }

  if (/^-?\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }

  if (/^-?\d+\.\d+$/.test(raw)) {
    return Number.parseFloat(raw);
  }

  return raw;
}

function normalizeViewKey(requestedView?: string): string {
  const view = cleanText(requestedView ?? "").toLowerCase();
  if (!view) {
    return "game";
  }

  return view;
}

function resolveXslForView(sport: string, requestedView?: string): string {
  const view = normalizeViewKey(requestedView);

  if (sport === "bsgame") {
    if (view.startsWith("plays_inning_")) {
      const inning = Number.parseInt(view.replace("plays_inning_", ""), 10);
      if (Number.isFinite(inning) && inning > 0 && inning < 30) {
        return `baseball/sb.bsgame.views.pxp.xsl&params={\"inn\":${inning}}`;
      }
    }

    return BASEBALL_VIEW_XSL[view] ?? BASEBALL_VIEW_XSL.game;
  }

  return XSL_BY_SPORT[sport] ?? XSL_BY_SPORT.bsgame;
}

async function serviceCall(path: string, data: string): Promise<string> {
  const encoded = Buffer.from(data, "utf8").toString("base64");

  const response = await axios.get<string>(`${BASE_URL}/${path}`, {
    params: { data: encoded },
    timeout: 20_000,
    responseType: "text",
    transformResponse: [(value) => value],
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status >= 400) {
    throw new Error(`StatBroadcast request failed (${response.status})`);
  }

  const body = String(response.data ?? "");
  if (!body) {
    throw new Error("StatBroadcast returned an empty response.");
  }

  try {
    const rotated = rot13(body);
    return Buffer.from(rotated, "base64").toString("utf8");
  } catch (error) {
    throw new Error(`Failed to decode StatBroadcast payload: ${(error as Error).message}`);
  }
}

function rot13(input: string): string {
  return input.replace(/[a-zA-Z]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= 97 ? 97 : 65;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}
