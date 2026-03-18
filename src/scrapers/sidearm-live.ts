import axios from "axios";
import { TtlCache } from "../utils/cache";
import { cleanText } from "../utils/text";

const SIDARM_STATS_BASE_URL = "https://sidearmstats.com";
const CACHE_TTL_MS = 15_000;
const configCache = new TtlCache<string, SidearmSiteConfig>();
const gameCache = new TtlCache<string, SidearmLiveGameStatus>();

interface SidearmSiteConfig {
  folder: string;
  sport: string;
}

interface SidearmGameResponse {
  Game?: {
    HasStarted?: boolean;
    IsComplete?: boolean;
    Period?: number | string | null;
    StartTime?: string | null;
    Location?: string | null;
    Situation?: {
      BattingTeam?: string | null;
      Inning?: number | string | null;
    } | null;
    HomeTeam?: {
      Score?: number | null;
    } | null;
    VisitingTeam?: {
      Score?: number | null;
    } | null;
  } | null;
}

export interface SidearmLiveGameStatus {
  statusText: string;
  inProgress: boolean;
  isOver: boolean;
  roadScore: number | null;
  homeScore: number | null;
  location: string | null;
}

export async function getSidearmLiveGameStatus(liveStatsUrl: string): Promise<SidearmLiveGameStatus | null> {
  const cacheKey = normalizeCacheKey(liveStatsUrl);
  if (!cacheKey) {
    return null;
  }

  const cached = gameCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const config = await getSidearmSiteConfig(liveStatsUrl);
  if (!config) {
    return null;
  }

  const endpoint = `${SIDARM_STATS_BASE_URL}/${config.folder}/${config.sport}/game.json`;
  const response = await axios.get<SidearmGameResponse>(endpoint, {
    params: { detail: "full" },
    timeout: 20_000,
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status >= 400 || !response.data?.Game) {
    return null;
  }

  const parsed = parseSidearmLiveGameStatus(response.data);
  if (!parsed) {
    return null;
  }

  gameCache.set(cacheKey, parsed, CACHE_TTL_MS);
  return parsed;
}

export function parseSidearmSiteConfig(rawHtml: string, liveStatsUrl: string): SidearmSiteConfig | null {
  const folderMatch = rawHtml.match(/window\.(?:livestats_foldername|client_shortname)\s*=\s*"([^"]+)"/i);
  const folder = cleanText(folderMatch?.[1] ?? "");
  if (!folder) {
    return null;
  }

  try {
    const parsed = new URL(liveStatsUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const sidearmIndex = segments.findIndex((segment) => segment.toLowerCase() === "sidearmstats");
    const sport = cleanText(segments[sidearmIndex + 1] ?? "");
    if (!sport) {
      return null;
    }

    return {
      folder,
      sport,
    };
  } catch {
    return null;
  }
}

export function parseSidearmLiveGameStatus(payload: SidearmGameResponse): SidearmLiveGameStatus | null {
  const game = payload.Game;
  if (!game) {
    return null;
  }

  const hasStarted = game.HasStarted === true;
  const isOver = game.IsComplete === true;
  const roadScore = toNullableNumber(game.VisitingTeam?.Score);
  const homeScore = toNullableNumber(game.HomeTeam?.Score);
  const location = cleanText(game.Location ?? "") || null;

  return {
    statusText: deriveSidearmStatusText(game),
    inProgress: hasStarted && !isOver,
    isOver,
    roadScore,
    homeScore,
    location,
  };
}

async function getSidearmSiteConfig(liveStatsUrl: string): Promise<SidearmSiteConfig | null> {
  const cacheKey = normalizeCacheKey(liveStatsUrl);
  if (!cacheKey) {
    return null;
  }

  const cached = configCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await axios.get<string>(liveStatsUrl, {
    timeout: 20_000,
    responseType: "text",
    transformResponse: [(value) => value],
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status >= 400) {
    return null;
  }

  const parsed = parseSidearmSiteConfig(String(response.data ?? ""), liveStatsUrl);
  if (!parsed) {
    return null;
  }

  configCache.set(cacheKey, parsed, CACHE_TTL_MS);
  return parsed;
}

function deriveSidearmStatusText(game: NonNullable<SidearmGameResponse["Game"]>): string {
  if (game.IsComplete === true) {
    return "Final";
  }

  if (game.HasStarted === true) {
    const battingTeam = cleanText(game.Situation?.BattingTeam ?? "").toLowerCase();
    const rawInning = toNullableNumber(game.Situation?.Inning) ?? toNullableNumber(game.Period);
    if (rawInning !== null) {
      const inningNumber = normalizeInningNumber(rawInning, battingTeam);
      if (inningNumber !== null) {
        if (battingTeam === "visitingteam") {
          return `Top ${inningNumber}`;
        }
        if (battingTeam === "hometeam") {
          return `Bot ${inningNumber}`;
        }
      }
    }

    return "Live";
  }

  const startTime = cleanText(game.StartTime ?? "");
  return startTime || "Scheduled";
}

function normalizeInningNumber(rawInning: number, battingTeam: string): number | null {
  if (!Number.isFinite(rawInning) || rawInning <= 0) {
    return null;
  }

  if (Number.isInteger(rawInning)) {
    return rawInning;
  }

  if (battingTeam === "hometeam") {
    return Math.floor(rawInning);
  }

  if (battingTeam === "visitingteam") {
    return Math.ceil(rawInning);
  }

  return Math.floor(rawInning);
}

function normalizeCacheKey(liveStatsUrl: string): string | null {
  try {
    return new URL(liveStatsUrl).toString();
  } catch {
    return null;
  }
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
