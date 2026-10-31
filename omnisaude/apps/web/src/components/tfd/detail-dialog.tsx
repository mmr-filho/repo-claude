'use client';

import { TIPO_AJUDA_CUSTO, totalAjudaCusto, TRANSPORTE_TFD, type AjudaCustoItem, type TipoAjudaCusto, type TransporteTfd } from '@omnisaude/shared';
import { FileDown, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { EVENTO_TFD, STATUS_TFD_TONE, type ProcessoDetalhe } from './types';

type Acao = 'enviar' | 'parecer' | 'agendar' | 'ajuda' | 'viagem' | 'concluir' | 'cancelar' | 'mensagem';
interface ViagemOpcao {
  id: string;
  date: string;
  departureTime: string;
  destinationCity: string;
  destinationUf: string;
  destinationPlace: string | null;
  status: string;
  vehicle: { plate: string; model: string; wheelchair: boolean };
  ocupacao: { usados: number; assentos: number; livres: number };
}

/** Detalhe do processo de TFD com parecer, agendamento, ajuda de custo, transporte, histórico e impressão. */
export function TfdDetailDialog({ id, onClose, onChanged, onEditarLaudo }: { id: string | null; onClose: () => void; onChanged: () => void; onEditarLaudo: (p: ProcessoDetalhe) => void }) {
  const session = useSession();
  const toast = useToast();
  const det = useApi<ProcessoDetalhe>(id ? `/tfd/processos/${id}` : null, [id]);
  const gere = session.can('tfd.gerir');
  const [acao, setAcao] = useState<Acao | null>(null);
  const [texto, setTexto] = useState('');
  const [deferido, setDeferido] = useState(true);
  const [ajudaAprovada, setAjudaAprovada] = useState(true);
  const [transporte, setTransporte] = useState<TransporteTfd | ''>('');
  const [quando, setQuando] = useState('');
  const [local, setLocal] = useState('');
  const [itens, setItens] = useState<AjudaCustoItem[]>([]);
  const [tripId, setTripId] = useState('');
  const [embarque, setEmbarque] = useState('');
  const [cadeirante, setCadeirante] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const viagens = useApi<ViagemOpcao[]>(acao === 'viagem' ? `/transporte/viagens?from=${todayIso()}&status=PLANEJADA` : null, [acao]);
  const p = det.data;

  useEffect(() => {
    setAcao(null);
    setTexto('');
    setErro(null);
  }, [id]);
  useEffect(() => {
    if (!p) return;
    if (acao === 'ajuda') setItens(p.allowance.itens.map((i) => ({ tipo: i.tipo, beneficiario: i.beneficiario, quantidade: i.quantidade, valorUnitario: i.valorUnitario, descricao: i.descricao ?? null })));
    if (acao === 'agendar') {
      setQuando(p.appointment ? new Date(new Date(p.appointment.at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
      setLocal(p.appointment?.place ?? p.destination.unit ?? '');
    }
    if (acao === 'parecer') {
      setDeferido(true);
      setAjudaAprovada(true);
      setTransporte('');
    }
    if (acao === 'viagem') {
      setTripId('');
      setEmbarque('');
      setCadeirante(false);
    }
  }, [acao, p]);

  async function executar() {
    if (!p || !acao) return;
    setErro(null);
    setBusy(true);
    try {
      if (acao === 'enviar') await api.post(`/tfd/processos/${p.id}/enviar`, { notes: texto.trim() || null });
      else if (acao === 'parecer') await api.post(`/tfd/processos/${p.id}/parecer`, { deferido, notes: texto.trim(), allowanceApproved: deferido ? ajudaAprovada : false, transport: transporte || null });
      else if (acao === 'agendar') await api.post(`/tfd/processos/${p.id}/agendar`, { appointmentAt: new Date(quando).toISOString(), appointmentPlace: local.trim(), notes: texto.trim() || null });
      else if (acao === 'ajuda') await api.put(`/tfd/processos/${p.id}/ajuda-custo`, { itens });
      else if (acao === 'viagem') await api.post(`/tfd/processos/${p.id}/viagem`, { tripId, pickupAddress: embarque.trim() || null, wheelchair: cadeirante });
      else if (acao === 'concluir') await api.post(`/tfd/processos/${p.id}/concluir`, { notes: texto.trim() || null });
      else if (acao === 'cancelar') await api.post(`/tfd/processos/${p.id}/cancelar`, { reason: texto.trim() });
      else await api.post(`/tfd/processos/${p.id}/mensagem`, { notes: texto.trim() });
      toast.success(
        {
          enviar: 'Processo enviado',
          parecer: 'Parecer registrado',
          agendar: 'Atendimento agendado',
          ajuda: 'Ajuda de custo lançada',
          viagem: 'Transporte reservado',
          concluir: 'Processo concluído',
          cancelar: 'Processo cancelado',
          mensagem: 'Mensagem registrada',
        }[acao],
      );
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

  async function simples(path: 'ajuda-custo/pagar' | 'viagem/cancelar') {
    if (!p) return;
    setBusy(true);
    try {
      await api.post(`/tfd/processos/${p.id}/${path}`);
      toast.success(path === 'ajuda-custo/pagar' ? 'Ajuda de custo marcada como paga' : 'Reserva de transporte cancelada');
      await det.reload();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function pdf(kind: 'laudo' | 'guia') {
    if (!p) return;
    try {
      const { blob, fileName } = await api.download(`/tfd/processos/${p.id}/${kind}.pdf`);
      saveBlob(blob, fileName ?? `tfd-${kind}.pdf`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const totais = totalAjudaCusto(itens);
  const precisaTexto = acao === 'parecer' || acao === 'cancelar' || acao === 'mensagem';
  const aberto = !!p && ['ABERTO', 'ENVIADO', 'DEFERIDO', 'AGENDADO'].includes(p.status);

  return (
    <Dialog
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title={p ? `${p.protocol} · ${p.procedureName}` : 'Processo de TFD'}
      description={p ? `${p.patient.name} · ${p.patient.age} anos · aberto em ${fmtDateTime(p.createdAt)} por ${p.requester.name ?? '—'} (${p.unit.name ?? '—'})` : undefined}
      size="xl"
    >
      {det.error && <Alert tone="error">{det.error}</Alert>}
      {!p && !det.error && <Spinner />}
      {p && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TFD_TONE[p.status]}>{p.statusLabel}</Badge>
            {p.urgency && <Badge tone="red">urgência</Badge>}
            <Badge tone="slate">
              {p.destination.city}/{p.destination.uf}
            </Badge>
            <Badge tone="slate">{p.transportLabel}</Badge>
            {p.companion && <Badge tone="violet">com acompanhante</Badge>}
            {p.solicitacao && <Badge tone="blue">Regulação {p.solicitacao.protocol}</Badge>}
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="secondary" onClick={() => pdf('laudo')} id="tfd-pdf-laudo">
                <FileDown className="h-4 w-4" /> Laudo (PDF)
              </Button>
              <Button size="sm" variant="secondary" onClick={() => pdf('guia')}>
                <FileDown className="h-4 w-4" /> Guia de viagem (PDF)
              </Button>
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="mb-1 font-semibold">Laudo</p>
              <p>
                <b>{p.diagnosis}</b>
                {p.cid ? ` (CID-10 ${p.cid})` : ''}
              </p>
              <p className="whitespace-pre-wrap text-slate-700">{p.clinicalSummary}</p>
              <p className="mt-1">
                <span className="font-semibold">Procedimento:</span> {p.procedureName}
                {p.procedureCode ? ` · SIGTAP ${p.procedureCode}` : ''}
              </p>
              <p className="mt-1">
                <span className="font-semibold">Justificativa:</span> {p.justification}
              </p>
              <p className="mt-1 text-slate-600">
                Destino: {p.destination.city}/{p.destination.uf}
                {p.destination.unit ? ` · ${p.destination.unit}` : ''} · {p.transportLabel}
                {p.accommodation ? ' · pernoite' : ''}
              </p>
              {p.companion && (
                <p className="text-slate-600">
                  Acompanhante: {p.companion.name}
                  {p.companion.relation ? ` (${p.companion.relation})` : ''}
                </p>
              )}
              {p.opinion && (
                <Alert tone={p.status === 'INDEFERIDO' ? 'error' : 'success'} className="mt-2" title={`Parecer em ${fmtDate(p.opinion.at)}${p.opinion.by ? ` · ${p.opinion.by}` : ''}`}>
                  {p.opinion.notes} · ajuda de custo {p.opinion.allowanceApproved ? 'aprovada' : 'não aprovada'}
                </Alert>
              )}
              {p.appointment && (
                <Alert tone="info" className="mt-2" title={`Atendimento em ${fmtDateTime(p.appointment.at)}`}>
                  {p.appointment.place}
                  {p.appointment.notes ? ` · ${p.appointment.notes}` : ''}
                </Alert>
              )}
            </section>
            <section className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="mb-1 font-semibold">Ajuda de custo e transporte</p>
              {p.allowance.itens.length > 0 ? (
                <Table>
                  <THead>
                    <TR>
                      <TH>Item</TH>
                      <TH>Beneficiário</TH>
                      <TH>Qtd × valor</TH>
                      <TH>Total</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {p.allowance.itens.map((i, idx) => (
                      <TR key={idx}>
                        <TD>{i.tipoLabel}</TD>
                        <TD>{i.beneficiario === 'PACIENTE' ? 'Paciente' : 'Acompanhante'}</TD>
                        <TD>
                          {i.quantidade} × {fmtMoney(i.valorUnitario)}
                        </TD>
                        <TD>{fmtMoney(i.total)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <p className="text-slate-500">Sem ajuda de custo lançada{p.opinion && !p.allowance.approved ? ' (não aprovada no parecer)' : ''}.</p>
              )}
              {p.allowance.total > 0 && (
                <p className="mt-1">
                  <b>Total {fmtMoney(p.allowance.total)}</b> · {p.allowance.paidAt ? `paga em ${fmtDate(p.allowance.paidAt)}` : 'a pagar'}
                  {gere && !p.allowance.paidAt && (
                    <Button size="sm" variant="ghost" className="ml-2" onClick={() => simples('ajuda-custo/pagar')} loading={busy}>
                      Marcar como paga
                    </Button>
                  )}
                </p>
              )}
              <div className="mt-3">
                {p.viagem ? (
                  <Alert tone="info" title={`Transporte: ${fmtDate(p.viagem.date)} às ${p.viagem.departureTime} · ${p.viagem.vehicle.model} (${p.viagem.vehicle.plate})`}>
                    {p.viagem.destinationCity}/{p.viagem.destinationUf}
                    {p.viagem.destinationPlace ? ` · ${p.viagem.destinationPlace}` : ''} · motorista {p.viagem.driver.name} · {p.viagem.statusLabel}
                    {p.viagem.passageiro?.pickupAddress ? ` · embarque: ${p.viagem.passageiro.pickupAddress}` : ''}
                    {gere && aberto && p.viagem.status === 'PLANEJADA' && (
                      <Button size="sm" variant="ghost" className="ml-2" onClick={() => simples('viagem/cancelar')} loading={busy}>
                        Cancelar reserva
                      </Button>
                    )}
                  </Alert>
                ) : (
                  <p className="text-slate-500">Sem transporte sanitário reservado.</p>
                )}
              </div>
            </section>
          </div>
          <section className="rounded-lg border border-slate-200 p-3 text-sm">
            <p className="mb-1 font-semibold">Histórico</p>
            <ol className="flex flex-col gap-1">
              {p.eventos.map((e) => (
                <li key={e.id} className="border-l-2 border-slate-200 pl-2">
                  <span className="text-xs text-slate-500">
                    {fmtDateTime(e.at)} · {e.usuario ?? '—'}
                  </span>{' '}
                  <b>{EVENTO_TFD[e.kind] ?? e.kind}</b>
                  {e.notes ? <span className="text-slate-700"> — {e.notes}</span> : null}
                </li>
              ))}
            </ol>
          </section>
          {erro && <Alert tone="error">{erro}</Alert>}
          {acao ? (
            <section className="rounded-lg border border-brand-200 bg-brand-50/40 p-3">
              <p className="mb-2 text-sm font-semibold">
                {
                  {
                    enviar: 'Enviar à regional / estado',
                    parecer: 'Registrar o parecer',
                    agendar: 'Agendar o atendimento no destino',
                    ajuda: 'Ajuda de custo',
                    viagem: 'Reservar transporte sanitário',
                    concluir: 'Concluir o processo',
                    cancelar: 'Cancelar o processo',
                    mensagem: 'Mensagem',
                  }[acao]
                }
              </p>
              {acao === 'parecer' && (
                <div className="mb-2 grid gap-3 sm:grid-cols-3">
                  <Field label="Resultado" htmlFor="tfd-parecer">
                    <Select id="tfd-parecer" value={deferido ? 'sim' : 'nao'} onChange={(e) => setDeferido(e.target.value === 'sim')}>
                      <option value="sim">Deferido</option>
                      <option value="nao">Indeferido</option>
                    </Select>
                  </Field>
                  {deferido && (
                    <>
                      <label className="flex items-center gap-2 text-sm sm:mt-6">
                        <input type="checkbox" checked={ajudaAprovada} onChange={(e) => setAjudaAprovada(e.target.checked)} /> Ajuda de custo aprovada
                      </label>
                      <Field label="Transporte autorizado" htmlFor="tfd-parecer-transp">
                        <Select id="tfd-parecer-transp" value={transporte} onChange={(e) => setTransporte(e.target.value as TransporteTfd | '')}>
                          <option value="">Manter {p.transportLabel.toLowerCase()}</option>
                          {(Object.keys(TRANSPORTE_TFD) as TransporteTfd[]).map((t) => (
                            <option key={t} value={t}>
                              {TRANSPORTE_TFD[t]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </>
                  )}
                </div>
              )}
              {acao === 'agendar' && (
                <div className="mb-2 grid gap-3 sm:grid-cols-2">
                  <Field label="Data e hora" htmlFor="tfd-quando">
                    <Input id="tfd-quando" type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
                  </Field>
                  <Field label="Local" htmlFor="tfd-local">
                    <Input id="tfd-local" value={local} onChange={(e) => setLocal(e.target.value)} />
                  </Field>
                </div>
              )}
              {acao === 'ajuda' && (
                <div className="mb-2 flex flex-col gap-2">
                  {itens.map((i, idx) => (
                    <div key={idx} className="grid gap-2 sm:grid-cols-5">
                      <Select value={i.tipo} onChange={(e) => setItens((x) => x.map((y, j) => (j === idx ? { ...y, tipo: e.target.value as TipoAjudaCusto } : y)))} aria-label="Tipo">
                        {(Object.keys(TIPO_AJUDA_CUSTO) as TipoAjudaCusto[]).map((t) => (
                          <option key={t} value={t}>
                            {TIPO_AJUDA_CUSTO[t]}
                          </option>
                        ))}
                      </Select>
                      <Select value={i.beneficiario} onChange={(e) => setItens((x) => x.map((y, j) => (j === idx ? { ...y, beneficiario: e.target.value as 'PACIENTE' | 'ACOMPANHANTE' } : y)))} aria-label="Beneficiário">
                        <option value="PACIENTE">Paciente</option>
                        {p.companion && <option value="ACOMPANHANTE">Acompanhante</option>}
                      </Select>
                      <Input inputMode="decimal" value={i.quantidade} onChange={(e) => setItens((x) => x.map((y, j) => (j === idx ? { ...y, quantidade: Number(e.target.value) || 0 } : y)))} aria-label="Quantidade" />
                      <Input
                        inputMode="decimal"
                        value={i.valorUnitario}
                        onChange={(e) => setItens((x) => x.map((y, j) => (j === idx ? { ...y, valorUnitario: Number(e.target.value.replace(',', '.')) || 0 } : y)))}
                        aria-label="Valor unitário"
                      />
                      <Button size="sm" variant="ghost" onClick={() => setItens((x) => x.filter((_, j) => j !== idx))} aria-label="Remover item">
                        ×
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <Button size="sm" variant="secondary" onClick={() => setItens((x) => [...x, { tipo: 'DIARIA', beneficiario: 'PACIENTE', quantidade: 1, valorUnitario: 0 }])} id="tfd-ajuda-adicionar">
                      <Plus className="h-4 w-4" /> Item
                    </Button>
                    <span className="text-sm">
                      Total <b>{fmtMoney(totais.total)}</b> (paciente {fmtMoney(totais.porBeneficiario.PACIENTE)} · acompanhante {fmtMoney(totais.porBeneficiario.ACOMPANHANTE)})
                    </span>
                  </div>
                </div>
              )}
              {acao === 'viagem' && (
                <div className="mb-2 grid gap-3 sm:grid-cols-3">
                  <Field label="Viagem" htmlFor="tfd-viagem" className="sm:col-span-2">
                    <Select id="tfd-viagem" value={tripId} onChange={(e) => setTripId(e.target.value)}>
                      <option value="">Escolha…</option>
                      {(viagens.data ?? []).map((v) => (
                        <option key={v.id} value={v.id} disabled={v.ocupacao.livres < 1 + (p.companion ? 1 : 0)}>
                          {fmtDate(v.date)} {v.departureTime} · {v.destinationCity}/{v.destinationUf}
                          {v.destinationPlace ? ` · ${v.destinationPlace}` : ''} · {v.vehicle.plate} · {v.ocupacao.livres} lugar(es)
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 text-sm sm:mt-6">
                    <input type="checkbox" checked={cadeirante} onChange={(e) => setCadeirante(e.target.checked)} /> Cadeirante
                  </label>
                  <Field label="Endereço de embarque (opcional)" htmlFor="tfd-embarque" className="sm:col-span-3">
                    <Input id="tfd-embarque" value={embarque} onChange={(e) => setEmbarque(e.target.value)} placeholder="Padrão: endereço do cadastro" />
                  </Field>
                </div>
              )}
              {acao !== 'ajuda' && acao !== 'viagem' && (
                <Field label={precisaTexto ? (acao === 'mensagem' ? 'Mensagem' : acao === 'parecer' ? 'Parecer' : 'Motivo') : 'Observações (opcional)'} htmlFor="tfd-acao-texto">
                  <Textarea id="tfd-acao-texto" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} />
                </Field>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setAcao(null)} disabled={busy}>
                  Voltar
                </Button>
                <Button
                  onClick={executar}
                  loading={busy}
                  variant={acao === 'cancelar' ? 'danger' : 'primary'}
                  id="tfd-acao-confirmar"
                  disabled={(precisaTexto && texto.trim().length < 3) || (acao === 'agendar' && (!quando || local.trim().length < 3)) || (acao === 'viagem' && !tripId)}
                >
                  Confirmar
                </Button>
              </div>
            </section>
          ) : (
            gere && (
              <div className="flex flex-wrap justify-end gap-2">
                {(p.status === 'ABERTO' || p.status === 'INDEFERIDO') && (
                  <Button variant="secondary" onClick={() => onEditarLaudo(p)}>
                    Editar laudo
                  </Button>
                )}
                {p.status === 'ABERTO' && (
                  <Button onClick={() => setAcao('enviar')} id="tfd-enviar">
                    Enviar à regional
                  </Button>
                )}
                {p.status === 'ENVIADO' && (
                  <Button onClick={() => setAcao('parecer')} id="tfd-parecer-btn">
                    Registrar parecer
                  </Button>
                )}
                {(p.status === 'DEFERIDO' || p.status === 'AGENDADO') && (
                  <>
                    <Button onClick={() => setAcao('agendar')} id="tfd-agendar">
                      {p.appointment ? 'Reagendar' : 'Agendar no destino'}
                    </Button>
                    {p.allowance.approved && (
                      <Button variant="secondary" onClick={() => setAcao('ajuda')} id="tfd-ajuda">
                        Ajuda de custo
                      </Button>
                    )}
                    {!p.viagem && (
                      <Button variant="secondary" onClick={() => setAcao('viagem')} id="tfd-viagem-btn">
                        Reservar transporte
                      </Button>
                    )}
                    <Button variant="success" onClick={() => setAcao('concluir')}>
                      Concluir
                    </Button>
                  </>
                )}
                {aberto && (
                  <Button variant="ghost" onClick={() => setAcao('cancelar')}>
                    Cancelar processo
                  </Button>
                )}
                {aberto && (
                  <Button variant="ghost" onClick={() => setAcao('mensagem')}>
                    Mensagem
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      )}
    </Dialog>
  );
}
