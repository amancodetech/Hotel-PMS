import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { PlatformSessionInfo, SessionResponse } from '../api/client.js';

interface AuthContextValue {
  loading: boolean;
  session: SessionResponse;
  activeTenantId: string | null;
  platform: PlatformSessionInfo | null;
  hasPlatformPermission: (permission: string) => boolean;
  hasPermission: (permission: string) => boolean;
  mfa: boolean;
  refresh: () => Promise<void>;
  selectTenant: (tenantId: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const anonymous: SessionResponse = { authenticated: false };
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionResponse>(anonymous);

  const refresh = useCallback(async () => {
    const next = await api<SessionResponse>('/api/v1/auth/session');
    setSession(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh().catch(() => {
      setSession(anonymous);
      setLoading(false);
    });
  }, [refresh]);

  useEffect(() => {
    const onUnauthorized = () => {
      void refresh().catch(() => setSession(anonymous));
    };
    window.addEventListener('hotel:session-changed', onUnauthorized);
    return () =>
      window.removeEventListener('hotel:session-changed', onUnauthorized);
  }, [refresh]);

  const selectTenant = useCallback(
    async (tenantId: string) => {
      if (
        !window.dispatchEvent(
          new Event('hotel:before-context-change', { cancelable: true }),
        )
      )
        return;
      await api(`/api/v1/tenants/${tenantId}/select`, { method: 'POST' });
      queryClient.clear();
      await refresh();
    },
    [queryClient, refresh],
  );

  const signOut = useCallback(async () => {
    if (
      !window.dispatchEvent(
        new Event('hotel:before-context-change', { cancelable: true }),
      )
    )
      return;
    try {
      const result = await api<{ end_session_url: string | null }>(
        '/api/v1/auth/logout',
        { method: 'POST' },
      );
      queryClient.clear();
      setSession(anonymous);
      if (result.end_session_url)
        window.location.assign(result.end_session_url);
      else window.location.assign('/login');
    } catch {
      queryClient.clear();
      setSession(anonymous);
      window.location.assign('/login');
    }
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      session,
      activeTenantId:
        session.authenticated && session.session
          ? (session.session.active_tenant_id ?? null)
          : null,
      mfa:
        session.authenticated && session.session ? session.session.mfa : false,
      platform:
        session.authenticated && session.platform ? session.platform : null,
      hasPlatformPermission: (permission: string) =>
        session.authenticated &&
        (session.platform?.permissions ?? []).includes(permission),
      hasPermission: (permission: string) =>
        session.authenticated &&
        (session.permissions ?? []).some(
          (entry) =>
            entry.permission === permission && entry.granted && !entry.denied,
        ),
      refresh,
      selectTenant,
      signOut,
    }),
    [loading, session, refresh, selectTenant, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}
