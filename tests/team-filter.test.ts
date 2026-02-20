import { describe, expect, it } from "vitest";
import { isSouthernMissGame } from "../src/utils/team-filter";

describe("southern miss team filter", () => {
  it("matches games where Southern Miss is home or away", () => {
    expect(isSouthernMissGame("Southern Miss", "Kent State")).toBe(true);
    expect(isSouthernMissGame("Louisiana Tech", "Southern Miss")).toBe(true);
  });

  it("does not match non-Southern-Miss games", () => {
    expect(isSouthernMissGame("Kent State", "#1 LSU")).toBe(false);
  });
});
