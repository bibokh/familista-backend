// ── Typed API endpoints ───────────────────────────────────────────────────────
// Each function corresponds to one backend route.

import { api, qs } from './client';
import type {
  AuthResponse,
  PaginatedResponse,
  Player,
  Team,
  Match,
  PlayerProfile,
  PlayerMatchStats,
  PlayerSeasonStats,
  SquadReadiness,
  Injury,
  TransferPipelineBoard,
  TransferTarget,
  ScoutingReport,
  ContractStatus,
  Competition,
  StandingRow,
  Fixture,
  ClubAnalytics,
  VideoAsset,
  VideoClip,
  VideoAnnotation,
  AIJob,
} from './types';

// ── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    api.post<AuthResponse>('/auth/login', { email, password }),

  refreshToken: (refreshToken: string) =>
    api.post<AuthResponse>('/auth/refresh', { refreshToken }),
};

// ── Core resources ────────────────────────────────────────────────────────────

export const playersApi = {
  list: (params?: { page?: number; limit?: number; teamId?: string; signal?: AbortSignal }) =>
    api.get<PaginatedResponse<Player>>(
      `/players${qs({ page: params?.page, limit: params?.limit ?? 50, teamId: params?.teamId })}`,
      params?.signal,
    ),
};

export const teamsApi = {
  list: () => api.get<PaginatedResponse<Team>>('/teams?limit=100'),
};

export const matchesApi = {
  list: (params?: { page?: number; limit?: number }) =>
    api.get<PaginatedResponse<Match>>(
      `/matches${qs({ page: params?.page, limit: params?.limit ?? 20 })}`,
    ),
};

// ── Phase Q — Player Stats ────────────────────────────────────────────────────

export const statsApi = {
  playerProfile: (playerId: string, signal?: AbortSignal) =>
    api.get<PlayerProfile>(`/phase-q/stats/players/${playerId}/profile`, signal),

  playerSeasons: (playerId: string) =>
    api.get<PlayerSeasonStats[]>(`/phase-q/stats/players/${playerId}/seasons`),

  matchStats: (matchId: string) =>
    api.get<PlayerMatchStats[]>(`/phase-q/stats/matches/${matchId}`),

  rebuildMatchStats: (matchId: string) =>
    api.post<{ message: string }>(`/phase-q/stats/matches/${matchId}/rebuild`),
};

// ── Phase Q — Workload ────────────────────────────────────────────────────────

export const workloadApi = {
  squadReadiness: (teamId: string, signal?: AbortSignal) =>
    api.get<SquadReadiness>(`/phase-q/workload/teams/${teamId}/readiness`, signal),

  listInjuries: (params?: { page?: number; limit?: number; status?: string }) =>
    api.get<PaginatedResponse<Injury>>(
      `/phase-q/workload/injuries${qs({ ...params, limit: params?.limit ?? 50 })}`,
    ),

  recordInjury: (payload: Partial<Injury>) =>
    api.post<Injury>('/phase-q/workload/injuries', payload),

  updateInjuryReturn: (injuryId: string, returnDate: string) =>
    api.patch<Injury>(`/phase-q/workload/injuries/${injuryId}/return`, { returnDate }),
};

// ── Phase Q — Transfer ────────────────────────────────────────────────────────

export const transferApi = {
  pipeline: (signal?: AbortSignal) =>
    api.get<TransferPipelineBoard>('/phase-q/transfer/pipeline', signal),

  listTargets: (params?: { page?: number; limit?: number; stage?: string }) =>
    api.get<PaginatedResponse<TransferTarget>>(
      `/phase-q/transfer/targets${qs({ ...params, limit: params?.limit ?? 50 })}`,
    ),

  listReports: (params?: { page?: number; limit?: number }) =>
    api.get<PaginatedResponse<ScoutingReport>>(
      `/phase-q/transfer/reports${qs({ ...params, limit: params?.limit ?? 20 })}`,
    ),

  expiringContracts: (signal?: AbortSignal) =>
    api.get<ContractStatus[]>('/phase-q/transfer/contracts-expiring', signal),

  createTarget: (payload: Partial<TransferTarget>) =>
    api.post<TransferTarget>('/phase-q/transfer/targets', payload),

  advanceStage: (targetId: string, stage: string) =>
    api.post<TransferTarget>(`/phase-q/transfer/targets/${targetId}/advance`, { stage }),
};

// ── Phase Q — Competition ─────────────────────────────────────────────────────

export const competitionApi = {
  list: (signal?: AbortSignal) =>
    api.get<PaginatedResponse<Competition>>(
      '/phase-q/competitions?limit=50',
      signal,
    ),

  standings: (competitionId: string, signal?: AbortSignal) =>
    api.get<{ standings: StandingRow[] }>(
      `/phase-q/competitions/${competitionId}/standings`,
      signal,
    ),

  fixtures: (competitionId: string, params?: { matchday?: number }) =>
    api.get<PaginatedResponse<Fixture>>(
      `/phase-q/competitions/${competitionId}/fixtures${qs({ ...params, limit: 100 })}`,
    ),
};

// ── Phase S.1 — Video Intelligence ───────────────────────────────────────────

export const videoApi = {
  // Asset management
  list: (params?: { status?: string; matchId?: string; limit?: number; offset?: number }, signal?: AbortSignal) =>
    api.get<{ items: VideoAsset[]; total: number }>(
      `/phase-q/video/assets${qs({ ...params, limit: params?.limit ?? 30 })}`,
      signal,
    ),

  get: (assetId: string) =>
    api.get<VideoAsset>(`/phase-q/video/assets/${assetId}`),

  requestUpload: (payload: {
    title:        string;
    description?: string;
    sourceKind:   string;
    matchId?:     string;
    teamId?:      string;
    filename:     string;
    fileSizeMb?:  number;
  }) => api.post<{ asset: VideoAsset; uploadUrl: string; uploadKey: string }>(
    '/phase-q/video/assets/request-upload', payload,
  ),

  confirmUpload: (assetId: string, etag?: string) =>
    api.post<VideoAsset>('/phase-q/video/assets/confirm-upload', { assetId, etag }),

  delete: (assetId: string) =>
    api.del<void>(`/phase-q/video/assets/${assetId}`),

  // HLS proxy URL — authentication is handled by the API proxy, not presigned URLs.
  // hls.js loads this URL directly; segments are served from the same base path.
  hlsUrl: (assetId: string): string =>
    `/api/v1/phase-q/video/assets/${assetId}/hls/manifest.m3u8`,

  // Clips
  listClips: (assetId: string) =>
    api.get<{ items: VideoClip[]; total: number }>(
      `/phase-q/video/clips${qs({ assetId, limit: 100 })}`,
    ),

  createClip: (payload: {
    assetId:      string;
    title?:       string;
    description?: string;
    startSec:     number;
    endSec:       number;
    tags?:        string[];
  }) => api.post<VideoClip>('/phase-q/video/clips', payload),

  deleteClip: (clipId: string) =>
    api.del<void>(`/phase-q/video/clips/${clipId}`),

  // Annotations on a clip
  listAnnotations: (clipId: string) =>
    api.get<VideoAnnotation[]>(`/phase-q/video/clips/${clipId}/annotations`),

  createAnnotation: (payload: {
    clipId:       string;
    timestampSec: number;
    label?:       string;
    shape:        string;
    x:            number;
    y:            number;
    color?:       string;
    thickness?:   number;
  }) => api.post<VideoAnnotation>('/phase-q/video/annotations', payload),

  deleteAnnotation: (annotationId: string) =>
    api.del<void>(`/phase-q/video/annotations/${annotationId}`),
};

// ── Phase S.2 — AI Intelligence ──────────────────────────────────────────────

export const aiIntelligenceApi = {
  // Trigger endpoints — 202 Accepted, frontend polls for completion
  triggerMatchAnalysis: (matchId: string) =>
    api.post<AIJob>(`/phase-s/intelligence/jobs/match/${matchId}/analysis`, {}),

  triggerTactical: (teamId: string) =>
    api.post<AIJob>(`/phase-s/intelligence/jobs/teams/${teamId}/tactical`, {}),

  triggerRecruitment: () =>
    api.post<AIJob>('/phase-s/intelligence/jobs/recruitment', {}),

  triggerTraining: (teamId: string) =>
    api.post<AIJob>(`/phase-s/intelligence/jobs/teams/${teamId}/training`, {}),

  triggerInjuryRisk: (teamId: string) =>
    api.post<AIJob>(`/phase-s/intelligence/jobs/teams/${teamId}/injury-risk`, {}),

  // Read endpoints
  listJobs: (params?: { domain?: string; limit?: number }, signal?: AbortSignal) =>
    api.get<{ items: AIJob[]; total: number }>(
      `/phase-s/intelligence/jobs${qs({ ...params, limit: params?.limit ?? 20 })}`,
      signal,
    ),

  getJob: (jobId: string, signal?: AbortSignal) =>
    api.get<AIJob>(`/phase-s/intelligence/jobs/${jobId}`, signal),
};

// ── Analytics ────────────────────────────────────────────────────────────────

export const analyticsApi = {
  clubOverview: (signal?: AbortSignal) =>
    api.get<ClubAnalytics>('/analytics', signal),
};
