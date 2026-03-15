import { describe, expect, it } from "vitest";
import {
  buildPearatingsIndex,
  buildPearatingsLookupKeys,
  canonicalizePearatingsName,
  matchPearatingsTeam,
} from "../scripts/import-team-branding.mjs";

const pearatingsIndex = buildPearatingsIndex([
  {
    key: "d1",
    logoPath: "/api/baseball-logo",
    teams: ["Southern Miss.", "Fla. Atlantic", "Miami (FL)", "Miami (OH)", "Col. of Charleston"],
    error: null,
  },
]);

describe("Pearatings branding matcher", () => {
  it("normalizes punctuation-heavy school names", () => {
    expect(canonicalizePearatingsName("Southern Miss.")).toBe("southern miss");
    expect(canonicalizePearatingsName("Hawai'i")).toBe("hawaii");
  });

  it("matches abbreviation-heavy Pearatings school names", () => {
    const match = matchPearatingsTeam(
      {
        id: "163",
        location: "Florida Atlantic",
        shortDisplayName: "FAU",
        displayName: "Florida Atlantic Owls",
        abbreviation: "FAU",
      },
      pearatingsIndex,
    );

    expect(buildPearatingsLookupKeys("Florida Atlantic")).toContain("fla atlantic");
    expect(match?.name).toBe("Fla. Atlantic");
  });

  it("applies identity overrides for ambiguous schools", () => {
    const miami = matchPearatingsTeam(
      {
        id: "176",
        location: "Miami",
        shortDisplayName: "Miami",
        displayName: "Miami Hurricanes",
        abbreviation: "MIA",
      },
      pearatingsIndex,
    );
    const charleston = matchPearatingsTeam(
      {
        id: "118",
        location: "Charleston",
        shortDisplayName: "Charleston",
        displayName: "Charleston Cougars",
        abbreviation: "COFC",
      },
      pearatingsIndex,
    );

    expect(miami?.name).toBe("Miami (FL)");
    expect(charleston?.name).toBe("Col. of Charleston");
  });
});
