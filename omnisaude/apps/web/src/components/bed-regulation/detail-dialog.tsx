'use client';

import { PRIORIDADE_LEITO, TIPO_LEITO, TRANSPORTE_TRANSFERENCIA, type PrioridadeRegulacao, type TipoLeito, type TransporteTransferencia } from '@omnisaude/shared';
import { FileDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { EVENTO_LEITO, PRIORIDADE_LEITO_TONE, RISCO_NEWS2, STATUS_LEITO_TONE, type Mapa, type SolicitacaoLeito } from './types';

type Acao = 'analisar' | 'devolver' | 'segunda-pedir' | 'segunda' | 'autorizar' | 'negar' | 'transferir' | 'internar' | 'cancelar' | 'mensagem';
const TITULO: Record<Acao, string> = {
  analisar: 'Assumir a análise',
  devolver: 'Devolver com pendência',
  'segunda-pedir': 'Pedir segunda avaliação',
  segunda: 'Registrar segunda avaliação',
  autorizar: 'Autorizar a vaga',
  negar: 'Negar a solicitação',
  transferir: 'Registrar a transferência',
  internar: 'Internar no destino',
  cancelar: 'Cancelar a solicitação',
  mensagem: 'Mensagem',
};

/** Detalhe da solicitação de vaga: quadro clínico, NEWS2, histórico e as ações do regulador, da origem e do destino. */
export function BedRequestDetailDialog({ id, onClose, onChanged, onComplementar }: { id: string | null; onClose: () => void; onChanged: () => void; onComplementar: (s: SolicitacaoLeito) => void }) {
  const session = useSession();
  const toast = useToast();
  const det = useApi<SolicitacaoLeito>(id ? `/regulacao-leitos/solicitacoes/${id}` : null, [id]);
  const regula = session.can('leitos_rede.regular');
  const solicita = session.can('leitos_rede.solicitar');
  const gereLeitos = session.can('leitos.gerir');
  const [acao, setAcao] = useState<Acao | null>(null);
  const [texto, setTexto] = useState('');
  const [prioridade, setPrioridade] = useState<PrioridadeRegulacao | ''>('');
  const [unidade, setUnidade] = useState('');
  const [tipo, setTipo] = useState<TipoLeito>('CLINICA_MEDICA');
  const [leito, setLeito] = useState('');
  const [transporte, setTransporte] = useState<TransporteTransferencia | ''>('');
  const [quando, setQuando] = useState('');
  const [cid, setCid] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const mapa = useApi<Mapa>(acao === 'autorizar' || acao === 'internar' ? '/regulacao-leitos/mapa' : null, [acao]);
  const s = det.data;
  const me = session.me!;

  useEffect(() => {
    setAcao(null);
    setTexto('');
    setErro(null);
  }, [id]);
  useEffect(() => {
    if (!s) return;
    setTexto('');
    setPrioridade('');
    if (acao === 'autorizar') {
      setUnidade(s.destination?.unitId ?? '');
      setTipo((s.destination?.kind ?? s.bedKind) as TipoLeito);
      setLeito(s.destination?.bed?.id ?? '');
      setTransporte((s.transport as TransporteTransferencia | null) ?? '');
    }
    if (acao === 'transferir') {
      setTransporte((s.transport as TransporteTransferencia | null) ?? 'AMBULANCIA_BASICA');
      setQuando('');
    }
    if (acao === 'internar') {
      setLeito(s.destination?.bed?.id ?? '');
      setCid(s.cid ?? '');
    }
  }, [acao, s]);

  async function executar() {
    if (!s || !acao) return;
    setErro(null);
    setBusy(true);
    const base = `/regulacao-leitos/solicitacoes/${s.id}`;
    try {
      if (acao === 'analisar') await api.post(`${base}/analisar`);
      else if (acao === 'devolver') await api.post(`${base}/devolver`, { reason: texto.trim() });
      else if (acao === 'segunda-pedir') await api.post(`${base}/segunda-avaliacao/pedir`, { notes: texto.trim() });
      else if (acao === 'segunda') await api.post(`${base}/segunda-avaliacao`, { notes: texto.trim(), priority: prioridade || null });
      else if (acao === 'autorizar')
        await api.post(`${base}/autorizar`, { destinationUnitId: unidade, destinationKind: tipo, bedId: leito || null, transport: transporte || null, priority: prioridade || null, notes: texto.trim() });
      else if (acao === 'negar') await api.post(`${base}/negar`, { reason: texto.trim() });
      else if (acao === 'transferir') await api.post(`${base}/transferir`, { transport: transporte, transferAt: quando ? new Date(quando).toISOString() : null, notes: texto.trim() || null });
      else if (acao === 'internar') await api.post(`${base}/internar`, { bedId: leito || null, mainCid: cid.trim() || null });
      else if (acao === 'cancelar') await api.post(`${base}/cancelar`, { reason: texto.trim() });
      else await api.post(`${base}/mensagem`, { notes: texto.trim() });
      toast.success(TITULO[acao]);
      setAcao(null);
      await det.reload();
      onChanged();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function pdf() {
    if (!s) return;
    try {
      const { blob, fileName } = await api.download(`/regulacao-leitos/solicitacoes/${s.id}/ficha.pdf`);
      saveBlob(blob, fileName ?? `vaga-${s.protocol}.pdf`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const naFila = !!s && (s.status === 'PENDENTE' || s.status === 'EM_ANALISE');
  const aberta = !!s && ['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'EM_TRANSFERENCIA'].includes(s.status);
  const daOrigem = !!s && s.originUnit.id === me.context.unitId;
  const doDestino = !!s && s.destination?.unitId === me.context.unitId;
  const unidadeMapa = mapa.data?.unidades.find((u) => u.unit.id === (acao === 'internar' ? s?.destination?.unitId : unidade));
  const leitosVagos = (unidadeMapa?.leitosVagos ?? []).filter((b) => (acao === 'internar' ? !s?.destination?.kind || b.kind === s.destination.kind : b.kind === tipo));
  const precisaTexto = ['devolver', 'segunda-pedir', 'segunda', 'autorizar', 'negar', 'cancelar', 'mensagem'].includes(acao ?? '');
  const v = s?.vitals;

  return (
    <Dialog
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title={s ? `${s.protocol} · ${s.bedKindLabel} · ${s.specialty}` : 'Solicitação de vaga'}
      description={s ? `${s.patient.name} · ${s.patient.age} anos · ${s.originUnit.name ?? '—'} · ${s.requester.name ?? '—'} · ${fmtDateTime(s.createdAt)}` : undefined}
      size="xl"
    >
      {det.error && <Alert tone="error">{det.error}</Alert>}
      {!s && !det.error && <Spinner />}
      {s && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_LEITO_TONE[s.status]}>{s.statusLabel}</Badge>
            <Badge tone={PRIORIDADE_LEITO_TONE[s.priority]}>
              {s.priorityLabel} · {PRIORIDADE_LEITO[s.priority].prazoHoras} h
            </Badge>
            {s.requestedPriority !== s.priority && <Badge tone="slate">pedida: {PRIORIDADE_LEITO[s.requestedPriority].label}</Badge>}
            {s.news2 && (
              <Badge tone={RISCO_NEWS2[s.news2.risco].tone}>
                NEWS2 {s.news2.pontos} · {RISCO_NEWS2[s.news2.risco].label}
              </Badge>
            )}
            {s.isolation !== 'NENHUM' && <Badge tone="violet">isolamento: {s.isolation.toLowerCase()}</Badge>}
            {s.elective && <Badge tone="blue">eletiva</Badge>}
            {s.atrasada && <Badge tone="red">prazo vencido</Badge>}
            {naFila && <span className="text-xs text-slate-500">{s.horasEmFila} h na fila</span>}
            <Button size="sm" variant="secondary" className="ml-auto" onClick={pdf}>
              <FileDown className="h-4 w-4" /> Ficha (PDF)
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="mb-1 font-semibold">Quadro clínico</p>
              {s.cid && <p className="text-slate-600">CID-10 {s.cid}</p>}
              <p className="whitespace-pre-wrap">{s.clinicalSummary}</p>
              {v && (
                <p className="mt-2 text-slate-700">
                  {[
                    v.pas != null ? `PA ${v.pas}/${v.pad ?? '—'}` : null,
                    v.fc != null ? `FC ${v.fc}` : null,
                    v.fr != null ? `FR ${v.fr}` : null,
                    v.sato2 != null ? `SatO2 ${v.sato2}%` : null,
                    v.temp != null ? `T ${v.temp} °C` : null,
                    v.consciencia ? v.consciencia.toLowerCase() : null,
                    v.oxigenio ? 'em O2' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
              <p className="mt-1 text-slate-600">
                Suporte:{' '}
                {Object.entries(s.support)
                  .filter(([, on]) => on)
                  .map(([k]) => ({ ventilacaoMecanica: 'ventilação mecânica', drogaVasoativa: 'droga vasoativa', oxigenio: 'oxigênio', dialise: 'diálise' })[k] ?? k)
                  .join(', ') || 'nenhum'}
              </p>
            </section>
            <section className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="mb-1 font-semibold">Regulação</p>
              {s.regulator && <p className="text-slate-600">Regulador: {s.regulator.name}</p>}
              {s.decision && (
                <Alert
                  tone={s.status === 'NEGADA' ? 'error' : s.status === 'DEVOLVIDA' ? 'warn' : 'success'}
                  className="mt-1"
                  title={`${s.status === 'DEVOLVIDA' ? 'Pendência' : 'Decisão'} em ${fmtDateTime(s.decision.at)}`}
                >
                  {s.decision.reason}
                </Alert>
              )}
              {s.secondOpinion && (
                <Alert tone="info" className="mt-2" title={s.secondOpinion.at ? `Segunda avaliação · ${s.secondOpinion.by ?? ''}` : 'Segunda avaliação pedida'}>
                  {s.secondOpinion.notes ?? 'Aguardando outro regulador.'}
                </Alert>
              )}
              {s.destination && (
                <p className="mt-2">
                  <b>Destino:</b> {s.destination.unitName} · {s.destination.kindLabel}
                  {s.destination.bed ? ` · leito ${s.destination.bed.code} (${s.destination.bed.ward})` : ' · leito a definir na chegada'}
                </p>
              )}
              {s.transportLabel && (
                <p className="text-slate-700">
                  {s.transportLabel}
                  {s.transferAt ? ` · saída ${fmtDateTime(s.transferAt)}` : ''}
                  {s.transferNotes ? ` · ${s.transferNotes}` : ''}
                </p>
              )}
              {!s.decision && !s.destination && <p className="text-slate-500">Aguardando a central de leitos.</p>}
            </section>
          </div>
          <section className="rounded-lg border border-slate-200 p-3 text-sm">
            <p className="mb-1 font-semibold">Histórico</p>
            <ol className="flex flex-col gap-1">
              {s.eventos.map((e) => (
                <li key={e.id} className="border-l-2 border-slate-200 pl-2">
                  <span className="text-xs text-slate-500">
                    {fmtDateTime(e.at)} · {e.usuario ?? '—'} ({e.roleLabel})
                  </span>{' '}
                  <b>{EVENTO_LEITO[e.kind] ?? e.kind}</b>
                  {e.notes ? <span className="text-slate-700"> — {e.notes}</span> : null}
                </li>
              ))}
            </ol>
          </section>
          {erro && <Alert tone="error">{erro}</Alert>}
          {acao ? (
            <section className="rounded-lg border border-brand-200 bg-brand-50/40 p-3">
              <p className="mb-2 text-sm font-semibold">{TITULO[acao]}</p>
              {acao === 'autorizar' && (
                <div className="mb-2 grid gap-3 sm:grid-cols-4">
                  <Field label="Hospital / UPA de destino" htmlFor="leito-dest" className="sm:col-span-2">
                    <Select
                      id="leito-dest"
                      value={unidade}
                      onChange={(e) => {
                        setUnidade(e.target.value);
                        setLeito('');
                      }}
                    >
                      <option value="">Escolha…</option>
                      {(mapa.data?.unidades ?? []).map((u) => (
                        <option key={u.unit.id} value={u.unit.id}>
                          {u.unit.name} · {u.totals.VAGO} vago(s) · {u.occupancyRate}%
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Tipo de leito" htmlFor="leito-dest-tipo">
                    <Select
                      id="leito-dest-tipo"
                      value={tipo}
                      onChange={(e) => {
                        setTipo(e.target.value as TipoLeito);
                        setLeito('');
                      }}
                    >
                      {(Object.keys(TIPO_LEITO) as TipoLeito[]).map((k) => (
                        <option key={k} value={k}>
                          {TIPO_LEITO[k]} {unidadeMapa ? `(${unidadeMapa.porTipo.find((p) => p.tipo === k)?.vagos ?? 0} vago(s))` : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Reservar leito" htmlFor="leito-dest-leito">
                    <Select id="leito-dest-leito" value={leito} onChange={(e) => setLeito(e.target.value)}>
                      <option value="">Sem reserva (definir na chegada)</option>
                      {leitosVagos.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.code} · {b.ward}
                          {b.isolation !== 'NENHUM' ? ` · ${b.isolation.toLowerCase()}` : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Transporte" htmlFor="leito-dest-transp" className="sm:col-span-2">
                    <Select id="leito-dest-transp" value={transporte} onChange={(e) => setTransporte(e.target.value as TransporteTransferencia | '')}>
                      <option value="">A definir pela origem</option>
                      {(Object.keys(TRANSPORTE_TRANSFERENCIA) as TransporteTransferencia[]).map((t) => (
                        <option key={t} value={t}>
                          {TRANSPORTE_TRANSFERENCIA[t]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Reclassificar prioridade" htmlFor="leito-dest-prio" className="sm:col-span-2">
                    <Select id="leito-dest-prio" value={prioridade} onChange={(e) => setPrioridade(e.target.value as PrioridadeRegulacao | '')}>
                      <option value="">Manter {s.priorityLabel}</option>
                      {(Object.keys(PRIORIDADE_LEITO) as PrioridadeRegulacao[]).map((p) => (
                        <option key={p} value={p}>
                          {PRIORIDADE_LEITO[p].label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              )}
              {acao === 'segunda' && (
                <Field label="Reclassificar prioridade (opcional)" htmlFor="leito-seg-prio" className="mb-2">
                  <Select id="leito-seg-prio" value={prioridade} onChange={(e) => setPrioridade(e.target.value as PrioridadeRegulacao | '')}>
                    <option value="">Manter {s.priorityLabel}</option>
                    {(Object.keys(PRIORIDADE_LEITO) as PrioridadeRegulacao[]).map((p) => (
                      <option key={p} value={p}>
                        {PRIORIDADE_LEITO[p].label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {acao === 'transferir' && (
                <div className="mb-2 grid gap-3 sm:grid-cols-2">
                  <Field label="Transporte" htmlFor="leito-tr-transp">
                    <Select id="leito-tr-transp" value={transporte} onChange={(e) => setTransporte(e.target.value as TransporteTransferencia)}>
                      {(Object.keys(TRANSPORTE_TRANSFERENCIA) as TransporteTransferencia[]).map((t) => (
                        <option key={t} value={t}>
                          {TRANSPORTE_TRANSFERENCIA[t]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Saída (vazio = agora)" htmlFor="leito-tr-quando">
                    <Input id="leito-tr-quando" type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
                  </Field>
                </div>
              )}
              {acao === 'internar' && (
                <div className="mb-2 grid gap-3 sm:grid-cols-2">
                  <Field label="Leito" htmlFor="leito-int-leito" hint={s.destination?.bed ? `Reservado: ${s.destination.bed.code}` : 'Leitos vagos do tipo autorizado'}>
                    <Select id="leito-int-leito" value={leito} onChange={(e) => setLeito(e.target.value)}>
                      {s.destination?.bed && (
                        <option value={s.destination.bed.id}>
                          {s.destination.bed.code} · {s.destination.bed.ward} (reservado)
                        </option>
                      )}
                      {leitosVagos.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.code} · {b.ward}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="CID principal da internação" htmlFor="leito-int-cid">
                    <Input id="leito-int-cid" value={cid} onChange={(e) => setCid(e.target.value)} />
                  </Field>
                </div>
              )}
              {acao !== 'analisar' && acao !== 'internar' && (
                <Field label={acao === 'mensagem' ? 'Mensagem' : acao === 'transferir' ? 'Observações (opcional)' : acao === 'autorizar' ? 'Orientações à origem' : 'Motivo / parecer'} htmlFor="leito-acao-texto">
                  <Textarea id="leito-acao-texto" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} />
                </Field>
              )}
              {acao === 'analisar' && <p className="text-sm text-slate-600">A solicitação sai de "aguardando" e fica sob a sua análise.</p>}
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setAcao(null)} disabled={busy}>
                  Voltar
                </Button>
                <Button
                  onClick={executar}
                  loading={busy}
                  variant={acao === 'negar' || acao === 'cancelar' ? 'danger' : 'primary'}
                  id="leito-acao-confirmar"
                  disabled={(precisaTexto && texto.trim().length < 3) || (acao === 'autorizar' && !unidade) || (acao === 'internar' && !leito)}
                >
                  Confirmar
                </Button>
              </div>
            </section>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              {regula && naFila && (
                <>
                  {s.status === 'PENDENTE' && (
                    <Button variant="secondary" onClick={() => setAcao('analisar')} id="leito-analisar">
                      Assumir análise
                    </Button>
                  )}
                  <Button onClick={() => setAcao('autorizar')} id="leito-autorizar">
                    Autorizar vaga
                  </Button>
                  <Button variant="secondary" onClick={() => setAcao('devolver')} id="leito-devolver">
                    Devolver
                  </Button>
                  <Button variant="secondary" onClick={() => setAcao(s.regulator?.id && s.regulator.id !== me.user.id ? 'segunda' : 'segunda-pedir')} id="leito-segunda">
                    {s.regulator?.id && s.regulator.id !== me.user.id ? 'Segunda avaliação' : 'Pedir 2ª avaliação'}
                  </Button>
                  <Button variant="danger" onClick={() => setAcao('negar')}>
                    Negar
                  </Button>
                </>
              )}
              {regula && s.status === 'AUTORIZADA' && (
                <Button variant="secondary" onClick={() => setAcao('autorizar')}>
                  Alterar destino / reserva
                </Button>
              )}
              {solicita && s.status === 'DEVOLVIDA' && (daOrigem || regula) && (
                <Button onClick={() => onComplementar(s)} id="leito-complementar">
                  Complementar e reenviar
                </Button>
              )}
              {(solicita || regula) && s.status === 'AUTORIZADA' && (daOrigem || regula) && (
                <Button onClick={() => setAcao('transferir')} id="leito-transferir">
                  Registrar transferência
                </Button>
              )}
              {(gereLeitos || regula) && (s.status === 'AUTORIZADA' || s.status === 'EM_TRANSFERENCIA') && (doDestino || regula) && (
                <Button variant="success" onClick={() => setAcao('internar')} id="leito-internar">
                  Internar
                </Button>
              )}
              {(solicita || regula) && aberta && (daOrigem || regula) && (
                <Button variant="ghost" onClick={() => setAcao('cancelar')}>
                  Cancelar
                </Button>
              )}
              {(solicita || regula) && aberta && (daOrigem || regula) && (
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
