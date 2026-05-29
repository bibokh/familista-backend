// Familista — AI Intelligence Center (Phase S.2)
// Target: client/src/pages/ai/AICenter.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Five-domain AI analysis center:
//   Match Analysis   — post-match LLM report triggered per match
//   Tactical Advisor — formation / system recommendations per team
//   Recruitment      — squad gap + transfer target intelligence (club-level)
//   Training Planner — 7-day microcycle from squad state
//   Injury Risk      — ACWR-based risk prediction per team
//
// UX flow:
//   1. Pick domain tab
//   2. For team/match domains: pick entity from dropdown
//   3. Click "Run Analysis" → 202 queued → status poll every 5s
//   4. Click a job card in the list → detail panel shows status/output

import { useState, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { aiIntelligenceApi } from '@/api/endpoints';
import { teamsApi, matchesApi } from '@/api/endpoints';
import type { AIJob, AIJobDomain } from '@/api/types';
import styles from './AICenter.module.css';

// ─── Domain config ────────────────────────────────────────────────────────────

interface DomainConfig {
  key:       AIJobDomain;
  label:     string;
  icon:      string;
  kind:      string;
  entity:    'match' | 'team' | 'none';
  desc:      string;
}

const DOMAINS: DomainConfig[] = [
  {
    key:    'match_analysis',
    label:  'Match Analysis',
    icon:   '◉',
    kind:   'INTELLIGENCE.MATCH_ANALYSIS',
    entity: 'match',
    desc:   'Post-match AI report: player ratings, tactical patterns, key moments, and recommendations.',
  },
  {
    key:    'tactical_advisor',
    label:  'Tactical Advisor',
    icon:   '◈',
    kind:   'INTELLIGENCE.TACTICAL_ADVISOR',
    entity: 'team',
    desc:   'Formation and system recommendations based on squad composition and recent results.',
  },
  {
    key:    'recruitment',
    label:  'Recruitment',
    icon:   '⟺',
    kind:   'INTELLIGENCE.RECRUITMENT',
    entity: 'none',
    desc:   'Squad gap analysis and transfer target intelligence based on your current roster.',
  },
  {
    key:    'training_planner',
    label:  'Training Planner',
    icon:   '⊕',
    kind:   'INTELLIGENCE.TRAINING_PLANNER',
    entity: 'team',
    desc:   '7-day training microcycle tailored to upcoming fixtures and player workload data.',
  },
  {
    key:    'injury_risk',
    label:  'Injury Risk',
    icon:   '♥',
    kind:   'INTELLIGENCE.INJURY_RISK_SCAN',
    entity: 'team',
    desc:   'ACWR-based injury risk scan: identifies high-risk players and recommends protective measures.',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    'INTELLIGENCE.MATCH_ANALYSIS':   'Match Analysis',
    'INTELLIGENCE.TACTICAL_ADVISOR': 'Tactical Advisor',
    'INTELLIGENCE.RECRUITMENT':      'Recruitment',
    'INTELLIGENCE.TRAINING_PLANNER': 'Training Planner',
    'INTELLIGENCE.INJURY_RISK_SCAN': 'Injury Risk',
  };
  return map[kind] ?? kind;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)        return 'Just now';
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`${styles.jobStatusDot} ${styles[`dot-${status}` as keyof typeof styles] ?? ''}`}
    />
  );
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`${styles.jobStatusChip} ${styles[`chip-${status}` as keyof typeof styles] ?? ''}`}>
      {status}
    </span>
  );
}

function JobCard({
  job,
  selected,
  onClick,
}: {
  job:      AIJob;
  selected: boolean;
  onClick:  () => void;
}) {
  return (
    <div
      className={`${styles.jobCard} ${selected ? styles.selected : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      <StatusDot status={job.status} />
      <div className={styles.jobMeta}>
        <p className={styles.jobKindLabel}>{kindLabel(job.kind)}</p>
        <p className={styles.jobTime}>{relativeTime(job.createdAt)}</p>
      </div>
      <StatusChip status={job.status} />
    </div>
  );
}

function JobDetail({ job }: { job: AIJob }) {
  const output = job.output as { text?: string; payload?: unknown; model?: string } | null;

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <p className={styles.detailDomain}>{kindLabel(job.kind)}</p>
          <StatusChip status={job.status} />
        </div>
        <div className={styles.detailMeta}>
          <span className={styles.detailMetaItem}>
            <strong>Agent:</strong> {job.agent}
          </span>
          <span className={styles.detailMetaItem}>
            <strong>Started:</strong> {new Date(job.createdAt).toLocaleString()}
          </span>
        </div>
      </div>

      <div className={styles.detailBody}>
        {job.status === 'PENDING' && (
          <div className={styles.pendingState}>
            <p className={styles.stateTitle}>Queued</p>
            <p className={styles.stateSubtitle}>Waiting for an AI worker to pick up this job.</p>
          </div>
        )}

        {job.status === 'RUNNING' && (
          <div className={styles.runningState}>
            <div className={styles.spinner} />
            <p className={styles.stateTitle}>Analysing…</p>
            <p className={styles.stateSubtitle}>The AI is processing your request. This usually takes 15–60 seconds.</p>
          </div>
        )}

        {job.status === 'FAILED' && (
          <div className={styles.failedState}>
            <p className={styles.failedTitle}>Analysis failed</p>
            <pre className={styles.failedError}>{job.error ?? 'Unknown error'}</pre>
          </div>
        )}

        {job.status === 'SUCCESS' && output && (
          <>
            <div className={styles.outputCard}>
              <div className={styles.outputCardHeader}>
                <p className={styles.outputCardTitle}>AI Analysis</p>
                {output.model && (
                  <span className={styles.outputModelChip}>{output.model}</span>
                )}
              </div>
              <div className={styles.outputText}>
                {output.text ?? 'No analysis text returned.'}
              </div>
            </div>

            {output.payload && Object.keys(output.payload as object).length > 0 && (
              <div className={styles.payloadSection}>
                <p className={styles.payloadTitle}>Structured Data</p>
                <pre className={styles.payloadCode}>
                  {JSON.stringify(output.payload, null, 2)}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AICenter() {
  const qc = useQueryClient();

  const [activeDomain, setActiveDomain] = useState<AIJobDomain>('match_analysis');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [entityId, setEntityId] = useState<string>('');

  const domain = DOMAINS.find((d) => d.key === activeDomain)!;

  // ── Data fetching ───────────────────────────────────────────────────────────

  const { data: teamsData } = useQuery({
    queryKey: ['teams'],
    queryFn:  () => teamsApi.list(),
    staleTime: 5 * 60_000,
  });

  const { data: matchesData } = useQuery({
    queryKey: ['matches', { limit: 30 }],
    queryFn:  () => matchesApi.list({ limit: 30 }),
    staleTime: 5 * 60_000,
  });

  const teams   = teamsData?.data ?? [];
  const matches = matchesData?.data ?? [];

  // Reset entity when domain changes
  useEffect(() => {
    setEntityId('');
    setSelectedJobId(null);
  }, [activeDomain]);

  // Auto-select first entity
  useEffect(() => {
    if (entityId) return;
    if (domain.entity === 'team' && teams.length > 0) setEntityId(teams[0].id);
    if (domain.entity === 'match' && matches.length > 0) setEntityId(matches[0].id);
  }, [domain.entity, teams, matches, entityId]);

  // Job list — poll every 5s if any job is PENDING or RUNNING
  const { data: jobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ['ai-jobs', activeDomain],
    queryFn:  (ctx) =>
      aiIntelligenceApi.listJobs({ domain: activeDomain, limit: 30 }, ctx.signal),
    refetchInterval: (query) => {
      const items = (query.state.data as { items: AIJob[] } | undefined)?.items ?? [];
      const hasActive = items.some((j) => j.status === 'PENDING' || j.status === 'RUNNING');
      return hasActive ? 5_000 : 30_000;
    },
  });

  const jobs: AIJob[] = jobsData?.items ?? [];

  // Selected job detail — poll every 4s while not terminal
  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;
  const { data: jobDetail } = useQuery({
    queryKey:  ['ai-job', selectedJobId],
    queryFn:   (ctx) =>
      selectedJobId ? aiIntelligenceApi.getJob(selectedJobId, ctx.signal) : null,
    enabled:   !!selectedJobId,
    refetchInterval: (query) => {
      const s = (query.state.data as AIJob | null)?.status;
      return s === 'PENDING' || s === 'RUNNING' ? 4_000 : false;
    },
  });

  const displayJob = (jobDetail ?? selectedJob) as AIJob | null;

  // Auto-select first job when list loads
  useEffect(() => {
    if (!selectedJobId && jobs.length > 0) {
      setSelectedJobId(jobs[0].id);
    }
  }, [jobs, selectedJobId]);

  // ── Trigger mutations ────────────────────────────────────────────────────────

  const onSuccess = useCallback(
    (job: AIJob) => {
      qc.invalidateQueries({ queryKey: ['ai-jobs', activeDomain] });
      setSelectedJobId(job.id);
    },
    [qc, activeDomain],
  );

  const matchMut     = useMutation({ mutationFn: (id: string) => aiIntelligenceApi.triggerMatchAnalysis(id), onSuccess });
  const tacticalMut  = useMutation({ mutationFn: (id: string) => aiIntelligenceApi.triggerTactical(id),    onSuccess });
  const recruitMut   = useMutation({ mutationFn: () => aiIntelligenceApi.triggerRecruitment(),             onSuccess });
  const trainingMut  = useMutation({ mutationFn: (id: string) => aiIntelligenceApi.triggerTraining(id),    onSuccess });
  const injuryMut    = useMutation({ mutationFn: (id: string) => aiIntelligenceApi.triggerInjuryRisk(id),  onSuccess });

  const isPending =
    matchMut.isPending || tacticalMut.isPending ||
    recruitMut.isPending || trainingMut.isPending || injuryMut.isPending;

  const handleRunAnalysis = useCallback(() => {
    if (isPending) return;
    switch (activeDomain) {
      case 'match_analysis':   if (entityId) matchMut.mutate(entityId);    break;
      case 'tactical_advisor': if (entityId) tacticalMut.mutate(entityId); break;
      case 'recruitment':      recruitMut.mutate();                         break;
      case 'training_planner': if (entityId) trainingMut.mutate(entityId); break;
      case 'injury_risk':      if (entityId) injuryMut.mutate(entityId);   break;
    }
  }, [activeDomain, entityId, isPending, matchMut, tacticalMut, recruitMut, trainingMut, injuryMut]);

  const canRun = domain.entity === 'none' || !!entityId;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.titleBlock}>
            <h1 className={styles.pageTitle}>AI Intelligence</h1>
            <p className={styles.pageSubtitle}>
              {domain.desc}
            </p>
          </div>
        </div>

        {/* Domain tabs */}
        <div className={styles.tabs} role="tablist">
          {DOMAINS.map((d) => (
            <button
              key={d.key}
              role="tab"
              aria-selected={activeDomain === d.key}
              className={`${styles.tab} ${activeDomain === d.key ? styles.active : ''}`}
              onClick={() => setActiveDomain(d.key)}
            >
              <span className={styles.tabIcon}>{d.icon}</span>
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className={styles.body}>
        {/* Left: job list */}
        <div className={styles.listPanel}>
          <div className={styles.listHeader}>
            <p className={styles.listTitle}>Recent Jobs</p>
            <button
              className={styles.runBtn}
              onClick={handleRunAnalysis}
              disabled={isPending || !canRun}
              title={!canRun ? 'Select an entity first' : 'Run AI analysis'}
            >
              <span className={styles.runBtnIcon}>
                {isPending ? '◌' : '▶'}
              </span>
              {isPending ? 'Running…' : 'Run Analysis'}
            </button>
          </div>

          {/* Entity picker — only for domains that need team/match */}
          {domain.entity !== 'none' && (
            <div className={styles.entitySelector}>
              <label className={styles.entityLabel} htmlFor="entity-select">
                {domain.entity === 'team' ? 'Select Team' : 'Select Match'}
              </label>
              <select
                id="entity-select"
                className={styles.entitySelect}
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
              >
                <option value="">— pick one —</option>
                {domain.entity === 'team' &&
                  teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                {domain.entity === 'match' &&
                  matches.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.homeTeam} vs {m.awayTeam} — {m.date ? new Date(m.date).toLocaleDateString() : ''}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {/* Job list */}
          <div className={styles.jobList}>
            {jobsLoading && (
              <div className={styles.emptyState}>
                <span className={styles.emptyIcon}>◌</span>
                <p className={styles.emptyText}>Loading jobs…</p>
              </div>
            )}

            {!jobsLoading && jobs.length === 0 && (
              <div className={styles.emptyState}>
                <span className={styles.emptyIcon}>{domain.icon}</span>
                <p className={styles.emptyText}>
                  No {domain.label.toLowerCase()} jobs yet.
                  <br />Click "Run Analysis" to start one.
                </p>
              </div>
            )}

            {jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                selected={selectedJobId === job.id}
                onClick={() => setSelectedJobId(job.id)}
              />
            ))}
          </div>
        </div>

        {/* Right: detail */}
        {!displayJob ? (
          <div className={`${styles.detailPanel} ${styles.detailEmpty}`}>
            <span className={styles.detailEmptyIcon}>◎</span>
            <p className={styles.detailEmptyText}>Select a job to view the analysis</p>
          </div>
        ) : (
          <JobDetail job={displayJob} />
        )}
      </div>
    </div>
  );
}
