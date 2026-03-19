import axios from "axios";
import { load } from "cheerio";
import { TtlCache } from "../utils/cache";
import { cleanText, parseInteger } from "../utils/text";
import { getBrandingLogoUrl } from "../utils/team-branding";
import type { RankingsEntry, RankingsFeed, RankingsSource } from "../types";

const RANKINGS_CACHE_TTL_MS = 15 * 60_000;
const rankingsCache = new TtlCache<RankingsSource, RankingsFeed>();

const SOURCE_CONFIG: Record<RankingsSource, { label: string; url: string }> = {
  d1: {
    label: "D1",
    url: "https://www.ncaa.com/rankings/baseball/d1/d1baseballcom-top-25",
  },
  rpi: {
    label: "RPI",
    url: "https://www.ncaa.com/rankings/baseball/d1/rpi",
  },
  "baseball-america": {
    label: "Baseball America",
    url: "https://www.baseballamerica.com/stories/college-baseball-top-25-rankings/",
  },
  "usa-today": {
    label: "USA Today",
    url: "https://sportsdata.usatoday.com/baseball/cbb/coaches-poll",
  },
};

const HTML_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export async function getRankingsFeed(source: RankingsSource): Promise<RankingsFeed> {
  const cached = rankingsCache.get(source);
  if (cached) {
    return cached;
  }

  const config = SOURCE_CONFIG[source];
  const html = await fetchRankingsHtml(config.url);

  const parsed = (() => {
    switch (source) {
    case "d1":
      return parseNCAAD1RankingsHtml(html);
    case "rpi":
      return parseNCAARpiHtml(html);
    case "baseball-america":
      return parseBaseballAmericaRankingsHtml(html);
    case "usa-today":
      return parseUsaTodayCoachesPollHtml(html);
    }
  })();

  const feed: RankingsFeed = {
    source,
    sourceLabel: config.label,
    sourceUrl: config.url,
    updatedAt: parsed.updatedAt,
    entries: parsed.entries,
  };

  rankingsCache.set(source, feed, RANKINGS_CACHE_TTL_MS);
  return feed;
}

export function parseNCAAD1RankingsHtml(rawHtml: string): { updatedAt: string | null; entries: RankingsEntry[] } {
  return parseNCAAHtml(rawHtml, {
    source: "d1",
    mapRow: (cells) => ({
      rank: parseInteger(cells[0]) ?? 0,
      teamName: cells[1] ?? "",
      shortName: cells[1] ?? null,
      record: cells[2] ?? null,
      previousRank: normalizeNullableText(cells[3]),
      conference: null,
      points: null,
      firstPlaceVotes: null,
      change: null,
      highLow: null,
      logoUrl: resolveRankingLogoUrl(cells[1], null),
      teamUrl: null,
    }),
  });
}

export function parseNCAARpiHtml(rawHtml: string): { updatedAt: string | null; entries: RankingsEntry[] } {
  return parseNCAAHtml(rawHtml, {
    source: "rpi",
    mapRow: (cells) => ({
      rank: parseInteger(cells[0]) ?? 0,
      teamName: cells[1] ?? "",
      shortName: cells[1] ?? null,
      record: cells[2] ?? null,
      previousRank: normalizeNullableText(cells[8]),
      conference: normalizeNullableText(cells[3]),
      points: null,
      firstPlaceVotes: null,
      change: null,
      highLow: null,
      logoUrl: resolveRankingLogoUrl(cells[1], null),
      teamUrl: null,
    }),
  });
}

export function parseBaseballAmericaRankingsHtml(rawHtml: string): { updatedAt: string | null; entries: RankingsEntry[] } {
  const $ = load(rawHtml);
  const table = $("table").first();
  if (!table.length) {
    throw new Error("Baseball America rankings page did not include a rankings table.");
  }

  const rows = table.find("tr").toArray();
  const entries: RankingsEntry[] = [];

  for (const row of rows.slice(1)) {
    const cells = $(row)
      .find("td")
      .map((_, cell) => cleanText($(cell).text()))
      .get();

    const rank = parseInteger(cells[0]);
    if (!rank) {
      continue;
    }

    const teamCell = $(row).find("td").eq(1);
    const teamName = cleanText(teamCell.find("a").first().text()) || cleanText(teamCell.text());

    entries.push({
      rank,
      teamName,
      shortName: teamName || null,
      record: normalizeNullableText(cells[3]),
      previousRank: normalizeNullableText(cells[2]),
      conference: null,
      points: null,
      firstPlaceVotes: null,
      change: null,
      highLow: null,
      logoUrl: resolveRankingLogoUrl(teamName, null),
      teamUrl: null,
    });
  }

  if (entries.length === 0) {
    throw new Error("Baseball America rankings page did not include ranked teams.");
  }

  const updatedAt =
    normalizeDateForDisplay(
      $('meta[property="article:modified_time"]').attr("content")
        ?? $('meta[property="og:updated_time"]').attr("content")
        ?? null
    );

  return { updatedAt, entries };
}

export function parseUsaTodayCoachesPollHtml(rawHtml: string): { updatedAt: string | null; entries: RankingsEntry[] } {
  const $ = load(rawHtml);
  const table = $("table").first();
  if (!table.length) {
    throw new Error("USA Today rankings page did not include a rankings table.");
  }

  const entries: RankingsEntry[] = [];
  table.find("tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    const rank = parseInteger(cleanText(cells.eq(0).text()));
    if (!rank) {
      return;
    }

    const teamCell = cells.eq(1);
    const teamName =
      cleanText(teamCell.find("span.QA1t2T__QA1t2T").first().text()) || cleanText(teamCell.text());
    const shortName = cleanText(teamCell.find("span.yNdnxn__yNdnxn").first().text()) || teamName;
    const logoUrl = cleanLogoUrl(teamCell.find("img").first().attr("src")) ?? resolveRankingLogoUrl(teamName, shortName);

    entries.push({
      rank,
      teamName,
      shortName: shortName || null,
      record: normalizeNullableText(cells.eq(2).text()),
      previousRank: normalizeNullableText(cells.eq(5).text()),
      conference: null,
      points: normalizeNullableText(cells.eq(3).text()),
      firstPlaceVotes: normalizeNullableText(cells.eq(4).text()),
      change: normalizeNullableText(cells.eq(6).text()),
      highLow: normalizeNullableText(cells.eq(7).text()),
      logoUrl,
      teamUrl: null,
    });
  });

  if (entries.length === 0) {
    throw new Error("USA Today rankings page did not include ranked teams.");
  }

  return { updatedAt: null, entries };
}

async function fetchRankingsHtml(url: string): Promise<string> {
  const response = await axios.get<string>(url, {
    headers: HTML_HEADERS,
    timeout: 20_000,
    responseType: "text",
    transformResponse: [(value) => value],
  });

  return String(response.data ?? "");
}

function parseNCAAHtml(
  rawHtml: string,
  options: {
    source: "d1" | "rpi";
    mapRow: (cells: string[]) => RankingsEntry;
  }
): { updatedAt: string | null; entries: RankingsEntry[] } {
  const $ = load(rawHtml);
  const table = $("table").first();
  if (!table.length) {
    throw new Error(`NCAA ${options.source.toUpperCase()} page did not include a rankings table.`);
  }

  const entries: RankingsEntry[] = [];
  table.find("tbody tr").each((_, row) => {
    const cells = $(row)
      .find("td")
      .map((__, cell) => cleanText($(cell).text()))
      .get();

    const entry = options.mapRow(cells);
    if (!entry.rank || !entry.teamName) {
      return;
    }

    entries.push(entry);
  });

  if (entries.length === 0) {
    throw new Error(`NCAA ${options.source.toUpperCase()} page did not include ranked teams.`);
  }

  const updatedAt = normalizeDateForDisplay(extractNcaaModifiedAt(rawHtml));
  return { updatedAt, entries };
}

function extractNcaaModifiedAt(rawHtml: string): string | null {
  const match = rawHtml.match(/"article_modified_time":"([^"]+)"/i);
  return match?.[1] ?? null;
}

function normalizeDateForDisplay(value: string | null): string | null {
  const clean = cleanText(value);
  if (!clean) {
    return null;
  }

  const normalized = clean.replace(/^(\d{4}-\d{2}-\d{2})t/i, "$1T");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return clean;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(parsed);
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const clean = cleanText(value);
  if (!clean || clean === "-" || clean === "—") {
    return null;
  }
  return clean;
}

function resolveRankingLogoUrl(teamName: string | null | undefined, alternateName: string | null | undefined): string | null {
  const primary = getBrandingLogoUrl(cleanText(teamName));
  if (primary) {
    return primary;
  }

  return getBrandingLogoUrl(cleanText(alternateName));
}

function cleanLogoUrl(value: string | null | undefined): string | null {
  const clean = cleanText(value);
  return clean || null;
}
