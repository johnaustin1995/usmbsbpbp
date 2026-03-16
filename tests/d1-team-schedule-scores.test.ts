import { describe, expect, it } from "vitest";
import { parseD1TeamScheduleScoresHtml } from "../src/scrapers/d1";
import type { D1TeamSeasonData } from "../src/types";

describe("parseD1TeamScheduleScoresHtml", () => {
  it("builds a game card from a team schedule tile with statbroadcast", () => {
    const alabama: D1TeamSeasonData = {
      id: 145427,
      name: "Alabama",
      slug: "alabama",
      season: "2026",
      conference: {
        id: 3,
        name: "SEC",
        slug: "sec",
        url: "https://d1baseball.com/conference/sec/",
      },
      logoUrl: "https://cdn.example.com/alabama.svg",
      teamUrl: "https://d1baseball.com/team/alabama/",
      scheduleUrl: "https://d1baseball.com/team/alabama/schedule/",
      statsUrl: "https://d1baseball.com/team/alabama/stats/",
      schedule: [
        {
          scheduleId: "prev-win",
          dateLabel: "Saturday, Mar 14",
          dateUrl: "https://d1baseball.com/scores/?date=20260314",
          locationType: null,
          opponentName: "Auburn",
          opponentSlug: "auburn",
          opponentUrl: "https://d1baseball.com/team/auburn/",
          opponentLogoUrl: null,
          resultText: "W, 5-2",
          resultUrl: null,
          outcome: "win",
          notes: null,
          columns: {},
        },
        {
          scheduleId: "current",
          dateLabel: "Sunday, Mar 15",
          dateUrl: "https://d1baseball.com/scores/?date=20260315",
          locationType: null,
          opponentName: "Kentucky",
          opponentSlug: "kentucky",
          opponentUrl: "https://d1baseball.com/team/kentucky/",
          opponentLogoUrl: null,
          resultText: null,
          resultUrl: null,
          outcome: "unknown",
          notes: null,
          columns: {},
        },
      ],
      statsTables: [],
      errors: [],
    };

    const kentucky: D1TeamSeasonData = {
      id: 145751,
      name: "Kentucky",
      slug: "kentucky",
      season: "2026",
      conference: {
        id: 3,
        name: "SEC",
        slug: "sec",
        url: "https://d1baseball.com/conference/sec/",
      },
      logoUrl: "https://cdn.example.com/kentucky.svg",
      teamUrl: "https://d1baseball.com/team/kentucky/",
      scheduleUrl: "https://d1baseball.com/team/kentucky/schedule/",
      statsUrl: "https://d1baseball.com/team/kentucky/stats/",
      schedule: [
        {
          scheduleId: "preseason",
          dateLabel: "Friday, Feb 13",
          dateUrl: "https://d1baseball.com/scores/?date=20260213",
          locationType: null,
          opponentName: "Campbell",
          opponentSlug: "campbell",
          opponentUrl: "https://d1baseball.com/team/campbell/",
          opponentLogoUrl: null,
          resultText: "W, 6-2",
          resultUrl: null,
          outcome: "win",
          notes: null,
          columns: {},
        },
      ],
      statsTables: [],
      errors: [],
    };

    const html = `
      <div
        class="d1-score-tile d1-team-schedule-tile winner"
        data-matchup="632555"
        data-home-name="Kentucky"
        data-road-name="Alabama"
      >
        <div class="box-score-header scoresclear">
          <h5><span>W</span>4 - 3</h5>
          <div class="box-score-links">
            <a target="_blank" href="https://stats.statbroadcast.com/broadcast/?id=632555">Box Score</a>
          </div>
        </div>
        <div class="team team-1" data-search="kentucky wildcats" data-team-id="145751">
          <h5 class="team-location">@</h5>
          <a class="team-logo" href="https://d1baseball.com/team/kentucky/schedule/">
            <img src="https://cdn.example.com/kentucky.svg">
          </a>
          <a class="team-title" href="https://d1baseball.com/team/kentucky/schedule/">
            <h5>Kentucky<small>(18-3, 4-1 SEC)</small></h5>
          </a>
          <h5 class="team-score">
            <a href="/scores/?date=20260315">Sunday, Mar 15<br>@ 1:00 PM</a>
          </h5>
        </div>
        <div class="box-score-footer scoresclear">
          <p>Lexington, Ky.</p>
        </div>
      </div>
      <div
        class="d1-score-tile d1-team-schedule-tile"
        data-matchup="other"
        data-home-name="Alabama"
        data-road-name="Auburn"
      >
        <div class="team team-1" data-team-id="145999">
          <a class="team-title" href="https://d1baseball.com/team/auburn/schedule/"><h5>Auburn</h5></a>
          <h5 class="team-score"><a href="/scores/?date=20260316">Monday, Mar 16<br>@ 6:00 PM</a></h5>
        </div>
      </div>
    `;

    const games = parseD1TeamScheduleScoresHtml(html, alabama, "20260315", [alabama, kentucky]);

    expect(games).toHaveLength(1);
    expect(games[0].key).toBe("schedule-632555");
    expect(games[0].roadTeam.name).toBe("Alabama");
    expect(games[0].roadTeam.record).toBe("1-0");
    expect(games[0].homeTeam.name).toBe("Kentucky");
    expect(games[0].roadTeam.score).toBe(4);
    expect(games[0].homeTeam.score).toBe(3);
    expect(games[0].homeTeam.record).toBe("18-3");
    expect(games[0].statbroadcastId).toBe(632555);
    expect(games[0].statusText).toBe("Final");
    expect(games[0].conferenceNames).toEqual(["SEC"]);
  });
});
