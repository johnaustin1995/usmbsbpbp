import { describe, expect, it } from "vitest";
import { isRecentScoresPayload, mergePrimaryScoresIntoFallback } from "../src/utils/merge-primary-scores";
import type { D1ScoresPayload } from "../src/types";

describe("mergePrimaryScoresIntoFallback", () => {
  it("preserves primary live inning text for a non-statbroadcast fallback game", () => {
    const fallback: D1ScoresPayload = {
      date: "20260318",
      sourceUpdatedAt: "2026-03-18T19:08:20.000Z",
      games: [
        {
          key: "fallback-yale-quinnipiac",
          conferenceIds: ["maac", "ivy"],
          conferenceNames: ["MAAC", "Ivy"],
          statusText: "1 - 0",
          matchupTimeEpoch: null,
          matchupTimeIso: null,
          inProgress: true,
          isOver: false,
          location: null,
          roadTeam: {
            id: 146290,
            name: "Yale",
            record: "8-5",
            rank: null,
            score: 1,
            logoUrl: null,
            teamUrl: null,
            searchTokens: [],
          },
          homeTeam: {
            id: 145660,
            name: "Quinnipiac",
            record: "5-11",
            rank: null,
            score: 0,
            logoUrl: null,
            teamUrl: null,
            searchTokens: [],
          },
          links: [],
          liveStatsUrl: "https://gobobcats.com/sidearmstats/baseball/summary",
          statbroadcastId: null,
          statbroadcastQuery: {},
        },
      ],
    };

    const primary: D1ScoresPayload = {
      date: "20260318",
      sourceUpdatedAt: "2026-03-18T19:09:12.000Z",
      games: [
        {
          key: "primary-yale-quinnipiac",
          conferenceIds: ["maac", "ivy"],
          conferenceNames: ["MAAC", "Ivy"],
          statusText: "Top 1",
          matchupTimeEpoch: 1773862080,
          matchupTimeIso: "2026-03-18T18:08:00.000Z",
          inProgress: true,
          isOver: false,
          location: "Hamden, Conn.",
          roadTeam: {
            id: 146290,
            name: "Yale",
            record: "8-5",
            rank: null,
            score: 1,
            logoUrl: "https://example.com/yale.svg",
            teamUrl: "https://d1baseball.com/team/yale/2026/",
            searchTokens: ["yale"],
          },
          homeTeam: {
            id: 145660,
            name: "Quinnipiac",
            record: "5-11",
            rank: null,
            score: 0,
            logoUrl: "https://example.com/quinnipiac.svg",
            teamUrl: "https://d1baseball.com/team/quinnipiac/2026/",
            searchTokens: ["quinnipiac"],
          },
          links: [
            {
              label: "Box Score",
              url: "https://gobobcats.com/sidearmstats/baseball/summary",
            },
          ],
          liveStatsUrl: "https://gobobcats.com/sidearmstats/baseball/summary",
          statbroadcastId: null,
          statbroadcastQuery: {},
        },
      ],
    };

    const merged = mergePrimaryScoresIntoFallback(fallback, primary);

    expect(merged.sourceUpdatedAt).toBe(primary.sourceUpdatedAt);
    expect(merged.games[0]?.statusText).toBe("Top 1");
    expect(merged.games[0]?.matchupTimeIso).toBe("2026-03-18T18:08:00.000Z");
    expect(merged.games[0]?.location).toBe("Hamden, Conn.");
    expect(merged.games[0]?.links).toEqual(primary.games[0]?.links);
  });
});

describe("isRecentScoresPayload", () => {
  it("accepts recently updated payloads and rejects stale ones", () => {
    expect(
      isRecentScoresPayload(
        { date: "20260318", sourceUpdatedAt: "2026-03-18T19:09:00.000Z", games: [] },
        Date.parse("2026-03-18T19:12:00.000Z"),
        5 * 60_000
      )
    ).toBe(true);

    expect(
      isRecentScoresPayload(
        { date: "20260318", sourceUpdatedAt: "2026-03-18T18:59:00.000Z", games: [] },
        Date.parse("2026-03-18T19:12:00.000Z"),
        5 * 60_000
      )
    ).toBe(false);
  });
});
