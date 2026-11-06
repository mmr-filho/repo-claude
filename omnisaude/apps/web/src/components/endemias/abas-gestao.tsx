'use client';

import { TIPOS_DEPOSITO, type IndicesLarvarios } from '@omnisaude/shared';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, Stat } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { GRUPO_LABEL } from './types';

const qtd = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('pt-BR');

// ─── Estoque de larvicidas ──────────────────────────────────────────────────

interface PainelEstoque {
  depositos: { id: string; nome: string; unidade: string }[];
  produtos: {
    id: string;
    codigo: string;
    descricao: string;
    principioAtivo: string | null;
    concentracao: string | null;
    forma: string | null;
    unidade: string;
    tipo: 'LARVICIDA' | 'ADULTICIDA';
    consumo30d: number;
    baixasPendentes: number;
    lotes: { loteId: string; lote: string; validade: string; vencido: boolean; deposito: string; unidade: string; saldo: number }[];
  }[];
}

/** Larvicidas por lote no depósito de endemias, entrada por remessa (SIES/SES) e prorrogação de validade por nota técnica. */
export function AbaEstoque({ podeLancar }: { podeLancar: boolean }) {
  const painel = useApi<PainelEstoque>('/endemias/estoque');
  const [dialogo, setDialogo] = useState<'produto' | 'entrada' | { loteId: string; lote: string; validade: string } | null>(null);
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader
          title="Larvicidas e adulticidas"
          description="Saldo por lote nos depósitos de endemias. A baixa sai de cada tratamento registrado pelo ACE."
          actions={
            podeLancar ? (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setDialogo('produto')}>
                  Novo insumo
                </Button>
                <Button onClick={() => setDialogo('entrada')}>Entrada por remessa</Button>
              </div>
            ) : undefined
          }
        />
        <CardBody className="space-y-4">
          {painel.loading && !painel.data && <Spinner />}
          {painel.error && <Alert tone="error">{painel.error}</Alert>}
          {painel.data && !painel.data.produtos.length && (
            <EmptyState title="Nenhum insumo do controle vetorial cadastrado" description="Cadastre os larvicidas recebidos do Ministério (ex.: Bti WG em gramas, disco de piriproxifeno em unidades)." />
          )}
          {painel.data?.produtos.map((p) => {
            const saldo = p.lotes.reduce((s, l) => s + l.saldo, 0);
            return (
              <div key={p.id} className="rounded-lg border border-slate-200">
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-3 py-2">
                  <div>
                    <div className="font-medium">{p.descricao}</div>
                    <div className="text-xs text-slate-500">
                      {p.codigo} · {p.tipo === 'LARVICIDA' ? 'larvicida' : 'adulticida'}
                      {p.concentracao ? ` · ${p.concentracao}` : ''}
                      {p.forma ? ` · ${p.forma}` : ''}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-semibold">
                      {qtd(saldo)} {p.unidade}
                    </div>
                    <div className="text-xs text-slate-500">
                      uso em 30 dias: {qtd(p.consumo30d)} {p.unidade}
                    </div>
                    {p.baixasPendentes > 0 && <Badge tone="amber">{p.baixasPendentes} baixa(s) pendente(s)</Badge>}
                  </div>
                </div>
                <Table>
                  <THead>
                    <tr>
                      <TH>Lote</TH>
                      <TH>Validade</TH>
                      <TH>Depósito</TH>
                      <TH>Saldo</TH>
                      {podeLancar && <TH />}
                    </tr>
                  </THead>
                  <TBody>
                    {p.lotes.map((l) => (
                      <TR key={`${l.loteId}:${l.deposito}`}>
                        <TD className="font-medium">{l.lote}</TD>
                        <TD>
                          {fmtDate(l.validade)} {l.vencido && <Badge tone="red">vencido</Badge>}
                        </TD>
                        <TD>
                          {l.deposito} <span className="text-xs text-slate-500">{l.unidade}</span>
                        </TD>
                        <TD>
                          {qtd(l.saldo)} {p.unidade}
                        </TD>
                        {podeLancar && (
                          <TD>
                            <Button size="sm" variant="ghost" onClick={() => setDialogo({ loteId: l.loteId, lote: l.lote, validade: l.validade })}>
                              Prorrogar validade
                            </Button>
                          </TD>
                        )}
                      </TR>
                    ))}
                    {!p.lotes.length && (
                      <TR>
                        <TD colSpan={5} className="text-sm text-slate-500">
                          Sem lote com saldo.
                        </TD>
                      </TR>
                    )}
                  </TBody>
                </Table>
              </div>
            );
          })}
          <p className="text-xs text-slate-500">
            Larvicidas da rotina (Nota Informativa nº 29/2024-CGARB): Bti WG 37,4% e o disco de piriproxifeno 2% para recipientes de 40 a 500 L. São fornecidos pelo Ministério e pedidos pelo SIES; a dose segue a
            capacidade do depósito e a nota técnica do produto.
          </p>
        </CardBody>
      </Card>
      {dialogo === 'produto' && <ProdutoDialog onClose={() => setDialogo(null)} onFeito={() => void painel.reload()} />}
      {dialogo === 'entrada' && painel.data && <EntradaDialog produtos={painel.data.produtos} onClose={() => setDialogo(null)} onFeito={() => void painel.reload()} />}
      {dialogo && typeof dialogo === 'object' && <ValidadeDialog lote={dialogo} onClose={() => setDialogo(null)} onFeito={() => void painel.reload()} />}
    </div>
  );
}

function ProdutoDialog({ onClose, onFeito }: { onClose: () => void; onFeito: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ code: '', description: '', activeIngredient: '', concentration: '', pharmaceuticalForm: '', unit: 'G', tipo: 'LARVICIDA' as 'LARVICIDA' | 'ADULTICIDA' });
  const [enviando, setEnviando] = useState(false);
  const salvar = async () => {
    setEnviando(true);
    try {
      await api.post('/endemias/estoque/produtos', { ...f, activeIngredient: f.activeIngredient || null, concentration: f.concentration || null, pharmaceuticalForm: f.pharmaceuticalForm || null });
      toast.success('Insumo cadastrado');
      onFeito();
      onClose();
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
      title="Novo insumo do controle vetorial"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={enviando} disabled={!f.code.trim() || f.description.trim().length < 3}>
            Cadastrar
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Código" htmlFor="pv-code">
          <Input id="pv-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="LAR003" />
        </Field>
        <Field label="Tipo" htmlFor="pv-tipo">
          <Select id="pv-tipo" value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value as typeof f.tipo })}>
            <option value="LARVICIDA">Larvicida</option>
            <option value="ADULTICIDA">Adulticida</option>
          </Select>
        </Field>
        <Field label="Descrição" htmlFor="pv-desc" className="sm:col-span-2">
          <Input id="pv-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Princípio ativo" htmlFor="pv-pa">
          <Input id="pv-pa" value={f.activeIngredient} onChange={(e) => setF({ ...f, activeIngredient: e.target.value })} />
        </Field>
        <Field label="Concentração" htmlFor="pv-conc">
          <Input id="pv-conc" value={f.concentration} onChange={(e) => setF({ ...f, concentration: e.target.value })} />
        </Field>
        <Field label="Apresentação" htmlFor="pv-forma">
          <Input id="pv-forma" value={f.pharmaceuticalForm} onChange={(e) => setF({ ...f, pharmaceuticalForm: e.target.value })} placeholder="Granulado (WG), disco, comprimido" />
        </Field>
        <Field label="Unidade de estoque" htmlFor="pv-un" hint="G (grama), UN (unidade), CP (comprimido), ML">
          <Input id="pv-un" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} maxLength={6} />
        </Field>
      </div>
    </Dialog>
  );
}

function EntradaDialog({ produtos, onClose, onFeito }: { produtos: PainelEstoque['produtos']; onClose: () => void; onFeito: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ productId: produtos[0]?.id ?? '', lotNumber: '', expiry: '', manufacturedAt: '', quantity: '', document: '', origin: 'SIES', notes: '' });
  const [enviando, setEnviando] = useState(false);
  const unidade = produtos.find((p) => p.id === f.productId)?.unidade ?? '';
  const salvar = async () => {
    setEnviando(true);
    try {
      await api.post('/endemias/estoque/entradas', { ...f, quantity: Number(f.quantity.replace(',', '.')), manufacturedAt: f.manufacturedAt || null, notes: f.notes || null });
      toast.success('Entrada lançada no depósito de endemias');
      onFeito();
      onClose();
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
      title="Entrada por remessa"
      description="Larvicida recebido do Ministério ou da SES (guia do SIES), sem nota fiscal"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={enviando} disabled={!f.productId || !f.lotNumber.trim() || !f.expiry || !(Number(f.quantity.replace(',', '.')) > 0) || !f.document.trim()}>
            Lançar
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Insumo" htmlFor="en-prod" className="sm:col-span-2">
          <Select id="en-prod" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}>
            {produtos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.descricao}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Lote" htmlFor="en-lote">
          <Input id="en-lote" value={f.lotNumber} onChange={(e) => setF({ ...f, lotNumber: e.target.value.toUpperCase() })} />
        </Field>
        <Field label={`Quantidade (${unidade})`} htmlFor="en-qtd">
          <Input id="en-qtd" inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
        </Field>
        <Field label="Validade" htmlFor="en-val">
          <Input id="en-val" type="date" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} />
        </Field>
        <Field label="Fabricação" htmlFor="en-fab">
          <Input id="en-fab" type="date" value={f.manufacturedAt} onChange={(e) => setF({ ...f, manufacturedAt: e.target.value })} />
        </Field>
        <Field label="Documento (guia)" htmlFor="en-doc">
          <Input id="en-doc" value={f.document} onChange={(e) => setF({ ...f, document: e.target.value.toUpperCase() })} placeholder="SIES-2026-0042" />
        </Field>
        <Field label="Origem" htmlFor="en-orig">
          <Select id="en-orig" value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value })}>
            <option value="SIES">Ministério da Saúde (SIES)</option>
            <option value="SES">Secretaria Estadual</option>
            <option value="MUNICIPIO">Município</option>
            <option value="OUTRA">Outra</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function ValidadeDialog({ lote, onClose, onFeito }: { lote: { loteId: string; lote: string; validade: string }; onClose: () => void; onFeito: () => void }) {
  const toast = useToast();
  const [validade, setValidade] = useState('');
  const [documento, setDocumento] = useState('');
  const [enviando, setEnviando] = useState(false);
  const salvar = async () => {
    setEnviando(true);
    try {
      await api.post(`/endemias/estoque/lotes/${lote.loteId}/validade`, { validade, documento });
      toast.success('Validade prorrogada');
      onFeito();
      onClose();
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
      title={`Prorrogar validade do lote ${lote.lote}`}
      description={`Validade atual: ${fmtDate(lote.validade)}. Só com nota técnica do Ministério (ex.: NT nº 54/2025-CGARB).`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={enviando} disabled={!validade || documento.trim().length < 3}>
            Prorrogar
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nova validade" htmlFor="pv-val">
          <Input id="pv-val" type="date" value={validade} onChange={(e) => setValidade(e.target.value)} />
        </Field>
        <Field label="Nota técnica" htmlFor="pv-nt">
          <Input id="pv-nt" value={documento} onChange={(e) => setDocumento(e.target.value)} placeholder="Nota Técnica nº 54/2025-CGARB/DEDT/SVSA/MS" />
        </Field>
      </div>
    </Dialog>
  );
}

// ─── Produção e índices ────────────────────────────────────────────────────

interface Resumo {
  visitas: number;
  trabalhados: number;
  fechados: number;
  recusados: number;
  abandonados: number;
  recuperados: number;
  imoveisComFoco: number;
  depositosInspecionados: number;
  depositosComFoco: number;
  depositosEliminados: number;
  depositosTratados: number;
  amostras: number;
  nebulizados: number;
  larvicida: { produto: string; unidade: string; quantidade: number }[];
}
interface Producao {
  periodo: { de: string; ate: string };
  total: Resumo & { indices: IndicesLarvarios };
  agentes: (Resumo & { id: string; nome: string | null })[];
  localidades: { id: string; codigo: string; nome: string; visitas: number; indices: IndicesLarvarios }[];
}

const CLASSE = { SATISFATORIO: { label: 'Satisfatório', tone: 'green' }, ALERTA: { label: 'Alerta', tone: 'amber' }, RISCO: { label: 'Risco', tone: 'red' } } as const;
const num = (n: number | null) => (n === null ? '—' : n.toLocaleString('pt-BR'));

export function AbaProducao() {
  const [de, setDe] = useState(todayIso(-30));
  const [ate, setAte] = useState(todayIso());
  const p = useApi<Producao>(`/endemias/producao?de=${de}&ate=${ate}`, [de, ate]);
  const t = p.data?.total;
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader
          title="Produção de campo e índices"
          description="Índices preliminares: o foco ainda sem a identificação da espécie pelo laboratório de entomologia."
          actions={
            <div className="flex gap-2">
              <Input type="date" aria-label="De" value={de} onChange={(e) => setDe(e.target.value)} />
              <Input type="date" aria-label="Até" value={ate} onChange={(e) => setAte(e.target.value)} />
            </div>
          }
        />
        <CardBody className="space-y-3">
          {p.loading && !p.data && <Spinner />}
          {p.error && <Alert tone="error">{p.error}</Alert>}
          {t && (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat label="Imóveis trabalhados" value={t.trabalhados} tone="good" hint={`${t.recuperados} recuperado(s)`} />
                <Stat
                  label="Pendências"
                  value={t.fechados + t.recusados + t.abandonados}
                  tone={t.fechados + t.recusados + t.abandonados ? 'warn' : 'default'}
                  hint={`${t.fechados} fechados · ${t.recusados} recusados · ${t.abandonados} abandonados`}
                />
                <Stat label="Imóveis com foco" value={t.imoveisComFoco} tone={t.imoveisComFoco ? 'bad' : 'default'} hint={`${t.depositosComFoco} depósito(s) com foco · ${t.amostras} tubito(s)`} />
                <Stat label="Depósitos" value={t.depositosInspecionados} hint={`${t.depositosEliminados} eliminados · ${t.depositosTratados} tratados`} />
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat
                  label="IIP (predial)"
                  value={t.indices.iip === null ? '—' : `${num(t.indices.iip)}%`}
                  tone={t.indices.classe === 'RISCO' ? 'bad' : t.indices.classe === 'ALERTA' ? 'warn' : 'good'}
                  hint={t.indices.classe ? CLASSE[t.indices.classe].label : undefined}
                />
                <Stat label="Índice de Breteau" value={num(t.indices.ib)} hint="depósitos com foco por 100 imóveis" />
                <Stat label="Índice de recipientes" value={t.indices.ir === null ? '—' : `${num(t.indices.ir)}%`} />
                <Stat label="Larvicida usado" value={t.larvicida.map((l) => `${qtd(l.quantidade)} ${l.unidade}`).join(' · ') || '—'} hint={`${t.nebulizados} imóvel(is) nebulizado(s)`} />
              </div>
              <div className="text-xs text-slate-600">Por tipo de recipiente (ITR): {TIPOS_DEPOSITO.map((d) => `${d} ${t.indices.itr[d] === null ? '—' : `${num(t.indices.itr[d])}%`}`).join(' · ')}</div>
            </>
          )}
        </CardBody>
      </Card>
      {!!p.data?.agentes.length && (
        <Card>
          <CardHeader title="Por agente" />
          <CardBody className="p-0">
            <Table>
              <THead>
                <tr>
                  <TH>Agente</TH>
                  <TH>Visitas</TH>
                  <TH>Trabalhados</TH>
                  <TH>Pendências</TH>
                  <TH>Com foco</TH>
                  <TH>Depósitos (insp./elim./trat.)</TH>
                  <TH>Larvicida</TH>
                </tr>
              </THead>
              <TBody>
                {p.data.agentes.map((a) => (
                  <TR key={a.id}>
                    <TD>{a.nome}</TD>
                    <TD>{a.visitas}</TD>
                    <TD>
                      {a.trabalhados}
                      {a.recuperados ? <span className="text-xs text-slate-500"> ({a.recuperados} rec.)</span> : null}
                    </TD>
                    <TD>{a.fechados + a.recusados + a.abandonados}</TD>
                    <TD>{a.imoveisComFoco}</TD>
                    <TD>
                      {a.depositosInspecionados}/{a.depositosEliminados}/{a.depositosTratados}
                    </TD>
                    <TD className="text-sm">{a.larvicida.map((l) => `${qtd(l.quantidade)} ${l.unidade}`).join(' · ') || '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      )}
      {!!p.data?.localidades.length && (
        <Card>
          <CardHeader title="Por localidade" />
          <CardBody className="p-0">
            <Table>
              <THead>
                <tr>
                  <TH>Localidade</TH>
                  <TH>Visitas</TH>
                  <TH>Imóveis inspecionados</TH>
                  <TH>IIP</TH>
                  <TH>Breteau</TH>
                  <TH>Classe</TH>
                </tr>
              </THead>
              <TBody>
                {p.data.localidades.map((l) => (
                  <TR key={l.id}>
                    <TD>
                      {l.codigo} · {l.nome}
                    </TD>
                    <TD>{l.visitas}</TD>
                    <TD>{l.indices.imoveisInspecionados}</TD>
                    <TD>{l.indices.iip === null ? '—' : `${num(l.indices.iip)}%`}</TD>
                    <TD>{num(l.indices.ib)}</TD>
                    <TD>{l.indices.classe ? <Badge tone={CLASSE[l.indices.classe].tone}>{CLASSE[l.indices.classe].label}</Badge> : '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

// ─── Configuração ──────────────────────────────────────────────────────────

interface ConfigEndemias {
  bloqueioAutomatico: boolean;
  janelaAgrupamentoDias: number;
  gruposBloqueio: string[];
  alertaSemInicioDias: number;
  raioBloqueioM: number;
}

export function AbaConfiguracao({ podeEditar }: { podeEditar: boolean }) {
  const toast = useToast();
  const cfg = useApi<ConfigEndemias>('/endemias/configuracao');
  const [f, setF] = useState<ConfigEndemias | null>(null);
  const [salvando, setSalvando] = useState(false);
  useEffect(() => {
    if (cfg.data) setF(cfg.data);
  }, [cfg.data]);
  if (cfg.loading && !f) return <Spinner />;
  if (cfg.error) return <Alert tone="error">{cfg.error}</Alert>;
  if (!f) return null;
  const salvar = async () => {
    setSalvando(true);
    try {
      cfg.setData(
        await api.put<ConfigEndemias>('/endemias/configuracao', {
          bloqueioAutomatico: f.bloqueioAutomatico,
          janelaAgrupamentoDias: f.janelaAgrupamentoDias,
          gruposBloqueio: f.gruposBloqueio,
          alertaSemInicioDias: f.alertaSemInicioDias,
        }),
      );
      toast.success('Configuração salva');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSalvando(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Bloqueio de transmissão" description={`Raio de ${f.raioBloqueioM} m (definido em Território > Configuração; as Diretrizes pedem no mínimo 150 m).`} />
      <CardBody className="space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" disabled={!podeEditar} checked={f.bloqueioAutomatico} onChange={(e) => setF({ ...f, bloqueioAutomatico: e.target.checked })} />
          <span>
            <span className="font-medium">Abrir a ordem a cada notificação</span>
            <span className="block text-slate-500">Em epidemia, com a transmissão espalhada, desligue e passe a agir por área (Diretrizes de 2025, cap. 9). As ordens já abertas continuam.</span>
          </span>
        </label>
        <fieldset>
          <legend className="text-sm font-medium">Agravos que abrem a ordem</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {['dengue', 'chikungunya', 'zika', 'febre-amarela'].map((g) => (
              <label key={g} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={!podeEditar}
                  checked={f.gruposBloqueio.includes(g)}
                  onChange={(e) => setF({ ...f, gruposBloqueio: e.target.checked ? [...f.gruposBloqueio, g] : f.gruposBloqueio.filter((x) => x !== g) })}
                />
                {GRUPO_LABEL[g]}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">Febre amarela urbana (Aedes) é opção local; oropouche e febre do Nilo têm outros vetores e não entram.</p>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Janela de agrupamento (dias)" htmlFor="cfg-janela" hint="Casos da mesma área com até esta diferença de datas entram na mesma ordem (Diretrizes: 7)">
            <Input id="cfg-janela" type="number" min={1} max={30} disabled={!podeEditar} value={f.janelaAgrupamentoDias} onChange={(e) => setF({ ...f, janelaAgrupamentoDias: Number(e.target.value) || 1 })} />
          </Field>
          <Field label="Alerta de ordem sem início (dias)" htmlFor="cfg-alerta" hint="Parâmetro local: o Ministério pede o início o mais rápido possível">
            <Input id="cfg-alerta" type="number" min={1} max={30} disabled={!podeEditar} value={f.alertaSemInicioDias} onChange={(e) => setF({ ...f, alertaSemInicioDias: Number(e.target.value) || 1 })} />
          </Field>
        </div>
        {podeEditar && (
          <div className="flex justify-end">
            <Button onClick={salvar} loading={salvando} disabled={!f.gruposBloqueio.length}>
              Salvar
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
