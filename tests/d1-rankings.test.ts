import { describe, expect, it } from "vitest";
import { parseD1RankingsHtml } from "../src/scrapers/d1";

describe("parseD1RankingsHtml", () => {
  it("extracts updated label and ranked teams from the D1 rankings table", () => {
    const html = `
      <section class="avia_codeblock_section">
        <div class="avia_codeblock">
          <hgroup>
            <p>
              <a href="https://d1baseball.com/rankings/" target="_blank">
                <strong><span class="updated">Updated March 9, 2026 | More on the Top 25</span></strong>
              </a>
            </p>
          </hgroup>
          <section class="data-table full-size">
            <table class="standings rankings">
              <thead>
                <tr>
                  <td>Rank</td>
                  <td>Team</td>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1</td>
                  <td class="team">
                    <a href="/team/ucla/">
                      <img class="team-logo" src="https://cdn.d1baseball.com/logos/teams/128/ucla.png" alt="ucla logo">
                      UCLA
                    </a>
                  </td>
                </tr>
                <tr>
                  <td>2</td>
                  <td class="team">
                    <a href="/team/texas/">
                      <img class="team-logo" src="https://cdn.d1baseball.com/logos/teams/128/texas.png" alt="texas logo">
                      Texas
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </section>
    `;

    const parsed = parseD1RankingsHtml(html);

    expect(parsed.sourceUpdatedAt).toBe("March 9, 2026");
    expect(parsed.teams).toHaveLength(2);
    expect(parsed.teams[0]).toEqual({
      rank: 1,
      name: "UCLA",
      slug: "ucla",
      logoUrl: "https://cdn.d1baseball.com/logos/teams/128/ucla.png",
      teamUrl: "https://d1baseball.com/team/ucla/",
    });
    expect(parsed.teams[1].rank).toBe(2);
    expect(parsed.teams[1].name).toBe("Texas");
  });
});
