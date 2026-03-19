import axios from "axios";
import { load } from "cheerio";
import he from "he";
import { TtlCache } from "../utils/cache";
import { cleanText, parseInteger } from "../utils/text";
import { getBrandingLogoUrl } from "../utils/team-branding";
import type {
  ConferenceStandingsConference,
  ConferenceStandingsEntry,
  ConferenceStandingsFeed,
} from "../types";

const D1_CONFERENCES_ENDPOINT = "https://d1baseball.com/conferences/";
const STANDINGS_CACHE_TTL_MS = 15 * 60_000;

const HTML_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: D1_CONFERENCES_ENDPOINT,
};

const conferencesCache = new TtlCache<string, ConferenceStandingsConference[]>();
const standingsCache = new TtlCache<string, ConferenceStandingsFeed>();

export async function getConferenceStandingsFeed(
  requestedConference: string | null = null
): Promise<ConferenceStandingsFeed> {
  const conferences = await getConferenceDirectory();
  if (conferences.length === 0) {
    throw new Error("D1 conferences page did not include any conference options.");
  }

  const selectedConference =
    resolveRequestedConference(conferences, requestedConference) ?? conferences[0];
  if (!selectedConference) {
    throw new Error(`Unknown conference "${requestedConference}".`);
  }

  const cacheKey = selectedConference.id;
  const cached = standingsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const html = await fetchHtml(selectedConference.url);
  const parsed = parseConferenceStandingsHtml(html);

  const feed: ConferenceStandingsFeed = {
    sourceLabel: "D1Baseball Conference Standings",
    sourceUrl: D1_CONFERENCES_ENDPOINT,
    updatedAt: null,
    selectedConference,
    conferences,
    headers: parsed.headers,
    entries: parsed.entries,
  };

  standingsCache.set(cacheKey, feed, STANDINGS_CACHE_TTL_MS);
  return feed;
}

export async function getConferenceDirectory(): Promise<ConferenceStandingsConference[]> {
  const cached = conferencesCache.get("current");
  if (cached) {
    return cached;
  }

  const html = await fetchHtml(D1_CONFERENCES_ENDPOINT);
  const conferences = parseConferencesIndexHtml(html);
  conferencesCache.set("current", conferences, STANDINGS_CACHE_TTL_MS);
  return conferences;
}

export function parseConferencesIndexHtml(rawHtml: string): ConferenceStandingsConference[] {
  const $ = load(he.decode(rawHtml));
  const byId = new Map<string, ConferenceStandingsConference>();

  $("select[name='conference'] option").each((_, node) => {
    const option = $(node);
    const name = cleanText(option.text());
    const url = toAbsoluteUrl(option.attr("data-target"), D1_CONFERENCES_ENDPOINT);
    const slug = extractConferenceSlug(url);
    if (!name || !url || !slug) {
      return;
    }

    const id = slug;
    if (byId.has(id)) {
      return;
    }

    byId.set(id, {
      id,
      name,
      slug,
      url,
    });
  });

  return Array.from(byId.values());
}

export function parseConferenceStandingsHtml(rawHtml: string): {
  headers: string[];
  entries: ConferenceStandingsEntry[];
} {
  const $ = load(he.decode(rawHtml));
  const table = $("#conference-standings .conference-standings-table").first();
  if (!table.length) {
    throw new Error("D1 conference page did not include a standings table.");
  }

  const headers = table
    .find("thead tr")
    .first()
    .find("td, th")
    .map((_, node) => cleanText($(node).text()))
    .get()
    .filter(Boolean);

  const headerKeys = headers.map(normalizeHeaderKey);
  const teamIndex = headerKeys.indexOf("team");
  const recordIndex = headerKeys.indexOf("record");
  const winPctIndex = headerKeys.indexOf("win_pct");
  const gamesBackIndex = headerKeys.indexOf("gb");
  const overallIndex = headerKeys.indexOf("overall");
  const overallPctIndex = headerKeys.indexOf("overall_pct");
  const streakIndex = headerKeys.indexOf("streak");

  const entries: ConferenceStandingsEntry[] = [];
  table.find("tbody tr").each((_, rowNode) => {
    const row = $(rowNode);
    const cells = row.find("td").toArray();
    const teamCell =
      teamIndex >= 0 && cells[teamIndex] ? $(cells[teamIndex]) : row.find("td.team").first();
    const teamAnchor = teamCell.find("a").first();
    const teamName = cleanText(teamAnchor.text()) || cleanText(teamCell.text());

    if (!teamName) {
      return;
    }

    const teamUrl = toAbsoluteUrl(teamAnchor.attr("href"), D1_CONFERENCES_ENDPOINT);
    const imageUrl = toAbsoluteUrl(teamCell.find("img").first().attr("src"), D1_CONFERENCES_ENDPOINT);
    const logoUrl = getBrandingLogoUrl(teamName) ?? imageUrl;

    const valueAt = (index: number): string | null =>
      index >= 0 && cells[index] ? cleanStandingValue($(cells[index]).text()) : null;

    entries.push({
      position: entries.length + 1,
      teamName,
      shortName: teamName,
      conferenceRecord: valueAt(recordIndex),
      conferenceWinPct: valueAt(winPctIndex),
      gamesBack: valueAt(gamesBackIndex),
      overallRecord: valueAt(overallIndex),
      overallWinPct: valueAt(overallPctIndex),
      streak: valueAt(streakIndex),
      logoUrl,
      teamUrl,
    });
  });

  if (entries.length === 0) {
    throw new Error("D1 conference page did not include standings rows.");
  }

  return { headers, entries };
}

async function fetchHtml(url: string): Promise<string> {
  const response = await axios.get<string>(url, {
    headers: HTML_HEADERS,
    timeout: 20_000,
    responseType: "text",
    transformResponse: [(value) => value],
  });

  return String(response.data ?? "");
}

function resolveRequestedConference(
  conferences: ConferenceStandingsConference[],
  requestedConference: string | null
): ConferenceStandingsConference | null {
  const normalizedRequested = normalizeConferenceKey(requestedConference);
  if (!normalizedRequested) {
    return conferences[0] ?? null;
  }

  return (
    conferences.find((conference) => conference.id === normalizedRequested)
    ?? conferences.find((conference) => conference.slug === normalizedRequested)
    ?? conferences.find((conference) => normalizeConferenceKey(conference.name) === normalizedRequested)
    ?? null
  );
}

function normalizeHeaderKey(value: string): string {
  const normalized = cleanText(value)
    .toLowerCase()
    .replace(/%/g, " pct")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  switch (normalized) {
  case "team":
    return "team";
  case "record":
    return "record";
  case "win pct":
    return "win_pct";
  case "gb":
    return "gb";
  case "overall":
    return "overall";
  case "overall pct":
    return "overall_pct";
  case "streak":
    return "streak";
  default:
    return normalized.replace(/\s+/g, "_");
  }
}

function normalizeConferenceKey(value: string | null | undefined): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanStandingValue(value: string | null | undefined): string | null {
  const clean = cleanText(value);
  return clean || null;
}

function toAbsoluteUrl(value: string | null | undefined, base: string): string | null {
  const clean = cleanText(value);
  if (!clean) {
    return null;
  }

  try {
    return new URL(clean, base).toString();
  } catch {
    return null;
  }
}

function extractConferenceSlug(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  const match = url.match(/\/conference\/([^/]+)(?:\/\d{4})?\/?$/i);
  return match?.[1] ?? null;
}
