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

  it("keeps scheduled tiles upcoming and uses the first-pitch time as the status label", () => {
    const airForce: D1TeamSeasonData = {
      id: 144356,
      name: "Air Force",
      slug: "airforce",
      season: "2026",
      conference: {
        id: 18,
        name: "Mountain West",
        slug: "mountain-west",
        url: "https://d1baseball.com/conference/mountain-west/",
      },
      logoUrl: "https://cdn.example.com/airforce.svg",
      teamUrl: "https://d1baseball.com/team/airforce/",
      scheduleUrl: "https://d1baseball.com/team/airforce/schedule/",
      statsUrl: "https://d1baseball.com/team/airforce/stats/",
      schedule: [
        {
          scheduleId: "airforce-stthomas",
          dateLabel: "Monday, Mar 16",
          dateUrl: "https://d1baseball.com/scores/?date=20260316",
          locationType: "vs",
          opponentName: "St. Thomas",
          opponentSlug: "stthomas",
          opponentUrl: "https://d1baseball.com/team/stthomas/",
          opponentLogoUrl: null,
          resultText: null,
          resultUrl: null,
          outcome: "unknown",
          notes: "USAF Academy, CO",
          columns: {},
        },
      ],
      statsTables: [],
      errors: [],
    };

    const stThomas: D1TeamSeasonData = {
      id: 145901,
      name: "St. Thomas (MN)",
      slug: "stthomas",
      season: "2026",
      conference: {
        id: 31,
        name: "Summit League",
        slug: "summit",
        url: "https://d1baseball.com/conference/summit/",
      },
      logoUrl: "https://cdn.example.com/stthomas.svg",
      teamUrl: "https://d1baseball.com/team/stthomas/",
      scheduleUrl: "https://d1baseball.com/team/stthomas/schedule/",
      statsUrl: "https://d1baseball.com/team/stthomas/stats/",
      schedule: [],
      statsTables: [],
      errors: [],
    };

    const html = `
      <div
        class="d1-score-tile d1-team-schedule-tile in-progress"
        data-home-name="Air Force"
        data-road-name="St. Thomas"
      >
        <div class="box-score-header scoresclear">
          <h5></h5>
          <div class="box-score-links">
            <a target="_blank" href="https://stats.statbroadcast.com/broadcast/?id=629647">Box Score</a>
          </div>
        </div>
        <div class="team team-1" data-search="st. thomas" data-team-id="145901">
          <h5 class="team-location">vs</h5>
          <a class="team-title" href="https://d1baseball.com/team/stthomas/schedule/"><h5>St. Thomas</h5></a>
          <h5 class="team-score"><a href="/scores/?date=20260316">Monday, Mar 16<br>@ 3:00 PM</a></h5>
        </div>
        <div class="box-score-footer scoresclear">
          <p>USAF Academy, CO</p>
        </div>
      </div>
    `;

    const games = parseD1TeamScheduleScoresHtml(html, airForce, "20260316", [airForce, stThomas]);

    expect(games).toHaveLength(1);
    expect(games[0].statusText).toBe("3:00 PM");
    expect(games[0].inProgress).toBe(false);
    expect(games[0].isOver).toBe(false);
    expect(games[0].roadTeam.name).toBe("St. Thomas");
    expect(games[0].homeTeam.name).toBe("Air Force");
  });

  it("ignores score-like header text on upcoming tiles and keeps the first-pitch time", () => {
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
          scheduleId: "alabama-south-alabama",
          dateLabel: "Tuesday, Mar 17",
          dateUrl: "https://d1baseball.com/scores/?date=20260317",
          locationType: "@",
          opponentName: "South Alabama",
          opponentSlug: "salabama",
          opponentUrl: "https://d1baseball.com/team/salabama/",
          opponentLogoUrl: null,
          resultText: null,
          resultUrl: null,
          outcome: "unknown",
          notes: "Mobile, Ala. , Stanky Field",
          columns: {},
        },
      ],
      statsTables: [],
      errors: [],
    };

    const southAlabama: D1TeamSeasonData = {
      id: 145812,
      name: "South Alabama",
      slug: "salabama",
      season: "2026",
      conference: {
        id: 29,
        name: "Sun Belt",
        slug: "sun-belt",
        url: "https://d1baseball.com/conference/sun-belt/",
      },
      logoUrl: "https://cdn.example.com/south-alabama.svg",
      teamUrl: "https://d1baseball.com/team/salabama/",
      scheduleUrl: "https://d1baseball.com/team/salabama/schedule/",
      statsUrl: "https://d1baseball.com/team/salabama/stats/",
      schedule: [
        {
          scheduleId: "south-alabama-prev",
          dateLabel: "Sunday, Mar 15",
          dateUrl: "https://d1baseball.com/scores/?date=20260315",
          locationType: "vs",
          opponentName: "Troy",
          opponentSlug: "troy",
          opponentUrl: "https://d1baseball.com/team/troy/",
          opponentLogoUrl: null,
          resultText: "W, 6-2",
          resultUrl: null,
          outcome: "win",
          notes: "Mobile, Ala.",
          columns: {},
        },
      ],
      statsTables: [],
      errors: [],
    };

    const html = `
      <div
        class="d1-score-tile d1-team-schedule-tile"
        data-home-name="South Alabama"
        data-road-name="Alabama"
      >
        <div class="box-score-header scoresclear">
          <h5>2 - 0</h5>
          <div class="box-score-links">
            <a target="_blank" href="https://stats.statbroadcast.com/broadcast/?id=634643">Box Score</a>
          </div>
        </div>
        <div class="team team-1" data-search="alabama" data-team-id="145427">
          <h5 class="team-location">@</h5>
          <a class="team-title" href="https://d1baseball.com/team/alabama/schedule/"><h5>Alabama</h5></a>
          <h5 class="team-score"><a href="/scores/?date=20260317">Tuesday, Mar 17<br>@ 7:30 PM</a></h5>
        </div>
        <div class="box-score-footer scoresclear">
          <p>Mobile, Ala. , Stanky Field</p>
        </div>
      </div>
    `;

    const games = parseD1TeamScheduleScoresHtml(html, alabama, "20260317", [alabama, southAlabama]);

    expect(games).toHaveLength(1);
    expect(games[0].statusText).toBe("7:30 PM");
    expect(games[0].inProgress).toBe(false);
    expect(games[0].isOver).toBe(false);
    expect(games[0].roadTeam.name).toBe("Alabama");
    expect(games[0].homeTeam.name).toBe("South Alabama");
    expect(games[0].homeTeam.record).toBe("1-0");
  });

  it("treats in-progress tiles with score-like headers as live candidates", () => {
    const duke: D1TeamSeasonData = {
      id: 145500,
      name: "Duke",
      slug: "duke",
      season: "2026",
      conference: {
        id: 1,
        name: "ACC",
        slug: "acc",
        url: "https://d1baseball.com/conference/acc/",
      },
      logoUrl: "https://cdn.example.com/duke.svg",
      teamUrl: "https://d1baseball.com/team/duke/",
      scheduleUrl: "https://d1baseball.com/team/duke/schedule/",
      statsUrl: "https://d1baseball.com/team/duke/stats/",
      schedule: [
        {
          scheduleId: "duke-campbell",
          dateLabel: "Tuesday, Mar 17",
          dateUrl: "https://d1baseball.com/scores/?date=20260317",
          locationType: "@",
          opponentName: "Campbell",
          opponentSlug: "campbell",
          opponentUrl: "https://d1baseball.com/team/campbell/",
          opponentLogoUrl: null,
          resultText: null,
          resultUrl: null,
          outcome: "unknown",
          notes: "Buies Creek, N.C.",
          columns: {},
        },
      ],
      statsTables: [],
      errors: [],
    };

    const campbell: D1TeamSeasonData = {
      id: 145421,
      name: "Campbell",
      slug: "campbell",
      season: "2026",
      conference: {
        id: 9,
        name: "CAA",
        slug: "caa",
        url: "https://d1baseball.com/conference/caa/",
      },
      logoUrl: "https://cdn.example.com/campbell.svg",
      teamUrl: "https://d1baseball.com/team/campbell/",
      scheduleUrl: "https://d1baseball.com/team/campbell/schedule/",
      statsUrl: "https://d1baseball.com/team/campbell/stats/",
      schedule: [],
      statsTables: [],
      errors: [],
    };

    const html = `
      <div
        class="d1-score-tile d1-team-schedule-tile in-progress"
        data-home-name="Campbell"
        data-road-name="Duke"
      >
        <div class="box-score-header scoresclear">
          <h5>3 - 10</h5>
          <div class="box-score-links">
            <a target="_blank" href="https://stats.statbroadcast.com/broadcast/?id=630993">Box Score</a>
          </div>
        </div>
        <div class="team team-1" data-search="duke" data-team-id="145500">
          <h5 class="team-location">@</h5>
          <a class="team-title" href="https://d1baseball.com/team/duke/schedule/"><h5>Duke</h5></a>
          <h5 class="team-score"><a href="/scores/?date=20260317">Tuesday, Mar 17<br>@ 6:00 PM</a></h5>
        </div>
        <div class="box-score-footer scoresclear">
          <p>Buies Creek, N.C.</p>
        </div>
      </div>
    `;

    const games = parseD1TeamScheduleScoresHtml(html, duke, "20260317", [duke, campbell]);

    expect(games).toHaveLength(1);
    expect(games[0].statusText).toBe("3 - 10");
    expect(games[0].inProgress).toBe(true);
    expect(games[0].isOver).toBe(false);
    expect(games[0].statbroadcastId).toBe(630993);
  });

  it("uses canceled from the schedule row instead of a placeholder 11:59 PM time", () => {
    const maine: D1TeamSeasonData = {
      id: 145229,
      name: "Maine",
      slug: "maine",
      season: "2026",
      conference: {
        id: 2,
        name: "America East",
        slug: "america-east",
        url: "https://d1baseball.com/conference/america-east/",
      },
      logoUrl: "https://cdn.example.com/maine.svg",
      teamUrl: "https://d1baseball.com/team/maine/",
      scheduleUrl: "https://d1baseball.com/team/maine/schedule/",
      statsUrl: "https://d1baseball.com/team/maine/stats/",
      schedule: [
        {
          scheduleId: "maine-omaha",
          dateLabel: "Monday, Mar 16",
          dateUrl: "https://d1baseball.com/scores/?date=20260316",
          locationType: "@",
          opponentName: "Omaha",
          opponentSlug: "nebomaha",
          opponentUrl: "https://d1baseball.com/team/nebomaha/",
          opponentLogoUrl: null,
          resultText: null,
          resultUrl: null,
          outcome: "unknown",
          notes: "Canceled",
          columns: { notes: "Canceled" },
        },
      ],
      statsTables: [],
      errors: [],
    };

    const omaha: D1TeamSeasonData = {
      id: 145438,
      name: "Omaha",
      slug: "nebomaha",
      season: "2026",
      conference: {
        id: 31,
        name: "Summit League",
        slug: "summit",
        url: "https://d1baseball.com/conference/summit/",
      },
      logoUrl: "https://cdn.example.com/omaha.svg",
      teamUrl: "https://d1baseball.com/team/nebomaha/",
      scheduleUrl: "https://d1baseball.com/team/nebomaha/schedule/",
      statsUrl: "https://d1baseball.com/team/nebomaha/stats/",
      schedule: [],
      statsTables: [],
      errors: [],
    };

    const html = `
      <div
        class="d1-score-tile d1-team-schedule-tile in-progress"
        data-home-name="Omaha"
        data-road-name="Maine"
      >
        <div class="box-score-header scoresclear">
          <h5></h5>
        </div>
        <div class="team team-1" data-search="omaha" data-team-id="145438">
          <h5 class="team-location">@</h5>
          <a class="team-title" href="https://d1baseball.com/team/nebomaha/schedule/"><h5>Omaha</h5></a>
          <h5 class="team-score"><a href="/scores/?date=20260316">Monday, Mar 16<br>@ 11:59 PM</a></h5>
        </div>
        <div class="box-score-footer scoresclear">
          <p>Canceled</p>
        </div>
      </div>
    `;

    const games = parseD1TeamScheduleScoresHtml(html, maine, "20260316", [maine, omaha]);

    expect(games).toHaveLength(1);
    expect(games[0].statusText).toBe("Canceled");
    expect(games[0].inProgress).toBe(false);
    expect(games[0].isOver).toBe(false);
  });
});
