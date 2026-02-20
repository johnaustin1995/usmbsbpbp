import { describe, expect, it } from "vitest";
import {
  parsePitchContextFromText,
  parsePlayDescription,
  resolveScoringDecisionContext,
  parseScoringDecisionContext,
  normalizePlayerDisplayName,
} from "../src/scorekeeping/baseball";

describe("baseball scorekeeping play parser", () => {
  it("classifies common scoring outcomes", () => {
    const single = parsePlayDescription(
      "Goldstein,Cade singled to right field, RBI (3-2 BKSBFB); Kelly,Rowan scored."
    );
    expect(single.outcome).toBe("single");
    expect(single.tags).toContain("single");
    expect(single.tags).toContain("run_scored");
    expect(single.tags).toContain("rbi");

    const homer = parsePlayDescription("Barrett,Drey homered to left field, RBI (2-1 BKB).");
    expect(homer.outcome).toBe("home_run");
    expect(homer.tags).toContain("home_run");
    expect(homer.tags).toContain("rbi");
  });

  it("classifies outs and base-running events", () => {
    const strikeout = parsePlayDescription("Mendez,Jonathan struck out looking (1-2 KKBK).");
    expect(strikeout.outcome).toBe("strikeout");

    const dp = parsePlayDescription(
      "Karliner,Noah struck out looking (3-2 BKKBBK); Esquer,Xavier is out caught stealing, in a double play."
    );
    expect(dp.tags).toContain("double_play");
    expect(dp.outcome).toBe("caught_stealing");

    const wildPitch = parsePlayDescription("Kelly,Rowan advanced to third base on a wild pitch.");
    expect(wildPitch.outcome).toBe("wild_pitch");
    expect(wildPitch.tags).toContain("wild_pitch");
  });

  it("parses final count and pitch sequence from play text", () => {
    const parsed = parsePitchContextFromText(
      "Goldstein,Cade singled to right field, RBI (3-2 BKSBFB); Kelly,Rowan scored."
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.finalCount).toEqual({ balls: 3, strikes: 2 });
    expect(parsed?.rawSequence).toBe("BKSBFB");
    expect(parsed?.pitches.map((pitch) => pitch.description)).toEqual([
      "ball",
      "called_strike",
      "swinging_strike",
      "ball",
      "foul",
      "ball",
    ]);
  });

  it("prefers the last count sequence when multiple parentheticals exist", () => {
    const parsed = parsePitchContextFromText(
      "Husovsky,Nick homered to right field (383 ft), 2nd of season, RBI (1-0 B)."
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.finalCount).toEqual({ balls: 1, strikes: 0 });
    expect(parsed?.rawSequence).toBe("B");
    expect(parsed?.pitches[0].description).toBe("ball");
  });

  it("parses scoring decision fielder location codes", () => {
    const context = parseScoringDecisionContext("HR 9 1RBI");
    expect(context).not.toBeNull();
    expect(context?.playCode).toBe("HR");
    expect(context?.fielderCodes).toEqual([9]);
    expect(context?.fieldLocations[0]).toEqual({
      code: 9,
      abbreviation: "RF",
      name: "right field",
    });
    expect(context?.rbi).toBe(1);
  });

  it("uses play-text location as source of truth over scorecard location codes", () => {
    const resolved = resolveScoringDecisionContext(
      "HR 9 1RBI",
      "Example batter homered to center field, RBI (2-1 BKS)."
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.playCode).toBe("HR");
    expect(resolved?.fielderCodes).toEqual([8]);
    expect(resolved?.fieldLocations[0]).toEqual({
      code: 8,
      abbreviation: "CF",
      name: "center field",
    });
  });

  it("fills location from play text when scoring decision has no fielder code", () => {
    const resolved = resolveScoringDecisionContext(
      "1RBI",
      "Stockman,Tucker sacrifice fly to rf, RBI (2-2 KBBF);"
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.fielderCodes).toEqual([9]);
    expect(resolved?.fieldLocations[0]).toEqual({
      code: 9,
      abbreviation: "RF",
      name: "right field",
    });
  });

  it("normalizes player display names from Last,First to First Last", () => {
    expect(normalizePlayerDisplayName("Kelly,Rowan")).toBe("Rowan Kelly");
    expect(normalizePlayerDisplayName("Clark,Camden")).toBe("Camden Clark");
    expect(normalizePlayerDisplayName("Rowan Kelly")).toBe("Rowan Kelly");
    expect(normalizePlayerDisplayName(null)).toBeNull();
  });
});
