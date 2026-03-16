import { describe, expect, it } from "vitest";
import {
  buildScoresFallbackCandidate,
  chooseBestScoresFallback,
  isTeamsPayloadFreshForDate,
} from "../src/utils/scores-fallback";
import type { D1ScoresPayload } from "../src/types";

function createPayload(recordPairs: Array<[string | null, string | null]>): D1ScoresPayload {
  return {
    date: "20260315",
    sourceUpdatedAt: "2026-03-15T15:00:00.000Z",
    games: recordPairs.map(([awayRecord, homeRecord], index) => ({
      key: `game-${index}`,
      conferenceIds: [],
      conferenceNames: [],
      statusText: "Final",
      matchupTimeEpoch: null,
      matchupTimeIso: null,
      inProgress: false,
      isOver: true,
      location: null,
      roadTeam: {
        id: null,
        name: `Away ${index}`,
        record: awayRecord,
        rank: null,
        score: 1,
        logoUrl: null,
        teamUrl: null,
        searchTokens: [],
      },
      homeTeam: {
        id: null,
        name: `Home ${index}`,
        record: homeRecord,
        rank: null,
        score: 0,
        logoUrl: null,
        teamUrl: null,
        searchTokens: [],
      },
      links: [],
      liveStatsUrl: null,
      statbroadcastId: null,
      statbroadcastQuery: {},
    })),
  };
}

describe("scores fallback selection", () => {
  it("treats teams exports as stale when they predate the requested game date", () => {
    expect(isTeamsPayloadFreshForDate("2026-02-27T15:00:00.000Z", "20260315")).toBe(false);
    expect(isTeamsPayloadFreshForDate("2026-03-15T01:00:00.000Z", "20260315")).toBe(true);
  });

  it("prefers the directory fallback over a stale teams export", () => {
    const staleTeams = buildScoresFallbackCandidate({
      source: "teams-file",
      payload: createPayload([
        ["2-6", "1-7"],
        ["4-4", "5-4"],
      ]),
      fetchedAt: "2026-02-27T15:00:00.000Z",
      requestedDate: "20260315",
    });
    const directory = buildScoresFallbackCandidate({
      source: "team-directory",
      payload: createPayload([
        [null, null],
        [null, "10-8"],
      ]),
      requestedDate: "20260315",
    });

    expect(chooseBestScoresFallback([staleTeams, directory])?.source).toBe("team-directory");
  });

  it("prefers a fresh teams export when it matches the requested date", () => {
    const freshTeams = buildScoresFallbackCandidate({
      source: "teams-file",
      payload: createPayload([
        ["13-6", "10-9"],
        ["14-6", "15-7"],
      ]),
      fetchedAt: "2026-03-15T15:00:00.000Z",
      requestedDate: "20260315",
    });
    const directory = buildScoresFallbackCandidate({
      source: "team-directory",
      payload: createPayload([
        [null, null],
        [null, "10-8"],
      ]),
      requestedDate: "20260315",
    });

    expect(chooseBestScoresFallback([directory, freshTeams])?.source).toBe("teams-file");
  });
});
