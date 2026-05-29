import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import styles from './Sidebar.module.css';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  group?: string;
}

const NAV: NavItem[] = [
  { path: '/app',             label: 'Overview',           icon: '⬡',  group: 'Platform' },
  { path: '/app/players',     label: 'Player Intelligence', icon: '◎',  group: 'Analytics' },
  { path: '/app/workload',    label: 'Workload & Injury',   icon: '♥',  group: 'Analytics' },
  { path: '/app/analytics',   label: 'Analytics Center',    icon: '◈',  group: 'Analytics' },
  { path: '/app/transfer',    label: 'Transfer Pipeline',   icon: '⟺',  group: 'Recruitment' },
  { path: '/app/competition', label: 'Competition',         icon: '⊞',  group: 'Competition' },
  { path: '/app/video',       label: 'Video Intelligence',  icon: '▶',  group: 'Video' },
  { path: '/app/ai',          label: 'AI Intelligence',     icon: '◎',  group: 'Intelligence' },
];

const GROUPS = ['Platform', 'Analytics', 'Recruitment', 'Competition', 'Video', 'Intelligence'];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/app/login', { replace: true });
  };

  return (
    <aside className={`${styles.sidebar} ${isOpen ? styles.open : ''}`}>
      {/* Logo */}
      <div className={styles.logo}>
        <span className={styles.logoMark}>F</span>
        <div className={styles.logoText}>
          <span className={styles.logoName}>Familista</span>
          <span className={styles.logoTagline}>Football Intelligence</span>
        </div>
      </div>

      {/* Club chip */}
      {user?.clubName && (
        <div className={styles.clubChip}>
          <span className={styles.clubDot} />
          <span className={styles.clubName} title={user.clubName}>{user.clubName}</span>
        </div>
      )}

      {/* Navigation */}
      <nav className={styles.nav} aria-label="Main navigation">
        {GROUPS.map((group) => {
          const items = NAV.filter((n) => n.group === group);
          if (!items.length) return null;
          return (
            <div key={group} className={styles.navGroup}>
              <p className={styles.groupLabel}>{group}</p>
              {items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/app'}
                  className={({ isActive }) =>
                    `${styles.navItem} ${isActive ? styles.active : ''}`
                  }
                  onClick={onClose}
                >
                  <span className={styles.navIcon}>{item.icon}</span>
                  <span className={styles.navLabel}>{item.label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className={styles.footer}>
        <div className={styles.userInfo}>
          <div className={styles.userAvatar}>
            {user?.name?.charAt(0).toUpperCase() ?? 'U'}
          </div>
          <div className={styles.userDetails}>
            <p className={styles.userName}>{user?.name ?? 'User'}</p>
            <p className={styles.userRole}>{user?.role ?? ''}</p>
          </div>
        </div>
        <button
          className={styles.logoutBtn}
          onClick={handleLogout}
          title="Sign out"
          aria-label="Sign out"
        >
          ⇥
        </button>
      </div>
    </aside>
  );
}
