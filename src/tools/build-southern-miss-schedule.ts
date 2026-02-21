import fs from "fs/promises";
import path from "path";
import { getD1Scores } from "../scrapers/d1";
import { isSouthernMissGame } from "../utils/team-filter";

interface CliOptions {
  startDate: string;
  endDate: string;
  outPath: string;
}

interface ScheduleGame {
  date: string;
  gameId: number | null;
  startTimeEpochEt: number | null;
  startTimeIsoEt: string | null;
  startTimeEpoch: number | null;
  startTimeIso: string | null;
  startTimeEt: string | null;
  statusText: string;
  awayTeam: string;
  homeTeam: string;
  hasStatbroadcastId: boolean;
  liveStatsUrl: string | null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const games = await buildSchedule(options.startDate, options.endDate);

  await fs.mkdir(path.dirname(options.outPath), { recursive: true });
  await fs.writeFile(
    options.outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "https://d1baseball.com/wp-content/plugins/integritive/dynamic-scores.php",
        range: {
          startDate: options.startDate,
          endDate: options.endDate,
        },
        games,
      },
      null,
      2
    ),
    "utf8"
  );

  const withIds = games.filter((game) => game.gameId !== null).length;
  const missingIds = games.length - withIds;

  // eslint-disable-next-line no-console
  console.log(`# Southern Miss schedule written: ${options.outPath}`);
  // eslint-disable-next-line no-console
  console.log(`# Games found: ${games.length} | With StatBroadcast IDs: ${withIds} | Missing IDs: ${missingIds}`);
}

async function buildSchedule(startDate: string, endDate: string): Promise<ScheduleGame[]> {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (start > end) {
    throw new Error(`Start date ${startDate} must be <= end date ${endDate}.`);
  }

  const result: ScheduleGame[] = [];

  for (let current = new Date(start); current <= end; current = addDaysUtc(current, 1)) {
    const yyyymmdd = formatYyyymmdd(current);
    const payload = await getD1Scores(yyyymmdd);
    const games = payload.games.filter((game) => isSouthernMissGame(game.roadTeam.name, game.homeTeam.name));

    for (const game of games) {
      const startTimeEpochEt = parseStatusTimeEpochEt(current, game.statusText);
      result.push({
        date: formatIsoDateUtc(current),
        gameId: game.statbroadcastId ?? null,
        startTimeEpochEt,
        startTimeIsoEt: toIsoFromEpoch(startTimeEpochEt),
        startTimeEpoch: game.matchupTimeEpoch ?? null,
        startTimeIso: game.matchupTimeIso ?? null,
        startTimeEt: formatEpochEt(game.matchupTimeEpoch ?? null),
        statusText: game.statusText,
        awayTeam: stripRecordSuffix(game.roadTeam.name),
        homeTeam: stripRecordSuffix(game.homeTeam.name),
        hasStatbroadcastId: game.statbroadcastId !== null,
        liveStatsUrl: game.liveStatsUrl ?? null,
      });
    }
  }

  const deduped = new Map<string, ScheduleGame>();
  for (const game of result) {
    const key =
      game.gameId !== null
        ? `id:${game.gameId}`
        : `${game.date}|${normalizeTeamKey(game.awayTeam)}|${normalizeTeamKey(game.homeTeam)}`;
    if (!deduped.has(key)) {
      deduped.set(key, game);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const aEpoch = a.startTimeEpoch ?? Number.MAX_SAFE_INTEGER;
    const bEpoch = b.startTimeEpoch ?? Number.MAX_SAFE_INTEGER;
    if (aEpoch !== bEpoch) {
      return aEpoch - bEpoch;
    }
    return a.date.localeCompare(b.date);
  });
}

function parseArgs(argv: string[]): CliOptions {
  let startDate = "20260221";
  let endDate = "20260630";
  let outPath = path.resolve(process.cwd(), "data", "schedules", "southern-miss-2026.json");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--start") {
      if (!next) {
        throw new Error("Missing value for --start");
      }
      startDate = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--end") {
      if (!next) {
        throw new Error("Missing value for --end");
      }
      endDate = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--out") {
      if (!next) {
        throw new Error("Missing value for --out");
      }
      outPath = path.resolve(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: npx tsx src/tools/build-southern-miss-schedule.ts [--start 20260221] [--end 20260630] [--out data/schedules/southern-miss-2026.json]"
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!/^\d{8}$/.test(startDate) || !/^\d{8}$/.test(endDate)) {
    throw new Error("Dates must use YYYYMMDD format.");
  }

  return { startDate, endDate, outPath };
}

function parseDate(yyyymmdd: string): Date {
  const year = Number.parseInt(yyyymmdd.slice(0, 4), 10);
  const month = Number.parseInt(yyyymmdd.slice(4, 6), 10);
  const day = Number.parseInt(yyyymmdd.slice(6, 8), 10);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatYyyymmdd(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

function formatIsoDateUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

function formatEpochEt(epoch: number | null): string | null {
  if (epoch === null || !Number.isFinite(epoch)) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(epoch * 1000));
}

function parseStatusTimeEpochEt(date: Date, statusText: string): number | null {
  const match = cleanStatusTime(statusText);
  if (!match) {
    return null;
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(match.hour24).padStart(2, "0");
  const minute = String(match.minute).padStart(2, "0");

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const target = `${year}-${month}-${day} ${hour}:${minute}:00`;

  for (let offsetMinutes = -6 * 60; offsetMinutes <= 6 * 60; offsetMinutes += 30) {
    const candidateUtc = Date.UTC(
      year,
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      match.hour24,
      match.minute
    );
    const shifted = new Date(candidateUtc - offsetMinutes * 60 * 1000);
    const parts = formatter.formatToParts(shifted);
    const rebuilt = `${valueFor(parts, "year")}-${valueFor(parts, "month")}-${valueFor(parts, "day")} ${valueFor(
      parts,
      "hour"
    )}:${valueFor(parts, "minute")}:${valueFor(parts, "second")}`;
    if (rebuilt === target) {
      return Math.floor(shifted.getTime() / 1000);
    }
  }

  return null;
}

function cleanStatusTime(statusText: string): { hour24: number; minute: number } | null {
  const match = statusText.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) {
    return null;
  }

  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const ampm = match[3].toUpperCase();

  if (ampm === "AM" && hour === 12) {
    hour = 0;
  }
  if (ampm === "PM" && hour !== 12) {
    hour += 12;
  }

  return { hour24: hour, minute };
}

function valueFor(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function toIsoFromEpoch(epoch: number | null): string | null {
  if (epoch === null || !Number.isFinite(epoch)) {
    return null;
  }
  return new Date(epoch * 1000).toISOString();
}

function stripRecordSuffix(value: string): string {
  return value.replace(/\([^)]*\)\s*$/u, "").trim();
}

function normalizeTeamKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`build-southern-miss-schedule failed: ${message}`);
  process.exit(1);
});
