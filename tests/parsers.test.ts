import { describe, expect, it } from "vitest";
import {
  parseD1ConferencePageHtml,
  parseD1ScoreHtml,
  parseD1TeamScheduleHtml,
  parseD1TeamStatsHtml,
  parseD1TeamsDirectoryHtml,
} from "../src/scrapers/d1";
import { parseEventXml, parseStatsHtml, parseStatsSections } from "../src/scrapers/statbroadcast";

describe("d1 parser", () => {
  it("extracts statbroadcast ids and deduplicates by data-key", () => {
    const html = `
      <div id="d1-scores-update" data-date="2026-02-13 11:42:56 am"></div>
      <section class="score-set" data-conference="top-25">
        <div class="conference-header"><h3>Top 25</h3></div>
        <div class="d1-score-tiles">
          <div class="d1-score-tile" data-key="game-1" data-matchup-time="1770973200" data-in-progress="1" data-is-over="0">
            <div class="status-wrapper"><h5>Top&nbsp;6</h5></div>
            <div class="box-score-links">
              <a href="https://stats.statbroadcast.com/broadcast/?id=636528&amp;vislive=ncst">Live Stats</a>
            </div>
            <div class="team team-1" data-search="wake wake forest" data-team-id="462670">
              <a class="team-title"><h5><span class="team-rank">21</span>Wake Forest</h5></a>
              <h5 class="team-score"><span class="score-meta score-runs">2</span></h5>
            </div>
            <div class="team team-2" data-search="hou houston" data-team-id="462536">
              <a class="team-title"><h5>Houston</h5></a>
              <h5 class="team-score"><span class="score-meta score-runs">6</span></h5>
            </div>
            <div class="box-score-footer"><span class="matchup-commentary">Ponce, Puerto Rico</span></div>
          </div>
        </div>
      </section>
      <section class="score-set" data-conference="13">
        <div class="conference-header"><h3>ACC</h3></div>
        <div class="d1-score-tiles">
          <div class="d1-score-tile" data-key="game-1" data-matchup-time="1770973200" data-in-progress="1" data-is-over="0"></div>
        </div>
      </section>
    `;

    const parsed = parseD1ScoreHtml(html, "20260213");

    expect(parsed.sourceUpdatedAt).toBe("2026-02-13 11:42:56 am");
    expect(parsed.games).toHaveLength(1);

    const game = parsed.games[0];
    expect(game.key).toBe("game-1");
    expect(game.conferenceIds).toEqual(["top-25", "13"]);
    expect(game.statbroadcastId).toBe(636528);
    expect(game.statbroadcastQuery).toEqual({ vislive: "ncst" });
    expect(game.roadTeam.name).toBe("Wake Forest");
    expect(game.homeTeam.name).toBe("Houston");
    expect(game.roadTeam.rank).toBe(21);
    expect(game.roadTeam.score).toBe(2);
    expect(game.homeTeam.score).toBe(6);
  });
});

describe("d1 teams parser", () => {
  it("parses team and conference directory options", () => {
    const html = `
      <select name="conference">
        <option value="select">Conference</option>
        <option value="3" data-target="https://d1baseball.com/conference/sec/2026/">SEC</option>
      </select>
      <select name="team">
        <option value="select">Team</option>
        <option value="144358" data-target="https://d1baseball.com/team/alabama/2026/">Alabama</option>
      </select>
    `;

    const parsed = parseD1TeamsDirectoryHtml(html);
    expect(parsed.season).toBe("2026");
    expect(parsed.conferences).toHaveLength(1);
    expect(parsed.conferences[0].name).toBe("SEC");
    expect(parsed.teams).toHaveLength(1);
    expect(parsed.teams[0].slug).toBe("alabama");
    expect(parsed.teams[0].baseUrl).toBe("https://d1baseball.com/team/alabama/");
  });

  it("parses conference standings memberships", () => {
    const html = `
      <div id="conference-standings">
        <table class="conference-standings-table">
          <tbody>
            <tr>
              <td class="team"><a href="https://d1baseball.com/team/alabama/"><img src="">Alabama</a></td>
            </tr>
            <tr>
              <td class="team"><a href="https://d1baseball.com/team/auburn/"><img src="">Auburn</a></td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    const teams = parseD1ConferencePageHtml(html);
    expect(teams).toHaveLength(2);
    expect(teams.map((team) => team.slug)).toEqual(["alabama", "auburn"]);
  });

  it("parses full team schedule rows", () => {
    const html = `
      <h1 class="single-team-title">Alabama</h1>
      <table class="full-team-schedule">
        <thead>
          <tr><th>Date</th><th>Loc</th><th>Opponent</th><th>Results</th><th>Win Prob</th><th>Notes</th></tr>
        </thead>
        <tbody>
          <tr data-schedule-id="abc123">
            <td><a href="/scores/?date=20260213">Fri, Feb 13</a></td>
            <td>vs</td>
            <td><a class="team-logo-name" href="https://d1baseball.com/team/washst/schedule/"><img class="team-logo" src="https://cdn/logo.svg"><h5 class="team-name">Washington State</h5></a></td>
            <td class="result win"><a href="https://rolltide.com/boxscore.aspx?id=1">W 8 - 1</a></td>
            <td></td>
            <td>Tuscaloosa, Ala.</td>
          </tr>
        </tbody>
      </table>
    `;

    const parsed = parseD1TeamScheduleHtml(html);
    expect(parsed.teamName).toBe("Alabama");
    expect(parsed.games).toHaveLength(1);
    expect(parsed.games[0].scheduleId).toBe("abc123");
    expect(parsed.games[0].opponentSlug).toBe("washst");
    expect(parsed.games[0].outcome).toBe("win");
    expect(parsed.games[0].notes).toBe("Tuscaloosa, Ala.");
  });

  it("parses stats tables into structured rows", () => {
    const html = `
      <h1 class="single-team-title">Alabama</h1>
      <div id="team-single-stats">
        <section class="data-table full-size all-rows">
          <h3 class="stat-heading">Batting</h3>
          <section id="standard-batting">
            <table id="batting-stats">
              <thead>
                <tr><th>Player</th><th>BA</th></tr>
              </thead>
              <tbody>
                <tr><td>Bryce Fowler</td><td>.500</td></tr>
              </tbody>
            </table>
          </section>
        </section>
      </div>
    `;

    const parsed = parseD1TeamStatsHtml(html);
    expect(parsed.teamName).toBe("Alabama");
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.tables[0].group).toBe("Batting");
    expect(parsed.tables[0].section).toBe("standard-batting");
    expect(parsed.tables[0].rows[0].values.player).toBe("Bryce Fowler");
    expect(parsed.tables[0].rows[0].values.ba).toBe(".500");
  });
});

describe("statbroadcast parser", () => {
  it("parses event xml metadata", () => {
    const xml = `
      <BCSResponse>
        <event id="636528" completed="0" homename="Houston" visitorname="Wake Forest">
          <title><![CDATA[Houston vs. Wake Forest]]></title>
          <date>February 13, 2026</date>
          <time>9:30 AM CST</time>
          <xmlfile><![CDATA[wake/636528.xml]]></xmlfile>
          <sport>bsgame</sport>
          <venue><![CDATA[Alex Box Stadium]]></venue>
          <location><![CDATA[Baton Rouge, LA]]></location>
        </event>
      </BCSResponse>
    `;

    const event = parseEventXml(636528, xml);
    expect(event.id).toBe(636528);
    expect(event.sport).toBe("bsgame");
    expect(event.xmlFile).toBe("wake/636528.xml");
    expect(event.homeName).toBe("Houston");
    expect(event.visitorName).toBe("Wake Forest");
    expect(event.completed).toBe(false);
  });

  it("parses live summary and line score", () => {
    const event = {
      id: 636528,
      title: "Houston vs. Wake Forest",
      sport: "bsgame",
      xmlFile: "wake/636528.xml",
      date: "February 13, 2026",
      time: "9:30 AM CST",
      venue: null,
      location: null,
      homeName: "Houston",
      visitorName: "Wake Forest",
      completed: false,
    };

    const html = `
      <div class="statusbar d-none d-md-block">
        <div class="sb-teamname sb-teamnameV">#21 Wake Forest</div>
        <div class="sb-teamscore">2</div>
        <div class="sb-statusbar-clock"><div class="font-size-125">End 6th</div></div>
        <div class="sb-teamname sb-teamnameH"><i class="fas fa-caret-right"></i>Houston</div>
        <div class="sb-teamscore">6</div>
      </div>
      <div class="card card-info card-outline">
        <div class="card-header card-title">Game Line Score</div>
        <div class="card-body pb-0">
          <table>
            <thead>
              <tr>
                <th></th><th>TEAM</th><th>1</th><th>2</th><th>3</th><th></th><th>R</th><th>H</th><th>E</th><th>LOB</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td></td><td>#21 Wake Forest</td><td>0</td><td>2</td><td>0</td><td></td><td>2</td><td>4</td><td>1</td><td>3</td>
              </tr>
              <tr>
                <td></td><td>Houston</td><td>2</td><td>1</td><td>3</td><td></td><td>6</td><td>7</td><td>0</td><td>7</td>
              </tr>
            </tbody>
          </table>
          <div class="row bg-primary border-bottom smaller">
            <div class="sb-col col-3 sb-bsgame-thisinning">End 6th</div>
            <div class="sb-col col-9 text-right">This Inning: 0R 0H 0E</div>
          </div>
        </div>
      </div>
    `;

    const summary = parseStatsHtml(636528, event, html);

    expect(summary.statusText).toBe("End 6th");
    expect(summary.visitorTeam).toContain("Wake Forest");
    expect(summary.homeTeam).toContain("Houston");
    expect(summary.visitorScore).toBe(2);
    expect(summary.homeScore).toBe(6);

    expect(summary.lineScore).not.toBeNull();
    expect(summary.lineScore?.rows).toHaveLength(2);
    expect(summary.lineScore?.rows[0].totals.r).toBe(2);
    expect(summary.lineScore?.rows[1].totals.h).toBe(7);
    expect(summary.situation?.inningText).toBe("End 6th");
    expect(summary.situation?.count.balls).toBeNull();
    expect(summary.situation?.count.strikes).toBeNull();

    expect(summary.thisInning).toEqual({
      label: "End 6th",
      runs: 0,
      hits: 0,
      errors: 0,
    });
  });

  it("parses live situation details for scoreboard snapshots", () => {
    const event = {
      id: 650933,
      title: "Oklahoma vs. Texas Tech",
      sport: "bsgame",
      xmlFile: "oklahoma/650933.xml",
      date: "February 13, 2026",
      time: "7:00 PM CST",
      venue: null,
      location: null,
      homeName: "Texas Tech",
      visitorName: "Oklahoma",
      completed: false,
    };

    const html = `
      <div class="statusbar d-none d-md-block">
        <div class="sb-teamname sb-teamnameV"><span class="seed"></span>Oklahoma</div>
        <div class="sb-indicator-timeouts"><span>On Mound:</span><span>Cleveland,Jackson</span></div>
        <div class="sb-teamscore">10</div>
        <div class="sb-statusbar-clock">
          <div class="font-size-125">Bot 9th</div>
          <div class="font-size-125">2-0</div>
          <div class="base-indicator">
            <i class="sbicon font-size-300">3</i>
            <span class="d-inline d-sm-none">1</span>
          </div>
        </div>
        <div class="sb-teamname sb-teamnameH"><i class="fas fa-caret-right"></i>Texas Tech</div>
        <div class="sb-indicator-timeouts"><span>At Bat:</span><span>Garcia,Linkin</span></div>
        <div class="sb-teamscore">3</div>
      </div>
      <div class="card card-primary card-outline">
        <div class="card-header card-title">At Bat for TECH: #4 Garcia,Linkin [3B]</div>
        <div class="card-body">
          <table>
            <thead><tr><th>TODAY</th><th>AB</th><th>H</th><th>R</th></tr></thead>
            <tbody><tr><td></td><td>1</td><td>1</td><td>1</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="card card-secondary card-outline">
        <div class="card-header card-title">Pitching For OU: #49 Cleveland, Jackson</div>
        <div class="card-body">
          <table>
            <thead><tr><th>TODAY</th><th>IP</th><th>PC</th></tr></thead>
            <tbody><tr><td></td><td>1</td><td>14</td></tr></tbody>
          </table>
        </div>
      </div>
    `;

    const summary = parseStatsHtml(650933, event, html);
    expect(summary.situation).not.toBeNull();
    expect(summary.situation?.inningText).toBe("Bot 9th");
    expect(summary.situation?.half).toBe("bottom");
    expect(summary.situation?.inning).toBe(9);
    expect(summary.situation?.count.balls).toBe(2);
    expect(summary.situation?.count.strikes).toBe(0);
    expect(summary.situation?.outs).toBe(1);
    expect(summary.situation?.bases.first).toBe(true);
    expect(summary.situation?.bases.second).toBe(true);
    expect(summary.situation?.bases.third).toBe(false);
    expect(summary.situation?.battingTeam).toBe("home");
    expect(summary.situation?.batter.name).toBe("Garcia,Linkin");
    expect(summary.situation?.batter.summary).toBe("1-1");
    expect(summary.situation?.pitcher.name).toBe("Cleveland,Jackson");
    expect(summary.situation?.pitcher.pitchCount).toBe(14);
  });

  it("parses card tables into structured statistical sections", () => {
    const html = `
      <div class="card card-info card-outline">
        <div class="card-header card-title">Game Line Score</div>
        <div class="card-body pb-0">
          <table>
            <thead>
              <tr><th>Team</th><th>R</th><th>H</th><th>E</th></tr>
            </thead>
            <tbody>
              <tr><td>Wake Forest</td><td>2</td><td>4</td><td>1</td></tr>
              <tr><td>Houston</td><td>6</td><td>7</td><td>0</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card card-secondary card-outline">
        <div class="card-header card-title">Pitching For HOU</div>
        <div class="card-body">
          <table>
            <thead>
              <tr><th>TODAY</th><th>IP</th><th>K</th></tr>
            </thead>
            <tbody>
              <tr><td>Scinta, Chris</td><td>6.0</td><td>4</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const sections = parseStatsSections(html);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("Game Line Score");
    expect(sections[0].tables[0].rows[1].values.r).toBe(6);
    expect(sections[1].title).toContain("Pitching");
    expect(sections[1].tables[0].rows[0].values.ip).toBe(6);
  });
});
