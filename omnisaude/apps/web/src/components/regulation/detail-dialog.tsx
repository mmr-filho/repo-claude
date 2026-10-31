'use client';

import { PRIORIDADES, type PrioridadeRegulacao } from '@omnisaude/shared';
import { Paperclip } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { EVENTO_LABEL, PRIORIDADE_TONE, STATUS_TONE, type SolicitacaoDetalhe } from './types';

type Acao = 'autorizar' | 'devolver' | 'negar' | 'complementar' | 'cancelar' | 'mensagem';

/** Detalhe da solicitação: protocolo, quadro clínico, pendências, anexos, histórico e as ações de quem regula ou de quem solicitou. */
export function DetailDialog({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const session = useSession();
  const toast = useToast();
  const det = useApi<SolicitacaoDetalhe>(id ? `/regulacao/solicitacoes/${id}` : null, [id]);
  const directory = useApi<{ units: { id: string; name: string; type: string }[] }>(id && session.can('regulacao.regular') ? '/directory' : null, [id]);
  const [acao, setAcao] = useState<Acao | null>(null);
  const [texto, setTexto] = useState('');
  const [prioridade, setPrioridade] = useState<PrioridadeRegulacao | ''>('');
  const [unidade, setUnidade] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    setAcao(null);
    setTexto('');
    setPrioridade('');
    setUnidade('');
    setErro(null);
  }, [id]);

  const s = det.data;
  const regula = session.can('regulacao.regular');
  const solicita = session.can('regulacao.solicitar');
  const minhaUnidade = s?.unit.id === session.me?.context.unitId;
  const naFila = s?.status === 'PENDENTE' || s?.status === 'EM_ANALISE';

  async function executar() {
    if (!s || !acao) return;
    setErro(null);
    setBusy(true);
    try {
      if (acao === 'autorizar') await api.post(`/regulacao/solicitacoes/${s.id}/autorizar`, { priority: prioridade || undefined, providerUnitId: unidade || null, notes: texto.trim() || null });
      else if (acao === 'complementar') await api.post(`/regulacao/solicitacoes/${s.id}/complementar`, { notes: texto.trim(), priority: prioridade || undefined });
      else if (acao === 'mensagem') await api.post(`/regulacao/solicitacoes/${s.id}/mensagem`, { notes: texto.trim() });
      else await api.post(`/regulacao/solicitacoes/${s.id}/${acao}`, { reason: texto.trim() });
      toast.success(
        {
          autorizar: 'Solicitação autorizada',
          devolver: 'Devolvida ao solicitante',
          negar: 'Solicitação negada',
          complementar: 'Complementação enviada: a solicitação voltou à fila',
          cancelar: 'Solicitação cancelada',
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

  async function analisar() {
    if (!s) return;
    setBusy(true);
    try {
      await api.post(`/regulacao/solicitacoes/${s.id}/analisar`);
      await det.reload();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const unidades = (directory.data?.units ?? []).filter((u) => ['POLICLINICA', 'HOSPITAL', 'CEO', 'LABORATORIO', 'UPA'].includes(u.type));

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
            {s.providerUnit && <Badge tone="violet">Executante: {s.providerUnit.name}</Badge>}
            {s.returnedCount > 0 && <Badge tone="amber">devolvida {s.returnedCount}x</Badge>}
          </div>
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
                    <a
                      key={a.id}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50"
                      href={`#anexo-${a.documentId}`}
                      onClick={(e) => {
                        e.preventDefault();
                        void abrirAnexo(s.patient.id, a.documentId);
                      }}
                    >
                      <Paperclip className="h-3 w-3" /> {a.kind ?? 'Documento'} · {a.createdAt ? fmtDate(a.createdAt) : ''}
                    </a>
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
              <p className="mb-2 text-sm font-semibold">
                {
                  { autorizar: 'Autorizar', devolver: 'Devolver com pendência', negar: 'Negar', complementar: 'Complementar a solicitação', cancelar: 'Cancelar a solicitação', mensagem: 'Mensagem para a outra parte' }[
                    acao
                  ]
                }
              </p>
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
                    <Field label="Unidade executante" htmlFor="reg-acao-unidade">
                      <Select id="reg-acao-unidade" value={unidade} onChange={(e) => setUnidade(e.target.value)}>
                        <option value="">A definir no agendamento</option>
                        {unidades.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>
              )}
              <Field label={acao === 'autorizar' ? 'Orientações (opcional)' : acao === 'mensagem' ? 'Mensagem' : 'Motivo'} htmlFor="reg-acao-texto">
                <Textarea id="reg-acao-texto" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} />
              </Field>
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setAcao(null)} disabled={busy}>
                  Voltar
                </Button>
                <Button onClick={executar} loading={busy} variant={acao === 'negar' || acao === 'cancelar' ? 'danger' : 'primary'} id="reg-acao-confirmar" disabled={acao !== 'autorizar' && texto.trim().length < 5}>
                  Confirmar
                </Button>
              </div>
            </section>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              {regula && s.status === 'PENDENTE' && (
                <Button variant="secondary" onClick={analisar} loading={busy}>
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
