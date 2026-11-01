'use client';

import { eventoIcs } from '@omnisaude/shared';
import { CalendarPlus, Check, MapPin, X } from 'lucide-react';
import { useState } from 'react';
import { citizenApi } from '@/components/citizen/api';
import { useCitizen } from '@/components/citizen/hooks';
import { CardItem, CitizenShell, Section } from '@/components/citizen/shell';
import type { Agenda, Agendamento } from '@/components/citizen/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

const TONE: Record<string, 'blue' | 'green' | 'red' | 'amber' | 'slate' | 'violet'> = { AGENDADO: 'blue', CONFIRMADO: 'green', CANCELADO: 'red', FALTOU: 'amber', ATENDIDO: 'slate', REMARCADO: 'violet' };

function baixarIcs(a: Agendamento) {
  const ics = eventoIcs({
    uid: `${a.id}@omnisaude`,
    inicio: a.quando,
    fim: a.fim,
    titulo: `${a.servico} · ${a.unidade?.nome ?? 'Saúde'}`,
    local: a.unidade ? `${a.unidade.nome}${a.unidade.endereco ? `, ${a.unidade.endereco}` : ''}` : null,
    descricao: a.profissional ? `Com ${a.profissional}` : null,
  });
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const el = document.createElement('a');
  el.href = url;
  el.download = 'compromisso-saude.ics';
  document.body.appendChild(el);
  el.click();
  el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function CitizenAgendaPage() {
  const toast = useToast();
  const { data, error, loading, setData } = useCitizen<Agenda>('/cidadao/agenda');
  const [cancelando, setCancelando] = useState<Agendamento | null>(null);
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function confirmar(a: Agendamento) {
    setBusy(a.id);
    try {
      setData(await citizenApi.post<Agenda>(`/cidadao/agenda/${a.id}/confirmar`));
      toast.success('Presença confirmada. Até lá!');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function cancelar() {
    if (!cancelando) return;
    setBusy(cancelando.id);
    try {
      setData(await citizenApi.post<Agenda>(`/cidadao/agenda/${cancelando.id}/cancelar`, { motivo: motivo || null }));
      toast.success('Agendamento cancelado. A vaga foi liberada para outra pessoa.');
      setCancelando(null);
      setMotivo('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function lembretes(on: boolean) {
    try {
      const r = await citizenApi.patch<{ whatsapp: boolean; telefone: string | null }>('/cidadao/preferencias', { whatsappOptIn: on });
      setData((d) => (d ? { ...d, lembretes: { ...d.lembretes, whatsapp: r.whatsapp, telefone: r.telefone } } : d));
      toast.success(on ? 'Lembretes pelo WhatsApp ativados.' : 'Lembretes pelo WhatsApp desativados.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const Item = ({ a }: { a: Agendamento }) => (
    <CardItem className="mb-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{a.servico}</p>
          <p className="text-sm text-slate-700">{fmtDateTime(a.quando)}</p>
          {a.profissional && <p className="text-sm text-slate-500">{a.profissional}</p>}
          {a.unidade && (
            <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
              <MapPin className="h-3.5 w-3.5" /> {a.unidade.nome}
              {a.unidade.endereco ? ` · ${a.unidade.endereco}` : ''}
            </p>
          )}
        </div>
        <Badge tone={TONE[a.status] ?? 'slate'}>{a.statusLabel}</Badge>
      </div>
      {(a.podeConfirmar || a.podeCancelar) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {a.podeConfirmar && (
            <Button size="sm" variant="success" loading={busy === a.id} onClick={() => confirmar(a)}>
              <Check className="h-4 w-4" /> Confirmar presença
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => baixarIcs(a)}>
            <CalendarPlus className="h-4 w-4" /> Salvar na agenda
          </Button>
          {a.podeCancelar && (
            <Button size="sm" variant="ghost" onClick={() => setCancelando(a)}>
              <X className="h-4 w-4" /> Cancelar
            </Button>
          )}
        </div>
      )}
    </CardItem>
  );

  return (
    <CitizenShell title="Minha agenda">
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <CardItem className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Lembretes pelo WhatsApp</p>
              <p className="text-xs text-slate-500">
                {data.lembretes.telefone ? `Enviados para ${data.lembretes.telefone}, ${data.lembretes.horasAntes} h antes.` : 'Cadastre um telefone na sua unidade para receber lembretes.'}
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5 accent-brand-600"
                checked={data.lembretes.whatsapp}
                disabled={!data.lembretes.telefone}
                onChange={(e) => lembretes(e.target.checked)}
                aria-label="Receber lembretes pelo WhatsApp"
              />
            </label>
          </CardItem>
          <Section title="Próximos">
            {data.proximos.length === 0 && <CardItem className="text-sm text-slate-500">Nenhum agendamento marcado. Procure sua unidade de saúde para agendar.</CardItem>}
            {data.proximos.map((a) => (
              <Item key={a.id} a={a} />
            ))}
          </Section>
          <Section title="Histórico">
            {data.historico.length === 0 && <CardItem className="text-sm text-slate-500">Sem atendimentos nos últimos 12 meses.</CardItem>}
            {data.historico.map((a) => (
              <Item key={a.id} a={a} />
            ))}
          </Section>
        </>
      )}
      <Dialog
        open={!!cancelando}
        onOpenChange={(o) => !o && setCancelando(null)}
        title="Cancelar agendamento"
        description={cancelando ? `${cancelando.servico} em ${fmtDateTime(cancelando.quando)}. A vaga será oferecida a outra pessoa.` : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelando(null)}>
              Manter
            </Button>
            <Button variant="danger" loading={!!busy} onClick={cancelar} id="cid-confirmar-cancelamento">
              Cancelar agendamento
            </Button>
          </>
        }
      >
        <Field label="Motivo (opcional)" htmlFor="cid-motivo">
          <Textarea id="cid-motivo" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: vou viajar, já fui atendido em outro lugar…" />
        </Field>
      </Dialog>
    </CitizenShell>
  );
}
