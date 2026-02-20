import axios from "axios";
import crypto from "crypto";
import { getFinalGame } from "./statbroadcast";
import type { StatBroadcastFinalGame } from "../types";
import {
  buildBaseballScorekeepingData,
  type BaseballScorekeepingData,
  normalizePlayerDisplayName,
} from "../scorekeeping/baseball";

const pdfjs: {
  getDocument: (options: Record<string, unknown>) => { promise: Promise<any> };
} = require("pdfjs-dist/legacy/build/pdf.js");

const STATBROADCAST_PRINT_URL = "https://stats.statbroadcast.com/output/print.php";

export const BASEBALL_PRINT_XSL = {
  book: "baseball/sb.bsgame.print.book.xsl",
  ncaabox: "baseball/sb.bsgame.print.ncaabox.xsl",
  scoring: "baseball/sb.bsgame.print.scoring.xsl",
  fullpxp: "baseball/sb.bsgame.print.fullpxp.xsl",
  pregame: "baseball/sb.bsgame.print.pregame.xsl",
  coversheet: "baseball/sb.bsgame.print.coversheet.xsl",
} as const;

export const DEFAULT_BASEBALL_PRINT_XSL = BASEBALL_PRINT_XSL.book;

export interface PdfTextPage {
  page: number;
  lines: string[];
  text: string;
}

export interface PdfTextExtraction {
  pageCount: number;
  pages: PdfTextPage[] | null;
  fullText: string | null;
}

export interface StatBroadcastPdfJsonPayload {
  id: number;
  source: {
    broadcastUrl: string;
    pdfUrl: string;
    xsl: string;
    downloadedAt: string;
  };
  pdf: {
    bytes: number;
    sha256: string;
    pageCount: number;
    includesRawText: boolean;
    pages: PdfTextPage[] | null;
    fullText: string | null;
  };
  baseballScorekeeping: BaseballScorekeepingData | null;
  articleSeed: ReturnType<typeof buildArticleSeed> | null;
  finalGame: StatBroadcastFinalGame | null;
}

export function extractStatBroadcastId(input: string): number | null {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return null;
  }

  if (/^\d+$/.test(raw)) {
    const id = Number.parseInt(raw, 10);
    return Number.isFinite(id) ? id : null;
  }

  try {
    const url = new URL(raw);
    const queryValue = url.searchParams.get("id");
    if (queryValue && /^\d+$/.test(queryValue)) {
      return Number.parseInt(queryValue, 10);
    }
  } catch {
    const queryMatch = raw.match(/[?&]id=(\d+)/i);
    if (queryMatch) {
      return Number.parseInt(queryMatch[1], 10);
    }
  }

  return null;
}

export function buildStatBroadcastPrintPdfUrl(id: number, xsl: string = DEFAULT_BASEBALL_PRINT_XSL): string {
  const url = new URL(STATBROADCAST_PRINT_URL);
  url.searchParams.set("id", String(id));
  url.searchParams.set("xsl", xsl);
  url.searchParams.set("ext", "1");
  url.searchParams.set("format", "pdf");
  url.searchParams.set("prompt", "0");
  return url.toString();
}

export async function getStatBroadcastPdfJson(
  id: number,
  options?: { xsl?: string; includeFinalGame?: boolean; includeRawPdfText?: boolean; timeoutMs?: number }
): Promise<StatBroadcastPdfJsonPayload> {
  const xsl = (options?.xsl ?? DEFAULT_BASEBALL_PRINT_XSL).trim() || DEFAULT_BASEBALL_PRINT_XSL;
  const pdfUrl = buildStatBroadcastPrintPdfUrl(id, xsl);
  const downloadedAt = new Date().toISOString();

  const includeRawPdfText = options?.includeRawPdfText === true;
  const pdfBuffer = await downloadPdf(pdfUrl, options?.timeoutMs ?? 45_000);
  const pdfText = await extractPdfText(pdfBuffer, includeRawPdfText);
  const finalGame =
    options?.includeFinalGame === false
      ? null
      : await getFinalGame(id);
  const baseballScorekeeping = finalGame ? buildBaseballScorekeepingData(finalGame) : null;

  return {
    id,
    source: {
      broadcastUrl: `https://stats.statbroadcast.com/broadcast/?id=${id}`,
      pdfUrl,
      xsl,
      downloadedAt,
    },
    pdf: {
      bytes: pdfBuffer.byteLength,
      sha256: crypto.createHash("sha256").update(pdfBuffer).digest("hex"),
      pageCount: pdfText.pageCount,
      includesRawText: includeRawPdfText,
      pages: pdfText.pages,
      fullText: pdfText.fullText,
    },
    baseballScorekeeping,
    articleSeed: finalGame ? buildArticleSeed(finalGame, baseballScorekeeping) : null,
    finalGame,
  };
}

async function downloadPdf(url: string, timeoutMs: number): Promise<Buffer> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: timeoutMs,
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status >= 400) {
    throw new Error(`StatBroadcast print endpoint failed (${response.status})`);
  }

  const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.includes("application/pdf")) {
    throw new Error(`Expected PDF response but received content-type: ${contentType || "unknown"}`);
  }

  return Buffer.from(response.data);
}

async function extractPdfText(buffer: Buffer, includeRawText: boolean): Promise<PdfTextExtraction> {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  if (!includeRawText) {
    return {
      pageCount: doc.numPages,
      pages: null,
      fullText: null,
    };
  }

  const pages: PdfTextPage[] = [];
  for (let pageIndex = 1; pageIndex <= doc.numPages; pageIndex += 1) {
    const page = await doc.getPage(pageIndex);
    const textContent = await page.getTextContent();

    const linesByY = new Map<number, Array<{ x: number; text: string }>>();
    for (const item of textContent.items) {
      const str = cleanPdfText(String(item.str ?? ""));
      if (!str) {
        continue;
      }

      const x = Number(item.transform?.[4] ?? 0);
      const y = Number(item.transform?.[5] ?? 0);
      const yBucket = Math.round(y * 2) / 2;

      if (!linesByY.has(yBucket)) {
        linesByY.set(yBucket, []);
      }
      linesByY.get(yBucket)?.push({ x, text: str });
    }

    const lines = Array.from(linesByY.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) =>
        parts
          .sort((a, b) => a.x - b.x)
          .map((part) => part.text)
          .join("")
      )
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter((line) => line.length > 0);

    pages.push({
      page: pageIndex,
      lines,
      text: lines.join("\n"),
    });
  }

  return {
    pageCount: doc.numPages,
    pages,
    fullText: pages.map((page) => page.text).join("\n\n"),
  };
}

function cleanPdfText(value: string): string {
  return value.replace(/\u00a0/g, " ");
}

function buildArticleSeed(
  finalGame: StatBroadcastFinalGame,
  baseballScorekeeping: BaseballScorekeepingData | null
) {
  const winningTeamName =
    finalGame.finalScore.winner === "visitor"
      ? finalGame.finalScore.visitorTeam
      : finalGame.finalScore.winner === "home"
        ? finalGame.finalScore.homeTeam
        : null;

  const scoringHighlights = finalGame.scoringPlays.slice(0, 12).map((play) => ({
    inning: play.inning,
    team: play.team,
    batter: normalizePlayerDisplayName(play.batter),
    pitcher: normalizePlayerDisplayName(play.pitcher),
    play: normalizeNamesInText(play.play),
  }));

  const pbpHighlights = finalGame.playByPlayByInning
    .flatMap((inning) =>
      inning.events
        .filter((event) => event.type === "play")
        .map((event) => ({
          inning: inning.inning,
          play: normalizeNamesInText(event.text),
          batter: normalizePlayerDisplayName(event.batter),
          pitcher: normalizePlayerDisplayName(event.pitcher),
          outs: event.outs,
        }))
    )
    .slice(0, 30);

  return {
    matchup: `${finalGame.finalScore.visitorTeam} at ${finalGame.finalScore.homeTeam}`,
    gameStatus: finalGame.status,
    finalScore: {
      visitorTeam: finalGame.finalScore.visitorTeam,
      visitorScore: finalGame.finalScore.visitorScore,
      homeTeam: finalGame.finalScore.homeTeam,
      homeScore: finalGame.finalScore.homeScore,
      winner: winningTeamName,
    },
    pitcherDecisions: {
      winning: normalizeSeedPitcherDecision(finalGame.pitcherDecisions.winning),
      losing: normalizeSeedPitcherDecision(finalGame.pitcherDecisions.losing),
      save: normalizeSeedPitcherDecision(finalGame.pitcherDecisions.save),
    },
    eventMeta: {
      title: finalGame.event.title,
      date: finalGame.event.date,
      time: finalGame.event.time,
      venue: finalGame.event.venue,
      location: finalGame.event.location,
    },
    scorekeepingSnapshot:
      baseballScorekeeping === null
        ? null
        : {
            attendance: baseballScorekeeping.game.attendance,
            duration: baseballScorekeeping.game.duration,
            lineScore: {
              innings: baseballScorekeeping.teams.away.lineScore.innings,
              awayByInning: baseballScorekeeping.teams.away.lineScore.runsByInning,
              homeByInning: baseballScorekeeping.teams.home.lineScore.runsByInning,
              totals: {
                away: baseballScorekeeping.teams.away.lineScore.totals,
                home: baseballScorekeeping.teams.home.lineScore.totals,
              },
            },
          },
    scoringHighlights,
    notes: finalGame.notesDocs.notes.slice(0, 20),
    playByPlayHighlights: pbpHighlights,
  };
}

function normalizeNamesInText(value: string | null): string | null {
  const text = value === null ? null : String(value);
  if (text === null) {
    return null;
  }
  return text.replace(/\b([A-Z][A-Za-z'.-]+),\s*([A-Z][A-Za-z'.-]+)\b/g, (_match, last, first) => {
    return `${first} ${last}`;
  });
}

function normalizeSeedPitcherDecision(
  decision: StatBroadcastFinalGame["pitcherDecisions"]["winning"]
): StatBroadcastFinalGame["pitcherDecisions"]["winning"] {
  if (!decision) {
    return null;
  }
  const player = normalizePlayerDisplayName(decision.player) ?? decision.player;
  return player === decision.player ? decision : { ...decision, player };
}
