import { cleanText } from "./text";

const SOUTHERN_MISS_ALIASES = new Set([
  "southern miss",
  "southern mississippi",
  "southern miss golden eagles",
]);

export function isSouthernMissGame(awayTeam: string, homeTeam: string): boolean {
  return isSouthernMissTeam(awayTeam) || isSouthernMissTeam(homeTeam);
}

function isSouthernMissTeam(teamName: string): boolean {
  const normalized = normalizeTeamName(teamName);
  if (!normalized) {
    return false;
  }

  if (SOUTHERN_MISS_ALIASES.has(normalized)) {
    return true;
  }

  return normalized.includes("southern miss");
}

function normalizeTeamName(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
