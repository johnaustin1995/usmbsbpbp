import { describe, expect, it } from "vitest";
import { parseConferenceStandingsHtml, parseConferencesIndexHtml } from "../src/scrapers/standings";

describe("conference standings scrapers", () => {
  it("parses the D1 conferences index options", () => {
    const html = `
      <html>
        <body>
          <select name="conference">
            <option value="">Select</option>
            <option value="13" data-target="https://d1baseball.com/conference/atlantic-coast-conference/2026/">ACC</option>
            <option value="6" data-target="https://d1baseball.com/conference/sun-belt-conference/2026/">Sun Belt</option>
          </select>
        </body>
      </html>
    `;

    expect(parseConferencesIndexHtml(html)).toEqual([
      {
        id: "atlantic-coast-conference",
        name: "ACC",
        slug: "atlantic-coast-conference",
        url: "https://d1baseball.com/conference/atlantic-coast-conference/2026/",
      },
      {
        id: "sun-belt-conference",
        name: "Sun Belt",
        slug: "sun-belt-conference",
        url: "https://d1baseball.com/conference/sun-belt-conference/2026/",
      },
    ]);
  });

  it("parses a D1 conference standings table", () => {
    const html = `
      <html>
        <body>
          <div id="conference-standings" class="table-group">
            <section class="data-table full-size">
              <div class="lazy-table">
                <table class="standings conference-standings-table">
                  <thead>
                    <tr>
                      <td class="team-header text-left">Team</td>
                      <td>Record</td>
                      <td>Win %</td>
                      <td>GB</td>
                      <td>Overall</td>
                      <td>Overall %</td>
                      <td>Streak</td>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td class="team">
                        <a href="https://d1baseball.com/team/floridast/">
                          <img src="https://example.com/fsu.svg" alt="Florida State" />
                          Florida State
                        </a>
                      </td>
                      <td>3-0</td>
                      <td>1.000</td>
                      <td>-</td>
                      <td>17-3</td>
                      <td>0.850</td>
                      <td>W4</td>
                    </tr>
                    <tr>
                      <td class="team">
                        <a href="https://d1baseball.com/team/unc/">
                          <img src="https://example.com/unc.svg" alt="North Carolina" />
                          North Carolina
                        </a>
                      </td>
                      <td>4-2</td>
                      <td>0.667</td>
                      <td>0.5</td>
                      <td>18-3-1</td>
                      <td>0.818</td>
                      <td>W6</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </body>
      </html>
    `;

    const parsed = parseConferenceStandingsHtml(html);
    expect(parsed.headers).toEqual([
      "Team",
      "Record",
      "Win %",
      "GB",
      "Overall",
      "Overall %",
      "Streak",
    ]);
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        position: 1,
        teamName: "Florida State",
        conferenceRecord: "3-0",
        conferenceWinPct: "1.000",
        gamesBack: "-",
        overallRecord: "17-3",
        overallWinPct: "0.850",
        streak: "W4",
        teamUrl: "https://d1baseball.com/team/floridast/",
      }),
      expect.objectContaining({
        position: 2,
        teamName: "North Carolina",
        conferenceRecord: "4-2",
        conferenceWinPct: "0.667",
        gamesBack: "0.5",
        overallRecord: "18-3-1",
        overallWinPct: "0.818",
        streak: "W6",
        teamUrl: "https://d1baseball.com/team/unc/",
      }),
    ]);
  });
});
