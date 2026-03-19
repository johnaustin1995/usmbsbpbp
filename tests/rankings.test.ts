import { describe, expect, it } from "vitest";
import {
  parseBaseballAmericaRankingsHtml,
  parseNCAAD1RankingsHtml,
  parseNCAARpiHtml,
  parseUsaTodayCoachesPollHtml,
} from "../src/scrapers/rankings";

describe("rankings scrapers", () => {
  it("parses NCAA D1 rankings", () => {
    const html = `
      <html>
        <body>
          <script>
            var turner_metadata = {"article_modified_time":"2026-03-17t16:11:56-04:00"};
          </script>
          <table>
            <thead>
              <tr>
                <th>RANK</th>
                <th>TEAM</th>
                <th>OVERALL RECORD</th>
                <th>PREVIOUS RANK</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td>UCLA</td>
                <td>17-2</td>
                <td>1</td>
              </tr>
              <tr>
                <td>2</td>
                <td>Texas</td>
                <td>18-1</td>
                <td>3</td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    `;

    const parsed = parseNCAAD1RankingsHtml(html);
    expect(parsed.updatedAt).toBe("March 17, 2026");
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        rank: 1,
        teamName: "UCLA",
        record: "17-2",
        previousRank: "1",
      }),
      expect.objectContaining({
        rank: 2,
        teamName: "Texas",
        record: "18-1",
        previousRank: "3",
      }),
    ]);
  });

  it("parses NCAA RPI rankings", () => {
    const html = `
      <html>
        <body>
          <script>
            var turner_metadata = {"article_modified_time":"2026-03-18t08:00:00-04:00"};
          </script>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>School</th>
                <th>Record</th>
                <th>Conf</th>
                <th>Road</th>
                <th>Neutral</th>
                <th>Home</th>
                <th>Non-Div I</th>
                <th>Prev</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td>Southern Miss.</td>
                <td>17-4</td>
                <td>Sun Belt</td>
                <td>5-2</td>
                <td>4-0</td>
                <td>8-2</td>
                <td>0-0</td>
                <td>1</td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    `;

    const parsed = parseNCAARpiHtml(html);
    expect(parsed.updatedAt).toBe("March 18, 2026");
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        rank: 1,
        teamName: "Southern Miss.",
        record: "17-4",
        conference: "Sun Belt",
        previousRank: "1",
      }),
    ]);
  });

  it("parses Baseball America rankings", () => {
    const html = `
      <html>
        <head>
          <meta property="article:modified_time" content="2026-03-17T18:05:12+00:00" />
        </head>
        <body>
          <table>
            <tbody>
              <tr>
                <td>Rank</td>
                <td>Team</td>
                <td>Previous Rank</td>
                <td>Record (Conference Record)</td>
              </tr>
              <tr>
                <td>1</td>
                <td><a href="#ucla">UCLA Bruins</a></td>
                <td>1</td>
                <td>17-2 (6-0 Big Ten)</td>
              </tr>
              <tr>
                <td>2</td>
                <td><a href="#texas">Texas Longhorns</a></td>
                <td>3</td>
                <td>18-1 (2-1 SEC)</td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    `;

    const parsed = parseBaseballAmericaRankingsHtml(html);
    expect(parsed.updatedAt).toBe("March 17, 2026");
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        rank: 1,
        teamName: "UCLA Bruins",
        record: "17-2 (6-0 Big Ten)",
        previousRank: "1",
      }),
      expect.objectContaining({
        rank: 2,
        teamName: "Texas Longhorns",
        record: "18-1 (2-1 SEC)",
        previousRank: "3",
      }),
    ]);
  });

  it("parses USA Today coaches poll", () => {
    const html = `
      <html>
        <body>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Team</th>
                <th>Record</th>
                <th>PTS</th>
                <th>1st</th>
                <th>Prev</th>
                <th>Chg</th>
                <th>Hi/Lo</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td>
                  <span>
                    <img src="https://example.com/ucla.png" />
                    <span class="QA1t2T__QA1t2T">UCLA Bruins</span>
                    <span class="yNdnxn__yNdnxn">UCLA</span>
                  </span>
                </td>
                <td>17-2</td>
                <td>746</td>
                <td>26</td>
                <td>1</td>
                <td>-</td>
                <td>1/2</td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    `;

    const parsed = parseUsaTodayCoachesPollHtml(html);
    expect(parsed.updatedAt).toBeNull();
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        rank: 1,
        teamName: "UCLA Bruins",
        shortName: "UCLA",
        record: "17-2",
        points: "746",
        firstPlaceVotes: "26",
        previousRank: "1",
        change: null,
        highLow: "1/2",
        logoUrl: "https://example.com/ucla.png",
      }),
    ]);
  });
});
