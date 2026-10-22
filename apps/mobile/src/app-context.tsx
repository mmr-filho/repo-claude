import { createContext, useContext, useEffect, useRef } from 'react';
import type { ServerEvent, SigiloSession } from '@sigilo/core';
import type { Settings } from './storage';

export interface AppContextValue {
  session: SigiloSession;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  lockNow: () => void;
  /** Marca atividade do usuário (digitação conta para o bloqueio por inatividade). */
  touch: () => void;
  logout: () => Promise<void>;
  /** Tempo real conectado (avisos de mensagem nova/lida chegam na hora). */
  online: boolean;
  subscribe: (handler: (e: ServerEvent) => void) => () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp fora do AppContext');
  return ctx;
}

/** Recebe eventos do servidor (mensagem nova, lida, recolhida, contatos mudaram). */
export function useServerEvents(handler: (e: ServerEvent) => void): void {
  const { subscribe } = useApp();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}
