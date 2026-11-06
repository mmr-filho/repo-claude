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
import type { AgenteEndemias } from './types';

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
                  <TD>{z.agente?.nome ?? <span className="text-amber-700">descoberta</span>}</TD>
                  <TD className="max-w-xs text-sm">
                    {z.quarteiroes.length
                      ? z.quarteiroes
                          .map((q) => q.numero)
                          .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
                          .join(', ')
                      : '—'}
                  </TD>
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
  const opcoes = useMemo(() => {
    const atuais: QuarteiraoLivre[] = (zona?.quarteiroes ?? []).map((q) => ({ id: q.id, numero: q.numero, localidade: null, bairro: null, imoveis: 0 }));
    return [...atuais, ...(livres.data ?? [])].filter((q) => !filtro.trim() || `${q.numero} ${q.localidade ?? ''} ${q.bairro ?? ''}`.toLowerCase().includes(filtro.trim().toLowerCase()));
  }, [zona, livres.data, filtro]);
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
              {agentes.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nome}
                </option>
              ))}
            </Select>
          </Field>
        </div>
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
              Q {q.numero}
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
  tentativas: number;
  naOrdem: boolean;
  ausenciaDocumentada: boolean;
}
interface BaixaPendente {
  id: string;
  visitadoEm: string;
  agente: string | null;
  imovel: string | null;
  produtoId: string;
  produto: string;
  unidade: string;
  loteId: string | null;
  lote: string | null;
  quantidade: number;
  motivo: string | null;
  motivoLabel: string | null;
}

/** Imóveis pendentes (fechado, recusado, abandonado) e baixas de larvicida que ficaram para a supervisão. */
export function AbaPendencias() {
  const imoveis = useApi<PendenciaImovel[]>('/endemias/pendencias');
  const baixas = useApi<BaixaPendente[]>('/endemias/estoque/pendentes');
  const [resolvendo, setResolvendo] = useState<BaixaPendente | null>(null);
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader title="Imóveis pendentes" description="Última visita no ciclo atual ou numa ordem ativa foi fechado, recusado ou abandonado. Volte em outro dia e turno (fim de semana inclusive)." />
        <CardBody className="p-0">
          {imoveis.loading && !imoveis.data && <Spinner className="p-4" />}
          {imoveis.error && <Alert tone="error">{imoveis.error}</Alert>}
          {imoveis.data && !imoveis.data.length && <EmptyState title="Nenhum imóvel pendente" />}
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
                      {p.ausenciaDocumentada && <div className="text-xs text-slate-600">2 tentativas em dias e turnos diferentes em 10 dias</div>}
                    </TD>
                    <TD>{fmtDateTime(p.ultimaEm)}</TD>
                    <TD>{p.agente}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="px-4 py-2 text-xs text-slate-500">
            Imóvel recusado ou abandonado segue o rito do código de posturas do município (notificação e intimação do responsável). O ingresso forçado da Lei 13.301/2016 só vale com emergência em saúde pública declarada.
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
                      {b.lote ?? '—'} · {b.quantidade.toLocaleString('pt-BR')} {b.unidade}
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

function ResolverBaixa({ baixa, onClose, onFeito }: { baixa: BaixaPendente; onClose: () => void; onFeito: () => void }) {
  const toast = useToast();
  const estoque = useApi<{ produtos: { id: string; lotes: { loteId: string; lote: string; saldo: number; validade: string; deposito: string }[] }[] }>('/endemias/estoque');
  const [acao, setAcao] = useState<'BAIXAR' | 'REGULARIZAR' | 'CANCELAR'>('BAIXAR');
  const [loteId, setLoteId] = useState(baixa.loteId ?? '');
  const [nota, setNota] = useState('');
  const [enviando, setEnviando] = useState(false);
  const lotes = estoque.data?.produtos.find((p) => p.id === baixa.produtoId)?.lotes ?? [];
  const enviar = async () => {
    setEnviando(true);
    try {
      await api.post(`/endemias/estoque/pendentes/${baixa.id}/resolver`, { acao, loteId: acao === 'CANCELAR' ? null : loteId || null, nota: nota.trim() });
      toast.success(acao === 'CANCELAR' ? 'Baixa cancelada' : acao === 'REGULARIZAR' ? 'Estoque regularizado e baixado' : 'Baixa feita');
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
      description={`${baixa.produto} · ${baixa.quantidade} ${baixa.unidade} · ${baixa.motivoLabel ?? ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button onClick={enviar} loading={enviando} disabled={nota.trim().length < 5 || (acao !== 'CANCELAR' && !loteId)}>
            Confirmar
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="O que fazer" htmlFor="baixa-acao">
          <Select id="baixa-acao" value={acao} onChange={(e) => setAcao(e.target.value as typeof acao)}>
            <option value="BAIXAR">Baixar no lote (escolha o lote com saldo)</option>
            <option value="REGULARIZAR">Regularizar: o estoque físico tinha o produto (ajuste e baixa)</option>
            <option value="CANCELAR">Cancelar: registro errado, sem efeito no estoque</option>
          </Select>
        </Field>
        {acao !== 'CANCELAR' && (
          <Field label="Lote" htmlFor="baixa-lote">
            <Select id="baixa-lote" value={loteId} onChange={(e) => setLoteId(e.target.value)}>
              <option value="">Escolha</option>
              {lotes.map((l) => (
                <option key={l.loteId} value={l.loteId}>
                  {l.lote} · saldo {l.saldo} · {l.deposito}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {acao === 'REGULARIZAR' && <Alert tone="warn">Faz um ajuste de entrada só da diferença e baixa o tratamento. Programe a contagem do lote no depósito.</Alert>}
        <Field label="Nota (mínimo de 5 caracteres)" htmlFor="baixa-nota">
          <Textarea id="baixa-nota" rows={2} value={nota} onChange={(e) => setNota(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
