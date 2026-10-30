'use client';

import { HeartPulse, Volume2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { speak } from '@/lib/native';
import { useRealtime } from '@/lib/realtime';

interface Call {
  code: string;
  desk: string | null;
  firstName?: string | null;
  kind?: string;
  calledAt: string | null;
  speech?: string;
}

interface PanelState {
  unitName: string;
  tenantName: string;
  lastCalls: Call[];
}

/** Painel de chamada da sala de espera (TV): senha, local e primeiro nome, com chamada falada. */
function Panel() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<PanelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Call | null>(null);
  const [history, setHistory] = useState<Call[]>([]);
  const [sound, setSound] = useState(false);
  const [flash, setFlash] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const queue = useRef<Call[]>([]);
  const speaking = useRef(false);

  useEffect(() => {
    if (!token) return;
    api
      .get<PanelState>(`/reception/panel?token=${encodeURIComponent(token)}`, { token: null })
      .then((s) => {
        setState(s);
        setCurrent(s.lastCalls[0] ?? null);
        setHistory(s.lastCalls.slice(1));
      })
      .catch((err) => setError(errorMessage(err)));
  }, [token]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // As chamadas são faladas uma de cada vez, na ordem em que chegam.
  const drain = useCallback(async () => {
    if (speaking.current) return;
    speaking.current = true;
    while (queue.current.length) {
      const c = queue.current.shift()!;
      const text = c.speech ?? `Senha ${c.code}. ${c.desk ?? ''}`;
      await speak(c.firstName ? `${c.firstName}. ${text}` : text, 0.95);
      await new Promise((r) => setTimeout(r, 600));
      await speak(text, 0.95);
    }
    speaking.current = false;
  }, []);

  useRealtime<Call>(
    'senha.chamada',
    (c) => {
      setCurrent((prev) => {
        if (prev && prev.code !== c.code) setHistory((h) => [prev, ...h.filter((x) => x.code !== prev.code)].slice(0, 5));
        return c;
      });
      setFlash(true);
      setTimeout(() => setFlash(false), 4000);
      if (sound) {
        queue.current.push(c);
        void drain();
      }
    },
    token,
  );

  if (!token) return <Message text="Endereço do painel incompleto. Gere o link na tela da recepção." />;
  if (error) return <Message text={error} />;

  return (
    <main className="flex min-h-dvh flex-col bg-slate-950 text-white" onClick={() => setSound(true)}>
      <header className="flex items-center justify-between border-b border-white/10 px-8 py-4">
        <div className="flex items-center gap-3">
          <HeartPulse className="h-8 w-8 text-sky-400" />
          <div>
            <p className="text-2xl font-semibold">{state?.unitName ?? '…'}</p>
            <p className="text-sm text-slate-400">{state?.tenantName}</p>
          </div>
        </div>
        <p className="font-mono text-4xl tabular-nums" aria-label="Horário atual">
          {now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </p>
      </header>
      <section className="grid flex-1 gap-6 p-8 lg:grid-cols-[2fr_1fr]" aria-live="assertive">
        <div className={`flex flex-col items-center justify-center rounded-3xl border-4 p-8 text-center transition-colors ${flash ? 'border-yellow-300 bg-sky-800' : 'border-sky-700 bg-sky-900/60'}`}>
          <p className="text-3xl uppercase tracking-widest text-sky-200">Senha</p>
          <p className="mt-2 font-mono text-[9rem] font-bold leading-none tracking-wider">{current?.code ?? '— — —'}</p>
          {current?.firstName && <p className="mt-4 text-5xl font-semibold">{current.firstName}</p>}
          <p className="mt-6 text-5xl font-semibold text-yellow-300">{current?.desk ?? ''}</p>
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-xl uppercase tracking-wide text-slate-400">Últimas chamadas</p>
          {history.length === 0 && <p className="text-slate-500">—</p>}
          {history.map((c, i) => (
            <div key={`${c.code}-${i}`} className="flex items-center justify-between rounded-2xl bg-white/5 px-6 py-4">
              <span className="font-mono text-4xl font-semibold">{c.code}</span>
              <span className="text-right text-xl text-slate-300">
                {c.desk}
                <br />
                <span className="text-sm text-slate-500">{fmtTime(c.calledAt)}</span>
              </span>
            </div>
          ))}
        </div>
      </section>
      {!sound && (
        <button className="fixed inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-yellow-400 py-4 text-xl font-semibold text-slate-900" onClick={() => setSound(true)}>
          <Volume2 className="h-6 w-6" /> Clique para ativar o som das chamadas
        </button>
      )}
    </main>
  );
}

function Message({ text }: { text: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-950 p-8 text-center text-2xl text-white">
      <p>{text}</p>
    </main>
  );
}

export default function PanelPage() {
  return (
    <Suspense fallback={<Message text="Carregando painel…" />}>
      <Panel />
    </Suspense>
  );
}
