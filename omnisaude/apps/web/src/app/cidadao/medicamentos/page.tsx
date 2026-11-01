'use client';

import { Pill, Store } from 'lucide-react';
import { CardItem, CitizenShell, Section } from '@/components/citizen/shell';
import { useCitizen } from '@/components/citizen/hooks';
import type { Medicamentos } from '@/components/citizen/types';
import { Badge } from '@/components/ui/badge';
import { Alert, Spinner } from '@/components/ui/misc';
import { fmtDate } from '@/lib/format';

export default function CitizenMedicationsPage() {
  const { data, error, loading } = useCitizen<Medicamentos>('/cidadao/medicamentos');
  return (
    <CitizenShell title="Meus remédios">
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <Section title="Em uso (receitas ativas)">
            {data.itens.length === 0 && <CardItem className="text-sm text-slate-500">Nenhuma receita ativa registrada na rede.</CardItem>}
            {data.itens.map((i) => (
              <CardItem key={i.id} className="mb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 font-medium">
                      <Pill className="h-4 w-4 text-brand-600" /> {i.medicamento}
                    </p>
                    <p className="text-sm text-slate-700">{i.posologia}</p>
                    <p className="text-xs text-slate-500">
                      Receita de {fmtDate(i.prescritoEm)}
                      {i.prescritor ? ` · ${i.prescritor}` : ''}
                      {i.ultimaRetirada ? ` · última retirada ${fmtDate(i.ultimaRetirada)}` : ''}
                    </p>
                  </div>
                  {i.usoContinuo && <Badge tone="violet">Uso contínuo</Badge>}
                </div>
                {i.cadastradoNaFarmacia && (
                  <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs">
                    {i.disponivelEm.length ? (
                      <p className="flex flex-wrap items-center gap-1 text-green-800">
                        <Store className="h-3.5 w-3.5" /> Disponível em: {i.disponivelEm.map((d) => d.unidade).join(', ')}
                      </p>
                    ) : (
                      <p className="text-amber-800">Sem estoque nas farmácias da rede neste momento. Confirme na unidade antes de ir.</p>
                    )}
                  </div>
                )}
              </CardItem>
            ))}
          </Section>
          <Section title="Retiradas na farmácia (6 meses)">
            {data.retiradas.length === 0 && <CardItem className="text-sm text-slate-500">Nenhuma retirada registrada.</CardItem>}
            {data.retiradas.map((r) => (
              <CardItem key={r.id} className="mb-2">
                <p className="text-sm font-medium">
                  {fmtDate(r.em)}
                  {r.unidade ? ` · ${r.unidade}` : ''}
                </p>
                <ul className="mt-1 text-sm text-slate-700">
                  {r.itens.map((it, idx) => (
                    <li key={idx}>
                      {it.medicamento} — {it.quantidade} {it.unidade}
                    </li>
                  ))}
                </ul>
              </CardItem>
            ))}
          </Section>
        </>
      )}
    </CitizenShell>
  );
}
