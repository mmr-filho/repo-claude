'use client';

import { TIPOS_DEPOSITO, type IndicesLarvarios, type PositividadeAtividade } from '@omnisaude/shared';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, Stat } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { fmtIndice, fmtPercentual, fmtQuantidade as qtd, lerQuantidadeEntrada, textoSeraLancado } from './gestao-regras';
import { GRUPO_LABEL, type EntradaRemessa, type PainelEstoque } from './types';

// ─── Estoque de larvicidas ──────────────────────────────────────────────────

const ORIGEM_LABEL: Record<string, string> = { SIES: 'Ministério da Saúde (SIES)', SES: 'Secretaria Estadual', MUNICIPIO: 'Município', OUTRA: 'Outra' };

/** Larvicidas por lote no depósito de endemias, entrada por remessa (SIES/SES) e prorrogação de validade por nota técnica. */
export function AbaEstoque({ podeLancar }: { podeLancar: boolean }) {
  const painel = useApi<PainelEstoque>('/endemias/estoque');
  const entradas = useApi<EntradaRemessa[]>('/endemias/estoque/entradas');
  const [dialogo, setDialogo] = useState<'produto' | 'entrada' | { loteId: string; lote: string; validade: string } | null>(null);
  const [estornando, setEstornando] = useState<EntradaRemessa | null>(null);
  const recarregar = () => {
    void painel.reload();
    void entradas.reload();
  };
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
                    <div className="font-medium">
                      {p.descricao} {!p.ativo && <Badge>inativo</Badge>}
                    </div>
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
      <Card>
        <CardHeader
          title="Entradas recentes"
          description="As 100 últimas entradas por remessa. A entrada lançada errada (quantidade, lote ou validade) se corrige pelo estorno; depois, a mesma guia pode ser lançada de novo."
        />
        <CardBody className="p-0">
          {entradas.loading && !entradas.data && <Spinner className="p-4" />}
          {entradas.error && <Alert tone="error">{entradas.error}</Alert>}
          {entradas.data && !entradas.data.length && <EmptyState title="Nenhuma entrada lançada" />}
          {!!entradas.data?.length && (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <tr>
                    <TH>Recebida em</TH>
                    <TH>Guia</TH>
                    <TH>Insumo e lote</TH>
                    <TH>Quantidade</TH>
                    <TH>Depósito</TH>
                    <TH>Situação</TH>
                    {podeLancar && <TH />}
                  </tr>
                </THead>
                <TBody>
                  {entradas.data.map((e) => (
                    <TR key={e.id}>
                      <TD className="whitespace-nowrap">
                        {fmtDateTime(e.recebidaEm)}
                        <div className="text-xs text-slate-500">{e.recebidaPor ?? '—'}</div>
                      </TD>
                      <TD>
                        {e.documento}
                        <div className="text-xs text-slate-500">{ORIGEM_LABEL[e.origem] ?? e.origem}</div>
                      </TD>
                      <TD>
                        {e.produto ?? '—'}
                        <div className="text-xs text-slate-500">lote {e.lote ?? '—'}</div>
                      </TD>
                      <TD className={e.estornadaEm ? 'whitespace-nowrap text-slate-400 line-through' : 'whitespace-nowrap'}>
                        {qtd(e.quantidade)} {e.unidade ?? ''}
                      </TD>
                      <TD>
                        {e.deposito ?? '—'}
                        <div className="text-xs text-slate-500">{e.unidadeDeposito ?? ''}</div>
                      </TD>
                      <TD>
                        {e.estornadaEm ? (
                          <>
                            <Badge>estornada</Badge>
                            <div className="max-w-[16rem] text-xs text-slate-500">
                              {fmtDateTime(e.estornadaEm)} por {e.estornadaPor ?? '—'}: {e.motivoEstorno}
                            </div>
                          </>
                        ) : (
                          <Badge tone="green">lançada</Badge>
                        )}
                      </TD>
                      {podeLancar && (
                        <TD>
                          {!e.estornadaEm && (
                            <Button size="sm" variant="ghost" onClick={() => setEstornando(e)}>
                              Estornar
                            </Button>
                          )}
                        </TD>
                      )}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>
      {dialogo === 'produto' && <ProdutoDialog onClose={() => setDialogo(null)} onFeito={recarregar} />}
      {dialogo === 'entrada' && painel.data && <EntradaDialog produtos={painel.data.produtos} onClose={() => setDialogo(null)} onFeito={recarregar} />}
      {dialogo && typeof dialogo === 'object' && <ValidadeDialog lote={dialogo} onClose={() => setDialogo(null)} onFeito={recarregar} />}
      {estornando && <EstornoDialog entrada={estornando} onClose={() => setEstornando(null)} onFeito={recarregar} />}
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
  const ativos = produtos.filter((p) => p.ativo);
  const [f, setF] = useState({ productId: ativos[0]?.id ?? '', lotNumber: '', expiry: '', manufacturedAt: '', quantity: '', document: '', origin: 'SIES', notes: '' });
  const [enviando, setEnviando] = useState(false);
  const unidade = produtos.find((p) => p.id === f.productId)?.unidade ?? '';
  // Formato brasileiro: "25.000" são 25 mil (não 25); o que for ambíguo não é lançado.
  const quantidade = lerQuantidadeEntrada(f.quantity);
  const salvar = async () => {
    if (quantidade.valor === null) return;
    setEnviando(true);
    try {
      await api.post('/endemias/estoque/entradas', { ...f, quantity: quantidade.valor, manufacturedAt: f.manufacturedAt || null, notes: f.notes || null });
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
          <Button onClick={salvar} loading={enviando} disabled={!f.productId || !f.lotNumber.trim() || !f.expiry || quantidade.valor === null || !f.document.trim()}>
            {quantidade.valor === null ? 'Lançar' : `Lançar ${qtd(quantidade.valor)} ${unidade}`.trim()}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Insumo" htmlFor="en-prod" className="sm:col-span-2">
          <Select id="en-prod" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}>
            {ativos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.descricao}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Lote" htmlFor="en-lote">
          <Input id="en-lote" value={f.lotNumber} onChange={(e) => setF({ ...f, lotNumber: e.target.value.toUpperCase() })} />
        </Field>
        <Field label={`Quantidade (${unidade})`} htmlFor="en-qtd" error={quantidade.erro} hint="Vírgula nas casas decimais e ponto no milhar (25.000 são 25 mil)">
          <Input id="en-qtd" inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} placeholder="Ex.: 25.000" />
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
            {Object.entries(ORIGEM_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        {quantidade.valor !== null && (
          <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-800 sm:col-span-2" role="status">
            {textoSeraLancado(quantidade.valor, unidade)}
            {f.lotNumber.trim() ? ` no lote ${f.lotNumber.trim()}` : ''}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Estorno da entrada lançada errada: movimento inverso auditado; depois dele, a mesma guia pode ser lançada de novo. */
function EstornoDialog({ entrada, onClose, onFeito }: { entrada: EntradaRemessa; onClose: () => void; onFeito: () => void }) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const estornar = async () => {
    setEnviando(true);
    try {
      await api.post(`/endemias/estoque/entradas/${entrada.id}/estorno`, { motivo: motivo.trim() });
      toast.success('Entrada estornada: a guia pode ser lançada de novo');
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
      title={`Estornar a entrada da guia ${entrada.documento}`}
      description={`${entrada.produto ?? '—'} · lote ${entrada.lote ?? '—'} · ${qtd(entrada.quantidade)} ${entrada.unidade ?? ''} · ${entrada.deposito ?? '—'}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button variant="danger" onClick={estornar} loading={enviando} disabled={motivo.trim().length < 5}>
            Estornar
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Alert tone="warn">
          Sai do depósito toda a quantidade desta entrada, num movimento de estorno registrado na trilha de auditoria. Só é possível se o lote ainda tiver esse saldo no depósito: o que já foi usado em campo não volta.
        </Alert>
        <Field label="Motivo (de 5 a 500 caracteres)" htmlFor="es-motivo">
          <Textarea id="es-motivo" rows={2} maxLength={500} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: lançada como 25 G em vez de 25.000 G" />
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
  /** Imóveis distintos com foco em qualquer atividade (o índice é só do levantamento). */
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
  /** Índices só do levantamento (LI e LI+T); as outras atividades têm a positividade à parte. */
  total: Resumo & { indices: IndicesLarvarios; positividade: PositividadeAtividade[] };
  agentes: (Resumo & { id: string; nome: string | null })[];
  localidades: { id: string; codigo: string; nome: string; visitas: number; indices: IndicesLarvarios }[];
}

const CLASSE = { SATISFATORIO: { label: 'Satisfatório', tone: 'green' }, ALERTA: { label: 'Alerta', tone: 'amber' }, RISCO: { label: 'Risco', tone: 'red' } } as const;

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
                <Stat label="Imóveis trabalhados" value={t.trabalhados} tone="good" hint={`visitas de todas as atividades · ${t.recuperados} recuperado(s)`} />
                <Stat
                  label="Pendências"
                  value={t.fechados + t.recusados + t.abandonados}
                  tone={t.fechados + t.recusados + t.abandonados ? 'warn' : 'default'}
                  hint={`${t.fechados} fechados · ${t.recusados} recusados · ${t.abandonados} abandonados`}
                />
                <Stat label="Imóveis com foco" value={t.imoveisComFoco} tone={t.imoveisComFoco ? 'bad' : 'default'} hint={`em qualquer atividade · ${t.depositosComFoco} depósito(s) com foco · ${t.amostras} tubito(s)`} />
                <Stat label="Depósitos" value={t.depositosInspecionados} hint={`${t.depositosEliminados} eliminados · ${t.depositosTratados} tratados`} />
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-700">Índices do levantamento (LI e LI+T)</h3>
                <p className="text-xs text-slate-500">
                  {t.indices.imoveisInspecionados
                    ? `${t.indices.imoveisInspecionados} imóvel(is) inspecionado(s) em LI ou LI+T, cada um pela última visita trabalhada no período; ${t.indices.imoveisComFoco} com foco.`
                    : 'Nenhum imóvel trabalhado em LI ou LI+T no período: sem índice. As outras atividades (tratamento, bloqueio, PE, DF, PVE) são buscas dirigidas e não entram no índice.'}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat
                  label="IIP (LI e LI+T)"
                  value={fmtPercentual(t.indices.iip)}
                  tone={t.indices.classe === 'RISCO' ? 'bad' : t.indices.classe === 'ALERTA' ? 'warn' : t.indices.classe ? 'good' : 'default'}
                  hint={t.indices.classe ? CLASSE[t.indices.classe].label : undefined}
                />
                <Stat label="Breteau (LI e LI+T)" value={fmtIndice(t.indices.ib)} hint="depósitos com foco por 100 imóveis" />
                <Stat label="Recipientes (LI e LI+T)" value={fmtPercentual(t.indices.ir)} hint="depósitos com foco por depósitos inspecionados" />
                <Stat label="Larvicida usado" value={t.larvicida.map((l) => `${qtd(l.quantidade)} ${l.unidade}`).join(' · ') || '—'} hint={`${t.nebulizados} imóvel(is) nebulizado(s)`} />
              </div>
              <div className="text-xs text-slate-600">Por tipo de recipiente (ITR, LI e LI+T): {TIPOS_DEPOSITO.map((d) => `${d} ${fmtPercentual(t.indices.itr[d])}`).join(' · ')}</div>
              {t.positividade.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-slate-700">Positividade das outras atividades</h3>
                  <p className="text-xs text-slate-500">Imóveis com foco entre os trabalhados em cada atividade no período. Não é índice de infestação: são buscas dirigidas.</p>
                  <Table>
                    <THead>
                      <tr>
                        <TH>Atividade</TH>
                        <TH>Imóveis trabalhados</TH>
                        <TH>Com foco</TH>
                        <TH>Positividade</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {t.positividade.map((a) => (
                        <TR key={a.atividade}>
                          <TD>{a.label}</TD>
                          <TD>{a.imoveisInspecionados}</TD>
                          <TD>{a.imoveisComFoco}</TD>
                          <TD>{fmtPercentual(a.percentual)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              )}
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
          <CardHeader title="Por localidade" description="Índices do levantamento (LI e LI+T) de cada localidade; as visitas são de todas as atividades." />
          <CardBody className="p-0">
            <Table>
              <THead>
                <tr>
                  <TH>Localidade</TH>
                  <TH>Visitas</TH>
                  <TH>Imóveis inspecionados (LI e LI+T)</TH>
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
                    <TD>{fmtPercentual(l.indices.iip)}</TD>
                    <TD>{fmtIndice(l.indices.ib)}</TD>
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
