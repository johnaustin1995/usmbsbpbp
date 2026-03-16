import fs from "fs";
import path from "path";

interface TeamBrandingPayload {
  teams?: TeamBranding[];
}

interface TeamBranding {
  school?: string;
  displayName?: string;
  shortDisplayName?: string;
  abbreviation?: string;
  aliases?: string[];
  logo?: {
    primary?: TeamBrandingLogoEntry;
    dark?: TeamBrandingLogoEntry;
  };
}

interface TeamBrandingLogoEntry {
  href?: string;
}

const BRANDING_TEAM_ALIASES: Record<string, string> = {
  albany: "ualbany",
  "appalachian st": "app st",
  "college of charleston": "charleston",
  connecticut: "uconn",
  "csu bakersfield": "cal st bakersfield",
  hawaii: "hawai i",
  "illinois chicago": "uic",
  "new jersey tech": "njit",
  "southeastern louisiana": "se louisiana",
  tarleton: "tarleton st",
  "tennessee martin": "ut martin",
  "usc upstate": "south carolina upstate",
};

let brandingLogoIndex: Map<string, string> | null = null;

export function getBrandingLogoUrl(teamName: string): string | null {
  const normalized = normalizeBrandingTeamName(teamName);
  if (!normalized) {
    return null;
  }

  if (brandingLogoIndex === null) {
    brandingLogoIndex = loadBrandingLogoIndex();
  }

  return brandingLogoIndex.get(normalized) ?? null;
}

export function normalizeBrandingTeamName(value: string | null | undefined): string {
  const input = String(value ?? "").trim();
  if (!input) {
    return "";
  }

  const normalized = input
    .replace(/^#\d+\s+/u, "")
    .replace(/([A-Za-z])&s\b/gu, "$1's")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\buniversity\b/g, "u")
    .replace(/\bstate\b/g, "st")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bmount\b/g, "mt")
    .replace(/\s+/g, " ")
    .trim();

  return BRANDING_TEAM_ALIASES[normalized] ?? normalized;
}

function loadBrandingLogoIndex(): Map<string, string> {
  const index = new Map<string, string>();
  const file = path.resolve(__dirname, "../../public/data/team-branding.json");

  try {
    const raw = fs.readFileSync(file, "utf8");
    const payload = JSON.parse(raw) as TeamBrandingPayload;
    const teams = Array.isArray(payload.teams) ? payload.teams : [];

    for (const team of teams) {
      const logoUrl = resolveBrandingLogoUrl(team);
      if (!logoUrl) {
        continue;
      }

      const keys = [
        team.school,
        team.displayName,
        team.shortDisplayName,
        team.abbreviation,
        ...(Array.isArray(team.aliases) ? team.aliases : []),
      ];

      for (const key of keys) {
        const normalized = normalizeBrandingTeamName(key);
        if (!normalized || index.has(normalized)) {
          continue;
        }
        index.set(normalized, logoUrl);
      }
    }
  } catch {
    return index;
  }

  return index;
}

function resolveBrandingLogoUrl(team: TeamBranding): string | null {
  const primary = cleanLogoHref(team.logo?.primary?.href);
  if (primary) {
    return primary;
  }

  return cleanLogoHref(team.logo?.dark?.href);
}

function cleanLogoHref(value: string | undefined): string | null {
  const clean = String(value ?? "").trim();
  return clean.length > 0 ? clean : null;
}
