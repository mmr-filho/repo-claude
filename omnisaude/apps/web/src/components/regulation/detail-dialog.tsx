'use client';

import { PRIORIDADES, type PrioridadeRegulacao } from '@omnisaude/shared';
import { CalendarCheck, Paperclip } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SlotPicker, type Slot } from '@/components/scheduling/slot-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { EVENTO_LABEL, PRIORIDADE_TONE, STATUS_TONE, type AgendaPrestador, type Oferta, type SolicitacaoDetalhe } from './types';

type Acao = 'autorizar' | 'devolver' | 'negar' | 'complementar' | 'cancelar' | 'mensagem' | 'agendar' | 'remarcar' | 'desmarcar' | 'realizar';

const TITULO: Record<Acao, string> = {
  autorizar: 'Autorizar',
  devolver: 'Devolver com pendência',
  negar: 'Negar',
  complementar: 'Complementar a solicitação',
  cancelar: 'Cancelar a solicitação',
  mensagem: 'Mensagem para a outra parte',
  agendar: 'Agendar na unidade executante',
  remarcar: 'Remarcar',
  desmarcar: 'Desmarcar o agendamento',
  realizar: 'Concluir (atendimento realizado)',
};
const SUCESSO: Record<Acao, string> = {
  autorizar: 'Solicitação autorizada',
  devolver: 'Devolvida ao solicitante',
  negar: 'Solicitação negada',
  complementar: 'Complementação enviada: a solicitação voltou à fila',
  cancelar: 'Solicitação cancelada',
  mensagem: 'Mensagem registrada',
  agendar: 'Agendado: o cidadão recebe a confirmação pelo WhatsApp',
  remarcar: 'Remarcado',
  desmarcar: 'Agendamento desmarcado; a vaga voltou à agenda',
  realizar: 'Solicitação concluída',
};

/** Detalhe da solicitação: protocolo, quadro clínico, pendências, anexos, histórico, agendamento e as ações de quem regula ou de quem solicitou. */
export function DetailDialog({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const session = useSession();
  const toast = useToast();
  const det = useApi<SolicitacaoDetalhe>(id ? `/regulacao/solicitacoes/${id}` : null, [id]);
  const [acao, setAcao] = useState<Acao | null>(null);
  const [texto, setTexto] = useState('');
  const [prioridade, setPrioridade] = useState<PrioridadeRegulacao | ''>('');
  const [prestador, setPrestador] = useState('');
  const [agenda, setAgenda] = useState('');
  const [data, setData] = useState(todayIso(1));
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const s = det.data;
  const regula = session.can('regulacao.regular');
  const solicita = session.can('regulacao.solicitar');
  const marca = session.can('agenda.marcar');
  const minhaUnidade = s?.unit.id === session.me?.context.unitId;
  const executante = !!s?.providerUnit && s.providerUnit.id === session.me?.context.unitId && marca;
  const naFila = s?.status === 'PENDENTE' || s?.status === 'EM_ANALISE';
  const ofertas = useApi<{ competencia: string; prestadores: Oferta[] }>(s && acao === 'autorizar' && regula ? `/regulacao/ofertas?kind=${s.kind}&specialty=${s.specialty}&unitId=${s.unit.id}` : null, [acao, s?.id]);
  const agendas = useApi<{ unitId: string | null; agendas: AgendaPrestador[] }>(s && (acao === 'agendar' || acao === 'remarcar') && s.provider ? `/regulacao/prestadores/${s.provider.id}/agendas` : null, [
    acao,
    s?.provider?.id,
  ]);
  const agendasUnidade = useApi<{ id: string; name: string }[]>(s && (acao === 'agendar' || acao === 'remarcar') && !s.provider && s.providerUnit ? `/scheduling/schedules?unitId=${s.providerUnit.id}` : null, [
    acao,
    s?.providerUnit?.id,
  ]);

  useEffect(() => {
    setAcao(null);
    setTexto('');
    setPrioridade('');
    setPrestador('');
    setAgenda('');
    setSlot(null);
    setErro(null);
  }, [id]);
  useEffect(() => {
    if (acao === 'remarcar' && s?.agendamento) setAgenda(s.agendamento.schedule.id);
    if (acao === 'agendar' || acao === 'remarcar') {
      setSlot(null);
      setData(todayIso(1));
    }
  }, [acao, s?.agendamento]);

  async function executar() {
    if (!s || !acao) return;
    setErro(null);
    setBusy(true);
    try {
      if (acao === 'autorizar') await api.post(`/regulacao/solicitacoes/${s.id}/autorizar`, { priority: prioridade || undefined, providerId: prestador || null, notes: texto.trim() || null });
      else if (acao === 'complementar') await api.post(`/regulacao/solicitacoes/${s.id}/complementar`, { notes: texto.trim(), priority: prioridade || undefined });
      else if (acao === 'mensagem') await api.post(`/regulacao/solicitacoes/${s.id}/mensagem`, { notes: texto.trim() });
      else if (acao === 'agendar') {
        if (!agenda || !slot) throw new Error('Escolha a agenda e um horário livre');
        await api.post(`/regulacao/solicitacoes/${s.id}/agendar`, { scheduleId: agenda, startsAt: slot.startsAt });
      } else if (acao === 'remarcar') {
        if (!slot) throw new Error('Escolha um horário livre');
        await api.post(`/regulacao/solicitacoes/${s.id}/remarcar`, { startsAt: slot.startsAt });
      } else if (acao === 'realizar') await api.post(`/regulacao/solicitacoes/${s.id}/realizar`, { notes: texto.trim() || null });
      else await api.post(`/regulacao/solicitacoes/${s.id}/${acao}`, { reason: texto.trim() });
      toast.success(SUCESSO[acao]);
      setAcao(null);
      setTexto('');
      await det.reload();
      onChanged();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function simples(path: 'analisar' | 'falta') {
    if (!s) return;
    setBusy(true);
    try {
      await api.post(`/regulacao/solicitacoes/${s.id}/${path}`);
      toast.success(path === 'falta' ? 'Falta registrada: a solicitação voltou a autorizada para reagendar' : 'Análise assumida');
      await det.reload();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const listaAgendas = agendas.data?.agendas ?? (agendasUnidade.data ?? []).map((a) => ({ id: a.id, name: a.name, cbo: '', slotMinutes: 0, profissional: null, proximos: [] }));
  const precisaMotivo = acao === 'devolver' || acao === 'negar' || acao === 'cancelar' || acao === 'desmarcar' || acao === 'complementar' || acao === 'mensagem';

  return (
    <Dialog
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title={s ? `${s.protocol} · ${s.procedureName}` : 'Solicitação'}
      description={s ? `${s.patient.name} · ${s.patient.age} anos · solicitada em ${fmtDateTime(s.createdAt)} por ${s.requester.name ?? '—'} (${s.unit.name ?? '—'})` : undefined}
      size="xl"
    >
      {det.error && <Alert tone="error">{det.error}</Alert>}
      {!s && !det.error && <Spinner />}
      {s && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[s.status]}>{s.statusLabel}</Badge>
            <Badge tone={PRIORIDADE_TONE[s.priority]}>
              {s.priorityLabel}
              {s.requestedPriority !== s.priority ? ` (pedida: ${PRIORIDADES[s.requestedPriority].label.toLowerCase()})` : ''}
            </Badge>
            {naFila && (
              <span className="text-sm text-slate-600">
                {s.diasEmFila} dia(s) na fila · prazo-meta {fmtDate(s.prazoMeta)}
                {s.atrasada ? ' · atrasada' : ''}
              </span>
            )}
            {s.provider ? (
              <Badge tone="violet">
                Executante: {s.provider.name}
                {s.quotaId ? ' · cota' : ''}
              </Badge>
            ) : (
              s.providerUnit && <Badge tone="violet">Executante: {s.providerUnit.name}</Badge>
            )}
            {s.returnedCount > 0 && <Badge tone="amber">devolvida {s.returnedCount}x</Badge>}
            {s.noShowCount > 0 && <Badge tone="red">{s.noShowCount} falta(s)</Badge>}
          </div>
          {s.agendamento && (
            <Alert tone={s.agendamento.status === 'CONFIRMADO' ? 'success' : 'info'} title={`Agendado para ${fmtDateTime(s.agendamento.startsAt)}`}>
              {s.agendamento.schedule.name} · {s.agendamento.unit.name ?? ''} ·{' '}
              {s.agendamento.status === 'CONFIRMADO' ? `presença confirmada${s.agendamento.confirmedAt ? ` em ${fmtDateTime(s.agendamento.confirmedAt)}` : ''}` : 'aguardando confirmação do cidadão (WhatsApp)'}
            </Alert>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="mb-1 font-semibold">Quadro clínico</p>
              <p className="whitespace-pre-wrap text-slate-700">{s.clinicalSummary}</p>
              {s.cid && <p className="mt-1 text-slate-500">CID-10 {s.cid}</p>}
              {s.priorityJustification && (
                <p className="mt-2">
                  <span className="font-semibold">Justificativa da prioridade:</span> {s.priorityJustification}
                </p>
              )}
              {s.criteria.length > 0 && (
                <ul className="mt-2 list-inside list-disc text-slate-700">
                  {s.criteria.map((c) => (
                    <li key={c.codigo}>{c.descricao}</li>
                  ))}
                </ul>
              )}
              {s.protocolIssues.length > 0 && (
                <Alert tone="warn" className="mt-2" title="Pendências do protocolo">
                  <ul className="list-inside list-disc">
                    {s.protocolIssues.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              {s.anexos.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {s.anexos.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50"
                      onClick={() => void abrirAnexo(s.patient.id, a.documentId)}
                    >
                      <Paperclip className="h-3 w-3" /> {a.kind ?? 'Documento'} · {a.createdAt ? fmtDate(a.createdAt) : ''}
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="mb-1 font-semibold">Histórico e devolutiva</p>
              <ol className="flex flex-col gap-2">
                {s.eventos.map((e) => (
                  <li key={e.id} className="border-l-2 border-slate-200 pl-2">
                    <p className="text-xs text-slate-500">
                      {fmtDateTime(e.at)} · {e.usuario ?? '—'}
                    </p>
                    <p className="font-medium">{EVENTO_LABEL[e.kind] ?? e.kind}</p>
                    {e.notes && <p className="whitespace-pre-wrap text-slate-700">{e.notes}</p>}
                  </li>
                ))}
              </ol>
            </section>
          </div>
          {erro && <Alert tone="error">{erro}</Alert>}
          {acao ? (
            <section className="rounded-lg border border-brand-200 bg-brand-50/40 p-3">
              <p className="mb-2 text-sm font-semibold">{TITULO[acao]}</p>
              {(acao === 'autorizar' || acao === 'complementar') && (
                <div className="mb-2 grid gap-3 sm:grid-cols-2">
                  <Field label={acao === 'autorizar' ? 'Reclassificar prioridade (opcional)' : 'Nova prioridade (opcional)'} htmlFor="reg-acao-prio">
                    <Select id="reg-acao-prio" value={prioridade} onChange={(e) => setPrioridade(e.target.value as PrioridadeRegulacao | '')}>
                      <option value="">Manter {s.priorityLabel.toLowerCase()}</option>
                      {(Object.keys(PRIORIDADES) as PrioridadeRegulacao[]).map((p) => (
                        <option key={p} value={p}>
                          {PRIORIDADES[p].label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {acao === 'autorizar' && (
                    <Field label="Prestador executante" htmlFor="reg-acao-prestador" hint={ofertas.data ? `Cotas da competência ${ofertas.data.competencia}` : undefined}>
                      <Select id="reg-acao-prestador" value={prestador} onChange={(e) => setPrestador(e.target.value)}>
                        <option value="">A definir no agendamento</option>
                        {(ofertas.data?.prestadores ?? []).map((o) => (
                          <option key={o.id} value={o.id} disabled={!o.disponivel}>
                            {o.name} · {o.semCota ? 'sem cota configurada' : o.disponivel ? `${o.cotas.reduce((t, c) => t + c.available, 0)} vaga(s) de ${o.cotas.reduce((t, c) => t + c.quantity, 0)}` : 'cota esgotada'}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>
              )}
              {(acao === 'agendar' || acao === 'remarcar') && (
                <div className="mb-2 flex flex-col gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Agenda" htmlFor="reg-acao-agenda">
                      <Select id="reg-acao-agenda" value={agenda} disabled={acao === 'remarcar'} onChange={(e) => setAgenda(e.target.value)}>
                        <option value="">Escolha…</option>
                        {listaAgendas.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                            {a.profissional ? ` · ${a.profissional}` : ''}
                            {a.proximos[0] ? ` · próximo ${fmtDateTime(a.proximos[0].startsAt)}` : ''}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Dia" htmlFor="reg-acao-dia">
                      <Input
                        id="reg-acao-dia"
                        type="date"
                        value={data}
                        onChange={(e) => {
                          setData(e.target.value);
                          setSlot(null);
                        }}
                      />
                    </Field>
                  </div>
                  {!s.provider && !s.providerUnit && <Alert tone="warn">A solicitação foi autorizada sem prestador: defina o prestador (autorização) para listar as agendas.</Alert>}
                  {agenda && <SlotPicker scheduleId={agenda} date={data} onPick={setSlot} />}
                  {slot && (
                    <p className="text-sm">
                      Horário escolhido: <b>{fmtDateTime(slot.startsAt)}</b>
                    </p>
                  )}
                </div>
              )}
              {(precisaMotivo || acao === 'autorizar' || acao === 'realizar') && (
                <Field label={acao === 'autorizar' || acao === 'realizar' ? 'Orientações (opcional)' : acao === 'mensagem' ? 'Mensagem' : 'Motivo'} htmlFor="reg-acao-texto">
                  <Textarea id="reg-acao-texto" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} />
                </Field>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setAcao(null)} disabled={busy}>
                  Voltar
                </Button>
                <Button onClick={executar} loading={busy} variant={acao === 'negar' || acao === 'cancelar' ? 'danger' : 'primary'} id="reg-acao-confirmar" disabled={precisaMotivo && texto.trim().length < 5}>
                  Confirmar
                </Button>
              </div>
            </section>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              {regula && s.status === 'PENDENTE' && (
                <Button variant="secondary" onClick={() => simples('analisar')} loading={busy}>
                  Assumir análise
                </Button>
              )}
              {regula && naFila && (
                <>
                  <Button onClick={() => setAcao('autorizar')} id="reg-autorizar">
                    Autorizar
                  </Button>
                  <Button variant="secondary" onClick={() => setAcao('devolver')}>
                    Devolver
                  </Button>
                  <Button variant="danger" onClick={() => setAcao('negar')}>
                    Negar
                  </Button>
                </>
              )}
              {regula && s.status === 'DEVOLVIDA' && (
                <Button variant="danger" onClick={() => setAcao('negar')}>
                  Negar
                </Button>
              )}
              {(regula || executante) && s.status === 'AUTORIZADA' && (
                <Button onClick={() => setAcao('agendar')} id="reg-agendar">
                  <CalendarCheck className="h-4 w-4" /> Agendar
                </Button>
              )}
              {(regula || executante) && s.status === 'AGENDADA' && (
                <>
                  <Button variant="secondary" onClick={() => setAcao('remarcar')}>
                    Remarcar
                  </Button>
                  <Button variant="secondary" onClick={() => setAcao('desmarcar')}>
                    Desmarcar
                  </Button>
                  <Button variant="secondary" onClick={() => simples('falta')} loading={busy}>
                    Faltou
                  </Button>
                  <Button variant="success" onClick={() => setAcao('realizar')}>
                    Realizada
                  </Button>
                </>
              )}
              {solicita && (minhaUnidade || regula) && s.status === 'DEVOLVIDA' && (
                <Button onClick={() => setAcao('complementar')} id="reg-complementar">
                  Complementar e reenviar
                </Button>
              )}
              {(regula || (solicita && minhaUnidade)) && ['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'AGENDADA'].includes(s.status) && (
                <Button variant="ghost" onClick={() => setAcao('cancelar')}>
                  Cancelar solicitação
                </Button>
              )}
              {(regula || (solicita && minhaUnidade)) && !s.closedAt && (
                <Button variant="ghost" onClick={() => setAcao('mensagem')}>
                  Mensagem
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

async function abrirAnexo(patientId: string, documentId: string) {
  try {
    const { blob } = await api.download(`/patients/${patientId}/documents/${documentId}/content`);
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  } catch {
    // o navegador pode bloquear a janela; o documento continua no cadastro do paciente
  }
}
