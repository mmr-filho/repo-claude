'use client';

import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useState } from 'react';
import { cn } from '@/lib/cn';

type Kind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: Kind;
  message: string;
}

const Ctx = createContext<(kind: Kind, message: string) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((kind: Kind, message: string) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, kind, message }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="no-print pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg',
              t.kind === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-900',
              t.kind === 'error' && 'border-red-200 bg-red-50 text-red-900',
              t.kind === 'info' && 'border-slate-200 bg-white text-slate-800',
            )}
          >
            {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : t.kind === 'error' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const push = useContext(Ctx);
  return { success: (m: string) => push('success', m), error: (m: string) => push('error', m), info: (m: string) => push('info', m) };
}
