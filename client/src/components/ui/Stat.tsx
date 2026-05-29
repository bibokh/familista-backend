import type { ReactNode } from 'react';
import styles from './Stat.module.css';

interface StatProps {
  label: string;
  value: string | number | null | undefined;
  sub?: string;
  trend?: 'up' | 'down' | 'flat';
  trendValue?: string;
  icon?: ReactNode;
  accent?: 'green' | 'amber' | 'red' | 'blue' | 'purple' | 'cyan' | 'default';
  size?: 'sm' | 'md' | 'lg';
}

const TREND_ICONS = {
  up:   '↑',
  down: '↓',
  flat: '→',
};

export function Stat({
  label,
  value,
  sub,
  trend,
  trendValue,
  icon,
  accent = 'default',
  size = 'md',
}: StatProps) {
  const displayValue = value === null || value === undefined ? '—' : value;

  return (
    <div className={`${styles.stat} ${styles[`size-${size}`]} ${styles[`accent-${accent}`]}`}>
      {icon && <div className={styles.icon}>{icon}</div>}
      <div className={styles.body}>
        <p className={styles.label}>{label}</p>
        <p className={styles.value}>{displayValue}</p>
        {(sub || trend) && (
          <div className={styles.meta}>
            {trend && trendValue && (
              <span className={`${styles.trend} ${styles[`trend-${trend}`]}`}>
                {TREND_ICONS[trend]} {trendValue}
              </span>
            )}
            {sub && <span className={styles.sub}>{sub}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Mini inline stat used inside tables / player cards */
export function StatPill({ label, value }: { label: string; value: string | number | null }) {
  return (
    <span className={styles.pill}>
      <span className={styles.pillLabel}>{label}</span>
      <span className={styles.pillValue}>{value ?? '—'}</span>
    </span>
  );
}
