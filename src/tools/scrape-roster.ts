import fs from "fs/promises";
import path from "path";
import { scrapeRosterPage, type ScrapedRosterPayload } from "../scrapers/roster";

interface CliOptions {
  url: string;
  outPath: string | null;
  timeoutMs: number;
  teamNameOverride: string | null;
  sportOverride: string | null;
  seasonOverride: string | null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const scraped = await scrapeRosterPage({
    url: options.url,
    timeoutMs: options.timeoutMs,
  });

  const payload = applyOverrides(scraped, options);
  const outPath = options.outPath ? path.resolve(options.outPath) : buildDefaultOutPath(payload);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");

  // eslint-disable-next-line no-console
  console.log(`# Roster written: ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(
    `# Team: ${payload.teamName ?? "-"} | Sport: ${payload.sport ?? "-"} | Season: ${payload.season ?? "-"} | Players: ${
      payload.playerCount
    }`
  );
  // eslint-disable-next-line no-console
  console.log(`# Parser: ${payload.parser.strategy} | Candidates: ${payload.parser.candidateRecords} | Deduped: ${payload.parser.dedupedRecords}`);
}

function applyOverrides(payload: ScrapedRosterPayload, options: CliOptions): ScrapedRosterPayload {
  return {
    ...payload,
    teamName: options.teamNameOverride || payload.teamName,
    sport: options.sportOverride || payload.sport,
    season: options.seasonOverride || payload.season,
  };
}

function buildDefaultOutPath(payload: ScrapedRosterPayload): string {
  const teamSlug = slugify(payload.teamName || "team");
  const sportSlug = slugify(payload.sport || "roster");
  const seasonSlug = slugify(payload.season || "latest");
  return path.resolve(process.cwd(), "data", "rosters", `${teamSlug}-${sportSlug}-${seasonSlug}.json`);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

function parseArgs(argv: string[]): CliOptions {
  let url = "https://southernmiss.com/sports/baseball/roster";
  let outPath: string | null = null;
  let timeoutMs = 25_000;
  let teamNameOverride: string | null = null;
  let sportOverride: string | null = null;
  let seasonOverride: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--url") {
      if (!next) {
        throw new Error("Missing value for --url");
      }
      url = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--out") {
      if (!next) {
        throw new Error("Missing value for --out");
      }
      outPath = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms") {
      if (!next) {
        throw new Error("Missing value for --timeout-ms");
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1_000) {
        throw new Error("--timeout-ms must be an integer >= 1000");
      }
      timeoutMs = parsed;
      index += 1;
      continue;
    }

    if (arg === "--team") {
      if (!next) {
        throw new Error("Missing value for --team");
      }
      teamNameOverride = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--sport") {
      if (!next) {
        throw new Error("Missing value for --sport");
      }
      sportOverride = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--season") {
      if (!next) {
        throw new Error("Missing value for --season");
      }
      seasonOverride = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    url,
    outPath,
    timeoutMs,
    teamNameOverride,
    sportOverride,
    seasonOverride,
  };
}

function printHelpAndExit(): never {
  // eslint-disable-next-line no-console
  console.log(
    "Usage: npx tsx src/tools/scrape-roster.ts [--url https://southernmiss.com/sports/baseball/roster] [--out data/rosters/southern-miss-baseball-2026.json] [--team 'Southern Miss'] [--sport Baseball] [--season 2026] [--timeout-ms 25000]"
  );
  process.exit(0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`roster:scrape failed: ${message}`);
  process.exit(1);
});
