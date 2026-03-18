import { describe, expect, it } from "vitest";
import {
  parseSidearmLiveDashboard,
  parseSidearmLiveGameStatus,
  parseSidearmSiteConfig,
} from "../src/scrapers/sidearm-live";

describe("parseSidearmSiteConfig", () => {
  it("extracts the folder and sport from a Sidearm summary page", () => {
    const html = `
      <script>
        window.client_shortname = "quinnipiac";
        window.livestats_foldername = "quinnipiac";
      </script>
    `;

    expect(parseSidearmSiteConfig(html, "https://gobobcats.com/sidearmstats/baseball/summary")).toEqual({
      folder: "quinnipiac",
      sport: "baseball",
    });
  });

  it("prefers livestats_foldername over client_shortname when both are present", () => {
    const html = `
      <script>
        window.client_shortname = "brownuni";
        window.livestats_foldername = "brown";
      </script>
    `;

    expect(parseSidearmSiteConfig(html, "https://brownbears.com/sidearmstats/baseball/")).toEqual({
      folder: "brown",
      sport: "baseball",
    });
  });
});

describe("parseSidearmLiveGameStatus", () => {
  it("derives a top-inning label from the visiting batting team", () => {
    expect(
      parseSidearmLiveGameStatus({
        Game: {
          HasStarted: true,
          IsComplete: false,
          Period: 3,
          Location: "Hamden, Conn.",
          Situation: {
            BattingTeam: "VisitingTeam",
            Inning: 3,
          },
          HomeTeam: { Score: 1 },
          VisitingTeam: { Score: 2 },
        },
      })
    ).toEqual({
      statusText: "Top 3",
      inProgress: true,
      isOver: false,
      roadScore: 2,
      homeScore: 1,
      location: "Hamden, Conn.",
    });
  });

  it("derives a bottom-inning label from a fractional inning value", () => {
    expect(
      parseSidearmLiveGameStatus({
        Game: {
          HasStarted: true,
          IsComplete: false,
          Period: 3.5,
          Location: "Bronx, NY",
          Situation: {
            BattingTeam: "HomeTeam",
            Inning: 3.5,
          },
          HomeTeam: { Score: 2 },
          VisitingTeam: { Score: 0 },
        },
      })
    ).toEqual({
      statusText: "Bot 3",
      inProgress: true,
      isOver: false,
      roadScore: 0,
      homeScore: 2,
      location: "Bronx, NY",
    });
  });
});

describe("parseSidearmLiveDashboard", () => {
  it("maps a Sidearm live payload into the shared dashboard shape", () => {
    const parsed = parseSidearmLiveDashboard(
      {
        Game: {
          HasStarted: true,
          IsComplete: false,
          DateUTC: "2026-03-18T18:00:00Z",
          StartTime: "2:00 PM",
          Location: "Hamden, Conn.",
          GlobalSportShortname: "baseball",
          Period: 3,
          HomeTeam: {
            Name: "Quinnipiac",
            Score: 0,
            PeriodScores: [0, 0, 0],
            BatOrder: [
              {
                Player: {
                  Team: "HomeTeam",
                  FirstName: "Caden",
                  LastName: "Williamson",
                  UniformNumber: "7",
                },
                Position: "cf",
              },
            ],
          },
          VisitingTeam: {
            Name: "Yale",
            Score: 1,
            PeriodScores: [1, 0, 0],
            BatOrder: [
              {
                Player: {
                  Team: "VisitingTeam",
                  FirstName: "Bryce",
                  LastName: "Miller",
                  UniformNumber: "12",
                },
                Position: "c",
              },
              {
                Player: {
                  Team: "VisitingTeam",
                  FirstName: "Garrett",
                  LastName: "Larsen",
                  UniformNumber: "1",
                },
                Position: "cf",
              },
            ],
          },
          Situation: {
            BattingTeam: "VisitingTeam",
            Pitcher: {
              Team: "HomeTeam",
              FirstName: "Kevin",
              LastName: "Rusinak",
              UniformNumber: "18",
            },
            PitcherPitchCount: 25,
            Batter: {
              Team: "VisitingTeam",
              FirstName: "Bryce",
              LastName: "Miller",
              UniformNumber: "12",
            },
            OnDeck: {
              Team: "VisitingTeam",
              FirstName: "Garrett",
              LastName: "Larsen",
              UniformNumber: "1",
            },
            OnFirst: {
              Team: "VisitingTeam",
              FirstName: "Bryce",
              LastName: "Miller",
              UniformNumber: "12",
            },
            Balls: 1,
            Strikes: 2,
            Outs: 1,
            Inning: 3,
          },
        },
        Plays: [
          {
            Player: {
              Team: "VisitingTeam",
              FirstName: "Bryce",
              LastName: "Miller",
              UniformNumber: "12",
            },
            InvolvedPlayers: [
              {
                Team: "HomeTeam",
                FirstName: "Kevin",
                LastName: "Rusinak",
                UniformNumber: "18",
              },
            ],
            Team: "VisitingTeam",
            Narrative: "Bryce Miller hit by pitch (0-0).",
            Context: "P: K. RUSINAK; B: B. MILLER",
            Id: "0+8F405B5F",
            Type: "Hit by Pitch",
            Action: "Hit by Pitch",
            Period: 1,
          },
          {
            Player: {
              Team: "VisitingTeam",
              FirstName: "Garrett",
              LastName: "Larsen",
              UniformNumber: "1",
            },
            InvolvedPlayers: [
              {
                Team: "HomeTeam",
                FirstName: "Kevin",
                LastName: "Rusinak",
                UniformNumber: "18",
              },
              {
                Team: "VisitingTeam",
                FirstName: "Bryce",
                LastName: "Miller",
                UniformNumber: "12",
              },
            ],
            Team: "VisitingTeam",
            Narrative: "Garrett Larsen stole second; Bryce Miller scored.",
            Context: "P: K. RUSINAK; B: B. MILLER; B. MILLER on first; 1 out",
            Id: "1+8F405B5F",
            Type: "Advanced",
            Action: "Steal",
            Period: 1,
            Score: {
              VisitingTeam: 1,
              HomeTeam: 0,
            },
          },
          {
            Team: "VisitingTeam",
            Narrative: "1 Runs, 0 Hits, 0 Errors, 0 Left on Base",
            Context: "Summary, Top of 1st",
            Id: "2+8F405B5F",
            Type: "Summary",
            Period: 1,
          },
        ],
        Stats: {
          HomeTeam: {
            Totals: {
              Values: {
                Runs: "0",
                Hits: "0",
                Errors: "0",
                LeftOnBase: "0",
              },
            },
            PlayerGroups: {
              Batting: {
                Values: [
                  {
                    Uni: "7",
                    Name: "C. WILLIAMSON",
                    Position: "CF",
                    AtBats: "1",
                    Hits: "0",
                    Avg: ".280",
                  },
                ],
              },
              BattingSeason: {
                Values: [
                  {
                    Uni: "7",
                    Name: "C. WILLIAMSON",
                    Avg: ".320",
                  },
                ],
              },
            },
            PeriodStats: [
              {
                Values: {
                  Runs: "0",
                  Hits: "0",
                  Errors: "0",
                },
              },
            ],
          },
          VisitingTeam: {
            Totals: {
              Values: {
                Runs: "1",
                Hits: "0",
                Errors: "0",
                LeftOnBase: "0",
              },
            },
            PlayerGroups: {
              Batting: {
                Values: [
                  {
                    Uni: "12",
                    Name: "B. MILLER",
                    Position: "C",
                    AtBats: "2",
                    Hits: "1",
                    Strikeouts: "1",
                    Avg: ".250",
                  },
                  {
                    Uni: "1",
                    Name: "G. LARSEN",
                    Position: "CF",
                    AtBats: "1",
                    Hits: "0",
                    Strikeouts: "0",
                    Avg: ".300",
                  },
                ],
              },
              BattingSeason: {
                Values: [
                  {
                    Uni: "12",
                    Name: "B. MILLER",
                    Avg: ".273",
                  },
                  {
                    Uni: "1",
                    Name: "G. LARSEN",
                    Avg: ".392",
                  },
                ],
              },
            },
            PeriodStats: [
              {
                Values: {
                  Runs: "1",
                  Hits: "0",
                  Errors: "0",
                },
              },
            ],
          },
        },
      },
      "https://gobobcats.com/sidearmstats/baseball/summary",
      "2026-03-18T18:30:00Z"
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.summary.statusText).toBe("Top 3");
    expect(parsed?.summary.visitorTeam).toBe("Yale");
    expect(parsed?.summary.homeTeam).toBe("Quinnipiac");
    expect(parsed?.summary.situation?.batter?.name).toBe("Bryce Miller");
    expect(parsed?.summary.situation?.pitcher?.name).toBe("Kevin Rusinak");
    expect(parsed?.summary.lineScore?.rows[0]?.totals.r).toBe(1);
    expect(parsed?.plays).toHaveLength(2);
    expect(parsed?.plays[0]?.awayScore).toBe(0);
    expect(parsed?.plays[1]?.awayScore).toBe(1);
    expect(parsed?.plays[1]?.outsAfterPlay).toBe(1);
    expect(parsed?.lineupsSections[0]?.title).toBe("Yale Batting Order");
    expect(parsed?.lineupsSections[0]?.tables[0]?.rows[0]?.cells).toEqual([
      1,
      "12 Bryce Miller",
      "c",
      "1-2, 1 K",
      ".273",
    ]);
  });
});
