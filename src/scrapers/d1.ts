import axios from "axios";
import { execFile } from "child_process";
import { load } from "cheerio";
import type { Element } from "domhandler";
import { mkdtemp, rm } from "fs/promises";
import he from "he";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { runWithConcurrency } from "../utils/async";
import { TtlCache } from "../utils/cache";
import { cleanText, parseInteger } from "../utils/text";
import type {
  D1ConferenceDirectoryEntry,
  D1ConferenceMembership,
  D1Game,
  D1RankedTeam,
  D1RankingsPayload,
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
const D1_SCORES_PAGE = "https://d1baseball.com/scores/";
const D1_DYNAMIC_CONTENT_ENDPOINT = "https://d1baseball.com/wp-json/d1/v1/dynamic-content/";
const D1_RANKINGS_ENDPOINT = "https://d1baseball.com/rankings/";
const D1_TEAMS_ENDPOINT = "https://d1baseball.com/teams/";
const CACHE_TTL_MS = 15_000;
const TEAM_SCHEDULE_CACHE_TTL_MS = 60_000;
const DIRECTORY_LOOKUP_CACHE_TTL_MS = 15 * 60_000;
const RANKINGS_CACHE_TTL_MS = 15 * 60_000;
const TEAM_SCHEDULE_DYNAMIC_KEY = "dynamic-team-schedule";
const TEAM_SCHEDULE_CALLBACK = "team_schedule";
const TEAM_SCHEDULE_ARG_KEY = "team_id_643";

const BASE_BROWSER_HEADERS = {
  Origin: "https://d1baseball.com",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};
const SCORES_HEADERS = {
  ...BASE_BROWSER_HEADERS,
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: D1_SCORES_PAGE,
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "X-Requested-With": "XMLHttpRequest",
};
const SCORES_PAGE_HEADERS = {
  ...BASE_BROWSER_HEADERS,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: D1_SCORES_PAGE,
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};
const TEAM_SCHEDULE_DYNAMIC_HEADERS = {
  ...BASE_BROWSER_HEADERS,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/json",
};
const TEAMS_HEADERS = { ...BASE_BROWSER_HEADERS, Referer: D1_TEAMS_ENDPOINT };

const cache = new TtlCache<string, D1ScoresPayload>();
const rankingsCache = new TtlCache<string, D1RankingsPayload>();
const teamScheduleScoresCache = new TtlCache<string, D1ScoresPayload>();
const directoryLookupCache = new TtlCache<string, D1TeamSeasonData[]>();
const execFileAsync = promisify(execFile);

interface D1RawResponse {
  content?: {
    "d1-scores"?: string;
  };
}

interface D1TeamLookup {
  byId: Map<number, D1TeamSeasonData>;
  bySlug: Map<string, D1TeamSeasonData>;
  byName: Map<string, D1TeamSeasonData>;
}

interface ScheduleTileScore {
  outcome: "W" | "L" | "T";
  currentScore: number;
  opponentScore: number;
}

export async function getD1Scores(date: string): Promise<D1ScoresPayload> {
  const cached = cache.get(date);
  if (cached) {
    return cached;
  }

  const html = await fetchD1ScoreHtml(date);
  const parsed = parseD1ScoreHtml(html, date);
  cache.set(date, parsed, CACHE_TTL_MS);
  return parsed;
}

export async function getD1Rankings(): Promise<D1RankingsPayload> {
  const cacheKey = "current";
  const cached = rankingsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const html = await fetchD1Html(D1_RANKINGS_ENDPOINT);
  const parsed = parseD1RankingsHtml(html);
  rankingsCache.set(cacheKey, parsed, RANKINGS_CACHE_TTL_MS);
  return parsed;
}

export async function getD1ScoresFromTeamsPayload(
  teamsPayload: D1TeamsDatabasePayload,
  date: string
): Promise<D1ScoresPayload> {
  const cacheKey = `${teamsPayload.fetchedAt}:${date}`;
  const cached = teamScheduleScoresCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const candidateTeams = teamsPayload.teams.filter((team) => team.id !== null && hasGameOnDate(team, date));
  return buildScoresFromScheduleTeams(candidateTeams, date, cacheKey);
}

export async function getD1ScoresFromTeamDirectory(date: string): Promise<D1ScoresPayload> {
  const cacheKey = `directory:${date}`;
  const cached = teamScheduleScoresCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const teams = await getScheduleLookupTeamsFromDirectory(date);
  const candidateTeams = teams.filter((team) => team.id !== null);
  return buildScoresFromScheduleTeams(candidateTeams, date, cacheKey);
}

function d1CacheBustMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60;
}

async function fetchD1ScoreHtml(date: string): Promise<string> {
  const cacheBustMinute = d1CacheBustMinute();
  let lastError: unknown = null;

  try {
    return await fetchD1ScoreHtmlWithAxios(date, cacheBustMinute);
  } catch (error) {
    lastError = error;
  }

  try {
    await warmD1ScoresPage(date);
    return await fetchD1ScoreHtmlWithAxios(date, cacheBustMinute);
  } catch (error) {
    lastError = error;
  }

  try {
    return await fetchD1ScoreHtmlWithCurl(date, cacheBustMinute);
  } catch (error) {
    if (!(error instanceof Error && error.message === "curl is not installed.") || lastError === null) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to load D1 scores.");
}

async function fetchD1ScoreHtmlWithAxios(date: string, cacheBustMinute: number): Promise<string> {
  const response = await axios.get<string>(D1_SCORES_ENDPOINT, {
    params: { date, v: cacheBustMinute },
    headers: buildScoresHeaders(date),
    timeout: 20_000,
    responseType: "text",
    transformResponse: [(value) => value],
    validateStatus: (status) => status >= 200 && status < 500,
  });

  return extractScoreHtmlFromResponse(response.status, String(response.data ?? ""));
}

async function fetchD1ScoreHtmlWithCurl(date: string, cacheBustMinute: number): Promise<string> {
  const url = new URL(D1_SCORES_ENDPOINT);
  url.searchParams.set("date", date);
  url.searchParams.set("v", String(cacheBustMinute));
  try {
    const tempDir = await mkdtemp(join(tmpdir(), "d1-scores-"));
    const cookieJar = join(tempDir, "cookies.txt");

    try {
      const warmUrl = new URL(D1_SCORES_PAGE);
      warmUrl.searchParams.set("date", date);
      await curlRequest(warmUrl.toString(), buildScoresPageHeaders(date), cookieJar);

      const { status, body } = await curlRequest(url.toString(), buildScoresHeaders(date), cookieJar);
      return extractScoreHtmlFromResponse(status, body);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      throw new Error("curl is not installed.");
    }

    throw error;
  }
}

async function warmD1ScoresPage(date: string): Promise<void> {
  await axios.get<string>(D1_SCORES_PAGE, {
    params: { date },
    headers: buildScoresPageHeaders(date),
    timeout: 20_000,
    responseType: "text",
    transformResponse: [(value) => value],
    validateStatus: (status) => status >= 200 && status < 500,
  });
}

async function curlRequest(
  url: string,
  headers: Record<string, string>,
  cookieJar: string
): Promise<{ status: number; body: string }> {
  const statusMarker = "__CURL_HTTP_STATUS__:";
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--max-time",
    "20",
    "--cookie-jar",
    cookieJar,
    "--cookie",
    cookieJar,
    "--write-out",
    `\n${statusMarker}%{http_code}`,
    "--output",
    "-",
  ];

  for (const [name, value] of Object.entries(headers)) {
    args.push("--header", `${name}: ${value}`);
  }
  args.push(url);

  let stdout = "";
  try {
    const result = await execFileAsync("curl", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 25_000,
    });
    stdout = result.stdout;
  } catch (error) {
    const fallbackStdout =
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout?: string }).stdout ?? "")
        : "";
    if (!fallbackStdout) {
      throw new Error(`curl fallback failed: ${errorToMessage(error)}`);
    }
    stdout = fallbackStdout;
  }

  const markerIndex = stdout.lastIndexOf(statusMarker);
  if (markerIndex < 0) {
    throw new Error("curl fallback returned an invalid response.");
  }

  const body = stdout.slice(0, markerIndex);
  const statusText = stdout.slice(markerIndex + statusMarker.length).trim();
  const status = Number.parseInt(statusText, 10);
  if (!Number.isFinite(status)) {
    throw new Error("curl fallback returned an invalid status.");
  }

  return { status, body };
}

async function buildScoresFromScheduleTeams(
  teams: D1TeamSeasonData[],
  date: string,
  cacheKey: string
): Promise<D1ScoresPayload> {
  const lookup = buildTeamLookup(teams);

  const parsedByTeam = await runWithConcurrency(teams, 10, async (team) => {
    try {
      const html = await fetchDynamicTeamScheduleHtml(team);
      if (!html.includes(`date=${date}`)) {
        return [] as D1Game[];
      }

      if (team.schedule.length === 0) {
        try {
          const scheduleHtml = await fetchD1Html(team.scheduleUrl);
          const scheduleData = parseD1TeamScheduleHtml(scheduleHtml);
          team.schedule = scheduleData.games;
          team.logoUrl = team.logoUrl ?? scheduleData.logoUrl ?? null;
        } catch {
          // Keep the dynamic-only fallback if the full schedule page cannot be fetched.
        }
      }

      return parseD1TeamScheduleScoresHtmlWithLookup(html, team, date, lookup);
    } catch {
      return [] as D1Game[];
    }
  });

  const byKey = new Map<string, D1Game>();
  for (const games of parsedByTeam) {
    for (const game of games) {
      const existing = byKey.get(game.key);
      if (!existing) {
        byKey.set(game.key, game);
        continue;
      }

      mergeScheduleDerivedGame(existing, game);
    }
  }

  const payload: D1ScoresPayload = {
    date,
    sourceUpdatedAt: new Date().toISOString(),
    games: Array.from(byKey.values()).sort(compareScheduleDerivedGames),
  };
  teamScheduleScoresCache.set(cacheKey, payload, TEAM_SCHEDULE_CACHE_TTL_MS);
  return payload;
}

function buildScoresHeaders(date: string): Record<string, string> {
  return {
    ...SCORES_HEADERS,
    Referer: `${D1_SCORES_PAGE}?date=${date}`,
  };
}

function buildScoresPageHeaders(date: string): Record<string, string> {
  return {
    ...SCORES_PAGE_HEADERS,
    Referer: `${D1_SCORES_PAGE}?date=${date}`,
  };
}

function extractScoreHtmlFromResponse(status: number, rawBody: string): string {
  if (status >= 400) {
    if (isCloudflareChallenge(rawBody)) {
      throw new Error(`D1 request blocked by Cloudflare (${status})`);
    }
    throw new Error(`D1 request failed (${status})`);
  }

  const parsed = parseD1ScoresResponseBody(rawBody);
  const html = parsed.content?.["d1-scores"];
  if (!html) {
    throw new Error("D1 response did not include score HTML.");
  }

  return html;
}

function parseD1ScoresResponseBody(rawBody: string): D1RawResponse {
  const body = rawBody.trim();
  if (!body) {
    throw new Error("D1 returned an empty response.");
  }

  if (isCloudflareChallenge(body)) {
    throw new Error("D1 request blocked by Cloudflare.");
  }

  try {
    const parsed = JSON.parse(body) as D1RawResponse;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("D1 returned an invalid JSON response.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && /Cloudflare|invalid JSON/i.test(error.message)) {
      throw error;
    }
    throw new Error("D1 returned a non-JSON response.");
  }
}

function isCloudflareChallenge(body: string): boolean {
  return /cf-mitigated|challenge-platform|Just a moment|Enable JavaScript and cookies to continue/i.test(
    body
  );
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
      const rawKey = cleanText(tile.attr("data-key"));
      const key = rawKey || `${conferenceId}-${__}`;

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
      const hasScoreData =
        rawKey.length > 0 ||
        statusText.length > 0 ||
        links.length > 0 ||
        roadTeam.name.length > 0 ||
        homeTeam.name.length > 0;
      if (!hasScoreData) {
        return;
      }

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

export function parseD1RankingsHtml(rawHtml: string): D1RankingsPayload {
  const decodedHtml = he.decode(rawHtml);
  const $ = load(decodedHtml);
  const table = $("table.standings.rankings").first();

  if (table.length === 0) {
    throw new Error("D1 rankings page did not include a rankings table.");
  }

  const updatedText = cleanText(table.closest(".avia_codeblock").find(".updated").first().text());
  const sourceUpdatedAt =
    cleanText(updatedText.replace(/^Updated\s+/i, "").split("|")[0] ?? "") || null;

  const teams: D1RankedTeam[] = [];
  table.find("tbody tr").each((_, rowNode) => {
    const row = $(rowNode);
    const cells = row.find("td");
    const rank = parseInteger(cells.first().text());
    const teamCell = cells.eq(1);
    const teamLink = teamCell.find("a").first();
    const name = cleanText(teamLink.text());
    const teamUrl = toAbsoluteUrl(teamLink.attr("href"), D1_RANKINGS_ENDPOINT);
    const slug = teamUrl ? extractSlug(teamUrl, "team") : null;
    const logoUrl = cleanText(teamCell.find("img.team-logo").first().attr("src")) || null;

    if (rank === null || !name) {
      return;
    }

    teams.push({
      rank,
      name,
      slug,
      logoUrl,
      teamUrl,
    });
  });

  if (teams.length === 0) {
    throw new Error("D1 rankings page did not include ranked teams.");
  }

  return {
    sourceUpdatedAt,
    teams,
  };
}

export function parseD1TeamScheduleScoresHtml(
  rawHtml: string,
  team: D1TeamSeasonData,
  date: string,
  allTeams: D1TeamSeasonData[] = [team]
): D1Game[] {
  const lookup = buildTeamLookup(allTeams);
  return parseD1TeamScheduleScoresHtmlWithLookup(rawHtml, team, date, lookup);
}

function parseD1TeamScheduleScoresHtmlWithLookup(
  rawHtml: string,
  team: D1TeamSeasonData,
  date: string,
  lookup: D1TeamLookup
): D1Game[] {
  const decodedHtml = he.decode(rawHtml);
  const $ = load(decodedHtml);
  const games: D1Game[] = [];

  $(".d1-team-schedule-tile").each((index, tileNode) => {
    const tile = $(tileNode);
    const dateHref = cleanText(tile.find(".team-score a").first().attr("href"));
    const tileDate = extractDateFromScoresHref(dateHref);
    const result = parseScheduleTileScore(tile.find(".box-score-header h5").first().text());

    if (tileDate !== date) {
      return;
    }

    const homeName = decodeScheduleName(tile.attr("data-home-name"));
    const roadName = decodeScheduleName(tile.attr("data-road-name"));
    if (!homeName || !roadName) {
      return;
    }

    const currentSide = resolveCurrentTeamSide(team, homeName, roadName);
    if (!currentSide) {
      return;
    }

    const opponentNode = tile.find(".team").first().get(0);
    const opponentParsed = parseTeam($, opponentNode);
    const opponentName = currentSide === "home" ? roadName : homeName;
    const opponent = findOpponentTeam(lookup, opponentParsed, opponentName);
    const derivedScore = deriveTileScores(currentSide, result);
    const liveStatsLink = extractTeamScheduleLiveStatsUrl(tile);
    const timeLabel = cleanText(tile.find(".team-score a").first().text());
    const rawStatusText = cleanText(tile.find(".box-score-header h5").first().text());
    const scheduledTimeText = extractScheduledTimeLabel(timeLabel);
    const currentTeamRecord = computeOverallRecordBeforeDate(team.schedule, date);
    const currentScheduleGame = findScheduleGameForDate(team.schedule, date, opponentName);
    const scheduleStatusOverride = extractScheduleStatusOverride(currentScheduleGame);
    const inferredInProgress = inferScheduleTileInProgress(tile, rawStatusText, derivedScore.isOver);

    const key =
      cleanText(tile.attr("data-matchup")).length > 0
        ? `schedule-${cleanText(tile.attr("data-matchup"))}`
        : `${date}:${normalizeTeamKey(roadName)}:${normalizeTeamKey(homeName)}:${normalizeTeamKey(
            timeLabel || cleanText(tile.find(".box-score-footer p").first().text()) || String(index)
          )}`;

    const homeTeam = currentSide === "home"
      ? buildCurrentTeamSnapshot(team, homeName, derivedScore.homeScore, currentTeamRecord)
      : buildOpponentTeamSnapshot(opponentParsed, opponent, homeName, derivedScore.homeScore, date);
    const roadTeam = currentSide === "road"
      ? buildCurrentTeamSnapshot(team, roadName, derivedScore.roadScore, currentTeamRecord)
      : buildOpponentTeamSnapshot(opponentParsed, opponent, roadName, derivedScore.roadScore, date);

    const conferenceIds = uniqueStrings([
      team.conference?.slug ?? null,
      team.conference?.id !== null && team.conference?.id !== undefined
        ? String(team.conference.id)
        : null,
      opponent?.conference?.slug ?? null,
      opponent?.conference?.id !== null && opponent?.conference?.id !== undefined
        ? String(opponent.conference.id)
        : null,
    ]);
    const conferenceNames = uniqueStrings([
      team.conference?.name ?? null,
      opponent?.conference?.name ?? null,
    ]);

    const statusText = derivedScore.isOver
      ? "Final"
      : inferredInProgress && isScoreOnlyScheduleStatus(rawStatusText)
        ? rawStatusText
        : normalizeScheduleTileStatus(rawStatusText, scheduledTimeText, scheduleStatusOverride);

    games.push({
      key,
      conferenceIds,
      conferenceNames,
      statusText,
      matchupTimeEpoch: null,
      matchupTimeIso: null,
      inProgress: inferredInProgress,
      isOver: derivedScore.isOver,
      location: cleanText(tile.find(".box-score-footer p").first().text()) || null,
      roadTeam,
      homeTeam,
      links: tile
        .find(".box-score-links a")
        .map((linkIndex, linkNode) => {
          const link = $(linkNode);
          return {
            label: cleanText(link.text()) || `Link ${linkIndex + 1}`,
            url: cleanText(link.attr("href")),
          };
        })
        .get()
        .filter((entry) => entry.url.length > 0),
      liveStatsUrl: liveStatsLink?.url ?? null,
      statbroadcastId: liveStatsLink?.id ?? null,
      statbroadcastQuery: liveStatsLink?.query ?? {},
    });
  });

  return games;
}

async function fetchDynamicTeamScheduleHtml(team: D1TeamSeasonData): Promise<string> {
  if (team.id === null || team.id === undefined) {
    throw new Error(`Missing D1 team id for ${team.name}.`);
  }

  const response = await axios.post<{ content?: Record<string, string> }>(
    D1_DYNAMIC_CONTENT_ENDPOINT,
    {
      [TEAM_SCHEDULE_DYNAMIC_KEY]: {
        callback: TEAM_SCHEDULE_CALLBACK,
        args: {
          [TEAM_SCHEDULE_ARG_KEY]: String(team.id),
        },
      },
    },
    {
      timeout: 20_000,
      headers: {
        ...TEAM_SCHEDULE_DYNAMIC_HEADERS,
        Referer: team.teamUrl || `${D1_TEAMS_ENDPOINT}team/${team.slug ?? ""}/`,
      },
      validateStatus: (status) => status >= 200 && status < 500,
    }
  );

  if (response.status >= 400) {
    throw new Error(`D1 dynamic team schedule request failed (${response.status})`);
  }

  const html = cleanText(response.data?.content?.[TEAM_SCHEDULE_DYNAMIC_KEY] ?? "");
  if (!html) {
    throw new Error(`D1 dynamic team schedule did not include HTML for ${team.name}.`);
  }

  return html;
}

function buildTeamLookup(teams: D1TeamSeasonData[]): D1TeamLookup {
  const byId = new Map<number, D1TeamSeasonData>();
  const bySlug = new Map<string, D1TeamSeasonData>();
  const byName = new Map<string, D1TeamSeasonData>();

  for (const team of teams) {
    if (team.id !== null && team.id !== undefined) {
      byId.set(team.id, team);
    }

    const slug = cleanText(team.slug ?? "").toLowerCase();
    if (slug) {
      bySlug.set(slug, team);
    }

    const normalizedName = normalizeTeamKey(team.name);
    if (normalizedName) {
      byName.set(normalizedName, team);
    }
  }

  return { byId, bySlug, byName };
}

async function getScheduleLookupTeamsFromDirectory(date: string): Promise<D1TeamSeasonData[]> {
  const indexHtml = await fetchD1Html(D1_TEAMS_ENDPOINT);
  const directory = parseD1TeamsDirectoryHtml(indexHtml);
  const season = /^\d{8}$/.test(date) ? date.slice(0, 4) : directory.season;
  const cacheKey = season || "current";
  const cached = directoryLookupCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const conferences = directory.conferences.map((conference) => ({
    ...conference,
    url:
      season && conference.slug
        ? toSeasonUrl(toCanonicalBaseUrl(conference.url, "conference", conference.slug), season)
        : conference.url,
  }));
  const membership = await mapConferenceMemberships(conferences, 4);
  const teams = directory.teams.map((entry) =>
    toScheduleLookupTeam(
      entry,
      season,
      entry.slug ? membership.byTeamSlug.get(entry.slug.toLowerCase()) ?? null : null
    )
  );

  directoryLookupCache.set(cacheKey, teams, DIRECTORY_LOOKUP_CACHE_TTL_MS);
  return teams;
}

function toScheduleLookupTeam(
  entry: D1TeamDirectoryEntry,
  season: string | null,
  conference: D1ConferenceDirectoryEntry | null = null
): D1TeamSeasonData {
  const teamUrl = season ? toSeasonUrl(entry.baseUrl, season) : entry.url;
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    season,
    conference,
    logoUrl: null,
    teamUrl,
    scheduleUrl: toAbsoluteUrl("schedule/", teamUrl) ?? `${teamUrl}schedule/`,
    statsUrl: toAbsoluteUrl("stats/", teamUrl) ?? `${teamUrl}stats/`,
    schedule: [],
    statsTables: [],
    errors: [],
  };
}

function hasGameOnDate(team: D1TeamSeasonData, date: string): boolean {
  return team.schedule.some((game) => extractDateFromScoresHref(game.dateUrl) === date);
}

function resolveCurrentTeamSide(
  team: D1TeamSeasonData,
  homeName: string,
  roadName: string
): "home" | "road" | null {
  const teamName = normalizeTeamKey(team.name);
  if (teamName === normalizeTeamKey(homeName)) {
    return "home";
  }

  if (teamName === normalizeTeamKey(roadName)) {
    return "road";
  }

  const teamSlug = cleanText(team.slug ?? "").toLowerCase();
  if (teamSlug) {
    if (teamSlug === normalizeTeamKey(homeName).replace(/\s+/g, "")) {
      return "home";
    }
    if (teamSlug === normalizeTeamKey(roadName).replace(/\s+/g, "")) {
      return "road";
    }
  }

  return null;
}

function decodeScheduleName(value: string | undefined): string {
  const decoded = he.decode(value ?? "")
    .replace(/&#;/g, "&")
    .replace(/\s+/g, " ");
  return cleanText(decoded);
}

function normalizeTeamKey(value: string): string {
  return cleanText(he.decode(value))
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseScheduleTileScore(value: string): ScheduleTileScore | null {
  const clean = cleanText(value).replace(/\s+/g, " ");
  const match = clean.match(/^([WLT])\s*(\d+)\s*-\s*(\d+)$/i);
  if (!match) {
    return null;
  }

  return {
    outcome: match[1].toUpperCase() as "W" | "L" | "T",
    currentScore: Number.parseInt(match[2], 10),
    opponentScore: Number.parseInt(match[3], 10),
  };
}

function deriveTileScores(
  currentSide: "home" | "road",
  score: ScheduleTileScore | null
): { homeScore: number | null; roadScore: number | null; isOver: boolean } {
  if (!score) {
    return {
      homeScore: null,
      roadScore: null,
      isOver: false,
    };
  }

  if (currentSide === "home") {
    if (score.outcome === "T") {
      return {
        homeScore: score.currentScore,
        roadScore: score.opponentScore,
        isOver: true,
      };
    }

    return {
      homeScore: score.outcome === "W" ? score.currentScore : score.opponentScore,
      roadScore: score.outcome === "W" ? score.opponentScore : score.currentScore,
      isOver: true,
    };
  }

  if (score.outcome === "T") {
    return {
      homeScore: score.opponentScore,
      roadScore: score.currentScore,
      isOver: true,
    };
  }

  return {
    homeScore: score.outcome === "W" ? score.opponentScore : score.currentScore,
    roadScore: score.outcome === "W" ? score.currentScore : score.opponentScore,
    isOver: true,
  };
}

function normalizeScheduleTileStatus(
  rawStatusText: string,
  scheduledTimeText: string | null,
  scheduleStatusOverride: string | null
): string {
  if (scheduleStatusOverride) {
    return scheduleStatusOverride;
  }

  if (isScoreOnlyScheduleStatus(rawStatusText)) {
    return scheduledTimeText ?? "Scheduled";
  }

  if (rawStatusText.length === 0) {
    return scheduledTimeText ?? "Scheduled";
  }

  if (/^(scheduled|pregame)$/i.test(rawStatusText) && scheduledTimeText) {
    return scheduledTimeText;
  }

  return rawStatusText;
}

function isScheduleTileLive(rawStatusText: string): boolean {
  return /(top|bot|bottom|mid|middle|end)\s*\d|live/i.test(rawStatusText);
}

function inferScheduleTileInProgress(
  tile: any,
  rawStatusText: string,
  isOver: boolean
): boolean {
  if (isOver) {
    return false;
  }

  if (isScheduleTileLive(rawStatusText)) {
    return true;
  }

  if (!isScoreOnlyScheduleStatus(rawStatusText)) {
    return false;
  }

  return tile.hasClass("in-progress") || tile.attr("data-in-progress") === "1";
}

function isScoreOnlyScheduleStatus(rawStatusText: string): boolean {
  return /^\d+\s*-\s*\d+$/.test(rawStatusText);
}

function extractScheduledTimeLabel(value: string): string | null {
  const clean = cleanText(value).replace(/\s+/g, " ");
  if (!clean) {
    return null;
  }

  const match = clean.match(/@\s*([0-9]{1,2}:[0-9]{2}\s*[AP]M)$/i);
  if (!match) {
    return null;
  }

  return match[1].replace(/\s+/g, " ").toUpperCase();
}

function findScheduleGameForDate(
  schedule: D1TeamScheduleGame[],
  date: string,
  opponentName: string
): D1TeamScheduleGame | null {
  const onDate = schedule.filter((game) => extractDateFromScoresHref(game.dateUrl) === date);
  if (onDate.length === 0) {
    return null;
  }

  const normalizedOpponent = normalizeTeamKey(opponentName);
  const exactMatch = onDate.find((game) => normalizeTeamKey(game.opponentName ?? "") === normalizedOpponent);
  if (exactMatch) {
    return exactMatch;
  }

  return onDate.length === 1 ? onDate[0] : null;
}

function extractScheduleStatusOverride(game: D1TeamScheduleGame | null): string | null {
  if (!game) {
    return null;
  }

  const candidates = [
    game.resultText,
    game.notes,
    ...Object.values(game.columns),
  ];

  for (const candidate of candidates) {
    const clean = cleanText(candidate ?? "");
    if (/^cancel(?:ed|led)$/i.test(clean)) {
      return "Canceled";
    }
  }

  return null;
}

function computeOverallRecordBeforeDate(
  schedule: D1TeamScheduleGame[],
  date: string
): string | null {
  if (schedule.length === 0) {
    return null;
  }

  let wins = 0;
  let losses = 0;
  let sawDatedGame = false;

  for (const game of schedule) {
    const gameDate = extractDateFromScoresHref(game.dateUrl);
    if (!gameDate) {
      continue;
    }

    sawDatedGame = true;
    if (gameDate >= date) {
      continue;
    }

    if (game.outcome === "win") {
      wins += 1;
    } else if (game.outcome === "loss") {
      losses += 1;
    }
  }

  if (!sawDatedGame) {
    return null;
  }

  return `${wins}-${losses}`;
}

function buildCurrentTeamSnapshot(
  team: D1TeamSeasonData,
  name: string,
  score: number | null,
  record: string | null
): TeamSnapshot {
  return {
    id: team.id,
    name,
    record,
    rank: null,
    score,
    logoUrl: team.logoUrl ?? null,
    teamUrl: team.teamUrl,
    searchTokens: tokenizeTeamName(name),
  };
}

function buildOpponentTeamSnapshot(
  partial: TeamSnapshot,
  team: D1TeamSeasonData | null,
  name: string,
  score: number | null,
  date: string
): TeamSnapshot {
  return {
    id: team?.id ?? partial.id,
    name,
    record: partial.record ?? (team ? computeOverallRecordBeforeDate(team.schedule, date) : null),
    rank: partial.rank,
    score,
    logoUrl: partial.logoUrl ?? team?.logoUrl ?? null,
    teamUrl: partial.teamUrl ?? team?.teamUrl ?? null,
    searchTokens: tokenizeTeamName(name),
  };
}

function tokenizeTeamName(name: string): string[] {
  return normalizeTeamKey(name)
    .split(" ")
    .filter((token) => token.length > 0);
}

function findOpponentTeam(
  lookup: D1TeamLookup,
  partial: TeamSnapshot,
  fallbackName: string
): D1TeamSeasonData | null {
  if (partial.id !== null && partial.id !== undefined) {
    const byId = lookup.byId.get(partial.id);
    if (byId) {
      return byId;
    }
  }

  const slugFromUrl = extractSlug(partial.teamUrl ?? "", "team");
  if (slugFromUrl) {
    const bySlug = lookup.bySlug.get(slugFromUrl);
    if (bySlug) {
      return bySlug;
    }
  }

  const normalizedPartial = normalizeTeamKey(partial.name || fallbackName);
  return lookup.byName.get(normalizedPartial) ?? null;
}

function extractTeamScheduleLiveStatsUrl(tile: any): {
  url: string;
  id: number;
  query: Record<string, string>;
} | null {
  const links = tile.find(".box-score-links a").toArray() as Element[];
  for (const linkNode of links) {
    const href = cleanText(linkNode.attribs?.href);
    const statbroadcast = extractStatBroadcastInfo(href || null);
    if (href && statbroadcast) {
      return {
        url: href,
        id: statbroadcast.id,
        query: statbroadcast.query,
      };
    }
  }

  return null;
}

function extractDateFromScoresHref(href: string | null | undefined): string | null {
  const value = cleanText(href ?? "");
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value, D1_SCORES_PAGE);
    const date = cleanText(parsed.searchParams.get("date"));
    return /^\d{8}$/.test(date) ? date : null;
  } catch {
    return null;
  }
}

function currentEasternDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year}${month}${day}`;
}

function mergeScheduleDerivedGame(target: D1Game, source: D1Game): void {
  for (const conferenceId of source.conferenceIds) {
    if (!target.conferenceIds.includes(conferenceId)) {
      target.conferenceIds.push(conferenceId);
    }
  }

  for (const conferenceName of source.conferenceNames) {
    if (!target.conferenceNames.includes(conferenceName)) {
      target.conferenceNames.push(conferenceName);
    }
  }

  if (!target.location && source.location) {
    target.location = source.location;
  }
  if (!target.liveStatsUrl && source.liveStatsUrl) {
    target.liveStatsUrl = source.liveStatsUrl;
  }
  if (target.statbroadcastId === null && source.statbroadcastId !== null) {
    target.statbroadcastId = source.statbroadcastId;
    target.statbroadcastQuery = source.statbroadcastQuery;
  }
  if (target.roadTeam.score === null && source.roadTeam.score !== null) {
    target.roadTeam.score = source.roadTeam.score;
  }
  if (target.homeTeam.score === null && source.homeTeam.score !== null) {
    target.homeTeam.score = source.homeTeam.score;
  }
  if (target.roadTeam.logoUrl === null && source.roadTeam.logoUrl !== null) {
    target.roadTeam.logoUrl = source.roadTeam.logoUrl;
  }
  if (target.homeTeam.logoUrl === null && source.homeTeam.logoUrl !== null) {
    target.homeTeam.logoUrl = source.homeTeam.logoUrl;
  }
  if (target.roadTeam.record === null && source.roadTeam.record !== null) {
    target.roadTeam.record = source.roadTeam.record;
  }
  if (target.homeTeam.record === null && source.homeTeam.record !== null) {
    target.homeTeam.record = source.homeTeam.record;
  }
  if (!target.isOver && source.isOver) {
    target.isOver = true;
    target.inProgress = false;
    target.statusText = source.statusText;
  }
  if (!target.inProgress && source.inProgress) {
    target.inProgress = true;
  }

  const existingLinks = new Set(target.links.map((entry) => `${entry.label}|${entry.url}`));
  for (const link of source.links) {
    const key = `${link.label}|${link.url}`;
    if (!existingLinks.has(key)) {
      target.links.push(link);
      existingLinks.add(key);
    }
  }
}

function compareScheduleDerivedGames(a: D1Game, b: D1Game): number {
  const phaseRank = (game: D1Game): number => {
    if (game.inProgress) {
      return 0;
    }
    if (game.isOver) {
      return 2;
    }
    return 1;
  };

  const rankDiff = phaseRank(a) - phaseRank(b);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  return a.key.localeCompare(b.key);
}

function uniqueStrings(values: Array<string | null>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => cleanText(value ?? ""))
        .filter((value) => value.length > 0)
    )
  );
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
      record: null,
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
  const record = extractTeamRecord(titleNode.find("small").first().text());
  titleNode.find("small").remove();
  titleNode.find(".team-rank").remove();

  const searchRaw = cleanText(team.attr("data-search"));

  return {
    id: parseInteger(team.attr("data-team-id")),
    name: cleanText(titleNode.text()),
    record,
    rank,
    score: parseInteger(team.find(".score-meta.score-runs").first().text()),
    logoUrl: cleanText(team.find(".team-logo img").first().attr("src")) || null,
    teamUrl: cleanText(team.find(".team-title").first().attr("href")) || null,
    searchTokens: searchRaw.length > 0 ? searchRaw.split(" ") : [],
  };
}

function extractTeamRecord(value: string): string | null {
  const clean = cleanText(value).replace(/^\(/, "").replace(/\)$/, "");
  if (!clean) {
    return null;
  }

  const firstPart = clean.split(",")[0]?.trim() ?? "";
  return firstPart || null;
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
