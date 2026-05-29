import type { ReactNode } from 'react';
import styles from './Badge.module.css';

type BadgeVariant = 'default' | 'green' | 'amber' | 'red' | 'blue' | 'purple' | 'cyan' | 'outline';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  dot?: boolean;
}

export function Badge({ children, variant = 'default', size = 'md', dot = false }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[variant]} ${styles[`size-${size}`]}`}>
      {dot && <span className={styles.dot} />}
      {children}
    </span>
  );
}

/** Risk tier → Badge variant mapping */
export function RiskBadge({ tier }: { tier: string }) {
  const map: Record<string, BadgeVariant> = {
    LOW: 'green',
    MODERATE: 'amber',
    HIGH: 'red',
    CRITICAL: 'red',
  };
  return <Badge variant={map[tier] ?? 'default'} dot>{tier}</Badge>;
}

/** Transfer stage → Badge variant mapping */
export function StageBadge({ stage }: { stage: string }) {
  const map: Record<string, BadgeVariant> = {
    WATCHLIST: 'default',
    INTEREST: 'blue',
    APPROACHED: 'purple',
    NEGOTIATING: 'amber',
    AGREED: 'green',
    SIGNED: 'green',
    REJECTED: 'red',
  };
  return <Badge variant={map[stage] ?? 'default'}>{stage}</Badge>;
}

/** Recommendation → Badge */
export function RecommendationBadge({ rec }: { rec: string }) {
  const map: Record<string, BadgeVariant> = {
    STRONG_BUY: 'green',
    BUY: 'cyan',
    MONITOR: 'amber',
    PASS: 'red',
  };
  const labels: Record<string, string> = {
    STRONG_BUY: 'Strong Buy',
    BUY: 'Buy',
    MONITOR: 'Monitor',
    PASS: 'Pass',
  };
  return <Badge variant={map[rec] ?? 'default'}>{labels[rec] ?? rec}</Badge>;
}

export function FormBadge({ result }: { result: string }) {
  const map: Record<string, BadgeVariant> = { W: 'green', D: 'amber', L: 'red' };
  return <Badge variant={map[result] ?? 'default'} size="sm">{result}</Badge>;
}
