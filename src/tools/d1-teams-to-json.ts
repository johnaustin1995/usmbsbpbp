import fs from "fs/promises";
import path from "path";
import { getD1TeamsDatabase } from "../scrapers/d1";

interface CliOptions {
  outPath: string | null;
  season: string | null;
  concurrency: number;
  conferenceConcurrency: number;
  teamLimit: number | null;
  includeSchedule: boolean;
  includeStats: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const payload = await getD1TeamsDatabase({
    season: options.season,
    concurrency: options.concurrency,
    conferenceConcurrency: options.conferenceConcurrency,
    teamLimit: options.teamLimit,
    includeSchedule: options.includeSchedule,
    includeStats: options.includeStats,
  });

  const defaultName = `d1-teams-${payload.season ?? "current"}-${new Date().toISOString().slice(0, 10)}.json`;
  const outPath = options.outPath ?? path.resolve(process.cwd(), "data", "tmp", "teams", defaultName);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");

  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(`Teams: ${payload.teams.length} | Conferences: ${payload.conferences.length}`);
  if (payload.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`Global warnings: ${payload.errors.length}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outPath: null,
    season: null,
    concurrency: 8,
    conferenceConcurrency: 4,
    teamLimit: null,
    includeSchedule: true,
    includeStats: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--out") {
      if (!next) {
        throw new Error("Missing value for --out");
      }
      options.outPath = path.resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--season") {
      if (!next) {
        throw new Error("Missing value for --season");
      }
      options.season = next;
      index += 1;
      continue;
    }

    if (arg === "--concurrency") {
      if (!next) {
        throw new Error("Missing value for --concurrency");
      }
      const value = Number.parseInt(next, 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("Expected a positive integer for --concurrency");
      }
      options.concurrency = value;
      index += 1;
      continue;
    }

    if (arg === "--conference-concurrency") {
      if (!next) {
        throw new Error("Missing value for --conference-concurrency");
      }
      const value = Number.parseInt(next, 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("Expected a positive integer for --conference-concurrency");
      }
      options.conferenceConcurrency = value;
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      if (!next) {
        throw new Error("Missing value for --limit");
      }
      const value = Number.parseInt(next, 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("Expected a positive integer for --limit");
      }
      options.teamLimit = value;
      index += 1;
      continue;
    }

    if (arg === "--no-schedule") {
      options.includeSchedule = false;
      continue;
    }

    if (arg === "--no-stats") {
      options.includeStats = false;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  if (!options.includeSchedule && !options.includeStats) {
    throw new Error("At least one of schedule or stats must be enabled.");
  }

  return options;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    "Usage: npm run teams:json -- [--season 2026] [--out data/tmp/teams/d1-teams.json] [--concurrency 8] [--conference-concurrency 4] [--limit 25] [--no-schedule] [--no-stats]"
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`teams:json failed: ${message}`);
  process.exit(1);
});
