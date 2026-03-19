import { describe, expect, it } from "vitest";
import { findD1TeamSeasonDataByKey } from "../src/scrapers/d1";
import type { D1TeamSeasonData } from "../src/types";

describe("findD1TeamSeasonDataByKey", () => {
  const teams: D1TeamSeasonData[] = [
    {
      id: 145901,
      name: "UCLA",
      slug: "ucla",
      season: "2026",
      conference: null,
      overallRecord: "17-2",
      logoUrl: "https://example.com/ucla.png",
      teamUrl: "https://d1baseball.com/team/ucla/2026/",
      scheduleUrl: "https://d1baseball.com/team/ucla/2026/schedule/",
      statsUrl: "https://d1baseball.com/team/ucla/2026/stats/",
      schedule: [],
      statsTables: [],
      errors: [],
    },
    {
      id: 145902,
      name: "Southern Miss",
      slug: "southern-miss",
      season: "2026",
      conference: null,
      overallRecord: "15-4",
      logoUrl: "https://example.com/usm.png",
      teamUrl: "https://d1baseball.com/team/southern-miss/2026/",
      scheduleUrl: "https://d1baseball.com/team/southern-miss/2026/schedule/",
      statsUrl: "https://d1baseball.com/team/southern-miss/2026/stats/",
      schedule: [],
      statsTables: [],
      errors: [],
    },
  ];

  it("matches by id, slug, url, and normalized team name", () => {
    expect(findD1TeamSeasonDataByKey(teams, "145901")?.slug).toBe("ucla");
    expect(findD1TeamSeasonDataByKey(teams, "southern-miss")?.name).toBe("Southern Miss");
    expect(findD1TeamSeasonDataByKey(teams, "https://d1baseball.com/team/ucla/2026/")?.name).toBe("UCLA");
    expect(findD1TeamSeasonDataByKey(teams, "southern miss")?.slug).toBe("southern-miss");
  });
});
