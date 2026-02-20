import { describe, expect, it } from "vitest";
import {
  buildFinalTweetText,
  buildPlayTweetText,
  deriveLivePlayStates,
  extractLivePlayEvents,
  isFinalStatus,
} from "../src/pipelines/live-play-feed";
import type { StatBroadcastLiveStats, StatBroadcastLiveSummary, StatsSection, StatsTable } from "../src/types";

describe("live play feed pipeline", () => {
  it("extracts play rows and preserves inning/half context", () => {
    const payload = buildLiveStatsPayload([
      buildSection("1st Inning Play-by-play", [
        buildTable(
          ["", "Play", "Scoring Dec.", "Batter", "Pitcher", "Outs"],
          [
            ["", "Play", "Scoring Dec.", "Batter", "Pitcher", "Outs"],
            ["Top of the 1st", null, null, null, null, null],
            [null, "Smith singled to left field", null, "Smith", "Jones", 0],
            [null, "Brown struck out swinging", null, "Brown", "Jones", 1],
            ["Bottom of the 1st", null, null, null, null, null],
            [null, "Davis doubled down the line", "2B", "Davis", "Clark", 0],
          ]
        ),
      ]),
    ]);

    const events = extractLivePlayEvents(payload);

    expect(events).toHaveLength(3);
    expect(events[0].inning).toBe(1);
    expect(events[0].half).toBe("top");
    expect(events[0].text).toContain("singled");

    expect(events[2].inning).toBe(1);
    expect(events[2].half).toBe("bottom");
    expect(events[2].scoringDecision).toBe("2B");
  });

  it("generates stable keys and differentiates duplicate play text", () => {
    const payload = buildLiveStatsPayload([
      buildSection("3rd Inning Play-by-play", [
        buildTable(
          ["", "Play", "Scoring Dec.", "Batter", "Pitcher", "Outs"],
          [
            ["Top of the 3rd", null, null, null, null, null],
            [null, "Miller grounded out to short", null, "Miller", "Adams", 1],
            [null, "Miller grounded out to short", null, "Miller", "Adams", 2],
          ]
        ),
      ]),
    ]);

    const firstPass = extractLivePlayEvents(payload);
    const secondPass = extractLivePlayEvents(payload);

    expect(firstPass).toHaveLength(2);
    expect(firstPass[0].key).not.toBe(firstPass[1].key);
    expect(firstPass.map((entry) => entry.key)).toEqual(secondPass.map((entry) => entry.key));
  });

  it("formats play and final tweets within max length", () => {
    const summary = buildSummary({
      visitorTeam: "Wake Forest",
      homeTeam: "Houston",
      visitorScore: 4,
      homeScore: 6,
      statusText: "Bottom 7th",
      outs: 2,
      pitchCount: 32,
    });

    const events = extractLivePlayEvents(
      buildLiveStatsPayload([
        buildSection("7th Inning Play-by-play", [
          buildTable(
            ["", "Play", "Scoring Dec.", "Batter", "Pitcher", "Outs"],
            [["Bottom of the 7th", null, null, null, null, null], [null, "Batter Name struck out looking (0-2 KKFK).", null, "Batter Name", "Pitcher Name", 2]]
          ),
        ]),
      ])
    );

    const playTweet = buildPlayTweetText({
      play: events[0],
      summary,
      maxLength: 280,
      appendTag: "#NCAABaseball",
    });

    const finalTweet = buildFinalTweetText({
      summary: {
        ...summary,
        statusText: "Final",
        event: {
          ...summary.event,
          completed: true,
        },
      },
      maxLength: 280,
    });

    expect(playTweet.length).toBeLessThanOrEqual(280);
    expect(playTweet).toContain("Bottom 7th | 2 Outs");
    expect(playTweet).toContain("Wake Forest - 4");
    expect(playTweet).toContain("Houston - 6");
    expect(playTweet).toContain("Pitching | Pitcher Name - P 32");
    expect(finalTweet).toContain("Final");
    expect(finalTweet.length).toBeLessThanOrEqual(280);
  });

  it("detects final status from completed flag or status text", () => {
    const notFinal = buildSummary({ statusText: "Top 5th", completed: false });
    const finalByText = buildSummary({ statusText: "Final", completed: false });
    const finalByEvent = buildSummary({ statusText: "Top 8th", completed: true });

    expect(isFinalStatus(notFinal)).toBe(false);
    expect(isFinalStatus(finalByText)).toBe(true);
    expect(isFinalStatus(finalByEvent)).toBe(true);
  });

  it("uses Mid/End inning labels when the play records the third out", () => {
    const summary = buildSummary({
      visitorTeam: "Kent State",
      homeTeam: "#1 LSU",
      visitorScore: 7,
      homeScore: 10,
      pitchCount: 32,
    });

    const topOutsPayload = buildLiveStatsPayload([
      buildSection("9th Inning Play-by-play", [
        buildTable(
          ["", "Play", "Scoring Dec.", "Batter", "Pitcher", "Outs"],
          [
            ["Top of the 9th", null, null, null, null, null],
            [null, "LastName,FirstName struck out looking (0-2 KKFK).", null, "LastName,FirstName", "Pitcher,Name", 3],
          ]
        ),
      ]),
    ]);

    const bottomOutsPayload = buildLiveStatsPayload([
      buildSection("9th Inning Play-by-play", [
        buildTable(
          ["", "Play", "Scoring Dec.", "Batter", "Pitcher", "Outs"],
          [
            ["Bottom of the 9th", null, null, null, null, null],
            [null, "LastName,FirstName lined out to rf (1-0 B).", null, "LastName,FirstName", "Pitcher,Name", 3],
          ]
        ),
      ]),
    ]);

    const topTweet = buildPlayTweetText({
      play: extractLivePlayEvents(topOutsPayload)[0],
      summary,
      stateAfterPlay: deriveLivePlayStates(extractLivePlayEvents(topOutsPayload), summary).get(
        extractLivePlayEvents(topOutsPayload)[0].key
      ),
      maxLength: 280,
    });
    const bottomTweet = buildPlayTweetText({
      play: extractLivePlayEvents(bottomOutsPayload)[0],
      summary,
      stateAfterPlay: deriveLivePlayStates(extractLivePlayEvents(bottomOutsPayload), summary).get(
        extractLivePlayEvents(bottomOutsPayload)[0].key
      ),
      maxLength: 280,
    });

    expect(topTweet).toContain("Mid 9th");
    expect(topTweet).not.toContain("3 Outs");
    expect(bottomTweet).toContain("End 9th");
    expect(bottomTweet).not.toContain("3 Outs");
  });

  it("derives score and outs from play results instead of play-start state", () => {
    const summary = buildSummary({
      visitorTeam: "Kent State",
      homeTeam: "#1 LSU",
      visitorScore: 7,
      homeScore: 10,
      pitchCount: 32,
    });

    const payload = buildLiveStatsPayload([
      buildSection("9th Inning Play-by-play", [
        buildTable(
          ["", "Play", "Scoring Dec.", "Batter", "Pitcher", "Outs"],
          [
            ["Top of the 9th", null, null, null, null, null],
            [null, "Roe,Max singled to center field, RBI; Lane,Chris scored.", "1B 1RBI", "Roe,Max", "Smith,Alex", 0],
            [null, "Doe,John struck out looking (0-2 KKFK).", null, "Doe,John", "Smith,Alex", 1],
            [null, "Poe,Ian flied out to rf (1-1 BK).", null, "Poe,Ian", "Smith,Alex", 2],
            ["Bottom of the 9th", null, null, null, null, null],
            [null, "Cole,Ben grounded out to 2b (1-2).", null, "Cole,Ben", "Lee,Tom", 0],
          ]
        ),
      ]),
    ]);

    const plays = extractLivePlayEvents(payload);
    const states = deriveLivePlayStates(plays, summary);

    const scoringTweet = buildPlayTweetText({
      play: plays[0],
      summary,
      stateAfterPlay: states.get(plays[0].key) ?? null,
      maxLength: 280,
    });

    const thirdOutTweet = buildPlayTweetText({
      play: plays[2],
      summary,
      stateAfterPlay: states.get(plays[2].key) ?? null,
      maxLength: 280,
    });

    expect(scoringTweet).toContain("Top 9th | 1 Out");
    expect(scoringTweet).toContain("Kent State - 7");
    expect(scoringTweet).toContain("#1 LSU - 10");
    expect(thirdOutTweet).toContain("Mid 9th");
    expect(thirdOutTweet).toContain("Kent State - 7");
    expect(thirdOutTweet).toContain("#1 LSU - 10");
  });

  it("accounts for substitution rows without forcing scoring/out side effects", () => {
    const summary = buildSummary({
      visitorTeam: "Kent State",
      homeTeam: "#1 LSU",
      visitorScore: 7,
      homeScore: 10,
      pitchCount: 32,
    });

    const payload = buildLiveStatsPayload([
      buildSection("9th Inning Play-by-play", [
        buildTable(
          ["", "Play", "Scoring Dec.", "Batter", "Pitcher", "Outs"],
          [
            ["Top of the 9th", null, null, null, null, null],
            [null, "Marsh to p for Buczkowski.", null, null, null, 1],
            [null, "I. Warrick pinch ran for W. Helms.", null, null, null, 1],
            [null, "M. Price pinch hit for Pierzynski.", null, null, null, 1],
            [null, "Doe,John struck out looking (0-2 KKFK).", null, "Doe,John", "Marsh", 1],
          ]
        ),
      ]),
    ]);

    const plays = extractLivePlayEvents(payload);
    const states = deriveLivePlayStates(plays, summary);

    expect(plays[0].isSubstitution).toBe(true);
    expect(plays[1].isSubstitution).toBe(true);
    expect(plays[2].isSubstitution).toBe(true);

    for (let index = 0; index < 3; index += 1) {
      const state = states.get(plays[index].key);
      expect(state?.awayScore).toBe(7);
      expect(state?.homeScore).toBe(10);
      expect(state?.outsAfterPlay).toBe(1);
    }

    const substitutionTweet = buildPlayTweetText({
      play: plays[0],
      summary,
      stateAfterPlay: states.get(plays[0].key) ?? null,
      maxLength: 280,
    });

    expect(substitutionTweet).toContain("Top 9th | 1 Out");
    expect(substitutionTweet).toContain("Kent State - 7");
    expect(substitutionTweet).toContain("#1 LSU - 10");
    expect(substitutionTweet).toContain("Marsh to p for Buczkowski.");
    expect(substitutionTweet).not.toContain("Mid 9th");
  });
});

function buildLiveStatsPayload(sections: StatsSection[]): StatBroadcastLiveStats {
  return {
    id: 636528,
    view: "plays",
    event: {
      id: 636528,
      title: "Wake Forest at Houston",
      sport: "bsgame",
      xmlFile: "wake/636528.xml",
      date: "February 13, 2026",
      time: "9:30 AM CST",
      venue: null,
      location: null,
      homeName: "Houston",
      visitorName: "Wake Forest",
      completed: false,
    },
    summary: buildSummary({}),
    sections,
    fetchedAt: "2026-02-19T12:00:00.000Z",
  };
}

function buildSection(title: string, tables: StatsTable[]): StatsSection {
  return {
    title,
    tables,
  };
}

function buildTable(headers: string[], rows: Array<Array<string | number | null>>): StatsTable {
  return {
    headers,
    rows: rows.map((cells) => ({
      cells,
      values: {},
    })),
  };
}

function buildSummary(overrides: {
  visitorTeam?: string;
  homeTeam?: string;
  visitorScore?: number | null;
  homeScore?: number | null;
  statusText?: string | null;
  completed?: boolean;
  outs?: number | null;
  pitchCount?: number | null;
}): StatBroadcastLiveSummary {
  return {
    id: 636528,
    event: {
      id: 636528,
      title: "Wake Forest at Houston",
      sport: "bsgame",
      xmlFile: "wake/636528.xml",
      date: "February 13, 2026",
      time: "9:30 AM CST",
      venue: null,
      location: null,
      homeName: overrides.homeTeam ?? "Houston",
      visitorName: overrides.visitorTeam ?? "Wake Forest",
      completed: overrides.completed ?? false,
    },
    statusText: overrides.statusText ?? "Top 6th",
    visitorTeam: overrides.visitorTeam ?? "Wake Forest",
    homeTeam: overrides.homeTeam ?? "Houston",
    visitorScore: overrides.visitorScore ?? 3,
    homeScore: overrides.homeScore ?? 2,
    lineScore: null,
    situation: {
      inningText: overrides.statusText ?? "Top 6th",
      half: null,
      inning: null,
      count: {
        balls: null,
        strikes: null,
      },
      outs: overrides.outs ?? null,
      bases: {
        first: false,
        second: false,
        third: false,
        mask: null,
      },
      battingTeam: null,
      batter: {
        name: null,
        ab: null,
        hits: null,
        summary: null,
      },
      pitcher: {
        name: null,
        pitchCount: overrides.pitchCount ?? null,
      },
    },
    thisInning: null,
    fetchedAt: "2026-02-19T12:00:00.000Z",
  };
}
