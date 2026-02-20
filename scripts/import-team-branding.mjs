#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import axios from "axios";

const ESPN_TEAMS_URL =
  "https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/teams?limit=1000";
const TEAMCOLORS_URL =
  "https://raw.githubusercontent.com/beanumber/teamcolors/master/data-csv/teamcolors_ncaa.csv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const rawDir = path.join(projectRoot, "data", "branding", "raw");
const outputPath = path.join(projectRoot, "data", "branding", "team-branding.json");
const publicOutputPath = path.join(projectRoot, "public", "data", "team-branding.json");
const logosDir = path.join(projectRoot, "public", "assets", "logos", "teams");

const manualNameAliases = new Map([
  ["miami", "Miami (FL)"],
  ["louisiana monroe", "UL Monroe"],
  ["southern cal", "USC"],
  ["cal state fullerton", "Cal State Fullerton"],
  ["ole miss", "Mississippi"],
  ["texas a&m corpus christi", "A&M-Corpus Christi"],
  ["abilene chrstn", "Abilene Christian"],
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));

  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(path.dirname(publicOutputPath), { recursive: true });
  await fs.mkdir(logosDir, { recursive: true });

  console.log("Fetching ESPN teams feed...");
  const espnPayload = await fetchJson(ESPN_TEAMS_URL);
  await writeJson(path.join(rawDir, "espn-teams.json"), espnPayload);

  const espnTeams = extractEspnTeams(espnPayload);
  const limitedTeams = options.limit ? espnTeams.slice(0, options.limit) : espnTeams;
  console.log(`Loaded ${limitedTeams.length} ESPN teams.`);

  console.log("Fetching teamcolors NCAA CSV...");
  const teamcolorsCsv = await fetchText(TEAMCOLORS_URL);
  await fs.writeFile(path.join(rawDir, "teamcolors-ncaa.csv"), teamcolorsCsv, "utf8");

  const teamcolorRows = parseTeamcolorsCsv(teamcolorsCsv);
  const teamcolorIndex = buildTeamcolorIndex(teamcolorRows);
  console.log(`Loaded ${teamcolorRows.length} teamcolors rows.`);

  const mergedTeams = limitedTeams.map((espnTeam) => mergeTeamBranding(espnTeam, teamcolorIndex));

  let downloadedCount = 0;
  let failedDownloads = 0;

  if (!options.skipLogos) {
    console.log("Downloading local logo assets...");
    const logoJobs = mergedTeams
      .map((team) => [
        team.logo.primary ? { team, slot: "primary", remote: team.logo.primary } : null,
        team.logo.dark ? { team, slot: "dark", remote: team.logo.dark } : null,
      ])
      .flat()
      .filter(Boolean);

    await runWithConcurrency(logoJobs, 8, async (job) => {
      const extension = extensionFromUrl(job.remote.href);
      const filename = `${safeId(job.team.id)}-${job.slot}${extension}`;
      const localFilePath = path.join(logosDir, filename);
      const localWebPath = `/assets/logos/teams/${filename}`;

      try {
        const wrote = await downloadFile(job.remote.href, localFilePath, options.force);
        if (wrote) {
          downloadedCount += 1;
        }

        job.remote.localPath = localWebPath;
      } catch (error) {
        failedDownloads += 1;
        job.remote.localPath = null;
        job.remote.error = error instanceof Error ? error.message : "logo download failed";
      }
    });
  }

  mergedTeams.sort((a, b) => a.school.localeCompare(b.school));

  const output = {
    generatedAt: new Date().toISOString(),
    sources: {
      espnTeamsApi: ESPN_TEAMS_URL,
      teamcolorsCsv: TEAMCOLORS_URL,
    },
    counts: summarizeCounts(mergedTeams, teamcolorRows.length),
    options,
    downloads: {
      downloaded: downloadedCount,
      failed: failedDownloads,
      skipped: options.skipLogos,
    },
    teams: mergedTeams,
  };

  await writeJson(outputPath, output);
  await writeJson(publicOutputPath, output);

  console.log(`Wrote merged branding JSON: ${outputPath}`);
  console.log(`Wrote frontend copy: ${publicOutputPath}`);
  if (options.skipLogos) {
    console.log("Skipped logo downloads (--skip-logos).");
  } else {
    console.log(`Logos downloaded: ${downloadedCount}, failed: ${failedDownloads}`);
  }
}

function parseArgs(args) {
  const options = {
    skipLogos: false,
    force: false,
    limit: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--skip-logos") {
      options.skipLogos = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--limit") {
      const next = args[i + 1];
      if (!next) {
        throw new Error("Missing value for --limit");
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = parsed;
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage() {
  console.log("Usage: npm run import:branding -- [--skip-logos] [--force] [--limit N]");
}

function extractEspnTeams(payload) {
  const teams = payload?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return teams
    .map((entry) => entry?.team)
    .filter((team) => team && team.id && team.displayName);
}

function parseTeamcolorsCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = normalizeCsvValue(values[i]);
    }
    return row;
  });
}

function parseCsvLine(line) {
  const values = [];
  let buffer = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        buffer += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(buffer);
      buffer = "";
      continue;
    }

    buffer += char;
  }

  values.push(buffer);
  return values;
}

function normalizeCsvValue(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "NA" || trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

function buildTeamcolorIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = normalizeSchoolName(row.name);
    if (key.length > 0 && !index.has(key)) {
      index.set(key, row);
    }
  }
  return index;
}

function mergeTeamBranding(espnTeam, teamcolorIndex) {
  const candidates = candidateSchoolNames(espnTeam);
  let teamcolorRow = null;
  let matchedBy = null;

  for (const candidate of candidates) {
    const normalized = normalizeSchoolName(candidate);
    if (normalized.length === 0) {
      continue;
    }

    if (teamcolorIndex.has(normalized)) {
      teamcolorRow = teamcolorIndex.get(normalized);
      matchedBy = candidate;
      break;
    }

    const alias = manualNameAliases.get(normalized);
    if (alias) {
      const aliasKey = normalizeSchoolName(alias);
      if (teamcolorIndex.has(aliasKey)) {
        teamcolorRow = teamcolorIndex.get(aliasKey);
        matchedBy = `${candidate} -> ${alias}`;
        break;
      }
    }
  }

  const espnPrimary = normalizeColor(espnTeam.color);
  const espnSecondary = normalizeColor(espnTeam.alternateColor);
  const teamcolorPrimary = normalizeColor(teamcolorRow?.primary);
  const teamcolorSecondary = normalizeColor(teamcolorRow?.secondary);
  const teamcolorTertiary = normalizeColor(teamcolorRow?.tertiary);
  const teamcolorQuaternary = normalizeColor(teamcolorRow?.quaternary);

  const logos = Array.isArray(espnTeam.logos) ? espnTeam.logos : [];
  const logoPrimary = pickLogo(logos, "default");
  const logoDark = pickLogo(logos, "dark");

  return {
    id: teamIdentity(espnTeam),
    espnId: toNumberOrNull(espnTeam.id),
    school: firstNonEmpty([espnTeam.location, inferSchoolFromDisplayName(espnTeam.displayName)]),
    displayName: nonEmptyOrNull(espnTeam.displayName),
    shortDisplayName: nonEmptyOrNull(espnTeam.shortDisplayName),
    abbreviation: nonEmptyOrNull(espnTeam.abbreviation),
    slug: nonEmptyOrNull(espnTeam.slug),
    mascot: nonEmptyOrNull(espnTeam.name),
    nickname: nonEmptyOrNull(espnTeam.nickname),
    division: nonEmptyOrNull(teamcolorRow?.division),
    colors: {
      primary: teamcolorPrimary ?? espnPrimary,
      secondary: teamcolorSecondary ?? espnSecondary,
      tertiary: teamcolorTertiary,
      quaternary: teamcolorQuaternary,
      espnPrimary,
      espnSecondary,
    },
    logo: {
      primary: logoPrimary,
      dark: logoDark,
    },
    aliases: uniqueStrings(candidates),
    source: {
      espn: true,
      teamcolors: Boolean(teamcolorRow),
      teamcolorsName: nonEmptyOrNull(teamcolorRow?.name),
      matchedBy: nonEmptyOrNull(matchedBy),
    },
  };
}

function candidateSchoolNames(espnTeam) {
  return uniqueStrings([
    espnTeam.location,
    espnTeam.shortDisplayName,
    espnTeam.displayName,
    inferSchoolFromDisplayName(espnTeam.displayName),
    espnTeam.abbreviation,
  ]);
}

function inferSchoolFromDisplayName(displayName) {
  const clean = nonEmptyOrNull(displayName);
  if (!clean) {
    return null;
  }

  const tokens = clean.split(/\s+/u);
  if (tokens.length <= 1) {
    return clean;
  }

  return tokens.slice(0, tokens.length - 1).join(" ");
}

function pickLogo(logos, relValue) {
  const filtered = logos
    .filter((logo) => logo?.href)
    .map((logo) => ({
      href: logo.href,
      width: toNumberOrNull(logo.width),
      height: toNumberOrNull(logo.height),
      rel: Array.isArray(logo.rel) ? logo.rel : [],
      localPath: null,
      error: null,
    }));

  if (filtered.length === 0) {
    return null;
  }

  const exact = filtered.find((logo) => logo.rel.includes(relValue));
  if (exact) {
    return exact;
  }

  return filtered.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
}

function normalizeSchoolName(value) {
  const raw = String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return raw
    .replace(/\buniversity\b/g, "u")
    .replace(/\bstate\b/g, "st")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bmount\b/g, "mt")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeColor(value) {
  const clean = nonEmptyOrNull(value);
  if (!clean) {
    return null;
  }

  const noHash = clean.replace(/^#/u, "").trim();
  if (!/^[0-9a-f]{6}$/iu.test(noHash)) {
    return null;
  }

  return `#${noHash.toUpperCase()}`;
}

function extensionFromUrl(url) {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (ext === ".svg" || ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".webp") {
      return ext;
    }
  } catch {
    // no-op
  }

  return ".png";
}

async function downloadFile(url, outputFile, force) {
  if (!force) {
    try {
      await fs.access(outputFile);
      return false;
    } catch {
      // continue and download
    }
  }

  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 30_000,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  if (!response.data) {
    throw new Error("failed to fetch logo stream");
  }

  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await pipeline(response.data, createWriteStream(outputFile));
  return true;
}

function summarizeCounts(teams, teamcolorTotal) {
  let matchedTeamcolors = 0;
  let withPrimaryColor = 0;
  let withSecondaryColor = 0;
  let withRemoteLogo = 0;
  let withLocalLogo = 0;

  for (const team of teams) {
    if (team.source.teamcolors) {
      matchedTeamcolors += 1;
    }
    if (team.colors.primary) {
      withPrimaryColor += 1;
    }
    if (team.colors.secondary) {
      withSecondaryColor += 1;
    }
    if (team.logo.primary?.href) {
      withRemoteLogo += 1;
    }
    if (team.logo.primary?.localPath) {
      withLocalLogo += 1;
    }
  }

  return {
    teamcolorsRows: teamcolorTotal,
    mergedTeams: teams.length,
    matchedTeamcolors,
    withPrimaryColor,
    withSecondaryColor,
    withRemoteLogo,
    withLocalLogo,
  };
}

async function runWithConcurrency(items, limit, worker) {
  let currentIndex = 0;

  async function consume() {
    while (true) {
      const index = currentIndex;
      if (index >= items.length) {
        return;
      }
      currentIndex += 1;
      await worker(items[index]);
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, () => consume());
  await Promise.all(workers);
}

async function fetchJson(url) {
  const response = await axios.get(url, {
    timeout: 30_000,
    headers: { Accept: "application/json" },
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 400,
  });

  if (!response.data) {
    throw new Error(`Empty JSON response for ${url}`);
  }
  return response.data;
}

async function fetchText(url) {
  const response = await axios.get(url, {
    timeout: 30_000,
    headers: { Accept: "text/plain" },
    responseType: "text",
    validateStatus: (status) => status >= 200 && status < 400,
  });

  if (typeof response.data !== "string") {
    throw new Error(`Unexpected text response for ${url}`);
  }
  return response.data;
}

async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, "utf8");
}

function toNumberOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmptyOrNull(value) {
  const clean = String(value ?? "").trim();
  return clean.length > 0 ? clean : null;
}

function firstNonEmpty(values) {
  for (const value of values) {
    const clean = nonEmptyOrNull(value);
    if (clean) {
      return clean;
    }
  }
  return null;
}

function uniqueStrings(values) {
  const deduped = [];
  const seen = new Set();
  for (const value of values) {
    const clean = nonEmptyOrNull(value);
    if (!clean) {
      continue;
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      deduped.push(clean);
    }
  }
  return deduped;
}

function teamIdentity(team) {
  const espnId = nonEmptyOrNull(team.id);
  if (espnId) {
    return `espn:${espnId}`;
  }
  return safeId(team.slug || team.displayName || "team");
}

function safeId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
