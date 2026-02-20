import { describe, expect, it } from "vitest";
import { buildFrontendScoresFeed, normalizeLiveSummary } from "../src/normalize";
import type { D1GameWithLive, StatBroadcastLiveSummary } from "../src/types";

describe("frontend normalization", () => {
  it("builds card and ticker entries", () => {
    const games: D1GameWithLive[] = [
      {
        key: "game-1",
        conferenceIds: ["top-25"],
        conferenceNames: ["Top 25"],
        statusText: "Top 7",
        matchupTimeEpoch: 1770973200,
        matchupTimeIso: "2026-02-13T15:00:00.000Z",
        inProgress: true,
        isOver: false,
        location: "Houston, TX",
        roadTeam: {
          id: 1,
          name: "Wake Forest",
          rank: 21,
          score: 2,
          logoUrl: null,
          teamUrl: null,
          searchTokens: [],
        },
        homeTeam: {
          id: 2,
          name: "Houston",
          rank: null,
          score: 6,
          logoUrl: null,
          teamUrl: null,
          searchTokens: [],
        },
        links: [],
        liveStatsUrl: "https://stats.statbroadcast.com/broadcast/?id=636528",
        statbroadcastId: 636528,
        statbroadcastQuery: {},
        live: null,
        liveError: null,
      },
    ];

    const frontend = buildFrontendScoresFeed("20260213", "2026-02-13 11:42:56 am", games);

    expect(frontend.totalGames).toBe(1);
    expect(frontend.cards[0].phase).toBe("live");
    expect(frontend.cards[0].teams[0].name).toBe("Wake Forest");
    expect(frontend.cards[0].teams[1].isWinner).toBe(true);
    expect(frontend.ticker[0].text).toContain("Wake Forest 2 at Houston 6");
  });

  it("normalizes live summary for UI", () => {
    const live: StatBroadcastLiveSummary = {
      id: 636528,
      event: {
        id: 636528,
        title: "Houston vs. Wake Forest",
        sport: "bsgame",
        xmlFile: "wake/636528.xml",
        date: "February 13, 2026",
        time: "9:30 AM CST",
        venue: null,
        location: null,
        homeName: "Houston",
        visitorName: "Wake Forest",
        completed: false,
      },
      statusText: "Top 7th",
      visitorTeam: "#21 Wake Forest",
      homeTeam: "Houston",
      visitorScore: 2,
      homeScore: 6,
      lineScore: null,
      situation: null,
      thisInning: {
        label: "Top 7th",
        runs: null,
        hits: null,
        errors: 0,
      },
      fetchedAt: "2026-02-13T16:51:14.806Z",
    };

    const frontendLive = normalizeLiveSummary(live);

    expect(frontendLive.phase).toBe("live");
    expect(frontendLive.teams[0].rank).toBe(21);
    expect(frontendLive.teams[1].isWinner).toBe(true);
    expect(frontendLive.status).toBe("Top 7th");
  });
});
