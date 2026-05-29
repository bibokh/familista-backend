// ── Module 4: Competition Center ─────────────────────────────────────────────
// Competition selector, league table, fixture calendar, form guide.

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { competitionApi } from '@/api/endpoints';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge, FormBadge } from '@/components/ui/Badge';
import { PageLoader } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import type { Competition, StandingRow, Fixture } from '@/api/types';
import styles from './CompetitionCenter.module.css';

type View = 'standings' | 'fixtures';

export function CompetitionCenter() {
  const [selectedId, setSelectedId] = useState<string>('');
  const [view, setView] = useState<View>('standings');
  const [matchdayFilter, setMatchdayFilter] = useState<string>('all');

  const competitionsQ = useQuery({
    queryKey: ['competitions'],
    queryFn:  () => competitionApi.list(),
    staleTime: 300_000,
  });

  // Auto-select first competition when they load
  useEffect(() => {
    if (competitionsQ.data && !selectedId && competitionsQ.data.data.length > 0) {
      setSelectedId(competitionsQ.data.data[0].id);
    }
  }, [competitionsQ.data, selectedId]);

  const standingsQ = useQuery({
    queryKey: ['standings', selectedId],
    queryFn:  () => competitionApi.standings(selectedId),
    enabled:  !!selectedId,
    staleTime: 60_000,
  });

  const fixturesQ = useQuery({
    queryKey: ['fixtures', selectedId],
    queryFn:  () => competitionApi.fixtures(selectedId),
    enabled:  !!selectedId,
    staleTime: 60_000,
  });

  if (competitionsQ.isLoading) return <PageLoader />;
  if (competitionsQ.isError)
    return (
      <div className="page">
        <ErrorState message={(competitionsQ.error as Error).message} onRetry={() => competitionsQ.refetch()} />
      </div>
    );

  const competitions = competitionsQ.data?.data ?? [];
  const selectedComp = competitions.find((c) => c.id === selectedId);
  const standings = standingsQ.data?.standings ?? [];
  const fixtures  = fixturesQ.data?.data ?? [];

  const matchdays = useMemo(() => {
    const days = [...new Set(fixtures.map((f) => f.matchday))].sort((a, b) => a - b);
    return days;
  }, [fixtures]);

  const filteredFixtures = useMemo(() => {
    if (matchdayFilter === 'all') return fixtures;
    return fixtures.filter((f) => String(f.matchday) === matchdayFilter);
  }, [fixtures, matchdayFilter]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Competition Center</h1>
          <p className="page-subtitle">
            {selectedComp
              ? `${selectedComp.name} · ${selectedComp.season} · ${selectedComp.type}`
              : 'Select a competition'}
          </p>
        </div>
        <div className={styles.controls}>
          {/* Competition selector */}
          <select
            className={styles.select}
            value={selectedId}
            onChange={(e) => { setSelectedId(e.target.value); setMatchdayFilter('all'); }}
          >
            {competitions.length === 0 && <option value="">No competitions</option>}
            {competitions.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.season})</option>
            ))}
          </select>

          {/* View toggle */}
          <div className={styles.viewToggle}>
            <button
              className={`${styles.toggleBtn} ${view === 'standings' ? styles.toggleActive : ''}`}
              onClick={() => setView('standings')}
              type="button"
            >
              Standings
            </button>
            <button
              className={`${styles.toggleBtn} ${view === 'fixtures' ? styles.toggleActive : ''}`}
              onClick={() => setView('fixtures')}
              type="button"
            >
              Fixtures
            </button>
          </div>
        </div>
      </div>

      {!selectedId ? (
        <Card padding="lg">
          <EmptyState icon="⊞" title="No competitions" description="Create a competition first to see standings and fixtures." />
        </Card>
      ) : (
        <>
          {view === 'standings' ? (
            <StandingsTable standings={standings} isLoading={standingsQ.isLoading} error={standingsQ.error as Error | null} />
          ) : (
            <FixturesView
              fixtures={filteredFixtures}
              matchdays={matchdays}
              selectedMatchday={matchdayFilter}
              onMatchdayChange={setMatchdayFilter}
              isLoading={fixturesQ.isLoading}
              error={fixturesQ.error as Error | null}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Standings table ───────────────────────────────────────────────────────────

function StandingsTable({
  standings,
  isLoading,
  error,
}: {
  standings: StandingRow[];
  isLoading: boolean;
  error: Error | null;
}) {
  if (isLoading) return <PageLoader />;
  if (error)     return <ErrorState message={error.message} />;
  if (!standings.length)
    return (
      <Card padding="lg">
        <EmptyState icon="⊞" title="No standings" description="Standings will populate once fixtures have been played and results recorded." />
      </Card>
    );

  const maxPoints = Math.max(...standings.map((s) => s.points), 1);

  return (
    <Card padding="none">
      <div style={{ padding: 'var(--gap-md) var(--gap-md) var(--gap-sm)' }}>
        <CardHeader title="League standings" subtitle={`${standings.length} teams`} />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.posCol}>#</th>
              <th style={{ textAlign: 'left' }}>Team</th>
              <th>P</th>
              <th>W</th>
              <th>D</th>
              <th>L</th>
              <th>GF</th>
              <th>GA</th>
              <th>GD</th>
              <th>Pts</th>
              <th>Form</th>
              <th className={styles.ptBarCol}></th>
            </tr>
          </thead>
          <tbody>
            {standings.map((row, idx) => {
              const isTop3  = idx < 3;
              const isBot3  = idx >= standings.length - 3;
              return (
                <tr key={row.teamId} className={isTop3 ? styles.rowPromotion : isBot3 ? styles.rowRelegation : ''}>
                  <td className={styles.posCell}>
                    <span className={`${styles.pos} ${isTop3 ? styles.posTop : isBot3 ? styles.posBotStyle : ''}`}>
                      {row.position}
                    </span>
                  </td>
                  <td className={styles.teamCell}>{row.teamName}</td>
                  <td>{row.played}</td>
                  <td className={styles.won}>{row.won}</td>
                  <td>{row.drawn}</td>
                  <td className={styles.lost}>{row.lost}</td>
                  <td>{row.goalsFor}</td>
                  <td>{row.goalsAgainst}</td>
                  <td className={row.goalDifference > 0 ? styles.gdPos : row.goalDifference < 0 ? styles.gdNeg : ''}>
                    {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
                  </td>
                  <td className={styles.ptsCell}>{row.points}</td>
                  <td>
                    <div className={styles.form}>
                      {(row.form ?? []).slice(-5).map((r, i) => (
                        <FormBadge key={i} result={r} />
                      ))}
                    </div>
                  </td>
                  <td className={styles.ptBarCol}>
                    <div className={styles.ptBar}>
                      <div
                        className={styles.ptBarFill}
                        style={{ width: `${(row.points / maxPoints) * 100}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className={styles.legend}>
        <span className={styles.legendPromotion}>— Promotion zone</span>
        <span className={styles.legendRelegation}>— Relegation zone</span>
      </div>
    </Card>
  );
}

// ── Fixtures view ─────────────────────────────────────────────────────────────

function FixturesView({
  fixtures,
  matchdays,
  selectedMatchday,
  onMatchdayChange,
  isLoading,
  error,
}: {
  fixtures: Fixture[];
  matchdays: number[];
  selectedMatchday: string;
  onMatchdayChange: (v: string) => void;
  isLoading: boolean;
  error: Error | null;
}) {
  if (isLoading) return <PageLoader />;
  if (error)     return <ErrorState message={error.message} />;

  return (
    <div className={styles.fixturesLayout}>
      {/* Matchday filter */}
      <div className={styles.matchdayFilter}>
        <button
          className={`${styles.matchdayBtn} ${selectedMatchday === 'all' ? styles.matchdayActive : ''}`}
          onClick={() => onMatchdayChange('all')}
          type="button"
        >
          All
        </button>
        {matchdays.map((md) => (
          <button
            key={md}
            className={`${styles.matchdayBtn} ${selectedMatchday === String(md) ? styles.matchdayActive : ''}`}
            onClick={() => onMatchdayChange(String(md))}
            type="button"
          >
            MD{md}
          </button>
        ))}
      </div>

      {fixtures.length === 0 ? (
        <Card padding="lg">
          <EmptyState icon="○" title="No fixtures" description="Generate fixtures using the round-robin generator or add them manually." />
        </Card>
      ) : (
        <div className={styles.fixturesList}>
          {fixtures.map((f) => (
            <FixtureCard key={f.id} fixture={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function FixtureCard({ fixture }: { fixture: Fixture }) {
  const isPlayed = fixture.status === 'PLAYED' || fixture.status === 'COMPLETED';
  const isCancelled = fixture.status === 'CANCELLED';
  const date = new Date(fixture.scheduledAt);

  return (
    <Card
      padding="md"
      className={`${styles.fixtureCard} ${isCancelled ? styles.fixtureCancelled : ''}`}
    >
      <div className={styles.fixtureHeader}>
        <Badge variant="outline">MD {fixture.matchday}</Badge>
        <span className={styles.fixtureDate}>
          {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        {fixture.venue && <span className={styles.fixtureVenue}>{fixture.venue}</span>}
        <Badge
          variant={isPlayed ? 'green' : isCancelled ? 'red' : 'outline'}
        >
          {fixture.status}
        </Badge>
      </div>

      <div className={styles.fixtureMatch}>
        <span className={styles.fixtureName}>{fixture.homeTeamName}</span>

        <div className={styles.fixtureScore}>
          {isPlayed ? (
            <>
              <span className={styles.scoreNum}>{fixture.homeScore ?? 0}</span>
              <span className={styles.scoreDivider}>–</span>
              <span className={styles.scoreNum}>{fixture.awayScore ?? 0}</span>
            </>
          ) : (
            <span className={styles.scoreVs}>vs</span>
          )}
        </div>

        <span className={`${styles.fixtureName} ${styles.fixtureNameRight}`}>
          {fixture.awayTeamName}
        </span>
      </div>
    </Card>
  );
}
