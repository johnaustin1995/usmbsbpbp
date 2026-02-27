import axios from "axios";
import { load } from "cheerio";
import { TtlCache } from "../utils/cache";
import { cleanText } from "../utils/text";

const DEFAULT_SOURCE_URL = "https://southernmiss.com/sports/baseball/schedule/text";
const DEFAULT_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 5 * 60_000;

const BASE_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const cache = new TtlCache<string, SouthernMissScheduleTextPayload>();

export interface SouthernMissScheduleTextGame {
  dateLabel: string;
  dateIso: string | null;
  timeLabel: string | null;
  siteLabel: string | null;
  opponentName: string;
  locationName: string | null;
  tournamentName: string | null;
  resultText: string | null;
  outcome: "win" | "loss" | "unknown";
}

export interface SouthernMissScheduleTextPayload {
  sourceUrl: string;
  fetchedAt: string;
  pageTitle: string | null;
  season: string | null;
  overallRecord: string | null;
  conferenceRecord: string | null;
  games: SouthernMissScheduleTextGame[];
}

export interface GetSouthernMissScheduleTextOptions {
  url?: string | null;
  timeoutMs?: number;
  bypassCache?: boolean;
}

export async function getSouthernMissScheduleText(
  options: GetSouthernMissScheduleTextOptions = {}
): Promise<SouthernMissScheduleTextPayload> {
  const sourceUrl = cleanText(options.url ?? "") || DEFAULT_SOURCE_URL;

  if (!options.bypassCache) {
    const cached = cache.get(sourceUrl);
    if (cached) {
      return cached;
    }
  }

  const response = await axios.get<string>(sourceUrl, {
    headers: BASE_BROWSER_HEADERS,
    timeout: Number.isFinite(options.timeoutMs) ? Math.max(2_000, Math.floor(options.timeoutMs ?? 0)) : DEFAULT_TIMEOUT_MS,
    responseType: "text",
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const html = response.data;
  const $ = load(html);

  const pageTitle = cleanText($("title").first().text()) || null;
  const scheduleRoot = $("#scheduleTextPage");
  const scheduleHeading = cleanText(scheduleRoot.find("h2").first().text()) || null;
  const season = extractSeason(scheduleHeading);

  const recordRows = scheduleRoot.find(".flex.flex-col > .flex");
  let overallRecord: string | null = null;
  let conferenceRecord: string | null = null;
  recordRows.each((_, node) => {
    const row = $(node);
    const columns = row.find("span");
    const label = cleanText(columns.eq(0).text()).toLowerCase();
    const firstValue = cleanText(columns.eq(1).text());
    if (!firstValue) {
      return;
    }

    if (label === "overall") {
      overallRecord = firstValue;
    }

    if (label === "conference") {
      conferenceRecord = firstValue;
    }
  });

  const games: SouthernMissScheduleTextGame[] = [];
  scheduleRoot.find("table tbody tr").each((_, node) => {
    const row = $(node);
    const cells = row.find("td");
    if (cells.length < 7) {
      return;
    }

    const dateLabel = cleanText(cells.eq(0).text());
    const timeLabel = cleanText(cells.eq(1).text()) || null;
    const siteLabel = cleanText(cells.eq(2).text()) || null;
    const opponentName = cleanText(cells.eq(3).text());
    const locationName = cleanText(cells.eq(4).text()) || null;
    const tournamentName = cleanText(cells.eq(5).text()) || null;
    const rawResult = cleanText(cells.eq(6).text());

    if (!dateLabel || !opponentName) {
      return;
    }

    const resultText = normalizeResult(rawResult);
    games.push({
      dateLabel,
      dateIso: parseDateLabelToIso(dateLabel, season),
      timeLabel,
      siteLabel,
      opponentName,
      locationName,
      tournamentName,
      resultText,
      outcome: parseOutcome(resultText),
    });
  });

  const payload: SouthernMissScheduleTextPayload = {
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    pageTitle,
    season,
    overallRecord,
    conferenceRecord,
    games,
  };

  cache.set(sourceUrl, payload, CACHE_TTL_MS);
  return payload;
}

function extractSeason(heading: string | null): string | null {
  if (!heading) {
    return null;
  }

  const match = heading.match(/\b(\d{4})\b/);
  return match?.[1] ?? null;
}

function parseDateLabelToIso(dateLabel: string, season: string | null): string | null {
  const monthMatch = dateLabel.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
  const dayMatch = dateLabel.match(/\b(\d{1,2})\b/);
  if (!monthMatch || !dayMatch) {
    return null;
  }

  const monthMap: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };

  const month = monthMap[monthMatch[1].slice(0, 3).toLowerCase()];
  const day = Number.parseInt(dayMatch[1], 10);
  const year = Number.parseInt(season ?? "", 10);

  if (!month || !Number.isFinite(day)) {
    return null;
  }

  const fallbackYear = Number.isFinite(year) ? year : new Date().getUTCFullYear();
  return `${String(fallbackYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeResult(value: string): string | null {
  const text = cleanText(value);
  if (!text || text === "-" || text === "--") {
    return null;
  }
  return text;
}

function parseOutcome(resultText: string | null): "win" | "loss" | "unknown" {
  if (!resultText) {
    return "unknown";
  }

  const normalized = cleanText(resultText).toUpperCase();
  if (/^W\b/u.test(normalized)) {
    return "win";
  }
  if (/^L\b/u.test(normalized)) {
    return "loss";
  }
  return "unknown";
}
