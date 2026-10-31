'use client';

import { PRIORIDADES, STATUS_SOLICITACAO, type PrioridadeRegulacao, type StatusSolicitacao } from '@omnisaude/shared';
import { RefreshCw, Scale } from 'lucide-react';
import { useState } from 'react';
import { DetailDialog } from '@/components/regulation/detail-dialog';
import { PRIORIDADE_TONE, STATUS_TONE, type Protocolos, type Solicitacao } from '@/components/regulation/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi, useInterval } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

interface Fila {
  total: number;
  atrasadas: number;
  tempoMedioDias: number;
  porPrioridade: Record<PrioridadeRegulacao, number>;
  porEspecialidade: { codigo: string; nome: string; total: number; atrasadas: number }[];
  itens: Solicitacao[];
}
interface Painel {
  unidade: { unitId: string; porStatus: Record<StatusSolicitacao, number>; atrasadas: number };
  central: { porStatus: Record<StatusSolicitacao, number>; naFila: number } | null;
}

/** Regulação ambulatorial: fila única para quem regula, solicitações da unidade para quem solicita e acompanha. */
export default function RegulacaoPage() {
  const session = useSession();
  const regula = session.can('regulacao.regular');
  const [tab, setTab] = useState(regula ? 'fila' : 'unidade');
  const [filtro, setFiltro] = useState<{ specialty?: string; priority?: PrioridadeRegulacao; status?: StatusSolicitacao }>({});
  const [detalhe, setDetalhe] = useState<string | null>(null);
  const protocolos = useApi<Protocolos>('/regulacao/protocolos');
  const qFila = new URLSearchParams({ ...(filtro.specialty ? { specialty: filtro.specialty } : {}), ...(filtro.priority ? { priority: filtro.priority } : {}) }).toString();
  const fila = useApi<Fila>(regula && tab === 'fila' ? `/regulacao/fila${qFila ? `?${qFila}` : ''}` : null, [tab, qFila]);
  const qUnidade = new URLSearchParams({ ...(filtro.status ? { status: filtro.status } : {}), ...(filtro.specialty ? { specialty: filtro.specialty } : {}) }).toString();
  const unidade = useApi<Solicitacao[]>(tab === 'unidade' ? `/regulacao/solicitacoes${qUnidade ? `?${qUnidade}` : ''}` : null, [tab, qUnidade]);
  const painel = useApi<Painel>('/regulacao/painel');
  const recarregar = () => {
    void fila.reload();
    void unidade.reload();
    void painel.reload();
  };
  useRealtime('regulacao.atualizada', recarregar);
  useInterval(recarregar, 60_000);

  const opcoesEspecialidade = [
    ...(protocolos.data?.especialidades.map((e) => ({ codigo: e.codigo, nome: `Consulta · ${e.nome}` })) ?? []),
    ...(protocolos.data?.procedimentos.map((p) => ({ codigo: p.codigo, nome: `${p.tipo === 'EXAME' ? 'Exame' : 'Procedimento'} · ${p.nome}` })) ?? []),
  ];
  const u = painel.data?.unidade;

  return (
    <>
      <PageHeader
        title="Regulação ambulatorial"
        description={regula ? 'Fila única de consultas especializadas, exames e procedimentos: prioridade, protocolo e devolutiva.' : 'Solicitações da unidade à regulação e a devolutiva do regulador.'}
        actions={
          <Button variant="secondary" onClick={recarregar}>
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        }
      />
      {u && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <Stat label="Aguardando" value={u.porStatus.PENDENTE + u.porStatus.EM_ANALISE} hint="da unidade" tone={u.atrasadas ? 'warn' : 'default'} />
          <Stat label="Devolvidas" value={u.porStatus.DEVOLVIDA} tone={u.porStatus.DEVOLVIDA ? 'bad' : 'good'} hint="precisam de complementação" />
          <Stat label="Autorizadas" value={u.porStatus.AUTORIZADA + u.porStatus.AGENDADA} tone="good" />
          <Stat label="Negadas" value={u.porStatus.NEGADA} />
          <Stat label="Fora do prazo" value={u.atrasadas} tone={u.atrasadas ? 'bad' : 'good'} hint="prazo-meta vencido" />
          {painel.data?.central && <Stat label="Fila única" value={painel.data.central.naFila} hint="todas as unidades" />}
        </div>
      )}
      <Tabs value={tab} onValueChange={setTab} tabs={[...(regula ? [{ value: 'fila', label: 'Fila única' }] : []), { value: 'unidade', label: 'Solicitações da unidade' }, { value: 'protocolos', label: 'Protocolos' }]}>
        {regula && (
          <TabPanel value="fila">
            <Card>
              <CardHeader
                title="Fila única regulada"
                description={fila.data ? `${fila.data.total} na fila · ${fila.data.atrasadas} fora do prazo · espera média de ${fila.data.tempoMedioDias} dia(s)` : 'Carregando…'}
                actions={
                  <div className="flex flex-wrap gap-2">
                    <Select value={filtro.specialty ?? ''} onChange={(e) => setFiltro((f) => ({ ...f, specialty: e.target.value || undefined }))} aria-label="Especialidade" className="w-64">
                      <option value="">Todas as especialidades</option>
                      {opcoesEspecialidade.map((o) => (
                        <option key={o.codigo} value={o.codigo}>
                          {o.nome}
                        </option>
                      ))}
                    </Select>
                    <Select
                      value={filtro.priority ?? ''}
                      onChange={(e) => setFiltro((f) => ({ ...f, priority: (e.target.value || undefined) as PrioridadeRegulacao | undefined }))}
                      aria-label="Prioridade"
                      className="w-44"
                    >
                      <option value="">Todas as prioridades</option>
                      {(Object.keys(PRIORIDADES) as PrioridadeRegulacao[]).map((p) => (
                        <option key={p} value={p}>
                          {PRIORIDADES[p].label}
                        </option>
                      ))}
                    </Select>
                  </div>
                }
              />
              <CardBody className="p-0">
                {fila.error && (
                  <Alert tone="error" className="m-4">
                    {fila.error}
                  </Alert>
                )}
                {fila.loading && !fila.data && <Spinner />}
                {fila.data && (
                  <>
                    <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3 text-xs">
                      {(Object.keys(PRIORIDADES) as PrioridadeRegulacao[]).map((p) => (
                        <Badge key={p} tone={PRIORIDADE_TONE[p]}>
                          {PRIORIDADES[p].label}: {fila.data!.porPrioridade[p]}
                        </Badge>
                      ))}
                      {fila.data.porEspecialidade.slice(0, 6).map((e) => (
                        <Badge key={e.codigo} tone="slate">
                          {e.nome}: {e.total}
                          {e.atrasadas ? ` (${e.atrasadas} atrasada(s))` : ''}
                        </Badge>
                      ))}
                    </div>
                    {fila.data.itens.length === 0 ? (
                      <EmptyState title="Fila vazia" description="Nenhuma solicitação aguardando regulação com estes filtros." icon={<Scale className="h-8 w-8" />} />
                    ) : (
                      <Table>
                        <THead>
                          <TR>
                            <TH>#</TH>
                            <TH>Prioridade</TH>
                            <TH>Protocolo</TH>
                            <TH>Pessoa</TH>
                            <TH>Solicitação</TH>
                            <TH>Unidade</TH>
                            <TH>Na fila</TH>
                            <TH>Situação</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {fila.data.itens.map((s) => (
                            <TR key={s.id} className="cursor-pointer" onClick={() => setDetalhe(s.id)}>
                              <TD className="tabular-nums">{s.posicao}</TD>
                              <TD>
                                <Badge tone={PRIORIDADE_TONE[s.priority]}>{s.priorityLabel}</Badge>
                              </TD>
                              <TD className="font-mono text-xs">{s.protocol}</TD>
                              <TD>
                                {s.patient.name}
                                <span className="block text-xs text-slate-500">{s.patient.age} anos</span>
                              </TD>
                              <TD>
                                {s.procedureName}
                                {s.protocolIssues.length > 0 && <span className="block text-xs text-amber-700">{s.protocolIssues.length} pendência(s) do protocolo</span>}
                              </TD>
                              <TD className="text-xs">
                                {s.unit.name}
                                <span className="block text-slate-500">{s.requester.name}</span>
                              </TD>
                              <TD className={s.atrasada ? 'text-red-700' : ''}>
                                {s.diasEmFila} dia(s)
                                <span className="block text-xs text-slate-500">meta {fmtDate(s.prazoMeta)}</span>
                              </TD>
                              <TD>
                                <Badge tone={STATUS_TONE[s.status]}>{s.statusLabel}</Badge>
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    )}
                  </>
                )}
              </CardBody>
            </Card>
          </TabPanel>
        )}
        <TabPanel value="unidade">
          <Card>
            <CardHeader
              title="Solicitações da unidade"
              description="Tudo o que esta unidade pediu à regulação, com a resposta do regulador. Clique para ver o histórico, complementar ou cancelar."
              actions={
                <div className="flex flex-wrap gap-2">
                  <Select value={filtro.status ?? ''} onChange={(e) => setFiltro((f) => ({ ...f, status: (e.target.value || undefined) as StatusSolicitacao | undefined }))} aria-label="Situação" className="w-56">
                    <option value="">Todas as situações</option>
                    {(Object.keys(STATUS_SOLICITACAO) as StatusSolicitacao[]).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_SOLICITACAO[s]}
                      </option>
                    ))}
                  </Select>
                </div>
              }
            />
            <CardBody className="p-0">
              {unidade.error && (
                <Alert tone="error" className="m-4">
                  {unidade.error}
                </Alert>
              )}
              {unidade.loading && !unidade.data && <Spinner />}
              {unidade.data && unidade.data.length === 0 && (
                <EmptyState title="Nenhuma solicitação" description="As solicitações são feitas a partir do atendimento, na aba Encaminhamentos." icon={<Scale className="h-8 w-8" />} />
              )}
              {unidade.data && unidade.data.length > 0 && (
                <Table>
                  <THead>
                    <TR>
                      <TH>Protocolo</TH>
                      <TH>Pessoa</TH>
                      <TH>Solicitação</TH>
                      <TH>Prioridade</TH>
                      <TH>Situação</TH>
                      <TH>Devolutiva</TH>
                      <TH>Solicitada</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {unidade.data.map((s) => (
                      <TR key={s.id} className="cursor-pointer" onClick={() => setDetalhe(s.id)}>
                        <TD className="font-mono text-xs">{s.protocol}</TD>
                        <TD>{s.patient.name}</TD>
                        <TD>{s.procedureName}</TD>
                        <TD>
                          <Badge tone={PRIORIDADE_TONE[s.priority]}>{s.priorityLabel}</Badge>
                        </TD>
                        <TD>
                          <Badge tone={STATUS_TONE[s.status]}>{s.statusLabel}</Badge>
                          {s.atrasada && <span className="block text-xs text-red-700">prazo-meta vencido</span>}
                        </TD>
                        <TD className="max-w-xs text-xs text-slate-600">
                          {s.decisionReason ?? (s.providerUnit ? `Executante: ${s.providerUnit.name}` : '—')}
                          {s.decisionAt && <span className="block text-slate-400">{fmtDateTime(s.decisionAt)}</span>}
                        </TD>
                        <TD className="whitespace-nowrap text-xs">{fmtDate(s.createdAt)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </TabPanel>
        <TabPanel value="protocolos">
          <div className="grid gap-4 md:grid-cols-2">
            {(protocolos.data?.especialidades ?? []).map((e) => (
              <Card key={e.codigo}>
                <CardHeader title={e.nome} description={`Consulta SIGTAP ${e.sigtapCode} · ${e.fonte}`} />
                <CardBody className="text-sm">
                  <p className="mb-1 font-semibold">Encaminhar quando</p>
                  <ul className="mb-2 list-inside list-disc text-slate-700">
                    {e.criterios.map((c) => (
                      <li key={c.codigo}>
                        {c.descricao} <Badge tone={PRIORIDADE_TONE[c.prioridade]}>{PRIORIDADES[c.prioridade].label}</Badge>
                      </li>
                    ))}
                  </ul>
                  {e.examesMinimos.length > 0 && (
                    <p className="mb-1 text-xs text-slate-600">
                      <span className="font-semibold">Exames mínimos:</span> {e.examesMinimos.map((x) => `${x.nome}${x.obrigatorio ? '' : ' (opcional)'}`).join(', ')}
                    </p>
                  )}
                  <p className="text-xs text-slate-500">
                    <span className="font-semibold">Segue na APS:</span> {e.manejoNaAps.join('; ')}
                  </p>
                </CardBody>
              </Card>
            ))}
            {(protocolos.data?.procedimentos ?? []).map((p) => (
              <Card key={p.codigo}>
                <CardHeader title={p.nome} description={`${p.tipo === 'EXAME' ? 'Exame' : 'Procedimento'} · SIGTAP ${p.sigtapCode} · ${p.fonte}`} />
                <CardBody className="text-sm">
                  <ul className="list-inside list-disc text-slate-700">
                    {p.criterios.map((c) => (
                      <li key={c.codigo}>
                        {c.descricao} <Badge tone={PRIORIDADE_TONE[c.prioridade]}>{PRIORIDADES[c.prioridade].label}</Badge>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ))}
          </div>
        </TabPanel>
      </Tabs>
      <DetailDialog id={detalhe} onClose={() => setDetalhe(null)} onChanged={recarregar} />
    </>
  );
}
