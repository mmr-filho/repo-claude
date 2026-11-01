'use client';

import { Star } from 'lucide-react';
import { useState } from 'react';
import { citizenApi } from '@/components/citizen/api';
import { useCitizen } from '@/components/citizen/hooks';
import { CardItem, CitizenShell, Section } from '@/components/citizen/shell';
import type { Avaliacao } from '@/components/citizen/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

const LABEL: Record<number, string> = { 1: 'Muito ruim', 2: 'Ruim', 3: 'Regular', 4: 'Bom', 5: 'Ótimo' };

export default function CitizenSurveyPage() {
  const toast = useToast();
  const { data, error, loading, setData } = useCitizen<Avaliacao[]>('/cidadao/avaliacoes');
  const [form, setForm] = useState<Record<string, { nota: number; recomendaria: number | null; comentario: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pendentes = data?.filter((a) => a.status === 'PENDENTE') ?? [];
  const respondidas = data?.filter((a) => a.status === 'RESPONDIDA') ?? [];

  async function enviar(a: Avaliacao) {
    const f = form[a.id];
    if (!f?.nota) return;
    setBusy(a.id);
    try {
      setData(await citizenApi.post<Avaliacao[]>(`/cidadao/avaliacoes/${a.id}`, { nota: f.nota, recomendaria: f.recomendaria, comentario: f.comentario || null }));
      toast.success('Obrigado! Sua avaliação ajuda a melhorar o atendimento.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <CitizenShell title="Avalie o atendimento">
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data && <Spinner />}
      <Section title="Aguardando sua opinião">
        {data && pendentes.length === 0 && <CardItem className="text-sm text-slate-500">Nenhuma avaliação pendente. Depois de cada atendimento, a pesquisa fica aqui por 7 dias.</CardItem>}
        {pendentes.map((a) => {
          const f = form[a.id] ?? { nota: 0, recomendaria: null, comentario: '' };
          return (
            <CardItem key={a.id} className="mb-3">
              <p className="font-medium">{a.unidade}</p>
              <p className="text-xs text-slate-500">
                {fmtDateTime(a.atendimentoEm)}
                {a.profissional ? ` · ${a.profissional}` : ''}
              </p>
              <p className="mt-3 text-sm">Como foi o atendimento?</p>
              <div className="mt-1 flex gap-1" role="radiogroup" aria-label="Nota do atendimento">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={f.nota === n} aria-label={`${n}: ${LABEL[n]}`} onClick={() => setForm({ ...form, [a.id]: { ...f, nota: n } })} className="p-1">
                    <Star className={`h-8 w-8 ${n <= f.nota ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />
                  </button>
                ))}
              </div>
              {f.nota > 0 && <p className="text-xs text-slate-500">{LABEL[f.nota]}</p>}
              <p className="mt-3 text-sm">De 0 a 10, quanto você recomendaria esta unidade a um amigo ou familiar?</p>
              <div className="mt-1 grid grid-cols-11 gap-1">
                {Array.from({ length: 11 }, (_, n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={f.recomendaria === n}
                    onClick={() => setForm({ ...form, [a.id]: { ...f, recomendaria: n } })}
                    className={`rounded-md border py-1.5 text-xs ${f.recomendaria === n ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <Textarea className="mt-3" rows={2} placeholder="Quer contar mais? (opcional)" value={f.comentario} onChange={(e) => setForm({ ...form, [a.id]: { ...f, comentario: e.target.value } })} />
              <Button className="mt-3" loading={busy === a.id} disabled={!f.nota} onClick={() => enviar(a)} id={`aval-enviar-${a.id}`}>
                Enviar avaliação
              </Button>
            </CardItem>
          );
        })}
      </Section>
      {respondidas.length > 0 && (
        <Section title="Já avaliadas">
          {respondidas.map((a) => (
            <CardItem key={a.id} className="mb-2 text-sm">
              <p className="font-medium">
                {a.unidade} · {a.notaLabel}
                {a.recomendaria != null ? ` · recomendaria ${a.recomendaria}/10` : ''}
              </p>
              <p className="text-xs text-slate-500">{fmtDateTime(a.atendimentoEm)}</p>
              {a.comentario && <p className="mt-1 text-slate-600">“{a.comentario}”</p>}
            </CardItem>
          ))}
        </Section>
      )}
    </CitizenShell>
  );
}
