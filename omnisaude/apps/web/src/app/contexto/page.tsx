'use client';

import { Building2, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Assignment } from '@/lib/types';

/** Escolha da unidade e do papel ativos (o contexto define as permissões da sessão). */
export default function ContextPage() {
  const session = useSession();
  const router = useRouter();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const pending = session.pendingAssignments();
    if (pending.length) setAssignments(pending);
    else if (session.me) setAssignments(session.me.assignments);
    else if (!session.loading) router.replace('/login');
  }, [session, router]);

  async function choose(a: Assignment) {
    try {
      await session.selectContext(a.unitId, a.role);
      router.replace('/inicio');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-lg">
        <h1 className="mb-1 text-xl font-semibold">Onde você está trabalhando agora?</h1>
        <p className="mb-4 text-sm text-slate-600">As permissões valem para a unidade e o papel escolhidos. Você pode trocar a qualquer momento.</p>
        {error && <Alert tone="error" className="mb-3">{error}</Alert>}
        <Card className="divide-y divide-slate-100">
          {assignments.map((a) => (
            <button key={`${a.unitId}-${a.role}`} onClick={() => choose(a)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
              <Building2 className="h-5 w-5 text-brand-600" />
              <div className="flex-1">
                <p className="font-medium">{a.unitName}</p>
                <p className="text-sm text-slate-500">{a.roleLabel} · CBO {a.cbo}</p>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-400" />
            </button>
          ))}
        </Card>
      </div>
    </main>
  );
}
