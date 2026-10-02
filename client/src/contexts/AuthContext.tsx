import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '@/api/endpoints';
import { setToken, clearToken } from '@/api/client';
import type { AuthUser, LoginUser, MeResponse } from '@/api/types';

// Cyber Defense R7: this provider keeps nothing in localStorage or
// sessionStorage — no token, no profile. The session lives in HttpOnly cookies
// the server sets at sign-in; on load the signed-in person is asked of the
// server (GET /auth/me), which is the only party that knows.

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

/** One shape for the person, whichever endpoint described them. */
function toAuthUser(u: LoginUser | MeResponse): AuthUser {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return {
    id: u.id,
    name: name || u.email,
    email: u.email,
    role: u.role,
    clubId: u.clubId,
    clubName: u.clubName ?? undefined,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, isLoading: true, isAuthenticated: false });

  // Restore the session from its cookie. A 401 here is the ordinary answer for
  // somebody who is not signed in, not an error to navigate away from.
  useEffect(() => {
    let alive = true;
    authApi.me()
      .then((res) => { if (alive) setState({ user: toAuthUser(res.data), isLoading: false, isAuthenticated: true }); })
      .catch(() => { if (alive) setState({ user: null, isLoading: false, isAuthenticated: false }); });
    return () => { alive = false; };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setState((s) => ({ ...s, isLoading: true }));
    try {
      const res = await authApi.login(email, password);
      setToken(res.data.tokens.accessToken);
      setState({ user: toAuthUser(res.data.user), isLoading: false, isAuthenticated: true });
    } catch (e) {
      setState((s) => ({ ...s, isLoading: false }));
      throw e;
    }
  }, []);

  const logout = useCallback(() => {
    // Revoke the refresh token and clear the cookies server-side, then leave,
    // whether or not the server answered: the local half is gone either way.
    authApi.logout().catch(() => undefined).finally(() => {
      clearToken();
      setState({ user: null, isLoading: false, isAuthenticated: false });
      window.location.href = '/app/login';
    });
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
