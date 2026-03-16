import { describe, expect, it } from "vitest";
import { buildFrontendScoresFeed, normalizeLiveSummary } from "../src/normalize";
import type { D1GameWithLive, D1RankingsPayload, StatBroadcastLiveSummary } from "../src/types";

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
          record: "5-1",
          rank: 21,
          score: 2,
          logoUrl: null,
          teamUrl: null,
          searchTokens: [],
        },
        homeTeam: {
          id: 2,
          name: "Houston",
          record: "4-2",
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
    expect(frontend.cards[0].teams[0].record).toBe("5-1");
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

  it("swaps SVG scoreboard logos for branding logos that iOS can render", () => {
    const ncaaSvgLogo = "https://www.ncaa.com/sites/default/files/images/logos/schools/bgl/alabama.svg";
    const games: D1GameWithLive[] = [
      {
        key: "game-2",
        conferenceIds: ["sec"],
        conferenceNames: ["SEC"],
        statusText: "Scheduled",
        matchupTimeEpoch: 1770973200,
        matchupTimeIso: "2026-02-13T15:00:00.000Z",
        inProgress: false,
        isOver: false,
        location: "Tuscaloosa, AL",
        roadTeam: {
          id: 1,
          name: "Alabama",
          record: "7-2",
          rank: null,
          score: null,
          logoUrl: ncaaSvgLogo,
          teamUrl: null,
          searchTokens: [],
        },
        homeTeam: {
          id: 2,
          name: "Auburn",
          record: "6-3",
          rank: null,
          score: null,
          logoUrl: null,
          teamUrl: null,
          searchTokens: [],
        },
        links: [],
        liveStatsUrl: null,
        statbroadcastId: null,
        statbroadcastQuery: {},
        live: null,
        liveError: null,
      },
    ];

    const frontend = buildFrontendScoresFeed("20260213", "2026-02-13T16:42:56.000Z", games);
    const logoUrl = frontend.cards[0].teams[0].logoUrl;

    expect(logoUrl).toBeTruthy();
    expect(logoUrl).not.toBe(ncaaSvgLogo);
    expect(logoUrl).not.toMatch(/\.svg(?:$|[?#])/i);
  });

  it("prefers D1 rankings page data for team rank values", () => {
    const games: D1GameWithLive[] = [
      {
        key: "game-3",
        conferenceIds: ["sec"],
        conferenceNames: ["SEC"],
        statusText: "Scheduled",
        matchupTimeEpoch: 1770973200,
        matchupTimeIso: "2026-02-13T15:00:00.000Z",
        inProgress: false,
        isOver: false,
        location: "Austin, TX",
        roadTeam: {
          id: 1,
          name: "Texas",
          record: "8-1",
          rank: null,
          score: null,
          logoUrl: null,
          teamUrl: "https://d1baseball.com/team/texas/",
          searchTokens: [],
        },
        homeTeam: {
          id: 2,
          name: "Houston",
          record: "7-2",
          rank: 18,
          score: null,
          logoUrl: null,
          teamUrl: "https://d1baseball.com/team/houston/",
          searchTokens: [],
        },
        links: [],
        liveStatsUrl: null,
        statbroadcastId: null,
        statbroadcastQuery: {},
        live: null,
        liveError: null,
      },
    ];
    const rankings: D1RankingsPayload = {
      sourceUpdatedAt: "March 9, 2026",
      teams: [
        {
          rank: 2,
          name: "Texas",
          slug: "texas",
          logoUrl: "https://cdn.d1baseball.com/logos/teams/128/texas.png",
          teamUrl: "https://d1baseball.com/team/texas/",
        },
      ],
    };

    const frontend = buildFrontendScoresFeed("20260213", "2026-02-13T16:42:56.000Z", games, rankings);

    expect(frontend.rankingsUpdatedAt).toBe("March 9, 2026");
    expect(frontend.cards[0].teams[0].rank).toBe(2);
    expect(frontend.cards[0].teams[1].rank).toBeNull();
  });

  it("does not expose placeholder start times for canceled games", () => {
    const games: D1GameWithLive[] = [
      {
        key: "game-4",
        conferenceIds: ["summit"],
        conferenceNames: ["Summit League"],
        statusText: "Canceled",
        matchupTimeEpoch: 1773705540,
        matchupTimeIso: "2026-03-16T23:59:00.000Z",
        inProgress: false,
        isOver: false,
        location: "Omaha, NE",
        roadTeam: {
          id: 1,
          name: "Maine",
          record: "4-11",
          rank: null,
          score: null,
          logoUrl: null,
          teamUrl: null,
          searchTokens: [],
        },
        homeTeam: {
          id: 2,
          name: "Omaha",
          record: "4-10",
          rank: null,
          score: null,
          logoUrl: null,
          teamUrl: null,
          searchTokens: [],
        },
        links: [],
        liveStatsUrl: null,
        statbroadcastId: null,
        statbroadcastQuery: {},
        live: null,
        liveError: null,
      },
    ];

    const frontend = buildFrontendScoresFeed("20260316", "2026-03-16T16:42:56.000Z", games);

    expect(frontend.cards[0].status).toBe("Canceled");
    expect(frontend.cards[0].displayTime).toBeNull();
    expect(frontend.cards[0].startTimeIso).toBeNull();
  });
});
