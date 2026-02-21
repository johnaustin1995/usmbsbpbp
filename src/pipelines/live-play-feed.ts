import crypto from "crypto";
import type {
  StatBroadcastLiveStats,
  StatBroadcastLiveSummary,
  StatsTable,
  StatsTableRow,
} from "../types";
import { cleanText, parseInteger } from "../utils/text";

export interface LivePlayEvent {
  key: string;
  order: number;
  inning: number | null;
  half: "top" | "bottom" | null;
  isSubstitution: boolean;
  text: string;
  scoringDecision: string | null;
  batter: string | null;
  pitcher: string | null;
  outs: number | null;
  sectionTitle: string;
}

export interface BuildPlayTweetTextInput {
  play: LivePlayEvent;
  summary: StatBroadcastLiveSummary;
  stateAfterPlay?: DerivedPlayState | null;
  maxLength?: number;
  appendTag?: string | null;
}

export interface BuildFinalTweetTextInput {
  summary: StatBroadcastLiveSummary;
  pitcherDecisions?: {
    winning: string | null;
    save: string | null;
    losing: string | null;
  } | null;
  maxLength?: number;
  appendTag?: string | null;
}

export interface DerivedPlayState {
  awayScore: number | null;
  homeScore: number | null;
  outsAfterPlay: number | null;
}

export function extractLivePlayEvents(liveStats: StatBroadcastLiveStats): LivePlayEvent[] {
  const events: LivePlayEvent[] = [];
  const occurrenceBySignature = new Map<string, number>();

  let order = 0;
  for (const section of liveStats.sections) {
    if (!/play-by-play/i.test(section.title)) {
      continue;
    }

    const inningFromTitle = parseInningFromTitle(section.title);

    for (const table of section.tables) {
      let currentHalf: "top" | "bottom" | null = null;

      for (const row of table.rows) {
        const parsed = parsePlayRow(table, row);
        if (!parsed) {
          continue;
        }

        if (parsed.type === "half") {
          currentHalf = parsed.half;
          continue;
        }

        const inning = parsed.inning ?? inningFromTitle;
        const half = parsed.half ?? currentHalf;

        const signature = normalizeSignatureValue(inning) +
          "|" +
          normalizeSignatureValue(half) +
          "|" +
          normalizeSignatureValue(parsed.text) +
          "|" +
          normalizeSignatureValue(parsed.batter) +
          "|" +
          normalizeSignatureValue(parsed.pitcher) +
          "|" +
          normalizeSignatureValue(parsed.outs) +
          "|" +
          normalizeSignatureValue(parsed.scoringDecision);

        const occurrence = (occurrenceBySignature.get(signature) ?? 0) + 1;
        occurrenceBySignature.set(signature, occurrence);

        order += 1;
        events.push({
          key: digest(`${signature}|${occurrence}`),
          order,
          inning,
          half,
          isSubstitution: parsed.isSubstitution,
          text: parsed.text,
          scoringDecision: parsed.scoringDecision,
          batter: parsed.batter,
          pitcher: parsed.pitcher,
          outs: parsed.outs,
          sectionTitle: section.title,
        });
      }
    }
  }

  return events;
}

export function deriveLivePlayStates(
  plays: LivePlayEvent[],
  summary: StatBroadcastLiveSummary
): Map<string, DerivedPlayState> {
  const states = new Map<string, DerivedPlayState>();

  plays.forEach((play) => {
    states.set(play.key, {
      awayScore: summary.visitorScore,
      homeScore: summary.homeScore,
      outsAfterPlay: play.outs,
    });
  });

  let awayScore = summary.visitorScore;
  let homeScore = summary.homeScore;

  for (let index = plays.length - 1; index >= 0; index -= 1) {
    const play = plays[index];
    const state = states.get(play.key);
    if (!state) {
      continue;
    }

    state.awayScore = awayScore;
    state.homeScore = homeScore;

    const runsScored = estimateRunsScoredOnPlay(play);
    const battingSide = inferBattingSide(play);

    if (runsScored > 0 && battingSide === "away" && awayScore !== null) {
      awayScore = Math.max(0, awayScore - runsScored);
    } else if (runsScored > 0 && battingSide === "home" && homeScore !== null) {
      homeScore = Math.max(0, homeScore - runsScored);
    }
  }

  for (let index = 0; index < plays.length; index += 1) {
    const play = plays[index];
    const nextPlay = plays[index + 1] ?? null;
    const state = states.get(play.key);
    if (!state) {
      continue;
    }

    if (nextPlay && isSameHalfInning(play, nextPlay) && nextPlay.outs !== null) {
      state.outsAfterPlay = clampOuts(nextPlay.outs);
      continue;
    }

    if (nextPlay && !isSameHalfInning(play, nextPlay)) {
      state.outsAfterPlay = 3;
      continue;
    }

    if (play.outs !== null) {
      state.outsAfterPlay = clampOuts(play.outs + estimateOutsRecordedOnPlay(play.text));
    } else {
      state.outsAfterPlay = null;
    }
  }

  return states;
}

export function buildPlayTweetText(input: BuildPlayTweetTextInput): string {
  const maxLength = clampTweetLength(input.maxLength ?? 280);
  const outs =
    input.stateAfterPlay?.outsAfterPlay ??
    input.play.outs ??
    input.summary.situation?.outs ??
    null;
  const inningLabel = buildInningLabel(input.play, outs, input.summary);
  const pitcherName = normalizeDisplayName(cleanText(input.play.pitcher ?? input.summary.situation?.pitcher.name ?? ""));
  const pitchCount = input.summary.situation?.pitcher.pitchCount ?? null;
  const awayScore = input.stateAfterPlay?.awayScore ?? input.summary.visitorScore;
  const homeScore = input.stateAfterPlay?.homeScore ?? input.summary.homeScore;

  const blocks: string[] = [];
  blocks.push(formatHeaderLine(inningLabel, outs));
  blocks.push(
    `${cleanText(input.summary.visitorTeam)} - ${formatScore(awayScore)}\n${cleanText(input.summary.homeTeam)} - ${formatScore(homeScore)}`
  );
  blocks.push(normalizeNamesInText(cleanText(input.play.text), [input.play.batter, input.play.pitcher]));

  if (pitcherName && pitchCount !== null) {
    blocks.push(`Pitching | ${pitcherName} - P ${pitchCount}`);
  }

  if (input.appendTag) {
    blocks.push(input.appendTag.trim());
  }

  return trimToTweetLength(blocks.filter((block) => block.length > 0).join("\n\n"), maxLength);
}

export function buildFinalTweetText(input: BuildFinalTweetTextInput): string {
  const maxLength = clampTweetLength(input.maxLength ?? 280);
  const away = cleanText(input.summary.visitorTeam);
  const home = cleanText(input.summary.homeTeam);
  const awayScore = formatScore(input.summary.visitorScore);
  const homeScore = formatScore(input.summary.homeScore);

  const winning = toOptionalFinalPitcherName(input.pitcherDecisions?.winning);
  const save = toOptionalFinalPitcherName(input.pitcherDecisions?.save);
  const losing = toOptionalFinalPitcherName(input.pitcherDecisions?.losing);

  const lines = [
    "Final",
    `${away} - ${awayScore}`,
    `${home} - ${homeScore}`,
  ];

  const decisionLines = [
    winning ? `W - ${winning}` : null,
    save ? `S - ${save}` : null,
    losing ? `L - ${losing}` : null,
  ].filter((line): line is string => Boolean(line));

  if (decisionLines.length > 0) {
    lines.push("", ...decisionLines);
  }

  if (input.appendTag) {
    lines.push(input.appendTag.trim());
  }

  return trimToTweetLength(lines.join("\n"), maxLength);
}

function toOptionalFinalPitcherName(value: string | null | undefined): string | null {
  const normalized = normalizeDisplayName(cleanText(value ?? ""));
  return normalized.length > 0 ? normalized : null;
}

export function isFinalStatus(summary: StatBroadcastLiveSummary): boolean {
  if (summary.event.completed) {
    return true;
  }

  const status = cleanText(summary.statusText ?? "").toLowerCase();
  if (!status) {
    return false;
  }

  return /\bfinal\b|game over|ended|complete(d)?/i.test(status);
}

interface ParsedHalfRow {
  type: "half";
  half: "top" | "bottom";
}

interface ParsedPlayRow {
  type: "play";
  inning: number | null;
  half: "top" | "bottom" | null;
  text: string;
  isSubstitution: boolean;
  scoringDecision: string | null;
  batter: string | null;
  pitcher: string | null;
  outs: number | null;
}

type ParsedRow = ParsedHalfRow | ParsedPlayRow;

function parsePlayRow(table: StatsTable, row: StatsTableRow): ParsedRow | null {
  if (isHeaderPlaceholderRow(table, row)) {
    return null;
  }

  const aligned = alignCellsToHeaders(table.headers, row.cells);
  const firstCell = toOptionalString(aligned[0] ?? row.cells[0] ?? null);
  const fallback = inferPlayRowFields(row.cells);

  let play = toOptionalString(readTableCellByHeader(table, row, /^play$/i));
  let scoringDecision = toOptionalString(readTableCellByHeader(table, row, /^scoring dec\.?$/i));
  let batter = toOptionalString(readTableCellByHeader(table, row, /^batter$/i));
  let pitcher = toOptionalString(readTableCellByHeader(table, row, /^pitcher$/i));
  let outs = toOptionalNumber(readTableCellByHeader(table, row, /^outs$/i));

  if (isInvalidParsedPlay(play, firstCell, batter, pitcher, outs)) {
    play = fallback.play ?? play;
    scoringDecision = fallback.scoringDecision ?? scoringDecision;
    batter = fallback.batter ?? batter;
    pitcher = fallback.pitcher ?? pitcher;
    outs = fallback.outs ?? outs;
  }

  if (firstCell && /^top of the|^bottom of the/i.test(firstCell)) {
    return {
      type: "half",
      half: /^top/i.test(firstCell) ? "top" : "bottom",
    };
  }

  if (firstCell && /inning summary:/i.test(firstCell)) {
    return null;
  }

  if (!play || play.toLowerCase() === "play") {
    return null;
  }
  if (/^\d+$/u.test(play)) {
    return null;
  }

  const halfAndInning = firstCell ? parseHalfAndInning(firstCell) : null;

  return {
    type: "play",
    inning: halfAndInning?.inning ?? null,
    half: halfAndInning?.half ?? null,
    text: play,
    isSubstitution: isSubstitutionText(play),
    scoringDecision,
    batter,
    pitcher,
    outs,
  };
}

interface FallbackPlayFields {
  play: string | null;
  scoringDecision: string | null;
  batter: string | null;
  pitcher: string | null;
  outs: number | null;
}

function inferPlayRowFields(cells: Array<string | number | null>): FallbackPlayFields {
  const values = cells
    .map((cell) => toOptionalString(cell))
    .filter((cell): cell is string => Boolean(cell));

  if (values.length === 0) {
    return {
      play: null,
      scoringDecision: null,
      batter: null,
      pitcher: null,
      outs: null,
    };
  }

  let outs: number | null = null;
  const last = values[values.length - 1];
  if (/^\d$/u.test(last)) {
    const parsedOuts = Number.parseInt(last, 10);
    if (Number.isFinite(parsedOuts) && parsedOuts >= 0 && parsedOuts <= 3) {
      outs = parsedOuts;
      values.pop();
    }
  }

  if (values.length === 0) {
    return {
      play: null,
      scoringDecision: null,
      batter: null,
      pitcher: null,
      outs,
    };
  }

  if (values.length >= 2 && isLikelyActionCode(values[0]) && isLikelyPlayText(values[1])) {
    values.shift();
  }

  const play = values[0] ?? null;
  const remainder = values.slice(1);

  let scoringDecision: string | null = null;
  let batter: string | null = null;
  let pitcher: string | null = null;

  if (remainder.length >= 2 && isLikelyPlayerName(remainder[remainder.length - 1])) {
    const maybePitcher = remainder[remainder.length - 1];
    const maybeBatter = remainder[remainder.length - 2] ?? null;
    if (maybeBatter && isLikelyPlayerName(maybeBatter)) {
      pitcher = maybePitcher;
      batter = maybeBatter;
      const scoringParts = remainder.slice(0, -2).filter((entry) => !isLikelyActionCode(entry));
      scoringDecision = scoringParts.length > 0 ? scoringParts.join(" ") : null;
    }
  }

  if (!scoringDecision && remainder.length > 0) {
    const candidate = remainder[0];
    if (!isLikelyPlayerName(candidate)) {
      scoringDecision = candidate;
    }
  }

  return {
    play,
    scoringDecision,
    batter,
    pitcher,
    outs,
  };
}

function isInvalidParsedPlay(
  play: string | null,
  firstCell: string | null,
  batter: string | null,
  pitcher: string | null,
  outs: number | null
): boolean {
  if (!play || /^\d+$/u.test(play)) {
    return true;
  }

  if (batter && /^\d+$/u.test(batter)) {
    return true;
  }

  if (firstCell && play === batter && firstCell.length > play.length + 6) {
    return true;
  }

  if (firstCell && play !== firstCell && isLikelyPlayText(firstCell) && !isLikelyPlayText(play)) {
    return true;
  }

  if (play && !play.includes(" ") && !pitcher && outs === null && firstCell && isLikelyPlayText(firstCell)) {
    return true;
  }

  return false;
}

function isLikelyPlayText(value: string): boolean {
  const text = cleanText(value);
  if (!text) {
    return false;
  }

  if (isLikelyActionCode(text)) {
    return false;
  }

  return /\s/.test(text) || /[.();]/.test(text);
}

function isLikelyActionCode(value: string): boolean {
  const text = cleanText(value);
  if (!text) {
    return false;
  }

  if (text.includes(" ")) {
    return false;
  }

  return /^[A-Z0-9]{1,4}$/u.test(text);
}

function isLikelyPlayerName(value: string): boolean {
  const text = cleanText(value);
  if (!text) {
    return false;
  }

  if (/^\d+$/u.test(text)) {
    return false;
  }

  if (isLikelyActionCode(text)) {
    return false;
  }

  return /^[A-Za-z][A-Za-z'. -]*$/u.test(text);
}

function parseHalfAndInning(
  value: string
): { half: "top" | "bottom" | null; inning: number | null } | null {
  const match = cleanText(value).match(/(top|bottom|bot)\s+of\s+the\s+(\d+)/i);
  if (!match) {
    return null;
  }

  return {
    half: /^top/i.test(match[1]) ? "top" : "bottom",
    inning: Number.parseInt(match[2], 10),
  };
}

function parseInningFromTitle(title: string): number | null {
  const match = cleanText(title).match(/(\d+)(?:st|nd|rd|th)?\s+inning/i);
  if (!match) {
    return null;
  }

  const inning = Number.parseInt(match[1], 10);
  return Number.isFinite(inning) ? inning : null;
}

function isHeaderPlaceholderRow(table: StatsTable, row: StatsTableRow): boolean {
  const play = toOptionalString(readTableCellByHeader(table, row, /^play$/i));
  const scoring = toOptionalString(readTableCellByHeader(table, row, /^scoring dec\.?$/i));
  const batter = toOptionalString(readTableCellByHeader(table, row, /^batter$/i));
  const pitcher = toOptionalString(readTableCellByHeader(table, row, /^pitcher$/i));
  const outs = toOptionalString(readTableCellByHeader(table, row, /^outs$/i));

  return play === "Play" && scoring === "Scoring Dec." && batter === "Batter" && pitcher === "Pitcher" && outs === "Outs";
}

function readTableCellByHeader(table: StatsTable, row: StatsTableRow, headerPattern: RegExp): string | number | null {
  const index = table.headers.findIndex((header) => headerPattern.test(cleanText(header)));
  if (index === -1) {
    return null;
  }

  const aligned = alignCellsToHeaders(table.headers, row.cells);
  return (aligned[index] ?? null) as string | number | null;
}

function alignCellsToHeaders<T>(headers: string[], cells: Array<T | null>): Array<T | null> {
  if (headers.length === cells.length) {
    return cells;
  }

  if (headers.length === cells.length + 1 && cleanText(headers[0]) === "") {
    return [null, ...cells];
  }

  if (headers.length === cells.length + 1 && cleanText(headers[headers.length - 1]) === "") {
    return [...cells, null];
  }

  return cells;
}

function toOptionalString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = cleanText(String(value));
  return text.length > 0 ? text : null;
}

function toOptionalNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value === null || value === undefined) {
    return null;
  }

  return parseInteger(String(value));
}

function buildInningLabel(
  play: LivePlayEvent,
  outsAfterPlay: number | null,
  summary: StatBroadcastLiveSummary
): string {
  if (play.inning !== null && play.half && outsAfterPlay === 3 && !play.isSubstitution) {
    return `${play.half === "top" ? "Mid" : "End"} ${ordinal(play.inning)}`;
  }

  if (play.inning !== null && play.half) {
    return `${capitalize(play.half)} ${ordinal(play.inning)}`;
  }

  if (play.inning !== null) {
    return `Inning ${ordinal(play.inning)}`;
  }

  const status = cleanText(summary.statusText ?? "");
  return status || "Live";
}

function buildScoreLine(summary: StatBroadcastLiveSummary): string {
  const away = cleanText(summary.visitorTeam);
  const home = cleanText(summary.homeTeam);

  return `${away} ${formatScore(summary.visitorScore)} - ${home} ${formatScore(summary.homeScore)}`;
}

function formatScore(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "?";
  }

  return String(value);
}

function formatOutsLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "Outs ?";
  }

  return `${value} ${value === 1 ? "Out" : "Outs"}`;
}

function formatHeaderLine(inningLabel: string, outs: number | null): string {
  if (/^(Mid|End)\b/.test(inningLabel)) {
    return inningLabel;
  }

  return `${inningLabel} | ${formatOutsLabel(outs)}`;
}

function normalizeNamesInText(value: string, explicitNames: Array<string | null | undefined> = []): string {
  let text = value.replace(
    /\b([A-Za-z][A-Za-z'.-]+),\s*([A-Za-z][A-Za-z'.-]+)\b/g,
    (_, last: string, first: string) => `${toTitleCasePersonName(first)} ${toTitleCasePersonName(last)}`
  );
  text = text.replace(
    /\b([A-Za-z]\.)\s+([A-Za-z][A-Za-z'.-]+)\b/g,
    (_, initial: string, last: string) => `${initial.toUpperCase()} ${toTitleCasePersonName(last)}`
  );
  text = normalizeUppercaseSurnameContext(text);

  const replacements = new Map<string, string>();
  for (const rawName of explicitNames) {
    const raw = cleanText(rawName ?? "");
    if (!raw) {
      continue;
    }

    const normalized = normalizeDisplayName(raw);
    if (!normalized) {
      continue;
    }

    replacements.set(raw, normalized);
    replacements.set(raw.toUpperCase(), normalized);
    replacements.set(raw.toLowerCase(), normalized);
    replacements.set(normalized, normalized);
    replacements.set(normalized.toUpperCase(), normalized);
  }

  const variants = Array.from(replacements.entries()).sort((a, b) => b[0].length - a[0].length);
  for (const [variant, normalized] of variants) {
    if (!variant || variant === normalized) {
      continue;
    }
    text = replaceNameVariant(text, variant, normalized);
  }

  return text;
}

function normalizeDisplayName(value: string): string {
  const text = cleanText(value);
  const match = text.match(/^([A-Za-z][A-Za-z'.-]+),\s*([A-Za-z][A-Za-z'.-]+)$/);
  if (!match) {
    return toTitleCasePersonName(text);
  }

  return `${toTitleCasePersonName(match[2])} ${toTitleCasePersonName(match[1])}`;
}

function replaceNameVariant(text: string, variant: string, normalized: string): string {
  const pattern = escapeRegExp(variant).replace(/\s+/g, "\\s+");
  const regex = new RegExp(`(^|[^A-Za-z0-9])(${pattern})(?=[^A-Za-z0-9]|$)`, "g");
  return text.replace(regex, `$1${normalized}`);
}

const NAME_UPPERCASE_EXCLUSIONS = new Set([
  "RBI",
  "RISP",
  "OPS",
  "ERA",
  "WHIP",
  "BABIP",
  "HBP",
  "LOB",
  "AB",
  "BB",
  "SO",
  "IP",
  "HR",
  "SB",
  "CS",
  "DP",
  "TP",
  "K",
  "KKFK",
]);

const NAME_ACTION_HINT_PATTERN =
  /^(struck|grounded|flied|lined|popped|fouled|walked|singled|doubled|tripled|homered|reached|advanced|stole|to|pinch|out)\b/i;

function normalizeUppercaseSurnameContext(text: string): string {
  return text.replace(/\b([A-Z][A-Z'.-]{3,})\b/g, (full, word: string, offset: number, source: string) => {
    if (NAME_UPPERCASE_EXCLUSIONS.has(word)) {
      return word;
    }

    const before = source.slice(0, offset);
    const after = source.slice(offset + word.length).trimStart();
    const previousToken = before.match(/([A-Za-z.]+)\s*$/)?.[1]?.toLowerCase() ?? "";

    if (previousToken === "for" || previousToken === "to" || previousToken === "by") {
      return toTitleCasePersonName(word);
    }

    if (NAME_ACTION_HINT_PATTERN.test(after)) {
      return toTitleCasePersonName(word);
    }

    return word;
  });
}

function toTitleCasePersonName(value: string): string {
  return cleanText(value)
    .split(/\s+/)
    .map((token) => formatNameToken(token))
    .join(" ")
    .trim();
}

function formatNameToken(token: string): string {
  if (/^[A-Za-z]\.$/.test(token)) {
    return token.toUpperCase();
  }

  if (/^(jr|sr|ii|iii|iv|v)$/i.test(token)) {
    return token.toUpperCase();
  }

  const segments = token.split(/([-'`])/);
  return segments
    .map((segment) => {
      if (segment.length === 0 || /^[-'`]$/.test(segment)) {
        return segment;
      }

      const lower = segment.toLowerCase();
      if (lower.startsWith("mc") && lower.length > 2) {
        return `Mc${capitalize(lower.slice(2))}`;
      }

      return capitalize(lower);
    })
    .join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimToTweetLength(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const truncated = text.slice(0, Math.max(0, maxLength - 3)).trimEnd();
  return `${truncated}...`;
}

function clampTweetLength(input: number): number {
  if (!Number.isFinite(input)) {
    return 280;
  }

  return Math.max(20, Math.min(280, Math.floor(input)));
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value;
}

function ordinal(value: number): string {
  const mod10 = value % 10;
  const mod100 = value % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${value}st`;
  }
  if (mod10 === 2 && mod100 !== 12) {
    return `${value}nd`;
  }
  if (mod10 === 3 && mod100 !== 13) {
    return `${value}rd`;
  }

  return `${value}th`;
}

function normalizeSignatureValue(value: string | number | null): string {
  if (value === null) {
    return "";
  }

  return cleanText(String(value)).toLowerCase();
}

function digest(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 20);
}

function inferBattingSide(play: LivePlayEvent): "away" | "home" | null {
  if (play.half === "top") {
    return "away";
  }

  if (play.half === "bottom") {
    return "home";
  }

  return null;
}

function isSameHalfInning(a: LivePlayEvent, b: LivePlayEvent): boolean {
  return a.inning !== null && b.inning !== null && a.inning === b.inning && a.half !== null && a.half === b.half;
}

function estimateRunsScoredOnPlay(play: LivePlayEvent): number {
  if (play.isSubstitution) {
    return 0;
  }

  const text = cleanText(play.text);
  const scoredMentions = (text.match(/\bscored\b/gi) ?? []).length;
  const rbiFromDecision = parseRbiCount(play.scoringDecision);
  const rbiFromText = parseRbiCount(text);

  let runs = Math.max(scoredMentions, rbiFromDecision ?? 0, rbiFromText ?? 0);

  if (runs === 0 && /\bhomered\b|\bhome run\b/i.test(text)) {
    runs = 1;
  }

  return runs;
}

function parseRbiCount(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const text = cleanText(value);
  const explicit = text.match(/(\d+)\s*RBI/i);
  if (explicit) {
    return Number.parseInt(explicit[1], 10);
  }

  return /\bRBI\b/i.test(text) ? 1 : null;
}

function estimateOutsRecordedOnPlay(text: string): number {
  const normalized = cleanText(text);
  if (!normalized) {
    return 0;
  }

  if (/\btriple play\b/i.test(normalized)) {
    return 3;
  }

  if (/\bdouble play\b/i.test(normalized)) {
    return 2;
  }

  const outAtMentions =
    (normalized.match(/\bout at\b/gi) ?? []).length +
    (normalized.match(/\bout on the play\b/gi) ?? []).length;
  if (outAtMentions > 0) {
    return outAtMentions;
  }

  if (
    /\bstruck out\b|\blined out\b|\bgrounded out\b|\bflied out\b|\bfouled out\b|\bpopped out\b|\bout\b/i.test(
      normalized
    )
  ) {
    return 1;
  }

  return 0;
}

function isSubstitutionText(value: string): boolean {
  const text = cleanText(value);
  if (!text) {
    return false;
  }

  return (
    /\bpinch\s+(?:ran|runner|hit)\s+for\b/i.test(text) ||
    /\bto\s+(?:p|c|1b|2b|3b|ss|lf|cf|rf|dh|ph|pr)\s+for\b/i.test(text) ||
    /\bsub(?:stitution)?\b/i.test(text)
  );
}

function clampOuts(value: number): number {
  return Math.max(0, Math.min(3, Math.floor(value)));
}
