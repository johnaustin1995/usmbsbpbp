import axios from "axios";
import { load } from "cheerio";
import { TtlCache } from "../utils/cache";
import { cleanText } from "../utils/text";

const DEFAULT_STATS_URL_TEMPLATE = "https://southernmiss.com/sports/baseball/stats/{season}";
const DEFAULT_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 5 * 60_000;

const BASE_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const cache = new TtlCache<string, SouthernMissStatsPayload>();
const dynamicImport = new Function("modulePath", "return import(modulePath)") as (
  modulePath: string
) => Promise<{ parse: (serialized: string, revivers?: Record<string, (value: unknown) => unknown>) => unknown }>;

export interface SouthernMissStatsSeasonOption {
  value: number | null;
  name: string | null;
  statTitle: string | null;
}

export type SouthernMissStatCell = string | number | boolean | null;

export interface SouthernMissStatsRow {
  playerName: string | null;
  playerUniform: string | null;
  playerUrl: string | null;
  playerImageUrl: string | null;
  meetsMinStats: boolean | null;
  values: Record<string, SouthernMissStatCell>;
}

export interface SouthernMissStatsPayload {
  sourceUrl: string;
  fetchedAt: string;
  pageTitle: string | null;
  season: string | null;
  teamName: string | null;
  teamId: string | null;
  record: string | null;
  pdfDocUrl: string | null;
  teamStats: Record<string, SouthernMissStatCell>;
  individual: {
    hitting: SouthernMissStatsRow[];
    pitching: SouthernMissStatsRow[];
    fielding: SouthernMissStatsRow[];
  };
  availableSeasons: SouthernMissStatsSeasonOption[];
}

export interface GetSouthernMissStatsOptions {
  season?: string | number | null;
  url?: string | null;
  timeoutMs?: number;
  bypassCache?: boolean;
}

export async function getSouthernMissStats(
  options: GetSouthernMissStatsOptions = {}
): Promise<SouthernMissStatsPayload> {
  const season = normalizeSeason(options.season);
  const sourceUrl =
    cleanText(options.url ?? "") || DEFAULT_STATS_URL_TEMPLATE.replace("{season}", season ?? "2026");
  const cacheKey = `${sourceUrl}|${season ?? "auto"}`;

  if (!options.bypassCache) {
    const cached = cache.get(cacheKey);
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
  const rawNuxtPayload = cleanText($("#__NUXT_DATA__").html() || "");
  if (!rawNuxtPayload) {
    throw new Error("Southern Miss stats page did not include __NUXT_DATA__ payload.");
  }

  const nuxtPayload = await parseNuxtPayload(rawNuxtPayload);
  const statsStore = asRecord(asRecord(nuxtPayload)?.pinia)?.statsSeason;
  const statsStoreRecord = asRecord(statsStore);
  if (!statsStoreRecord) {
    throw new Error("Unable to resolve statsSeason store in Nuxt payload.");
  }

  const cumulativeStats = asRecord(statsStoreRecord.cumulativeStats);
  const cumulativeEntry = cumulativeStats ? pickFirstObjectValue(cumulativeStats) : null;
  if (!cumulativeEntry) {
    throw new Error("Unable to resolve cumulative stats entry from Southern Miss payload.");
  }

  const overallTeamStats = asRecord(asRecord(cumulativeEntry.overallTeamStats)?.teamStats) ?? {};
  const overallIndividualStats = asRecord(asRecord(cumulativeEntry.overallIndividualStats)?.individualStats) ?? {};

  const seasonsObject = asRecord(statsStoreRecord.seasons);
  const seasonOptions = seasonsObject ? pickFirstArrayValue(seasonsObject) : [];

  const payload: SouthernMissStatsPayload = {
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    pageTitle,
    season: season ?? inferSeasonFromPath(sourceUrl),
    teamName: asText(cumulativeEntry.ourTeamName),
    teamId: asText(cumulativeEntry.ourTeamId),
    record: asText(cumulativeEntry.record),
    pdfDocUrl: asText(cumulativeEntry.pdfDoc),
    teamStats: normalizeFlatValues(overallTeamStats),
    individual: {
      hitting: normalizeStatRows(overallIndividualStats.individualHittingStats, "hitting"),
      pitching: normalizeStatRows(overallIndividualStats.individualPitchingStats, "pitching"),
      fielding: normalizeStatRows(overallIndividualStats.individualFieldingStats, "fielding"),
    },
    availableSeasons: normalizeSeasonOptions(seasonOptions),
  };

  cache.set(cacheKey, payload, CACHE_TTL_MS);
  return payload;
}

async function parseNuxtPayload(rawPayload: string): Promise<unknown> {
  const devalueModule = await dynamicImport("devalue");
  return devalueModule.parse(rawPayload, {
    ShallowReactive: (value: unknown) => value,
    Reactive: (value: unknown) => value,
  });
}

function normalizeSeason(value: string | number | null | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.floor(value));
  }
  const text = cleanText(String(value ?? ""));
  if (!text) {
    return null;
  }
  return /^\d{4}$/.test(text) ? text : null;
}

function inferSeasonFromPath(sourceUrl: string): string | null {
  const match = sourceUrl.match(/\/stats\/(\d{4})(?:\/|$)/i);
  return match?.[1] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickFirstObjectValue(record: Record<string, unknown>): Record<string, unknown> | null {
  for (const value of Object.values(record)) {
    const asObj = asRecord(value);
    if (asObj) {
      return asObj;
    }
  }
  return null;
}

function pickFirstArrayValue(record: Record<string, unknown>): unknown[] {
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function asText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  const text = cleanText(typeof value === "string" ? value : "");
  return text || null;
}

function asCell(value: unknown): SouthernMissStatCell {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const text = cleanText(value);
    return text.length > 0 ? text : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function normalizeFlatValues(record: Record<string, unknown>): Record<string, SouthernMissStatCell> {
  const normalized: Record<string, SouthernMissStatCell> = {};
  for (const [key, value] of Object.entries(record)) {
    const cell = asCell(value);
    if (cell !== null) {
      normalized[key] = cell;
    }
  }
  return normalized;
}

function normalizeStatRows(rowsValue: unknown, type: "hitting" | "pitching" | "fielding"): SouthernMissStatsRow[] {
  if (!Array.isArray(rowsValue)) {
    return [];
  }

  return rowsValue
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => row !== null)
    .map((row) => {
      const values = normalizeFlatValues(row);
      const playerName = asText(row.playerName);
      const playerUniform = asText(row.playerUniform);
      const playerUrl = toAbsoluteSouthernMissUrl(asText(row.playerUrl));
      const playerImageUrl = toAbsoluteSouthernMissAssetUrl(asText(row.playerImageUrl));
      const meetsMinStats =
        type === "pitching"
          ? asBoolean(row.meetsMinPitchingStats)
          : asBoolean(row.meetsMinHittingStats);

      return {
        playerName,
        playerUniform,
        playerUrl,
        playerImageUrl,
        meetsMinStats,
        values,
      } satisfies SouthernMissStatsRow;
    })
    .filter((row) => row.playerName !== null);
}

function normalizeSeasonOptions(values: unknown[]): SouthernMissStatsSeasonOption[] {
  return values
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value !== null)
    .map((value) => ({
      value: asNumber(value.value),
      name: asText(value.name),
      statTitle: asText(value.statTitle),
    }))
    .filter((entry) => entry.value !== null || entry.name !== null);
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return null;
  }
  if (typeof value === "string") {
    const normalized = cleanText(value).toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const text = cleanText(value);
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      const parsed = Number.parseFloat(text);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function toAbsoluteSouthernMissUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith("/")) {
    return `https://southernmiss.com${value}`;
  }
  return null;
}

function toAbsoluteSouthernMissAssetUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith("/images/")) {
    return `https://dxbhsrqyrr690.cloudfront.net/sidearm.nextgen.sites/southernmiss.com${value}`;
  }
  if (value.startsWith("/")) {
    return `https://southernmiss.com${value}`;
  }
  return null;
}
