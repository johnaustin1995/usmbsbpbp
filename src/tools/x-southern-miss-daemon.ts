import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import type { D1Game } from "../types";
import { getD1Scores } from "../scrapers/d1";
import { normalizeScoreDate } from "../utils/date";
import { loadDotEnv } from "../utils/env";
import { isSouthernMissGame } from "../utils/team-filter";

interface CliOptions {
  discoveryIntervalMs: number;
  startLeadSeconds: number;
  once: boolean;
  feedDryRun: boolean;
  feedIntervalSeconds: number | null;
  manualGameIds: number[];
  schedulePath: string | null;
}

const DEFAULT_DISCOVERY_INTERVAL_SECONDS = 60;
const DEFAULT_START_LEAD_SECONDS = 30 * 60;
const SCHEDULE_LOOKBACK_SECONDS = 12 * 60 * 60;

async function main(): Promise<void> {
  loadDotEnv();
  const options = parseArgs(process.argv.slice(2), process.env);

  const activeFeeds = new Map<number, ChildProcess>();
  let stopping = false;

  const shutdown = (): void => {
    if (stopping) {
      return;
    }

    stopping = true;
    // eslint-disable-next-line no-console
    console.log("# Shutting down daemon and child feed processes...");

    for (const [id, child] of activeFeeds.entries()) {
      // eslint-disable-next-line no-console
      console.log(`# Stopping feed process for game ${id} (pid ${child.pid ?? "n/a"})`);
      child.kill("SIGTERM");
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // eslint-disable-next-line no-console
  console.log("# Southern Miss X daemon started");
  // eslint-disable-next-line no-console
  console.log(
    `# Discovery interval: ${Math.floor(options.discoveryIntervalMs / 1000)}s | Start lead: ${options.startLeadSeconds}s`
  );
  if (options.manualGameIds.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`# Manual game IDs enabled: ${options.manualGameIds.join(", ")} (D1 discovery bypassed)`);
  }
  if (options.schedulePath) {
    // eslint-disable-next-line no-console
    console.log(`# Schedule mode enabled: ${options.schedulePath} (D1 discovery bypassed)`);
  }

  do {
    if (stopping) {
      break;
    }

    try {
      if (options.schedulePath) {
        const scheduledGames = await loadScheduledGameIds(options.schedulePath);
        const dueGames = scheduledGames.filter((game) =>
          shouldStartScheduledGame(game.startTimeEpoch, options.startLeadSeconds)
        );

        // eslint-disable-next-line no-console
        console.log(
          `# ${new Date().toISOString()} | Scheduled games loaded: ${scheduledGames.length} | Due now: ${dueGames.length}`
        );

        for (const game of dueGames) {
          if (activeFeeds.has(game.gameId)) {
            continue;
          }

          startFeedForGame(game.gameId, options, activeFeeds);
        }

        if (options.once) {
          break;
        }

        await sleep(options.discoveryIntervalMs);
        continue;
      }

      if (options.manualGameIds.length > 0) {
        for (const gameId of options.manualGameIds) {
          if (activeFeeds.has(gameId)) {
            continue;
          }

          startFeedForGame(gameId, options, activeFeeds);
        }

        if (options.once) {
          break;
        }

        await sleep(options.discoveryIntervalMs);
        continue;
      }

      const date = normalizeScoreDate();
      const payload = await getD1Scores(date);
      const southernMissGames = payload.games.filter((game) =>
        isSouthernMissGame(game.roadTeam.name, game.homeTeam.name)
      );

      // eslint-disable-next-line no-console
      console.log(
        `# ${new Date().toISOString()} | Date ${date} | Southern Miss games found: ${southernMissGames.length}`
      );

      for (const game of southernMissGames) {
        const gameId = game.statbroadcastId;
        if (!gameId) {
          // eslint-disable-next-line no-console
          console.log(`# Skipping ${describeGame(game)} (no StatBroadcast id yet)`);
          continue;
        }

        if (activeFeeds.has(gameId)) {
          continue;
        }

        if (!shouldStartFeed(game, options.startLeadSeconds)) {
          // eslint-disable-next-line no-console
          console.log(`# Waiting for start window: ${describeGame(game)}`);
          continue;
        }

        startFeedForGame(gameId, options, activeFeeds);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`# Discovery cycle failed: ${message}`);
    }

    if (options.once) {
      break;
    }

    await sleep(options.discoveryIntervalMs);
  } while (!stopping);

  shutdown();
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const intervalRaw = firstNonEmpty(env.X_DAEMON_INTERVAL_SECONDS);
  const leadRaw = firstNonEmpty(env.X_DAEMON_START_LEAD_SECONDS);
  const feedDryRunRaw = firstNonEmpty(env.X_DAEMON_FEED_DRY_RUN);
  const feedIntervalRaw = firstNonEmpty(env.X_DAEMON_FEED_INTERVAL_SECONDS);
  const manualGameIdsRaw = firstNonEmpty(env.X_DAEMON_MANUAL_GAME_IDS);
  const schedulePathRaw = firstNonEmpty(env.X_DAEMON_SCHEDULE_FILE);

  let discoveryIntervalMs =
    Math.max(5_000, (parsePositiveInteger(intervalRaw) ?? DEFAULT_DISCOVERY_INTERVAL_SECONDS) * 1000);
  let startLeadSeconds = parsePositiveInteger(leadRaw) ?? DEFAULT_START_LEAD_SECONDS;
  let once = false;
  let feedDryRun = feedDryRunRaw ? isTruthy(feedDryRunRaw) : false;
  let feedIntervalSeconds = parsePositiveInteger(feedIntervalRaw);
  let manualGameIds = parsePositiveIntegerList(manualGameIdsRaw);
  let schedulePath = schedulePathRaw ? path.resolve(schedulePathRaw) : null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--interval") {
      if (!next) {
        throw new Error("Missing value for --interval");
      }
      const seconds = parsePositiveInteger(next);
      if (!seconds) {
        throw new Error("Expected a positive integer for --interval");
      }
      discoveryIntervalMs = Math.max(5_000, seconds * 1000);
      index += 1;
      continue;
    }

    if (arg === "--start-lead") {
      if (!next) {
        throw new Error("Missing value for --start-lead");
      }
      const seconds = parsePositiveInteger(next);
      if (seconds === null) {
        throw new Error("Expected a positive integer for --start-lead");
      }
      startLeadSeconds = seconds;
      index += 1;
      continue;
    }

    if (arg === "--once") {
      once = true;
      continue;
    }

    if (arg === "--feed-dry-run") {
      feedDryRun = true;
      continue;
    }

    if (arg === "--feed-live") {
      feedDryRun = false;
      continue;
    }

    if (arg === "--feed-interval") {
      if (!next) {
        throw new Error("Missing value for --feed-interval");
      }
      const seconds = parsePositiveInteger(next);
      if (!seconds) {
        throw new Error("Expected a positive integer for --feed-interval");
      }
      feedIntervalSeconds = seconds;
      index += 1;
      continue;
    }

    if (arg === "--game-id") {
      if (!next) {
        throw new Error("Missing value for --game-id");
      }
      const id = parsePositiveInteger(next);
      if (!id) {
        throw new Error("Expected a positive integer for --game-id");
      }
      if (!manualGameIds.includes(id)) {
        manualGameIds = [...manualGameIds, id];
      }
      index += 1;
      continue;
    }

    if (arg === "--schedule") {
      if (!next) {
        throw new Error("Missing value for --schedule");
      }
      schedulePath = path.resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--game-ids") {
      if (!next) {
        throw new Error("Missing value for --game-ids");
      }
      const ids = parsePositiveIntegerList(next);
      if (ids.length === 0) {
        throw new Error("Expected comma-separated positive integers for --game-ids");
      }
      for (const id of ids) {
        if (!manualGameIds.includes(id)) {
          manualGameIds = [...manualGameIds, id];
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    discoveryIntervalMs,
    startLeadSeconds,
    once,
    feedDryRun,
    feedIntervalSeconds,
    manualGameIds,
    schedulePath,
  };
}

function shouldStartFeed(game: D1Game, startLeadSeconds: number): boolean {
  if (game.isOver) {
    return false;
  }

  if (game.inProgress) {
    return true;
  }

  const statusText = String(game.statusText ?? "").toLowerCase();
  if (statusText.includes("postponed") || statusText.includes("canceled") || statusText.includes("cancelled")) {
    return false;
  }

  if (!Number.isFinite(game.matchupTimeEpoch ?? null)) {
    return false;
  }

  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  return (game.matchupTimeEpoch as number) <= nowEpochSeconds + startLeadSeconds;
}

function startFeedProcess(gameId: number, options: CliOptions): ChildProcess {
  const nodeBinary = process.execPath || "node";
  const args = ["dist/tools/x-play-by-play-feed.js", "--id", String(gameId), "--bootstrap", "latest"];

  if (options.feedDryRun) {
    args.push("--dry-run");
  }

  if (options.feedIntervalSeconds) {
    args.push("--interval", String(options.feedIntervalSeconds));
  }

  // eslint-disable-next-line no-console
  console.log(`# Starting feed process for game ${gameId}: ${nodeBinary} ${args.join(" ")}`);

  return spawn(nodeBinary, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
}

function startFeedForGame(gameId: number, options: CliOptions, activeFeeds: Map<number, ChildProcess>): void {
  const child = startFeedProcess(gameId, options);
  activeFeeds.set(gameId, child);

  child.on("exit", (code, signal) => {
    activeFeeds.delete(gameId);
    // eslint-disable-next-line no-console
    console.log(`# Feed process for game ${gameId} exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  });
}

interface ScheduledGameEntry {
  gameId: number;
  startTimeEpoch: number | null;
}

async function loadScheduledGameIds(schedulePath: string): Promise<ScheduledGameEntry[]> {
  const raw = await fs.readFile(schedulePath, "utf8");
  const parsed = JSON.parse(raw) as {
    games?: Array<Record<string, unknown>>;
  };

  const games = Array.isArray(parsed.games) ? parsed.games : [];
  const deduped = new Map<number, ScheduledGameEntry>();

  for (const game of games) {
    const gameId = toPositiveInt(game.gameId ?? game.statbroadcastId ?? game.id);
    if (!gameId) {
      continue;
    }

    const startTimeEpoch = toNullableInt(
      game.startTimeEpochEt ?? game.startTimeEpoch ?? game.matchupTimeEpoch ?? game.epoch
    );
    if (!deduped.has(gameId)) {
      deduped.set(gameId, { gameId, startTimeEpoch });
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const aEpoch = a.startTimeEpoch ?? Number.MAX_SAFE_INTEGER;
    const bEpoch = b.startTimeEpoch ?? Number.MAX_SAFE_INTEGER;
    if (aEpoch !== bEpoch) {
      return aEpoch - bEpoch;
    }
    return a.gameId - b.gameId;
  });
}

function shouldStartScheduledGame(startTimeEpoch: number | null, startLeadSeconds: number): boolean {
  if (startTimeEpoch === null) {
    return true;
  }

  const now = Math.floor(Date.now() / 1000);
  if (startTimeEpoch < now - SCHEDULE_LOOKBACK_SECONDS) {
    return false;
  }

  return startTimeEpoch <= now + startLeadSeconds;
}

function toPositiveInt(value: unknown): number | null {
  const parsed = toNullableInt(value);
  if (parsed === null || parsed < 1) {
    return null;
  }
  return parsed;
}

function toNullableInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  if (!text) {
    return null;
  }

  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function describeGame(game: D1Game): string {
  return `${game.roadTeam.name} at ${game.homeTeam.name} | status=${game.statusText} | start=${
    game.matchupTimeIso ?? "unknown"
  }`;
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

function isTruthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveIntegerList(value: string | null): number[] {
  if (!value) {
    return [];
  }

  const tokens = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const ids: number[] = [];
  for (const token of tokens) {
    const parsed = parsePositiveInteger(token);
    if (!parsed) {
      continue;
    }
    if (!ids.includes(parsed)) {
      ids.push(parsed);
    }
  }

  return ids;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    "Usage: npm run x:daemon -- [--interval 60] [--start-lead 1800] [--feed-interval 20] [--feed-dry-run|--feed-live] [--schedule data/schedules/southern-miss-2026.json] [--game-id 651247] [--game-ids 651247,651255] [--once]"
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`x:daemon failed: ${message}`);
  process.exit(1);
});
