'use client';

import { Download, Syringe } from 'lucide-react';
import { useState } from 'react';
import { citizenApi } from '@/components/citizen/api';
import { useCitizen } from '@/components/citizen/hooks';
import { CardItem, CitizenShell, Section } from '@/components/citizen/shell';
import type { Vacinas } from '@/components/citizen/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';

const SITUACAO: Record<string, { label: string; tone: 'red' | 'amber' | 'blue' | 'slate' }> = {
  ATRASADA: { label: 'Atrasada', tone: 'red' },
  NO_PRAZO: { label: 'Pode tomar agora', tone: 'amber' },
  FUTURA: { label: 'Mais adiante', tone: 'blue' },
};

export default function CitizenVaccinesPage() {
  const toast = useToast();
  const { data, error, loading } = useCitizen<Vacinas>('/cidadao/vacinas');
  const [baixando, setBaixando] = useState(false);
  async function certificado() {
    setBaixando(true);
    try {
      await citizenApi.download('/cidadao/vacinas/certificado.pdf', 'certificado-vacinacao.pdf');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBaixando(false);
    }
  }
  return (
    <CitizenShell title="Cartão de vacinas">
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (
        <>
          {data.atrasadas > 0 && (
            <Alert tone="warn" title={`${data.atrasadas} ${data.atrasadas === 1 ? 'vacina atrasada' : 'vacinas atrasadas'}`} className="mb-4">
              Procure a sala de vacina da sua unidade. Não precisa agendar: leve um documento com foto.
            </Alert>
          )}
          <Section
            title="Próximas doses"
            action={
              data.certificadoDisponivel ? (
                <Button size="sm" variant="secondary" loading={baixando} onClick={certificado} id="cid-certificado">
                  <Download className="h-4 w-4" /> Certificado
                </Button>
              ) : undefined
            }
          >
            {data.proximas.length === 0 && <CardItem className="text-sm text-slate-500">Calendário em dia para a sua idade. Parabéns!</CardItem>}
            {data.proximas.map((p, i) => (
              <CardItem key={`${p.vacina}-${p.dose}-${i}`} className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{p.nome}</p>
                  <p className="text-xs text-slate-500">
                    {p.dose}
                    {p.situacao === 'ATRASADA' ? ' · pode ser aplicada agora' : p.previstaPara ? ` · prevista para ${fmtDate(p.previstaPara)}` : ''}
                  </p>
                </div>
                <Badge tone={SITUACAO[p.situacao]?.tone ?? 'slate'}>{SITUACAO[p.situacao]?.label ?? p.situacao}</Badge>
              </CardItem>
            ))}
          </Section>
          <Section title="Doses aplicadas">
            {data.doses.length === 0 && <CardItem className="text-sm text-slate-500">Nenhuma dose registrada na rede. Doses de outros lugares podem ser transcritas na sua unidade.</CardItem>}
            {data.doses.map((d) => (
              <CardItem key={d.id} className="mb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 font-medium">
                      <Syringe className="h-4 w-4 text-brand-600" /> {d.vacina}
                    </p>
                    <p className="text-xs text-slate-500">
                      {d.dose} · {fmtDate(d.aplicadaEm)}
                      {d.unidade ? ` · ${d.unidade}` : ''}
                      {d.lote ? ` · lote ${d.lote}` : ''}
                    </p>
                  </div>
                  {d.transcrita && <Badge tone="slate">Transcrita</Badge>}
                </div>
              </CardItem>
            ))}
          </Section>
        </>
      )}
    </CitizenShell>
  );
}
