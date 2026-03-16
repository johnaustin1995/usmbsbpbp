import { describe, expect, it } from "vitest";
import { parseD1ScoreHtml } from "../src/scrapers/d1";

describe("parseD1ScoreHtml", () => {
  it("ignores placeholder tiles without matchup data", () => {
    const html = `
      <section class="score-set" data-conference="all">
        <div class="conference-header"><h3>All Games</h3></div>
        <div class="d1-score-tiles">
          <div class="d1-score-tile">
            <svg role="img" width="100%" height="125"></svg>
          </div>
          <div class="d1-score-tile" data-matchup-time="1770973200" data-in-progress="1" data-is-over="0">
            <div class="status-wrapper"><h5>Top 6</h5></div>
            <div class="box-score-links">
              <a href="https://stats.statbroadcast.com/broadcast/?id=636528">Live Stats</a>
            </div>
            <div class="team team-1" data-search="wake wake forest" data-team-id="462670">
              <a class="team-title"><h5><span class="team-rank">21</span>Wake Forest</h5></a>
              <h5 class="team-score"><span class="score-meta score-runs">2</span></h5>
            </div>
            <div class="team team-2" data-search="hou houston" data-team-id="462536">
              <a class="team-title"><h5>Houston</h5></a>
              <h5 class="team-score"><span class="score-meta score-runs">6</span></h5>
            </div>
          </div>
        </div>
      </section>
    `;

    const parsed = parseD1ScoreHtml(html, "20260213");

    expect(parsed.games).toHaveLength(1);
    expect(parsed.games[0].roadTeam.name).toBe("Wake Forest");
    expect(parsed.games[0].homeTeam.name).toBe("Houston");
    expect(parsed.games[0].statbroadcastId).toBe(636528);
  });
});
