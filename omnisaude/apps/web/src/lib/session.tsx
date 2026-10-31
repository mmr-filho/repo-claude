'use client';

import type { Permission, Role } from '@omnisaude/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, setUnauthorizedHandler } from './api';
import { meStore, tokenStore } from './storage';
import type { Assignment, Me } from './types';

/** Token intermediário (etapas "mfa" e "context" do login), guardado só em memória. */
let pendingToken: string | null = null;
let pendingAssignments: Assignment[] = [];

export type LoginResult = { stage: 'mfa' } | { stage: 'context'; assignments: Assignment[] };
export interface MfaSetupData {
  secret: string;
  otpauthUrl: string;
  setupToken: string;
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  /** Etapa 1: tenant + CPF + senha. */
  login(tenant: string, cpf: string, password: string): Promise<LoginResult>;
  /** Etapa 2 (quando o 2FA está ativo). */
  verifyMfa(code: string): Promise<LoginResult>;
  pendingAssignments(): Assignment[];
  /** Escolhe (ou troca) unidade e papel ativos. */
  selectContext(unitId: string, role: Role): Promise<void>;
  /** 2FA exigido pelo papel escolhido: configuração ainda na etapa de contexto (token pendente). */
  pendingMfaSetup(): Promise<MfaSetupData>;
  pendingMfaEnable(code: string, setupToken: string): Promise<void>;
  logout(): void;
  refresh(): Promise<void>;
  can(...permissions: Permission[]): boolean;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get<Me>('/auth/me');
      meStore.set(me);
      setMe(me);
    } catch (err) {
      // Sem rede (app do ACS em campo): segue com a cópia da sessão; só a recusa do servidor encerra.
      const cached = err instanceof ApiError && err.status === 0 ? meStore.get<Me>() : null;
      if (cached) setMe(cached);
      else {
        tokenStore.clear();
        meStore.clear();
        setMe(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      tokenStore.clear();
      meStore.clear();
      setMe(null);
    });
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({
      me,
      loading,
      async login(tenant, cpf, password) {
        const res = await api.post<{ stage: 'mfa' | 'context'; token: string; assignments?: Assignment[] }>('/auth/login', { tenant, cpf, password }, { token: null });
        pendingToken = res.token;
        if (res.stage === 'mfa') return { stage: 'mfa' };
        pendingAssignments = res.assignments ?? [];
        return { stage: 'context', assignments: pendingAssignments };
      },
      async verifyMfa(code) {
        const res = await api.post<{ stage: 'context'; token: string; assignments: Assignment[] }>('/auth/mfa', { code }, { token: pendingToken });
        pendingToken = res.token;
        pendingAssignments = res.assignments;
        return { stage: 'context', assignments: res.assignments };
      },
      pendingAssignments: () => pendingAssignments,
      async selectContext(unitId, role) {
        const token = pendingToken ?? tokenStore.get();
        const res = await api.post<{ token: string }>('/auth/context', { unitId, role }, { token });
        tokenStore.set(res.token);
        pendingToken = null;
        pendingAssignments = [];
        const me = await api.get<Me>('/auth/me');
        meStore.set(me);
        setMe(me);
      },
      pendingMfaSetup: () => api.post<MfaSetupData>('/auth/pending/mfa/setup', {}, { token: pendingToken ?? tokenStore.get() }),
      async pendingMfaEnable(code, setupToken) {
        const res = await api.post<{ token: string }>('/auth/pending/mfa/enable', { code, setupToken }, { token: pendingToken ?? tokenStore.get() });
        pendingToken = res.token;
      },
      logout() {
        tokenStore.clear();
        meStore.clear();
        pendingToken = null;
        setMe(null);
      },
      refresh,
      can: (...permissions) => !!me && permissions.some((p) => me.permissions.includes(p)),
    }),
    [me, loading, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession fora do SessionProvider');
  return v;
}
