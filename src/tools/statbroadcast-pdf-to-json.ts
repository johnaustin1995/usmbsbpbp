import fs from "fs/promises";
import path from "path";
import {
  DEFAULT_BASEBALL_PRINT_XSL,
  extractStatBroadcastId,
  getStatBroadcastPdfJson,
} from "../scrapers/statbroadcast-pdf";

interface CliOptions {
  input: string | null;
  xsl: string;
  outPath: string | null;
  includeFinalGame: boolean;
  includeRawPdfText: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.input) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const id = extractStatBroadcastId(options.input);
  if (!id) {
    throw new Error(
      `Could not parse a StatBroadcast game id from "${options.input}". Pass --id 635076 or --url https://stats.statbroadcast.com/broadcast/?id=635076`
    );
  }

  const payload = await getStatBroadcastPdfJson(id, {
    xsl: options.xsl,
    includeFinalGame: options.includeFinalGame,
    includeRawPdfText: options.includeRawPdfText,
  });

  const outPath =
    options.outPath ??
    path.resolve(process.cwd(), "data", "tmp", "pdf-json", `statbroadcast-${id}-${slugifyXsl(options.xsl)}.json`);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");

  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(`Pages: ${payload.pdf.pageCount} | Bytes: ${payload.pdf.bytes} | SHA256: ${payload.pdf.sha256}`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    input: null,
    xsl: DEFAULT_BASEBALL_PRINT_XSL,
    outPath: null,
    includeFinalGame: true,
    includeRawPdfText: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--id" || arg === "--url" || arg === "--input") {
      if (!next) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.input = next;
      index += 1;
      continue;
    }

    if (arg === "--xsl") {
      if (!next) {
        throw new Error("Missing value for --xsl");
      }
      options.xsl = next;
      index += 1;
      continue;
    }

    if (arg === "--out") {
      if (!next) {
        throw new Error("Missing value for --out");
      }
      options.outPath = path.resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--no-final") {
      options.includeFinalGame = false;
      continue;
    }

    if (arg === "--include-raw-pdf") {
      options.includeRawPdfText = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return options;
}

function slugifyXsl(xsl: string): string {
  return xsl
    .toLowerCase()
    .replace(/\.xsl$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    "Usage: npm run pdf:json -- --url https://stats.statbroadcast.com/broadcast/?id=635076 [--xsl baseball/sb.bsgame.print.book.xsl] [--out data/tmp/pdf-json/game.json] [--no-final] [--include-raw-pdf]"
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`pdf:json failed: ${message}`);
  process.exit(1);
});
