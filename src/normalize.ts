import {
  type D1GameWithLive,
  type FrontendGameCard,
  type FrontendGamePhase,
  type FrontendLiveSummary,
  type FrontendScoresFeed,
  type FrontendTeam,
  type FrontendTickerItem,
  type StatBroadcastLiveSummary,
} from "./types";

export function buildFrontendScoresFeed(
  date: string,
  updatedAt: string | null,
  games: D1GameWithLive[]
): FrontendScoresFeed {
  const cards = games.map(normalizeGameCard);
  const ticker = cards.map(cardToTickerItem);

  return {
    date,
    updatedAt,
    totalGames: cards.length,
    cards,
    ticker,
  };
}

export function normalizeLiveSummary(live: StatBroadcastLiveSummary): FrontendLiveSummary {
  const phase = inferPhase({ isOver: live.event.completed, inProgress: true, status: live.statusText });

  const awayTeam = normalizeLiveTeam({
    side: "away",
    name: live.visitorTeam,
    score: live.visitorScore,
    otherScore: live.homeScore,
    phase,
  });

  const homeTeam = normalizeLiveTeam({
    side: "home",
    name: live.homeTeam,
    score: live.homeScore,
    otherScore: live.visitorScore,
    phase,
  });

  return {
    id: live.id,
    title: live.event.title,
    phase,
    status: normalizeStatus(phase, live.statusText),
    teams: [awayTeam, homeTeam],
    lineScore: live.lineScore,
    situation: live.situation,
    thisInning: live.thisInning,
    fetchedAt: live.fetchedAt,
  };
}

export function normalizeGameCard(game: D1GameWithLive): FrontendGameCard {
  const phase = inferPhase({
    isOver: game.isOver || game.live?.event.completed === true,
    inProgress: game.inProgress,
    status: game.live?.statusText ?? game.statusText,
  });

  const status = normalizeStatus(phase, game.live?.statusText ?? game.statusText);
  const awayScore = firstDefinedNumber(game.live?.visitorScore, game.roadTeam.score);
  const homeScore = firstDefinedNumber(game.live?.homeScore, game.homeTeam.score);

  const awayTeam = normalizeTeam({
    side: "away",
    name: game.roadTeam.name,
    rank: game.roadTeam.rank,
    score: awayScore,
    logoUrl: game.roadTeam.logoUrl,
    teamUrl: game.roadTeam.teamUrl,
    otherScore: homeScore,
    phase,
  });

  const homeTeam = normalizeTeam({
    side: "home",
    name: game.homeTeam.name,
    rank: game.homeTeam.rank,
    score: homeScore,
    logoUrl: game.homeTeam.logoUrl,
    teamUrl: game.homeTeam.teamUrl,
    otherScore: awayScore,
    phase,
  });

  const displayTime =
    phase === "upcoming"
      ? game.matchupTimeIso
      : status;

  return {
    id: game.key,
    key: game.key,
    phase,
    status,
    displayTime,
    startTimeEpoch: game.matchupTimeEpoch,
    startTimeIso: game.matchupTimeIso,
    location: game.location,
    conferences: game.conferenceNames,
    statbroadcastId: game.statbroadcastId,
    liveStatsUrl: game.liveStatsUrl,
    teams: [awayTeam, homeTeam],
    hasAnyScore: awayScore !== null || homeScore !== null,
    liveSituation: game.live?.situation ?? null,
    liveError: game.liveError,
  };
}

function cardToTickerItem(card: FrontendGameCard): FrontendTickerItem {
  const away = card.teams[0];
  const home = card.teams[1];

  const scorePart =
    away.score !== null && home.score !== null
      ? `${away.shortName} ${away.score} at ${home.shortName} ${home.score}`
      : `${away.shortName} at ${home.shortName}`;

  const text = `${scorePart} • ${card.status}`;

  return {
    id: card.id,
    phase: card.phase,
    text,
    status: card.status,
    statbroadcastId: card.statbroadcastId,
    liveStatsUrl: card.liveStatsUrl,
  };
}

function normalizeTeam(input: {
  side: "away" | "home";
  name: string;
  rank: number | null;
  score: number | null;
  logoUrl: string | null;
  teamUrl: string | null;
  otherScore: number | null;
  phase: FrontendGamePhase;
}): FrontendTeam {
  return {
    side: input.side,
    name: input.name,
    shortName: shortTeamName(input.name),
    rank: input.rank,
    score: input.score,
    logoUrl: input.logoUrl,
    teamUrl: input.teamUrl,
    isWinner:
      (input.phase === "live" || input.phase === "final") &&
      input.score !== null &&
      input.otherScore !== null &&
      input.score > input.otherScore,
  };
}

function normalizeLiveTeam(input: {
  side: "away" | "home";
  name: string;
  score: number | null;
  otherScore: number | null;
  phase: FrontendGamePhase;
}): FrontendTeam {
  return {
    side: input.side,
    name: input.name,
    shortName: shortTeamName(input.name),
    rank: extractRank(input.name),
    score: input.score,
    logoUrl: null,
    teamUrl: null,
    isWinner:
      (input.phase === "live" || input.phase === "final") &&
      input.score !== null &&
      input.otherScore !== null &&
      input.score > input.otherScore,
  };
}

function inferPhase(input: {
  isOver: boolean;
  inProgress: boolean;
  status: string | null;
}): FrontendGamePhase {
  const status = (input.status ?? "").toLowerCase();

  if (
    input.isOver ||
    status.includes("final") ||
    status.includes("f/") ||
    status.includes("completed")
  ) {
    return "final";
  }

  if (
    input.inProgress ||
    status.includes("top ") ||
    status.includes("bot ") ||
    status.includes("middle ") ||
    status.includes("end ") ||
    status.includes("live")
  ) {
    return "live";
  }

  return "upcoming";
}

function normalizeStatus(phase: FrontendGamePhase, status: string | null): string {
  const clean = (status ?? "").replace(/\s+/g, " ").trim();
  if (clean.length > 0) {
    if (phase === "final" && !clean.toLowerCase().includes("final")) {
      return `Final (${clean})`;
    }

    return clean;
  }

  if (phase === "final") {
    return "Final";
  }

  if (phase === "live") {
    return "Live";
  }

  return "Scheduled";
}

function firstDefinedNumber(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function shortTeamName(name: string): string {
  const withoutRank = name.replace(/^#\d+\s+/, "").trim();
  return withoutRank;
}

function extractRank(name: string): number | null {
  const match = name.match(/^#(\d+)\b/);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}
