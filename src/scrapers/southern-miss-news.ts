import axios from "axios";
import { load } from "cheerio";
import { TtlCache } from "../utils/cache";
import { cleanText } from "../utils/text";

const DEFAULT_NEWS_URL = "https://southernmiss.com/sports/baseball";
const DEFAULT_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 5 * 60_000;

const BASE_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const cache = new TtlCache<string, SouthernMissNewsPayload>();

export interface SouthernMissNewsItem {
  title: string;
  url: string;
  path: string;
  dateLabel: string | null;
  sport: string | null;
  imageUrl: string | null;
  teaser: string | null;
}

export interface SouthernMissNewsPayload {
  sourceUrl: string;
  fetchedAt: string;
  pageTitle: string | null;
  total: number;
  items: SouthernMissNewsItem[];
}

export interface GetSouthernMissNewsOptions {
  url?: string | null;
  limit?: number | null;
  timeoutMs?: number;
  bypassCache?: boolean;
}

export async function getSouthernMissNews(options: GetSouthernMissNewsOptions = {}): Promise<SouthernMissNewsPayload> {
  const sourceUrl = cleanText(options.url ?? "") || DEFAULT_NEWS_URL;
  const cacheKey = sourceUrl;

  if (!options.bypassCache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return applyLimit(cached, options.limit);
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

  const itemsByUrl = new Map<string, SouthernMissNewsItem>();

  const storyCards = $(".c-stories__item");
  storyCards.each((_, node) => {
    const card = $(node);
    const linkNode = card.find("a.c-stories__link[href], a[href*='/news/']").first();
    const href = cleanText(String(linkNode.attr("href") ?? ""));
    const absoluteUrl = toAbsoluteUrl(href, sourceUrl);
    if (!absoluteUrl || !isNewsUrl(absoluteUrl)) {
      return;
    }

    const titleText =
      cleanText(linkNode.find("span").first().text()) || cleanText(linkNode.text()) || inferTitleFromUrl(absoluteUrl) || "";
    if (!titleText) {
      return;
    }

    const dateLabel =
      cleanText(card.find(".s-icon-time").nextAll("span").first().text()) ||
      cleanText(card.find("time").first().text()) ||
      cleanText(card.find(".s-text-details").first().text()) ||
      null;
    const sport = cleanText(card.find(".c-stories__sport").first().text()) || null;
    const imageUrl = toAbsoluteUrl(cleanText(card.find("img").first().attr("src") || ""), sourceUrl);
    const teaser = cleanText(card.find("p").first().text()) || null;

    itemsByUrl.set(absoluteUrl, {
      title: titleText,
      url: absoluteUrl,
      path: safePathname(absoluteUrl),
      dateLabel,
      sport,
      imageUrl,
      teaser,
    });
  });

  if (itemsByUrl.size === 0) {
    $("a[href*='/news/']").each((_, node) => {
      const linkNode = $(node);
      const href = cleanText(String(linkNode.attr("href") ?? ""));
      const absoluteUrl = toAbsoluteUrl(href, sourceUrl);
      if (!absoluteUrl || !isNewsUrl(absoluteUrl) || itemsByUrl.has(absoluteUrl)) {
        return;
      }

      const titleText = cleanText(linkNode.text()) || inferTitleFromUrl(absoluteUrl) || "";
      if (!titleText) {
        return;
      }

      const card = linkNode.closest("article, li, div");
      const imageUrl = toAbsoluteUrl(cleanText(card.find("img").first().attr("src") || ""), sourceUrl);
      const dateLabel = cleanText(card.find("time").first().text()) || null;

      itemsByUrl.set(absoluteUrl, {
        title: titleText,
        url: absoluteUrl,
        path: safePathname(absoluteUrl),
        dateLabel,
        sport: null,
        imageUrl,
        teaser: null,
      });
    });
  }

  const payload: SouthernMissNewsPayload = {
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    pageTitle,
    total: itemsByUrl.size,
    items: [...itemsByUrl.values()],
  };

  cache.set(cacheKey, payload, CACHE_TTL_MS);
  return applyLimit(payload, options.limit);
}

function applyLimit(payload: SouthernMissNewsPayload, limitValue: number | null | undefined): SouthernMissNewsPayload {
  const limit = Number.isFinite(limitValue)
    ? Math.max(1, Math.min(50, Math.floor(Number(limitValue))))
    : null;

  if (!limit) {
    return payload;
  }

  return {
    ...payload,
    items: payload.items.slice(0, limit),
    total: payload.total,
  };
}

function toAbsoluteUrl(value: string | null | undefined, sourceUrl: string): string | null {
  const text = cleanText(value ?? "");
  if (!text) {
    return null;
  }

  try {
    return new URL(text, sourceUrl).toString();
  } catch {
    return null;
  }
}

function isNewsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\/news\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function safePathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function inferTitleFromUrl(value: string): string | null {
  try {
    const pathname = new URL(value).pathname;
    const parts = pathname.split("/").filter(Boolean);
    const slug = parts.length > 0 ? parts[parts.length - 1] : "";
    if (!slug) {
      return null;
    }

    const words = slug.split("-").map((part: string) => capitalize(part));
    return cleanText(words.join(" ")) || null;
  } catch {
    return null;
  }
}

function capitalize(value: string): string {
  if (!value) {
    return "";
  }

  return value[0].toUpperCase() + value.slice(1).toLowerCase();
}
