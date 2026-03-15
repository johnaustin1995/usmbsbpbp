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
const PEARATINGS_BASE_URL = "https://pearatings.com";
const PEARATINGS_SOURCES = [
  {
    key: "d1",
    apiPath: "/api/cbase",
    logoPath: "/api/baseball-logo",
  },
  {
    key: "d2",
    apiPath: "/api/d2-cbase",
    logoPath: "/api/d2-baseball-logo",
  },
  {
    key: "d3",
    apiPath: "/api/d3-cbase",
    logoPath: "/api/d3-baseball-logo",
  },
  {
    key: "naia",
    apiPath: "/api/naia-cbase",
    logoPath: "/api/naia-baseball-logo",
  },
];

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

const pearIdentityOverrides = new Map([
  ["espn:118", "Col. of Charleston"],
  ["espn:176", "Miami (FL)"],
  ["espn:30", "Southern California"],
]);

const pearCandidateOverrides = new Map([
  ["alcorn state", "Alcorn"],
  ["alcorn st", "Alcorn"],
  ["cal state bakersfield", "CSU Bakersfield"],
  ["central missouri state", "Central Mo."],
  ["loyola marymount", "LMU (CA)"],
  ["mississippi valley state", "Mississippi Val."],
  ["saint marys", "Saint Mary's (CA)"],
  ["se louisiana", "Southeastern La."],
  ["south carolina upstate", "USC Upstate"],
  ["texas a and m corpus christi", "A&M-Corpus Christi"],
  ["ut rio grande valley", "UTRGV"],
  ["usc", "Southern California"],
  ["western carolina", "Western Caro."],
]);

const pearPhraseAliases = [
  ["texas a and m corpus christi", "a and m corpus christi"],
  ["north carolina", "nc"],
  ["n c", "nc"],
  ["south carolina", "sc"],
  ["s c", "sc"],
  ["north dakota", "nd"],
  ["n d", "nd"],
  ["south dakota", "sd"],
  ["s d", "sd"],
  ["new mexico", "nm"],
  ["n m", "nm"],
  ["new hampshire", "nh"],
  ["n h", "nh"],
  ["new jersey", "nj"],
  ["n j", "nj"],
  ["new york", "ny"],
  ["n y", "ny"],
  ["west virginia", "wv"],
  ["w v", "wv"],
  ["rhode island", "ri"],
  ["r i", "ri"],
  ["los angeles", "la"],
  ["cal state", "csu"],
  ["cal st", "csu"],
  ["se louisiana", "southeastern la"],
  ["southeastern louisiana", "southeastern la"],
  ["west point", ""],
];

const pearTokenAliases = new Map([
  ["alabama", "ala"],
  ["ala", "ala"],
  ["arizona", "ariz"],
  ["ariz", "ariz"],
  ["arkansas", "ark"],
  ["ark", "ark"],
  ["california", "cal"],
  ["cal", "cal"],
  ["college", "college"],
  ["col", "college"],
  ["colorado", "colo"],
  ["colo", "colo"],
  ["connecticut", "conn"],
  ["conn", "conn"],
  ["florida", "fla"],
  ["fla", "fla"],
  ["georgia", "ga"],
  ["ga", "ga"],
  ["illinois", "ill"],
  ["ill", "ill"],
  ["indiana", "ind"],
  ["ind", "ind"],
  ["kentucky", "ky"],
  ["ky", "ky"],
  ["louisiana", "la"],
  ["la", "la"],
  ["maryland", "md"],
  ["md", "md"],
  ["massachusetts", "mass"],
  ["mass", "mass"],
  ["michigan", "mich"],
  ["mich", "mich"],
  ["minnesota", "minn"],
  ["minn", "minn"],
  ["mississippi", "miss"],
  ["miss", "miss"],
  ["missouri", "mo"],
  ["mo", "mo"],
  ["mount", "mt"],
  ["mt", "mt"],
  ["nebraska", "neb"],
  ["neb", "neb"],
  ["oklahoma", "okla"],
  ["okla", "okla"],
  ["pennsylvania", "pa"],
  ["pa", "pa"],
  ["saint", "st"],
  ["st", "st"],
  ["state", "st"],
  ["tennessee", "tenn"],
  ["tenn", "tenn"],
  ["univ", "u"],
  ["university", "u"],
  ["u", "u"],
  ["virginia", "va"],
  ["va", "va"],
  ["washington", "wash"],
  ["wash", "wash"],
]);

const pearFillerTokens = new Set(["college", "of", "the", "u"]);

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

  console.log("Fetching Pearatings baseball team feeds...");
  const pearatingsData = await loadPearatingsSources();
  await writeJson(path.join(rawDir, "pearatings-baseball-teams.json"), pearatingsData);
  const pearatingsIndex = buildPearatingsIndex(pearatingsData.sources);
  const pearLoadedTeams = pearatingsData.sources.reduce((total, source) => total + source.teams.length, 0);
  const pearLoadedDivisions = pearatingsData.sources.filter((source) => !source.error).length;
  console.log(`Loaded ${pearLoadedTeams} Pearatings teams across ${pearLoadedDivisions} divisions.`);

  const mergedTeams = limitedTeams.map((espnTeam) => mergeTeamBranding(espnTeam, teamcolorIndex, pearatingsIndex));

  let downloadedCount = 0;
  let failedDownloads = 0;
  let removedCount = 0;
  const referencedLogoFiles = new Set();

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
      const filename = buildLogoFilename(job.team, job.slot, job.remote);
      const localFilePath = path.join(logosDir, filename);
      const localWebPath = `/assets/logos/teams/${filename}`;

      try {
        const wrote = await downloadFile(job.remote.href, localFilePath, options.force);
        if (wrote) {
          downloadedCount += 1;
        }

        job.remote.localPath = localWebPath;
        delete job.remote.fallback;
        referencedLogoFiles.add(localFilePath);
      } catch (error) {
        const fallback = job.remote.provider === "pearatings" ? cloneLogoEntry(job.remote.fallback) : null;
        if (fallback?.href) {
          try {
            const fallbackFilename = buildLogoFilename(job.team, job.slot, fallback);
            const fallbackFilePath = path.join(logosDir, fallbackFilename);
            const fallbackWebPath = `/assets/logos/teams/${fallbackFilename}`;
            const wrote = await downloadFile(fallback.href, fallbackFilePath, options.force);
            if (wrote) {
              downloadedCount += 1;
            }

            Object.keys(job.remote).forEach((key) => {
              delete job.remote[key];
            });
            Object.assign(job.remote, fallback, {
              localPath: fallbackWebPath,
              error: null,
            });
            job.team.source.logoProvider = "espn-fallback";
            referencedLogoFiles.add(fallbackFilePath);
            return;
          } catch {
            // Fall through to the original Pear failure below.
          }
        }

        failedDownloads += 1;
        delete job.remote.fallback;
        job.remote.localPath = null;
        job.remote.error = error instanceof Error ? error.message : "logo download failed";
      }
    });

    removedCount = await removeUnusedLogoFiles(logosDir, referencedLogoFiles);
  }

  mergedTeams.sort((a, b) => a.school.localeCompare(b.school));

  const output = {
    generatedAt: new Date().toISOString(),
    sources: {
      espnTeamsApi: ESPN_TEAMS_URL,
      teamcolorsCsv: TEAMCOLORS_URL,
      pearatings: pearatingsData.sources.map((source) => ({
        key: source.key,
        apiPath: source.apiPath,
        logoPath: source.logoPath,
        currentSeason: source.currentSeason,
        teamCount: source.teams.length,
        error: source.error,
      })),
    },
    counts: summarizeCounts(mergedTeams, teamcolorRows.length),
    options,
    downloads: {
      downloaded: downloadedCount,
      failed: failedDownloads,
      removed: removedCount,
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
    console.log(`Logos downloaded: ${downloadedCount}, failed: ${failedDownloads}, removed: ${removedCount}`);
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

function mergeTeamBranding(espnTeam, teamcolorIndex, pearatingsIndex) {
  const identity = teamIdentity(espnTeam);
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
  const espnLogoPrimary = pickLogo(logos, "default");
  const espnLogoDark = pickLogo(logos, "dark");
  const pearMatch = matchPearatingsTeam(espnTeam, pearatingsIndex);
  const logoPrimary = pearMatch ? createPearatingsLogoEntry(pearMatch, espnLogoPrimary) : espnLogoPrimary;
  const logoDark = pearMatch ? null : espnLogoDark;

  return {
    id: identity,
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
      pearatings: Boolean(pearMatch),
      pearatingsName: nonEmptyOrNull(pearMatch?.name),
      pearatingsDivision: nonEmptyOrNull(pearMatch?.division),
      pearatingsMatchedBy: nonEmptyOrNull(pearMatch?.matchedBy),
      teamcolors: Boolean(teamcolorRow),
      teamcolorsName: nonEmptyOrNull(teamcolorRow?.name),
      matchedBy: nonEmptyOrNull(matchedBy),
      logoProvider: pearMatch ? "pearatings" : logoPrimary ? "espn" : null,
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
      provider: "espn",
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

async function loadPearatingsSources() {
  const sources = await Promise.all(
    PEARATINGS_SOURCES.map(async (source) => {
      try {
        const currentSeasonPayload = await fetchJson(`${PEARATINGS_BASE_URL}${source.apiPath}/current-season`);
        const currentSeason = toNumberOrNull(currentSeasonPayload?.year);
        if (!currentSeason) {
          throw new Error(`Missing current season for ${source.key}`);
        }

        const teamsPayload = await fetchJson(
          `${PEARATINGS_BASE_URL}${source.apiPath}/teams?season=${currentSeason}`,
        );
        const teams = uniqueStrings(Array.isArray(teamsPayload?.teams) ? teamsPayload.teams : []);

        return {
          ...source,
          currentSeason,
          teams,
          error: null,
        };
      } catch (error) {
        return {
          ...source,
          currentSeason: null,
          teams: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return {
    fetchedAt: new Date().toISOString(),
    baseUrl: PEARATINGS_BASE_URL,
    sources,
  };
}

function buildPearatingsIndex(sources) {
  const entryById = new Map();
  const nameBuckets = new Map();
  const keyBuckets = new Map();

  for (const source of sources) {
    if (source.error || !Array.isArray(source.teams)) {
      continue;
    }

    for (const teamName of source.teams) {
      const entryId = `${source.key}:${teamName}`;
      const entry = {
        id: entryId,
        name: teamName,
        division: source.key,
        logoUrl: `${PEARATINGS_BASE_URL}${source.logoPath}/${encodeURIComponent(teamName)}`,
      };

      entryById.set(entryId, entry);
      addPearBucketValue(nameBuckets, teamName, entryId);

      for (const key of buildPearatingsLookupKeys(teamName)) {
        addPearBucketValue(keyBuckets, key, entryId);
      }
    }
  }

  return {
    entryByExactName: collapseUniqueBuckets(nameBuckets, entryById),
    entryByLookupKey: collapseUniqueBuckets(keyBuckets, entryById),
  };
}

function addPearBucketValue(buckets, key, entryId) {
  if (!buckets.has(key)) {
    buckets.set(key, new Set());
  }
  buckets.get(key).add(entryId);
}

function collapseUniqueBuckets(buckets, entryById) {
  const index = new Map();

  for (const [key, entryIds] of buckets) {
    if (entryIds.size !== 1) {
      continue;
    }

    const [entryId] = [...entryIds];
    const entry = entryById.get(entryId);
    if (entry) {
      index.set(key, entry);
    }
  }

  return index;
}

function matchPearatingsTeam(espnTeam, pearatingsIndex) {
  const identity = teamIdentity(espnTeam);
  const identityOverride = pearIdentityOverrides.get(identity);
  if (identityOverride) {
    const entry = pearatingsIndex.entryByExactName.get(identityOverride);
    if (entry) {
      return {
        ...entry,
        matchedBy: identity,
      };
    }
  }

  for (const candidate of candidateSchoolNames(espnTeam)) {
    const override = pearCandidateOverrides.get(canonicalizePearatingsName(candidate));
    if (override) {
      const entry = pearatingsIndex.entryByExactName.get(override);
      if (entry) {
        return {
          ...entry,
          matchedBy: `${candidate} -> ${override}`,
        };
      }
    }

    for (const key of buildPearatingsLookupKeys(candidate)) {
      const entry = pearatingsIndex.entryByLookupKey.get(key);
      if (entry) {
        return {
          ...entry,
          matchedBy: candidate,
        };
      }
    }
  }

  return null;
}

function createPearatingsLogoEntry(match, fallbackLogo) {
  return {
    href: match.logoUrl,
    width: null,
    height: null,
    rel: ["pearatings", match.division, "baseball"],
    localPath: null,
    error: null,
    provider: "pearatings",
    division: match.division,
    fallback: cloneLogoEntry(fallbackLogo),
  };
}

function cloneLogoEntry(logo) {
  if (!logo) {
    return null;
  }

  return {
    href: logo.href,
    width: logo.width ?? null,
    height: logo.height ?? null,
    rel: Array.isArray(logo.rel) ? [...logo.rel] : [],
    localPath: logo.localPath ?? null,
    error: logo.error ?? null,
    provider: logo.provider ?? null,
    division: logo.division ?? null,
  };
}

function buildPearatingsLookupKeys(value) {
  const base = canonicalizePearatingsName(value);
  if (!base) {
    return [];
  }

  const keys = new Set([base]);
  const withoutFillers = removePearFillerTokens(base);
  if (withoutFillers && withoutFillers !== base) {
    keys.add(withoutFillers);
  }

  const withoutTrailingState = trimTrailingPearToken(base, "st");
  if (withoutTrailingState && withoutTrailingState !== base) {
    keys.add(withoutTrailingState);
  }

  const withoutFillersAndState = trimTrailingPearToken(withoutFillers, "st");
  if (withoutFillersAndState && withoutFillersAndState !== withoutFillers) {
    keys.add(withoutFillersAndState);
  }

  const withoutCampusCode = trimTrailingCampusCode(base);
  if (withoutCampusCode && withoutCampusCode !== base) {
    keys.add(withoutCampusCode);
  }

  const withoutCampusCodeAndFillers = removePearFillerTokens(withoutCampusCode);
  if (withoutCampusCodeAndFillers && withoutCampusCodeAndFillers !== withoutCampusCode) {
    keys.add(withoutCampusCodeAndFillers);
  }

  return [...keys];
}

function canonicalizePearatingsName(value) {
  let raw = String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const [from, to] of pearPhraseAliases) {
    raw = raw.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }

  return raw
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => pearTokenAliases.get(token) ?? token)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function removePearFillerTokens(key) {
  return String(key ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .filter((token) => !pearFillerTokens.has(token))
    .join(" ");
}

function trimTrailingPearToken(key, tokenToTrim) {
  const tokens = String(key ?? "")
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens.length < 2 || tokens[tokens.length - 1] !== tokenToTrim) {
    return null;
  }

  return tokens.slice(0, -1).join(" ");
}

function trimTrailingCampusCode(key) {
  const tokens = String(key ?? "")
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }

  const last = tokens[tokens.length - 1];
  if (!/^[a-z]{2,3}$/u.test(last)) {
    return null;
  }

  return tokens.slice(0, -1).join(" ");
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

async function removeUnusedLogoFiles(directory, referencedFiles) {
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    if (referencedFiles.has(filePath)) {
      continue;
    }

    await fs.unlink(filePath);
    removed += 1;
  }

  return removed;
}

function summarizeCounts(teams, teamcolorTotal) {
  let matchedTeamcolors = 0;
  let withPrimaryColor = 0;
  let withSecondaryColor = 0;
  let withPearLogo = 0;
  let withEspnLogo = 0;
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
    if (team.logo.primary?.provider === "pearatings") {
      withPearLogo += 1;
    } else if (team.logo.primary?.href) {
      withEspnLogo += 1;
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
    withPearLogo,
    withEspnLogo,
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

function buildLogoFilename(team, slot, remote) {
  const provider =
    remote?.provider === "pearatings"
      ? `pear-${safeId(remote.division || "baseball")}`
      : safeId(remote?.provider || "remote");
  const extension = extensionFromUrl(remote?.href);
  const teamKey = team?.espnId ?? team?.id ?? "team";
  return `${provider}-${safeId(teamKey)}-${slot}${extension}`;
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === __filename);

export {
  buildPearatingsIndex,
  buildPearatingsLookupKeys,
  canonicalizePearatingsName,
  matchPearatingsTeam,
};

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
