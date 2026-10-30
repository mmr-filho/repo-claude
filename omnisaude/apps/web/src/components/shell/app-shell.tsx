'use client';

import { ArrowLeftRight, BookOpenCheck, HeartPulse, LogOut, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { NAV } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { LibrasCallButton } from './libras-call';
import { PopsPanel } from './pops-panel';
import { VLibrasToggle } from './vlibras-toggle';

/** Moldura das telas autenticadas: menu por permissões, troca de contexto, POPs e acessibilidade. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [drawer, setDrawer] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [pops, setPops] = useState(false);

  useEffect(() => {
    if (!session.loading && !session.me) router.replace('/login');
  }, [session.loading, session.me, router]);
  useEffect(() => setDrawer(false), [pathname]);
  // Senha provisória (cadastro ou redefinição pela administração): só a troca libera as demais telas.
  const provisional = !!session.me?.user.mustChangePassword;
  useEffect(() => {
    if (provisional && pathname !== '/configuracoes') router.replace('/configuracoes');
  }, [provisional, pathname, router]);

  if (session.loading || !session.me) return <Spinner className="min-h-dvh" />;
  const me = session.me;
  const items = NAV.filter((n) => (provisional ? n.href === '/configuracoes' : n.any.length === 0 || n.any.some((p) => me.permissions.includes(p))));

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3" aria-label="Menu principal">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', active ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}
            aria-current={active ? 'page' : undefined}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="no-print sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        <Brand tenant={me.tenant.name} />
        <div className="flex-1 overflow-y-auto">{nav}</div>
      </aside>
      {drawer && (
        <div className="no-print fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between pr-2">
              <Brand tenant={me.tenant.name} />
              <Button variant="ghost" size="icon" onClick={() => setDrawer(false)} aria-label="Fechar menu">
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/95 px-3 backdrop-blur sm:px-4">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setDrawer(true)} aria-label="Abrir menu">
            <Menu className="h-5 w-5" />
          </Button>
          <button onClick={() => setSwitcher(true)} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-slate-100" title="Trocar unidade ou papel">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{me.context.unitName}</p>
              <p className="truncate text-xs text-slate-500">{me.context.roleLabel}</p>
            </div>
            <ArrowLeftRight className="h-4 w-4 shrink-0 text-slate-400" />
          </button>
          <div className="ml-auto flex items-center gap-1">
            <LibrasCallButton />
            <VLibrasToggle />
            {session.can('pop.consultar') && (
              <Button variant="ghost" size="icon" onClick={() => setPops(true)} aria-label="Procedimentos operacionais (POPs)" title="POPs">
                <BookOpenCheck className="h-5 w-5" />
              </Button>
            )}
            <span className="hidden px-2 text-sm text-slate-600 md:inline">{me.user.name}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                session.logout();
                router.replace('/login');
              }}
              aria-label="Sair"
              title="Sair"
            >
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-3 sm:p-6">{children}</main>
      </div>
      <Dialog open={switcher} onOpenChange={setSwitcher} title="Trocar unidade ou papel" description="As permissões passam a valer para o novo contexto.">
        <div className="flex flex-col divide-y divide-slate-100">
          {me.assignments.map((a) => {
            const current = a.unitId === me.context.unitId && a.role === me.context.role;
            return (
              <button
                key={`${a.unitId}-${a.role}`}
                disabled={current}
                onClick={async () => {
                  try {
                    await session.selectContext(a.unitId, a.role);
                    setSwitcher(false);
                    router.replace('/inicio');
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
                className="flex items-center justify-between px-2 py-3 text-left hover:bg-slate-50 disabled:opacity-60"
              >
                <span>
                  <span className="block font-medium">{a.unitName}</span>
                  <span className="text-sm text-slate-500">{a.roleLabel}</span>
                </span>
                {current && <span className="text-xs font-medium text-brand-700">atual</span>}
              </button>
            );
          })}
        </div>
      </Dialog>
      <PopsPanel open={pops} onOpenChange={setPops} />
    </div>
  );
}

function Brand({ tenant }: { tenant: string }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-4">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
        <HeartPulse className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold">OmniSaúde</p>
        <p className="truncate text-xs text-slate-500">{tenant}</p>
      </div>
    </div>
  );
}

