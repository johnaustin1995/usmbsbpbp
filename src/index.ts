import express from "express";
import fs from "fs/promises";
import path from "path";
import { getD1Scores } from "./scrapers/d1";
import {
  getAvailableViewsForSport,
  getFinalGame,
  getLiveStats,
  getLiveSummary,
} from "./scrapers/statbroadcast";
import {
  DEFAULT_BASEBALL_PRINT_XSL,
  getStatBroadcastPdfJson,
} from "./scrapers/statbroadcast-pdf";
import { normalizeScoreDate } from "./utils/date";
import { runWithConcurrency } from "./utils/async";
import { buildFrontendScoresFeed, normalizeLiveSummary } from "./normalize";
import type { D1GameWithLive, D1TeamSeasonData, D1TeamsDatabasePayload } from "./types";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const publicDir = path.resolve(__dirname, "../public");
const teamsDataDir = path.resolve(__dirname, "../data/tmp/teams");
const teamsFileCache = new Map<string, { mtimeMs: number; payload: D1TeamsDatabasePayload; loadedAt: string }>();

app.use(express.json());
app.use(express.static(publicDir));
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.get("/api/teams", async (req, res, next) => {
  try {
    const season = normalizeSeason(req.query.season);
    const file = safeFileName(req.query.file);
    const slim = toBoolean(req.query.slim);
    const teamKey = cleanQueryString(req.query.team);

    const loaded = await loadTeamsPayload({ season, file });
    if (teamKey) {
      const team = findTeamByKey(loaded.payload.teams, teamKey);
      if (!team) {
        res.status(404).json({ error: `No team matched "${teamKey}".` });
        return;
      }

      res.json({
        fetchedAt: loaded.payload.fetchedAt,
        sourceUrl: loaded.payload.sourceUrl,
        season: loaded.payload.season,
        file: loaded.filename,
        loadedAt: loaded.loadedAt,
        team: slim ? toTeamSlim(team) : team,
      });
      return;
    }

    if (slim) {
      res.json({
        fetchedAt: loaded.payload.fetchedAt,
        sourceUrl: loaded.payload.sourceUrl,
        season: loaded.payload.season,
        file: loaded.filename,
        loadedAt: loaded.loadedAt,
        errors: loaded.payload.errors,
        conferences: loaded.payload.conferences,
        totalTeams: loaded.payload.teams.length,
        teams: loaded.payload.teams.map(toTeamSlim),
      });
      return;
    }

    res.json({
      ...loaded.payload,
      file: loaded.filename,
      loadedAt: loaded.loadedAt,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scores", async (req, res, next) => {
  try {
    const date = normalizeScoreDate(String(req.query.date ?? ""));
    const includeLiveMode = parseIncludeLiveMode(req.query.includeLive);
    const statbroadcastOnly = toBoolean(req.query.statbroadcastOnly);
    const view = parseView(req.query.view, "both");

    const payload = await getD1Scores(date);
    const games = statbroadcastOnly
      ? payload.games.filter((game) => game.statbroadcastId !== null)
      : payload.games;

    let gamesWithLive: D1GameWithLive[] = games.map((game) => ({
      ...game,
      live: null,
      liveError: null,
    }));

    if (includeLiveMode === "none") {
      const rawPayload = {
        ...payload,
        totalGames: games.length,
        games,
      };
      const frontend = buildFrontendScoresFeed(date, payload.sourceUpdatedAt, gamesWithLive);
      respondByView(res, view, rawPayload, frontend);
      return;
    }

    const liveCandidates = includeLiveMode === "active" ? games.filter(isLikelyActiveGame) : games;
    const ids = Array.from(new Set(liveCandidates.map((game) => game.statbroadcastId).filter(isNumber)));

    const liveResponses = await runWithConcurrency(ids, 4, async (id) => {
      try {
        return { id, live: await getLiveSummary(id), error: null as string | null };
      } catch (error) {
        return {
          id,
          live: null,
          error: error instanceof Error ? error.message : "Unknown live fetch error",
        };
      }
    });

    const liveById = new Map(
      liveResponses.map((entry) => [entry.id, { live: entry.live, error: entry.error }])
    );

    const enriched = games.map((game) => {
      const liveEntry = game.statbroadcastId ? liveById.get(game.statbroadcastId) : undefined;
      return {
        ...game,
        live: liveEntry?.live ?? null,
        liveError: liveEntry?.error ?? null,
      };
    });
    gamesWithLive = enriched;

    const rawPayload = {
      ...payload,
      totalGames: enriched.length,
      games: enriched,
    };
    const frontend = buildFrontendScoresFeed(date, payload.sourceUpdatedAt, gamesWithLive);
    respondByView(res, view, rawPayload, frontend);
  } catch (error) {
    next(error);
  }
});

app.get("/api/live/:id", async (req, res, next) => {
  try {
    const view = parseView(req.query.view, "raw");
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid statbroadcast id." });
      return;
    }

    const live = await getLiveSummary(id);
    const frontend = normalizeLiveSummary(live);
    respondByView(res, view, live, frontend);
  } catch (error) {
    next(error);
  }
});

app.get("/api/live/:id/stats", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid statbroadcast id." });
      return;
    }

    const view = String(req.query.view ?? "game");
    const payload = await getLiveStats(id, view);

    res.json({
      ...payload,
      availableViews: getAvailableViewsForSport(payload.event.sport),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/live/:id/final", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid statbroadcast id." });
      return;
    }

    const payload = await getFinalGame(id);
    const requireFinal = toBoolean(req.query.requireFinal);
    if (requireFinal && payload.status !== "final") {
      res.status(409).json({
        error: "Game is not marked final yet.",
        status: payload.status,
        summaryStatus: payload.summary.statusText,
      });
      return;
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/live/:id/pdf-json", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid statbroadcast id." });
      return;
    }

    const xsl = String(req.query.xsl ?? DEFAULT_BASEBALL_PRINT_XSL);
    const includeFinalGame =
      req.query.includeFinalGame === undefined ? true : toBoolean(req.query.includeFinalGame);
    const includeRawPdfText =
      req.query.includeRawPdf === undefined ? false : toBoolean(req.query.includeRawPdf);

    const payload = await getStatBroadcastPdfJson(id, { xsl, includeFinalGame, includeRawPdfText });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/live", async (req, res, next) => {
  try {
    const view = parseView(req.query.view, "raw");
    const idsRaw = String(req.query.ids ?? "");
    if (!idsRaw) {
      res.status(400).json({ error: "Pass ids as a comma-separated query value." });
      return;
    }

    const ids = Array.from(
      new Set(
        idsRaw
          .split(",")
          .map((part) => Number.parseInt(part.trim(), 10))
          .filter((id) => Number.isFinite(id))
      )
    );

    if (ids.length === 0) {
      res.status(400).json({ error: "No valid ids were provided." });
      return;
    }

    const results = await runWithConcurrency(ids, 4, async (id) => {
      try {
        const live = await getLiveSummary(id);
        const frontend = normalizeLiveSummary(live);
        return { id, live, frontend, error: null as string | null };
      } catch (error) {
        return {
          id,
          live: null,
          frontend: null,
          error: error instanceof Error ? error.message : "Unknown live fetch error",
        };
      }
    });

    if (view === "frontend") {
      res.json({
        total: results.length,
        results: results.map((entry) => ({
          id: entry.id,
          frontend: entry.frontend,
          error: entry.error,
        })),
      });
      return;
    }

    if (view === "raw") {
      res.json({
        total: results.length,
        results: results.map((entry) => ({
          id: entry.id,
          live: entry.live,
          error: entry.error,
        })),
      });
      return;
    }

    res.json({
      total: results.length,
      results,
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`NCAA baseball API listening on http://localhost:${port}`);
});

interface LoadTeamsPayloadOptions {
  season: string | null;
  file: string | null;
}

interface LoadedTeamsPayload {
  filename: string;
  loadedAt: string;
  payload: D1TeamsDatabasePayload;
}

interface TeamSlim {
  id: number | null;
  name: string;
  slug: string | null;
  season: string | null;
  conference: {
    id: number | null;
    name: string;
    slug: string | null;
  } | null;
  logoUrl: string | null;
  teamUrl: string;
  scheduleUrl: string;
  statsUrl: string;
  scheduleCount: number;
  statsTableCount: number;
  errorCount: number;
}

async function loadTeamsPayload(options: LoadTeamsPayloadOptions): Promise<LoadedTeamsPayload> {
  const filePath = await resolveTeamsPayloadFile(options);
  const filename = path.basename(filePath);
  const stats = await fs.stat(filePath);
  const cached = teamsFileCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs) {
    return {
      filename,
      loadedAt: cached.loadedAt,
      payload: cached.payload,
    };
  }

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as D1TeamsDatabasePayload;
  if (!Array.isArray(parsed?.teams)) {
    throw new Error(`Invalid teams payload in ${filename}`);
  }

  const loadedAt = new Date().toISOString();
  teamsFileCache.set(filePath, {
    mtimeMs: stats.mtimeMs,
    payload: parsed,
    loadedAt,
  });

  return {
    filename,
    loadedAt,
    payload: parsed,
  };
}

async function resolveTeamsPayloadFile(options: LoadTeamsPayloadOptions): Promise<string> {
  const entries = await listTeamsDataEntries();
  if (entries.length === 0) {
    throw new Error(`No teams data files were found in ${teamsDataDir}. Run npm run teams:json first.`);
  }

  if (options.file) {
    const explicit = entries.find((entry) => entry.name === options.file);
    if (!explicit) {
      throw new Error(`Requested teams file "${options.file}" does not exist in ${teamsDataDir}.`);
    }
    return explicit.path;
  }

  const preferredEntries = entries.filter((entry) => isPrimaryTeamsExport(entry.name));
  const candidates = preferredEntries.length > 0 ? preferredEntries : entries;
  const seasonEntries = options.season
    ? candidates.filter((entry) => entry.name.includes(`d1-teams-${options.season}-`))
    : candidates;

  if (seasonEntries.length === 0) {
    throw new Error(`No teams data files found for season ${options.season}.`);
  }

  seasonEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return seasonEntries[0].path;
}

function isPrimaryTeamsExport(fileName: string): boolean {
  return /^d1-teams-(\d{4}|current)-\d{4}-\d{2}-\d{2}\.json$/u.test(fileName);
}

async function listTeamsDataEntries(): Promise<Array<{ name: string; path: string; mtimeMs: number }>> {
  try {
    const entries = await fs.readdir(teamsDataDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);

    const withStats = await Promise.all(
      files.map(async (name) => {
        const filePath = path.join(teamsDataDir, name);
        const stats = await fs.stat(filePath);
        return {
          name,
          path: filePath,
          mtimeMs: stats.mtimeMs,
        };
      })
    );

    return withStats;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function toTeamSlim(team: D1TeamSeasonData): TeamSlim {
  return {
    id: team.id,
    name: team.name,
    slug: team.slug,
    season: team.season,
    conference: team.conference
      ? {
          id: team.conference.id,
          name: team.conference.name,
          slug: team.conference.slug,
        }
      : null,
    logoUrl: team.logoUrl,
    teamUrl: team.teamUrl,
    scheduleUrl: team.scheduleUrl,
    statsUrl: team.statsUrl,
    scheduleCount: Array.isArray(team.schedule) ? team.schedule.length : 0,
    statsTableCount: Array.isArray(team.statsTables) ? team.statsTables.length : 0,
    errorCount: Array.isArray(team.errors) ? team.errors.length : 0,
  };
}

function findTeamByKey(teams: D1TeamSeasonData[], key: string): D1TeamSeasonData | null {
  const normalizedKey = key.trim().toLowerCase();
  if (!normalizedKey) {
    return null;
  }

  const asId = Number.parseInt(normalizedKey, 10);
  if (Number.isFinite(asId)) {
    const byId = teams.find((team) => team.id === asId);
    if (byId) {
      return byId;
    }
  }

  const bySlug = teams.find((team) => String(team.slug ?? "").toLowerCase() === normalizedKey);
  if (bySlug) {
    return bySlug;
  }

  const keyName = normalizeLookupName(normalizedKey);
  return teams.find((team) => normalizeLookupName(team.name) === keyName) ?? null;
}

function normalizeLookupName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQueryString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function safeFileName(value: unknown): string | null {
  const raw = cleanQueryString(value);
  if (!raw) {
    return null;
  }

  const basename = path.basename(raw);
  if (basename !== raw || basename.includes("..")) {
    return null;
  }

  return basename;
}

function normalizeSeason(value: unknown): string | null {
  const raw = cleanQueryString(value);
  if (!raw) {
    return null;
  }

  return /^\d{4}$/.test(raw) ? raw : null;
}

function toBoolean(value: unknown): boolean {
  const normalized = String(value ?? "").toLowerCase().trim();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

type IncludeLiveMode = "none" | "active" | "all";

function parseIncludeLiveMode(value: unknown): IncludeLiveMode {
  const normalized = String(value ?? "").toLowerCase().trim();
  if (normalized === "all" || normalized === "1" || normalized === "true" || normalized === "yes") {
    return "all";
  }

  if (normalized === "active" || normalized === "live") {
    return "active";
  }

  return "none";
}

function isLikelyActiveGame(game: { inProgress: boolean; isOver: boolean; statusText: string }): boolean {
  if (game.isOver) {
    return false;
  }

  if (game.inProgress) {
    return true;
  }

  return /(top|bot|middle|end)\s+\d|live/i.test(game.statusText);
}

function isNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type ApiView = "raw" | "frontend" | "both";

function parseView(value: unknown, defaultView: ApiView): ApiView {
  const normalized = String(value ?? "").toLowerCase().trim();
  if (normalized === "raw" || normalized === "frontend" || normalized === "both") {
    return normalized;
  }

  return defaultView;
}

function respondByView(
  res: express.Response,
  view: ApiView,
  rawPayload: unknown,
  frontendPayload: unknown
): void {
  if (view === "frontend") {
    res.json(frontendPayload);
    return;
  }

  if (view === "raw") {
    res.json(rawPayload);
    return;
  }

  if (
    rawPayload !== null &&
    typeof rawPayload === "object" &&
    !Array.isArray(rawPayload)
  ) {
    res.json({
      ...(rawPayload as Record<string, unknown>),
      frontend: frontendPayload,
    });
    return;
  }

  res.json({ raw: rawPayload, frontend: frontendPayload });
}
