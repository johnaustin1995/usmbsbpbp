export interface TeamSnapshot {
  id: number | null;
  name: string;
  rank: number | null;
  score: number | null;
  logoUrl: string | null;
  teamUrl: string | null;
  searchTokens: string[];
}

export interface ScoreLink {
  label: string;
  url: string;
}

export interface D1Game {
  key: string;
  conferenceIds: string[];
  conferenceNames: string[];
  statusText: string;
  matchupTimeEpoch: number | null;
  matchupTimeIso: string | null;
  inProgress: boolean;
  isOver: boolean;
  location: string | null;
  roadTeam: TeamSnapshot;
  homeTeam: TeamSnapshot;
  links: ScoreLink[];
  liveStatsUrl: string | null;
  statbroadcastId: number | null;
  statbroadcastQuery: Record<string, string>;
}

export interface D1ScoresPayload {
  date: string;
  sourceUpdatedAt: string | null;
  games: D1Game[];
}

export interface D1ConferenceDirectoryEntry {
  id: number | null;
  name: string;
  slug: string | null;
  url: string;
}

export interface D1TeamDirectoryEntry {
  id: number | null;
  name: string;
  slug: string | null;
  url: string;
  baseUrl: string;
}

export interface D1ConferenceMembership {
  slug: string;
  name: string;
  url: string;
}

export type D1ScheduleOutcome = "win" | "loss" | "unknown";

export interface D1TeamScheduleGame {
  scheduleId: string | null;
  dateLabel: string | null;
  dateUrl: string | null;
  locationType: string | null;
  opponentName: string | null;
  opponentSlug: string | null;
  opponentUrl: string | null;
  opponentLogoUrl: string | null;
  resultText: string | null;
  resultUrl: string | null;
  outcome: D1ScheduleOutcome;
  notes: string | null;
  columns: Record<string, string | null>;
}

export interface D1TeamStatsTableRow {
  cells: Array<string | null>;
  values: Record<string, string | null>;
}

export interface D1TeamStatsTable {
  id: string | null;
  group: string | null;
  section: string | null;
  headers: string[];
  rows: D1TeamStatsTableRow[];
}

export interface D1TeamSeasonData {
  id: number | null;
  name: string;
  slug: string | null;
  season: string | null;
  conference: D1ConferenceDirectoryEntry | null;
  logoUrl: string | null;
  teamUrl: string;
  scheduleUrl: string;
  statsUrl: string;
  schedule: D1TeamScheduleGame[];
  statsTables: D1TeamStatsTable[];
  errors: string[];
}

export interface D1TeamsDatabasePayload {
  fetchedAt: string;
  sourceUrl: string;
  season: string | null;
  conferences: D1ConferenceDirectoryEntry[];
  teams: D1TeamSeasonData[];
  errors: string[];
}

export interface StatBroadcastEventMeta {
  id: number;
  title: string;
  sport: string;
  xmlFile: string;
  date: string | null;
  time: string | null;
  venue: string | null;
  location: string | null;
  homeName: string;
  visitorName: string;
  completed: boolean;
}

export interface LiveCount {
  balls: number | null;
  strikes: number | null;
}

export interface LiveBases {
  first: boolean;
  second: boolean;
  third: boolean;
  mask: number | null;
}

export interface LiveBatter {
  name: string | null;
  ab: number | null;
  hits: number | null;
  summary: string | null;
}

export interface LivePitcher {
  name: string | null;
  pitchCount: number | null;
}

export interface LiveSituation {
  inningText: string | null;
  half: "top" | "bottom" | null;
  inning: number | null;
  count: LiveCount;
  outs: number | null;
  bases: LiveBases;
  battingTeam: "away" | "home" | null;
  batter: LiveBatter;
  pitcher: LivePitcher;
}

export interface LineScoreRow {
  team: string;
  innings: Array<{ inning: number; value: number | null }>;
  totals: Record<string, number | null | string>;
  columns: Record<string, number | null | string>;
}

export interface LineScore {
  headers: string[];
  rows: LineScoreRow[];
}

export interface StatBroadcastLiveSummary {
  id: number;
  event: StatBroadcastEventMeta;
  statusText: string | null;
  visitorTeam: string;
  homeTeam: string;
  visitorScore: number | null;
  homeScore: number | null;
  lineScore: LineScore | null;
  situation: LiveSituation | null;
  thisInning: {
    label: string;
    runs: number | null;
    hits: number | null;
    errors: number | null;
  } | null;
  fetchedAt: string;
}

export interface StatsTableRow {
  cells: Array<string | number | null>;
  values: Record<string, string | number | null>;
}

export interface StatsTable {
  headers: string[];
  rows: StatsTableRow[];
}

export interface StatsSection {
  title: string;
  tables: StatsTable[];
}

export interface StatBroadcastLiveStats {
  id: number;
  view: string;
  event: StatBroadcastEventMeta;
  summary: StatBroadcastLiveSummary;
  sections: StatsSection[];
  fetchedAt: string;
}

export type PitcherDecisionCode = "W" | "L" | "S";

export interface PitcherDecision {
  team: "away" | "home";
  player: string;
  code: PitcherDecisionCode;
  record: string | null;
  raw: string;
}

export interface FinalLineupEntry {
  spot: number | null;
  position: string | null;
  player: string;
  bats: string | null;
  today: string | null;
  avg: string | null;
}

export interface FinalScoringPlay {
  team: string | null;
  inning: string | null;
  scoringDecision: string | null;
  play: string;
  batter: string | null;
  pitcher: string | null;
  outs: number | null;
}

export type FinalPlayByPlayEventType = "half" | "play" | "summary" | "note";

export interface FinalPlayByPlayEvent {
  type: FinalPlayByPlayEventType;
  half: "top" | "bottom" | null;
  text: string;
  action: string | null;
  scoringDecision: string | null;
  batter: string | null;
  pitcher: string | null;
  outs: number | null;
}

export interface FinalInningPlayByPlay {
  inning: number;
  title: string;
  events: FinalPlayByPlayEvent[];
}

export interface FinalNotesDocument {
  label: string;
  url: string;
}

export interface FinalNotesDocs {
  sections: StatsSection[];
  gameInformation: Record<string, string | number | null>;
  notes: string[];
  documents: FinalNotesDocument[];
}

export interface FinalTeamStats {
  sections: StatsSection[];
  boxScore: StatsTable | null;
  pitching: StatsTable | null;
}

export interface StatBroadcastFinalGame {
  id: number;
  event: StatBroadcastEventMeta;
  status: "final" | "not_final" | "unknown";
  summary: StatBroadcastLiveSummary;
  finalScore: {
    visitorTeam: string;
    homeTeam: string;
    visitorScore: number | null;
    homeScore: number | null;
    winner: "visitor" | "home" | null;
  };
  pitcherDecisions: {
    winning: PitcherDecision | null;
    losing: PitcherDecision | null;
    save: PitcherDecision | null;
  };
  lineups: {
    away: FinalLineupEntry[];
    home: FinalLineupEntry[];
  };
  visitorStats: FinalTeamStats;
  homeStats: FinalTeamStats;
  scoringPlays: FinalScoringPlay[];
  playByPlayByInning: FinalInningPlayByPlay[];
  notesDocs: FinalNotesDocs;
  fetchedAt: string;
}

export interface D1GameWithLive extends D1Game {
  live: StatBroadcastLiveSummary | null;
  liveError: string | null;
}

export type FrontendGamePhase = "upcoming" | "live" | "final";

export interface FrontendTeam {
  side: "away" | "home";
  name: string;
  shortName: string;
  rank: number | null;
  score: number | null;
  logoUrl: string | null;
  teamUrl: string | null;
  isWinner: boolean;
}

export interface FrontendGameCard {
  id: string;
  key: string;
  phase: FrontendGamePhase;
  status: string;
  displayTime: string | null;
  startTimeEpoch: number | null;
  startTimeIso: string | null;
  location: string | null;
  conferences: string[];
  statbroadcastId: number | null;
  liveStatsUrl: string | null;
  teams: [FrontendTeam, FrontendTeam];
  hasAnyScore: boolean;
  liveSituation: LiveSituation | null;
  liveError: string | null;
}

export interface FrontendTickerItem {
  id: string;
  phase: FrontendGamePhase;
  text: string;
  status: string;
  statbroadcastId: number | null;
  liveStatsUrl: string | null;
}

export interface FrontendScoresFeed {
  date: string;
  updatedAt: string | null;
  totalGames: number;
  cards: FrontendGameCard[];
  ticker: FrontendTickerItem[];
}

export interface FrontendLiveSummary {
  id: number;
  title: string;
  phase: FrontendGamePhase;
  status: string;
  teams: [FrontendTeam, FrontendTeam];
  lineScore: LineScore | null;
  situation: LiveSituation | null;
  thisInning: StatBroadcastLiveSummary["thisInning"];
  fetchedAt: string;
}
