'use client';

import { CalendarDays, FlaskConical, HeartPulse, Home, LogOut, MapPinned, Pill, Scale, Syringe } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { citizenStore, type CitizenSession } from './api';

const NAV = [
  { href: '/cidadao/inicio', label: 'Início', icon: Home },
  { href: '/cidadao/agenda', label: 'Agenda', icon: CalendarDays },
  { href: '/cidadao/exames', label: 'Exames', icon: FlaskConical },
  { href: '/cidadao/vacinas', label: 'Vacinas', icon: Syringe },
  { href: '/cidadao/medicamentos', label: 'Remédios', icon: Pill },
  { href: '/cidadao/regulacao', label: 'Fila', icon: Scale },
  { href: '/cidadao/unidades', label: 'Unidades', icon: MapPinned },
];

/** Casca do app do cidadão: cabeçalho com o nome, conteúdo rolável e barra inferior de navegação (celular). */
export function CitizenShell({ title, children }: { title: string; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<CitizenSession | null | undefined>(undefined);
  useEffect(() => {
    const s = citizenStore.get();
    setSession(s);
    if (!s) router.replace('/cidadao');
  }, [router]);
  if (!session) return <Spinner className="min-h-dvh" />;
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col bg-slate-50">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
            <HeartPulse className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">{session.instituicao.nome}</p>
            <h1 className="text-base font-semibold leading-tight">{title}</h1>
          </div>
        </div>
        <button
          type="button"
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          onClick={() => {
            citizenStore.clear();
            router.replace('/cidadao');
          }}
          aria-label="Sair do app"
        >
          <LogOut className="h-4 w-4" /> Sair
        </button>
      </header>
      <main className="flex-1 px-4 py-4 pb-24">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white" aria-label="Seções do app">
        <ul className="mx-auto grid max-w-2xl grid-cols-7">
          {NAV.map((n) => {
            const active = pathname?.startsWith(n.href);
            return (
              <li key={n.href}>
                <Link href={n.href} className={cn('flex flex-col items-center gap-0.5 px-1 py-2 text-[11px]', active ? 'text-brand-700' : 'text-slate-500')} aria-current={active ? 'page' : undefined}>
                  <n.icon className="h-5 w-5" />
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

export function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function CardItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('rounded-xl border border-slate-200 bg-white p-4 shadow-sm', className)}>{children}</div>;
}
