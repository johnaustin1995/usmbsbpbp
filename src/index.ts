import express from "express";
import fs from "fs/promises";
import path from "path";
import { deriveLivePlayStates, extractLivePlayEvents } from "./pipelines/live-play-feed";
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
import { getSouthernMissScheduleText, type SouthernMissScheduleTextGame } from "./scrapers/southern-miss-schedule-text";
import { getSouthernMissNews } from "./scrapers/southern-miss-news";
import { getSouthernMissStats, type SouthernMissStatsPayload } from "./scrapers/southern-miss-stats";
import { normalizeScoreDate } from "./utils/date";
import { runWithConcurrency } from "./utils/async";
import { buildFrontendScoresFeed, normalizeLiveSummary } from "./normalize";
import type { D1GameWithLive, D1TeamScheduleGame, D1TeamSeasonData, D1TeamsDatabasePayload } from "./types";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const publicDir = path.resolve(__dirname, "../public");
const teamsDataDir = path.resolve(__dirname, "../data/tmp/teams");
const teamsFileCache = new Map<string, { mtimeMs: number; payload: D1TeamsDatabasePayload; loadedAt: string }>();
const usmSchedulePath = resolveUsmSchedulePath(process.env);
const rosterDataDir = path.resolve(process.cwd(), "data/rosters");
const usmScheduleCache = new Map<
  string,
  {
    mtimeMs: number;
    loadedAt: string;
    payload: UsmSchedulePayload;
  }
>();
const rosterFileCache = new Map<string, { mtimeMs: number; loadedAt: string; payload: RosterPayload }>();

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

app.get("/api/usm/schedule", async (req, res, next) => {
  try {
    const requestedId = parsePositiveInteger(cleanQueryString(req.query.id));
    const schedule = await loadUsmSchedulePayload();
    const nowEpoch = Math.floor(Date.now() / 1000);
    const normalizedGames = normalizeUsmScheduleGames(schedule.payload.games);
    let textScheduleError: string | null = null;
    let textScheduleFetchedAt: string | null = null;
    let textScheduleRows: SouthernMissScheduleTextGame[] = [];
    let gamesWithResults = normalizedGames;

    try {
      const textSchedule = await getSouthernMissScheduleText();
      textScheduleFetchedAt = textSchedule.fetchedAt;
      textScheduleRows = textSchedule.games;
      gamesWithResults = mergeUsmScheduleResults(gamesWithResults, textScheduleRows);
    } catch (error) {
      textScheduleError = error instanceof Error ? error.message : String(error);
    }

    const selectedGameId = pickUsmGameId(gamesWithResults, requestedId, nowEpoch);
    const selectedGame = selectedGameId
      ? gamesWithResults.find((game) => game.gameId === selectedGameId) ?? null
      : null;
    const games = buildUsmScheduleApiGames(gamesWithResults, textScheduleRows);

    res.json({
      file: path.basename(schedule.path),
      loadedAt: schedule.loadedAt,
      generatedAt: schedule.payload.generatedAt ?? null,
      totalGames: games.length,
      selectedGameId,
      selectedGame,
      nowEpoch,
      textSchedule: {
        fetchedAt: textScheduleFetchedAt,
        error: textScheduleError,
        totalGames: textScheduleRows.length,
      },
      games,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/usm/live", async (req, res, next) => {
  try {
    const requestedId = parsePositiveInteger(cleanQueryString(req.query.id));
    const schedule = await loadUsmSchedulePayload();
    const scheduleGames = normalizeUsmScheduleGames(schedule.payload.games);
    const nowEpoch = Math.floor(Date.now() / 1000);

    const selectedGameId = pickUsmGameId(scheduleGames, requestedId, nowEpoch, true);
    if (!selectedGameId) {
      res.status(404).json({
        error: "No Southern Miss game is available in schedule file.",
        file: path.basename(schedule.path),
        totalGames: scheduleGames.length,
      });
      return;
    }

    const selectedGame = scheduleGames.find((game) => game.gameId === selectedGameId) ?? null;

    let summaryError: string | null = null;
    let summary = null as Awaited<ReturnType<typeof getLiveSummary>> | null;
    try {
      summary = await getLiveSummary(selectedGameId);
    } catch (error) {
      summaryError = error instanceof Error ? error.message : String(error);
    }

    let plays = [] as Array<{
      key: string;
      order: number;
      inning: number | null;
      half: "top" | "bottom" | null;
      text: string;
      batter: string | null;
      pitcher: string | null;
      scoringDecision: string | null;
      isSubstitution: boolean;
      outsAfterPlay: number | null;
      awayScore: number | null;
      homeScore: number | null;
    }>;

    let playsSections: Awaited<ReturnType<typeof getLiveStats>>["sections"] = [];
    let gameSections: Awaited<ReturnType<typeof getLiveStats>>["sections"] = [];
    let lineupsSections: Awaited<ReturnType<typeof getLiveStats>>["sections"] = [];
    let awayBoxSections: Awaited<ReturnType<typeof getLiveStats>>["sections"] = [];
    let homeBoxSections: Awaited<ReturnType<typeof getLiveStats>>["sections"] = [];
    let awaySeasonSections: Awaited<ReturnType<typeof getLiveStats>>["sections"] = [];
    let homeSeasonSections: Awaited<ReturnType<typeof getLiveStats>>["sections"] = [];
    let playsError: string | null = null;
    let gameError: string | null = null;
    let lineupsError: string | null = null;
    let awayBoxError: string | null = null;
    let homeBoxError: string | null = null;
    let awaySeasonError: string | null = null;
    let homeSeasonError: string | null = null;

    if (summary) {
      const [
        playsResult,
        gameResult,
        lineupsResult,
        awayBoxResult,
        homeBoxResult,
        awaySeasonResult,
        homeSeasonResult,
      ] = await Promise.allSettled([
        getLiveStats(selectedGameId, "plays"),
        getLiveStats(selectedGameId, "game"),
        getLiveStats(selectedGameId, "lineups"),
        getLiveStats(selectedGameId, "away_box"),
        getLiveStats(selectedGameId, "home_box"),
        getLiveStats(selectedGameId, "away_season"),
        getLiveStats(selectedGameId, "home_season"),
      ]);

      if (playsResult.status === "fulfilled") {
        playsSections = playsResult.value.sections;
        const events = extractLivePlayEvents(playsResult.value);
        const states = deriveLivePlayStates(events, summary);
        plays = events.map((play) => {
          const state = states.get(play.key);
          return {
            key: play.key,
            order: play.order,
            inning: play.inning,
            half: play.half,
            text: play.text,
            batter: play.batter,
            pitcher: play.pitcher,
            scoringDecision: play.scoringDecision,
            isSubstitution: play.isSubstitution,
            outsAfterPlay: state?.outsAfterPlay ?? play.outs ?? null,
            awayScore: state?.awayScore ?? summary.visitorScore,
            homeScore: state?.homeScore ?? summary.homeScore,
          };
        });
      } else {
        playsError = playsResult.reason instanceof Error ? playsResult.reason.message : String(playsResult.reason);
      }

      if (gameResult.status === "fulfilled") {
        gameSections = gameResult.value.sections;
      } else {
        gameError = gameResult.reason instanceof Error ? gameResult.reason.message : String(gameResult.reason);
      }

      if (lineupsResult.status === "fulfilled") {
        lineupsSections = lineupsResult.value.sections;
      } else {
        lineupsError = lineupsResult.reason instanceof Error ? lineupsResult.reason.message : String(lineupsResult.reason);
      }

      if (awayBoxResult.status === "fulfilled") {
        awayBoxSections = awayBoxResult.value.sections;
      } else {
        awayBoxError = awayBoxResult.reason instanceof Error ? awayBoxResult.reason.message : String(awayBoxResult.reason);
      }

      if (homeBoxResult.status === "fulfilled") {
        homeBoxSections = homeBoxResult.value.sections;
      } else {
        homeBoxError = homeBoxResult.reason instanceof Error ? homeBoxResult.reason.message : String(homeBoxResult.reason);
      }

      if (awaySeasonResult.status === "fulfilled") {
        awaySeasonSections = awaySeasonResult.value.sections;
      } else {
        awaySeasonError =
          awaySeasonResult.reason instanceof Error ? awaySeasonResult.reason.message : String(awaySeasonResult.reason);
      }

      if (homeSeasonResult.status === "fulfilled") {
        homeSeasonSections = homeSeasonResult.value.sections;
      } else {
        homeSeasonError =
          homeSeasonResult.reason instanceof Error ? homeSeasonResult.reason.message : String(homeSeasonResult.reason);
      }
    }

    const upcomingGames = scheduleGames
      .filter((game) => game.startEpochResolved === null || game.startEpochResolved >= nowEpoch - 8 * 60 * 60)
      .slice(0, 14);
    const selectedGameForUi: UsmScheduleGameNormalized | null =
      selectedGame ??
      (requestedId && selectedGameId === requestedId
        ? {
            date: null,
            gameId: selectedGameId,
            awayTeam: summary?.visitorTeam ?? "Away",
            homeTeam: summary?.homeTeam ?? "Home",
            statusText: summary?.statusText ?? "External game",
            resultText: normalizeResultStatusText(summary?.statusText ?? null),
            startTimeEpochEt: null,
            startTimeIsoEt: null,
            startTimeEpoch: null,
            startTimeIso: null,
            startEpochResolved: null,
          }
        : null);

    const scheduleForUi = [...upcomingGames];
    if (selectedGameForUi && !scheduleForUi.some((game) => game.gameId === selectedGameForUi.gameId)) {
      scheduleForUi.unshift(selectedGameForUi);
    }

    res.json({
      file: path.basename(schedule.path),
      loadedAt: schedule.loadedAt,
      generatedAt: schedule.payload.generatedAt ?? null,
      nowEpoch,
      selectedGameId,
      selectedGame,
      schedule: scheduleForUi,
      live: {
        summary,
        summaryFrontend: summary ? normalizeLiveSummary(summary) : null,
        summaryError,
        plays,
        playsSections,
        playsError,
        gameSections,
        gameError,
        lineupsSections,
        lineupsError,
        awayBoxSections,
        awayBoxError,
        homeBoxSections,
        homeBoxError,
        awaySeasonSections,
        awaySeasonError,
        homeSeasonSections,
        homeSeasonError,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/usm/stats", async (req, res, next) => {
  try {
    const seasonQuery = normalizeSeason(req.query.season) ?? "2026";
    const refresh = toBoolean(req.query.refresh);
    const payload = await getSouthernMissStats({
      season: seasonQuery,
      bypassCache: refresh,
    });

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/usm/news", async (req, res, next) => {
  try {
    const limitRaw = parsePositiveInteger(cleanQueryString(req.query.limit));
    const refresh = toBoolean(req.query.refresh);
    const payload = await getSouthernMissNews({
      limit: limitRaw ? Math.min(limitRaw, 20) : 10,
      bypassCache: refresh,
    });

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/usm/site", async (req, res, next) => {
  try {
    const seasonQuery = normalizeSeason(req.query.season);
    const requestedId = parsePositiveInteger(cleanQueryString(req.query.id));
    const nowEpoch = Math.floor(Date.now() / 1000);

    const [scheduleLoaded, rosterCandidates] = await Promise.all([
      loadUsmSchedulePayload(),
      loadRosterCandidates(),
    ]);

    let teamsLoaded: LoadedTeamsPayload | null = null;
    let teamsLoadError: string | null = null;
    let usmTeam: D1TeamSeasonData | null = null;
    try {
      teamsLoaded = await loadTeamsPayload({ season: seasonQuery, file: null });
      usmTeam = findSouthernMissTeam(teamsLoaded.payload.teams);
      if (!usmTeam) {
        teamsLoadError = `Southern Miss team data was not found in teams payload (${teamsLoaded.filename}).`;
      }
    } catch (error) {
      teamsLoadError = error instanceof Error ? error.message : String(error);
    }

    const normalizedUsmSchedule = normalizeUsmScheduleGames(scheduleLoaded.payload.games);
    const selectedGameId = pickUsmGameId(normalizedUsmSchedule, requestedId, nowEpoch, true);
    const selectedGame = selectedGameId
      ? normalizedUsmSchedule.find((game) => game.gameId === selectedGameId) ?? null
      : null;

    const d1ScheduleRows = usmTeam
      ? buildUsmSiteScheduleRows(usmTeam.schedule, normalizedUsmSchedule, seasonQuery ?? usmTeam.season ?? null)
      : buildUsmSiteScheduleRowsFromUsmSchedule(normalizedUsmSchedule);
    const seasonSummary = buildUsmSeasonSummary(d1ScheduleRows);
    const statsSeason = seasonQuery ?? usmTeam?.season ?? null;

    let officialStats: SouthernMissStatsPayload | null = null;
    let officialStatsError: string | null = null;
    try {
      officialStats = await getSouthernMissStats({ season: statsSeason ?? "2026" });
    } catch (error) {
      officialStatsError = error instanceof Error ? error.message : String(error);
    }

    let liveSummary = null as Awaited<ReturnType<typeof getLiveSummary>> | null;
    let liveSummaryError: string | null = null;
    if (selectedGameId) {
      try {
        liveSummary = await getLiveSummary(selectedGameId);
      } catch (error) {
        liveSummaryError = error instanceof Error ? error.message : String(error);
      }
    }

    const rosterMatch = findBestRosterMatch(rosterCandidates, {
      team: "Southern Miss",
      sport: "baseball",
      season: seasonQuery ?? usmTeam?.season ?? null,
    });

    res.json({
      generatedAt: new Date().toISOString(),
      nowEpoch,
      season: seasonQuery ?? usmTeam?.season ?? teamsLoaded?.payload.season ?? null,
      team: {
        id: usmTeam?.id ?? null,
        name: usmTeam?.name ?? "Southern Miss",
        slug: usmTeam?.slug ?? "smiss",
        logoUrl: usmTeam?.logoUrl ?? null,
        conference: usmTeam?.conference ?? null,
        teamUrl: usmTeam?.teamUrl ?? null,
        scheduleUrl: usmTeam?.scheduleUrl ?? null,
        statsUrl: usmTeam?.statsUrl ?? null,
      },
      summary: seasonSummary,
      schedule: {
        sourceFile: path.basename(scheduleLoaded.path),
        sourceLoadedAt: scheduleLoaded.loadedAt,
        sourceGeneratedAt: scheduleLoaded.payload.generatedAt ?? null,
        sourceKind: usmTeam ? "d1-team-schedule" : "usm-schedule-file",
        total: d1ScheduleRows.length,
        games: d1ScheduleRows,
      },
      sources: {
        teamsFile: teamsLoaded?.filename ?? null,
        teamsLoadedAt: teamsLoaded?.loadedAt ?? null,
        teamsError: teamsLoadError,
      },
      stats: {
        season: statsSeason,
        payload: officialStats,
        error: officialStatsError,
      },
      live: {
        selectedGameId,
        selectedGame,
        summary: liveSummary,
        summaryFrontend: liveSummary ? normalizeLiveSummary(liveSummary) : null,
        summaryError: liveSummaryError,
        viewerUrl: selectedGameId ? `/usm-live-169.html?id=${selectedGameId}` : "/usm-live-169.html",
      },
      roster: rosterMatch
        ? {
            file: path.basename(rosterMatch.path),
            loadedAt: rosterMatch.loadedAt,
            score: rosterMatch.score,
            teamName: rosterMatch.payload.teamName ?? usmTeam?.name ?? "Southern Miss",
            season: rosterMatch.payload.season ?? null,
            playerCount: Array.isArray(rosterMatch.payload.players)
              ? rosterMatch.payload.players.length
              : 0,
            players: Array.isArray(rosterMatch.payload.players) ? rosterMatch.payload.players : [],
          }
        : null,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/roster", async (req, res, next) => {
  try {
    const teamQuery = cleanQueryString(req.query.team);
    const sportQuery = cleanQueryString(req.query.sport) ?? "baseball";
    const seasonQuery = cleanQueryString(req.query.season);
    const requestedFile = safeFileName(req.query.file);

    if (requestedFile) {
      const fullPath = path.resolve(rosterDataDir, requestedFile);
      if (!fullPath.startsWith(rosterDataDir)) {
        res.status(400).json({ error: "Invalid roster file path." });
        return;
      }

      const loaded = await loadRosterPayload(fullPath);
      res.json({
        file: path.basename(fullPath),
        loadedAt: loaded.loadedAt,
        roster: loaded.payload,
      });
      return;
    }

    if (!teamQuery) {
      res.status(400).json({
        error: "Missing required query parameter: team",
      });
      return;
    }

    const candidates = await loadRosterCandidates();
    const best = findBestRosterMatch(candidates, {
      team: teamQuery,
      sport: sportQuery,
      season: seasonQuery,
    });

    if (!best) {
      res.status(404).json({
        error: `No roster file matched team "${teamQuery}".`,
        search: {
          team: teamQuery,
          sport: sportQuery,
          season: seasonQuery,
        },
      });
      return;
    }

    res.json({
      file: path.basename(best.path),
      loadedAt: best.loadedAt,
      score: best.score,
      roster: best.payload,
    });
  } catch (error) {
    next(error);
  }
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

function toSlug(value: string): string {
  return normalizeLookupName(value).replace(/\s+/g, "-");
}

interface UsmScheduleGameRaw {
  date?: string;
  gameId?: number | null;
  statbroadcastId?: number | null;
  id?: number | null;
  awayTeam?: string;
  homeTeam?: string;
  statusText?: string;
  startTimeEpochEt?: number | null;
  startTimeIsoEt?: string | null;
  startTimeEpoch?: number | null;
  startTimeIso?: string | null;
  resultText?: string | null;
}

interface UsmSchedulePayload {
  generatedAt?: string;
  games: UsmScheduleGameRaw[];
}

interface UsmScheduleGameNormalized {
  date: string | null;
  gameId: number;
  awayTeam: string;
  homeTeam: string;
  statusText: string | null;
  resultText: string | null;
  startTimeEpochEt: number | null;
  startTimeIsoEt: string | null;
  startTimeEpoch: number | null;
  startTimeIso: string | null;
  startEpochResolved: number | null;
}

interface UsmScheduleApiGame {
  date: string | null;
  gameId: number | null;
  awayTeam: string;
  homeTeam: string;
  statusText: string | null;
  resultText: string | null;
  startTimeEpochEt: number | null;
  startTimeIsoEt: string | null;
  startTimeEpoch: number | null;
  startTimeIso: string | null;
  startEpochResolved: number | null;
}

interface LoadedUsmSchedulePayload {
  path: string;
  loadedAt: string;
  payload: UsmSchedulePayload;
}

interface RosterPayload {
  sourceUrl?: string;
  fetchedAt?: string;
  pageTitle?: string | null;
  teamName?: string | null;
  sport?: string | null;
  season?: string | null;
  playerCount?: number;
  players?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface LoadedRosterPayload {
  path: string;
  loadedAt: string;
  payload: RosterPayload;
}

interface FindRosterMatchOptions {
  team: string;
  sport: string;
  season: string | null;
}

interface RankedRosterMatch extends LoadedRosterPayload {
  score: number;
}

interface UsmSiteScheduleRow {
  index: number;
  dateLabel: string | null;
  dateIso: string | null;
  locationType: string | null;
  opponentName: string | null;
  opponentSlug: string | null;
  resultText: string | null;
  outcome: "win" | "loss" | "unknown";
  runsFor: number | null;
  runsAgainst: number | null;
  resultUrl: string | null;
  statbroadcastId: number | null;
  isCompleted: boolean;
  isUpcoming: boolean;
}

interface UsmRecordSplit {
  wins: number;
  losses: number;
}

interface UsmSeasonSummary {
  gamesPlayed: number;
  wins: number;
  losses: number;
  winPct: string;
  runDifferential: number;
  runsFor: number;
  runsAgainst: number;
  averageRunsFor: string;
  averageRunsAgainst: string;
  home: UsmRecordSplit;
  away: UsmRecordSplit;
  neutral: UsmRecordSplit;
  streak: string;
  last10: string;
}

async function loadUsmSchedulePayload(): Promise<LoadedUsmSchedulePayload> {
  const stats = await fs.stat(usmSchedulePath);
  const cached = usmScheduleCache.get(usmSchedulePath);
  if (cached && cached.mtimeMs === stats.mtimeMs) {
    return {
      path: usmSchedulePath,
      loadedAt: cached.loadedAt,
      payload: cached.payload,
    };
  }

  const raw = await fs.readFile(usmSchedulePath, "utf8");
  const parsed = JSON.parse(raw) as UsmSchedulePayload;
  if (!Array.isArray(parsed?.games)) {
    throw new Error(`Invalid Southern Miss schedule payload in ${usmSchedulePath}`);
  }

  const loadedAt = new Date().toISOString();
  usmScheduleCache.set(usmSchedulePath, {
    mtimeMs: stats.mtimeMs,
    loadedAt,
    payload: parsed,
  });

  return {
    path: usmSchedulePath,
    loadedAt,
    payload: parsed,
  };
}

async function loadRosterCandidates(): Promise<LoadedRosterPayload[]> {
  let directoryEntries: string[];
  try {
    directoryEntries = await fs.readdir(rosterDataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const jsonFiles = directoryEntries
    .filter((entry) => entry.toLowerCase().endsWith(".json"))
    .map((entry) => path.resolve(rosterDataDir, entry));

  const loaded = await Promise.all(
    jsonFiles.map(async (filePath) => {
      try {
        return await loadRosterPayload(filePath);
      } catch {
        return null;
      }
    })
  );

  return loaded.filter((entry): entry is LoadedRosterPayload => entry !== null);
}

async function loadRosterPayload(filePath: string): Promise<LoadedRosterPayload> {
  const stats = await fs.stat(filePath);
  const cached = rosterFileCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs) {
    return {
      path: filePath,
      loadedAt: cached.loadedAt,
      payload: cached.payload,
    };
  }

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as RosterPayload;
  if (!Array.isArray(parsed?.players)) {
    throw new Error(`Invalid roster payload in ${filePath}`);
  }

  const loadedAt = new Date().toISOString();
  rosterFileCache.set(filePath, {
    mtimeMs: stats.mtimeMs,
    loadedAt,
    payload: parsed,
  });

  return {
    path: filePath,
    loadedAt,
    payload: parsed,
  };
}

function findBestRosterMatch(
  candidates: LoadedRosterPayload[],
  options: FindRosterMatchOptions
): RankedRosterMatch | null {
  const normalizedTeam = normalizeLookupName(options.team);
  const normalizedSport = normalizeLookupName(options.sport);
  const normalizedSeason = options.season ? options.season.trim() : null;
  const teamSlug = toSlug(options.team);

  let best: RankedRosterMatch | null = null;

  for (const candidate of candidates) {
    const fileName = path.basename(candidate.path).toLowerCase();
    const candidateTeamName = normalizeLookupName(String(candidate.payload.teamName ?? ""));
    const candidateSport = normalizeLookupName(String(candidate.payload.sport ?? ""));
    const candidateSeason = cleanQueryString(candidate.payload.season);

    let score = 0;

    if (candidateTeamName && normalizedTeam === candidateTeamName) {
      score += 120;
    } else if (candidateTeamName && (candidateTeamName.includes(normalizedTeam) || normalizedTeam.includes(candidateTeamName))) {
      score += 80;
    } else if (fileName.includes(teamSlug)) {
      score += 45;
    }

    if (candidateSport && normalizedSport === candidateSport) {
      score += 30;
    } else if (candidateSport && (candidateSport.includes(normalizedSport) || normalizedSport.includes(candidateSport))) {
      score += 18;
    } else if (fileName.includes(toSlug(options.sport))) {
      score += 8;
    }

    if (normalizedSeason && candidateSeason === normalizedSeason) {
      score += 20;
    } else if (normalizedSeason && fileName.includes(normalizedSeason)) {
      score += 10;
    }

    if (score <= 0) {
      continue;
    }

    if (!best || score > best.score) {
      best = { ...candidate, score };
    }
  }

  return best;
}

function normalizeUsmScheduleGames(games: UsmScheduleGameRaw[]): UsmScheduleGameNormalized[] {
  const deduped = new Map<number, UsmScheduleGameNormalized>();

  for (const game of games) {
    const gameId = parsePositiveInteger(String(game.gameId ?? game.statbroadcastId ?? game.id ?? ""));
    if (!gameId) {
      continue;
    }

    const startTimeEpochEt = parseNullableInteger(game.startTimeEpochEt);
    const startTimeEpoch = parseNullableInteger(game.startTimeEpoch);
    const startEpochResolved = startTimeEpochEt ?? startTimeEpoch;

    if (!deduped.has(gameId)) {
      const statusText = typeof game.statusText === "string" ? game.statusText : null;
      const explicitResultText = typeof game.resultText === "string" ? game.resultText : null;
      deduped.set(gameId, {
        date: typeof game.date === "string" ? game.date : null,
        gameId,
        awayTeam: typeof game.awayTeam === "string" ? game.awayTeam : "Away",
        homeTeam: typeof game.homeTeam === "string" ? game.homeTeam : "Home",
        statusText,
        resultText: normalizeResultStatusText(explicitResultText) ?? normalizeResultStatusText(statusText),
        startTimeEpochEt,
        startTimeIsoEt: typeof game.startTimeIsoEt === "string" ? game.startTimeIsoEt : null,
        startTimeEpoch,
        startTimeIso: typeof game.startTimeIso === "string" ? game.startTimeIso : null,
        startEpochResolved,
      });
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const aEpoch = a.startEpochResolved ?? Number.MAX_SAFE_INTEGER;
    const bEpoch = b.startEpochResolved ?? Number.MAX_SAFE_INTEGER;
    if (aEpoch !== bEpoch) {
      return aEpoch - bEpoch;
    }
    return a.gameId - b.gameId;
  });
}

function pickUsmGameId(
  games: UsmScheduleGameNormalized[],
  requestedId: number | null,
  nowEpoch: number,
  allowAnyRequestedId = false
): number | null {
  if (requestedId) {
    const explicit = games.find((game) => game.gameId === requestedId);
    if (explicit) {
      return explicit.gameId;
    }
    if (allowAnyRequestedId) {
      return requestedId;
    }
  }

  const activeWindow = games
    .filter((game) => game.startEpochResolved !== null)
    .filter((game) => {
      const start = game.startEpochResolved as number;
      return start >= nowEpoch - 8 * 60 * 60 && start <= nowEpoch + 8 * 60 * 60;
    })
    .sort((a, b) => {
      const aDistance = Math.abs((a.startEpochResolved as number) - nowEpoch);
      const bDistance = Math.abs((b.startEpochResolved as number) - nowEpoch);
      if (aDistance !== bDistance) {
        return aDistance - bDistance;
      }
      return (a.startEpochResolved as number) - (b.startEpochResolved as number);
    });

  if (activeWindow[0]) {
    return activeWindow[0].gameId;
  }

  const nextUpcoming = games
    .filter((game) => game.startEpochResolved !== null && (game.startEpochResolved as number) >= nowEpoch)
    .sort((a, b) => (a.startEpochResolved as number) - (b.startEpochResolved as number))[0];

  if (nextUpcoming) {
    return nextUpcoming.gameId;
  }

  const latestPast = games
    .filter((game) => game.startEpochResolved !== null && (game.startEpochResolved as number) < nowEpoch)
    .sort((a, b) => (b.startEpochResolved as number) - (a.startEpochResolved as number))[0];

  if (latestPast) {
    return latestPast.gameId;
  }

  return games[0]?.gameId ?? null;
}

function findSouthernMissTeam(teams: D1TeamSeasonData[]): D1TeamSeasonData | null {
  const bySlug = teams.find((team) => String(team.slug ?? "").toLowerCase() === "smiss");
  if (bySlug) {
    return bySlug;
  }

  const byName = teams.find((team) => normalizeLookupName(team.name) === normalizeLookupName("Southern Miss"));
  if (byName) {
    return byName;
  }

  return teams.find((team) => normalizeLookupName(team.name).includes("southern miss")) ?? null;
}

function buildUsmSiteScheduleRows(
  d1Schedule: D1TeamScheduleGame[],
  normalizedUsmSchedule: UsmScheduleGameNormalized[],
  seasonHint: string | null = null
): UsmSiteScheduleRow[] {
  const nowEpoch = Math.floor(Date.now() / 1000);

  return d1Schedule.map((game, index) => {
    const dateIso = parseDateIsoFromD1Schedule(game, seasonHint);
    const { runsFor, runsAgainst } = parseRunsFromResultText(game.resultText, game.outcome);
    const statbroadcastId = matchUsmStatbroadcastId(normalizedUsmSchedule, dateIso, game.opponentName);
    const dateEpoch = dateIso ? Math.floor(Date.parse(`${dateIso}T00:00:00Z`) / 1000) : null;
    const isCompleted = game.outcome === "win" || game.outcome === "loss";
    const isUpcoming = !isCompleted && (dateEpoch === null || dateEpoch >= nowEpoch - 36 * 60 * 60);

    return {
      index,
      dateLabel: game.dateLabel ?? null,
      dateIso,
      locationType: game.locationType ?? null,
      opponentName: game.opponentName ?? null,
      opponentSlug: game.opponentSlug ?? null,
      resultText: game.resultText ?? null,
      outcome: game.outcome,
      runsFor,
      runsAgainst,
      resultUrl: game.resultUrl ?? null,
      statbroadcastId,
      isCompleted,
      isUpcoming,
    };
  });
}

function buildUsmSiteScheduleRowsFromUsmSchedule(
  games: UsmScheduleGameNormalized[]
): UsmSiteScheduleRow[] {
  const nowEpoch = Math.floor(Date.now() / 1000);
  return games.map((game, index) => {
    const locationType = inferUsmLocationType(game);
    const opponentName = resolveUsmOpponentName(game);
    const resultText = game.resultText ?? game.statusText;
    const outcome = parseOutcomeFromStatusText(resultText);
    const { runsFor, runsAgainst } = parseRunsFromResultText(resultText, outcome);
    const isCompleted = outcome === "win" || outcome === "loss";
    const isUpcoming = !isCompleted && (game.startEpochResolved === null || game.startEpochResolved >= nowEpoch - 36 * 60 * 60);

    return {
      index,
      dateLabel: game.date,
      dateIso: game.date,
      locationType,
      opponentName,
      opponentSlug: toSlug(opponentName),
      resultText: resultText ?? null,
      outcome,
      runsFor,
      runsAgainst,
      resultUrl: null,
      statbroadcastId: game.gameId,
      isCompleted,
      isUpcoming,
    };
  });
}

function inferUsmLocationType(game: UsmScheduleGameNormalized): string | null {
  const home = normalizeLookupName(game.homeTeam);
  const away = normalizeLookupName(game.awayTeam);
  if (home.includes("southern miss")) {
    return null;
  }
  if (away.includes("southern miss")) {
    return "@";
  }
  return null;
}

function parseDateIsoFromD1Schedule(game: D1TeamScheduleGame, seasonHint: string | null): string | null {
  const dateUrl = cleanQueryString(game.dateUrl);
  if (dateUrl) {
    const compact = dateUrl.match(/date=(\d{8})/i)?.[1] ?? null;
    if (compact) {
      return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    }
  }

  const label = cleanQueryString(game.dateLabel);
  if (!label) {
    return null;
  }

  const seasonYear = Number.parseInt(seasonHint ?? "", 10);
  const fallbackYear = Number.isFinite(seasonYear) ? seasonYear : new Date().getUTCFullYear();
  const monthMatch = label.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
  const dayMatch = label.match(/\b(\d{1,2})\b(?!.*\b\d{1,2}\b)/);
  if (!monthMatch || !dayMatch) {
    return null;
  }

  const monthToken = monthMatch[1].slice(0, 3).toLowerCase();
  const monthMap: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const month = monthMap[monthToken];
  const day = Number.parseInt(dayMatch[1], 10);
  if (!month || !Number.isFinite(day)) {
    return null;
  }

  return `${String(fallbackYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseOutcomeFromStatusText(statusText: string | null): "win" | "loss" | "unknown" {
  const normalized = cleanQueryString(statusText)?.toUpperCase() ?? "";
  if (!normalized) {
    return "unknown";
  }
  if (/^W\b/u.test(normalized)) {
    return "win";
  }
  if (/^L\b/u.test(normalized)) {
    return "loss";
  }
  return "unknown";
}

function parseRunsFromResultText(
  resultText: string | null,
  outcome: "win" | "loss" | "unknown"
): { runsFor: number | null; runsAgainst: number | null } {
  const text = cleanQueryString(resultText);
  if (!text) {
    return { runsFor: null, runsAgainst: null };
  }

  const scoreMatch = text.match(/(\d+)\s*-\s*(\d+)/);
  if (!scoreMatch) {
    return { runsFor: null, runsAgainst: null };
  }

  const first = Number.parseInt(scoreMatch[1], 10);
  const second = Number.parseInt(scoreMatch[2], 10);
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    return { runsFor: null, runsAgainst: null };
  }

  if (outcome === "win") {
    return { runsFor: first, runsAgainst: second };
  }

  if (outcome === "loss") {
    return { runsFor: second, runsAgainst: first };
  }

  return { runsFor: first, runsAgainst: second };
}

function matchUsmStatbroadcastId(
  normalizedUsmSchedule: UsmScheduleGameNormalized[],
  dateIso: string | null,
  d1OpponentName: string | null
): number | null {
  if (!dateIso) {
    return null;
  }

  const sameDateGames = normalizedUsmSchedule.filter((game) => game.date === dateIso);
  if (sameDateGames.length === 0) {
    return null;
  }

  if (sameDateGames.length === 1) {
    return sameDateGames[0].gameId;
  }

  const normalizedOpponent = normalizeLookupName(d1OpponentName ?? "");
  if (!normalizedOpponent) {
    return sameDateGames[0].gameId;
  }

  const matched = sameDateGames.find((game) => {
    const scheduleOpponent = normalizeLookupName(resolveUsmOpponentName(game));
    return (
      scheduleOpponent === normalizedOpponent ||
      scheduleOpponent.includes(normalizedOpponent) ||
      normalizedOpponent.includes(scheduleOpponent)
    );
  });

  return matched?.gameId ?? sameDateGames[0].gameId;
}

function resolveUsmOpponentName(game: UsmScheduleGameNormalized): string {
  const home = normalizeLookupName(game.homeTeam);
  const away = normalizeLookupName(game.awayTeam);
  if (home.includes("southern miss")) {
    return game.awayTeam;
  }
  if (away.includes("southern miss")) {
    return game.homeTeam;
  }
  return game.awayTeam || game.homeTeam;
}

function mergeUsmScheduleResults(
  games: UsmScheduleGameNormalized[],
  scheduleTextRows: SouthernMissScheduleTextGame[]
): UsmScheduleGameNormalized[] {
  if (!Array.isArray(scheduleTextRows) || scheduleTextRows.length === 0) {
    return games;
  }

  const rowsByDate = new Map<string, Array<{ row: SouthernMissScheduleTextGame; used: boolean }>>();
  for (const row of scheduleTextRows) {
    const dateIso = cleanQueryString(row.dateIso);
    if (!dateIso) {
      continue;
    }
    const bucket = rowsByDate.get(dateIso) ?? [];
    bucket.push({ row, used: false });
    rowsByDate.set(dateIso, bucket);
  }

  return games.map((game) => {
    let mergedResult = normalizeResultStatusText(game.resultText) ?? normalizeResultStatusText(game.statusText);
    const dateIso = cleanQueryString(game.date);
    if (!dateIso) {
      return { ...game, resultText: mergedResult };
    }

    const candidates = rowsByDate.get(dateIso);
    if (!candidates || candidates.length === 0) {
      return { ...game, resultText: mergedResult };
    }

    const normalizedOpponent = normalizeUsmOpponentMatchName(resolveUsmOpponentName(game));
    const preferredIndex = findBestScheduleTextMatchIndex(candidates, normalizedOpponent, true);
    const fallbackIndex = preferredIndex >= 0 ? preferredIndex : findBestScheduleTextMatchIndex(candidates, normalizedOpponent, false);
    const matchIndex = fallbackIndex;
    if (matchIndex < 0) {
      return { ...game, resultText: mergedResult };
    }

    candidates[matchIndex].used = true;
    const rowResult = normalizeResultStatusText(candidates[matchIndex].row.resultText);
    if (rowResult) {
      mergedResult = rowResult;
    }

    return { ...game, resultText: mergedResult };
  });
}

function buildUsmScheduleApiGames(
  gamesWithResults: UsmScheduleGameNormalized[],
  scheduleTextRows: SouthernMissScheduleTextGame[]
): UsmScheduleApiGame[] {
  const combined: UsmScheduleApiGame[] = gamesWithResults.map((game) => ({
    date: game.date,
    gameId: game.gameId,
    awayTeam: game.awayTeam,
    homeTeam: game.homeTeam,
    statusText: game.statusText,
    resultText: game.resultText,
    startTimeEpochEt: game.startTimeEpochEt,
    startTimeIsoEt: game.startTimeIsoEt,
    startTimeEpoch: game.startTimeEpoch,
    startTimeIso: game.startTimeIso,
    startEpochResolved: game.startEpochResolved,
  }));

  for (const row of scheduleTextRows) {
    if (hasScheduleTextMatch(gamesWithResults, row)) {
      continue;
    }

    const opponentName = cleanQueryString(row.opponentName);
    if (!opponentName) {
      continue;
    }

    const teams = buildUsmTeamsFromScheduleTextRow(row, opponentName);
    const resultText = normalizeResultStatusText(row.resultText);
    const statusText = resultText ? "Final" : cleanQueryString(row.timeLabel) ?? null;

    combined.push({
      date: cleanQueryString(row.dateIso),
      gameId: null,
      awayTeam: teams.awayTeam,
      homeTeam: teams.homeTeam,
      statusText,
      resultText,
      startTimeEpochEt: null,
      startTimeIsoEt: null,
      startTimeEpoch: null,
      startTimeIso: null,
      startEpochResolved: null,
    });
  }

  return combined.sort((a, b) => {
    const aEpoch = a.startEpochResolved;
    const bEpoch = b.startEpochResolved;
    if (aEpoch !== null && bEpoch !== null && aEpoch !== bEpoch) {
      return aEpoch - bEpoch;
    }

    if (aEpoch !== null && bEpoch === null) {
      return -1;
    }
    if (aEpoch === null && bEpoch !== null) {
      return 1;
    }

    if (a.date && b.date && a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }

    const aGameId = a.gameId ?? Number.MAX_SAFE_INTEGER;
    const bGameId = b.gameId ?? Number.MAX_SAFE_INTEGER;
    if (aGameId !== bGameId) {
      return aGameId - bGameId;
    }

    return resolveUsmOpponentNameFromTeams(a.awayTeam, a.homeTeam).localeCompare(
      resolveUsmOpponentNameFromTeams(b.awayTeam, b.homeTeam)
    );
  });
}

function hasScheduleTextMatch(
  gamesWithResults: UsmScheduleGameNormalized[],
  row: SouthernMissScheduleTextGame
): boolean {
  const dateIso = cleanQueryString(row.dateIso);
  if (!dateIso) {
    return false;
  }

  const sameDateGames = gamesWithResults.filter((game) => game.date === dateIso);
  if (sameDateGames.length === 0) {
    return false;
  }

  const normalizedRowOpponent = normalizeUsmOpponentMatchName(row.opponentName ?? "");
  if (!normalizedRowOpponent) {
    return true;
  }

  return sameDateGames.some((game) => {
    const normalizedOpponent = normalizeUsmOpponentMatchName(resolveUsmOpponentName(game));
    if (!normalizedOpponent) {
      return false;
    }

    return (
      normalizedOpponent === normalizedRowOpponent ||
      normalizedOpponent.includes(normalizedRowOpponent) ||
      normalizedRowOpponent.includes(normalizedOpponent)
    );
  });
}

function buildUsmTeamsFromScheduleTextRow(
  row: SouthernMissScheduleTextGame,
  opponentName: string
): { awayTeam: string; homeTeam: string } {
  const site = normalizeLookupName(row.siteLabel ?? "");
  if (site.includes("home")) {
    return {
      awayTeam: opponentName,
      homeTeam: "Southern Miss",
    };
  }

  if (site.includes("away")) {
    return {
      awayTeam: "Southern Miss",
      homeTeam: opponentName,
    };
  }

  return {
    awayTeam: "Southern Miss",
    homeTeam: opponentName,
  };
}

function resolveUsmOpponentNameFromTeams(awayTeam: string, homeTeam: string): string {
  const home = normalizeLookupName(homeTeam);
  const away = normalizeLookupName(awayTeam);
  if (home.includes("southern miss")) {
    return awayTeam;
  }
  if (away.includes("southern miss")) {
    return homeTeam;
  }
  return awayTeam || homeTeam;
}

function findBestScheduleTextMatchIndex(
  candidates: Array<{ row: SouthernMissScheduleTextGame; used: boolean }>,
  normalizedOpponent: string,
  unusedOnly: boolean
): number {
  let bestIndex = -1;
  let bestScore = -1;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (unusedOnly && candidate.used) {
      continue;
    }

    const opponent = normalizeUsmOpponentMatchName(candidate.row.opponentName ?? "");
    if (!opponent || !normalizedOpponent) {
      continue;
    }

    let score = 0;
    if (opponent === normalizedOpponent) {
      score = 40;
    } else if (opponent.includes(normalizedOpponent) || normalizedOpponent.includes(opponent)) {
      score = 25;
    } else {
      const opponentTokens = opponent.split(" ").filter((token) => token.length > 2);
      const targetTokens = new Set(normalizedOpponent.split(" ").filter((token) => token.length > 2));
      const overlap = opponentTokens.filter((token) => targetTokens.has(token)).length;
      if (overlap > 0) {
        score = overlap;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function normalizeResultStatusText(value: string | null): string | null {
  const text = cleanQueryString(value);
  if (!text || text === "-" || text === "--") {
    return null;
  }

  const outcome = parseOutcomeFromStatusText(text);
  const runs = parseRunsFromResultText(text, outcome);
  if (outcome === "unknown" || runs.runsFor === null || runs.runsAgainst === null) {
    return null;
  }

  return text;
}

function normalizeUsmOpponentMatchName(value: string): string {
  let normalized = normalizeLookupName(value);
  if (!normalized) {
    return normalized;
  }

  const aliasMap: Array<[RegExp, string]> = [
    [/\bapp state\b/g, "appalachian state"],
    [/\bulm\b/g, "ul monroe"],
    [/\bla tech\b/g, "louisiana tech"],
    [/\bolde? dom\b/g, "old dominion"],
  ];

  for (const [pattern, replacement] of aliasMap) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized.replace(/\s+/g, " ").trim();
}

function buildUsmSeasonSummary(scheduleRows: UsmSiteScheduleRow[]): UsmSeasonSummary {
  const completed = scheduleRows.filter((game) => game.isCompleted);
  const wins = completed.filter((game) => game.outcome === "win").length;
  const losses = completed.filter((game) => game.outcome === "loss").length;
  const gamesPlayed = wins + losses;

  const home: UsmRecordSplit = { wins: 0, losses: 0 };
  const away: UsmRecordSplit = { wins: 0, losses: 0 };
  const neutral: UsmRecordSplit = { wins: 0, losses: 0 };

  let runsFor = 0;
  let runsAgainst = 0;
  for (const game of completed) {
    if (game.runsFor !== null) {
      runsFor += game.runsFor;
    }
    if (game.runsAgainst !== null) {
      runsAgainst += game.runsAgainst;
    }

    const bucket = game.locationType === "@" ? away : game.locationType === "vs" ? neutral : home;
    if (game.outcome === "win") {
      bucket.wins += 1;
    } else if (game.outcome === "loss") {
      bucket.losses += 1;
    }
  }

  const recent = completed.slice(-10);
  const recentWins = recent.filter((game) => game.outcome === "win").length;
  const recentLosses = recent.filter((game) => game.outcome === "loss").length;

  let streak = "-";
  const latestCompleted = completed[completed.length - 1];
  if (latestCompleted) {
    let streakCount = 1;
    for (let i = completed.length - 2; i >= 0; i -= 1) {
      if (completed[i].outcome !== latestCompleted.outcome) {
        break;
      }
      streakCount += 1;
    }
    streak = `${latestCompleted.outcome === "win" ? "W" : "L"}${streakCount}`;
  }

  const winPctRaw = gamesPlayed > 0 ? wins / gamesPlayed : 0;
  const averageRunsFor = gamesPlayed > 0 ? runsFor / gamesPlayed : 0;
  const averageRunsAgainst = gamesPlayed > 0 ? runsAgainst / gamesPlayed : 0;

  return {
    gamesPlayed,
    wins,
    losses,
    winPct: winPctRaw.toFixed(3).replace(/^0(?=\.)/u, ""),
    runDifferential: runsFor - runsAgainst,
    runsFor,
    runsAgainst,
    averageRunsFor: averageRunsFor.toFixed(2),
    averageRunsAgainst: averageRunsAgainst.toFixed(2),
    home,
    away,
    neutral,
    streak,
    last10: `${recentWins}-${recentLosses}`,
  };
}

function parseNullableInteger(value: unknown): number | null {
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

function parsePositiveInteger(value: unknown): number | null {
  const parsed = parseNullableInteger(value);
  if (parsed === null || parsed < 1) {
    return null;
  }

  return parsed;
}

function resolveUsmSchedulePath(env: NodeJS.ProcessEnv): string {
  const configured = cleanQueryString(env.USM_SCHEDULE_FILE ?? env.X_DAEMON_SCHEDULE_FILE);
  if (!configured) {
    return path.resolve(process.cwd(), "data/schedules/southern-miss-2026.json");
  }

  if (path.isAbsolute(configured)) {
    return configured;
  }

  return path.resolve(process.cwd(), configured);
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
