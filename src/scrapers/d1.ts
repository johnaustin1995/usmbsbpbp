import axios from "axios";
import { load } from "cheerio";
import type { Element } from "domhandler";
import he from "he";
import { runWithConcurrency } from "../utils/async";
import { TtlCache } from "../utils/cache";
import { cleanText, parseInteger } from "../utils/text";
import type {
  D1ConferenceDirectoryEntry,
  D1ConferenceMembership,
  D1Game,
  D1ScheduleOutcome,
  D1ScoresPayload,
  D1TeamDirectoryEntry,
  D1TeamScheduleGame,
  D1TeamSeasonData,
  D1TeamStatsTable,
  D1TeamStatsTableRow,
  D1TeamsDatabasePayload,
  TeamSnapshot,
} from "../types";

const D1_SCORES_ENDPOINT = "https://d1baseball.com/wp-content/plugins/integritive/dynamic-scores.php";
const D1_TEAMS_ENDPOINT = "https://d1baseball.com/teams/";
const CACHE_TTL_MS = 15_000;

const BASE_BROWSER_HEADERS = {
  Origin: "https://d1baseball.com",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};
const SCORES_HEADERS = { ...BASE_BROWSER_HEADERS, Referer: "https://d1baseball.com/scores/" };
const TEAMS_HEADERS = { ...BASE_BROWSER_HEADERS, Referer: D1_TEAMS_ENDPOINT };

const cache = new TtlCache<string, D1ScoresPayload>();

interface D1RawResponse {
  content?: {
    "d1-scores"?: string;
  };
}

export async function getD1Scores(date: string): Promise<D1ScoresPayload> {
  const cached = cache.get(date);
  if (cached) {
    return cached;
  }

  const response = await axios.get<D1RawResponse>(D1_SCORES_ENDPOINT, {
    params: { date, v: d1CacheBustMinute() },
    headers: SCORES_HEADERS,
    timeout: 20_000,
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status >= 400) {
    throw new Error(`D1 request failed (${response.status})`);
  }

  const html = response.data?.content?.["d1-scores"];
  if (!html) {
    throw new Error("D1 response did not include score HTML.");
  }

  const parsed = parseD1ScoreHtml(html, date);
  cache.set(date, parsed, CACHE_TTL_MS);
  return parsed;
}

function d1CacheBustMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60;
}

export function parseD1ScoreHtml(rawHtml: string, date: string): D1ScoresPayload {
  const decodedHtml = he.decode(rawHtml);
  const $ = load(decodedHtml);

  const sourceUpdatedAt = cleanText($("#d1-scores-update").attr("data-date")) || null;
  const byKey = new Map<string, D1Game>();

  $(".score-set").each((_, scoreSet) => {
    const section = $(scoreSet);
    const conferenceId = cleanText(section.attr("data-conference")) || "unknown";
    const conferenceName =
      cleanText(section.find(".conference-header h3").first().text()) || conferenceId;

    section.find(".d1-score-tile").each((__, tileNode) => {
      const tile = $(tileNode);
      const key = cleanText(tile.attr("data-key")) || `${conferenceId}-${__}`;

      const statusText = cleanText(tile.find(".status-wrapper h5").first().text());
      const matchupTimeEpoch = parseInteger(tile.attr("data-matchup-time"));
      const matchupTimeIso =
        matchupTimeEpoch !== null ? new Date(matchupTimeEpoch * 1000).toISOString() : null;

      const links = tile
        .find(".box-score-links a")
        .map((linkIndex, linkNode) => {
          const link = $(linkNode);
          return {
            label: cleanText(link.text()) || `Link ${linkIndex + 1}`,
            url: cleanText(link.attr("href")),
          };
        })
        .get()
        .filter((entry) => entry.url.length > 0);

      const liveStatsLink = links.find((entry) => /live\s*stats/i.test(entry.label)) ?? null;
      const statbroadcast = extractStatBroadcastInfo(liveStatsLink?.url ?? null);

      const teams = tile.find(".team").toArray();
      const roadTeam = parseTeam($, teams[0]);
      const homeTeam = parseTeam($, teams[1]);

      const game: D1Game = {
        key,
        conferenceIds: [conferenceId],
        conferenceNames: [conferenceName],
        statusText,
        matchupTimeEpoch,
        matchupTimeIso,
        inProgress: tile.attr("data-in-progress") === "1",
        isOver: tile.attr("data-is-over") === "1",
        location: cleanText(tile.find(".matchup-commentary").first().text()) || null,
        roadTeam,
        homeTeam,
        links,
        liveStatsUrl: liveStatsLink?.url ?? null,
        statbroadcastId: statbroadcast?.id ?? null,
        statbroadcastQuery: statbroadcast?.query ?? {},
      };

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, game);
        return;
      }

      if (!existing.conferenceIds.includes(conferenceId)) {
        existing.conferenceIds.push(conferenceId);
      }
      if (!existing.conferenceNames.includes(conferenceName)) {
        existing.conferenceNames.push(conferenceName);
      }
    });
  });

  const games = Array.from(byKey.values()).sort((a, b) => {
    const aEpoch = a.matchupTimeEpoch ?? Number.MAX_SAFE_INTEGER;
    const bEpoch = b.matchupTimeEpoch ?? Number.MAX_SAFE_INTEGER;
    if (aEpoch !== bEpoch) {
      return aEpoch - bEpoch;
    }

    return a.key.localeCompare(b.key);
  });

  return {
    date,
    sourceUpdatedAt,
    games,
  };
}

export interface GetD1TeamsDatabaseOptions {
  season?: string | number | null;
  includeSchedule?: boolean;
  includeStats?: boolean;
  concurrency?: number;
  conferenceConcurrency?: number;
  teamLimit?: number | null;
}

interface ParsedD1TeamsDirectory {
  season: string | null;
  conferences: D1ConferenceDirectoryEntry[];
  teams: D1TeamDirectoryEntry[];
}

interface ParsedD1TeamSchedule {
  teamName: string | null;
  logoUrl: string | null;
  games: D1TeamScheduleGame[];
}

interface ParsedD1TeamStats {
  teamName: string | null;
  logoUrl: string | null;
  tables: D1TeamStatsTable[];
}

interface ConferenceMembershipResult {
  byTeamSlug: Map<string, D1ConferenceDirectoryEntry>;
  errors: string[];
}

export async function getD1TeamsDatabase(
  options: GetD1TeamsDatabaseOptions = {}
): Promise<D1TeamsDatabasePayload> {
  const includeSchedule = options.includeSchedule ?? true;
  const includeStats = options.includeStats ?? true;
  const teamConcurrency = clampPositiveInt(options.concurrency, 8);
  const conferenceConcurrency = clampPositiveInt(options.conferenceConcurrency, 4);

  const indexHtml = await fetchD1Html(D1_TEAMS_ENDPOINT);
  const directory = parseD1TeamsDirectoryHtml(indexHtml);

  const season = resolveRequestedSeason(directory.season, options.season);
  const conferences = directory.conferences.map((conference) => ({
    ...conference,
    url:
      season && conference.slug
        ? toSeasonUrl(toCanonicalBaseUrl(conference.url, "conference", conference.slug), season)
        : conference.url,
  }));

  const membership = await mapConferenceMemberships(conferences, conferenceConcurrency);

  const teamLimit =
    options.teamLimit && Number.isFinite(options.teamLimit)
      ? Math.max(1, Math.floor(options.teamLimit))
      : null;
  const teamsToScrape = teamLimit ? directory.teams.slice(0, teamLimit) : directory.teams;

  const teams = await runWithConcurrency(teamsToScrape, teamConcurrency, async (directoryEntry) => {
    const teamUrl = season ? toSeasonUrl(directoryEntry.baseUrl, season) : directoryEntry.url;
    const scheduleUrl = toAbsoluteUrl("schedule/", teamUrl) ?? `${teamUrl}schedule/`;
    const statsUrl = toAbsoluteUrl("stats/", teamUrl) ?? `${teamUrl}stats/`;

    const conference = directoryEntry.slug
      ? membership.byTeamSlug.get(directoryEntry.slug.toLowerCase()) ?? null
      : null;

    const errors: string[] = [];
    let resolvedName = directoryEntry.name;
    let logoUrl: string | null = null;
    let schedule: D1TeamScheduleGame[] = [];
    let statsTables: D1TeamStatsTable[] = [];

    const schedulePromise = includeSchedule
      ? fetchD1Html(scheduleUrl)
          .then((html) => parseD1TeamScheduleHtml(html))
          .catch((error: unknown) => {
            errors.push(`Schedule scrape failed: ${errorToMessage(error)}`);
            return null;
          })
      : Promise.resolve(null);

    const statsPromise = includeStats
      ? fetchD1Html(statsUrl)
          .then((html) => parseD1TeamStatsHtml(html))
          .catch((error: unknown) => {
            errors.push(`Stats scrape failed: ${errorToMessage(error)}`);
            return null;
          })
      : Promise.resolve(null);

    const [scheduleData, statsData] = await Promise.all([schedulePromise, statsPromise]);

    if (scheduleData) {
      schedule = scheduleData.games;
      resolvedName = scheduleData.teamName ?? resolvedName;
      logoUrl = scheduleData.logoUrl ?? logoUrl;
    }

    if (statsData) {
      statsTables = statsData.tables;
      resolvedName = statsData.teamName ?? resolvedName;
      logoUrl = statsData.logoUrl ?? logoUrl;
    }

    return {
      id: directoryEntry.id,
      name: resolvedName,
      slug: directoryEntry.slug,
      season,
      conference,
      logoUrl,
      teamUrl,
      scheduleUrl,
      statsUrl,
      schedule,
      statsTables,
      errors,
    } satisfies D1TeamSeasonData;
  });

  return {
    fetchedAt: new Date().toISOString(),
    sourceUrl: D1_TEAMS_ENDPOINT,
    season,
    conferences,
    teams,
    errors: membership.errors,
  };
}

export function parseD1TeamsDirectoryHtml(rawHtml: string): ParsedD1TeamsDirectory {
  const $ = load(he.decode(rawHtml));

  const conferences: D1ConferenceDirectoryEntry[] = [];
  $("select[name='conference'] option").each((_, node) => {
    const option = $(node);
    const value = cleanText(option.attr("value"));
    const name = cleanText(option.text());
    const target = toAbsoluteUrl(option.attr("data-target"), D1_TEAMS_ENDPOINT);
    if (!target || value.toLowerCase() === "select" || !name) {
      return;
    }

    conferences.push({
      id: parseInteger(value),
      name,
      slug: extractSlug(target, "conference"),
      url: target,
    });
  });

  const teams: D1TeamDirectoryEntry[] = [];
  $("select[name='team'] option").each((_, node) => {
    const option = $(node);
    const value = cleanText(option.attr("value"));
    const name = cleanText(option.text());
    const target = toAbsoluteUrl(option.attr("data-target"), D1_TEAMS_ENDPOINT);
    if (!target || value.toLowerCase() === "select" || !name) {
      return;
    }

    const slug = extractSlug(target, "team");
    teams.push({
      id: parseInteger(value),
      name,
      slug,
      url: target,
      baseUrl: slug ? toCanonicalBaseUrl(target, "team", slug) : target,
    });
  });

  const season = detectSeason(teams.map((team) => team.url)) ?? detectSeason(conferences.map((c) => c.url));

  return {
    season,
    conferences,
    teams,
  };
}

export function parseD1ConferencePageHtml(rawHtml: string): D1ConferenceMembership[] {
  const $ = load(he.decode(rawHtml));
  const bySlug = new Map<string, D1ConferenceMembership>();

  $("#conference-standings .conference-standings-table tbody td.team a").each((_, node) => {
    const anchor = $(node);
    const url = toAbsoluteUrl(anchor.attr("href"), D1_TEAMS_ENDPOINT);
    if (!url) {
      return;
    }

    const slug = extractSlug(url, "team");
    const name = cleanText(anchor.text());
    if (!slug || !name || bySlug.has(slug)) {
      return;
    }

    bySlug.set(slug, {
      slug,
      name,
      url,
    });
  });

  return Array.from(bySlug.values());
}

export function parseD1TeamScheduleHtml(rawHtml: string): ParsedD1TeamSchedule {
  const $ = load(he.decode(rawHtml));
  const teamName = cleanText($("h1.single-team-title").first().text()) || null;
  const logoUrl = cleanText($("#team-header .team-logo img").first().attr("src")) || null;

  const table = $("table.full-team-schedule").first();
  if (table.length === 0) {
    return { teamName, logoUrl, games: [] };
  }

  const headers = table
    .find("thead th")
    .map((_, th) => cleanText($(th).text()))
    .get();
  const headerKeys = buildHeaderKeys(headers);

  const games: D1TeamScheduleGame[] = table
    .find("tbody tr")
    .map((_, rowNode) => {
      const row = $(rowNode);
      const cells = row.find("td").toArray();
      const cellValues = cells.map((cell) => {
        const value = cleanText($(cell).text());
        return value || null;
      });

      const columns: Record<string, string | null> = {};
      cellValues.forEach((value, index) => {
        const key = headerKeys[index] ?? `col_${index + 1}`;
        columns[key] = value;
      });

      const dateCell = cells[0] ? $(cells[0]) : null;
      const locationCell = cells[1] ? $(cells[1]) : null;
      const opponentCell = cells[2] ? $(cells[2]) : null;
      const resultCell = cells[3] ? $(cells[3]) : null;
      const notesCell = cells[5] ? $(cells[5]) : null;

      const rawOpponentUrl = toAbsoluteUrl(
        opponentCell?.find("a.team-logo-name").attr("href"),
        D1_TEAMS_ENDPOINT
      );
      const opponentSlug = rawOpponentUrl ? extractSlug(rawOpponentUrl, "team") : null;
      const opponentUrl =
        rawOpponentUrl && opponentSlug
          ? toCanonicalBaseUrl(rawOpponentUrl, "team", opponentSlug)
          : rawOpponentUrl;
      const resultText = cleanText(resultCell?.text() ?? "") || null;
      const outcome = parseScheduleOutcome(resultCell?.attr("class"), resultText);

      return {
        scheduleId: cleanText(row.attr("data-schedule-id")) || null,
        dateLabel: cleanText(dateCell?.text() ?? "") || null,
        dateUrl: toAbsoluteUrl(dateCell?.find("a").attr("href"), D1_TEAMS_ENDPOINT),
        locationType: cleanText(locationCell?.text() ?? "") || null,
        opponentName: cleanText(opponentCell?.find(".team-name").first().text()) || cleanText(opponentCell?.text() ?? "") || null,
        opponentSlug,
        opponentUrl,
        opponentLogoUrl: cleanText(opponentCell?.find("img.team-logo").attr("src")) || null,
        resultText,
        resultUrl: toAbsoluteUrl(resultCell?.find("a").attr("href"), D1_TEAMS_ENDPOINT),
        outcome,
        notes: cleanText(notesCell?.text() ?? "") || null,
        columns,
      } satisfies D1TeamScheduleGame;
    })
    .get();

  return {
    teamName,
    logoUrl,
    games,
  };
}

export function parseD1TeamStatsHtml(rawHtml: string): ParsedD1TeamStats {
  const $ = load(he.decode(rawHtml));
  const teamName = cleanText($("h1.single-team-title").first().text()) || null;
  const logoUrl = cleanText($("#team-header .team-logo img").first().attr("src")) || null;

  const tables: D1TeamStatsTable[] = [];
  $("#team-single-stats table").each((_, tableNode) => {
    const table = $(tableNode);
    const id = cleanText(table.attr("id")) || null;
    const group =
      cleanText(table.parents("section.data-table.full-size.all-rows").first().find("h3.stat-heading").first().text()) || null;
    const section = cleanText(table.closest("section[id]").attr("id")) || null;
    const headers = table
      .find("thead th")
      .map((__, th) => cleanText($(th).text()))
      .get();
    const headerKeys = buildHeaderKeys(headers);

    const rows: D1TeamStatsTableRow[] = table
      .find("tbody tr")
      .map((__, rowNode) => {
        const row = $(rowNode);
        const cells = row
          .find("td")
          .map((___, td) => {
            const value = cleanText($(td).text());
            return value || null;
          })
          .get();

        const values: Record<string, string | null> = {};
        cells.forEach((cellValue, index) => {
          const key = headerKeys[index] ?? `col_${index + 1}`;
          values[key] = cellValue;
        });

        return {
          cells,
          values,
        } satisfies D1TeamStatsTableRow;
      })
      .get();

    tables.push({
      id,
      group,
      section,
      headers,
      rows,
    });
  });

  return {
    teamName,
    logoUrl,
    tables,
  };
}

async function mapConferenceMemberships(
  conferences: D1ConferenceDirectoryEntry[],
  concurrency: number
): Promise<ConferenceMembershipResult> {
  const byTeamSlug = new Map<string, D1ConferenceDirectoryEntry>();
  const errors: string[] = [];

  await runWithConcurrency(conferences, concurrency, async (conference) => {
    try {
      const html = await fetchD1Html(conference.url);
      const memberships = parseD1ConferencePageHtml(html);
      if (memberships.length === 0) {
        errors.push(`No teams found while scraping conference standings: ${conference.name}`);
        return;
      }

      memberships.forEach((membership) => {
        const existing = byTeamSlug.get(membership.slug);
        if (existing && existing.id !== conference.id) {
          errors.push(
            `Team "${membership.name}" mapped to multiple conferences (${existing.name}, ${conference.name}).`
          );
          return;
        }

        byTeamSlug.set(membership.slug, conference);
      });
    } catch (error) {
      errors.push(`Conference scrape failed for "${conference.name}": ${errorToMessage(error)}`);
    }
  });

  return { byTeamSlug, errors };
}

async function fetchD1Html(url: string): Promise<string> {
  const response = await axios.get<string>(url, {
    headers: TEAMS_HEADERS,
    timeout: 30_000,
    responseType: "text",
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status >= 400) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.data;
}

function parseScheduleOutcome(className: string | undefined, resultText: string | null): D1ScheduleOutcome {
  const classes = cleanText(className ?? "").toLowerCase();
  if (/\bwin\b/.test(classes) || /^w\b/i.test(resultText ?? "")) {
    return "win";
  }
  if (/\blose\b/.test(classes) || /\bloss\b/.test(classes) || /^l\b/i.test(resultText ?? "")) {
    return "loss";
  }

  return "unknown";
}

function buildHeaderKeys(headers: string[]): string[] {
  const keyCounts = new Map<string, number>();
  return headers.map((header, index) => {
    const normalized = normalizeHeaderKey(header) || `col_${index + 1}`;
    const seen = keyCounts.get(normalized) ?? 0;
    keyCounts.set(normalized, seen + 1);
    return seen === 0 ? normalized : `${normalized}_${seen + 1}`;
  });
}

function normalizeHeaderKey(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toAbsoluteUrl(href: string | null | undefined, base: string): string | null {
  const value = cleanText(href);
  if (!value) {
    return null;
  }

  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function toCanonicalBaseUrl(urlString: string, type: "team" | "conference", slug: string): string {
  const parsed = new URL(urlString, D1_TEAMS_ENDPOINT);
  return `${parsed.origin}/${type}/${slug}/`;
}

function extractSlug(urlString: string, type: "team" | "conference"): string | null {
  try {
    const parsed = new URL(urlString, D1_TEAMS_ENDPOINT);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const markerIndex = segments.indexOf(type);
    if (markerIndex < 0) {
      return null;
    }

    const slug = cleanText(segments[markerIndex + 1]).toLowerCase();
    return slug || null;
  } catch {
    return null;
  }
}

function detectSeason(urls: string[]): string | null {
  for (const url of urls) {
    try {
      const parsed = new URL(url, D1_TEAMS_ENDPOINT);
      const segments = parsed.pathname.split("/").filter(Boolean);
      for (let index = 0; index < segments.length; index += 1) {
        if (/^\d{4}$/.test(segments[index])) {
          return segments[index];
        }
      }
    } catch {
      // noop
    }
  }

  return null;
}

function toSeasonUrl(baseUrl: string, season: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${season}/`, normalizedBase).toString();
}

function resolveRequestedSeason(
  discoveredSeason: string | null,
  requestedSeason: string | number | null | undefined
): string | null {
  if (requestedSeason === null || requestedSeason === undefined) {
    return discoveredSeason;
  }

  const normalized = cleanText(String(requestedSeason));
  return normalized || discoveredSeason;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTeam($: ReturnType<typeof load>, node: Element | undefined): TeamSnapshot {
  if (!node) {
    return {
      id: null,
      name: "",
      rank: null,
      score: null,
      logoUrl: null,
      teamUrl: null,
      searchTokens: [],
    };
  }

  const team = $(node);
  const rank = parseInteger(team.find(".team-rank").first().text());

  const titleNode = team.find(".team-title h5").first().clone();
  titleNode.find(".team-rank").remove();

  const searchRaw = cleanText(team.attr("data-search"));

  return {
    id: parseInteger(team.attr("data-team-id")),
    name: cleanText(titleNode.text()),
    rank,
    score: parseInteger(team.find(".score-meta.score-runs").first().text()),
    logoUrl: cleanText(team.find(".team-logo img").first().attr("src")) || null,
    teamUrl: cleanText(team.find(".team-title").first().attr("href")) || null,
    searchTokens: searchRaw.length > 0 ? searchRaw.split(" ") : [],
  };
}

function extractStatBroadcastInfo(
  urlString: string | null
): { id: number; query: Record<string, string> } | null {
  if (!urlString) {
    return null;
  }

  try {
    const parsed = new URL(urlString);
    if (!/stats\.statbroadcast\.com$/i.test(parsed.hostname)) {
      return null;
    }

    if (!parsed.pathname.includes("/broadcast/")) {
      return null;
    }

    const idValue = parsed.searchParams.get("id");
    const id = idValue ? Number.parseInt(idValue, 10) : Number.NaN;
    if (!Number.isFinite(id)) {
      return null;
    }

    const query: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      if (key !== "id") {
        query[key] = value;
      }
    });

    return { id, query };
  } catch {
    return null;
  }
}
