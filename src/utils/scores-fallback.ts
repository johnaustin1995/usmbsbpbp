import type { D1ScoresPayload } from "../types";

export interface ScoresFallbackCandidate {
  source: "teams-file" | "team-directory";
  payload: D1ScoresPayload;
  freshnessTier: number;
  recordCoverage: number;
  recordCount: number;
  totalTeams: number;
}

export function buildScoresFallbackCandidate(input: {
  source: "teams-file" | "team-directory";
  payload: D1ScoresPayload;
  fetchedAt?: string | null;
  requestedDate: string;
}): ScoresFallbackCandidate {
  const recordCount = countPayloadRecords(input.payload);
  const totalTeams = input.payload.games.length * 2;
  const recordCoverage = totalTeams > 0 ? recordCount / totalTeams : 0;

  return {
    source: input.source,
    payload: input.payload,
    freshnessTier:
      input.source === "teams-file"
        ? isTeamsPayloadFreshForDate(input.fetchedAt ?? null, input.requestedDate)
          ? 2
          : 0
        : 1,
    recordCoverage,
    recordCount,
    totalTeams,
  };
}

export function chooseBestScoresFallback(
  candidates: ScoresFallbackCandidate[]
): ScoresFallbackCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort(compareScoresFallbackCandidates)[0] ?? null;
}

export function isTeamsPayloadFreshForDate(
  fetchedAt: string | null | undefined,
  requestedDate: string
): boolean {
  const fetchedDate = isoToScoreDate(fetchedAt);
  if (!fetchedDate) {
    return false;
  }

  return fetchedDate >= requestedDate;
}

function compareScoresFallbackCandidates(
  left: ScoresFallbackCandidate,
  right: ScoresFallbackCandidate
): number {
  if (left.freshnessTier !== right.freshnessTier) {
    return right.freshnessTier - left.freshnessTier;
  }

  if (left.recordCoverage !== right.recordCoverage) {
    return right.recordCoverage - left.recordCoverage;
  }

  if (left.payload.games.length !== right.payload.games.length) {
    return right.payload.games.length - left.payload.games.length;
  }

  if (left.recordCount !== right.recordCount) {
    return right.recordCount - left.recordCount;
  }

  return 0;
}

function countPayloadRecords(payload: D1ScoresPayload): number {
  return payload.games.reduce(
    (count, game) => count + (game.roadTeam.record ? 1 : 0) + (game.homeTeam.record ? 1 : 0),
    0
  );
}

function isoToScoreDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}
