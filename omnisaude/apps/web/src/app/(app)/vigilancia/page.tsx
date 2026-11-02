'use client';

import { BellPlus, FileDown, Lock, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { FichaNotificacao } from '@/components/vigilancia/ficha-notificacao';
import { CatalogoTab, CodigosTab, PlantaoTab, SistemasTab } from '@/components/vigilancia/gestao';
import { MapaCasosTab } from '@/components/vigilancia/mapa-casos';
import { NovaNotificacaoDialog } from '@/components/vigilancia/nova-notificacao';
import { DIGITACAO, ORIGEM, SITUACAO, STATUS, tempoAte, type FilaDigitacao, type NotificacaoResumo, type PainelVigilancia, type SugestaoSrag } from '@/components/vigilancia/types';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { fmtDateTime, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

function Linha({ n, ativa, onClick }: { n: NotificacaoResumo; ativa: boolean; onClick: () => void }) {
  const sms = n.situacaoSms ?? 'SEM_PRAZO';
  const pior = [sms, ...n.repasses.map((r) => r.situacao)].find((s) => s === 'VENCIDO') ?? (sms !== 'CUMPRIDO' ? sms : (n.repasses.find((r) => r.situacao !== 'CUMPRIDO')?.situacao ?? 'CUMPRIDO'));
  return (
    <li>
      <button type="button" onClick={onClick} className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-slate-50 ${ativa ? 'bg-brand-50' : ''}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-medium">
            {n.sigiloso && <Lock className="h-3.5 w-3.5 text-violet-600" aria-label="Sigilosa" />}
            {n.agravo}
          </span>
          <span className="flex shrink-0 gap-1">
            {n.prazo && <Badge tone={n.prazo === 'IMEDIATA' ? 'red' : 'amber'}>{n.prazo === 'IMEDIATA' ? 'Imediata' : 'Semanal'}</Badge>}
            <Badge tone={STATUS[n.status]!.tone}>{STATUS[n.status]!.label}</Badge>
          </span>
        </div>
        <p className="text-xs text-slate-500">{[n.numero, n.paciente ?? 'paciente sob sigilo', n.unidade, n.origem ? (ORIGEM[n.origem] ?? n.origem) : null].filter(Boolean).join(' · ')}</p>
        <p className="flex flex-wrap items-center gap-1.5 text-xs">
          {n.status !== 'DESCARTADA' && n.situacaoSms && <Badge tone={SITUACAO[pior].tone}>{SITUACAO[pior].label}</Badge>}
          {n.status !== 'DESCARTADA' && n.situacaoSms && n.situacaoSms !== 'CUMPRIDO' && n.venceEm && <span>{tempoAte(n.venceEm)}</span>}
          {n.status === 'NOTIFICADA' && n.prazo === 'IMEDIATA' && !n.ciencia && <Badge tone="amber">Aguardando ciência</Badge>}
          {n.repasses
            .filter((r) => r.situacao !== 'CUMPRIDO' && r.situacao !== 'SEM_PRAZO')
            .map((r) => (
              <Badge key={r.esfera} tone={SITUACAO[r.situacao].tone}>
                Repasse {r.esfera}
              </Badge>
            ))}
          {n.escalada && <Badge tone="red">Escalada</Badge>}
          {n.policial && n.policial.situacao !== 'CUMPRIDO' && (
            <Badge tone={SITUACAO[n.policial.situacao].tone}>
              <ShieldAlert className="h-3 w-3" /> Autoridade policial
            </Badge>
          )}
          {n.digitacao && (n.status !== 'DESCARTADA' || n.numeroOficial) && <Badge tone={DIGITACAO[n.digitacao]!.tone}>{n.numeroOficial ? `Nº ${n.numeroOficial}` : DIGITACAO[n.digitacao]!.label}</Badge>}
          {n.naoHomologado && <Badge tone="slate">Não homologado</Badge>}
        </p>
      </button>
    </li>
  );
}

export default function VigilanciaPage() {
  const session = useSession();
  const router = useRouter();
  const painelOk = session.can('vigilancia.painel');
  const notifica = session.can('notificacao.registrar');
  const gere = session.can('vigilancia.catalogo');
  const digita = session.can('vigilancia.digitar');
  const exporta = session.can('vigilancia.exportar');
  const mapaOk = session.can('vigilancia.mapa');
  const toast = useToast();
  const [sistema, setSistema] = useState('');
  const [situacaoFila, setSituacaoFila] = useState('PENDENTE');
  const [periodo, setPeriodo] = useState({ de: todayIso(-30), ate: todayIso() });
  const [tab, setTab] = useState(painelOk ? 'painel' : notifica ? 'minhas' : 'resumo');
  const [status, setStatus] = useState('');
  const [situacao, setSituacao] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [nova, setNova] = useState(false);
  const painel = useApi<PainelVigilancia>(painelOk && tab === 'painel' ? `/vigilancia/painel?${new URLSearchParams({ ...(status ? { status } : {}), ...(situacao ? { situacao } : {}) })}` : null, [tab, status, situacao]);
  const minhas = useApi<NotificacaoResumo[]>(notifica && tab === 'minhas' ? '/vigilancia/notificacoes/minhas' : null, [tab]);
  const descartes = useApi<(NotificacaoResumo & { motivo: string | null; descartadaEm: string | null })[]>(painelOk && tab === 'descartes' ? '/vigilancia/descartes' : null, [tab]);
  const resumo = useApi<{ imediatasNoPrazo: number; vencidas: number; repassesPendentes: number; comunicacoesPoliciaisVencidas: number; semana: string }>(!painelOk && !notifica ? '/vigilancia/resumo' : null);
  const fila = useApi<FilaDigitacao>(digita && tab === 'digitacao' ? `/vigilancia/digitacao?${new URLSearchParams({ ...(sistema ? { sistema } : {}), situacao: situacaoFila })}` : null, [tab, sistema, situacaoFila]);
  const srag = useApi<SugestaoSrag[]>(painelOk && tab === 'painel' ? '/vigilancia/srag/sugestoes' : null, [tab]);
  async function notificarSrag(s: SugestaoSrag) {
    try {
      // Ligada à internação: a unidade notificadora é o hospital, não a de quem clica.
      const n = await api.post<{ id: string }>('/vigilancia/notificacoes', { patientId: s.patientId, conditionKey: 'srag-coronavirus', encounterId: s.encounterId, admissionId: s.admissionId });
      toast.success('Notificação de Srag aberta.');
      setSel(n.id);
      await Promise.all([painel.reload(), srag.reload()]);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  async function exportar() {
    try {
      // Mesma situação da fila na tela (lembretes de DNV/DO não têm ficha a exportar).
      const r = await api.download(
        `/vigilancia/exportacao.csv?${new URLSearchParams({ ...(sistema ? { sistema } : {}), ...(situacaoFila === 'PENDENTE' || situacaoFila === 'DIGITADA' ? { situacao: situacaoFila } : {}), de: periodo.de, ate: periodo.ate })}`,
      );
      saveBlob(r.blob, r.fileName ?? 'notificacoes.csv');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  useRealtime('vigilancia:notificacao', () => {
    if (tab === 'painel') void painel.reload();
    if (tab === 'minhas') void minhas.reload();
    if (tab === 'digitacao') void fila.reload();
  });
  useRealtime('vigilancia:escalada', () => void painel.reload());

  const tabs = [
    ...(painelOk ? [{ value: 'painel', label: 'Painel da vigilância' }] : []),
    ...(notifica ? [{ value: 'minhas', label: 'Minhas notificações' }] : []),
    ...(digita ? [{ value: 'digitacao', label: 'Digitação nos sistemas oficiais' }] : []),
    ...(mapaOk ? [{ value: 'mapa', label: 'Mapa de casos' }] : []),
    ...(painelOk ? [{ value: 'descartes', label: 'Descartes' }] : []),
    ...(painelOk ? [{ value: 'catalogo', label: 'Lista (LNNC)' }] : []),
    ...(painelOk ? [{ value: 'codigos', label: 'Códigos' }] : []),
    ...(painelOk ? [{ value: 'sistemas', label: 'Sistemas oficiais' }] : []),
    ...(gere ? [{ value: 'plantao', label: 'Plantão e contatos' }] : []),
    ...(!painelOk && !notifica ? [{ value: 'resumo', label: 'Resumo' }] : []),
  ];
  const lista = tab === 'painel' ? painel.data?.notificacoes : tab === 'minhas' ? minhas.data : tab === 'descartes' ? descartes.data : tab === 'digitacao' ? fila.data?.notificacoes : undefined;
  // Carregamento e erro da aba aberta (o erro de uma aba não aparece nas outras).
  const atual = tab === 'painel' ? painel : tab === 'minhas' ? minhas : tab === 'descartes' ? descartes : tab === 'digitacao' ? fila : null;
  const carregando = !!atual && atual.loading && !atual.data;
  const c = painel.data?.cartoes;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Vigilância em saúde"
        description="Notificação compulsória (Anexo V da PRC GM/MS nº 4/2017, lista da PRT GM/MS nº 11.211/2026): imediata em 24 h e semanal em 7 dias, ciência e repasse da vigilância municipal."
        actions={
          notifica ? (
            <Button onClick={() => setNova(true)} id="vig-nova">
              <BellPlus className="h-4 w-4" /> Notificar agravo
            </Button>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={(v) => (setTab(v), setSel(null))} tabs={tabs}>
        {(['painel', 'minhas', 'descartes', 'digitacao'] as const).map((t) => (
          <TabPanel key={t} value={t}>
            {t === 'painel' && c && (
              <div className="mb-4 grid gap-3 md:grid-cols-6" id="vig-cartoes">
                <Stat label="Imediatas aguardando ciência" value={c.imediatasAguardandoCiencia} tone={c.imediatasAguardandoCiencia ? 'warn' : 'good'} />
                <Stat label="Rascunhos imediatos" value={c.rascunhosImediatos} tone={c.rascunhosImediatos ? 'warn' : 'default'} />
                <Stat label="Repasses pendentes (SES/MS)" value={c.repassesPendentes} tone={c.repassesPendentes ? 'warn' : 'good'} />
                <Stat label="Vencidas" value={c.vencidas} tone={c.vencidas ? 'bad' : 'good'} />
                <Stat label="Semanais em rascunho" value={c.semanaisAVencer} />
                <Stat label="Descartes (30 d)" value={c.descartes30d} hint={`Semana epidemiológica ${painel.data!.semanaAtual.slice(4)}/${painel.data!.semanaAtual.slice(0, 4)}`} />
                <Stat label="Comunicação policial pendente" value={c.comunicacoesPoliciais} tone={c.comunicacoesPoliciais ? 'bad' : 'good'} hint="Violência contra a mulher, 24 h" />
                <Stat label="Pendentes de digitação" value={c.pendentesDigitacao} tone={c.pendentesDigitacao ? 'warn' : 'good'} hint="Sinan, e-SUS Sinan, Notifica, Sivep" />
                {c.encerramentoVencido !== null && <Stat label="Encerramento vencido" value={c.encerramentoVencido} tone={c.encerramentoVencido ? 'bad' : 'good'} hint="Prazos definidos pela vigilância" />}
                {c.positivoAposFechamento > 0 && <Stat label="Positivo após encerramento ou descarte" value={c.positivoAposFechamento} tone="bad" hint="Últimos 30 dias: avaliar reabrir" />}
              </div>
            )}
            {t === 'painel' && !!srag.data?.length && (
              <Card className="mb-4" id="vig-srag">
                <CardHeader
                  title="Internações com indício de Srag"
                  description="CID respiratório agudo ou sinal de Srag na triagem (SpO2 ≤ 94%, dispneia ou desconforto respiratório, taquipneia; NT nº 11/2026), sem notificação de Srag. Avalie e notifique no Sivep-Gripe."
                />
                <CardBody className="flex flex-col gap-2 text-sm">
                  {srag.data.map((x) => (
                    <div key={x.admissionId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2">
                      <span>
                        <b>{x.paciente}</b> · {x.unidade} · internado em {fmtDateTime(x.internadoEm)} · CID {x.cid}
                        {x.cidRespiratorio ? ' (respiratório)' : ''}
                        {x.sinais.length ? ` · ${x.sinais.join(', ')}` : ''}
                      </span>
                      {notifica && (
                        <Button size="sm" variant="secondary" onClick={() => notificarSrag(x)}>
                          Notificar Srag
                        </Button>
                      )}
                    </div>
                  ))}
                </CardBody>
              </Card>
            )}
            {t === 'digitacao' && fila.data && (
              <div className="mb-4 flex flex-col gap-3" id="vig-digitacao">
                <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                  {fila.data.sistemas.map((x) => (
                    <button
                      key={x.sistema}
                      type="button"
                      onClick={() => setSistema(sistema === x.sistema ? '' : x.sistema)}
                      className={`rounded-lg border p-3 text-left ${sistema === x.sistema ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white'}`}
                    >
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{x.label}</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums">{x.digitacao ? x.pendentes : x.lembretes}</p>
                      <p className="text-xs text-slate-500">{x.digitacao ? `pendentes · ${x.digitadas} digitadas` : 'lembretes de DNV/DO'}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-500">Nenhum desses sistemas recebe dados de terceiros por API: a notificação é digitada lá e o número gerado é informado aqui, o que a tira da fila.</p>
                {exporta && (
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="De" htmlFor="exp-de">
                      <Input id="exp-de" type="date" value={periodo.de} onChange={(e) => setPeriodo({ ...periodo, de: e.target.value })} />
                    </Field>
                    <Field label="Até" htmlFor="exp-ate">
                      <Input id="exp-ate" type="date" value={periodo.ate} onChange={(e) => setPeriodo({ ...periodo, ate: e.target.value })} />
                    </Field>
                    <Button
                      variant="secondary"
                      onClick={exportar}
                      id="vig-exportar"
                      disabled={situacaoFila === 'LEMBRETE'}
                      title={situacaoFila === 'LEMBRETE' ? 'Lembretes de DNV/DO não têm ficha a exportar' : undefined}
                    >
                      <FileDown className="h-4 w-4" /> Exportar CSV ({situacaoFila === 'DIGITADA' ? 'digitadas' : situacaoFila === 'PENDENTE' ? 'pendentes' : 'dicionário do Sinan'})
                    </Button>
                  </div>
                )}
              </div>
            )}
            <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <Card>
                <CardHeader
                  title={t === 'painel' ? 'Notificações' : t === 'minhas' ? 'Minhas notificações' : t === 'digitacao' ? 'Fila de digitação' : 'Descartadas'}
                  actions={
                    t === 'digitacao' ? (
                      <Select value={situacaoFila} onChange={(e) => setSituacaoFila(e.target.value)} aria-label="Situação na fila">
                        <option value="PENDENTE">Pendentes</option>
                        <option value="DIGITADA">Digitadas</option>
                        <option value="LEMBRETE">Lembretes de DNV/DO</option>
                      </Select>
                    ) : t === 'painel' ? (
                      <div className="flex flex-wrap gap-2">
                        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação da notificação">
                          <option value="">Abertas e notificadas</option>
                          <option value="RASCUNHO">Rascunhos</option>
                          <option value="NOTIFICADA">Notificadas</option>
                        </Select>
                        <Select value={situacao} onChange={(e) => setSituacao(e.target.value)} aria-label="Prazo">
                          <option value="">Qualquer prazo</option>
                          <option value="VENCIDO">Vencidas</option>
                          <option value="A_VENCER">Vencem em até 6 h</option>
                          <option value="NO_PRAZO">No prazo</option>
                          <option value="REPASSE">Repasse pendente</option>
                        </Select>
                      </div>
                    ) : undefined
                  }
                />
                <CardBody className="p-0">
                  {carregando && <Spinner />}
                  {atual?.error && <Alert tone="error">{atual.error}</Alert>}
                  {lista && lista.length === 0 && <EmptyState title="Nenhuma notificação" description={t === 'minhas' ? 'Os rascunhos abertos ao assinar um registro com agravo da lista aparecem aqui.' : undefined} />}
                  <ul className="divide-y divide-slate-100" id="vig-lista">
                    {lista?.map((n) => (
                      <Linha key={n.id} n={n} ativa={sel === n.id} onClick={() => setSel(n.id)} />
                    ))}
                  </ul>
                </CardBody>
              </Card>
              <div>
                {sel ? (
                  <FichaNotificacao
                    key={sel}
                    id={sel}
                    onChanged={() => {
                      void painel.reload();
                      void minhas.reload();
                    }}
                  />
                ) : (
                  <Card>
                    <CardBody>
                      <EmptyState title="Escolha uma notificação" description="Prazo por esfera, campos da ficha, confirmação, ciência, comunicações e linha do tempo." />
                    </CardBody>
                  </Card>
                )}
              </div>
            </div>
          </TabPanel>
        ))}
        {mapaOk && <TabPanel value="mapa">{tab === 'mapa' && <MapaCasosTab />}</TabPanel>}
        <TabPanel value="catalogo">
          <CatalogoTab podeGerir={gere} />
        </TabPanel>
        <TabPanel value="codigos">
          <CodigosTab podeGerir={gere} />
        </TabPanel>
        <TabPanel value="sistemas">
          <SistemasTab podeGerir={gere} />
        </TabPanel>
        <TabPanel value="plantao">
          <PlantaoTab />
        </TabPanel>
        <TabPanel value="resumo">
          {resumo.data && (
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Imediatas no prazo" value={resumo.data.imediatasNoPrazo} tone="good" />
              <Stat label="Vencidas" value={resumo.data.vencidas} tone={resumo.data.vencidas ? 'bad' : 'good'} />
              <Stat label="Repasses pendentes" value={resumo.data.repassesPendentes} />
              <Stat label="Comunicações policiais vencidas" value={resumo.data.comunicacoesPoliciaisVencidas} tone={resumo.data.comunicacoesPoliciaisVencidas ? 'bad' : 'good'} />
              <Stat label="Semana epidemiológica" value={`${resumo.data.semana.slice(4)}/${resumo.data.semana.slice(0, 4)}`} />
            </div>
          )}
          <p className="mt-3 text-sm text-slate-500">A gestão vê só contagens; a lista nominal fica com a vigilância epidemiológica (sigilo, art. 7º do Anexo V). Atualizado em {fmtDateTime(new Date())}.</p>
        </TabPanel>
      </Tabs>
      <NovaNotificacaoDialog open={nova} onOpenChange={setNova} onCreated={(id) => router.push(`/vigilancia/notificacao?id=${id}`)} />
    </div>
  );
}
