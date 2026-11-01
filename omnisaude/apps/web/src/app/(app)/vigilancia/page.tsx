'use client';

import { BellPlus, Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { FichaNotificacao } from '@/components/vigilancia/ficha-notificacao';
import { CatalogoTab, CodigosTab, PlantaoTab } from '@/components/vigilancia/gestao';
import { NovaNotificacaoDialog } from '@/components/vigilancia/nova-notificacao';
import { ORIGEM, SITUACAO, STATUS, tempoAte, type NotificacaoResumo, type PainelVigilancia } from '@/components/vigilancia/types';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

function Linha({ n, ativa, onClick }: { n: NotificacaoResumo; ativa: boolean; onClick: () => void }) {
  const pior =
    [n.situacaoSms, ...n.repasses.map((r) => r.situacao)].find((s) => s === 'VENCIDO') ?? (n.situacaoSms !== 'CUMPRIDO' ? n.situacaoSms : (n.repasses.find((r) => r.situacao !== 'CUMPRIDO')?.situacao ?? 'CUMPRIDO'));
  return (
    <li>
      <button type="button" onClick={onClick} className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-slate-50 ${ativa ? 'bg-brand-50' : ''}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-medium">
            {n.sigiloso && <Lock className="h-3.5 w-3.5 text-violet-600" aria-label="Sigilosa" />}
            {n.agravo}
          </span>
          <span className="flex shrink-0 gap-1">
            <Badge tone={n.prazo === 'IMEDIATA' ? 'red' : 'amber'}>{n.prazo === 'IMEDIATA' ? 'Imediata' : 'Semanal'}</Badge>
            <Badge tone={STATUS[n.status]!.tone}>{STATUS[n.status]!.label}</Badge>
          </span>
        </div>
        <p className="text-xs text-slate-500">
          {n.numero} · {n.paciente ?? 'paciente sob sigilo'} · {n.unidade} · {ORIGEM[n.origem] ?? n.origem}
        </p>
        <p className="flex flex-wrap items-center gap-1.5 text-xs">
          {n.status !== 'DESCARTADA' && <Badge tone={SITUACAO[pior].tone}>{SITUACAO[pior].label}</Badge>}
          {n.status !== 'DESCARTADA' && n.situacaoSms !== 'CUMPRIDO' && n.venceEm && <span>{tempoAte(n.venceEm)}</span>}
          {n.status === 'NOTIFICADA' && n.prazo === 'IMEDIATA' && !n.ciencia && <Badge tone="amber">Aguardando ciência</Badge>}
          {n.repasses
            .filter((r) => r.situacao !== 'CUMPRIDO' && r.situacao !== 'SEM_PRAZO')
            .map((r) => (
              <Badge key={r.esfera} tone={SITUACAO[r.situacao].tone}>
                Repasse {r.esfera}
              </Badge>
            ))}
          {n.escalada && <Badge tone="red">Escalada</Badge>}
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
  const [tab, setTab] = useState(painelOk ? 'painel' : notifica ? 'minhas' : 'resumo');
  const [status, setStatus] = useState('');
  const [situacao, setSituacao] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [nova, setNova] = useState(false);
  const painel = useApi<PainelVigilancia>(painelOk && tab === 'painel' ? `/vigilancia/painel?${new URLSearchParams({ ...(status ? { status } : {}), ...(situacao ? { situacao } : {}) })}` : null, [tab, status, situacao]);
  const minhas = useApi<NotificacaoResumo[]>(notifica && tab === 'minhas' ? '/vigilancia/notificacoes/minhas' : null, [tab]);
  const descartes = useApi<(NotificacaoResumo & { motivo: string | null; descartadaEm: string | null })[]>(painelOk && tab === 'descartes' ? '/vigilancia/descartes' : null, [tab]);
  const resumo = useApi<{ imediatasNoPrazo: number; vencidas: number; repassesPendentes: number; semana: string }>(!painelOk && !notifica ? '/vigilancia/resumo' : null);
  useRealtime('vigilancia:notificacao', () => {
    if (tab === 'painel') void painel.reload();
    if (tab === 'minhas') void minhas.reload();
  });
  useRealtime('vigilancia:escalada', () => void painel.reload());

  const tabs = [
    ...(painelOk ? [{ value: 'painel', label: 'Painel da vigilância' }] : []),
    ...(notifica ? [{ value: 'minhas', label: 'Minhas notificações' }] : []),
    ...(painelOk ? [{ value: 'descartes', label: 'Descartes' }] : []),
    ...(painelOk ? [{ value: 'catalogo', label: 'Lista (LNNC)' }] : []),
    ...(painelOk ? [{ value: 'codigos', label: 'Códigos' }] : []),
    ...(gere ? [{ value: 'plantao', label: 'Plantão e contatos' }] : []),
    ...(!painelOk && !notifica ? [{ value: 'resumo', label: 'Resumo' }] : []),
  ];
  const lista = tab === 'painel' ? painel.data?.notificacoes : tab === 'minhas' ? minhas.data : tab === 'descartes' ? descartes.data : undefined;
  const carregando = (tab === 'painel' && painel.loading && !painel.data) || (tab === 'minhas' && minhas.loading && !minhas.data);
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
        {(['painel', 'minhas', 'descartes'] as const).map((t) => (
          <TabPanel key={t} value={t}>
            {t === 'painel' && c && (
              <div className="mb-4 grid gap-3 md:grid-cols-6" id="vig-cartoes">
                <Stat label="Imediatas aguardando ciência" value={c.imediatasAguardandoCiencia} tone={c.imediatasAguardandoCiencia ? 'warn' : 'good'} />
                <Stat label="Rascunhos imediatos" value={c.rascunhosImediatos} tone={c.rascunhosImediatos ? 'warn' : 'default'} />
                <Stat label="Repasses pendentes (SES/MS)" value={c.repassesPendentes} tone={c.repassesPendentes ? 'warn' : 'good'} />
                <Stat label="Vencidas" value={c.vencidas} tone={c.vencidas ? 'bad' : 'good'} />
                <Stat label="Semanais em rascunho" value={c.semanaisAVencer} />
                <Stat label="Descartes (30 d)" value={c.descartes30d} hint={`Semana epidemiológica ${painel.data!.semanaAtual.slice(4)}/${painel.data!.semanaAtual.slice(0, 4)}`} />
              </div>
            )}
            <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <Card>
                <CardHeader
                  title={t === 'painel' ? 'Notificações' : t === 'minhas' ? 'Minhas notificações' : 'Descartadas'}
                  actions={
                    t === 'painel' ? (
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
                  {(painel.error || minhas.error) && <Alert tone="error">{painel.error ?? minhas.error}</Alert>}
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
        <TabPanel value="catalogo">
          <CatalogoTab podeGerir={gere} />
        </TabPanel>
        <TabPanel value="codigos">
          <CodigosTab podeGerir={gere} />
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
