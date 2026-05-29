// ── Module 5: Analytics Center ────────────────────────────────────────────────
// Club KPIs, win/loss trend, GPS load trend, top performers, high-risk players.

import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, LineChart, Line,
} from 'recharts';
import { analyticsApi } from '@/api/endpoints';
import { Card, CardHeader } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { Badge } from '@/components/ui/Badge';
import { PageLoader } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import type { PerformanceTrendPoint, GpsLoadPoint, TopPerformer } from '@/api/types';
import styles from './AnalyticsCenter.module.css';

export function AnalyticsCenter() {
  const analyticsQ = useQuery({
    queryKey: ['club-analytics'],
    queryFn:  () => analyticsApi.clubOverview(),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  if (analyticsQ.isLoading) return <PageLoader />;
  if (analyticsQ.isError)
    return (
      <div className="page">
        <ErrorState
          message={(analyticsQ.error as Error).message}
          onRetry={() => analyticsQ.refetch()}
        />
      </div>
    );

  const data = analyticsQ.data!;
  const winRate = data.winRate != null ? `${(data.winRate * 100).toFixed(1)}%` : '—';

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Analytics Center</h1>
          <p className="page-subtitle">Club overview · Performance trends · GPS workload</p>
        </div>
        <Badge variant="green" dot>Live</Badge>
      </div>

      {/* KPI strip */}
      <div className={`${styles.kpiStrip} grid-4`}>
        <Card padding="md">
          <Stat label="Squad size"    value={data.playerCount}          accent="blue" />
        </Card>
        <Card padding="md">
          <Stat label="Win rate"      value={winRate}                   accent="green" />
        </Card>
        <Card padding="md">
          <Stat
            label="Injured"
            value={data.injuredCount}
            accent={data.injuredCount > 3 ? 'red' : 'amber'}
          />
        </Card>
        <Card padding="md">
          <Stat
            label="High risk"
            value={data.highRiskPlayerCount}
            accent={data.highRiskPlayerCount > 3 ? 'amber' : 'default'}
          />
        </Card>
      </div>

      {/* Charts row 1: performance trend + GPS load */}
      <div className={styles.chartsRow}>
        <Card padding="md" className={styles.chartCard}>
          <CardHeader
            title="Results trend"
            subtitle={`Last ${data.performanceTrend.length} periods`}
          />
          {data.performanceTrend.length === 0 ? (
            <EmptyState icon="○" title="No match data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.performanceTrend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
                <Tooltip
                  contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border-2)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--tx)', fontWeight: 500 }}
                  itemStyle={{ color: 'var(--tx-2)' }}
                />
                <Legend iconType="circle" />
                <Bar dataKey="wins"   name="Wins"   fill="var(--green)"  stackId="a" radius={[0,0,0,0]} />
                <Bar dataKey="draws"  name="Draws"  fill="var(--amber)"  stackId="a" />
                <Bar dataKey="losses" name="Losses" fill="var(--red)"    stackId="a" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card padding="md" className={styles.chartCard}>
          <CardHeader title="Goals for / against" subtitle="By period" />
          {data.performanceTrend.length === 0 ? (
            <EmptyState icon="○" title="No match data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data.performanceTrend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
                <Tooltip
                  contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border-2)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--tx)', fontWeight: 500 }}
                  itemStyle={{ color: 'var(--tx-2)' }}
                />
                <Legend iconType="circle" />
                <Line dataKey="goalsFor"     name="Goals For"     stroke="var(--green)"  strokeWidth={2} dot={{ r: 3 }} />
                <Line dataKey="goalsAgainst" name="Goals Against" stroke="var(--red)"    strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* GPS Load trend */}
      <Card padding="md" className={styles.gpsCard}>
        <CardHeader
          title="GPS training load"
          subtitle="Average distance (km) and top speed across sessions"
        />
        {data.gpsLoadTrend.length === 0 ? (
          <EmptyState icon="○" title="No GPS data yet" description="GPS sessions will appear here once uploaded." />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data.gpsLoadTrend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="gradDist" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="var(--blue)"  stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--blue)"  stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="gradSpeed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="var(--green)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--green)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--tx-3)' }}
                tickFormatter={(d: string) => d.slice(5)} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
              <Tooltip
                contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border-2)', borderRadius: 8 }}
                labelStyle={{ color: 'var(--tx)', fontWeight: 500 }}
                itemStyle={{ color: 'var(--tx-2)' }}
              />
              <Legend iconType="circle" />
              <Area dataKey="avgDistance" name="Avg Distance (km)" stroke="var(--blue)"  fill="url(#gradDist)"  strokeWidth={2} />
              <Area dataKey="avgTopSpeed" name="Avg Top Speed (km/h)" stroke="var(--green)" fill="url(#gradSpeed)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* Bottom row: top performers + high-risk */}
      <div className={styles.bottomRow}>
        <Card padding="none">
          <div style={{ padding: 'var(--gap-md) var(--gap-md) var(--gap-sm)' }}>
            <CardHeader title="Top performers" subtitle="Current season" />
          </div>
          {data.topPerformers.length === 0 ? (
            <EmptyState icon="◎" title="No data" description="Stats will appear once matches are played." />
          ) : (
            <TopPerformersTable performers={data.topPerformers} />
          )}
        </Card>

        <Card padding="md">
          <CardHeader title="Injury & risk snapshot" />
          <InjurySnapshot
            injuredCount={data.injuredCount}
            highRiskCount={data.highRiskPlayerCount}
            total={data.playerCount}
          />
        </Card>
      </div>
    </div>
  );
}

// ── Top performers table ──────────────────────────────────────────────────────

function TopPerformersTable({ performers }: { performers: TopPerformer[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Player</th>
            <th>Pos</th>
            <th>G</th>
            <th>A</th>
            <th>AI Rtg</th>
          </tr>
        </thead>
        <tbody>
          {performers.slice(0, 10).map((p, i) => (
            <tr key={p.playerId}>
              <td className={styles.rankCell}>
                <span className={styles.rank}>{i + 1}</span>
                {p.name}
              </td>
              <td style={{ textAlign: 'right' }}>
                {p.position ? (
                  <Badge variant="outline">{p.position}</Badge>
                ) : '—'}
              </td>
              <td className={styles.numCell}>{p.goals}</td>
              <td className={styles.numCell}>{p.assists}</td>
              <td className={`${styles.numCell} ${p.ratingAI && p.ratingAI >= 7 ? styles.hiRating : ''}`}>
                {p.ratingAI != null ? p.ratingAI.toFixed(1) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Injury snapshot ───────────────────────────────────────────────────────────

function InjurySnapshot({
  injuredCount,
  highRiskCount,
  total,
}: {
  injuredCount: number;
  highRiskCount: number;
  total: number;
}) {
  const available = total - injuredCount;
  const pct = total > 0 ? Math.round((available / total) * 100) : 0;

  const segments = [
    { label: 'Available',  count: available,      color: 'var(--green)' },
    { label: 'High risk',  count: highRiskCount,   color: 'var(--amber)' },
    { label: 'Injured',    count: injuredCount,    color: 'var(--red)'   },
  ];

  return (
    <div className={styles.snapshotWrap}>
      {/* Donut */}
      <div className={styles.donutWrap}>
        <svg viewBox="0 0 80 80" width="80" height="80">
          <circle cx="40" cy="40" r="32" fill="none" stroke="var(--border-2)" strokeWidth="10" />
          <circle
            cx="40" cy="40" r="32"
            fill="none"
            stroke="var(--green)"
            strokeWidth="10"
            strokeDasharray={`${pct * 2.01} ${201 - pct * 2.01}`}
            strokeDashoffset="50"
            strokeLinecap="round"
          />
          <text x="40" y="43" textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--tx)">
            {pct}%
          </text>
        </svg>
        <p className={styles.donutLabel}>Available</p>
      </div>

      {/* Legend */}
      <div className={styles.snapshotLegend}>
        {segments.map((s) => (
          <div key={s.label} className={styles.snapshotRow}>
            <span className={styles.snapshotDot} style={{ background: s.color }} />
            <span className={styles.snapshotLabel}>{s.label}</span>
            <span className={styles.snapshotCount}>{s.count}</span>
          </div>
        ))}
      </div>

      <div className={styles.snapshotBar}>
        {total > 0 && segments.filter(s => s.count > 0).map((s) => (
          <div
            key={s.label}
            className={styles.snapshotBarSegment}
            style={{
              width: `${(s.count / total) * 100}%`,
              background: s.color,
            }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
    </div>
  );
}
