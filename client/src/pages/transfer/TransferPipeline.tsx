// ── Module 3: Transfer Pipeline Board ────────────────────────────────────────
// Kanban pipeline: WATCHLIST → INTEREST → APPROACHED → NEGOTIATING → AGREED
// Right panel: target detail + scouting reports
// Bottom: expiring contracts table

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { transferApi } from '@/api/endpoints';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge, StageBadge, RecommendationBadge } from '@/components/ui/Badge';
import { PageLoader } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import type { TransferTarget, TransferStage, ContractStatus, ScoutingReport } from '@/api/types';
import styles from './TransferPipeline.module.css';

const STAGES: { key: TransferStage; label: string; color: string }[] = [
  { key: 'WATCHLIST',   label: 'Watchlist',   color: 'var(--tx-3)' },
  { key: 'INTEREST',    label: 'Interest',    color: 'var(--blue)' },
  { key: 'APPROACHED',  label: 'Approached',  color: 'var(--purple)' },
  { key: 'NEGOTIATING', label: 'Negotiating', color: 'var(--amber)' },
  { key: 'AGREED',      label: 'Agreed',      color: 'var(--green)' },
];

const PRIORITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function fmtVal(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `€${(v / 1_000).toFixed(0)}K`;
  return `€${v}`;
}

export function TransferPipeline() {
  const [selectedTarget, setSelectedTarget] = useState<TransferTarget | null>(null);
  const [activeView, setActiveView] = useState<'pipeline' | 'contracts'>('pipeline');

  const pipelineQ = useQuery({
    queryKey: ['transfer-pipeline'],
    queryFn:  () => transferApi.pipeline(),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });

  const reportsQ = useQuery({
    queryKey: ['scouting-reports'],
    queryFn:  () => transferApi.listReports({ limit: 50 }),
    staleTime: 60_000,
  });

  const contractsQ = useQuery({
    queryKey: ['expiring-contracts'],
    queryFn:  () => transferApi.expiringContracts(),
    staleTime: 120_000,
  });

  if (pipelineQ.isLoading) return <PageLoader />;
  if (pipelineQ.isError)
    return (
      <div className="page">
        <ErrorState message={(pipelineQ.error as Error).message} onRetry={() => pipelineQ.refetch()} />
      </div>
    );

  const stages = pipelineQ.data?.stages ?? {} as Record<TransferStage, TransferTarget[]>;
  const total  = pipelineQ.data?.totalCount ?? 0;
  const reports = reportsQ.data?.data ?? [];
  const contracts = contractsQ.data ?? [];

  // Reports keyed by target player name for quick lookup
  const reportsByPlayer: Record<string, ScoutingReport[]> = {};
  for (const r of reports) {
    const key = r.externalPlayerName ?? r.targetPlayerId ?? 'unknown';
    if (!reportsByPlayer[key]) reportsByPlayer[key] = [];
    reportsByPlayer[key].push(r);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Transfer Pipeline</h1>
          <p className="page-subtitle">{total} targets tracked · scouting reports · contract expiries</p>
        </div>
        <div className={styles.viewToggle}>
          <button
            className={`${styles.toggleBtn} ${activeView === 'pipeline' ? styles.toggleActive : ''}`}
            onClick={() => setActiveView('pipeline')}
            type="button"
          >
            Pipeline
          </button>
          <button
            className={`${styles.toggleBtn} ${activeView === 'contracts' ? styles.toggleActive : ''}`}
            onClick={() => setActiveView('contracts')}
            type="button"
          >
            Expiring ({contracts.length})
          </button>
        </div>
      </div>

      {activeView === 'pipeline' ? (
        <div className={styles.pipelineLayout}>
          {/* Kanban board */}
          <div className={styles.kanban}>
            {STAGES.map((stage) => {
              const targets = (stages[stage.key] ?? [])
                .slice()
                .sort((a, b) =>
                  (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9),
                );
              return (
                <div key={stage.key} className={styles.column}>
                  <div className={styles.columnHeader} style={{ '--col-color': stage.color } as React.CSSProperties}>
                    <span className={styles.columnLabel} style={{ color: stage.color }}>{stage.label}</span>
                    <span className={styles.columnCount}>{targets.length}</span>
                  </div>
                  <div className={styles.columnBody}>
                    {targets.length === 0 && (
                      <div className={styles.emptyColumn}>No targets</div>
                    )}
                    {targets.map((t) => (
                      <TargetCard
                        key={t.id}
                        target={t}
                        isSelected={selectedTarget?.id === t.id}
                        onClick={() => setSelectedTarget(
                          selectedTarget?.id === t.id ? null : t
                        )}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Detail sidebar */}
          {selectedTarget && (
            <aside className={styles.detailPanel}>
              <TargetDetail
                target={selectedTarget}
                reports={(reportsByPlayer[selectedTarget.externalPlayerName ?? selectedTarget.targetPlayerId ?? ''] ?? []) as ScoutingReport[]}
                onClose={() => setSelectedTarget(null)}
              />
            </aside>
          )}
        </div>
      ) : (
        <ContractsTable contracts={contracts} />
      )}
    </div>
  );
}

// ── Target card (Kanban) ──────────────────────────────────────────────────────

function TargetCard({
  target,
  isSelected,
  onClick,
}: {
  target: TransferTarget;
  isSelected: boolean;
  onClick: () => void;
}) {
  const priorityColor: Record<string, string> = {
    CRITICAL: 'var(--red)', HIGH: 'var(--amber)', MEDIUM: 'var(--blue)', LOW: 'var(--tx-3)',
  };

  return (
    <button
      className={`${styles.targetCard} ${isSelected ? styles.targetCardSelected : ''}`}
      onClick={onClick}
      type="button"
    >
      <div className={styles.targetCardTop}>
        <div className={styles.targetCardAvatar}>
          {(target.externalPlayerName ?? '?').charAt(0).toUpperCase()}
        </div>
        <div className={styles.targetCardInfo}>
          <span className={styles.targetName}>
            {target.externalPlayerName ?? 'Internal player'}
          </span>
          <span className={styles.targetMeta}>
            {target.position ?? '?'} · {target.externalClub ?? 'Unknown club'}
          </span>
        </div>
        <span
          className={styles.priorityDot}
          style={{ background: priorityColor[target.priority] ?? 'var(--tx-3)' }}
          title={`Priority: ${target.priority}`}
        />
      </div>
      <div className={styles.targetCardBottom}>
        <span className={styles.marketValue}>{fmtVal(target.marketValue)}</span>
        {target.scoutRating != null && (
          <span className={styles.scoutRating}>★ {target.scoutRating.toFixed(1)}</span>
        )}
        {target.age != null && (
          <span className={styles.age}>{target.age}y</span>
        )}
      </div>
    </button>
  );
}

// ── Target detail ─────────────────────────────────────────────────────────────

function TargetDetail({
  target,
  reports,
  onClose,
}: {
  target: TransferTarget;
  reports: ScoutingReport[];
  onClose: () => void;
}) {
  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <h3 className={styles.detailName}>{target.externalPlayerName ?? 'Internal player'}</h3>
        <button className={styles.closeBtn} onClick={onClose} type="button" aria-label="Close">✕</button>
      </div>

      <div className={styles.detailMeta}>
        <Badge variant="outline">{target.position ?? '—'}</Badge>
        <StageBadge stage={target.stage} />
        <Badge variant={target.priority === 'CRITICAL' ? 'red' : target.priority === 'HIGH' ? 'amber' : 'blue'}>
          {target.priority}
        </Badge>
      </div>

      <div className={styles.detailGrid}>
        {[
          ['Club',           target.externalClub ?? '—'],
          ['Age',            target.age ? `${target.age} years` : '—'],
          ['Nationality',    target.nationality ?? '—'],
          ['Market value',   fmtVal(target.marketValue)],
          ['Asking price',   fmtVal(target.askingPrice)],
          ['Scout rating',   target.scoutRating != null ? `★ ${target.scoutRating.toFixed(1)} / 10` : '—'],
        ].map(([label, value]) => (
          <div key={String(label)} className={styles.detailRow}>
            <span className={styles.detailLabel}>{label}</span>
            <span className={styles.detailValue}>{value}</span>
          </div>
        ))}
      </div>

      {target.notes && (
        <div className={styles.notesBox}>
          <p className={styles.notesLabel}>Notes</p>
          <p className={styles.notesText}>{target.notes}</p>
        </div>
      )}

      {/* Scouting reports */}
      {reports.length > 0 && (
        <div className={styles.reportsSection}>
          <p className={styles.reportsTitle}>Scouting reports ({reports.length})</p>
          {reports.map((r) => (
            <div key={r.id} className={styles.reportCard}>
              <div className={styles.reportCardTop}>
                <span className={styles.reportScore}>Overall: {r.overallScore}/10</span>
                <RecommendationBadge rec={r.recommendation} />
              </div>
              <div className={styles.reportScores}>
                {[
                  ['Tech', r.technicalScore],
                  ['Phys', r.physicalScore],
                  ['Mental', r.mentalScore],
                ].map(([label, score]) => (
                  <span key={String(label)} className={styles.reportScore2}>
                    {label}: {score != null ? Number(score).toFixed(1) : '—'}
                  </span>
                ))}
              </div>
              {r.notes && <p className={styles.reportNotes}>{r.notes}</p>}
              <p className={styles.reportDate}>{new Date(r.createdAt).toLocaleDateString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Expiring contracts table ───────────────────────────────────────────────────

function ContractsTable({ contracts }: { contracts: ContractStatus[] }) {
  if (contracts.length === 0) {
    return (
      <Card padding="lg">
        <EmptyState icon="✓" title="No expiring contracts" description="No player contracts expire in the next 6 months." />
      </Card>
    );
  }

  const sorted = [...contracts].sort(
    (a, b) => new Date(a.expiresAt ?? '9999').getTime() - new Date(b.expiresAt ?? '9999').getTime(),
  );

  return (
    <Card padding="none">
      <div style={{ padding: 'var(--gap-md) var(--gap-md) var(--gap-sm)' }}>
        <CardHeader title="Expiring contracts" subtitle="Sorted by expiry date ascending" />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className={styles.table}>
          <thead>
            <tr>
              {['Player ID','Type','Expires','Salary','Currency','Alert'].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const expiry = c.expiresAt ? new Date(c.expiresAt) : null;
              const daysLeft = expiry
                ? Math.ceil((expiry.getTime() - Date.now()) / 86_400_000)
                : null;
              return (
                <tr key={c.playerId}>
                  <td className={styles.mono}>{c.playerId.slice(0, 12)}…</td>
                  <td>{c.contractType}</td>
                  <td>{expiry ? expiry.toLocaleDateString() : '—'}</td>
                  <td>{c.salary != null ? `${c.currency} ${c.salary.toLocaleString()}` : '—'}</td>
                  <td>{c.currency}</td>
                  <td>
                    {daysLeft != null && daysLeft <= 90 ? (
                      <Badge variant="red" dot>{daysLeft}d left</Badge>
                    ) : daysLeft != null && daysLeft <= 180 ? (
                      <Badge variant="amber" dot>{daysLeft}d left</Badge>
                    ) : (
                      <Badge variant="default">OK</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
