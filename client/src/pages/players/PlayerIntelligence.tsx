// ── Module 1: Player Intelligence Center ─────────────────────────────────────
// Left panel: searchable player list.
// Right panel: selected player profile with tabs for stats, career, match log.

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid, RadarChart, Radar, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis,
} from 'recharts';
import { playersApi, statsApi } from '@/api/endpoints';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Stat, StatPill } from '@/components/ui/Stat';
import { PageLoader, Spinner } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import type { Player, PlayerSeasonStats, PlayerMatchStats, PlayerProfile } from '@/api/types';
import styles from './PlayerIntelligence.module.css';

type Tab = 'stats' | 'career' | 'matches';

const POSITION_COLOR: Record<string, string> = {
  GK: 'var(--amber)', CB: 'var(--blue)', LB: 'var(--blue)', RB: 'var(--blue)',
  DM: 'var(--purple)', CM: 'var(--purple)', AM: 'var(--cyan)',
  LW: 'var(--green)', RW: 'var(--green)', CF: 'var(--red)', ST: 'var(--red)',
};

function posColor(pos: string | null): string {
  if (!pos) return 'var(--tx-3)';
  return POSITION_COLOR[pos] ?? 'var(--tx-3)';
}

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n === null || n === undefined) return '—';
  return n.toFixed(decimals);
}

export function PlayerIntelligence() {
  const [search, setSearch]           = useState('');
  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [activeTab, setActiveTab]     = useState<Tab>('stats');

  // ── Player list ──────────────────────────────────────────────────────────
  const playersQ = useQuery({
    queryKey: ['players', 'all'],
    queryFn:  () => playersApi.list({ limit: 200 }),
    staleTime: 60_000,
  });

  // ── Player profile ───────────────────────────────────────────────────────
  const profileQ = useQuery({
    queryKey: ['player-profile', selectedId],
    queryFn:  () => statsApi.playerProfile(selectedId!),
    enabled:  !!selectedId,
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const all = playersQ.data?.data ?? [];
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.position ?? '').toLowerCase().includes(q) ||
        (p.nationality ?? '').toLowerCase().includes(q),
    );
  }, [playersQ.data, search]);

  if (playersQ.isLoading) return <PageLoader />;
  if (playersQ.isError)
    return (
      <div className="page">
        <ErrorState message={(playersQ.error as Error).message} onRetry={() => playersQ.refetch()} />
      </div>
    );

  const profile = profileQ.data;
  const selected = filtered.find((p) => p.id === selectedId) ??
                   (playersQ.data?.data ?? []).find((p) => p.id === selectedId);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Player Intelligence Center</h1>
          <p className="page-subtitle">
            {playersQ.data?.meta.total ?? 0} players · select to view detailed analytics
          </p>
        </div>
      </div>

      <div className={styles.layout}>
        {/* ── Left: player list ── */}
        <aside className={styles.listPanel}>
          <div className={styles.searchWrap}>
            <input
              type="search"
              className={styles.searchInput}
              placeholder="Search name, position…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className={styles.playerList}>
            {filtered.length === 0 && (
              <EmptyState icon="○" title="No players found" />
            )}
            {filtered.map((p) => (
              <PlayerListRow
                key={p.id}
                player={p}
                isSelected={p.id === selectedId}
                onClick={() => {
                  setSelectedId(p.id);
                  setActiveTab('stats');
                }}
              />
            ))}
          </div>
        </aside>

        {/* ── Right: detail panel ── */}
        <main className={styles.detailPanel}>
          {!selectedId ? (
            <div className={styles.emptyDetail}>
              <EmptyState
                icon="◎"
                title="Select a player"
                description="Choose a player from the list to view their performance analytics, career history, and match data."
              />
            </div>
          ) : profileQ.isLoading ? (
            <div className={styles.loadingDetail}>
              <Spinner size="lg" />
            </div>
          ) : profileQ.isError ? (
            <ErrorState
              message={(profileQ.error as Error).message}
              onRetry={() => profileQ.refetch()}
            />
          ) : profile ? (
            <PlayerDetail
              player={selected ?? profile.player}
              profile={profile}
              activeTab={activeTab}
              onTabChange={setActiveTab}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}

// ── Player list row ──────────────────────────────────────────────────────────

function PlayerListRow({
  player,
  isSelected,
  onClick,
}: {
  player: Player;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`${styles.playerRow} ${isSelected ? styles.playerRowSelected : ''}`}
      onClick={onClick}
      type="button"
    >
      <div className={styles.playerAvatar} style={{ color: posColor(player.position) }}>
        {player.name.charAt(0).toUpperCase()}
      </div>
      <div className={styles.playerRowInfo}>
        <span className={styles.playerRowName}>{player.name}</span>
        <span className={styles.playerRowMeta}>
          {player.position ?? 'Unknown'} · {player.nationality ?? ''}
        </span>
      </div>
      {player.number != null && (
        <span className={styles.playerNumber}>#{player.number}</span>
      )}
    </button>
  );
}

// ── Player detail ─────────────────────────────────────────────────────────────

function PlayerDetail({
  player,
  profile,
  activeTab,
  onTabChange,
}: {
  player: Player;
  profile: PlayerProfile;
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
}) {
  return (
    <div className={styles.detail}>
      {/* Header */}
      <div className={styles.playerHeader}>
        <div className={styles.playerHeaderAvatar} style={{ borderColor: posColor(player.position) }}>
          {player.name.charAt(0).toUpperCase()}
        </div>
        <div className={styles.playerHeaderInfo}>
          <h2 className={styles.playerName}>{player.name}</h2>
          <div className={styles.playerMeta}>
            <Badge variant="outline">{player.position ?? 'Unknown'}</Badge>
            {player.nationality && <span className={styles.metaChip}>{player.nationality}</span>}
            {player.number != null && <span className={styles.metaChip}>#{player.number}</span>}
            {player.height != null && <span className={styles.metaChip}>{player.height} cm</span>}
            {player.foot && <span className={styles.metaChip}>{player.foot} foot</span>}
          </div>
        </div>
        <div className={styles.careerKpis}>
          <StatPill label="Matches" value={profile.careerMatches} />
          <StatPill label="Goals"   value={profile.careerGoals} />
          <StatPill label="Assists" value={profile.careerAssists} />
        </div>
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {(['stats', 'career', 'matches'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`${styles.tab} ${activeTab === t ? styles.tabActive : ''}`}
            onClick={() => onTabChange(t)}
            type="button"
          >
            {{ stats: 'Season Stats', career: 'Career History', matches: 'Match Log' }[t]}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={styles.tabContent}>
        {activeTab === 'stats'   && <SeasonStatsTab  season={profile.currentSeason} />}
        {activeTab === 'career'  && <CareerTab seasons={profile.allSeasons} />}
        {activeTab === 'matches' && <MatchLogTab matches={profile.recentMatches} />}
      </div>
    </div>
  );
}

// ── Season stats tab ──────────────────────────────────────────────────────────

function SeasonStatsTab({ season }: { season: PlayerSeasonStats | null }) {
  if (!season) return <EmptyState icon="○" title="No season data" description="Stats will appear once matches are played." />;

  const attackingData = [
    { stat: 'xG', value: Number(fmt(season.xGoals, 2)) },
    { stat: 'xA', value: Number(fmt(season.xAssists, 2)) },
    { stat: 'G/90', value: Number(fmt(season.goalsPerNinety, 2)) },
    { stat: 'A/90', value: Number(fmt(season.assistsPerNinety, 2)) },
    { stat: 'xG/90', value: Number(fmt(season.xGoalsPerNinety, 2)) },
    { stat: 'AI Rtg', value: Number(fmt(season.avgRatingAI, 1)) },
  ];

  const radarData = [
    { subject: 'Attacking', A: (season.goals / Math.max(season.matchesPlayed, 1)) * 10 },
    { subject: 'Creativity', A: (season.xAssists ?? 0) * 5 },
    { subject: 'Fitness',    A: ((season.avgDistanceCovered ?? 0) / 12) * 10 },
    { subject: 'Speed',      A: ((season.avgTopSpeed ?? 0) / 35) * 10 },
    { subject: 'Discipline', A: Math.max(0, 10 - (season.yellowCards * 2 + season.redCards * 5)) },
    { subject: 'Minutes',    A: (season.minutesPlayed / (season.matchesPlayed * 90)) * 10 },
  ];

  return (
    <div className={styles.statsTab}>
      {/* KPI strip */}
      <div className={`${styles.kpiStrip} grid-4`}>
        <Card padding="md"><Stat label="Matches" value={season.matchesPlayed} accent="blue" /></Card>
        <Card padding="md"><Stat label="Goals"   value={season.goals}         accent="green" /></Card>
        <Card padding="md"><Stat label="Assists" value={season.assists}       accent="cyan" /></Card>
        <Card padding="md">
          <Stat label="AI Rating" value={fmt(season.avgRatingAI, 1)} accent="purple" />
        </Card>
      </div>

      <div className={styles.chartsRow}>
        {/* Per-90 bar */}
        <Card padding="md" className={styles.chartCard}>
          <CardHeader title="Per-90 & xG metrics" subtitle={season.seasonLabel} />
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={attackingData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="stat" tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
              <Tooltip
                contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border-2)', borderRadius: 8 }}
                labelStyle={{ color: 'var(--tx)', fontWeight: 500 }}
                itemStyle={{ color: 'var(--tx-2)' }}
              />
              <Bar dataKey="value" fill="var(--green)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Radar */}
        <Card padding="md" className={styles.chartCard}>
          <CardHeader title="Performance profile" subtitle="Relative scores (0–10)" />
          <ResponsiveContainer width="100%" height={200}>
            <RadarChart data={radarData} margin={{ top: 4, right: 16, left: 16, bottom: 4 }}>
              <PolarGrid stroke="var(--border)" />
              <PolarAngleAxis dataKey="subject" tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
              <PolarRadiusAxis domain={[0, 10]} tick={false} axisLine={false} />
              <Radar dataKey="A" stroke="var(--green)" fill="var(--green)" fillOpacity={0.25} strokeWidth={2} />
            </RadarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Full stat grid */}
      <Card padding="md">
        <CardHeader title="Full season stats" />
        <div className={styles.statGrid}>
          {[
            ['Season',          season.seasonLabel],
            ['Minutes played',  season.minutesPlayed],
            ['Goals',           season.goals],
            ['Assists',         season.assists],
            ['xGoals',          fmt(season.xGoals, 2)],
            ['xAssists',        fmt(season.xAssists, 2)],
            ['Goals / 90',      fmt(season.goalsPerNinety, 2)],
            ['Assists / 90',    fmt(season.assistsPerNinety, 2)],
            ['xG / 90',         fmt(season.xGoalsPerNinety, 2)],
            ['Yellow cards',    season.yellowCards],
            ['Red cards',       season.redCards],
            ['Avg AI rating',   fmt(season.avgRatingAI, 2)],
            ['Avg distance (km)', fmt(season.avgDistanceCovered, 2)],
            ['Avg top speed (km/h)', fmt(season.avgTopSpeed, 1)],
          ].map(([label, value]) => (
            <div key={String(label)} className={styles.statRow}>
              <span className={styles.statRowLabel}>{label}</span>
              <span className={styles.statRowValue}>{value ?? '—'}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ── Career history tab ────────────────────────────────────────────────────────

function CareerTab({ seasons }: { seasons: PlayerSeasonStats[] }) {
  if (!seasons.length) return <EmptyState icon="○" title="No career data" />;

  const chartData = seasons.map((s) => ({
    season:  s.seasonLabel,
    goals:   s.goals,
    assists: s.assists,
    xG:      parseFloat(fmt(s.xGoals, 2)),
    minutes: Math.round(s.minutesPlayed / 90),
  }));

  return (
    <div className={styles.careerTab}>
      <Card padding="md">
        <CardHeader title="Goals & Assists by season" />
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="season" tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
            <YAxis tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
            <Tooltip
              contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border-2)', borderRadius: 8 }}
              labelStyle={{ color: 'var(--tx)', fontWeight: 500 }}
              itemStyle={{ color: 'var(--tx-2)' }}
            />
            <Legend iconType="circle" />
            <Bar dataKey="goals"   name="Goals"   fill="var(--green)"  radius={[3, 3, 0, 0]} />
            <Bar dataKey="assists" name="Assists" fill="var(--cyan)"   radius={[3, 3, 0, 0]} />
            <Bar dataKey="xG"      name="xG"      fill="var(--purple)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card padding="md" style={{ marginTop: 'var(--gap-md)' }}>
        <CardHeader title="Minutes played by season" />
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="season" tick={{ fontSize: 11, fill: 'var(--tx-3)' }} />
            <YAxis tick={{ fontSize: 11, fill: 'var(--tx-3)' }} unit="×90" />
            <Tooltip
              contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border-2)', borderRadius: 8 }}
              labelStyle={{ color: 'var(--tx)', fontWeight: 500 }}
              itemStyle={{ color: 'var(--tx-2)' }}
            />
            <Line dataKey="minutes" name="90-min equivalents" stroke="var(--amber)" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Season table */}
      <Card padding="none" style={{ marginTop: 'var(--gap-md)' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className={styles.table}>
            <thead>
              <tr>
                {['Season','MP','Min','G','A','xG','xA','G/90','Rat'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {seasons.map((s) => (
                <tr key={s.id}>
                  <td>{s.seasonLabel}</td>
                  <td>{s.matchesPlayed}</td>
                  <td>{s.minutesPlayed}</td>
                  <td className={styles.highlight}>{s.goals}</td>
                  <td className={styles.highlight}>{s.assists}</td>
                  <td>{fmt(s.xGoals, 2)}</td>
                  <td>{fmt(s.xAssists, 2)}</td>
                  <td>{fmt(s.goalsPerNinety, 2)}</td>
                  <td>{fmt(s.avgRatingAI, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── Match log tab ─────────────────────────────────────────────────────────────

function MatchLogTab({ matches }: { matches: PlayerMatchStats[] }) {
  if (!matches.length) return <EmptyState icon="○" title="No recent matches" description="Stats appear after matches are played and imported." />;

  return (
    <Card padding="none">
      <div style={{ overflowX: 'auto' }}>
        <table className={styles.table}>
          <thead>
            <tr>
              {['Min','G','A','Shots','SoT','xG','Passes','Pass%','Tackles','Dist','Spd','Rat'].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matches.map((m) => (
              <tr key={m.id}>
                <td>{m.minutesPlayed}</td>
                <td className={styles.highlight}>{m.goals}</td>
                <td className={styles.highlight}>{m.assists}</td>
                <td>{m.shots}</td>
                <td>{m.shotsOnTarget}</td>
                <td>{fmt(m.xGoals, 2)}</td>
                <td>{m.passes}</td>
                <td>{m.passAccuracy != null ? `${m.passAccuracy.toFixed(0)}%` : '—'}</td>
                <td>{m.tackles}</td>
                <td>{fmt(m.distanceCovered, 1)}</td>
                <td>{fmt(m.topSpeed, 1)}</td>
                <td className={m.ratingAI && m.ratingAI >= 7 ? styles.highlight : ''}>
                  {fmt(m.ratingAI, 1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
