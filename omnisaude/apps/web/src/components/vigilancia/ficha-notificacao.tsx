'use client';

import { CAMPOS_FIN, DOMINIO_FIN } from '@omnisaude/shared';
import { BellRing, CheckCircle2, ClipboardCheck, Eye, FileDown, Hash, Lock, Pencil, PhoneCall, ShieldAlert, Table2, Trash2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, errorMessage, saveBlob } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';
import { DIGITACAO, ESFERA_ROTULO, EVENTO, MEIO, ORIGEM, SITUACAO, STATUS, tempoAte, type Destino, type LinhaEspelho, type NotificacaoDetalhe } from './types';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

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
  const [comunicacao, setComunicacao] = useState<{ target: Destino; channel: string; communicatedAt: string; counterpartName: string; contactId: string; contactValue: string; protocol: string; notes: string } | null>(
    null,
  );
  const [erros, setErros] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [numero, setNumero] = useState({ numero: '', lote: '' });
  const [espelho, setEspelho] = useState<LinhaEspelho[] | null>(null);
  const [motivo, setMotivo] = useState<{ tipo: 'desfazer' | 'reabrir' | 'dispensa'; texto: string } | null>(null);
  const [encerra, setEncerra] = useState<{ investigadaEm: string; classificacao: string; criterio: string; evolucao: string; obitoEm: string; encerradaEm: string; conclusao: Record<string, string> } | null>(null);
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
  const esferasComunicacao: Destino[] = [
    ...(d.permissoes.comunicar ? (nucleo ? (['SMS'] as Destino[]) : (['SMS', 'SES', 'MS'] as Destino[])) : []),
    ...(d.permissoes.comunicarPolicia ? (['AUTORIDADE_POLICIAL'] as Destino[]) : []),
  ];
  const policia = d.prazo.porEsfera.find((e) => e.esfera === 'AUTORIDADE_POLICIAL');
  const baixar = async (caminho: string, nome: string) => {
    try {
      const r = await api.download(caminho);
      saveBlob(r.blob, r.fileName ?? nome);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const novaComunicacao = (target: Destino) =>
    setComunicacao({ target, channel: target === 'AUTORIDADE_POLICIAL' ? 'PRESENCIAL' : 'TELEFONE', communicatedAt: agoraLocal(), counterpartName: '', contactId: '', contactValue: '', protocol: '', notes: '' });
  const hojeIso = agoraLocal().slice(0, 10);
  const num = d.encerramento.numeracao;
  async function confirmarMotivo() {
    if (!motivo) return;
    const ok = await acao(
      () =>
        motivo.tipo === 'desfazer'
          ? api.post(`/vigilancia/notificacoes/${id}/numero-oficial/desfazer`, { reason: motivo.texto })
          : motivo.tipo === 'reabrir'
            ? api.post(`/vigilancia/notificacoes/${id}/reabrir`, { reason: motivo.texto })
            : api.patch(`/vigilancia/notificacoes/${id}`, { policial: { dispensa: motivo.texto } }),
      motivo.tipo === 'desfazer' ? 'Digitação desfeita: a notificação voltou à fila.' : motivo.tipo === 'reabrir' ? 'Investigação reaberta.' : 'Comunicação policial dispensada.',
    );
    if (ok) setMotivo(null);
  }
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
                  onClick={() => novaComunicacao(nucleo ? 'SMS' : (d.prazo.porEsfera.find((e) => (e.esfera === 'SES' || e.esfera === 'MS') && e.situacao !== 'CUMPRIDO')?.esfera ?? 'SMS'))}
                >
                  <PhoneCall className="h-4 w-4" /> Registrar comunicação
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                id="vig-espelho"
                onClick={async () => {
                  try {
                    setEspelho((await api.get<{ linhas: LinhaEspelho[] }>(`/vigilancia/notificacoes/${id}/espelho`)).linhas);
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <Table2 className="h-4 w-4" /> Espelho
              </Button>
              <Button size="sm" variant="ghost" onClick={() => baixar(`/vigilancia/notificacoes/${id}/ficha.pdf`, `notificacao-${d.numero.replace('/', '-')}.pdf`)}>
                <FileDown className="h-4 w-4" /> PDF
              </Button>
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
            <Alert tone="error" title="Pendências da ficha">
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

      {d.policial && (
        <Card id="vig-policial">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-red-600" /> Violência contra a mulher: comunicação à autoridade policial
              </span>
            }
            description="Mulher de 18 a 59 anos: até 24 horas da constatação (Lei nº 10.778/2003, art. 1º, § 4º; Anexo V da PRC GM/MS nº 4/2017, arts. 14-A a 14-C), à autoridade de referência definida pela SES. O PDF padrão não identifica a vítima (Lei nº 10.778/2003, art. 3º)."
            actions={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => baixar(`/vigilancia/notificacoes/${id}/comunicacao-policial.pdf`, 'comunicacao-policial.pdf')} id="vig-policial-pdf">
                  <FileDown className="h-4 w-4" /> Comunicação (PDF)
                </Button>
                {d.permissoes.comunicarPolicia && (
                  <Button size="sm" onClick={() => novaComunicacao('AUTORIDADE_POLICIAL')} id="vig-policial-registrar">
                    <PhoneCall className="h-4 w-4" /> Registrar envio
                  </Button>
                )}
                {d.permissoes.dispensarPolicia && (d.policial.dispensa || !policia?.cumpridaEm) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => (d.policial?.dispensa ? acao(() => api.patch(`/vigilancia/notificacoes/${id}`, { policial: { dispensa: null } }), 'Exigência restaurada.') : setMotivo({ tipo: 'dispensa', texto: '' }))}
                  >
                    {d.policial.dispensa ? 'Restaurar exigência' : 'Dispensar'}
                  </Button>
                )}
              </div>
            }
          />
          <CardBody className="text-sm">
            {d.policial.dispensa ? (
              <p>
                <span className="text-slate-500">Dispensada: </span>
                {d.policial.dispensa}
              </p>
            ) : policia ? (
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={SITUACAO[policia.situacao].tone}>{SITUACAO[policia.situacao].label}</Badge>
                {policia.cumpridaEm ? `Comunicada em ${fmtDateTime(policia.cumpridaEm)}` : `${tempoAte(policia.venceEm, agora)} (${fmtDateTime(policia.venceEm)})`}
              </p>
            ) : null}
          </CardBody>
        </Card>
      )}

      {d.orientacaoViolencia && (
        <Card id="vig-violencia-orientacao">
          <CardBody className="flex items-start gap-2 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>{d.orientacaoViolencia}</p>
          </CardBody>
        </Card>
      )}

      {d.saida && (
        <Card id="vig-saida">
          <CardHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                Sistema oficial: {d.saida.sistemaLabel}
                {d.saida.digitacao && (d.status !== 'DESCARTADA' || d.saida.numero) && <Badge tone={DIGITACAO[d.saida.digitacao]!.tone}>{DIGITACAO[d.saida.digitacao]!.label}</Badge>}
                {d.saida.rota.situacao !== 'CONFIRMADO' && <Badge tone="amber">{d.saida.rota.situacaoLabel}</Badge>}
              </span>
            }
            description={`Destino: ${d.saida.rota.fonte}`}
            actions={
              d.permissoes.desfazerDigitacao ? (
                <Button size="sm" variant="ghost" onClick={() => setMotivo({ tipo: 'desfazer', texto: '' })}>
                  <Undo2 className="h-4 w-4" /> Desfazer digitação
                </Button>
              ) : undefined
            }
          />
          <CardBody className="flex flex-col gap-3 text-sm">
            {d.saida.rota.nota && <Alert tone="info">{d.saida.rota.nota}</Alert>}
            {d.saida.numero && (
              <p>
                <span className="text-slate-500">Número no {d.saida.sistemaLabel}: </span>
                <b>{d.saida.numero}</b>
                {d.saida.lote ? ` · lote ${d.saida.lote}` : ''} · {d.saida.digitadaPor ?? ''} em {fmtDateTime(d.saida.digitadaEm)}
              </p>
            )}
            {d.permissoes.digitar && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label={`Número gerado no ${d.saida.sistemaLabel}`} htmlFor="vig-numero" hint={d.saida.dicaNumero}>
                  <Input id="vig-numero" value={numero.numero} onChange={(e) => setNumero({ ...numero, numero: e.target.value })} className="w-48" />
                </Field>
                <Field label="Lote (opcional)" htmlFor="vig-lote">
                  <Input id="vig-lote" value={numero.lote} onChange={(e) => setNumero({ ...numero, lote: e.target.value })} className="w-32" />
                </Field>
                <Button
                  loading={busy}
                  disabled={!numero.numero.trim()}
                  id="vig-numero-salvar"
                  onClick={async () => {
                    if (await acao(() => api.post(`/vigilancia/notificacoes/${id}/numero-oficial`, { numero: numero.numero, lote: numero.lote || null }), 'Número oficial registrado: a notificação saiu da fila.'))
                      setNumero({ numero: '', lote: '' });
                  }}
                >
                  <Hash className="h-4 w-4" /> Informar número
                </Button>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {(d.status === 'NOTIFICADA' || d.status === 'ENCERRADA') && (
        <Card id="vig-encerramento">
          <CardHeader
            title="Investigação e encerramento"
            description={
              d.encerramento.fichaEsus
                ? 'Conclusão da ficha de Notificação/Conclusão do e-SUS Sinan (campos 44 a 56).'
                : `Bloco "notificação/conclusão" do Sinan Net v5 (campos 31 a 43).${d.encerramento.prazoDias ? ` Prazo de encerramento: ${d.encerramento.prazoDias} dias da notificação.` : ''}`
            }
            actions={
              d.permissoes.reabrir ? (
                <Button size="sm" variant="ghost" onClick={() => setMotivo({ tipo: 'reabrir', texto: '' })}>
                  <Undo2 className="h-4 w-4" /> Reabrir
                </Button>
              ) : d.permissoes.encerrar && !encerra ? (
                <Button
                  size="sm"
                  variant="secondary"
                  id="vig-encerrar"
                  onClick={() => setEncerra({ investigadaEm: hojeIso, classificacao: '', criterio: '', evolucao: '', obitoEm: '', encerradaEm: hojeIso, conclusao: { ...(d.encerramento.conclusao ?? {}) } })}
                >
                  <ClipboardCheck className="h-4 w-4" /> Encerrar investigação
                </Button>
              ) : undefined
            }
          />
          <CardBody className="flex flex-col gap-3 text-sm">
            {d.status === 'ENCERRADA' && (
              <div className="grid gap-1 md:grid-cols-2">
                <p>
                  <span className="text-slate-500">{num.classificacao}. Classificação final: </span>
                  {d.encerramento.classificacaoLabel}
                </p>
                <p>
                  <span className="text-slate-500">{num.criterio}. Critério: </span>
                  {d.encerramento.criterioLabel ?? '—'}
                </p>
                <p>
                  <span className="text-slate-500">{num.evolucao}. Evolução: </span>
                  {d.encerramento.evolucaoLabel ?? '—'}
                  {d.encerramento.obitoEm ? ` (óbito em ${fmtDate(d.encerramento.obitoEm)})` : ''}
                </p>
                <p>
                  <span className="text-slate-500">{num.encerramento}. Encerrada em: </span>
                  {fmtDate(d.encerramento.encerradaEm)}
                  {d.encerramento.encerradaPor ? ` · ${d.encerramento.encerradaPor}` : ''}
                </p>
                {d.encerramento.camposConclusao
                  .filter((c) => d.encerramento.conclusao?.[c.campo])
                  .map((c) => (
                    <p key={c.campo}>
                      <span className="text-slate-500">
                        {c.campo}. {c.rotulo}:{' '}
                      </span>
                      {c.opcoes?.[d.encerramento.conclusao![c.campo]!] ?? d.encerramento.conclusao![c.campo]}
                    </p>
                  ))}
              </div>
            )}
            {d.status === 'NOTIFICADA' && !encerra && <p className="text-slate-500">Investigação em aberto.</p>}
            {encerra && (
              <div className="grid gap-3 md:grid-cols-3" id="vig-encerrar-form">
                <Field label={`${num.investigacao}. Data da investigação`} htmlFor="enc-inv">
                  <Input id="enc-inv" type="date" max={hojeIso} value={encerra.investigadaEm} onChange={(e) => setEncerra({ ...encerra, investigadaEm: e.target.value })} />
                </Field>
                <Field label={`${num.classificacao}. Classificação final`} htmlFor="enc-class">
                  <Select id="enc-class" value={encerra.classificacao} onChange={(e) => setEncerra({ ...encerra, classificacao: e.target.value })}>
                    <option value="">Escolha…</option>
                    <option value="1">1 - Confirmado</option>
                    <option value="2">2 - Descartado</option>
                    {!d.encerramento.fichaEsus && <option value="8">8 - Inconclusivo</option>}
                  </Select>
                </Field>
                <Field label={`${num.criterio}. Critério de confirmação/descarte`} htmlFor="enc-crit">
                  <Select id="enc-crit" value={encerra.criterio} onChange={(e) => setEncerra({ ...encerra, criterio: e.target.value })}>
                    <option value="">—</option>
                    <option value="1">1 - Laboratorial</option>
                    <option value="2">2 - Clínico-epidemiológico</option>
                    {!d.encerramento.fichaEsus && <option value="3">3 - Clínico</option>}
                  </Select>
                </Field>
                <Field label={`${num.evolucao}. Evolução do caso`} htmlFor="enc-evo">
                  <Select
                    id="enc-evo"
                    value={encerra.evolucao}
                    // A data do óbito só vale com evolução para óbito: some (e é limpa) nas demais.
                    onChange={(e) => setEncerra({ ...encerra, evolucao: e.target.value, obitoEm: e.target.value === '2' || e.target.value === '3' ? encerra.obitoEm : '' })}
                  >
                    <option value="">—</option>
                    <option value="1">1 - Cura</option>
                    <option value="2">2 - Óbito pelo agravo notificado</option>
                    <option value="3">3 - Óbito por outras causas</option>
                    <option value="9">9 - Ignorado</option>
                  </Select>
                </Field>
                {(encerra.evolucao === '2' || encerra.evolucao === '3') && (
                  <Field label={`${num.obito}. Data do óbito`} htmlFor="enc-obito">
                    <Input id="enc-obito" type="date" max={hojeIso} value={encerra.obitoEm} onChange={(e) => setEncerra({ ...encerra, obitoEm: e.target.value })} />
                  </Field>
                )}
                <Field label={`${num.encerramento}. ${d.encerramento.fichaEsus ? 'Data de conclusão' : 'Data do encerramento'}`} htmlFor="enc-data">
                  <Input id="enc-data" type="date" max={hojeIso} value={encerra.encerradaEm} onChange={(e) => setEncerra({ ...encerra, encerradaEm: e.target.value })} />
                </Field>
                {d.encerramento.camposConclusao.map((c) => (
                  <Field key={c.campo} label={`${c.campo}. ${c.rotulo}${c.obrigatorio ? '' : c.obrigatorioSe ? ` (obrigatório ${c.obrigatorioSe})` : ' (se couber)'}`} htmlFor={`enc-${c.campo}`}>
                    {c.tipo === 'opcao' ? (
                      <Select id={`enc-${c.campo}`} value={encerra.conclusao[c.campo] ?? ''} onChange={(e) => setEncerra({ ...encerra, conclusao: { ...encerra.conclusao, [c.campo]: e.target.value } })}>
                        <option value="">—</option>
                        {Object.entries(c.opcoes ?? {}).map(([v, l]) => (
                          <option key={v} value={v}>
                            {v} - {l}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input id={`enc-${c.campo}`} value={encerra.conclusao[c.campo] ?? ''} onChange={(e) => setEncerra({ ...encerra, conclusao: { ...encerra.conclusao, [c.campo]: e.target.value } })} />
                    )}
                  </Field>
                ))}
                <div className="flex gap-2 md:col-span-3">
                  <Button
                    loading={busy}
                    disabled={!encerra.classificacao}
                    id="vig-encerrar-salvar"
                    onClick={async () => {
                      const ok = await acao(
                        () =>
                          api.post(`/vigilancia/notificacoes/${id}/encerrar`, {
                            investigadaEm: encerra.investigadaEm,
                            classificacao: encerra.classificacao,
                            criterio: encerra.criterio || null,
                            evolucao: encerra.evolucao || null,
                            obitoEm: encerra.evolucao === '2' || encerra.evolucao === '3' ? encerra.obitoEm || null : null,
                            encerradaEm: encerra.encerradaEm,
                            conclusao: Object.keys(encerra.conclusao).length ? Object.fromEntries(Object.entries(encerra.conclusao).map(([k, v]) => [k, v || null])) : null,
                          }),
                        'Investigação encerrada.',
                      );
                      if (ok) setEncerra(null);
                    }}
                  >
                    Encerrar
                  </Button>
                  <Button variant="secondary" onClick={() => setEncerra(null)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      )}

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
                  {ESFERA_ROTULO[c.esfera] ?? c.esfera} · {MEIO[c.meio] ?? c.meio} · {fmtDateTime(c.em)}
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
        title={comunicacao?.target === 'AUTORIDADE_POLICIAL' ? 'Registrar a comunicação à autoridade policial' : 'Registrar comunicação'}
        description={
          comunicacao?.target === 'AUTORIDADE_POLICIAL'
            ? 'Envio à autoridade policial de referência definida pela SES, em até 24 horas da constatação (Anexo V da PRC GM/MS nº 4/2017, art. 14-A).'
            : nucleo
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
              <Select id="com-esfera" value={comunicacao.target} onChange={(e) => setComunicacao({ ...comunicacao, target: e.target.value as Destino, contactId: '', contactValue: '' })}>
                {esferasComunicacao.map((e) => (
                  <option key={e} value={e}>
                    {e === 'SMS' ? 'SMS (vigilância municipal)' : e === 'SES' ? 'SES (vigilância estadual)' : e === 'MS' ? 'MS (CIEVS Nacional)' : 'Autoridade policial (violência contra a mulher)'}
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
            {comunicacao.target !== 'AUTORIDADE_POLICIAL' && (
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
            )}
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
      <Dialog
        open={!!espelho}
        onOpenChange={(o) => !o && setEspelho(null)}
        size="xl"
        title={`Espelho da ficha ${d.numero}`}
        description="Campos na ordem da ficha individual do Sinan Net v5, com a variável do dicionário de dados e o valor exportado."
      >
        {espelho && (
          <div className="max-h-[60vh] overflow-auto" id="vig-espelho-tabela">
            <Table>
              <THead>
                <TR>
                  <TH>Nº</TH>
                  <TH>Variável</TH>
                  <TH>Campo</TH>
                  <TH>Valor</TH>
                  <TH>Exportado</TH>
                </TR>
              </THead>
              <TBody>
                {espelho.map((l) => (
                  <TR key={`${l.bloco}-${l.variavel}`}>
                    <TD className="text-xs">{l.numero}</TD>
                    <TD className="font-mono text-xs">{l.variavel}</TD>
                    <TD className="text-xs">{l.rotulo}</TD>
                    <TD className="text-xs">{l.valor || '—'}</TD>
                    <TD className="font-mono text-xs">{l.exportado}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!motivo}
        onOpenChange={(o) => !o && setMotivo(null)}
        title={motivo?.tipo === 'desfazer' ? 'Desfazer a digitação' : motivo?.tipo === 'reabrir' ? 'Reabrir a investigação' : 'Dispensar a comunicação policial'}
        description={
          motivo?.tipo === 'dispensa'
            ? 'Use só quando a comunicação não se aplica (ex.: lesão autoprovocada) ou já foi feita por outro meio. Fica na trilha de auditoria.'
            : 'O motivo fica na linha do tempo e na trilha de auditoria.'
        }
        footer={
          <Button loading={busy} disabled={(motivo?.texto.trim().length ?? 0) < 10} onClick={confirmarMotivo}>
            Confirmar
          </Button>
        }
      >
        <Field label="Motivo (mínimo de 10 caracteres)" htmlFor="vig-motivo-acao">
          <Textarea id="vig-motivo-acao" rows={3} value={motivo?.texto ?? ''} onChange={(e) => motivo && setMotivo({ ...motivo, texto: e.target.value })} />
        </Field>
      </Dialog>
      {sms && d.status !== 'DESCARTADA' && sms.situacao === 'VENCIDO' && (
        <Alert tone="error">O prazo perante a vigilância municipal venceu. Confirme e comunique assim que possível: a notificação continua obrigatória.</Alert>
      )}
    </div>
  );
}
