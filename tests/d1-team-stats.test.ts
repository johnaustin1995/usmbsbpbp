import { describe, expect, it } from "vitest";
import { parseD1TeamStatsHtml } from "../src/scrapers/d1";

describe("parseD1TeamStatsHtml", () => {
  it("parses stats tables from the current D1 team page structure", () => {
    const html = `
      <html>
        <body>
          <div id="team-header">
            <a class="team-logo" href="https://d1baseball.com/team/ucla/">
              <img src="https://cdn.example.com/ucla.png" alt="UCLA" />
            </a>
            <h1 class="single-team-title">UCLA</h1>
          </div>

          <section class="data-table full-size all-rows">
            <h3 class="stat-heading">Batting</h3>
            <div class="d1-dynamic-content" id="batting-table">
              <section id="standard-batting" class="data-table full-size batting lazy-table">
                <table id="batting-stats" class="standard-batting-table display compact">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>BA</th>
                      <th>HR</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Will Gasparino</td>
                      <td>.380</td>
                      <td>10</td>
                    </tr>
                  </tbody>
                </table>
              </section>
            </div>
          </section>
        </body>
      </html>
    `;

    const parsed = parseD1TeamStatsHtml(html);

    expect(parsed.teamName).toBe("UCLA");
    expect(parsed.logoUrl).toBe("https://cdn.example.com/ucla.png");
    expect(parsed.tables).toEqual([
      expect.objectContaining({
        id: "batting-stats",
        group: "Batting",
        section: "standard-batting",
        headers: ["Player", "BA", "HR"],
        rows: [
          expect.objectContaining({
            cells: ["Will Gasparino", ".380", "10"],
          }),
        ],
      }),
    ]);
  });
});
