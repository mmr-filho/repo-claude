'use client';

import { Bus, BedDouble, Scale } from 'lucide-react';
import { CardItem, CitizenShell, Section } from '@/components/citizen/shell';
import { useCitizen } from '@/components/citizen/hooks';
import type { Regulacao } from '@/components/citizen/types';
import { Badge } from '@/components/ui/badge';
import { Alert, Spinner } from '@/components/ui/misc';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';

const TONE: Record<string, 'blue' | 'green' | 'red' | 'amber' | 'slate' | 'violet'> = {
  PENDENTE: 'blue',
  EM_ANALISE: 'amber',
  DEVOLVIDA: 'amber',
  AUTORIZADA: 'green',
  AGENDADA: 'green',
  REALIZADA: 'slate',
  NEGADA: 'red',
  CANCELADA: 'red',
  FALTOU: 'red',
  ABERTO: 'blue',
  ENVIADO: 'amber',
  DEFERIDO: 'green',
  INDEFERIDO: 'red',
  CONCLUIDO: 'slate',
  EM_TRANSFERENCIA: 'violet',
  INTERNADO: 'slate',
};

export default function CitizenRegulationPage() {
  const { data, error, loading } = useCitizen<Regulacao>('/cidadao/regulacao');
  const vazio = data && !data.solicitacoes.length && !data.leitos.length && !data.tfd.length;
  return (
    <CitizenShell title="Fila e encaminhamentos">
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data && <Spinner />}
      {vazio && <CardItem className="text-sm text-slate-500">Nenhum encaminhamento para especialista, exame regulado, leito ou tratamento fora do domicílio.</CardItem>}
      {data && data.solicitacoes.length > 0 && (
        <Section title="Consultas e exames especializados">
          {data.solicitacoes.map((s) => (
            <CardItem key={s.id} className="mb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-2 font-medium">
                    <Scale className="h-4 w-4 text-brand-600" /> {s.procedimento}
                  </p>
                  <p className="text-xs text-slate-500">
                    Protocolo {s.protocolo} · pedido em {fmtDate(s.em)}
                    {s.unidadeSolicitante ? ` · ${s.unidadeSolicitante}` : ''}
                  </p>
                </div>
                <Badge tone={TONE[s.status] ?? 'slate'}>{s.statusLabel}</Badge>
              </div>
              {s.posicaoNaFila != null && (
                <p className="mt-2 rounded-lg bg-brand-50 p-2 text-sm text-brand-900">
                  Você é o <b>{s.posicaoNaFila}º</b> da fila para este atendimento. Classificação: {s.prioridade.toLowerCase()}. A ordem segue a gravidade clínica, não só a data do pedido.
                </p>
              )}
              {s.agendadoPara && (
                <p className="mt-2 rounded-lg bg-green-50 p-2 text-sm text-green-900">
                  Agendado para <b>{fmtDateTime(s.agendadoPara)}</b>
                  {s.unidadeExecutante ? ` em ${s.unidadeExecutante}` : ''}.
                </p>
              )}
              {s.devolutiva && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">Retorno da regulação: {s.devolutiva}. Procure a unidade que fez o pedido.</p>}
            </CardItem>
          ))}
        </Section>
      )}
      {data && data.leitos.length > 0 && (
        <Section title="Vaga de internação">
          {data.leitos.map((l) => (
            <CardItem key={l.id} className="mb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-2 font-medium">
                    <BedDouble className="h-4 w-4 text-brand-600" /> {l.tipo} · {l.especialidade}
                  </p>
                  <p className="text-xs text-slate-500">
                    Protocolo {l.protocolo} · {fmtDate(l.em)} · de {l.origem ?? '—'}
                    {l.destino ? ` para ${l.destino}` : ''}
                  </p>
                </div>
                <Badge tone={TONE[l.status] ?? 'slate'}>{l.statusLabel}</Badge>
              </div>
            </CardItem>
          ))}
        </Section>
      )}
      {data && data.tfd.length > 0 && (
        <Section title="Tratamento fora do domicílio (TFD)">
          {data.tfd.map((t) => (
            <CardItem key={t.id} className="mb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-2 font-medium">
                    <Bus className="h-4 w-4 text-brand-600" /> {t.procedimento}
                  </p>
                  <p className="text-xs text-slate-500">
                    Protocolo {t.protocolo} · {t.destino} · {t.transporte}
                  </p>
                </div>
                <Badge tone={TONE[t.status] ?? 'slate'}>{t.statusLabel}</Badge>
              </div>
              {t.atendimento && (
                <p className="mt-2 rounded-lg bg-green-50 p-2 text-sm text-green-900">
                  Atendimento em <b>{fmtDateTime(t.atendimento.em)}</b>
                  {t.atendimento.local ? ` · ${t.atendimento.local}` : ''}
                </p>
              )}
              {t.viagem && (
                <p className="mt-2 rounded-lg bg-brand-50 p-2 text-sm text-brand-900">
                  Viagem em <b>{fmtDate(t.viagem.data)}</b>
                  {t.viagem.saida ? ` às ${t.viagem.saida}` : ''} · {t.viagem.veiculo} · motorista {t.viagem.motorista}
                  {t.viagem.telefoneMotorista ? ` (${t.viagem.telefoneMotorista})` : ''}
                </p>
              )}
              {t.ajudaCusto && (
                <p className="mt-1 text-xs text-slate-600">
                  Ajuda de custo: {fmtMoney(t.ajudaCusto.total)} · {t.ajudaCusto.paga ? 'paga' : 'a pagar'}
                </p>
              )}
            </CardItem>
          ))}
        </Section>
      )}
    </CitizenShell>
  );
}
