'use client';

import { SITUACAO_INFO, SITUACOES_VISITA, type ProgressoBloqueio, type SituacaoVisita } from '@omnisaude/shared';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { BarraProgresso } from './aba-ordens';
import { avisoLimitePendencias, depositoSugerido, fmtQuantidade, lotesParaResolver, opcoesQuarteiraoZona, opcoesTitular, rotuloQuarteiroesZona, textoTentativas, valorEntre } from './gestao-regras';
import type { AgenteEndemias, BaixaPendente, PainelEstoque } from './types';

// ─── Zonas ──────────────────────────────────────────────────────────────────

interface Zona {
  id: string;
  nome: string;
  ativa: boolean;
  observacao: string | null;
  agente: { id: string; nome: string | null } | null;
  quarteiroes: { id: string; numero: string; ativo: boolean }[];
  progressoCiclo: ProgressoBloqueio;
}
interface QuarteiraoLivre {
  id: string;
  numero: string;
  localidade: string | null;
  bairro: string | null;
  imoveis: number;
}

/** Zonas de trabalho dos ACE: o conjunto de quarteirões que cada agente percorre a cada ciclo. */
export function AbaZonas({ podeGerir }: { podeGerir: boolean }) {
  const zonas = useApi<{ ciclo: { ciclo: number; ano: number }; zonas: Zona[] }>('/endemias/zonas');
  // Para a supervisão, marca o titular que perdeu a lotação de campo (a zona fica sem quem a percorra).
  const agentes = useApi<AgenteEndemias[]>(podeGerir ? '/endemias/agentes' : null);
  const [editando, setEditando] = useState<Zona | 'nova' | null>(null);
  return (
    <Card>
      <CardHeader
        title="Zonas dos agentes"
        description={zonas.data ? `Progresso no ciclo ${zonas.data.ciclo.ciclo}/${zonas.data.ciclo.ano} (bimestral). O PNCD sugere de 800 a 1.000 imóveis por agente.` : undefined}
        actions={podeGerir ? <Button onClick={() => setEditando('nova')}>Nova zona</Button> : undefined}
      />
      <CardBody className="p-0">
        {zonas.loading && !zonas.data && <Spinner className="p-4" />}
        {zonas.error && <Alert tone="error">{zonas.error}</Alert>}
        {zonas.data && !zonas.data.zonas.length && <EmptyState title="Nenhuma zona" description="Monte as zonas com os quarteirões do território e designe o agente titular." />}
        {!!zonas.data?.zonas.length && (
          <Table>
            <THead>
              <tr>
                <TH>Zona</TH>
                <TH>Agente</TH>
                <TH>Quarteirões</TH>
                <TH>Imóveis no ciclo</TH>
                <TH />
              </tr>
            </THead>
            <TBody>
              {zonas.data.zonas.map((z) => (
                <TR key={z.id}>
                  <TD className="font-medium">
                    {z.nome} {!z.ativa && <Badge>inativa</Badge>}
                  </TD>
                  <TD>
                    {z.agente ? (
                      <>
                        {z.agente.nome}
                        {agentes.data && !agentes.data.some((a) => a.id === z.agente?.id) && <div className="text-xs text-amber-700">sem lotação ativa</div>}
                      </>
                    ) : (
                      <span className="text-amber-700">descoberta</span>
                    )}
                  </TD>
                  <TD className="max-w-xs text-sm">{rotuloQuarteiroesZona(z.quarteiroes)}</TD>
                  <TD>
                    <BarraProgresso p={z.progressoCiclo} />
                  </TD>
                  <TD>
                    {podeGerir && (
                      <Button size="sm" variant="secondary" onClick={() => setEditando(z)}>
                        Editar
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardBody>
      {editando && <ZonaDialog zona={editando === 'nova' ? null : editando} onClose={() => setEditando(null)} onSalvo={() => void zonas.reload()} />}
    </Card>
  );
}

function ZonaDialog({ zona, onClose, onSalvo }: { zona: Zona | null; onClose: () => void; onSalvo: () => void }) {
  const toast = useToast();
  const livres = useApi<QuarteiraoLivre[]>('/endemias/zonas/quarteiroes-livres');
  const agentes = useApi<AgenteEndemias[]>('/endemias/agentes');
  const [nome, setNome] = useState(zona?.nome ?? '');
  const [aceId, setAceId] = useState(zona?.agente?.id ?? '');
  const [ativa, setAtiva] = useState(zona?.ativa ?? true);
  const [obs, setObs] = useState(zona?.observacao ?? '');
  const [escolhidos, setEscolhidos] = useState<Set<string>>(new Set(zona?.quarteiroes.map((q) => q.id) ?? []));
  const [filtro, setFiltro] = useState('');
  const [salvando, setSalvando] = useState(false);
  // O titular atual fora da lista (sem lotação ativa) aparece como opção própria: o campo mostra o que vai ser enviado.
  const titulares = useMemo(() => opcoesTitular(agentes.data, zona?.agente ?? null), [agentes.data, zona]);
  const titularSemLotacao = titulares.some((t) => t.id === aceId && t.semLotacao);
  // O desativado na malha que continua na zona vem marcado: fica até a supervisão tirá-lo.
  const opcoes = useMemo(() => opcoesQuarteiraoZona(zona?.quarteiroes ?? [], livres.data ?? [], filtro), [zona, livres.data, filtro]);
  const salvar = async () => {
    setSalvando(true);
    try {
      const body = { nome: nome.trim(), aceId: aceId || null, quarteiroes: [...escolhidos], ativa, observacao: obs.trim() || null };
      if (zona) await api.put(`/endemias/zonas/${zona.id}`, body);
      else await api.post('/endemias/zonas', body);
      toast.success('Zona salva');
      onSalvo();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSalvando(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={zona ? `Zona ${zona.nome}` : 'Nova zona'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={salvando} disabled={!nome.trim()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome" htmlFor="zona-nome">
            <Input id="zona-nome" value={nome} onChange={(e) => setNome(e.target.value)} maxLength={60} placeholder="Ex.: Zona 03" />
          </Field>
          <Field label="Agente titular" htmlFor="zona-ace">
            <Select id="zona-ace" value={aceId} onChange={(e) => setAceId(e.target.value)}>
              <option value="">Descoberta (sem titular)</option>
              {titulares.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.rotulo}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {titularSemLotacao && <Alert tone="warn">O titular desta zona está sem lotação ativa de campo: escolha outro agente ou deixe a zona descoberta.</Alert>}
        {zona && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={ativa} onChange={(e) => setAtiva(e.target.checked)} /> Zona ativa
          </label>
        )}
        <Field label={`Quarteirões (${escolhidos.size} escolhidos)`} htmlFor="zona-filtro" hint="Só aparecem os quarteirões sem zona e os desta zona">
          <Input id="zona-filtro" placeholder="Filtrar por número, localidade ou bairro" value={filtro} onChange={(e) => setFiltro(e.target.value)} />
        </Field>
        {livres.loading && <Spinner />}
        <div className="grid max-h-64 grid-cols-2 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-4">
          {opcoes.map((q) => (
            <label key={q.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={escolhidos.has(q.id)}
                onChange={(e) =>
                  setEscolhidos((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(q.id);
                    else n.delete(q.id);
                    return n;
                  })
                }
              />
              {q.rotulo}
              {q.localidade && <span className="truncate text-xs text-slate-500">{q.localidade}</span>}
            </label>
          ))}
          {!opcoes.length && !livres.loading && <p className="col-span-full text-sm text-slate-500">Nenhum quarteirão livre. Importe a malha em Território.</p>}
        </div>
        <Field label="Observação" htmlFor="zona-obs">
          <Textarea id="zona-obs" rows={2} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

// ─── Visitas ────────────────────────────────────────────────────────────────

interface VisitaLinha {
  id: string;
  visitadaEm: string;
  agente: string | null;
  imovel: string | null;
  sequencia: string | null;
  quarteirao: string | null;
  tipo: string;
  atividadeLabel: string;
  situacao: SituacaoVisita;
  situacaoLabel: string;
  recuperacao: boolean;
  ordem: string | null;
  inspecionados: number;
  comFoco: number;
  eliminados: number;
  tratados: number;
  amostras: number;
  ubv: string | null;
  observacao: string | null;
  tratamentos: { produto: string; unidade: string; lote: string | null; quantidade: number; depositos: number; estoque: string; vencido: boolean }[];
}

export function AbaVisitas() {
  const [de, setDe] = useState(todayIso(-7));
  const [ate, setAte] = useState(todayIso());
  const [situacao, setSituacao] = useState('');
  const q = new URLSearchParams({ de, ate, ...(situacao ? { situacao } : {}) }).toString();
  const visitas = useApi<VisitaLinha[]>(`/endemias/visitas?${q}`, [q]);
  return (
    <Card>
      <CardHeader
        title="Visitas registradas"
        description="Boletim de campo dos agentes (até 500 por consulta)"
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Input type="date" aria-label="De" value={de} onChange={(e) => setDe(e.target.value)} />
            <Input type="date" aria-label="Até" value={ate} onChange={(e) => setAte(e.target.value)} />
            <Select aria-label="Situação" value={situacao} onChange={(e) => setSituacao(e.target.value)}>
              <option value="">Todas</option>
              {SITUACOES_VISITA.map((s) => (
                <option key={s} value={s}>
                  {SITUACAO_INFO[s].label}
                </option>
              ))}
            </Select>
          </div>
        }
      />
      <CardBody className="p-0">
        {visitas.loading && !visitas.data && <Spinner className="p-4" />}
        {visitas.error && <Alert tone="error">{visitas.error}</Alert>}
        {visitas.data && !visitas.data.length && <EmptyState title="Nenhuma visita no período" />}
        {!!visitas.data?.length && (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <tr>
                  <TH>Quando</TH>
                  <TH>Agente</TH>
                  <TH>Imóvel</TH>
                  <TH>Atividade</TH>
                  <TH>Situação</TH>
                  <TH>Depósitos</TH>
                  <TH>Larvicida</TH>
                </tr>
              </THead>
              <TBody>
                {visitas.data.map((v) => (
                  <TR key={v.id}>
                    <TD className="whitespace-nowrap">{fmtDateTime(v.visitadaEm)}</TD>
                    <TD>{v.agente}</TD>
                    <TD>
                      <div>{v.imovel}</div>
                      <div className="text-xs text-slate-500">
                        {v.quarteirao ? `Q ${v.quarteirao}` : 'sem quarteirão'}
                        {v.sequencia ? ` · seq. ${v.sequencia}` : ''} · {v.tipo}
                      </div>
                    </TD>
                    <TD>
                      {v.atividadeLabel}
                      {v.ordem && <div className="text-xs text-slate-500">ordem {v.ordem}</div>}
                    </TD>
                    <TD>
                      <Badge tone={SITUACAO_INFO[v.situacao].pendencia ? 'amber' : 'green'}>{v.situacaoLabel}</Badge>
                      {v.recuperacao && <div className="text-xs text-slate-500">recuperação</div>}
                      {v.observacao && <div className="max-w-[12rem] text-xs text-slate-500">{v.observacao}</div>}
                    </TD>
                    <TD className="text-sm">
                      {v.inspecionados ? (
                        <>
                          {v.inspecionados} insp. · {v.comFoco} com foco · {v.eliminados} elim. · {v.tratados} trat.
                          {v.amostras ? <div className="text-xs text-slate-500">{v.amostras} tubito(s)</div> : null}
                          {v.ubv ? <div className="text-xs text-slate-500">UBV {v.ubv.toLowerCase().replace('_', ' e ')}</div> : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD className="text-sm">
                      {v.tratamentos.map((t, i) => (
                        <div key={i}>
                          {t.quantidade.toLocaleString('pt-BR')} {t.unidade} · lote {t.lote ?? '?'}{' '}
                          {t.estoque === 'PENDENTE' ? <Badge tone="amber">baixa pendente</Badge> : t.estoque === 'CANCELADO' ? <Badge>cancelada</Badge> : null}
                          {t.vencido && <Badge tone="red">lote vencido</Badge>}
                        </div>
                      ))}
                      {!v.tratamentos.length && '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ─── Pendências ────────────────────────────────────────────────────────────

interface PendenciaImovel {
  imovelId: string;
  imovel: string | null;
  sequencia: string | null;
  tipo: string;
  quarteirao: string | null;
  situacao: SituacaoVisita;
  situacaoLabel: string;
  ultimaEm: string;
  agente: string | null;
  /** Visitas não trabalhadas desde a última trabalhada; delas, as com o imóvel fechado e as recusas. */
  tentativas: number;
  fechados: number;
  recusas: number;
  naOrdem: boolean;
  /** Duas visitas com o imóvel fechado em dias e turnos alternados em até 10 dias (Lei 13.301/2016, art. 1º, § 2º, II). */
  ausenciaDocumentada: boolean;
}

/** Imóveis pendentes (fechado, recusado, abandonado) e baixas de larvicida que ficaram para a supervisão. */
export function AbaPendencias() {
  const imoveis = useApi<PendenciaImovel[]>('/endemias/pendencias');
  const baixas = useApi<BaixaPendente[]>('/endemias/estoque/pendentes');
  const [resolvendo, setResolvendo] = useState<BaixaPendente | null>(null);
  const limite = imoveis.data ? avisoLimitePendencias(imoveis.data.length) : null;
  const comRecusa = imoveis.data?.filter((p) => p.recusas > 0).length ?? 0;
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader
          title="Imóveis pendentes"
          description={`Última visita no ciclo atual ou numa ordem ativa foi fechado, recusado ou abandonado. Volte em outro dia e turno (fim de semana inclusive).${comRecusa ? ` ${comRecusa} imóvel(is) com recusa.` : ''}`}
        />
        <CardBody className="p-0">
          {imoveis.loading && !imoveis.data && <Spinner className="p-4" />}
          {imoveis.error && <Alert tone="error">{imoveis.error}</Alert>}
          {imoveis.data && !imoveis.data.length && <EmptyState title="Nenhum imóvel pendente" />}
          {limite && (
            <Alert tone="warn" className="m-3">
              {limite}
            </Alert>
          )}
          {!!imoveis.data?.length && (
            <Table>
              <THead>
                <tr>
                  <TH>Imóvel</TH>
                  <TH>Situação</TH>
                  <TH>Tentativas</TH>
                  <TH>Última</TH>
                  <TH>Agente</TH>
                </tr>
              </THead>
              <TBody>
                {imoveis.data.map((p) => (
                  <TR key={p.imovelId}>
                    <TD>
                      <div>{p.imovel}</div>
                      <div className="text-xs text-slate-500">
                        {p.quarteirao ? `Q ${p.quarteirao}` : '—'}
                        {p.sequencia ? ` · seq. ${p.sequencia}` : ''} · {p.tipo}
                        {p.naOrdem ? ' · bloqueio' : ''}
                      </div>
                    </TD>
                    <TD>
                      <Badge tone="amber">{p.situacaoLabel}</Badge>
                    </TD>
                    <TD>
                      {p.tentativas}
                      <div className="text-xs text-slate-500">{textoTentativas(p)}</div>
                      {p.ausenciaDocumentada && (
                        <div className="max-w-[16rem] text-xs text-slate-600">Ausência: 2 visitas com o imóvel fechado em dias e turnos diferentes em até 10 dias (confira se foram comunicadas ao morador)</div>
                      )}
                    </TD>
                    <TD>{fmtDateTime(p.ultimaEm)}</TD>
                    <TD>{p.agente}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="px-4 py-2 text-xs text-slate-500">
            A ausência da Lei 13.301/2016 (art. 1º, § 2º, II) conta só o imóvel fechado, em duas visitas comunicadas; a recusa (§ 2º, III) e o abandono (§ 2º, I) são outras hipóteses. Imóvel recusado ou abandonado segue
            o rito do código de posturas do município (notificação e intimação do responsável). O ingresso forçado só vale com emergência em saúde pública declarada.
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Baixas de larvicida pendentes" description="A visita foi gravada, mas o estoque não baixou (sem saldo no lote, lote desconhecido ou sem depósito)." />
        <CardBody className="p-0">
          {baixas.loading && !baixas.data && <Spinner className="p-4" />}
          {baixas.error && <Alert tone="error">{baixas.error}</Alert>}
          {baixas.data && !baixas.data.length && <EmptyState title="Nenhuma baixa pendente" />}
          {!!baixas.data?.length && (
            <Table>
              <THead>
                <tr>
                  <TH>Visita</TH>
                  <TH>Produto</TH>
                  <TH>Lote e quantidade</TH>
                  <TH>Unidade e depósito</TH>
                  <TH>Motivo</TH>
                  <TH />
                </tr>
              </THead>
              <TBody>
                {baixas.data.map((b) => (
                  <TR key={b.id}>
                    <TD>
                      <div>{fmtDateTime(b.visitadoEm)}</div>
                      <div className="text-xs text-slate-500">
                        {b.agente} · {b.imovel}
                      </div>
                    </TD>
                    <TD>{b.produto}</TD>
                    <TD>
                      {b.lote ?? '—'} · {fmtQuantidade(b.quantidade)} {b.unidade}
                    </TD>
                    <TD className="text-sm">
                      <div>{b.unidadeVisita ?? '—'}</div>
                      <div className="text-xs text-slate-500">{b.deposito ?? 'sem depósito de endemias'}</div>
                    </TD>
                    <TD>{b.motivoLabel}</TD>
                    <TD>
                      <Button size="sm" onClick={() => setResolvendo(b)}>
                        Resolver
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
      {resolvendo && (
        <ResolverBaixa
          baixa={resolvendo}
          onClose={() => setResolvendo(null)}
          onFeito={() => {
            void baixas.reload();
            setResolvendo(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Resolver a baixa pendente: a supervisão vê a unidade da visita e escolhe o depósito de endemias de onde saiu o
 * larvicida (obrigatório quando a unidade da visita não tem depósito) e o lote desse depósito.
 */
function ResolverBaixa({ baixa, onClose, onFeito }: { baixa: BaixaPendente; onClose: () => void; onFeito: () => void }) {
  const toast = useToast();
  const estoque = useApi<PainelEstoque>('/endemias/estoque');
  const [acao, setAcao] = useState<'BAIXAR' | 'REGULARIZAR' | 'CANCELAR'>('BAIXAR');
  // null enquanto a supervisão não escolhe: vale o sugerido (o depósito da baixa, senão o da unidade da visita; o lote da visita).
  const [depositoEscolhido, setDeposito] = useState<string | null>(null);
  const [loteEscolhido, setLote] = useState<string | null>(null);
  const [nota, setNota] = useState('');
  const [enviando, setEnviando] = useState(false);
  const depositos = estoque.data?.depositos ?? [];
  const depositoId = valorEntre(depositoEscolhido ?? depositoSugerido(baixa, depositos), depositos);
  const lotesDoProduto = estoque.data?.produtos.find((p) => p.id === baixa.produtoId)?.lotes ?? [];
  const opcoesLote = acao === 'CANCELAR' ? [] : lotesParaResolver({ acao, lotes: lotesDoProduto, depositoId, baixa });
  const loteId = valorEntre(loteEscolhido ?? baixa.loteId ?? '', opcoesLote);
  const enviar = async () => {
    setEnviando(true);
    try {
      const cancelar = acao === 'CANCELAR';
      await api.post(`/endemias/estoque/pendentes/${baixa.id}/resolver`, { acao, loteId: cancelar ? null : loteId || null, depositoId: cancelar ? null : depositoId || null, nota: nota.trim() });
      toast.success(cancelar ? 'Baixa cancelada' : acao === 'REGULARIZAR' ? 'Estoque regularizado e baixado' : 'Baixa feita');
      onFeito();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title="Resolver baixa de larvicida"
      description={`${baixa.produto} · ${fmtQuantidade(baixa.quantidade)} ${baixa.unidade}${baixa.lote ? ` · lote ${baixa.lote}` : ''} · ${baixa.motivoLabel ?? ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button onClick={enviar} loading={enviando} disabled={nota.trim().length < 5 || (acao !== 'CANCELAR' && (!depositoId || !loteId))}>
            Confirmar
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <div>
            <span className="text-slate-500">Visita:</span> {fmtDateTime(baixa.visitadoEm)} · {baixa.agente ?? '—'} · {baixa.imovel ?? '—'}
          </div>
          <div>
            <span className="text-slate-500">Unidade da visita:</span> {baixa.unidadeVisita ?? '—'} · <span className="text-slate-500">depósito da baixa:</span> {baixa.deposito ?? 'nenhum'}
          </div>
        </div>
        {!baixa.depositoId && acao !== 'CANCELAR' && <Alert tone="info">A unidade da visita não tinha depósito de endemias: escolha o depósito de onde saiu o larvicida.</Alert>}
        {estoque.error && <Alert tone="error">{estoque.error}</Alert>}
        <Field label="O que fazer" htmlFor="baixa-acao">
          <Select id="baixa-acao" value={acao} onChange={(e) => setAcao(e.target.value as typeof acao)}>
            <option value="BAIXAR">Baixar no lote (escolha o depósito e o lote com saldo)</option>
            <option value="REGULARIZAR">Regularizar: o estoque físico tinha o produto (ajuste e baixa)</option>
            <option value="CANCELAR">Cancelar: registro errado, sem efeito no estoque</option>
          </Select>
        </Field>
        {acao !== 'CANCELAR' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Depósito de endemias" htmlFor="baixa-deposito">
              <Select id="baixa-deposito" value={depositoId} onChange={(e) => setDeposito(e.target.value)}>
                <option value="">Escolha</option>
                {depositos.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.nome} · {d.unidade}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Lote" htmlFor="baixa-lote" hint={depositoId && !opcoesLote.length ? 'Nenhum lote do produto com saldo neste depósito. Se o estoque físico tinha o produto, use Regularizar.' : undefined}>
              <Select id="baixa-lote" value={loteId} onChange={(e) => setLote(e.target.value)} disabled={!depositoId}>
                <option value="">{depositoId ? 'Escolha' : 'Escolha antes o depósito'}</option>
                {opcoesLote.map((l) => (
                  <option key={l.id} value={l.id} disabled={l.desabilitado}>
                    {l.rotulo}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {estoque.loading && !estoque.data && <Spinner />}
        {acao === 'REGULARIZAR' && <Alert tone="warn">Faz um ajuste de entrada só da diferença no depósito escolhido e baixa o tratamento. Programe a contagem do lote no depósito.</Alert>}
        <Field label="Nota (mínimo de 5 caracteres)" htmlFor="baixa-nota">
          <Textarea id="baixa-nota" rows={2} value={nota} onChange={(e) => setNota(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
