'use client';

import { ASSUNTO_MANIFESTACAO, TIPO_MANIFESTACAO } from '@omnisaude/shared';
import { ArchiveX, CalendarClock, CheckCircle2, Forward, MessageSquarePlus, Star } from 'lucide-react';
import { useState } from 'react';
import type { ManifestacaoDetalhe, ManifestacaoResumo, OuvidoriaPainel, SatisfacaoPainel } from '@/components/ombudsman/types';
import { PatientSearch } from '@/components/patients/patient-search';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

const STATUS_TONE: Record<string, 'blue' | 'amber' | 'green' | 'slate' | 'violet'> = { RECEBIDA: 'blue', EM_ANALISE: 'amber', PRORROGADA: 'violet', RESPONDIDA: 'green', ENCERRADA: 'slate', ARQUIVADA: 'slate' };
const PRAZO: Record<string, { label: string; tone: 'green' | 'amber' | 'red' }> = {
  NO_PRAZO: { label: 'No prazo', tone: 'green' },
  VENCE_EM_BREVE: { label: 'Vence em breve', tone: 'amber' },
  VENCIDA: { label: 'Vencida', tone: 'red' },
};
const CANAL: Record<string, string> = { APP: 'App', WHATSAPP: 'WhatsApp', PRESENCIAL: 'Presencial', TELEFONE: 'Telefone', SITE: 'Site' };
const EVENTO: Record<string, string> = {
  RECEBIDA: 'Recebida',
  ENCAMINHADA: 'Encaminhada',
  PRORROGADA: 'Prazo prorrogado',
  RESPONDIDA: 'Respondida',
  ENCERRADA: 'Encerrada',
  ARQUIVADA: 'Arquivada',
  AVALIADA: 'Avaliada pelo cidadão',
};

export default function OmbudsmanPage() {
  const session = useSession();
  const toast = useToast();
  const [tab, setTab] = useState('manifestacoes');
  const [status, setStatus] = useState('ABERTAS');
  const [busca, setBusca] = useState('');
  const [prazo, setPrazo] = useState('');
  const [selecionada, setSelecionada] = useState<string | null>(null);
  const [nova, setNova] = useState(false);
  const [acao, setAcao] = useState<'encaminhar' | 'prorrogar' | 'responder' | 'arquivar' | null>(null);
  const [texto, setTexto] = useState('');
  const [acaoUnit, setAcaoUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ kind: 'RECLAMACAO', channel: 'PRESENCIAL', subject: 'ATENDIMENTO', unitId: '', text: '', anonymous: false, patientId: '', patientName: '', contactName: '', contactPhone: '' });
  const painel = useApi<OuvidoriaPainel>('/ouvidoria/painel');
  const lista = useApi<ManifestacaoResumo[]>(`/ouvidoria/manifestacoes?${new URLSearchParams({ ...(status ? { status } : {}), ...(busca ? { busca } : {}), ...(prazo ? { prazo } : {}) })}`, [status, busca, prazo]);
  const detalhe = useApi<ManifestacaoDetalhe>(selecionada ? `/ouvidoria/manifestacoes/${selecionada}` : null, [selecionada]);
  const satisfacao = useApi<SatisfacaoPainel>(tab === 'satisfacao' ? '/ouvidoria/satisfacao' : null, [tab]);
  const unidades = useApi<{ id: string; name: string }[]>('/ouvidoria/unidades');
  useRealtime('ouvidoria.manifestacao', () => {
    void lista.reload();
    void painel.reload();
    if (selecionada) void detalhe.reload();
  });
  const gerir = session.can('ouvidoria.gerir');

  async function registrar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const m = await api.post<ManifestacaoDetalhe>('/ouvidoria/manifestacoes', {
        kind: form.kind,
        channel: form.channel,
        subject: form.subject,
        text: form.text,
        unitId: form.unitId || null,
        patientId: form.anonymous ? null : form.patientId || null,
        anonymous: form.anonymous,
        contactName: form.contactName || null,
        contactPhone: form.contactPhone || null,
      });
      toast.success(`Manifestação registrada: protocolo ${m.protocolo}.`);
      setNova(false);
      setForm({ kind: 'RECLAMACAO', channel: 'PRESENCIAL', subject: 'ATENDIMENTO', unitId: '', text: '', anonymous: false, patientId: '', patientName: '', contactName: '', contactPhone: '' });
      await Promise.all([lista.reload(), painel.reload()]);
      setSelecionada(m.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function executar() {
    if (!selecionada || !acao) return;
    setBusy(true);
    try {
      if (acao === 'encaminhar') await api.post(`/ouvidoria/manifestacoes/${selecionada}/encaminhar`, { unitId: acaoUnit || null, notes: texto || null });
      if (acao === 'prorrogar') await api.post(`/ouvidoria/manifestacoes/${selecionada}/prorrogar`, { reason: texto });
      if (acao === 'responder') await api.post(`/ouvidoria/manifestacoes/${selecionada}/responder`, { text: texto });
      if (acao === 'arquivar') await api.post(`/ouvidoria/manifestacoes/${selecionada}/encerrar`, { arquivar: true, notes: texto });
      toast.success(acao === 'responder' ? 'Resposta enviada ao cidadão.' : 'Manifestação atualizada.');
      setAcao(null);
      setTexto('');
      await Promise.all([detalhe.reload(), lista.reload(), painel.reload()]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function encerrar() {
    if (!selecionada) return;
    try {
      await api.post(`/ouvidoria/manifestacoes/${selecionada}/encerrar`, {});
      toast.success('Manifestação encerrada.');
      await Promise.all([detalhe.reload(), lista.reload(), painel.reload()]);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const p = painel.data;
  // Só a manifestação selecionada: enquanto a nova carrega (ou se falhar), não mostra a anterior com as ações apontando para outra.
  const d = detalhe.data && detalhe.data.id === selecionada ? detalhe.data : null;
  const s = satisfacao.data;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Ouvidoria e satisfação"
        description="Manifestações do cidadão com protocolo e prazo legal (Lei 13.460/2017) e pesquisa de satisfação após o atendimento."
        actions={
          session.can('ouvidoria.registrar') ? (
            <Button onClick={() => setNova(true)} id="ouv-nova">
              <MessageSquarePlus className="h-4 w-4" /> Registrar manifestação
            </Button>
          ) : undefined
        }
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'manifestacoes', label: 'Manifestações' },
          { value: 'satisfacao', label: 'Pesquisa de satisfação' },
        ]}
      >
        <TabPanel value="manifestacoes">
          {p && (
            <div className="mb-4 grid gap-3 md:grid-cols-6">
              <Stat label="Abertas" value={p.abertas} />
              <Stat label="No prazo" value={p.noPrazo} tone="good" />
              <Stat label="Vencem em 5 dias" value={p.vencendo} tone={p.vencendo ? 'warn' : 'default'} />
              <Stat label="Vencidas" value={p.vencidas} tone={p.vencidas ? 'bad' : 'good'} />
              <Stat label="Respondidas (30 d)" value={p.respondidas30d} hint={p.respondidas30d ? `${p.respondidasNoPrazo30d} no prazo · ${p.tempoMedioRespostaDias ?? '—'} dias em média` : undefined} />
              <Stat label="Avaliação da resposta" value={p.avaliacaoMedia != null ? `${p.avaliacaoMedia} / 5` : '—'} hint={`${p.avaliacoes} avaliações`} />
            </div>
          )}
          {p && (p.porTipo.length > 0 || p.porAssunto.length > 0 || p.porUnidade.length > 0) && (
            <div className="mb-4 grid gap-3 md:grid-cols-3" id="ouv-distribuicoes">
              {(
                [
                  ['Por tipo (30 dias)', p.porTipo.map((t) => ({ k: t.tipo, label: t.label, total: t.total }))],
                  ['Assuntos mais citados (30 dias)', p.porAssunto.map((a) => ({ k: a.assunto, label: a.label, total: a.total }))],
                  ['Por unidade (30 dias)', p.porUnidade.map((u) => ({ k: u.unitId ?? u.unidade, label: u.unidade, total: u.total }))],
                ] as const
              ).map(([titulo, itens]) => {
                const max = Math.max(1, ...itens.map((i) => i.total));
                return (
                  <Card key={titulo}>
                    <CardHeader title={titulo} />
                    <CardBody className="flex flex-col gap-1.5">
                      {itens.length === 0 && <p className="text-sm text-slate-500">Sem manifestações no período.</p>}
                      {itens.map((i) => (
                        <div key={i.k} className="flex items-center gap-2 text-sm">
                          <span className="w-40 shrink-0 truncate" title={i.label}>
                            {i.label}
                          </span>
                          <div className="h-2.5 flex-1 rounded bg-slate-100">
                            <div className="h-2.5 rounded bg-brand-500" style={{ width: `${Math.round((i.total / max) * 100)}%` }} />
                          </div>
                          <span className="w-8 text-right text-xs text-slate-500">{i.total}</span>
                        </div>
                      ))}
                    </CardBody>
                  </Card>
                );
              })}
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Card>
              <CardHeader
                title="Manifestações"
                actions={
                  <div className="flex flex-wrap gap-2">
                    <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação">
                      <option value="ABERTAS">Abertas</option>
                      <option value="">Todas</option>
                      <option value="RESPONDIDA">Respondidas</option>
                      <option value="ENCERRADA">Encerradas</option>
                      <option value="ARQUIVADA">Arquivadas</option>
                    </Select>
                    <Select value={prazo} onChange={(e) => setPrazo(e.target.value)} aria-label="Prazo">
                      <option value="">Qualquer prazo</option>
                      <option value="VENCIDA">Vencidas</option>
                      <option value="VENCE_EM_BREVE">Vencem em breve</option>
                      <option value="NO_PRAZO">No prazo</option>
                    </Select>
                    <Input placeholder="Protocolo, nome ou texto" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar manifestação" className="w-44" />
                  </div>
                }
              />
              <CardBody className="p-0">
                {lista.loading && !lista.data && <Spinner />}
                {lista.error && <Alert tone="error">{lista.error}</Alert>}
                {lista.data && lista.data.length === 0 && <EmptyState title="Nenhuma manifestação" description="As manifestações do app, do WhatsApp e do balcão aparecem aqui." />}
                <ul className="divide-y divide-slate-100">
                  {lista.data?.map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => setSelecionada(m.id)} className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-slate-50 ${selecionada === m.id ? 'bg-brand-50' : ''}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">
                            {m.tipoLabel} · {m.assuntoLabel}
                          </span>
                          <span className="flex gap-1">
                            {m.prazo && <Badge tone={PRAZO[m.prazo.situacao]!.tone}>{PRAZO[m.prazo.situacao]!.label}</Badge>}
                            <Badge tone={STATUS_TONE[m.status] ?? 'slate'}>{m.statusLabel}</Badge>
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {m.protocolo} · {CANAL[m.canal] ?? m.canal} · {fmtDate(m.recebidaEm)} · {m.identificado ? (m.pessoa?.nome ?? 'sem nome') : 'sem identificação'}
                          {m.unidade ? ` · ${m.unidade.nome}` : ''}
                        </p>
                        <p className="truncate text-sm text-slate-600">{m.resumo}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
            <Card>
              {!selecionada && (
                <CardBody>
                  <EmptyState title="Escolha uma manifestação" description="Texto completo, linha do tempo, encaminhamento, prorrogação e resposta." />
                </CardBody>
              )}
              {selecionada && !d && !detalhe.error && <Spinner />}
              {selecionada && detalhe.error && (
                <CardBody>
                  <Alert tone="error">{detalhe.error}</Alert>
                </CardBody>
              )}
              {d && (
                <>
                  <CardHeader
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        {d.protocolo} <Badge tone={STATUS_TONE[d.status] ?? 'slate'}>{d.statusLabel}</Badge>
                        {d.prazo && <Badge tone={PRAZO[d.prazo.situacao]!.tone}>{d.prazo.situacao === 'VENCIDA' ? `Vencida há ${-d.prazo.diasRestantes} dias` : `${d.prazo.diasRestantes} dias para responder`}</Badge>}
                      </span>
                    }
                    description={`${d.tipoLabel} · ${d.assuntoLabel} · ${d.canalLabel} · recebida em ${fmtDateTime(d.recebidaEm)} · prazo ${fmtDate(d.venceEm)}${d.prorrogada ? ' (prorrogado)' : ''}`}
                    actions={
                      gerir && d.prazo ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setAcao('encaminhar');
                              setTexto('');
                              setAcaoUnit(d.unidadeDestino?.id ?? d.unidade?.id ?? '');
                            }}
                          >
                            <Forward className="h-4 w-4" /> Encaminhar
                          </Button>
                          {!d.prorrogada && d.prazo.situacao !== 'VENCIDA' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setAcao('prorrogar');
                                setTexto('');
                              }}
                            >
                              <CalendarClock className="h-4 w-4" /> Prorrogar
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="success"
                            onClick={() => {
                              setAcao('responder');
                              setTexto('');
                            }}
                            id="ouv-responder"
                          >
                            <CheckCircle2 className="h-4 w-4" /> Responder
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setAcao('arquivar');
                              setTexto('');
                            }}
                          >
                            <ArchiveX className="h-4 w-4" /> Arquivar
                          </Button>
                        </div>
                      ) : gerir && d.status === 'RESPONDIDA' ? (
                        <Button size="sm" variant="secondary" onClick={encerrar}>
                          Encerrar
                        </Button>
                      ) : undefined
                    }
                  />
                  <CardBody className="flex flex-col gap-3">
                    <div className="grid gap-2 text-sm md:grid-cols-2">
                      <p>
                        <span className="text-slate-500">Quem: </span>
                        {d.identificado ? `${d.pessoa?.nome ?? 'sem nome'}${d.contato ? ` · ${d.contato}` : ''}` : 'Manifestação sem identificação (a pedido do cidadão)'}
                      </p>
                      <p>
                        <span className="text-slate-500">Unidade: </span>
                        {d.unidade?.nome ?? '—'}
                        {d.unidadeDestino && d.unidadeDestino.id !== d.unidade?.id ? ` → ${d.unidadeDestino.nome}` : ''}
                        {d.responsavel ? ` · ${d.responsavel}` : ''}
                      </p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap">{d.texto}</div>
                    {d.resposta && (
                      <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
                        <p className="text-xs font-semibold uppercase text-green-800">
                          Resposta conclusiva{d.resposta.por ? ` · ${d.resposta.por}` : ''}
                          {d.resposta.em ? ` · ${fmtDateTime(d.resposta.em)}` : ''}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap">{d.resposta.texto}</p>
                      </div>
                    )}
                    {d.avaliacao && (
                      <p className="flex items-center gap-1 text-sm text-amber-700">
                        <Star className="h-4 w-4 fill-amber-400 text-amber-400" /> Cidadão avaliou a resposta com {d.avaliacao.nota}/5{d.avaliacao.comentario ? `: “${d.avaliacao.comentario}”` : ''}
                      </p>
                    )}
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase text-slate-500">Linha do tempo</p>
                      <ol className="space-y-1 text-sm">
                        {d.eventos.map((e) => (
                          <li key={e.id} className="flex gap-2">
                            <span className="w-32 shrink-0 text-xs text-slate-500">{fmtDateTime(e.em)}</span>
                            <span>
                              <b>{EVENTO[e.tipo] ?? e.tipo}</b>
                              {e.por ? ` · ${e.por}` : ''}
                              {e.notas ? `: ${e.notas}` : ''}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </CardBody>
                </>
              )}
            </Card>
          </div>
        </TabPanel>
        <TabPanel value="satisfacao">
          {satisfacao.loading && !s && <Spinner />}
          {satisfacao.error && <Alert tone="error">{satisfacao.error}</Alert>}
          {s && (
            <div className="flex flex-col gap-4">
              <div className="grid gap-3 md:grid-cols-5">
                <Stat label="Pesquisas (90 dias)" value={s.geral.enviadas} hint={`${s.porCanal.whatsapp} pelo WhatsApp · ${s.porCanal.app} pelo app`} />
                <Stat label="Taxa de resposta" value={s.geral.taxaResposta != null ? `${s.geral.taxaResposta}%` : '—'} />
                <Stat label="Nota média" value={s.geral.media != null ? `${s.geral.media} / 5` : '—'} tone={s.geral.media != null ? (s.geral.media >= 4 ? 'good' : s.geral.media >= 3 ? 'warn' : 'bad') : 'default'} />
                <Stat label="NPS" value={s.geral.nps != null ? s.geral.nps : '—'} hint="recomendaria a unidade (0 a 10)" />
                <Stat label="Comentários" value={s.totalComentarios} hint={s.totalComentarios > s.comentarios.length ? `${s.comentarios.length} mais recentes abaixo` : undefined} />
              </div>
              <Card>
                <CardHeader title="Distribuição das notas" />
                <CardBody>
                  <div className="flex flex-col gap-1">
                    {([5, 4, 3, 2, 1] as const).map((n) => {
                      const total = s.geral.distribuicao[String(n) as '1'];
                      const pct = s.geral.respondidas ? Math.round((total / s.geral.respondidas) * 100) : 0;
                      return (
                        <div key={n} className="flex items-center gap-2 text-sm">
                          <span className="w-16">{n} ★</span>
                          <div className="h-3 flex-1 rounded bg-slate-100">
                            <div className={`h-3 rounded ${n >= 4 ? 'bg-green-500' : n === 3 ? 'bg-amber-400' : 'bg-red-400'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="w-20 text-right text-xs text-slate-500">
                            {total} ({pct}%)
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </CardBody>
              </Card>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Por unidade" />
                  <Table>
                    <THead>
                      <TR>
                        <TH>Unidade</TH>
                        <TH>Respostas</TH>
                        <TH>Média</TH>
                        <TH>NPS</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {s.porUnidade.map((u) => (
                        <TR key={u.unitId}>
                          <TD>{u.unidade}</TD>
                          <TD>
                            {u.respondidas}/{u.enviadas}
                          </TD>
                          <TD>{u.media ?? '—'}</TD>
                          <TD>{u.nps ?? '—'}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </Card>
                <Card>
                  <CardHeader title={gerir ? 'Por profissional' : 'Comentários recentes'} description={gerir ? 'Visível para quem gere a ouvidoria.' : undefined} />
                  {gerir ? (
                    <Table>
                      <THead>
                        <TR>
                          <TH>Profissional</TH>
                          <TH>Respostas</TH>
                          <TH>Média</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {s.porProfissional.map((u) => (
                          <TR key={u.id}>
                            <TD>{u.nome}</TD>
                            <TD>{u.respondidas}</TD>
                            <TD>{u.media ?? '—'}</TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  ) : null}
                  <CardBody>
                    {gerir && <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Comentários recentes</p>}
                    {s.comentarios.length === 0 && <p className="text-sm text-slate-500">Sem comentários no período.</p>}
                    <ul className="space-y-2 text-sm">
                      {s.comentarios.map((c) => (
                        <li key={c.id} className="rounded-lg bg-slate-50 p-2">
                          <p className="text-xs text-slate-500">
                            {c.unidade} · nota {c.nota ?? '—'}
                            {c.em ? ` · ${fmtDate(c.em)}` : ''}
                          </p>
                          <p>“{c.comentario}”</p>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              </div>
            </div>
          )}
        </TabPanel>
      </Tabs>

      <Dialog open={nova} onOpenChange={setNova} title="Registrar manifestação" description="Recebida no balcão, por telefone ou pelo site. O protocolo sai na hora; o prazo legal de resposta é de 30 dias." size="lg">
        <form onSubmit={registrar} className="grid gap-3 md:grid-cols-2" id="ouv-form">
          <Field label="Tipo" htmlFor="ouvf-kind">
            <Select id="ouvf-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {Object.entries(TIPO_MANIFESTACAO).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Canal" htmlFor="ouvf-channel">
            <Select id="ouvf-channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              <option value="PRESENCIAL">Presencial</option>
              <option value="TELEFONE">Telefone</option>
              <option value="SITE">Site / e-mail</option>
            </Select>
          </Field>
          <Field label="Assunto" htmlFor="ouvf-subject">
            <Select id="ouvf-subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })}>
              {Object.entries(ASSUNTO_MANIFESTACAO).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unidade" htmlFor="ouvf-unit">
            <Select id="ouvf-unit" value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })}>
              <option value="">Não se aplica</option>
              {unidades.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="md:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={form.anonymous} onChange={(e) => setForm({ ...form, anonymous: e.target.checked })} /> O cidadão não quer se identificar
            </label>
          </div>
          {!form.anonymous && (
            <>
              <Field label="Paciente (opcional)" htmlFor="ouvf-patient" hint={form.patientName ? `Selecionado: ${form.patientName}` : undefined}>
                <PatientSearch onSelect={(p) => setForm({ ...form, patientId: p.id, patientName: p.name })} placeholder="Nome, CPF ou CNS" />
              </Field>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Nome do contato" htmlFor="ouvf-cname">
                  <Input id="ouvf-cname" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
                </Field>
                <Field label="Telefone" htmlFor="ouvf-cphone">
                  <Input id="ouvf-cphone" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
                </Field>
              </div>
            </>
          )}
          <Field label="Relato" htmlFor="ouvf-text" className="md:col-span-2">
            <Textarea id="ouvf-text" rows={5} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} required minLength={10} />
          </Field>
          <div className="flex justify-end gap-2 md:col-span-2">
            <Button type="button" variant="secondary" onClick={() => setNova(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={busy} id="ouvf-salvar">
              Registrar
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={!!acao}
        onOpenChange={(o) => !o && setAcao(null)}
        title={acao === 'encaminhar' ? 'Encaminhar para análise' : acao === 'prorrogar' ? 'Prorrogar o prazo (uma única vez)' : acao === 'responder' ? 'Resposta conclusiva ao cidadão' : 'Arquivar manifestação'}
        description={
          acao === 'prorrogar' ? 'Lei 13.460/2017, art. 16: mais 30 dias, com justificativa.' : acao === 'responder' ? 'A resposta vai para o app do cidadão e, com WhatsApp autorizado, chega por mensagem.' : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setAcao(null)}>
              Cancelar
            </Button>
            <Button loading={busy} onClick={executar} disabled={acao !== 'encaminhar' && texto.trim().length < 10} id="ouv-acao-confirmar">
              Confirmar
            </Button>
          </>
        }
      >
        {acao === 'encaminhar' && (
          <Field label="Unidade responsável" htmlFor="ouv-acao-unit">
            <Select id="ouv-acao-unit" value={acaoUnit} onChange={(e) => setAcaoUnit(e.target.value)}>
              <option value="">Manter</option>
              {unidades.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={acao === 'encaminhar' ? 'Observações' : acao === 'prorrogar' ? 'Justificativa' : acao === 'responder' ? 'Resposta' : 'Motivo do arquivamento'} htmlFor="ouv-acao-texto">
          <Textarea id="ouv-acao-texto" rows={5} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
