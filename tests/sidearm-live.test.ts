import { describe, expect, it } from "vitest";
import { parseSidearmLiveGameStatus, parseSidearmSiteConfig } from "../src/scrapers/sidearm-live";

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
