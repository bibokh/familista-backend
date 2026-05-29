import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/api/client';
import styles from './Login.module.css';

export function Login() {
  const { login, isLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string })?.from ?? '/app';

  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');

  if (isAuthenticated) {
    navigate(from, { replace: true });
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Login failed. Check your credentials and try again.');
      }
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.panel}>
        {/* Branding */}
        <div className={styles.brand}>
          <div className={styles.logoMark}>F</div>
          <div>
            <h1 className={styles.logoName}>Familista</h1>
            <p className={styles.logoTag}>Football Intelligence Platform</p>
          </div>
        </div>

        <div className={styles.divider} />

        <h2 className={styles.heading}>Sign in to your club</h2>
        <p className={styles.sub}>Enter your credentials to access the platform.</p>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@club.com"
              autoComplete="email"
              required
              disabled={isLoading}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className={styles.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              disabled={isLoading}
            />
          </div>

          {error && (
            <div className={styles.errorBox} role="alert">
              ⚠ {error}
            </div>
          )}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={isLoading || !email || !password}
          >
            {isLoading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className={styles.footer}>
          Familista &copy; {new Date().getFullYear()} — Football Intelligence Platform
        </p>
      </div>

      {/* Background decorations */}
      <div className={styles.bgDecor1} aria-hidden="true" />
      <div className={styles.bgDecor2} aria-hidden="true" />
    </div>
  );
}
