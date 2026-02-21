import fs from "fs/promises";
import path from "path";
import { XClient } from "../integrations/x";
import {
  buildFinalTweetText,
  buildPlayTweetText,
  deriveLivePlayStates,
  extractLivePlayEvents,
  isFinalStatus,
} from "../pipelines/live-play-feed";
import { getFinalGame, getLiveStats, getLiveSummary } from "../scrapers/statbroadcast";
import { isSouthernMissGame } from "../utils/team-filter";
import { loadDotEnv } from "../utils/env";

interface CliOptions {
  gameId: number;
  intervalMs: number;
  finalGraceMs: number;
  statePath: string;
  once: boolean;
  dryRun: boolean;
  bootstrapMode: "latest" | "all";
  threadMode: "reply" | "none";
  maxPostsPerCycle: number;
  postFinal: boolean;
  appendTag: string | null;
}

interface FeedState {
  version: 1;
  gameId: number;
  createdAt: string;
  updatedAt: string;
  bootstrapped: boolean;
  postedPlayKeys: string[];
  lastTweetId: string | null;
  rootTweetId: string | null;
  finalPosted: boolean;
  finalCandidateAt: string | null;
}

const MAX_STORED_KEYS = 20_000;

async function main(): Promise<void> {
  loadDotEnv();
  const options = parseArgs(process.argv.slice(2), process.env);
  const state = await loadOrCreateState(options.statePath, options.gameId);
  const xClient = options.dryRun ? null : XClient.fromEnv(process.env);

  let shouldExit = false;

  do {
    shouldExit = await runCycle(options, state, xClient);
    await saveState(options.statePath, state);

    if (options.once || shouldExit) {
      break;
    }

    await sleep(options.intervalMs);
  } while (true);
}

async function runCycle(options: CliOptions, state: FeedState, xClient: XClient | null): Promise<boolean> {
  const summary = await getLiveSummary(options.gameId);
  if (!isSouthernMissGame(summary.visitorTeam, summary.homeTeam)) {
    throw new Error(
      `Game ${options.gameId} is ${summary.visitorTeam} at ${summary.homeTeam}. This script is restricted to Southern Miss games.`
    );
  }

  const liveStats = await getLiveStats(options.gameId, "plays");
  const plays = extractLivePlayEvents(liveStats);
  const playStates = deriveLivePlayStates(plays, summary);

  const postedSet = new Set(state.postedPlayKeys);

  if (!state.bootstrapped) {
    state.bootstrapped = true;

    if (options.bootstrapMode === "latest" && plays.length > 0) {
      for (const play of plays) {
        postedSet.add(play.key);
      }

      state.postedPlayKeys = compactPostedKeys(Array.from(postedSet));
      state.updatedAt = new Date().toISOString();

      // eslint-disable-next-line no-console
      console.log(`[bootstrap] Seeded ${plays.length} existing plays for game ${options.gameId}.`);
      return false;
    }
  }

  const unposted = plays.filter((play) => !postedSet.has(play.key));
  const toPost = unposted.slice(0, options.maxPostsPerCycle);

  for (const play of toPost) {
    const text = buildPlayTweetText({
      play,
      summary,
      stateAfterPlay: playStates.get(play.key) ?? null,
      appendTag: options.appendTag,
    });

    const replyToTweetId = options.threadMode === "reply" ? state.lastTweetId : null;
    const tweetId = await sendTweet(xClient, {
      text,
      replyToTweetId,
      dryRun: options.dryRun,
      syntheticIndex: state.postedPlayKeys.length + 1,
    });

    if (!state.rootTweetId) {
      state.rootTweetId = tweetId;
    }

    state.lastTweetId = tweetId;
    postedSet.add(play.key);
    state.postedPlayKeys = compactPostedKeys(Array.from(postedSet));

    // eslint-disable-next-line no-console
    console.log(`[play] ${play.key} | ${text.replace(/\s+/g, " ").slice(0, 140)}`);
  }

  const pendingPlays = plays.some((play) => !postedSet.has(play.key));
  const isOfficialFinal = isFinalStatus(summary);
  const isLikelyFinalFromPlays = detectLikelyFinalFromPlays(plays, playStates);

  if (isOfficialFinal) {
    state.finalCandidateAt = null;
  } else if (isLikelyFinalFromPlays) {
    if (!state.finalCandidateAt) {
      state.finalCandidateAt = new Date().toISOString();
      // eslint-disable-next-line no-console
      console.log(
        `[final-candidate] Likely final play detected for game ${options.gameId}; waiting ${Math.floor(
          options.finalGraceMs / 1000
        )}s confirmation window.`
      );
    }
  } else {
    state.finalCandidateAt = null;
  }

  const graceSatisfied =
    state.finalCandidateAt !== null &&
    Date.now() - new Date(state.finalCandidateAt).getTime() >= options.finalGraceMs;

  const shouldPostFinalNow =
    options.postFinal &&
    !state.finalPosted &&
    !pendingPlays &&
    (isOfficialFinal || (isLikelyFinalFromPlays && graceSatisfied));

  if (shouldPostFinalNow) {
    const pitcherDecisions = await resolveFinalPitcherDecisions(options.gameId);
    const text = buildFinalTweetText({
      summary,
      pitcherDecisions,
      appendTag: options.appendTag,
    });

    const replyToTweetId = options.threadMode === "reply" ? state.lastTweetId : null;
    const tweetId = await sendTweet(xClient, {
      text,
      replyToTweetId,
      dryRun: options.dryRun,
      syntheticIndex: state.postedPlayKeys.length + 1,
    });

    if (!state.rootTweetId) {
      state.rootTweetId = tweetId;
    }

    state.lastTweetId = tweetId;
    state.finalPosted = true;
    state.finalCandidateAt = null;

    // eslint-disable-next-line no-console
    console.log(`[final] ${text.replace(/\s+/g, " ").slice(0, 140)}`);
  }

  state.updatedAt = new Date().toISOString();
  const shouldExitForFinal = isOfficialFinal || (isLikelyFinalFromPlays && graceSatisfied);
  return shouldExitForFinal && (!options.postFinal || state.finalPosted) && !pendingPlays;
}

async function sendTweet(
  client: XClient | null,
  input: {
    text: string;
    replyToTweetId: string | null;
    dryRun: boolean;
    syntheticIndex: number;
  }
): Promise<string> {
  if (input.dryRun || !client) {
    const dryId = `dry-run-${Date.now()}-${input.syntheticIndex}`;
    // eslint-disable-next-line no-console
    console.log(`[dry-run] ${dryId} ${input.replyToTweetId ? `(reply ${input.replyToTweetId})` : ""}`.trim());
    return dryId;
  }

  const posted = await client.postTweet({
    text: input.text,
    replyToTweetId: input.replyToTweetId,
  });

  return posted.id;
}

async function loadOrCreateState(statePath: string, gameId: number): Promise<FeedState> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as FeedState;

    if (parsed.gameId !== gameId) {
      throw new Error(
        `State file ${statePath} is for game ${parsed.gameId}, but --id ${gameId} was requested.`
      );
    }

    return {
      version: 1,
      gameId,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      bootstrapped: Boolean(parsed.bootstrapped),
      postedPlayKeys: compactPostedKeys(Array.isArray(parsed.postedPlayKeys) ? parsed.postedPlayKeys : []),
      lastTweetId: typeof parsed.lastTweetId === "string" ? parsed.lastTweetId : null,
      rootTweetId: typeof parsed.rootTweetId === "string" ? parsed.rootTweetId : null,
      finalPosted: Boolean(parsed.finalPosted),
      finalCandidateAt: typeof parsed.finalCandidateAt === "string" ? parsed.finalCandidateAt : null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const now = new Date().toISOString();
  return {
    version: 1,
    gameId,
    createdAt: now,
    updatedAt: now,
    bootstrapped: false,
    postedPlayKeys: [],
    lastTweetId: null,
    rootTweetId: null,
    finalPosted: false,
    finalCandidateAt: null,
  };
}

async function saveState(statePath: string, state: FeedState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function compactPostedKeys(keys: string[]): string[] {
  const unique = Array.from(new Set(keys));
  if (unique.length <= MAX_STORED_KEYS) {
    return unique;
  }

  return unique.slice(unique.length - MAX_STORED_KEYS);
}

function detectLikelyFinalFromPlays(
  plays: ReturnType<typeof extractLivePlayEvents>,
  playStates: ReturnType<typeof deriveLivePlayStates>
): boolean {
  const lastMeaningfulPlay = [...plays].reverse().find((play) => !play.isSubstitution) ?? plays[plays.length - 1];
  if (!lastMeaningfulPlay) {
    return false;
  }

  const state = playStates.get(lastMeaningfulPlay.key);
  if (!state) {
    return false;
  }

  const inning = lastMeaningfulPlay.inning;
  const half = lastMeaningfulPlay.half;
  const outs = state.outsAfterPlay;
  const awayScore = state.awayScore;
  const homeScore = state.homeScore;

  if (
    inning === null ||
    half === null ||
    outs === null ||
    awayScore === null ||
    homeScore === null ||
    inning < 9 ||
    awayScore === homeScore
  ) {
    return false;
  }

  if (half === "top" && outs === 3 && homeScore > awayScore) {
    return true;
  }

  if (half === "bottom" && outs === 3) {
    return true;
  }

  if (half === "bottom" && homeScore > awayScore) {
    return true;
  }

  return false;
}

async function resolveFinalPitcherDecisions(gameId: number): Promise<{
  winning: string | null;
  save: string | null;
  losing: string | null;
}> {
  try {
    const finalGame = await getFinalGame(gameId);
    return {
      winning: toOptionalDecisionName(finalGame.pitcherDecisions.winning?.player),
      save: toOptionalDecisionName(finalGame.pitcherDecisions.save?.player),
      losing: toOptionalDecisionName(finalGame.pitcherDecisions.losing?.player),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn(`[final] Could not load pitcher decisions for game ${gameId}: ${message}`);
    return {
      winning: null,
      save: null,
      losing: null,
    };
  }
}

function toOptionalDecisionName(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const idRaw = firstNonEmpty(env.X_FEED_GAME_ID);
  const intervalRaw = firstNonEmpty(env.X_FEED_INTERVAL_SECONDS);
  const finalGraceRaw = firstNonEmpty(env.X_FEED_FINAL_GRACE_SECONDS);
  const bootstrapRaw = firstNonEmpty(env.X_FEED_BOOTSTRAP);
  const threadModeRaw = firstNonEmpty(env.X_FEED_THREAD_MODE);
  const maxPostsRaw = firstNonEmpty(env.X_FEED_MAX_POSTS_PER_CYCLE);
  const postFinalRaw = firstNonEmpty(env.X_FEED_POST_FINAL);
  const appendTagRaw = firstNonEmpty(env.X_FEED_APPEND_TAG);

  const options: Omit<CliOptions, "gameId" | "statePath"> & { gameId: number | null; statePath: string | null } = {
    gameId: parsePositiveInteger(idRaw),
    intervalMs: Math.max(5_000, (parsePositiveInteger(intervalRaw) ?? 20) * 1000),
    finalGraceMs: Math.max(30_000, (parsePositiveInteger(finalGraceRaw) ?? 120) * 1000),
    statePath: null,
    once: false,
    dryRun: false,
    bootstrapMode: bootstrapRaw === "all" ? "all" : "latest",
    threadMode: threadModeRaw === "none" ? "none" : "reply",
    maxPostsPerCycle: parsePositiveInteger(maxPostsRaw) ?? 6,
    postFinal: postFinalRaw ? isTruthy(postFinalRaw) : true,
    appendTag: appendTagRaw ?? null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--id") {
      if (!next) {
        throw new Error("Missing value for --id");
      }
      options.gameId = parsePositiveInteger(next);
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
      options.intervalMs = Math.max(5_000, seconds * 1000);
      index += 1;
      continue;
    }

    if (arg === "--final-grace") {
      if (!next) {
        throw new Error("Missing value for --final-grace");
      }
      const seconds = parsePositiveInteger(next);
      if (!seconds) {
        throw new Error("Expected a positive integer for --final-grace");
      }
      options.finalGraceMs = Math.max(30_000, seconds * 1000);
      index += 1;
      continue;
    }

    if (arg === "--state") {
      if (!next) {
        throw new Error("Missing value for --state");
      }
      options.statePath = path.resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--once") {
      options.once = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--bootstrap") {
      if (!next) {
        throw new Error("Missing value for --bootstrap");
      }
      if (next !== "latest" && next !== "all") {
        throw new Error("Expected --bootstrap latest|all");
      }
      options.bootstrapMode = next;
      index += 1;
      continue;
    }

    if (arg === "--thread-mode") {
      if (!next) {
        throw new Error("Missing value for --thread-mode");
      }
      if (next !== "reply" && next !== "none") {
        throw new Error("Expected --thread-mode reply|none");
      }
      options.threadMode = next;
      index += 1;
      continue;
    }

    if (arg === "--max-posts") {
      if (!next) {
        throw new Error("Missing value for --max-posts");
      }
      const maxPosts = parsePositiveInteger(next);
      if (!maxPosts) {
        throw new Error("Expected a positive integer for --max-posts");
      }
      options.maxPostsPerCycle = maxPosts;
      index += 1;
      continue;
    }

    if (arg === "--post-final") {
      options.postFinal = true;
      continue;
    }

    if (arg === "--no-post-final") {
      options.postFinal = false;
      continue;
    }

    if (arg === "--tag") {
      if (!next) {
        throw new Error("Missing value for --tag");
      }
      options.appendTag = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.gameId) {
    throw new Error("Missing required --id <statbroadcast game id> (or X_FEED_GAME_ID env var).");
  }

  const statePath =
    options.statePath ??
    path.resolve(process.cwd(), "data", "tmp", "x-feed", `statbroadcast-${options.gameId}.json`);

  return {
    gameId: options.gameId,
    intervalMs: options.intervalMs,
    finalGraceMs: options.finalGraceMs,
    statePath,
    once: options.once,
    dryRun: options.dryRun,
    bootstrapMode: options.bootstrapMode,
    threadMode: options.threadMode,
    maxPostsPerCycle: options.maxPostsPerCycle,
    postFinal: options.postFinal,
    appendTag: options.appendTag && options.appendTag.length > 0 ? options.appendTag : null,
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

function isTruthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    "Usage: npm run x:feed -- --id 636528 [--interval 20] [--final-grace 120] [--state data/tmp/x-feed/game.json] [--once] [--dry-run] [--bootstrap latest|all] [--thread-mode reply|none] [--max-posts 6] [--post-final|--no-post-final] [--tag '#NCAABaseball']"
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`x:feed failed: ${message}`);
  process.exit(1);
});
