import { createContext, useContext, useEffect, useRef } from 'react';
import type { LocalNode, PollResult } from '@sigilo/core/v2';
import type { Settings } from './storage';

export interface AppContextValue {
  node: LocalNode;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  lockNow: () => void;
  /** Apaga a identidade deste aparelho. Sem volta. */
  forgetDevice: () => Promise<void>;
  /** A última consulta ao relé funcionou. */
  online: boolean;
  /** Mensagens não lidas por contato (sem conteúdo). */
  unread: Record<string, number>;
  /** Aumenta quando contatos, vínculos ou membros podem ter mudado: telas releem do nó. */
  version: number;
  pollNow: () => Promise<void>;
  /** Recebe o resultado de cada consulta (recibos, novas mensagens, mudanças). */
  subscribe: (handler: (r: PollResult) => void) => () => void;
  /** Enquanto verdadeiro, consulta com mais frequência (conversa aberta). */
  setFastPolling: (on: boolean) => void;
  touch: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp fora do AppContext');
  return ctx;
}

export function usePollEvents(handler: (r: PollResult) => void): void {
  const { subscribe } = useApp();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((r) => ref.current(r)), [subscribe]);
}

export function useFastPolling(): void {
  const { setFastPolling } = useApp();
  useEffect(() => {
    setFastPolling(true);
    return () => setFastPolling(false);
  }, [setFastPolling]);
}
