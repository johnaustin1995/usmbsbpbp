import fs from "fs/promises";
import path from "path";
import { getSouthernMissStats } from "../scrapers/southern-miss-stats";

interface CliOptions {
  season: string;
  url: string | null;
  outFile: string | null;
  refresh: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const payload = await getSouthernMissStats({
    season: options.season,
    url: options.url,
    bypassCache: options.refresh,
  });

  const outFile =
    options.outFile ??
    path.resolve(process.cwd(), "data", "stats", `southern-miss-${options.season}.json`);

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(payload, null, 2), "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `# Southern Miss stats updated | Season: ${options.season} | Team: ${payload.teamName ?? "Unknown"} | Record: ${
      payload.record ?? "--"
    } | File: ${outFile}`
  );
}

function parseArgs(argv: string[]): CliOptions {
  const defaultSeason = String(new Date().getUTCFullYear());
  const options: CliOptions = {
    season: defaultSeason,
    url: null,
    outFile: null,
    refresh: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--season") {
      if (!next) {
        throw new Error("Missing value for --season");
      }
      if (!/^\d{4}$/.test(next.trim())) {
        throw new Error(`Invalid season "${next}". Expected 4 digits, e.g. 2026.`);
      }
      options.season = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--url") {
      if (!next) {
        throw new Error("Missing value for --url");
      }
      options.url = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--out") {
      if (!next) {
        throw new Error("Missing value for --out");
      }
      options.outFile = path.resolve(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--refresh") {
      options.refresh = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelpAndExit(): never {
  // eslint-disable-next-line no-console
  console.log(
    "Usage: npm run stats:usm -- [--season 2026] [--url https://southernmiss.com/sports/baseball/stats/2026] [--out data/stats/southern-miss-2026.json] [--refresh]"
  );
  process.exit(0);
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`stats:usm failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
