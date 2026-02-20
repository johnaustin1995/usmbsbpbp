import {
  buildFinalTweetText,
  buildPlayTweetText,
  deriveLivePlayStates,
  extractLivePlayEvents,
  isFinalStatus,
} from "../pipelines/live-play-feed";
import { getLiveStats, getLiveSummary } from "../scrapers/statbroadcast";
import { isSouthernMissGame } from "../utils/team-filter";
import { loadDotEnv } from "../utils/env";

interface CliOptions {
  gameId: number;
  appendTag: string | null;
  includeFinal: boolean;
  limit: number | null;
  intervalMs: number;
  once: boolean;
  bootstrapMode: "latest" | "all";
}

async function main(): Promise<void> {
  loadDotEnv();
  const options = parseArgs(process.argv.slice(2), process.env);
  const seenPlayKeys = new Set<string>();
  let bootstrapped = false;
  let finalPosted = false;
  let postCounter = 0;
  let fatalError: Error | null = null;

  // eslint-disable-next-line no-console
  console.log(`# Preview watcher started for game ${options.gameId}`);
  // eslint-disable-next-line no-console
  console.log(
    `# Mode: ${options.once ? "once" : "follow"} | Interval: ${Math.floor(options.intervalMs / 1000)}s | Bootstrap: ${options.bootstrapMode}`
  );

  do {
    try {
      const summary = await getLiveSummary(options.gameId);
      if (!isSouthernMissGame(summary.visitorTeam, summary.homeTeam)) {
        throw new Error(
          `Game ${options.gameId} is ${summary.visitorTeam} at ${summary.homeTeam}. This script is restricted to Southern Miss games.`
        );
      }

      const liveStats = await getLiveStats(options.gameId, "plays");
      const plays = extractLivePlayEvents(liveStats);
      const playStates = deriveLivePlayStates(plays, summary);

      // eslint-disable-next-line no-console
      console.log(
        `# ${new Date().toISOString()} | ${summary.visitorTeam} at ${summary.homeTeam} | ${summary.statusText ?? "Unknown status"}`
      );

      if (!bootstrapped && options.bootstrapMode === "latest") {
        plays.forEach((play) => {
          seenPlayKeys.add(play.key);
        });
        bootstrapped = true;
        // eslint-disable-next-line no-console
        console.log(`# Bootstrapped ${plays.length} existing play(s); waiting for new plays.`);
      } else {
        const unseen = plays.filter((play) => !seenPlayKeys.has(play.key));
        const selectedPlays = options.limit ? unseen.slice(0, options.limit) : unseen;

        selectedPlays.forEach((play) => {
          postCounter += 1;
          const text = buildPlayTweetText({
            play,
            summary,
            stateAfterPlay: playStates.get(play.key) ?? null,
            appendTag: options.appendTag,
          });

          // eslint-disable-next-line no-console
          console.log(`\n--- POST ${postCounter} | key=${play.key} ---`);
          // eslint-disable-next-line no-console
          console.log(text);
          seenPlayKeys.add(play.key);
        });

        if (selectedPlays.length === 0) {
          // eslint-disable-next-line no-console
          console.log("# No new plays.");
        }
      }

      bootstrapped = true;

      if (options.includeFinal && isFinalStatus(summary) && !finalPosted) {
        const finalText = buildFinalTweetText({
          summary,
          appendTag: options.appendTag,
        });

        // eslint-disable-next-line no-console
        console.log(`\n--- FINAL POST ---`);
        // eslint-disable-next-line no-console
        console.log(finalText);
        finalPosted = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`# Poll failed: ${message}`);

      if (error instanceof Error && /restricted to Southern Miss games/i.test(error.message)) {
        fatalError = error;
        break;
      }
    }

    if (options.once) {
      break;
    }

    await sleep(options.intervalMs);
  } while (true);

  if (fatalError) {
    throw fatalError;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const idRaw = firstNonEmpty(env.X_PREVIEW_GAME_ID);
  const appendTagRaw = firstNonEmpty(env.X_FEED_APPEND_TAG);
  const intervalRaw = firstNonEmpty(env.X_PREVIEW_INTERVAL_SECONDS);
  const bootstrapRaw = firstNonEmpty(env.X_PREVIEW_BOOTSTRAP);

  let gameId = parsePositiveInteger(idRaw);
  let appendTag = appendTagRaw;
  let includeFinal = true;
  let limit: number | null = null;
  let intervalMs = Math.max(5_000, (parsePositiveInteger(intervalRaw) ?? 20) * 1000);
  let once = false;
  let bootstrapMode: "latest" | "all" = bootstrapRaw === "all" ? "all" : "latest";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--id") {
      if (!next) {
        throw new Error("Missing value for --id");
      }
      gameId = parsePositiveInteger(next);
      index += 1;
      continue;
    }

    if (arg === "--tag") {
      if (!next) {
        throw new Error("Missing value for --tag");
      }
      appendTag = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      if (!next) {
        throw new Error("Missing value for --limit");
      }
      limit = parsePositiveInteger(next);
      if (!limit) {
        throw new Error("Expected a positive integer for --limit");
      }
      index += 1;
      continue;
    }

    if (arg === "--interval") {
      if (!next) {
        throw new Error("Missing value for --interval");
      }
      const seconds = parsePositiveInteger(next);
      if (!seconds) {
        throw new Error("Expected a positive integer for --interval");
      }
      intervalMs = Math.max(5_000, seconds * 1000);
      index += 1;
      continue;
    }

    if (arg === "--bootstrap") {
      if (!next) {
        throw new Error("Missing value for --bootstrap");
      }
      if (next !== "latest" && next !== "all") {
        throw new Error("Expected --bootstrap latest|all");
      }
      bootstrapMode = next;
      index += 1;
      continue;
    }

    if (arg === "--once") {
      once = true;
      continue;
    }

    if (arg === "--follow") {
      once = false;
      continue;
    }

    if (arg === "--include-final") {
      includeFinal = true;
      continue;
    }

    if (arg === "--no-final") {
      includeFinal = false;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!gameId) {
    throw new Error("Missing required --id <statbroadcast game id> (or X_PREVIEW_GAME_ID env var).");
  }

  return {
    gameId,
    appendTag: appendTag && appendTag.length > 0 ? appendTag : null,
    includeFinal,
    limit,
    intervalMs,
    once,
    bootstrapMode,
  };
}

function firstNonEmpty(value: string | undefined): string | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  return value.trim();
}

function parsePositiveInteger(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    "Usage: npm run x:preview -- --id 636528 [--interval 20] [--bootstrap latest|all] [--once] [--tag '#NCAABaseball'] [--limit 25] [--include-final|--no-final]"
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`x:preview failed: ${message}`);
  process.exit(1);
});
