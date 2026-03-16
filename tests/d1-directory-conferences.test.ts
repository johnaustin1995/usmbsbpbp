import { afterEach, describe, expect, it, vi } from "vitest";

const { mockedGet, mockedPost } = vi.hoisted(() => ({
  mockedGet: vi.fn(),
  mockedPost: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    get: mockedGet,
    post: mockedPost,
  },
}));

import { getD1ScoresFromTeamDirectory } from "../src/scrapers/d1";

describe("getD1ScoresFromTeamDirectory", () => {
  afterEach(() => {
    mockedGet.mockReset();
    mockedPost.mockReset();
  });

  it("preserves conference names on the team-directory fallback path", async () => {
    const directoryHtml = `
      <select name="conference">
        <option value="select">Select</option>
        <option value="3" data-target="/conference/sec/2026/">SEC</option>
      </select>
      <select name="team">
        <option value="select">Select</option>
        <option value="145427" data-target="/team/alabama/2026/">Alabama</option>
      </select>
    `;

    const conferenceHtml = `
      <div id="conference-standings">
        <table class="conference-standings-table">
          <tbody>
            <tr>
              <td class="team"><a href="/team/alabama/2026/">Alabama</a></td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    const scheduleHtml = `
      <div
        class="d1-score-tile d1-team-schedule-tile winner"
        data-matchup="632555"
        data-home-name="Kentucky"
        data-road-name="Alabama"
      >
        <div class="box-score-header scoresclear">
          <h5><span>W</span>4 - 3</h5>
          <div class="box-score-links">
            <a href="https://stats.statbroadcast.com/broadcast/?id=632555">Box Score</a>
          </div>
        </div>
        <div class="team team-1" data-team-id="145751">
          <h5 class="team-location">@</h5>
          <a class="team-title" href="https://d1baseball.com/team/kentucky/schedule/">
            <h5>Kentucky</h5>
          </a>
          <h5 class="team-score">
            <a href="/scores/?date=20260315">Sunday, Mar 15<br>@ 1:00 PM</a>
          </h5>
        </div>
        <div class="box-score-footer scoresclear">
          <p>Lexington, Ky.</p>
        </div>
      </div>
    `;

    const fullScheduleHtml = `
      <h1 class="single-team-title">Alabama</h1>
      <div id="team-header">
        <div class="team-logo">
          <img src="https://cdn.example.com/alabama.png">
        </div>
      </div>
      <table class="full-team-schedule">
        <thead>
          <tr>
            <th>Date</th>
            <th>Loc</th>
            <th>Opponent</th>
            <th>Result</th>
            <th>Info</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr data-schedule-id="prev-win">
            <td><a href="/scores/?date=20260314">Saturday, Mar 14</a></td>
            <td>A</td>
            <td>
              <a class="team-logo-name" href="/team/auburn/2026/">
                <span class="team-name">Auburn</span>
              </a>
            </td>
            <td class="win">W, 5-2</td>
            <td></td>
            <td></td>
          </tr>
          <tr data-schedule-id="current">
            <td><a href="/scores/?date=20260315">Sunday, Mar 15</a></td>
            <td>A</td>
            <td>
              <a class="team-logo-name" href="/team/kentucky/2026/">
                <span class="team-name">Kentucky</span>
              </a>
            </td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
        </tbody>
      </table>
    `;

    mockedGet.mockImplementation(async (url: string) => {
      if (url === "https://d1baseball.com/teams/") {
        return { status: 200, data: directoryHtml };
      }

      if (url === "https://d1baseball.com/conference/sec/2026/") {
        return { status: 200, data: conferenceHtml };
      }

      if (url === "https://d1baseball.com/team/alabama/2026/schedule/") {
        return { status: 200, data: fullScheduleHtml };
      }

      throw new Error(`Unexpected GET ${url}`);
    });

    mockedPost.mockResolvedValue({
      status: 200,
      data: {
        content: {
          "dynamic-team-schedule": scheduleHtml,
        },
      },
    });

    const payload = await getD1ScoresFromTeamDirectory("20260315");

    expect(payload.games).toHaveLength(1);
    expect(payload.games[0].conferenceNames).toEqual(["SEC"]);
    expect(payload.games[0].conferenceIds).toContain("sec");
    expect(payload.games[0].roadTeam.record).toBe("1-0");
  });
});
