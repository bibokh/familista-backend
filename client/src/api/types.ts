// ── Shared API response types ─────────────────────────────────────────────────

export interface PaginatedMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginatedMeta;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  clubId: string;
  clubName?: string;
}

export interface AuthResponse {
  tokens: {
    accessToken: string;
    refreshToken: string;
  };
  user: AuthUser;
}

// ── Player ───────────────────────────────────────────────────────────────────

export interface Player {
  id: string;
  name: string;
  position: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  number: number | null;
  foot: string | null;
  height: number | null;
  weight: number | null;
  status: string;
  teamId: string | null;
  teamName?: string;
  clubId: string;
}

// ── Team ─────────────────────────────────────────────────────────────────────

export interface Team {
  id: string;
  name: string;
  ageGroup: string | null;
  clubId: string;
}

// ── Match ────────────────────────────────────────────────────────────────────

export interface Match {
  id: string;
  homeTeam: string;
  awayTeam: string;
  date: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  competition: string | null;
  venue: string | null;
}

// ── Phase Q — Player Stats ────────────────────────────────────────────────────

export interface PlayerMatchStats {
  id: string;
  playerId: string;
  matchId: string;
  minutesPlayed: number;
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  xGoals: number | null;
  xAssists: number | null;
  passes: number;
  passesCompleted: number;
  passAccuracy: number | null;
  keyPasses: number;
  dribbles: number;
  dribblesSuccessful: number;
  tackles: number;
  interceptions: number;
  clearances: number;
  foulsCommitted: number;
  foulsSuffered: number;
  yellowCards: number;
  redCards: number;
  distanceCovered: number | null;
  topSpeed: number | null;
  sprintsCount: number | null;
  heatZone: string | null;
  ratingAI: number | null;
}

export interface PlayerSeasonStats {
  id: string;
  playerId: string;
  seasonLabel: string;
  clubId: string;
  matchesPlayed: number;
  minutesPlayed: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  xGoals: number | null;
  xAssists: number | null;
  goalsPerNinety: number | null;
  assistsPerNinety: number | null;
  xGoalsPerNinety: number | null;
  avgRatingAI: number | null;
  avgDistanceCovered: number | null;
  avgTopSpeed: number | null;
}

export interface PlayerProfile {
  player: Player;
  currentSeason: PlayerSeasonStats | null;
  allSeasons: PlayerSeasonStats[];
  recentMatches: PlayerMatchStats[];
  careerGoals: number;
  careerAssists: number;
  careerMatches: number;
}

// ── Phase Q — Workload ────────────────────────────────────────────────────────

export type RiskTier = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export interface PlayerReadiness {
  playerId: string;
  name: string;
  position: string | null;
  atl: number | null;
  ctl: number | null;
  tsb: number | null;
  acwr: number | null;
  riskScore: number;
  riskTier: RiskTier;
  status: 'AVAILABLE' | 'HIGH_RISK' | 'INJURED' | 'SUSPENDED';
}

export interface SquadReadiness {
  teamId: string;
  computedAt: string;
  players: PlayerReadiness[];
  summary: {
    available: number;
    highRisk: number;
    injured: number;
    suspended: number;
  };
}

export interface Injury {
  id: string;
  playerId: string;
  playerName?: string;
  injuryType: string;
  bodyPart: string;
  severity: string;
  dateOccurred: string;
  expectedReturn: string | null;
  actualReturn: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'RECOVERED' | 'CHRONIC';
}

// ── Phase Q — Transfer ────────────────────────────────────────────────────────

export type TransferStage =
  | 'WATCHLIST'
  | 'INTEREST'
  | 'APPROACHED'
  | 'NEGOTIATING'
  | 'AGREED'
  | 'SIGNED'
  | 'REJECTED';

export interface TransferTarget {
  id: string;
  targetPlayerId: string | null;
  externalPlayerName: string | null;
  externalClub: string | null;
  position: string | null;
  age: number | null;
  nationality: string | null;
  marketValue: number | null;
  askingPrice: number | null;
  stage: TransferStage;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  scoutRating: number | null;
  notes: string | null;
  clubId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransferPipelineBoard {
  stages: Record<TransferStage, TransferTarget[]>;
  totalCount: number;
}

export interface ScoutingReport {
  id: string;
  targetPlayerId: string | null;
  externalPlayerName: string | null;
  scoutId: string;
  overallScore: number;
  technicalScore: number | null;
  physicalScore: number | null;
  mentalScore: number | null;
  tacticalScore: number | null;
  notes: string | null;
  recommendation: 'STRONG_BUY' | 'BUY' | 'MONITOR' | 'PASS';
  clubId: string;
  createdAt: string;
}

export interface ContractStatus {
  playerId: string;
  expiresAt: string | null;
  salary: number | null;
  currency: string;
  contractType: string;
  isExpiringSoon: boolean;
}

// ── Phase Q — Competition ─────────────────────────────────────────────────────

export interface Competition {
  id: string;
  name: string;
  season: string;
  type: string;
  status: string;
  clubId: string;
}

export interface StandingRow {
  position: number;
  teamId: string;
  teamName: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  form: string[];
}

export interface Fixture {
  id: string;
  competitionId: string;
  homeTeamId: string;
  homeTeamName: string;
  awayTeamId: string;
  awayTeamName: string;
  scheduledAt: string;
  matchday: number;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  venue: string | null;
}

// ── Phase S.1 — Video Intelligence ───────────────────────────────────────────

export type VideoAssetStatus = 'PENDING' | 'UPLOADED' | 'READY' | 'FAILED';
export type VideoSourceKind  = 'MATCH' | 'TRAINING' | 'HIGHLIGHTS' | 'SCOUTING' | 'OTHER';

export interface VideoAsset {
  id:              string;
  clubId:          string;
  title:           string;
  description:     string | null;
  sourceKind:      VideoSourceKind;
  matchId:         string | null;
  teamId:          string | null;
  status:          VideoAssetStatus;
  rawStorageKey:   string | null;
  hlsManifestKey:  string | null;
  thumbStorageKey: string | null;
  cdnBaseUrl:      string | null;
  durationSec:     number | null;
  widthPx:         number | null;
  heightPx:        number | null;
  tags:            string[];
  uploadedBy:      string;
  uploadedAt:      string | null;
  transcodedAt:    string | null;
  createdAt:       string;
}

export interface VideoClip {
  id:          string;
  assetId:     string;
  title:       string | null;
  description: string | null;
  startSec:    number;
  endSec:      number;
  eventId:     string | null;
  shareToken:  string | null;
  tags:        string[];
  createdBy:   string;
  createdAt:   string;
}

export interface VideoAnnotation {
  id:           string;
  clipId:       string;
  timestampSec: number;
  label:        string | null;
  shape:        string;        // 'arrow' | 'circle' | 'rect' | 'line' | 'text'
  x:            number;
  y:            number;
  pathData:     string | null;
  color:        string;
  thickness:    number;
  createdBy:    string;
  createdAt:    string;
}

export interface VideoPlaylist {
  id:          string;
  clubId:      string;
  title:       string;
  description: string | null;
  clipIds:     string[];
  createdBy:   string;
  createdAt:   string;
}

// ── Phase S.2 — AI Intelligence ──────────────────────────────────────────────

export type AIJobStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export type AIJobDomain =
  | 'match_analysis'
  | 'tactical_advisor'
  | 'recruitment'
  | 'training_planner'
  | 'injury_risk';

export interface AIJobOutput {
  text:    string;
  payload: Record<string, unknown> | null;
  model:   string;
  backend: string;
}

export interface AIJob {
  id:        string;
  clubId:    string;
  agent:     string;
  kind:      string;
  status:    AIJobStatus;
  input:     Record<string, unknown>;
  output:    AIJobOutput | null;
  error:     string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface PerformanceTrendPoint {
  label: string;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
}

export interface GpsLoadPoint {
  date: string;
  avgDistance: number;
  avgTopSpeed: number;
  playerCount: number;
}

export interface TopPerformer {
  playerId: string;
  name: string;
  position: string | null;
  goals: number;
  assists: number;
  ratingAI: number | null;
}

export interface ClubAnalytics {
  playerCount: number;
  injuredCount: number;
  recentMatchCount: number;
  winRate: number;
  performanceTrend: PerformanceTrendPoint[];
  gpsLoadTrend: GpsLoadPoint[];
  topPerformers: TopPerformer[];
  highRiskPlayerCount: number;
}
