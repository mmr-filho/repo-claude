'use client';

import { CardItem, CitizenShell, Section } from '@/components/citizen/shell';
import { useCitizen } from '@/components/citizen/hooks';
import type { Exame } from '@/components/citizen/types';
import { Badge } from '@/components/ui/badge';
import { Alert, Spinner } from '@/components/ui/misc';
import { fmtDate } from '@/lib/format';

const TONE: Record<string, 'blue' | 'green' | 'red' | 'amber' | 'slate'> = { SOLICITADO: 'blue', COLETADO: 'amber', RESULTADO: 'green', CANCELADO: 'red' };

export default function CitizenExamsPage() {
  const { data, error, loading } = useCitizen<Exame[]>('/cidadao/exames');
  const comResultado = data?.filter((e) => e.status === 'RESULTADO') ?? [];
  const pendentes = data?.filter((e) => e.status !== 'RESULTADO') ?? [];
  const Item = ({ e }: { e: Exame }) => (
    <CardItem className={`mb-2 ${e.resultado?.novo ? 'border-green-300' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{e.nome}</p>
          <p className="text-xs text-slate-500">
            Pedido em {fmtDate(e.solicitadoEm)}
            {e.solicitante ? ` por ${e.solicitante}` : ''}
            {e.unidade ? ` · ${e.unidade}` : ''}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone={TONE[e.status] ?? 'slate'}>{e.statusLabel}</Badge>
          {e.resultado?.novo && <Badge tone="green">Novo</Badge>}
        </div>
      </div>
      {e.resultado && (
        <div className="mt-2 rounded-lg bg-slate-50 p-3 text-sm">
          {e.resultado.valor != null && (
            <p className="text-lg font-semibold">
              {e.resultado.valor} <span className="text-sm font-normal text-slate-500">{e.resultado.unidade}</span>
            </p>
          )}
          {e.resultado.texto && <p className="whitespace-pre-wrap text-slate-700">{e.resultado.texto}</p>}
          {e.resultado.em && <p className="mt-1 text-xs text-slate-500">Liberado em {fmtDate(e.resultado.em)}. Leve o resultado à consulta: só o profissional de saúde interpreta o exame.</p>}
        </div>
      )}
    </CardItem>
  );
  return (
    <CitizenShell title="Meus exames">
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && data.length === 0 && <CardItem className="text-sm text-slate-500">Nenhum exame solicitado até agora.</CardItem>}
      {pendentes.length > 0 && (
        <Section title="Aguardando">
          {pendentes.map((e) => (
            <Item key={e.id} e={e} />
          ))}
        </Section>
      )}
      {comResultado.length > 0 && (
        <Section title="Resultados">
          {comResultado.map((e) => (
            <Item key={e.id} e={e} />
          ))}
        </Section>
      )}
    </CitizenShell>
  );
}
