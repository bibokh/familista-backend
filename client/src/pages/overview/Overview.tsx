// ── Overview / Dashboard ──────────────────────────────────────────────────────
// Quick-access landing page with links to each module.

import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Card } from '@/components/ui/Card';
import styles from './Overview.module.css';

const MODULES = [
  {
    path: '/app/players',
    icon: '◎',
    title: 'Player Intelligence',
    description: 'Season stats, xG, per-90 metrics, career history, AI ratings',
    color: 'var(--blue)',
  },
  {
    path: '/app/workload',
    icon: '♥',
    title: 'Workload & Injury Risk',
    description: 'ATL / CTL / TSB loads, ACWR gauge, squad readiness, injury tracker',
    color: 'var(--red)',
  },
  {
    path: '/app/transfer',
    icon: '⟺',
    title: 'Transfer Pipeline',
    description: 'Kanban board, scouting reports, market values, contract expiries',
    color: 'var(--purple)',
  },
  {
    path: '/app/competition',
    icon: '⊞',
    title: 'Competition Center',
    description: 'League standings, fixture calendar, form guide, results',
    color: 'var(--amber)',
  },
  {
    path: '/app/analytics',
    icon: '◈',
    title: 'Analytics Center',
    description: 'Club KPIs, results trend, GPS load, top performers',
    color: 'var(--green)',
  },
] as const;

export function Overview() {
  const { user } = useAuth();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="page">
      <div className={styles.hero}>
        <div className={styles.heroText}>
          <h1 className={styles.greeting}>{greeting}, {user?.name?.split(' ')[0] ?? 'Coach'}</h1>
          <p className={styles.heroSub}>
            {user?.clubName ? `${user.clubName} — ` : ''}Football Intelligence Platform
          </p>
        </div>
        <div className={styles.heroBadge}>Phase R</div>
      </div>

      <div className={styles.modulesGrid}>
        {MODULES.map((mod) => (
          <Link key={mod.path} to={mod.path} className={styles.moduleLink}>
            <Card className={styles.moduleCard}>
              <div className={styles.moduleIcon} style={{ color: mod.color, borderColor: mod.color }}>
                {mod.icon}
              </div>
              <div className={styles.moduleInfo}>
                <h3 className={styles.moduleTitle}>{mod.title}</h3>
                <p className={styles.moduleDesc}>{mod.description}</p>
              </div>
              <span className={styles.moduleArrow}>→</span>
            </Card>
          </Link>
        ))}
      </div>

      <div className={styles.statusRow}>
        <div className={styles.statusChip}>
          <span className={styles.statusDot} />
          <span>API connected</span>
        </div>
        <div className={styles.statusChip}>
          <span className={styles.statusDotAmber} />
          <span>Real data mode</span>
        </div>
      </div>
    </div>
  );
}
