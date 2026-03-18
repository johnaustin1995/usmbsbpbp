import type { D1Game, D1ScoresPayload, TeamSnapshot } from "../types";

export function mergePrimaryScoresIntoFallback(
  fallbackPayload: D1ScoresPayload,
  primaryPayload: D1ScoresPayload
): D1ScoresPayload {
  const primaryByIdentity = buildPrimaryIdentityMap(primaryPayload.games);

  return {
    date: fallbackPayload.date,
    sourceUpdatedAt: primaryPayload.sourceUpdatedAt ?? fallbackPayload.sourceUpdatedAt,
    games: fallbackPayload.games.map((fallbackGame) => {
      const primaryGame = findMatchingPrimaryGame(primaryByIdentity, fallbackGame);
      if (!primaryGame) {
        return fallbackGame;
      }

      return {
        ...fallbackGame,
        statusText: primaryGame.statusText || fallbackGame.statusText,
        matchupTimeEpoch: primaryGame.matchupTimeEpoch ?? fallbackGame.matchupTimeEpoch,
        matchupTimeIso: primaryGame.matchupTimeIso ?? fallbackGame.matchupTimeIso,
        inProgress: primaryGame.inProgress,
        isOver: primaryGame.isOver,
        location: primaryGame.location ?? fallbackGame.location,
        roadTeam: mergeTeamSnapshot(fallbackGame.roadTeam, primaryGame.roadTeam),
        homeTeam: mergeTeamSnapshot(fallbackGame.homeTeam, primaryGame.homeTeam),
        links: primaryGame.links.length > 0 ? primaryGame.links : fallbackGame.links,
        liveStatsUrl: fallbackGame.liveStatsUrl ?? primaryGame.liveStatsUrl,
        statbroadcastId: fallbackGame.statbroadcastId ?? primaryGame.statbroadcastId,
        statbroadcastQuery:
          fallbackGame.statbroadcastId === null && primaryGame.statbroadcastId !== null
            ? primaryGame.statbroadcastQuery
            : fallbackGame.statbroadcastQuery,
      };
    }),
  };
}

export function isRecentScoresPayload(
  payload: D1ScoresPayload | null | undefined,
  now = Date.now(),
  maxAgeMs = 10 * 60_000
): boolean {
  if (!payload?.sourceUpdatedAt) {
    return false;
  }

  const updatedAt = new Date(payload.sourceUpdatedAt);
  if (Number.isNaN(updatedAt.getTime())) {
    return false;
  }

  return now - updatedAt.getTime() <= maxAgeMs;
}

function buildPrimaryIdentityMap(games: D1Game[]): Map<string, D1Game> {
  const byIdentity = new Map<string, D1Game>();

  for (const game of games) {
    for (const key of buildGameIdentityKeys(game)) {
      if (!byIdentity.has(key)) {
        byIdentity.set(key, game);
      }
    }
  }

  return byIdentity;
}

function findMatchingPrimaryGame(byIdentity: Map<string, D1Game>, game: D1Game): D1Game | null {
  for (const key of buildGameIdentityKeys(game)) {
    const match = byIdentity.get(key);
    if (match) {
      return match;
    }
  }

  return null;
}

function buildGameIdentityKeys(game: D1Game): string[] {
  const keys = new Set<string>();
  const roadId = teamIdentityPart(game.roadTeam);
  const homeId = teamIdentityPart(game.homeTeam);

  if (roadId && homeId) {
    keys.add(`teams:${roadId}:${homeId}`);
  }

  const normalizedRoad = normalizeTeamName(game.roadTeam.name);
  const normalizedHome = normalizeTeamName(game.homeTeam.name);
  if (normalizedRoad && normalizedHome) {
    keys.add(`names:${normalizedRoad}:${normalizedHome}`);
  }

  if (game.liveStatsUrl) {
    keys.add(`url:${normalizeUrl(game.liveStatsUrl)}`);
  }

  return Array.from(keys);
}

function teamIdentityPart(team: TeamSnapshot): string | null {
  if (team.id !== null && team.id !== undefined) {
    return `id:${team.id}`;
  }

  const normalizedUrl = normalizeUrl(team.teamUrl);
  if (normalizedUrl) {
    return `url:${normalizedUrl}`;
  }

  const normalizedName = normalizeTeamName(team.name);
  return normalizedName ? `name:${normalizedName}` : null;
}

function normalizeTeamName(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeUrl(value: string | null | undefined): string | null {
  const clean = String(value ?? "").trim().toLowerCase();
  return clean || null;
}

function mergeTeamSnapshot(fallbackTeam: TeamSnapshot, primaryTeam: TeamSnapshot): TeamSnapshot {
  return {
    ...fallbackTeam,
    record: fallbackTeam.record ?? primaryTeam.record,
    rank: fallbackTeam.rank ?? primaryTeam.rank,
    score: primaryTeam.score ?? fallbackTeam.score,
    logoUrl: fallbackTeam.logoUrl ?? primaryTeam.logoUrl,
    teamUrl: fallbackTeam.teamUrl ?? primaryTeam.teamUrl,
    searchTokens: fallbackTeam.searchTokens.length > 0 ? fallbackTeam.searchTokens : primaryTeam.searchTokens,
  };
}
