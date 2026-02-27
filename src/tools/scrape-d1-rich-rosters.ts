import fs from "fs/promises";
import path from "path";
import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";
import axios from "axios";
import { scrapeRosterPage, type ScrapedRosterPayload } from "../scrapers/roster";
import { runWithConcurrency } from "../utils/async";
import { cleanText } from "../utils/text";
import type { D1TeamScheduleGame, D1TeamSeasonData, D1TeamsDatabasePayload } from "../types";

const DEFAULT_TEAMS_DIR = path.resolve(process.cwd(), "data", "tmp", "teams");
const DEFAULT_OUT_DIR = path.resolve(process.cwd(), "data", "rosters");
const DEFAULT_REPORT_PATH = path.resolve(process.cwd(), "artifacts", "d1-rich-roster-scrape-report.json");
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_DOMAINS = 6;
const DEFAULT_MAX_ROSTER_URLS_PER_DOMAIN = 16;
const DEFAULT_MAX_ROSTER_URLS_PER_TEAM = 64;
const D1_DYNAMIC_CONTENT_ENDPOINT = "https://d1baseball.com/wp-json/d1/v1/dynamic-content/";

const BAD_RESULT_HOSTS = new Set([
  "d1baseball.com",
  "www.d1baseball.com",
  "ncaa.com",
  "www.ncaa.com",
  "stats.statbroadcast.com",
  "statb.us",
]);

const ROSTER_PATHS = [
  "/sports/baseball/roster",
  "/sports/m-basebl/roster",
  "/sports/bsb/roster",
  "/sports/baseball/2026-roster",
  "/sports/baseball/2025-roster",
];

const TEAM_DOMAIN_OVERRIDES: Record<string, string[]> = {
  "central connecticut": ["ccsubluedevils.com"],
};

interface CliOptions {
  teamsFile: string | null;
  season: string | null;
  outDir: string;
  reportPath: string;
  concurrency: number;
  timeoutMs: number;
  minPlayers: number;
  maxDomains: number;
  maxRosterUrlsPerDomain: number;
  maxRosterUrlsPerTeam: number;
  limit: number | null;
  overwrite: boolean;
  dryRun: boolean;
  conferenceFilters: string[];
  teamFilters: string[];
}

interface ExistingRosterIndex {
  byTeamName: Set<string>;
  byFileName: Set<string>;
}

interface DomainCandidate {
  host: string;
  score: number;
  sourceCount: number;
}

interface TeamResult {
  teamId: number | null;
  teamName: string;
  slug: string | null;
  conference: string | null;
  season: string | null;
  status: "success" | "skipped" | "failed";
  message: string;
  sourceUrl: string | null;
  outputPath: string | null;
  players: number | null;
  domainsTried: string[];
  rosterUrlsTried: string[];
}

interface ScrapeAttemptContext {
  domainCache: Map<string, string[]>;
  rosterCache: Set<string>;
  probeCache: Map<string, QuickProbeResult>;
  d1DynamicDomainCache: Map<string, DomainCandidate[]>;
}

interface QuickProbeResult {
  ok: boolean;
  finalUrl: string;
  title: string | null;
  profileLinkCount: number;
  tableRowCount: number;
  structuredPersonCount: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const teamsFile = options.teamsFile ?? (await resolveLatestTeamsFile(DEFAULT_TEAMS_DIR, options.season));
  const teamsPayload = await readTeamsPayload(teamsFile);

  const existing = await readExistingRosterIndex(options.outDir);
  const targetTeams = selectTargetTeams(teamsPayload.teams, existing, options);

  // eslint-disable-next-line no-console
  console.log(
    `# D1 rich roster scrape starting | Teams file: ${teamsFile} | Candidates: ${targetTeams.length} | Concurrency: ${options.concurrency}`
  );

  const context: ScrapeAttemptContext = {
    domainCache: new Map(),
    rosterCache: new Set(),
    probeCache: new Map(),
    d1DynamicDomainCache: new Map(),
  };

  const results = await runWithConcurrency(targetTeams, options.concurrency, async (team) =>
    processTeam(team, options, context)
  );

  await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
  await fs.writeFile(
    options.reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        teamsFile,
        totalTeams: teamsPayload.teams.length,
        attemptedTeams: targetTeams.length,
        success: results.filter((result) => result.status === "success").length,
        failed: results.filter((result) => result.status === "failed").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        options: {
          season: options.season,
          outDir: options.outDir,
          concurrency: options.concurrency,
          timeoutMs: options.timeoutMs,
          minPlayers: options.minPlayers,
          maxDomains: options.maxDomains,
          maxRosterUrlsPerDomain: options.maxRosterUrlsPerDomain,
          maxRosterUrlsPerTeam: options.maxRosterUrlsPerTeam,
          overwrite: options.overwrite,
          dryRun: options.dryRun,
          conferenceFilters: options.conferenceFilters,
          teamFilters: options.teamFilters,
          limit: options.limit,
        },
        results,
      },
      null,
      2
    ),
    "utf8"
  );

  const success = results.filter((result) => result.status === "success").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;

  // eslint-disable-next-line no-console
  console.log(`# Completed | Success: ${success} | Failed: ${failed} | Skipped: ${skipped}`);
  // eslint-disable-next-line no-console
  console.log(`# Report: ${options.reportPath}`);
}

async function processTeam(
  team: D1TeamSeasonData,
  options: CliOptions,
  context: ScrapeAttemptContext
): Promise<TeamResult> {
  const outPath = path.resolve(
    options.outDir,
    `${slugify(team.name)}-baseball-${slugify(options.season ?? team.season ?? "latest")}.json`
  );

  if (!options.overwrite && (await pathExists(outPath))) {
    return buildSkippedResult(team, `Roster file already exists (${path.basename(outPath)}).`, outPath);
  }

  const domainsTried: string[] = [];
  const rosterUrlsTried: string[] = [];
  const scheduleDomains = deriveDomainCandidates(team, options.maxDomains);
  const scheduleAttempt = await tryDomainCandidates(team, scheduleDomains, options, context, outPath, domainsTried, rosterUrlsTried);
  if (scheduleAttempt) {
    return scheduleAttempt;
  }

  if (rosterUrlsTried.length < options.maxRosterUrlsPerTeam) {
    const dynamicDomains = await deriveDynamicTeamScheduleDomains(team, options.timeoutMs, context.d1DynamicDomainCache, options.maxDomains);
    const unseenDynamicDomains = dynamicDomains.filter((candidate) => !domainsTried.includes(candidate.host));
    const dynamicAttempt = await tryDomainCandidates(
      team,
      unseenDynamicDomains,
      options,
      context,
      outPath,
      domainsTried,
      rosterUrlsTried
    );
    if (dynamicAttempt) {
      return dynamicAttempt;
    }
  }

  return buildFailedResult(team, "Exhausted candidate domains/URLs without a valid roster match.", null, outPath, domainsTried, rosterUrlsTried);
}

function applyTeamOverrides(
  payload: ScrapedRosterPayload,
  team: D1TeamSeasonData,
  season: string | null
): ScrapedRosterPayload {
  return {
    ...payload,
    teamName: team.name,
    sport: "Baseball",
    season,
  };
}

async function tryDomainCandidates(
  team: D1TeamSeasonData,
  domainCandidates: DomainCandidate[],
  options: CliOptions,
  context: ScrapeAttemptContext,
  outPath: string,
  domainsTried: string[],
  rosterUrlsTried: string[]
): Promise<TeamResult | null> {
  for (let domainIndex = 0; domainIndex < domainCandidates.length; domainIndex += 1) {
    const domain = domainCandidates[domainIndex];
    domainsTried.push(domain.host);
    const enableDiscovery = domainIndex < 3;
    const rosterCandidates = await buildRosterUrlCandidates(domain.host, context.domainCache, options.timeoutMs, enableDiscovery);
    let urlsForDomain = 0;

    for (const rosterUrl of rosterCandidates) {
      if (urlsForDomain >= options.maxRosterUrlsPerDomain) {
        break;
      }
      if (rosterUrlsTried.length >= options.maxRosterUrlsPerTeam) {
        break;
      }
      if (context.rosterCache.has(rosterUrl)) {
        continue;
      }

      urlsForDomain += 1;
      context.rosterCache.add(rosterUrl);
      rosterUrlsTried.push(rosterUrl);

      const probe = await quickProbeRosterUrl(rosterUrl, Math.min(options.timeoutMs, 6_000), context.probeCache);
      if (!probe.ok || !isLikelyRosterProbe(probe)) {
        continue;
      }

      const scraped = await tryScrapeRoster(probe.finalUrl, options.timeoutMs);
      if (!scraped.ok) {
        continue;
      }

      if (scraped.payload.playerCount < options.minPlayers) {
        continue;
      }

      if (!isLikelyTeamMatch(team, scraped.payload, rosterUrl)) {
        continue;
      }

      if (!options.dryRun) {
        const payload = applyTeamOverrides(scraped.payload, team, options.season ?? team.season ?? null);
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
      }

      return {
        teamId: team.id,
        teamName: team.name,
        slug: team.slug,
        conference: team.conference?.name ?? null,
        season: options.season ?? team.season ?? null,
        status: "success",
        message: options.dryRun
          ? `Matched roster URL (dry-run): ${probe.finalUrl}`
          : `Scraped ${scraped.payload.playerCount} players.`,
        sourceUrl: probe.finalUrl,
        outputPath: outPath,
        players: scraped.payload.playerCount,
        domainsTried,
        rosterUrlsTried,
      };
    }

    if (rosterUrlsTried.length >= options.maxRosterUrlsPerTeam) {
      break;
    }
  }

  return null;
}

function deriveDomainCandidates(team: D1TeamSeasonData, maxDomains: number): DomainCandidate[] {
  const scoreByHost = new Map<string, { score: number; count: number }>();
  const nameHints = buildNameHints(team.name, team.slug);

  const overrideHosts = TEAM_DOMAIN_OVERRIDES[normalizeName(team.name)] ?? [];
  for (const host of overrideHosts) {
    const normalized = normalizeHost(host);
    if (!normalized) {
      continue;
    }
    scoreByHost.set(normalized, { score: 10_000, count: 1 });
  }

  for (const game of team.schedule) {
    const url = cleanText(game.resultUrl);
    if (!url) {
      continue;
    }

    const parsed = parseHost(url);
    if (!parsed || BAD_RESULT_HOSTS.has(parsed)) {
      continue;
    }

    const weight = scoreScheduleGameDomain(game, url, parsed, nameHints);
    const current = scoreByHost.get(parsed) ?? { score: 0, count: 0 };
    current.score += weight;
    current.count += 1;
    scoreByHost.set(parsed, current);
  }

  return Array.from(scoreByHost.entries())
    .map(([host, value]) => ({
      host,
      score: value.score,
      sourceCount: value.count,
    }))
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      if (a.sourceCount !== b.sourceCount) {
        return b.sourceCount - a.sourceCount;
      }
      return a.host.localeCompare(b.host);
    })
    .slice(0, Math.max(1, maxDomains));
}

async function deriveDynamicTeamScheduleDomains(
  team: D1TeamSeasonData,
  timeoutMs: number,
  cache: Map<string, DomainCandidate[]>,
  maxDomains: number
): Promise<DomainCandidate[]> {
  const key = String(team.teamUrl || team.slug || team.id);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const scoreByHost = new Map<string, { score: number; count: number }>();
  const teamPageUrl = cleanText(team.teamUrl || "");
  if (!teamPageUrl) {
    cache.set(key, []);
    return [];
  }

  try {
    const teamPage = await axios.get<string>(teamPageUrl, {
      timeout: timeoutMs,
      responseType: "text",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 5,
    });

    const $ = load(teamPage.data);
    const scheduleNode = $("#dynamic-team-schedule").first();
    if (scheduleNode.length === 0) {
      cache.set(key, []);
      return [];
    }

    const callback = cleanText(scheduleNode.attr("data-callback")) || "team_schedule";
    const argsRaw = cleanText(scheduleNode.attr("data-args"));
    if (!argsRaw) {
      cache.set(key, []);
      return [];
    }

    let args: Record<string, string | number> = {};
    try {
      args = JSON.parse(argsRaw) as Record<string, string | number>;
    } catch {
      cache.set(key, []);
      return [];
    }

    const payload = {
      "dynamic-team-schedule": {
        callback,
        args,
      },
    };

    const dynamicResponse = await axios.post<{ content?: Record<string, string> }>(D1_DYNAMIC_CONTENT_ENDPOINT, payload, {
      timeout: timeoutMs,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
        "Content-Type": "application/json",
        Origin: "https://d1baseball.com",
        Referer: teamPageUrl,
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const scheduleHtml = cleanText(dynamicResponse.data?.content?.["dynamic-team-schedule"] || "");
    if (!scheduleHtml) {
      cache.set(key, []);
      return [];
    }

    const schedule$ = load(scheduleHtml);
    schedule$(".box-score-links a[href], a[href]").each((_, node) => {
      const href = cleanText(schedule$(node).attr("href"));
      if (!href) {
        return;
      }
      const resolved = resolveUrl(href, "https://d1baseball.com/");
      if (!resolved) {
        return;
      }

      const host = parseHost(resolved);
      if (!host || BAD_RESULT_HOSTS.has(host)) {
        return;
      }

      const label = cleanText(schedule$(node).text())?.toLowerCase() ?? "";
      const entry = scoreByHost.get(host) ?? { score: 0, count: 0 };
      entry.score += label.includes("recap") ? 4 : 2;
      entry.count += 1;
      scoreByHost.set(host, entry);
    });
  } catch {
    cache.set(key, []);
    return [];
  }

  const candidates = Array.from(scoreByHost.entries())
    .map(([host, value]) => ({
      host,
      score: value.score,
      sourceCount: value.count,
    }))
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      return b.sourceCount - a.sourceCount;
    })
    .slice(0, Math.max(1, maxDomains));

  cache.set(key, candidates);
  return candidates;
}

function scoreScheduleGameDomain(
  game: D1TeamScheduleGame,
  url: string,
  host: string,
  nameHints: string[]
): number {
  const location = cleanText(game.locationType)?.toLowerCase() ?? "";
  let score = 1;

  if (location === "vs") {
    score += 3;
  } else if (location === "@") {
    score += 0;
  } else {
    score += 1;
  }

  const lowerUrl = url.toLowerCase();
  for (const hint of nameHints) {
    if (hint.length < 4) {
      continue;
    }
    if (host.includes(hint) || lowerUrl.includes(hint)) {
      score += 2;
      break;
    }
  }

  if (/\/sports?\//i.test(lowerUrl)) {
    score += 1;
  }

  return score;
}

async function buildRosterUrlCandidates(
  host: string,
  domainCache: Map<string, string[]>,
  timeoutMs: number,
  enableDiscovery: boolean
): Promise<string[]> {
  const cacheKey = `${host}|${enableDiscovery ? "discover" : "static"}`;
  const cached = domainCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const candidates = new Set<string>();
  const hostVariants = new Set<string>();
  hostVariants.add(host);
  if (host.startsWith("www.")) {
    hostVariants.add(host.slice(4));
  } else {
    hostVariants.add(`www.${host}`);
  }

  for (const variant of hostVariants) {
    for (const pathSuffix of ROSTER_PATHS) {
      candidates.add(`https://${variant}${pathSuffix}`);
    }
  }

  if (enableDiscovery) {
    for (const variant of hostVariants) {
      const rootUrls = [`https://${variant}/`, `https://${variant}/sports/`];
      for (const rootUrl of rootUrls) {
        const discovered = await discoverRosterLinks(rootUrl, timeoutMs);
        for (const url of discovered) {
          candidates.add(url);
        }
      }
    }
  }

  const ranked = Array.from(candidates)
    .filter((url) => isLikelyRosterUrl(url))
    .sort((a, b) => rankRosterUrl(b) - rankRosterUrl(a));

  domainCache.set(cacheKey, ranked);
  return ranked;
}

async function discoverRosterLinks(pageUrl: string, timeoutMs: number): Promise<string[]> {
  try {
    const response = await axios.get<string>(pageUrl, {
      timeout: timeoutMs,
      responseType: "text",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 5,
    });

    return extractRosterLinksFromHtml(response.data, response.request?.res?.responseUrl || pageUrl);
  } catch {
    return [];
  }
}

async function quickProbeRosterUrl(
  url: string,
  timeoutMs: number,
  probeCache: Map<string, QuickProbeResult>
): Promise<QuickProbeResult> {
  const cached = probeCache.get(url);
  if (cached) {
    return cached;
  }

  try {
    const response = await axios.get<string>(url, {
      timeout: timeoutMs,
      responseType: "text",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 5,
    });

    const finalUrl = cleanText(response.request?.res?.responseUrl) || url;
    const $ = load(response.data);
    const title = cleanText($("title").first().text()) || null;

    const profileLinks = collectProfileLinkCount($, finalUrl);
    const tableRowCount = $("table tr").length;
    const structuredPersonCount = (response.data.match(/"@type"\s*:\s*"Person"/gi) || []).length;

    const result: QuickProbeResult = {
      ok: true,
      finalUrl,
      title,
      profileLinkCount: profileLinks,
      tableRowCount,
      structuredPersonCount,
    };
    probeCache.set(url, result);
    return result;
  } catch {
    const failed: QuickProbeResult = {
      ok: false,
      finalUrl: url,
      title: null,
      profileLinkCount: 0,
      tableRowCount: 0,
      structuredPersonCount: 0,
    };
    probeCache.set(url, failed);
    return failed;
  }
}

function collectProfileLinkCount($: CheerioAPI, pageUrl: string): number {
  const links = new Set<string>();
  $("a[href]").each((_, node) => {
    const href = cleanText($(node).attr("href"));
    if (!href) {
      return;
    }
    const resolved = resolveUrl(href, pageUrl);
    if (!resolved) {
      return;
    }
    if (/\/sport[s]?\/[^/]+\/roster\/(?!coaches\/|staff\/)[^?#]+/i.test(resolved)) {
      links.add(stripUrlFragment(resolved));
    }
  });
  return links.size;
}

function isLikelyRosterProbe(probe: QuickProbeResult): boolean {
  if (probe.profileLinkCount >= 8) {
    return true;
  }
  if (probe.tableRowCount >= 20) {
    return true;
  }
  if (probe.structuredPersonCount >= 8) {
    return true;
  }
  return false;
}

function extractRosterLinksFromHtml(html: string, pageUrl: string): string[] {
  const $ = load(html);
  const links = new Set<string>();

  $("a[href]").each((_, node) => {
    const href = cleanText($(node).attr("href"));
    if (!href) {
      return;
    }

    const text = cleanText($(node).text())?.toLowerCase() ?? "";
    const resolved = resolveUrl(href, pageUrl);
    if (!resolved) {
      return;
    }

    const lower = resolved.toLowerCase();
    const looksLikeRoster = lower.includes("roster");
    const looksLikeBaseball = lower.includes("baseball") || lower.includes("m-basebl") || lower.includes("/bsb");
    const textHint = text.includes("baseball") && text.includes("roster");

    if ((looksLikeRoster && looksLikeBaseball) || textHint) {
      links.add(stripUrlFragment(resolved));
    }
  });

  return Array.from(links);
}

async function tryScrapeRoster(
  url: string,
  timeoutMs: number
): Promise<{ ok: true; payload: ScrapedRosterPayload } | { ok: false; message: string }> {
  try {
    const payload = await scrapeRosterPage({ url, timeoutMs });
    return { ok: true, payload };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isLikelyTeamMatch(team: D1TeamSeasonData, payload: ScrapedRosterPayload, sourceUrl: string): boolean {
  return isLikelyTeamMatchByName(team, payload.teamName, sourceUrl);
}

function isLikelyTeamMatchByName(team: D1TeamSeasonData, candidateName: string | null, sourceUrl: string): boolean {
  const scrapedName = normalizeName(candidateName ?? "");
  const targetName = normalizeName(team.name);
  if (!targetName) {
    return false;
  }

  if (scrapedName) {
    if (scrapedName === targetName) {
      return true;
    }

    if (scrapedName.includes(targetName) || targetName.includes(scrapedName)) {
      if (Math.min(scrapedName.length, targetName.length) >= 6) {
        return true;
      }
    }

    const targetTokens = tokenizeName(team.name);
    const scrapedTokens = tokenizeName(candidateName ?? "");
    const shared = targetTokens.filter((token) => scrapedTokens.includes(token));

    if (targetTokens.length >= 2) {
      if (shared.length >= 2 && shared.length / targetTokens.length >= 0.5) {
        return true;
      }
    } else if (targetTokens.length === 1 && shared.length === 1) {
      const token = targetTokens[0];
      const source = sourceUrl.toLowerCase();
      if (source.includes(token)) {
        return true;
      }
    }
  }

  const hints = buildNameHints(team.name, team.slug);
  const source = sourceUrl.toLowerCase();
  return hints.some((hint) => hint.length >= 4 && source.includes(hint));
}

function selectTargetTeams(
  teams: D1TeamSeasonData[],
  existing: ExistingRosterIndex,
  options: CliOptions
): D1TeamSeasonData[] {
  const conferenceFilters = options.conferenceFilters.map((value) => normalizeName(value));
  const teamFilters = options.teamFilters.map((value) => normalizeName(value));

  const selected = teams.filter((team) => {
    const conferenceName = normalizeName(team.conference?.name ?? "");
    const conferenceSlug = normalizeName(team.conference?.slug ?? "");
    if (
      conferenceFilters.length > 0 &&
      !conferenceFilters.some((filter) => conferenceName.includes(filter) || conferenceSlug.includes(filter))
    ) {
      return false;
    }

    const teamName = normalizeName(team.name);
    const teamSlug = normalizeName(team.slug ?? "");
    if (
      teamFilters.length > 0 &&
      !teamFilters.some((filter) => teamName.includes(filter) || teamSlug.includes(filter))
    ) {
      return false;
    }

    if (!options.overwrite) {
      const fileName = `${slugify(team.name)}-baseball-${slugify(options.season ?? team.season ?? "latest")}.json`;
      if (existing.byFileName.has(fileName)) {
        return false;
      }
      if (existing.byTeamName.has(teamName)) {
        return false;
      }
    }

    return true;
  });

  const sorted = selected.sort((a, b) => {
    const aConference = a.conference?.name ?? "";
    const bConference = b.conference?.name ?? "";
    if (aConference !== bConference) {
      return aConference.localeCompare(bConference);
    }
    return a.name.localeCompare(b.name);
  });

  if (!options.limit) {
    return sorted;
  }
  return sorted.slice(0, options.limit);
}

async function readExistingRosterIndex(outDir: string): Promise<ExistingRosterIndex> {
  const byTeamName = new Set<string>();
  const byFileName = new Set<string>();

  let files: string[] = [];
  try {
    files = await fs.readdir(outDir);
  } catch {
    return { byTeamName, byFileName };
  }

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    byFileName.add(file);
    const fullPath = path.resolve(outDir, file);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw) as { teamName?: unknown };
      const teamName = typeof parsed.teamName === "string" ? normalizeName(parsed.teamName) : null;
      if (teamName) {
        byTeamName.add(teamName);
      }
    } catch {
      // Ignore malformed files while indexing.
    }
  }

  return { byTeamName, byFileName };
}

async function readTeamsPayload(filePath: string): Promise<D1TeamsDatabasePayload> {
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as D1TeamsDatabasePayload;
  if (!Array.isArray(parsed.teams)) {
    throw new Error(`Invalid D1 teams payload: ${resolved}`);
  }
  return parsed;
}

async function resolveLatestTeamsFile(directory: string, season: string | null): Promise<string> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^d1-teams-(\d{4}|current)-\d{4}-\d{2}-\d{2}\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => (season ? name.includes(`d1-teams-${season}-`) : true))
    .sort((a, b) => b.localeCompare(a));

  if (files.length === 0) {
    throw new Error(`No D1 teams file found in ${directory}${season ? ` for season ${season}` : ""}.`);
  }

  return path.resolve(directory, files[0]);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    teamsFile: null,
    season: null,
    outDir: DEFAULT_OUT_DIR,
    reportPath: DEFAULT_REPORT_PATH,
    concurrency: 4,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    minPlayers: 12,
    maxDomains: DEFAULT_MAX_DOMAINS,
    maxRosterUrlsPerDomain: DEFAULT_MAX_ROSTER_URLS_PER_DOMAIN,
    maxRosterUrlsPerTeam: DEFAULT_MAX_ROSTER_URLS_PER_TEAM,
    limit: null,
    overwrite: false,
    dryRun: false,
    conferenceFilters: [],
    teamFilters: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--teams-file") {
      if (!next) {
        throw new Error("Missing value for --teams-file");
      }
      options.teamsFile = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--season") {
      if (!next) {
        throw new Error("Missing value for --season");
      }
      options.season = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--out-dir") {
      if (!next) {
        throw new Error("Missing value for --out-dir");
      }
      options.outDir = path.resolve(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--report") {
      if (!next) {
        throw new Error("Missing value for --report");
      }
      options.reportPath = path.resolve(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--concurrency") {
      if (!next) {
        throw new Error("Missing value for --concurrency");
      }
      options.concurrency = parsePositiveInteger(next, "--concurrency");
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms") {
      if (!next) {
        throw new Error("Missing value for --timeout-ms");
      }
      options.timeoutMs = parsePositiveInteger(next, "--timeout-ms");
      index += 1;
      continue;
    }

    if (arg === "--min-players") {
      if (!next) {
        throw new Error("Missing value for --min-players");
      }
      options.minPlayers = parsePositiveInteger(next, "--min-players");
      index += 1;
      continue;
    }

    if (arg === "--max-domains") {
      if (!next) {
        throw new Error("Missing value for --max-domains");
      }
      options.maxDomains = parsePositiveInteger(next, "--max-domains");
      index += 1;
      continue;
    }

    if (arg === "--max-urls-per-domain") {
      if (!next) {
        throw new Error("Missing value for --max-urls-per-domain");
      }
      options.maxRosterUrlsPerDomain = parsePositiveInteger(next, "--max-urls-per-domain");
      index += 1;
      continue;
    }

    if (arg === "--max-urls-per-team") {
      if (!next) {
        throw new Error("Missing value for --max-urls-per-team");
      }
      options.maxRosterUrlsPerTeam = parsePositiveInteger(next, "--max-urls-per-team");
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      if (!next) {
        throw new Error("Missing value for --limit");
      }
      options.limit = parsePositiveInteger(next, "--limit");
      index += 1;
      continue;
    }

    if (arg === "--conference") {
      if (!next) {
        throw new Error("Missing value for --conference");
      }
      options.conferenceFilters = next
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (arg === "--team") {
      if (!next) {
        throw new Error("Missing value for --team");
      }
      options.teamFilters = next
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (arg === "--overwrite") {
      options.overwrite = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelpAndExit(): never {
  // eslint-disable-next-line no-console
  console.log(
    "Usage: npm run roster:d1-rich -- [--teams-file data/tmp/teams/d1-teams-2026-2026-02-27.json] [--season 2026] [--conference 'SEC,ACC'] [--team 'Alabama,Texas'] [--out-dir data/rosters] [--report artifacts/d1-rich-roster-scrape-report.json] [--concurrency 4] [--timeout-ms 12000] [--min-players 12] [--max-domains 6] [--max-urls-per-domain 16] [--max-urls-per-team 64] [--limit 25] [--overwrite] [--dry-run]"
  );
  process.exit(0);
}

function parsePositiveInteger(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${flag} must be an integer >= 1`);
  }
  return value;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|university|college|of|at|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeName(value: string): string[] {
  return normalizeName(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function buildNameHints(name: string, slug: string | null): string[] {
  const hints = new Set<string>();
  for (const token of tokenizeName(name)) {
    if (token.length >= 4) {
      hints.add(token);
    }
  }

  const normalizedSlug = cleanText(slug)?.toLowerCase() ?? "";
  if (normalizedSlug) {
    hints.add(normalizedSlug);
    for (const token of normalizedSlug.split("-")) {
      if (token.length >= 4) {
        hints.add(token);
      }
    }
  }

  return Array.from(hints);
}

function normalizeHost(host: string): string | null {
  const trimmed = cleanText(host)?.toLowerCase();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/:\d+$/g, "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function parseHost(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

function resolveUrl(raw: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(raw, baseUrl);
    if (!/^https?:$/i.test(resolved.protocol)) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function stripUrlFragment(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function isLikelyRosterUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (!lower.includes("roster")) {
    return false;
  }
  if (lower.includes("/coaches") || lower.includes("/staff")) {
    return false;
  }
  if (!(lower.includes("baseball") || lower.includes("m-basebl") || lower.includes("/bsb"))) {
    return false;
  }
  return true;
}

function rankRosterUrl(url: string): number {
  const lower = url.toLowerCase();
  let score = 0;
  if (lower.startsWith("https://")) {
    score += 20;
  }
  if (lower.includes("/sports/baseball/roster")) {
    score += 15;
  }
  if (lower.includes("/sports/m-basebl/roster")) {
    score += 14;
  }
  if (lower.includes("/sports/bsb/roster")) {
    score += 13;
  }
  if (/\b2026-roster\b/.test(lower)) {
    score += 10;
  }
  if (lower.includes("?path=baseball")) {
    score += 4;
  }
  score -= lower.length / 400;
  return score;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buildSkippedResult(team: D1TeamSeasonData, message: string, outPath: string): TeamResult {
  return {
    teamId: team.id,
    teamName: team.name,
    slug: team.slug,
    conference: team.conference?.name ?? null,
    season: team.season,
    status: "skipped",
    message,
    sourceUrl: null,
    outputPath: outPath,
    players: null,
    domainsTried: [],
    rosterUrlsTried: [],
  };
}

function buildFailedResult(
  team: D1TeamSeasonData,
  message: string,
  sourceUrl: string | null,
  outPath: string | null,
  domainsTried: string[],
  rosterUrlsTried: string[]
): TeamResult {
  return {
    teamId: team.id,
    teamName: team.name,
    slug: team.slug,
    conference: team.conference?.name ?? null,
    season: team.season,
    status: "failed",
    message,
    sourceUrl,
    outputPath: outPath,
    players: null,
    domainsTried,
    rosterUrlsTried,
  };
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`roster:d1-rich failed: ${message}`);
  process.exit(1);
});
