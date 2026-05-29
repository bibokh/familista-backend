// ── Module 2: Workload & Injury Risk Dashboard ───────────────────────────────
// Squad readiness grid + ACWR gauge + ATL/CTL/TSB visualization + injury table.

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ReferenceLine,
} from 'recharts';
import { teamsApi, workloadApi } from '@/api/endpoints';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge, RiskBadge } from '@/components/ui/Badge';
import { Stat } from '@/components/ui/Stat';
import { PageLoader } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import type { PlayerReadiness, RiskTier, Injury } from '@/api/types';
import styles from './WorkloadDashboard.module.css';

const RISK_COLOR: Record<RiskTier, string> = {
  LOW:      'var(--green)',
  MODERATE: 'var(--amber)',
  HIGH:     'var(--red)',
  CRITICAL: 'var(--red)',
};

const RISK_BG: Record<RiskTier, string> = {
  LOW:      'rgba(22,163,74,0.1)',
  MODERATE: 'rgba(245,158,11,0.1)',
  HIGH:     'rgba(239,68,68,0.1)',
  CRITICAL: 'rgba(239,68,68,0.2)',
};

function fmt1(n: number | null | undefined): string {
  return n != null ? n.toFixed(1) : '—';
}
function fmt2(n: number | null | undefined): string {
  return n != null ? n.toFixed(2) : '—';
}

export function WorkloadDashboard() {
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerReadiness | null>(null);

  const teamsQ = useQuery({
    queryKey: ['teams'],
    queryFn:  () => teamsApi.list(),
    staleTime: 300_000,
  });

  // Auto-select first team when teams load
  useEffect(() => {
    if (teamsQ.data && !selectedTeamId && teamsQ.data.data.length > 0) {
      setSelectedTeamId(teamsQ.data.data[0].id);
    }
  }, [teamsQ.data, selectedTeamId]);

  const readinessQ = useQuery({
    queryKey: ['squad-readiness', selectedTeamId],
    queryFn:  () => workloadApi.squadReadiness(selectedTeamId),
    enabled:  !!selectedTeamId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const injuriesQ = useQuery({
    queryKey: ['injuries', 'active'],
    queryFn:  () => workloadApi.listInjuries({ status: 'ACTIVE', limit: 50 }),
    staleTime: 60_000,
  });

  if (teamsQ.isLoading) return <PageLoader />;
  if (teamsQ.isError)
    return <div className="page"><ErrorState message={(teamsQ.error as Error).message} /></div>;

  const teams = teamsQ.data?.data ?? [];
  const readiness = readinessQ.data;
  const players = readiness?.players ?? [];
  const summary = readiness?.summary;

  const acwrChartData = players
    .filter((p) => p.acwr != null)
    .map((p) => ({
      name:  p.name.split(' ').slice(-1)[0],
      acwr:  Number(p.acwr!.toFixed(2)),
      risk:  p.riskTier,
    }))
    .sort((a, b) => b.acwr - a.acwr);

  const injuries = injuriesQ.data?.data ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Workload &amp; Injury Risk</h1>
          <p className="page-subtitle">ATL / CTL / TSB · ACWR · Squad readiness · Injury tracker</p>
        </div>
        <div className={styles.teamSelect}>
          <select
            className={styles.select}
            value={selectedTeamId}
            onChange={(e) => { setSelectedTeamId(e.target.value); setSelectedPlayer(null); }}
          >
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>

      {readinessQ.isLoading && <PageLoader />}
      {readinessQ.isError && (
        <ErrorState
          message={(readinessQ.error as Error).message}
          onRetry={() => readinessQ.refetch()}
        />
      )}

      {readiness && (
        <>
          {/* KPI strip */}
          <div className={`${styles.kpiStrip} grid-4`}>
            <Card padding="md"><Stat label="Available"  value={summary?.available ?? 0}  accent="green" /></Card>
            <Card padding="md"><Stat label="High Risk"  value={summary?.highRisk  ?? 0}  accent="amber" /></Card>
            <Card padding="md"><Stat label="Injured"    value={summary?.injured   ?? 0}  accent="red"   /></Card>
            <Card padding="md"><Stat label="Suspended"  value={summary?.suspended ?? 0}  accent="blue"  /></Card>
          </div>

          <div className={styles.mainGrid}>
            {/* Left: Squad readiness grid */}
            <div className={styles.leftCol}>
              <Card padding="md">
                <CardHeader
                  title="Squad readiness"
                  subtitle={`${players.length} players · ${readiness.computedAt ? new Date(readiness.computedAt).toLocaleTimeString() : ''}`}
                />
                <div className={styles.squadGrid}>
                  {players.map((p) => (
                    <button
                      key={p.playerId}
                      className={`${styles.playerCard} ${selectedPlayer?.playerId === p.playerId ? styles.playerCardActive : ''}`}
                      style={{
                        borderColor: RISK_COLOR[p.riskTier],
                        background: selectedPlayer?.playerId === p.playerId
                          ? RISK_BG[p.riskTier]
                          : undefined,
                      }}
                      onClick={() => setSelectedPlayer(
                        selectedPlayer?.playerId === p.playerId ? null : p
                      )}
                      type="button"
                    >
                      <div className={styles.playerCardAvatar} style={{ color: RISK_COLOR[p.riskTier] }}>
                        {p.name.charAt(0)}
                      </div>
                      <span className={styles.playerCardName} title={p.name}>
                        {p.name.split(' ').slice(-1)[0]}
                      </span>
                      <span className={styles.playerCardPos}>{p.position ?? '—'}</span>
                      <RiskBadge tier={p.riskTier} />
                      <span className={styles.riskScore} style={{ color: RISK_COLOR[p.riskTier] }}>
                        {p.riskScore.toFixed(0)}
                      </span>
                    </button>
                  ))}
                </div>
              </Card>
            </div>

            {/* Right: selected player detail + ACWR chart */}
            <div className={styles.rightCol}>
              {selectedPlayer ? (
                <PlayerWorkloadDetail player={selectedPlayer} />
              ) : (
                <Card padding="md">
                  <EmptyState icon="♥" title="Select a player" description="Click any player card to see their ATL, CTL, TSB and ACWR details." />
                </Card>
              )}

              {/* ACWR chart */}
              {acwrChartData.length > 0 && (
                <Card padding="md">
                  <CardHeader title="ACWR by player" subtitle="Optimal zone: 0.8–1.3" />
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={acwrChartData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--tx-3)' }} />
                      <YAxis domain={[0, 2]} tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
                      <Tooltip
                        contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border-2)', borderRadius: 8 }}
                        labelStyle={{ color: 'var(--tx)', fontWeight: 500 }}
                        itemStyle={{ color: 'var(--tx-2)' }}
                        formatter={(v: number) => [v.toFixed(2), 'ACWR']}
                      />
                      <ReferenceLine y={0.8} stroke="var(--green)"  strokeDasharray="4 2" label={{ value: '0.8', fill: 'var(--green)',  fontSize: 10 }} />
                      <ReferenceLine y={1.3} stroke="var(--amber)"  strokeDasharray="4 2" label={{ value: '1.3', fill: 'var(--amber)',  fontSize: 10 }} />
                      <ReferenceLine y={1.5} stroke="var(--red)"    strokeDasharray="4 2" label={{ value: '1.5', fill: 'var(--red)',    fontSize: 10 }} />
                      <Bar dataKey="acwr" radius={[3, 3, 0, 0]}>
                        {acwrChartData.map((entry) => (
                          <Cell key={entry.name} fill={RISK_COLOR[entry.risk as RiskTier]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              )}
            </div>
          </div>

          {/* Injury table */}
          <Card padding="none" style={{ marginTop: 'var(--gap-md)' }}>
            <div style={{ padding: 'var(--gap-md) var(--gap-md) var(--gap-sm)' }}>
              <CardHeader
                title="Active injuries"
                subtitle={`${injuries.filter(i => i.status === 'ACTIVE').length} players out`}
              />
            </div>
            {injuries.length === 0 ? (
              <EmptyState icon="✓" title="No active injuries" description="All players are fit." />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {['Player','Type','Body Part','Severity','Occurred','Expected Return','Status'].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {injuries.map((inj) => (
                      <InjuryRow key={inj.id} injury={inj} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Player workload detail ────────────────────────────────────────────────────

function PlayerWorkloadDetail({ player }: { player: PlayerReadiness }) {
  const metrics = [
    { label: 'ATL (Acute load)',  value: fmt1(player.atl),  sub: '7-day EWA', accent: 'blue' as const },
    { label: 'CTL (Chronic load)', value: fmt1(player.ctl), sub: '28-day EWA', accent: 'purple' as const },
    { label: 'TSB (Form)',        value: fmt1(player.tsb),  sub: 'CTL − ATL',  accent: player.tsb != null && player.tsb < -10 ? 'red' as const : 'green' as const },
    { label: 'ACWR',              value: fmt2(player.acwr), sub: 'ATL ÷ CTL',  accent: player.acwr != null && player.acwr > 1.3 ? 'amber' as const : 'green' as const },
  ];

  return (
    <Card padding="md">
      <div className={styles.playerDetailHeader}>
        <div>
          <h3 style={{ fontWeight: 600, color: 'var(--tx)', marginBottom: 4 }}>{player.name}</h3>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {player.position && <Badge variant="outline">{player.position}</Badge>}
            <RiskBadge tier={player.riskTier} />
            <Badge variant={player.status === 'AVAILABLE' ? 'green' : player.status === 'INJURED' ? 'red' : 'amber'}>
              {player.status}
            </Badge>
          </div>
        </div>
        <div className={styles.riskGauge}>
          <svg viewBox="0 0 80 40" width="80" height="40" aria-label={`Risk score ${player.riskScore}`}>
            <path d="M5 35 A35 35 0 0 1 75 35" fill="none" stroke="var(--border-2)" strokeWidth="6" strokeLinecap="round" />
            <path
              d="M5 35 A35 35 0 0 1 75 35"
              fill="none"
              stroke={RISK_COLOR[player.riskTier]}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${(player.riskScore / 100) * 110} 110`}
            />
            <text x="40" y="36" textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--tx)">
              {player.riskScore.toFixed(0)}
            </text>
          </svg>
          <p style={{ fontSize: '0.625rem', color: 'var(--tx-3)', textAlign: 'center', marginTop: -4 }}>Risk</p>
        </div>
      </div>

      <div className={styles.metricsGrid}>
        {metrics.map((m) => (
          <div key={m.label} className={styles.metricBox}>
            <Stat label={m.label} value={m.value} sub={m.sub} accent={m.accent} size="sm" />
          </div>
        ))}
      </div>

      <div className={styles.acwrZone}>
        <p style={{ fontSize: '0.75rem', color: 'var(--tx-3)', marginBottom: 4 }}>ACWR interpretation</p>
        {player.acwr == null ? (
          <p style={{ fontSize: '0.8125rem', color: 'var(--tx-3)' }}>Insufficient data (need ≥ 4 weeks of GPS sessions)</p>
        ) : player.acwr < 0.8 ? (
          <p style={{ fontSize: '0.8125rem', color: 'var(--amber)' }}>⚠ Undertraining zone — risk of deconditioning</p>
        ) : player.acwr <= 1.3 ? (
          <p style={{ fontSize: '0.8125rem', color: 'var(--green)' }}>✓ Optimal training zone (0.8–1.3)</p>
        ) : player.acwr <= 1.5 ? (
          <p style={{ fontSize: '0.8125rem', color: 'var(--amber)' }}>⚠ High acute load — monitor closely</p>
        ) : (
          <p style={{ fontSize: '0.8125rem', color: 'var(--red)' }}>⛔ Danger zone — injury risk elevated (ACWR &gt; 1.5)</p>
        )}
      </div>
    </Card>
  );
}

// ── Injury row ────────────────────────────────────────────────────────────────

function InjuryRow({ injury }: { injury: Injury }) {
  const sevColor: Record<string, string> = {
    MINOR: 'var(--amber)', MODERATE: 'var(--amber)', SEVERE: 'var(--red)', CAREER_THREATENING: 'var(--red)',
  };

  return (
    <tr>
      <td>{injury.playerName ?? injury.playerId.slice(0, 8)}</td>
      <td>{injury.injuryType}</td>
      <td>{injury.bodyPart}</td>
      <td>
        <span style={{ color: sevColor[injury.severity] ?? 'var(--tx-2)', fontWeight: 500 }}>
          {injury.severity}
        </span>
      </td>
      <td>{new Date(injury.dateOccurred).toLocaleDateString()}</td>
      <td>
        {injury.expectedReturn
          ? new Date(injury.expectedReturn).toLocaleDateString()
          : '—'}
      </td>
      <td>
        <Badge variant={injury.status === 'ACTIVE' ? 'red' : injury.status === 'RECOVERED' ? 'green' : 'amber'}>
          {injury.status}
        </Badge>
      </td>
    </tr>
  );
}
