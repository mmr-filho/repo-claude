'use client';

import { PRIORIDADE_LEITO, STATUS_AIH, STATUS_SOLICITACAO_LEITO, TIPO_LEITO, UFS, type PrioridadeRegulacao, type StatusAih, type StatusSolicitacaoLeito, type TipoLeito } from '@omnisaude/shared';
import { BedDouble, FileText, Hospital, Plus, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { AihDetailDialog } from '@/components/bed-regulation/aih-detail-dialog';
import { AihDialog } from '@/components/bed-regulation/aih-dialog';
import { BedRequestDetailDialog } from '@/components/bed-regulation/detail-dialog';
import { BedRequestDialog } from '@/components/bed-regulation/request-dialog';
import { PRIORIDADE_LEITO_TONE, RISCO_NEWS2, STATUS_AIH_TONE, STATUS_LEITO_TONE, type Faixa, type Laudo, type Mapa, type SolicitacaoLeito } from '@/components/bed-regulation/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi, useInterval } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

interface Painel {
  porStatus: Record<StatusSolicitacaoLeito, number>;
  naFila: number;
  ultimos30Dias: { autorizadas: number; negadas: number; internadas: number; horasAteDecisao: number | null; horasAteInternacao: number | null };
}
interface Fila {
  itens: SolicitacaoLeito[];
  total: number;
  porPrioridade: Record<PrioridadeRegulacao, number>;
  atrasadas: number;
}
interface PainelAih {
  porStatus: Record<StatusAih, number>;
  autorizadas30Dias: number;
  numerosDisponiveis: number;
}

/** Central de leitos da rede: mapa de leitos, fila de solicitações, regulação, transferências e AIH. */
export default function CentralLeitosPage() {
  const session = useSession();
  const toast = useToast();
  const regula = session.can('leitos_rede.regular');
  const solicita = session.can('leitos_rede.solicitar');
  const leAih = session.can('aih.ler');
  const autorizaAih = session.can('aih.autorizar');
  const solicitaAih = session.can('aih.solicitar');
  const [tab, setTab] = useState(regula ? 'fila' : 'solicitacoes');
  const [statusF, setStatusF] = useState<StatusSolicitacaoLeito | ''>('');
  const [tipoF, setTipoF] = useState<TipoLeito | ''>('');
  const [statusAih, setStatusAih] = useState<StatusAih | ''>('');
  const [nova, setNova] = useState(false);
  const [complementando, setComplementando] = useState<SolicitacaoLeito | null>(null);
  const [detalhe, setDetalhe] = useState<string | null>(null);
  const [novoLaudo, setNovoLaudo] = useState(false);
  const [corrigindo, setCorrigindo] = useState<Laudo | null>(null);
  const [laudoDet, setLaudoDet] = useState<string | null>(null);
  const [novaFaixa, setNovaFaixa] = useState(false);

  const painel = useApi<Painel>('/regulacao-leitos/painel');
  const mapa = useApi<Mapa>('/regulacao-leitos/mapa');
  const fila = useApi<Fila>(regula ? `/regulacao-leitos/fila${tipoF ? `?bedKind=${tipoF}` : ''}` : null, [tipoF, regula]);
  const lista = useApi<SolicitacaoLeito[]>(`/regulacao-leitos/solicitacoes${statusF ? `?status=${statusF}` : ''}`, [statusF]);
  const laudos = useApi<Laudo[]>(leAih ? `/aih/laudos${statusAih ? `?status=${statusAih}` : ''}` : null, [statusAih, leAih]);
  const painelAih = useApi<PainelAih>(leAih ? '/aih/painel' : null, [leAih]);
  const faixas = useApi<Faixa[]>(autorizaAih ? '/aih/faixas' : null, [autorizaAih]);

  const recarregar = () => {
    void painel.reload();
    void mapa.reload();
    void fila.reload();
    void lista.reload();
  };
  const recarregarAih = () => {
    void laudos.reload();
    void painelAih.reload();
    void faixas.reload();
  };
  useRealtime('leitos_rede.fila', recarregar);
  useRealtime('leitos_rede.atualizado', recarregar);
  useRealtime('censo', () => void mapa.reload());
  useRealtime('aih.atualizada', recarregarAih);
  useInterval(recarregar, 120_000);
  const p = painel.data;

  const Linha = ({ s }: { s: SolicitacaoLeito }) => (
    <TR className="cursor-pointer" onClick={() => setDetalhe(s.id)}>
      <TD className="font-mono text-xs">{s.protocol}</TD>
      <TD>
        <Badge tone={PRIORIDADE_LEITO_TONE[s.priority]}>{s.priorityLabel}</Badge>
        {s.atrasada && (
          <Badge tone="red" className="ml-1">
            atrasada
          </Badge>
        )}
      </TD>
      <TD>
        {s.patient.name}
        <span className="block text-xs text-slate-500">
          {s.patient.age} anos · {s.originUnit.name}
        </span>
      </TD>
      <TD>
        {s.bedKindLabel}
        <span className="block text-xs text-slate-500">
          {s.specialty}
          {s.cid ? ` · ${s.cid}` : ''}
          {s.isolation !== 'NENHUM' ? ` · ${s.isolation.toLowerCase()}` : ''}
        </span>
      </TD>
      <TD className="text-xs">{s.news2 ? <Badge tone={RISCO_NEWS2[s.news2.risco].tone}>NEWS2 {s.news2.pontos}</Badge> : '—'}</TD>
      <TD>
        <Badge tone={STATUS_LEITO_TONE[s.status]}>{s.statusLabel}</Badge>
        {s.destination && <span className="block text-xs text-slate-500">{s.destination.unitName}</span>}
      </TD>
      <TD className="whitespace-nowrap text-xs">
        {s.horasEmFila} h<span className="block text-slate-500">{fmtDateTime(s.createdAt)}</span>
      </TD>
    </TR>
  );
  const cabecalho = (
    <THead>
      <TR>
        <TH>Protocolo</TH>
        <TH>Prioridade</TH>
        <TH>Pessoa / origem</TH>
        <TH>Leito</TH>
        <TH>NEWS2</TH>
        <TH>Situação</TH>
        <TH>Espera</TH>
      </TR>
    </THead>
  );

  return (
    <>
      <PageHeader
        title="Central de leitos"
        description="Mapa de leitos da rede, solicitações de vaga por prioridade, avaliação do regulador, reserva de leito, transferência e AIH."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={recarregar}>
              <RefreshCw className="h-4 w-4" /> Atualizar
            </Button>
            {solicita && (
              <Button onClick={() => setNova(true)} id="leito-nova">
                <Plus className="h-4 w-4" /> Solicitar vaga
              </Button>
            )}
          </div>
        }
      />
      {p && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Na fila" value={p.naFila} tone={p.naFila ? 'warn' : 'default'} hint={fila.data ? `${fila.data.atrasadas} fora do prazo` : undefined} />
          <Stat label="Devolvidas" value={p.porStatus.DEVOLVIDA} />
          <Stat label="Autorizadas / em transferência" value={p.porStatus.AUTORIZADA + p.porStatus.EM_TRANSFERENCIA} tone="good" />
          <Stat label="Internadas (30 dias)" value={p.ultimos30Dias.internadas} />
          <Stat label="Horas até a decisão" value={p.ultimos30Dias.horasAteDecisao ?? '—'} hint="média, 30 dias" />
          <Stat label="Ocupação da rede" value={mapa.data ? `${mapa.data.totais.ocupacao}%` : '—'} hint={mapa.data ? `${mapa.data.totais.vagos} vago(s) · ${mapa.data.totais.reservados} reservado(s)` : undefined} />
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          ...(regula ? [{ value: 'fila', label: `Fila${fila.data ? ` (${fila.data.total})` : ''}` }] : []),
          { value: 'mapa', label: 'Mapa da rede' },
          { value: 'solicitacoes', label: 'Solicitações' },
          ...(leAih ? [{ value: 'aih', label: `AIH${painelAih.data ? ` (${painelAih.data.porStatus.PENDENTE})` : ''}` }] : []),
          ...(autorizaAih ? [{ value: 'faixas', label: 'Faixas de AIH' }] : []),
        ]}
      >
        {regula && (
          <TabPanel value="fila">
            <Card>
              <CardHeader
                title="Fila da central"
                description="Por prioridade (emergência, urgência, prioritária, eletiva) e, dentro dela, por tempo de espera."
                actions={
                  <Select value={tipoF} onChange={(e) => setTipoF(e.target.value as TipoLeito | '')} aria-label="Tipo de leito" className="w-56">
                    <option value="">Todos os tipos de leito</option>
                    {(Object.keys(TIPO_LEITO) as TipoLeito[]).map((k) => (
                      <option key={k} value={k}>
                        {TIPO_LEITO[k]}
                      </option>
                    ))}
                  </Select>
                }
              />
              <CardBody className="p-0">
                {fila.error && (
                  <Alert tone="error" className="m-4">
                    {fila.error}
                  </Alert>
                )}
                {fila.loading && !fila.data && <Spinner />}
                {fila.data && fila.data.itens.length === 0 && <EmptyState title="Fila vazia" description="Nenhuma solicitação aguardando regulação." icon={<BedDouble className="h-8 w-8" />} />}
                {fila.data && fila.data.itens.length > 0 && (
                  <Table>
                    {cabecalho}
                    <TBody>
                      {fila.data.itens.map((s) => (
                        <Linha key={s.id} s={s} />
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardBody>
            </Card>
          </TabPanel>
        )}
        <TabPanel value="mapa">
          {mapa.loading && !mapa.data && <Spinner />}
          {mapa.data && (
            <div className="grid gap-4 md:grid-cols-2">
              {mapa.data.unidades.map((u) => (
                <Card key={u.unit.id}>
                  <CardHeader
                    title={
                      <span className="flex items-center gap-2">
                        <Hospital className="h-4 w-4 text-slate-500" /> {u.unit.name}
                      </span>
                    }
                    description={`${u.totals.total} leitos · ocupação ${u.occupancyRate}% · ${u.totals.VAGO} vago(s)${u.aCaminho ? ` · ${u.aCaminho} a caminho` : ''}`}
                    actions={
                      <Link href={`/leitos?unitId=${u.unit.id}`} className="text-sm text-brand-700 underline">
                        Censo
                      </Link>
                    }
                  />
                  <CardBody className="p-0">
                    <Table>
                      <THead>
                        <TR>
                          <TH>Tipo</TH>
                          <TH>Vagos</TH>
                          <TH>Ocupados</TH>
                          <TH>Reservados</TH>
                          <TH>Higienização</TH>
                          <TH>Bloqueados</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {u.porTipo.map((t) => (
                          <TR key={t.tipo}>
                            <TD>{t.label}</TD>
                            <TD>
                              <Badge tone={t.vagos > 0 ? 'green' : 'red'}>{t.vagos}</Badge>
                            </TD>
                            <TD>{t.ocupados}</TD>
                            <TD>{t.reservados}</TD>
                            <TD>{t.higienizacao}</TD>
                            <TD>{t.bloqueados}</TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </TabPanel>
        <TabPanel value="solicitacoes">
          <Card>
            <CardHeader
              title="Solicitações de vaga"
              description={regula ? 'Toda a rede.' : 'Da sua unidade (origem ou destino).'}
              actions={
                <Select value={statusF} onChange={(e) => setStatusF(e.target.value as StatusSolicitacaoLeito | '')} aria-label="Situação" className="w-56">
                  <option value="">Todas as situações</option>
                  {(Object.keys(STATUS_SOLICITACAO_LEITO) as StatusSolicitacaoLeito[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_SOLICITACAO_LEITO[s]}
                    </option>
                  ))}
                </Select>
              }
            />
            <CardBody className="p-0">
              {lista.error && (
                <Alert tone="error" className="m-4">
                  {lista.error}
                </Alert>
              )}
              {lista.loading && !lista.data && <Spinner />}
              {lista.data && lista.data.length === 0 && <EmptyState title="Nenhuma solicitação" icon={<BedDouble className="h-8 w-8" />} />}
              {lista.data && lista.data.length > 0 && (
                <Table>
                  {cabecalho}
                  <TBody>
                    {lista.data.map((s) => (
                      <Linha key={s.id} s={s} />
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </TabPanel>
        {leAih && (
          <TabPanel value="aih">
            {painelAih.data && (
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Aguardando autorização" value={painelAih.data.porStatus.PENDENTE} tone={painelAih.data.porStatus.PENDENTE ? 'warn' : 'default'} />
                <Stat label="Autorizadas (30 dias)" value={painelAih.data.autorizadas30Dias} tone="good" />
                <Stat label="Negadas" value={painelAih.data.porStatus.NEGADA} />
                <Stat label="Números disponíveis" value={painelAih.data.numerosDisponiveis} hint="nas faixas ativas" />
              </div>
            )}
            <Card>
              <CardHeader
                title="Laudos de AIH"
                description="Laudo médico para solicitação / autorização de internação hospitalar; o número autorizado vai para o espelho de faturamento."
                actions={
                  <div className="flex gap-2">
                    <Select value={statusAih} onChange={(e) => setStatusAih(e.target.value as StatusAih | '')} aria-label="Situação do laudo" className="w-52">
                      <option value="">Todas as situações</option>
                      {(Object.keys(STATUS_AIH) as StatusAih[]).map((s) => (
                        <option key={s} value={s}>
                          {STATUS_AIH[s]}
                        </option>
                      ))}
                    </Select>
                    {solicitaAih && (
                      <Button onClick={() => setNovoLaudo(true)} id="aih-novo">
                        <Plus className="h-4 w-4" /> Laudo
                      </Button>
                    )}
                  </div>
                }
              />
              <CardBody className="p-0">
                {laudos.loading && !laudos.data && <Spinner />}
                {laudos.data && laudos.data.length === 0 && <EmptyState title="Nenhum laudo" icon={<FileText className="h-8 w-8" />} />}
                {laudos.data && laudos.data.length > 0 && (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Pessoa</TH>
                        <TH>Procedimento</TH>
                        <TH>CID</TH>
                        <TH>Caráter</TH>
                        <TH>Situação</TH>
                        <TH>Nº AIH</TH>
                        <TH>Emitido</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {laudos.data.map((l) => (
                        <TR key={l.id} className="cursor-pointer" onClick={() => setLaudoDet(l.id)}>
                          <TD>
                            {l.patient.name}
                            <span className="block text-xs text-slate-500">{l.unit.name}</span>
                          </TD>
                          <TD>
                            {l.procedureName}
                            <span className="block font-mono text-xs text-slate-500">{l.procedureCode}</span>
                          </TD>
                          <TD>{l.mainCid}</TD>
                          <TD className="text-xs">{l.natureLabel}</TD>
                          <TD>
                            <Badge tone={STATUS_AIH_TONE[l.status]}>{l.statusLabel}</Badge>
                            {l.vencida && (
                              <Badge tone="red" className="ml-1">
                                vencida
                              </Badge>
                            )}
                          </TD>
                          <TD className="font-mono text-xs">{l.aihNumber ?? '—'}</TD>
                          <TD className="whitespace-nowrap text-xs">{fmtDate(l.createdAt)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardBody>
            </Card>
          </TabPanel>
        )}
        {autorizaAih && (
          <TabPanel value="faixas">
            <Card>
              <CardHeader
                title="Faixas numéricas de AIH"
                description="Faixas distribuídas pelo gestor (UF + ano + tipo + sequencial). O número é montado com dígito verificador."
                actions={
                  <Button onClick={() => setNovaFaixa(true)} id="faixa-nova">
                    <Plus className="h-4 w-4" /> Faixa
                  </Button>
                }
              />
              <CardBody className="p-0">
                {faixas.loading && !faixas.data && <Spinner />}
                {faixas.data && (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Faixa</TH>
                        <TH>Unidade</TH>
                        <TH>UF / ano / tipo</TH>
                        <TH>Sequencial</TH>
                        <TH>Próximo número</TH>
                        <TH>Usados</TH>
                        <TH>Restantes</TH>
                        <TH></TH>
                      </TR>
                    </THead>
                    <TBody>
                      {faixas.data.map((f) => (
                        <TR key={f.id} className={f.active ? undefined : 'opacity-50'}>
                          <TD>{f.name}</TD>
                          <TD className="text-xs">{f.unitName ?? 'Todas'}</TD>
                          <TD className="text-xs">
                            {f.uf} · {f.year} · {f.tipoLabel}
                          </TD>
                          <TD className="text-xs">
                            {f.seqStart} – {f.seqEnd}
                          </TD>
                          <TD className="font-mono text-xs">{f.restantes > 0 ? f.exemplo : '—'}</TD>
                          <TD>{f.usados}</TD>
                          <TD>{f.restantes}</TD>
                          <TD>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                try {
                                  await api.patch(`/aih/faixas/${f.id}`, { active: !f.active });
                                  recarregarAih();
                                } catch (err) {
                                  toast.error(errorMessage(err));
                                }
                              }}
                            >
                              {f.active ? 'Desativar' : 'Ativar'}
                            </Button>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardBody>
            </Card>
          </TabPanel>
        )}
      </Tabs>

      <BedRequestDialog
        aberto={nova || !!complementando}
        onClose={() => {
          setNova(false);
          setComplementando(null);
        }}
        existente={complementando}
        onSalvo={(s) => {
          recarregar();
          setDetalhe(s.id);
        }}
      />
      <BedRequestDetailDialog
        id={detalhe}
        onClose={() => setDetalhe(null)}
        onChanged={recarregar}
        onComplementar={(s) => {
          setDetalhe(null);
          setComplementando(s);
        }}
      />
      <AihDialog
        aberto={novoLaudo || !!corrigindo}
        onClose={() => {
          setNovoLaudo(false);
          setCorrigindo(null);
        }}
        existente={corrigindo}
        onSalvo={(l) => {
          recarregarAih();
          setLaudoDet(l.id);
        }}
      />
      <AihDetailDialog
        id={laudoDet}
        onClose={() => setLaudoDet(null)}
        onChanged={recarregarAih}
        onCorrigir={(l) => {
          setLaudoDet(null);
          setCorrigindo(l);
        }}
      />
      {novaFaixa && <FaixaDialog onClose={() => setNovaFaixa(false)} onSalvo={recarregarAih} unidades={mapa.data?.unidades.map((u) => u.unit) ?? []} />}
    </>
  );
}

function FaixaDialog({ onClose, onSalvo, unidades }: { onClose: () => void; onSalvo: () => void; unidades: { id: string; name: string }[] }) {
  const [f, setF] = useState({ name: '', unitId: '', uf: 'TO', year: String(new Date().getFullYear()), aihType: '1' as '1' | '5', seqStart: '', seqEnd: '' });
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function salvar() {
    setErro(null);
    setBusy(true);
    try {
      await api.post('/aih/faixas', { name: f.name, unitId: f.unitId || null, uf: f.uf, year: Number(f.year), aihType: f.aihType, seqStart: Number(f.seqStart), seqEnd: Number(f.seqEnd) });
      onSalvo();
      onClose();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Nova faixa numérica de AIH"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={busy} id="faixa-salvar" disabled={f.name.trim().length < 3 || !f.seqStart || !f.seqEnd}>
            Salvar
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {erro && <Alert tone="error">{erro}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Nome" htmlFor="fx-nome" className="sm:col-span-2">
            <Input id="fx-nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Faixa 2026 · Hospital Municipal" />
          </Field>
          <Field label="Unidade" htmlFor="fx-unidade">
            <Select id="fx-unidade" value={f.unitId} onChange={(e) => setF({ ...f, unitId: e.target.value })}>
              <option value="">Todas</option>
              {unidades.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="UF" htmlFor="fx-uf">
            <Select id="fx-uf" value={f.uf} onChange={(e) => setF({ ...f, uf: e.target.value })}>
              {UFS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ano" htmlFor="fx-ano">
            <Input id="fx-ano" inputMode="numeric" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} />
          </Field>
          <Field label="Tipo" htmlFor="fx-tipo">
            <Select id="fx-tipo" value={f.aihType} onChange={(e) => setF({ ...f, aihType: e.target.value as '1' | '5' })}>
              <option value="1">1 · principal</option>
              <option value="5">5 · longa permanência</option>
            </Select>
          </Field>
          <Field label="Sequencial inicial" htmlFor="fx-ini">
            <Input id="fx-ini" inputMode="numeric" value={f.seqStart} onChange={(e) => setF({ ...f, seqStart: e.target.value })} />
          </Field>
          <Field label="Sequencial final" htmlFor="fx-fim">
            <Input id="fx-fim" inputMode="numeric" value={f.seqEnd} onChange={(e) => setF({ ...f, seqEnd: e.target.value })} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
