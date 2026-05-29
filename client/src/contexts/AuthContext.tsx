import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '@/api/endpoints';
import { setToken, clearToken } from '@/api/client';
import type { AuthUser } from '@/api/types';

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const USER_KEY = 'familista_user';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const stored = localStorage.getItem(USER_KEY);
    const token = localStorage.getItem('familista_token');
    if (stored && token) {
      try {
        return { user: JSON.parse(stored) as AuthUser, isLoading: false, isAuthenticated: true };
      } catch { /* ignore */ }
    }
    return { user: null, isLoading: false, isAuthenticated: false };
  });

  const login = useCallback(async (email: string, password: string) => {
    setState((s) => ({ ...s, isLoading: true }));
    try {
      const res = await authApi.login(email, password);
      setToken(res.tokens.accessToken);
      localStorage.setItem('familista_refresh_token', res.tokens.refreshToken);
      localStorage.setItem(USER_KEY, JSON.stringify(res.user));
      setState({ user: res.user, isLoading: false, isAuthenticated: true });
    } catch (e) {
      setState((s) => ({ ...s, isLoading: false }));
      throw e;
    }
  }, []);

  const logout = useCallback(() => {
    clearToken();
    localStorage.removeItem('familista_refresh_token');
    localStorage.removeItem(USER_KEY);
    setState({ user: null, isLoading: false, isAuthenticated: false });
    window.location.href = '/app/login';
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
