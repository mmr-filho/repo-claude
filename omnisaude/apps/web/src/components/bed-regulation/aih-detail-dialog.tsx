'use client';

import { FileDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { STATUS_AIH_TONE, type Faixa, type Laudo } from './types';

type Acao = 'autorizar' | 'negar' | 'cancelar';

/** Detalhe do laudo de AIH com autorização (faixa ou número manual), negativa, cancelamento e impressão. */
export function AihDetailDialog({ id, onClose, onChanged, onCorrigir }: { id: string | null; onClose: () => void; onChanged: () => void; onCorrigir: (l: Laudo) => void }) {
  const session = useSession();
  const toast = useToast();
  const det = useApi<Laudo>(id ? `/aih/laudos/${id}` : null, [id]);
  const autoriza = session.can('aih.autorizar');
  const solicita = session.can('aih.solicitar');
  const faixas = useApi<Faixa[]>(autoriza && id ? '/aih/faixas' : null, [id, autoriza]);
  const [acao, setAcao] = useState<Acao | null>(null);
  const [modo, setModo] = useState<'faixa' | 'manual'>('faixa');
  const [faixa, setFaixa] = useState('');
  const [numero, setNumero] = useState('');
  const [tipo, setTipo] = useState<'1' | '5'>('1');
  const [validade, setValidade] = useState('');
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const l = det.data;

  useEffect(() => {
    setAcao(null);
    setTexto('');
    setErro(null);
    setNumero('');
    setValidade('');
  }, [id]);
  useEffect(() => {
    if (acao === 'autorizar') setFaixa((faixas.data ?? []).find((f) => f.active && f.restantes > 0)?.id ?? '');
  }, [acao, faixas.data]);

  async function executar() {
    if (!l || !acao) return;
    setErro(null);
    setBusy(true);
    try {
      if (acao === 'autorizar')
        await api.post(`/aih/laudos/${l.id}/autorizar`, {
          aihNumber: modo === 'manual' ? numero : null,
          rangeId: modo === 'faixa' ? faixa || null : null,
          aihType: tipo,
          validUntil: validade || null,
          notes: texto.trim() || null,
        });
      else if (acao === 'negar') await api.post(`/aih/laudos/${l.id}/negar`, { reason: texto.trim() });
      else await api.post(`/aih/laudos/${l.id}/cancelar`, { reason: texto.trim() });
      toast.success({ autorizar: 'AIH autorizada', negar: 'Laudo negado', cancelar: 'Laudo cancelado' }[acao]);
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
    if (!l) return;
    try {
      const { blob, fileName } = await api.download(`/aih/laudos/${l.id}/laudo.pdf`);
      saveBlob(blob, fileName ?? 'aih-laudo.pdf');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title={l ? `AIH · ${l.patient.name}` : 'Laudo de AIH'}
      description={l ? `${l.unit.name ?? '—'} (CNES ${l.unit.cnes ?? '—'}) · emitido por ${l.requester.name ?? '—'} em ${fmtDateTime(l.createdAt)}` : undefined}
      size="xl"
    >
      {det.error && <Alert tone="error">{det.error}</Alert>}
      {!l && !det.error && <Spinner />}
      {l && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_AIH_TONE[l.status]}>{l.statusLabel}</Badge>
            {l.aihNumber && <Badge tone="green">AIH {l.aihNumber}</Badge>}
            {l.vencida && <Badge tone="red">validade vencida</Badge>}
            <Badge tone="slate">
              {l.specialtyCode} · {l.specialtyLabel}
            </Badge>
            <Badge tone="slate">
              {l.nature} · {l.natureLabel}
            </Badge>
            {l.admission && <Badge tone="blue">internação {l.admission.bed ?? ''}</Badge>}
            {l.bedRequest && <Badge tone="violet">vaga {l.bedRequest.protocol}</Badge>}
            <Button size="sm" variant="secondary" className="ml-auto" onClick={pdf} id="aih-pdf">
              <FileDown className="h-4 w-4" /> Laudo (PDF)
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2 text-sm">
            <section className="rounded-lg border border-slate-200 p-3">
              <p className="font-semibold">Procedimento e diagnóstico</p>
              <p>
                {l.procedureCode} · {l.procedureName}
              </p>
              <p className="text-slate-700">
                CID principal {l.mainCid}
                {l.secondaryCid ? ` · secundário ${l.secondaryCid}` : ''}
                {l.associatedCid ? ` · associado ${l.associatedCid}` : ''}
              </p>
              <p className="mt-2 font-semibold">Sinais e sintomas</p>
              <p className="whitespace-pre-wrap">{l.symptoms}</p>
              <p className="mt-2 font-semibold">Condições que justificam a internação</p>
              <p className="whitespace-pre-wrap">{l.conditions}</p>
              <p className="mt-2 font-semibold">Provas diagnósticas</p>
              <p className="whitespace-pre-wrap">{l.diagnostics}</p>
              {l.notes && <p className="mt-1 text-slate-600">{l.notes}</p>}
            </section>
            <section className="rounded-lg border border-slate-200 p-3">
              <p className="font-semibold">Autorização</p>
              {l.status === 'AUTORIZADA' ? (
                <Alert tone="success" title={`AIH ${l.aihNumber} · ${l.aihTypeLabel}`}>
                  Autorizada em {fmtDateTime(l.authorizedAt)}
                  {l.authorizer?.name ? ` por ${l.authorizer.name}` : ''}
                  {l.range ? ` · faixa ${l.range.name}` : ' · número informado'}
                  {l.validUntil ? ` · válida até ${fmtDate(l.validUntil)}` : ''}
                  {l.decisionNotes ? ` · ${l.decisionNotes}` : ''}
                </Alert>
              ) : l.status === 'NEGADA' ? (
                <Alert tone="error" title={`Negada${l.authorizer?.name ? ` por ${l.authorizer.name}` : ''}`}>
                  {l.decisionNotes}
                </Alert>
              ) : l.status === 'CANCELADA' ? (
                <Alert tone="warn" title="Cancelada">
                  {l.decisionNotes}
                </Alert>
              ) : (
                <p className="text-slate-500">Aguardando o autorizador.</p>
              )}
              {l.admission && (
                <p className="mt-2 text-slate-700">
                  Internação desde {fmtDateTime(l.admission.admittedAt)}
                  {l.admission.dischargedAt ? ` · alta em ${fmtDateTime(l.admission.dischargedAt)}` : ' · em curso'}
                </p>
              )}
            </section>
          </div>
          {erro && <Alert tone="error">{erro}</Alert>}
          {acao ? (
            <section className="rounded-lg border border-brand-200 bg-brand-50/40 p-3">
              <p className="mb-2 text-sm font-semibold">{{ autorizar: 'Autorizar e emitir o número da AIH', negar: 'Negar o laudo', cancelar: 'Cancelar o laudo' }[acao]}</p>
              {acao === 'autorizar' && (
                <div className="mb-2 grid gap-3 sm:grid-cols-4">
                  <Field label="Origem do número" htmlFor="aih-modo">
                    <Select id="aih-modo" value={modo} onChange={(e) => setModo(e.target.value as 'faixa' | 'manual')}>
                      <option value="faixa">Faixa numérica do gestor</option>
                      <option value="manual">Informar o número</option>
                    </Select>
                  </Field>
                  {modo === 'faixa' ? (
                    <Field label="Faixa" htmlFor="aih-faixa" className="sm:col-span-2" hint={faixas.data?.length ? undefined : 'Cadastre uma faixa na aba Faixas de AIH'}>
                      <Select id="aih-faixa" value={faixa} onChange={(e) => setFaixa(e.target.value)}>
                        <option value="">Automática (unidade do laudo ou geral)</option>
                        {(faixas.data ?? [])
                          .filter((f) => f.active)
                          .map((f) => (
                            <option key={f.id} value={f.id} disabled={f.restantes === 0}>
                              {f.name} · próximo {f.exemplo} · {f.restantes} restante(s)
                            </option>
                          ))}
                      </Select>
                    </Field>
                  ) : (
                    <Field label="Número da AIH (13 dígitos)" htmlFor="aih-numero" className="sm:col-span-2">
                      <Input id="aih-numero" value={numero} onChange={(e) => setNumero(e.target.value)} inputMode="numeric" />
                    </Field>
                  )}
                  <Field label="Tipo" htmlFor="aih-tipo">
                    <Select id="aih-tipo" value={tipo} onChange={(e) => setTipo(e.target.value as '1' | '5')}>
                      <option value="1">1 · principal</option>
                      <option value="5">5 · longa permanência</option>
                    </Select>
                  </Field>
                  <Field label="Validade (vazio = 30 dias)" htmlFor="aih-validade">
                    <Input id="aih-validade" type="date" value={validade} onChange={(e) => setValidade(e.target.value)} />
                  </Field>
                </div>
              )}
              <Field label={acao === 'autorizar' ? 'Observações (opcional)' : 'Motivo'} htmlFor="aih-acao-texto">
                <Textarea id="aih-acao-texto" rows={2} value={texto} onChange={(e) => setTexto(e.target.value)} />
              </Field>
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setAcao(null)} disabled={busy}>
                  Voltar
                </Button>
                <Button
                  onClick={executar}
                  loading={busy}
                  variant={acao === 'autorizar' ? 'primary' : 'danger'}
                  id="aih-acao-confirmar"
                  disabled={(acao !== 'autorizar' && texto.trim().length < 3) || (acao === 'autorizar' && modo === 'manual' && numero.replace(/\D/g, '').length !== 13)}
                >
                  Confirmar
                </Button>
              </div>
            </section>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              {solicita && l.status === 'PENDENTE' && (
                <Button variant="secondary" onClick={() => onCorrigir(l)}>
                  Corrigir laudo
                </Button>
              )}
              {autoriza && l.status === 'PENDENTE' && (
                <>
                  <Button onClick={() => setAcao('autorizar')} id="aih-autorizar">
                    Autorizar
                  </Button>
                  <Button variant="danger" onClick={() => setAcao('negar')}>
                    Negar
                  </Button>
                </>
              )}
              {((solicita && l.status === 'PENDENTE') || (autoriza && l.status === 'AUTORIZADA')) && (
                <Button variant="ghost" onClick={() => setAcao('cancelar')}>
                  Cancelar laudo
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
