'use client';

import { CAMPOS_FIN, DOMINIO_FIN } from '@omnisaude/shared';
import { BellRing, CheckCircle2, Eye, Lock, Pencil, PhoneCall, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';
import { EVENTO, MEIO, ORIGEM, SITUACAO, STATUS, tempoAte, type Esfera, type NotificacaoDetalhe } from './types';

const paraLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const agoraLocal = () => paraLocal(new Date().toISOString());
const IDADE: Record<string, string> = { H: 'hora(s)', D: 'dia(s)', M: 'mês(es)', A: 'ano(s)' };
const EDITAVEIS_TEXTO = ['ID_DISTRIT', 'NM_REFEREN', 'ID_PAIS'] as const;
const EDITAVEIS_DOMINIO = ['CS_GESTANT', 'CS_RACA', 'CS_ESCOL_N', 'CS_ZONA'] as const;

function valorCampo(campo: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (campo === 'ID_AGRAVO') {
    const a = v as { nome: string; cid: string | null };
    return `${a.nome}${a.cid ? ` (${a.cid})` : ''}`;
  }
  if (campo === 'ID_UNIDADE') {
    const u = v as { nome: string; cnes: string };
    return `${u.nome} · CNES ${u.cnes}`;
  }
  if (campo === 'NU_IDADE_N') {
    const i = v as { valor: number; unidade: string };
    return `${i.valor} ${IDADE[i.unidade] ?? i.unidade}`;
  }
  if (campo === 'TP_NOT') return '2 - Individual';
  if (campo.startsWith('DT_')) return fmtDate(String(v));
  const dom = DOMINIO_FIN[campo];
  if (dom) return `${String(v)} - ${dom[String(v)] ?? '?'}`;
  return String(v);
}

interface Edicao {
  conditionKey: string;
  basis: 'SUSPEITA' | 'CONFIRMADO';
  confirmedAt: string;
  symptomsOnset: string;
  ficha: Record<string, string>;
}

/** Ficha da notificação: prazo por esfera com contagem regressiva, campos da FIN, ações e linha do tempo. */
export function FichaNotificacao({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const toast = useToast();
  const session = useSession();
  const det = useApi<NotificacaoDetalhe>(`/vigilancia/notificacoes/${id}`, [id]);
  const [agora, setAgora] = useState(() => Date.now());
  const [edicao, setEdicao] = useState<Edicao | null>(null);
  const [descarte, setDescarte] = useState<string | null>(null);
  const [comunicacao, setComunicacao] = useState<{ target: Esfera; channel: string; communicatedAt: string; counterpartName: string; contactId: string; contactValue: string; protocol: string; notes: string } | null>(
    null,
  );
  const [erros, setErros] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useRealtime<{ id: string }>('vigilancia:notificacao', (p) => {
    if (p?.id === id) void det.reload();
  });
  const nucleo = session.me?.context.role === 'NUCLEO_VIGILANCIA';

  if (det.error) return <Alert tone="error">{det.error}</Alert>;
  const d = det.data && det.data.id === id ? det.data : null;
  if (!d) return <Spinner />;

  async function acao(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setErros([]);
    try {
      await fn();
      toast.success(ok);
      await det.reload();
      onChanged?.();
      return true;
    } catch (err) {
      const msg = errorMessage(err);
      // A lista de pendências da ficha só aparece quando a confirmação foi recusada por ela.
      setErros(err instanceof ApiError && err.code === 'FICHA_INVALIDA' ? msg.split('; ') : []);
      toast.error(msg);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const abrirEdicao = () =>
    setEdicao({
      conditionKey: d.agravo.key,
      basis: d.criterio,
      confirmedAt: paraLocal(d.datas.confirmacao),
      symptomsOnset: d.datas.sintomas ?? '',
      ficha: Object.fromEntries([...EDITAVEIS_DOMINIO, ...EDITAVEIS_TEXTO].map((c) => [c, (d.ficha[c] as string | null) ?? ''])),
    });

  async function salvar() {
    if (!edicao) return;
    const ok = await acao(
      () =>
        api.patch(`/vigilancia/notificacoes/${id}`, {
          ...(edicao.conditionKey !== d!.agravo.key ? { conditionKey: edicao.conditionKey } : {}),
          basis: edicao.basis,
          confirmedAt: edicao.confirmedAt ? new Date(edicao.confirmedAt).toISOString() : null,
          symptomsOnset: edicao.symptomsOnset || null,
          ficha: Object.fromEntries(Object.entries(edicao.ficha).map(([k, v]) => [k, v || null])),
        }),
      'Ficha atualizada.',
    );
    if (ok) setEdicao(null);
  }

  const imediata = d.prazo.tipo === 'IMEDIATA';
  const sms = d.prazo.porEsfera.find((e) => e.esfera === 'SMS');
  const esferasComunicacao: Esfera[] = nucleo ? ['SMS'] : ['SMS', 'SES', 'MS'];
  return (
    <div className="flex flex-col gap-4" id="ficha-notificacao">
      <Card>
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              Notificação {d.numero} <Badge tone={STATUS[d.status]!.tone}>{STATUS[d.status]!.label}</Badge>
              <Badge tone={imediata ? 'red' : 'amber'}>{imediata ? `Imediata · ${d.prazo.esferas.join(', ')}` : 'Semanal · SMS'}</Badge>
              {d.sigiloso && (
                <Badge tone="violet">
                  <Lock className="h-3 w-3" /> Sigilosa
                </Badge>
              )}
              {d.naoHomologado && <Badge tone="slate">Mapeamento do código não homologado</Badge>}
              {d.agravo.emRevisao && <Badge tone="amber">Em revisão normativa</Badge>}
              {d.foraDoMunicipio && <Badge tone="blue">Residente em outro município</Badge>}
            </span>
          }
          description={`${d.agravo.nome} · item ${d.agravo.item}${d.agravo.subitem ? `, ${d.agravo.subitem}` : ''} da LNNC · ${d.agravo.contextoLabel} · origem: ${ORIGEM[d.origem] ?? d.origem}`}
          actions={
            <div className="flex flex-wrap gap-2">
              {d.permissoes.editar && !edicao && (
                <Button size="sm" variant="secondary" onClick={abrirEdicao} id="vig-editar">
                  <Pencil className="h-4 w-4" /> Editar ficha
                </Button>
              )}
              {d.permissoes.confirmar && (
                <Button
                  size="sm"
                  variant="success"
                  loading={busy}
                  id="vig-confirmar"
                  onClick={() => acao(() => api.post(`/vigilancia/notificacoes/${id}/confirmar`), 'Notificação confirmada e comunicada à vigilância municipal.')}
                >
                  <CheckCircle2 className="h-4 w-4" /> Confirmar notificação
                </Button>
              )}
              {d.permissoes.ciencia && (
                <Button size="sm" loading={busy} id="vig-ciencia" onClick={() => acao(() => api.post(`/vigilancia/notificacoes/${id}/ciencia`), 'Ciência registrada: o repasse às demais esferas tem 24 h.')}>
                  <Eye className="h-4 w-4" /> Dar ciência
                </Button>
              )}
              {d.permissoes.comunicar && (
                <Button
                  size="sm"
                  variant="secondary"
                  id="vig-comunicar"
                  onClick={() =>
                    setComunicacao({
                      target: nucleo ? 'SMS' : (d.prazo.porEsfera.find((e) => e.esfera !== 'SMS' && e.situacao !== 'CUMPRIDO')?.esfera ?? 'SMS'),
                      channel: 'TELEFONE',
                      communicatedAt: agoraLocal(),
                      counterpartName: '',
                      contactId: '',
                      contactValue: '',
                      protocol: '',
                      notes: '',
                    })
                  }
                >
                  <PhoneCall className="h-4 w-4" /> Registrar comunicação
                </Button>
              )}
              {d.permissoes.descartar && (
                <Button size="sm" variant="ghost" onClick={() => setDescarte('')}>
                  <Trash2 className="h-4 w-4" /> Descartar
                </Button>
              )}
            </div>
          }
        />
        <CardBody className="flex flex-col gap-3">
          {erros.length > 0 && (
            <Alert tone="error" title="A ficha não pode ser confirmada ainda">
              <ul className="list-disc pl-5">
                {erros.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          )}
          {d.status === 'RASCUNHO' && imediata && (
            <Alert tone="warn" title="Notificação imediata">
              Comunique à vigilância municipal pelo meio mais rápido disponível. Confirmar aqui registra a comunicação pelo painel; a vigilância dá ciência e repassa à SES e ao MS em até 24 h.
            </Alert>
          )}
          {d.prazo.aguardandoConfirmacao && <Alert tone="info">Este agravo é notificado na confirmação do caso: o prazo começa quando a data de confirmação for informada.</Alert>}
          {d.agravo.notaNormativa && <Alert tone="info">{d.agravo.notaNormativa}</Alert>}
          <div className="grid gap-3 md:grid-cols-3" id="vig-prazos">
            {d.prazo.porEsfera.map((e) => (
              <div key={e.esfera} className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{e.rotulo}</p>
                <p className="mt-1 flex items-center gap-2">
                  <Badge tone={SITUACAO[e.situacao].tone}>{SITUACAO[e.situacao].label}</Badge>
                </p>
                <p className="mt-1 text-sm">
                  {e.cumpridaEm
                    ? `Cumprido em ${fmtDateTime(e.cumpridaEm)}`
                    : e.venceEm
                      ? `${tempoAte(e.venceEm, agora)} (${fmtDateTime(e.venceEm)})`
                      : e.esfera === 'SMS'
                        ? 'Aguardando o marco do prazo'
                        : 'Prazo abre com a ciência da SMS'}
                </p>
              </div>
            ))}
          </div>
          <div className="grid gap-2 text-sm md:grid-cols-2">
            <p>
              <span className="text-slate-500">Paciente: </span>
              <Link className="text-brand-700 underline" href={`/paciente?id=${d.paciente.id}`}>
                {d.paciente.nome}
              </Link>
            </p>
            <p>
              <span className="text-slate-500">Unidade notificadora: </span>
              {d.unidade.name} · CNES {d.unidade.cnes}
            </p>
            <p>
              <span className="text-slate-500">Prazo conta de: </span>
              {d.prazo.marcoLabel} {d.prazo.inicio ? `(${fmtDateTime(d.prazo.inicio)})` : ''}
            </p>
            <p>
              <span className="text-slate-500">Critério: </span>
              {d.criterio === 'CONFIRMADO' ? 'Caso confirmado' : 'Caso suspeito'}
              {d.datas.confirmacao ? ` em ${fmtDateTime(d.datas.confirmacao)}` : ''}
            </p>
            <p>
              <span className="text-slate-500">Notificador: </span>
              {d.ficha.notificador.nome}
              {d.ficha.notificador.cbo ? ` · CBO ${d.ficha.notificador.cbo}` : ''}
            </p>
            <p>
              <span className="text-slate-500">Semana epidemiológica: </span>
              {d.datas.semanaNotificacao ? `${d.datas.semanaNotificacao.slice(4)}/${d.datas.semanaNotificacao.slice(0, 4)} (notificação)` : 'definida ao confirmar'}
              {d.datas.semanaSintomas ? ` · ${d.datas.semanaSintomas.slice(4)}/${d.datas.semanaSintomas.slice(0, 4)} (sintomas)` : ''}
            </p>
            {d.ciencia && (
              <p>
                <span className="text-slate-500">Ciência da SMS: </span>
                {fmtDateTime(d.ciencia.em)}
                {d.ciencia.por ? ` · ${d.ciencia.por}` : ''}
              </p>
            )}
            {d.descarte && (
              <p className="md:col-span-2">
                <span className="text-slate-500">Descartada em {fmtDateTime(d.descarte.em)}: </span>
                {d.descarte.motivo}
              </p>
            )}
          </div>
          <p className="text-xs text-slate-500">{d.aviso}</p>
        </CardBody>
      </Card>

      {edicao && (
        <Card>
          <CardHeader title="Editar ficha" description="Os dados pessoais vêm do cadastro do paciente: para corrigi-los, atualize o cadastro. Aqui ficam o agravo, as datas e os campos próprios da notificação." />
          <CardBody className="grid gap-3 md:grid-cols-2">
            <Field label="Agravo / subitem da lista" htmlFor="vig-subitem">
              <Select id="vig-subitem" value={edicao.conditionKey} onChange={(e) => setEdicao({ ...edicao, conditionKey: e.target.value })}>
                {d.subitens.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.nome} ({s.contexto}){s.marcas.semanal ? ' · semanal' : ` · imediata ${[s.marcas.MS && 'MS', s.marcas.SES && 'SES', s.marcas.SMS && 'SMS'].filter(Boolean).join('/')}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Critério" htmlFor="vig-criterio">
              <Select id="vig-criterio" value={edicao.basis} onChange={(e) => setEdicao({ ...edicao, basis: e.target.value as Edicao['basis'] })}>
                <option value="SUSPEITA">Caso suspeito</option>
                <option value="CONFIRMADO">Caso confirmado</option>
              </Select>
            </Field>
            {(edicao.basis === 'CONFIRMADO' || d.agravo.criterio === 'CONFIRMACAO') && (
              <Field label="Data e hora da confirmação" htmlFor="vig-confirmacao">
                <Input id="vig-confirmacao" type="datetime-local" max={agoraLocal()} value={edicao.confirmedAt} onChange={(e) => setEdicao({ ...edicao, confirmedAt: e.target.value })} />
              </Field>
            )}
            <Field label="7. Data dos primeiros sintomas" htmlFor="vig-sintomas">
              <Input id="vig-sintomas" type="date" max={agoraLocal().slice(0, 10)} value={edicao.symptomsOnset} onChange={(e) => setEdicao({ ...edicao, symptomsOnset: e.target.value })} />
            </Field>
            {EDITAVEIS_DOMINIO.map((campo) => {
              const meta = CAMPOS_FIN.find((c) => c.campo === campo)!;
              return (
                <Field key={campo} label={`${meta.numero}. ${meta.rotulo}`} htmlFor={`vig-${campo}`}>
                  <Select id={`vig-${campo}`} value={edicao.ficha[campo] ?? ''} onChange={(e) => setEdicao({ ...edicao, ficha: { ...edicao.ficha, [campo]: e.target.value } })}>
                    <option value="">— não informado —</option>
                    {Object.entries(DOMINIO_FIN[campo] ?? {}).map(([v, l]) => (
                      <option key={v} value={v}>
                        {v} - {l}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            })}
            {EDITAVEIS_TEXTO.map((campo) => {
              const meta = CAMPOS_FIN.find((c) => c.campo === campo)!;
              return (
                <Field key={campo} label={`${meta.numero}. ${meta.rotulo}`} htmlFor={`vig-${campo}`}>
                  <Input id={`vig-${campo}`} value={edicao.ficha[campo] ?? ''} maxLength={120} onChange={(e) => setEdicao({ ...edicao, ficha: { ...edicao.ficha, [campo]: e.target.value } })} />
                </Field>
              );
            })}
            <div className="flex gap-2 md:col-span-2">
              <Button loading={busy} onClick={salvar} id="vig-salvar">
                Salvar alterações
              </Button>
              <Button variant="secondary" onClick={() => setEdicao(null)}>
                Cancelar
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Ficha Individual de Notificação (Sinan Net v5)" description="Campos 1 a 16 e 20 a 33. Retrato tirado do cadastro na abertura da notificação." />
        <CardBody className="grid gap-x-6 gap-y-1.5 text-sm md:grid-cols-2" id="vig-campos">
          {CAMPOS_FIN.map((c) => {
            const v = c.campo === 'DT_SIN_PRI' ? (d.datas.sintomas ?? d.ficha[c.campo]) : d.ficha[c.campo];
            const faltando = c.campo === 'CS_GESTANT' && !v;
            return (
              <p key={c.campo} className={faltando ? 'text-red-700' : undefined}>
                <span className="text-slate-500">
                  {c.numero}. {c.rotulo}:{' '}
                </span>
                {faltando ? 'obrigatório para mulher em idade fértil' : valorCampo(c.campo, v)}
              </p>
            );
          })}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Comunicações" description="Registro de quem foi avisado, por qual meio e quando. O sistema não liga nem envia e-mail." />
          <CardBody className="flex flex-col gap-2 text-sm">
            {d.comunicacoes.length === 0 && <p className="text-slate-500">Nenhuma comunicação registrada.</p>}
            {d.comunicacoes.map((c) => (
              <div key={c.id} className="rounded border border-slate-200 p-2">
                <p className="font-medium">
                  {c.esfera} · {MEIO[c.meio] ?? c.meio} · {fmtDateTime(c.em)}
                </p>
                <p className="text-xs text-slate-600">
                  {c.interlocutor}
                  {c.orgao ? ` (${c.orgao})` : ''}
                  {c.contato ? ` · ${c.contato}` : ''}
                  {c.protocolo ? ` · protocolo ${c.protocolo}` : ''}
                  {c.por ? ` · registrado por ${c.por}` : ''}
                </p>
                {c.notas && <p className="text-xs text-slate-500">{c.notas}</p>}
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Linha do tempo" />
          <CardBody>
            <ol className="flex flex-col gap-1.5 text-sm">
              {d.eventos.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span>
                    <span className="font-medium">{EVENTO[e.tipo] ?? e.tipo}</span> · {fmtDateTime(e.em)}
                    {e.por ? ` · ${e.por}` : ''}
                    {e.notas ? <span className="block text-xs text-slate-500">{e.notas}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      </div>

      <Dialog
        open={descarte !== null}
        onOpenChange={(o) => !o && setDescarte(null)}
        title={`Descartar a notificação ${d.numero}`}
        description="O descarte fica na linha do tempo e no relatório de descartes da vigilância."
        footer={
          <Button
            variant="danger"
            loading={busy}
            disabled={(descarte ?? '').trim().length < 10}
            onClick={async () => {
              if (await acao(() => api.post(`/vigilancia/notificacoes/${id}/descartar`, { reason: descarte }), 'Notificação descartada.')) setDescarte(null);
            }}
          >
            Descartar
          </Button>
        }
      >
        <Field label="Motivo (mínimo de 10 caracteres)" htmlFor="vig-motivo">
          <Textarea id="vig-motivo" value={descarte ?? ''} onChange={(e) => setDescarte(e.target.value)} rows={3} />
        </Field>
      </Dialog>

      <Dialog
        open={!!comunicacao}
        onOpenChange={(o) => !o && setComunicacao(null)}
        title="Registrar comunicação"
        description={
          nucleo
            ? 'O núcleo do estabelecimento comunica à vigilância municipal; o repasse à SES e ao MS é da SMS.'
            : 'Comunicação à vigilância municipal, à SES (CIEVS estadual) ou ao Ministério da Saúde (CIEVS Nacional).'
        }
        footer={
          <Button
            loading={busy}
            disabled={!comunicacao || comunicacao.counterpartName.trim().length < 2 || !comunicacao.communicatedAt || Number.isNaN(Date.parse(comunicacao.communicatedAt))}
            id="vig-comunicar-salvar"
            onClick={async () => {
              if (!comunicacao) return;
              const ok = await acao(
                () =>
                  api.post(`/vigilancia/notificacoes/${id}/comunicacoes`, {
                    target: comunicacao.target,
                    channel: comunicacao.channel,
                    communicatedAt: new Date(comunicacao.communicatedAt).toISOString(),
                    counterpartName: comunicacao.counterpartName,
                    contactId: comunicacao.contactId || null,
                    contactValue: comunicacao.contactValue || null,
                    protocol: comunicacao.protocol || null,
                    notes: comunicacao.notes || null,
                  }),
                'Comunicação registrada.',
              );
              if (ok) setComunicacao(null);
            }}
          >
            Registrar
          </Button>
        }
      >
        {comunicacao && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Esfera" htmlFor="com-esfera">
              <Select id="com-esfera" value={comunicacao.target} onChange={(e) => setComunicacao({ ...comunicacao, target: e.target.value as Esfera, contactId: '', contactValue: '' })}>
                {esferasComunicacao.map((e) => (
                  <option key={e} value={e}>
                    {e === 'SMS' ? 'SMS (vigilância municipal)' : e === 'SES' ? 'SES (vigilância estadual)' : 'MS (CIEVS Nacional)'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Meio" htmlFor="com-meio">
              <Select id="com-meio" value={comunicacao.channel} onChange={(e) => setComunicacao({ ...comunicacao, channel: e.target.value })}>
                {['TELEFONE', 'EMAIL', 'FORMULARIO', 'PRESENCIAL', 'OUTRO'].map((m) => (
                  <option key={m} value={m}>
                    {MEIO[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contato da agenda" htmlFor="com-contato">
              <Select
                id="com-contato"
                value={comunicacao.contactId}
                onChange={(e) => {
                  const c = d.contatos.find((x) => x.id === e.target.value);
                  setComunicacao({ ...comunicacao, contactId: e.target.value, contactValue: c ? (comunicacao.channel === 'EMAIL' ? (c.email ?? '') : (c.telefone ?? c.email ?? '')) : '' });
                }}
              >
                <option value="">—</option>
                {d.contatos
                  .filter((c) => c.esfera === comunicacao.target)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nome}
                      {c.telefone ? ` · ${c.telefone}` : ''}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Telefone / e-mail usado" htmlFor="com-valor">
              <Input id="com-valor" value={comunicacao.contactValue} onChange={(e) => setComunicacao({ ...comunicacao, contactValue: e.target.value })} />
            </Field>
            <Field label="Quem recebeu" htmlFor="com-quem">
              <Input id="com-quem" value={comunicacao.counterpartName} onChange={(e) => setComunicacao({ ...comunicacao, counterpartName: e.target.value })} placeholder="Nome de quem atendeu" />
            </Field>
            <Field label="Quando" htmlFor="com-quando">
              <Input id="com-quando" type="datetime-local" max={agoraLocal()} value={comunicacao.communicatedAt} onChange={(e) => setComunicacao({ ...comunicacao, communicatedAt: e.target.value })} />
            </Field>
            <Field label="Protocolo (se houver)" htmlFor="com-protocolo">
              <Input id="com-protocolo" value={comunicacao.protocol} onChange={(e) => setComunicacao({ ...comunicacao, protocol: e.target.value })} />
            </Field>
            <Field label="Observações" htmlFor="com-notas" className="sm:col-span-2">
              <Textarea id="com-notas" rows={2} value={comunicacao.notes} onChange={(e) => setComunicacao({ ...comunicacao, notes: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
      {sms && d.status !== 'DESCARTADA' && sms.situacao === 'VENCIDO' && (
        <Alert tone="error">O prazo perante a vigilância municipal venceu. Confirme e comunique assim que possível: a notificação continua obrigatória.</Alert>
      )}
    </div>
  );
}
