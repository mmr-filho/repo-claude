'use client';

import { PRIORIDADES, TIPO_PRESTADOR, type TipoPrestador, type TipoSolicitacao } from '@omnisaude/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { Protocolos } from './types';

export interface Prestador {
  id: string;
  name: string;
  kind: TipoPrestador;
  kindLabel: string;
  unit: { id: string; name: string } | null;
  cnes: string | null;
  cnpj: string | null;
  contractNumber: string | null;
  contractStart: string | null;
  contractEnd: string | null;
  physicalCeiling: number | null;
  financialCeiling: number | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  agendas: number;
  resumo: { cotas: number; quantidade: number; usadas: number; valorUsado: number; tetoFisicoUsadoPct: number | null; tetoFinanceiroUsadoPct: number | null };
}

export interface Cota {
  id: string;
  competencia: string;
  kind: TipoSolicitacao;
  specialty: string;
  specialtyLabel: string;
  quantity: number;
  unitValue: number | null;
  originUnitId: string | null;
  originUnitName: string | null;
  notes: string | null;
  used: number;
  available: number;
  valorUsado: number;
}

const competenciaAtual = () => new Date().toISOString().slice(0, 7);
const vazio = () => ({
  name: '',
  kind: 'PROPRIO' as TipoPrestador,
  unitId: '',
  cnes: '',
  cnpj: '',
  contractNumber: '',
  contractStart: '',
  contractEnd: '',
  physicalCeiling: '',
  financialCeiling: '',
  phone: '',
  address: '',
  notes: '',
  active: true,
});

/** Prestadores executantes, contratos, PPI e cotas por competência, com o consumo pelas autorizações. */
export function ProvidersTab({ podeGerir }: { podeGerir: boolean }) {
  const toast = useToast();
  const [competencia, setCompetencia] = useState(competenciaAtual());
  const lista = useApi<Prestador[]>(`/regulacao/prestadores?competencia=${competencia}`, [competencia]);
  const directory = useApi<{ units: { id: string; name: string; type: string }[] }>('/directory');
  const protocolos = useApi<Protocolos>('/regulacao/protocolos');
  const [editando, setEditando] = useState<Prestador | 'novo' | null>(null);
  const [cotasDe, setCotasDe] = useState<Prestador | null>(null);
  const [form, setForm] = useState(vazio());
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (editando === 'novo') setForm(vazio());
    else if (editando)
      setForm({
        name: editando.name,
        kind: editando.kind,
        unitId: editando.unit?.id ?? '',
        cnes: editando.cnes ?? '',
        cnpj: editando.cnpj ?? '',
        contractNumber: editando.contractNumber ?? '',
        contractStart: editando.contractStart?.slice(0, 10) ?? '',
        contractEnd: editando.contractEnd?.slice(0, 10) ?? '',
        physicalCeiling: editando.physicalCeiling?.toString() ?? '',
        financialCeiling: editando.financialCeiling?.toString() ?? '',
        phone: editando.phone ?? '',
        address: editando.address ?? '',
        notes: editando.notes ?? '',
        active: editando.active,
      });
    setErro(null);
  }, [editando]);

  async function salvar() {
    setErro(null);
    if (form.name.trim().length < 3) return setErro('Informe o nome do prestador');
    const texto = (v: string) => (v.trim() ? v.trim() : null);
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      unitId: form.unitId || null,
      cnes: texto(form.cnes),
      cnpj: form.cnpj.replace(/\D/g, '') || null,
      contractNumber: texto(form.contractNumber),
      contractStart: form.contractStart || null,
      contractEnd: form.contractEnd || null,
      physicalCeiling: form.physicalCeiling ? Number(form.physicalCeiling) : null,
      financialCeiling: form.financialCeiling ? Number(form.financialCeiling.replace(',', '.')) : null,
      phone: texto(form.phone),
      address: texto(form.address),
      notes: texto(form.notes),
      active: form.active,
    };
    setBusy(true);
    try {
      if (editando === 'novo') await api.post('/regulacao/prestadores', body);
      else if (editando) await api.patch(`/regulacao/prestadores/${editando.id}`, body);
      toast.success('Prestador salvo');
      setEditando(null);
      await lista.reload();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const unidades = (directory.data?.units ?? []).filter((u) => !['FARMACIA_CENTRAL', 'ALMOXARIFADO'].includes(u.type));
  return (
    <>
      <Card>
        <CardHeader
          title="Prestadores, contratos e cotas"
          description="Quem executa o que a regulação autoriza: rede própria e contratados, com tetos e a PPI (cotas por competência, especialidade e origem)."
          actions={
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Competência" htmlFor="prest-comp">
                <Input id="prest-comp" type="month" value={competencia} onChange={(e) => setCompetencia(e.target.value || competenciaAtual())} />
              </Field>
              {podeGerir && (
                <Button onClick={() => setEditando('novo')} id="prest-novo">
                  <Plus className="h-4 w-4" /> Novo prestador
                </Button>
              )}
            </div>
          }
        />
        <CardBody className="p-0">
          {lista.error && (
            <Alert tone="error" className="m-4">
              {lista.error}
            </Alert>
          )}
          {lista.loading && !lista.data && <Spinner />}
          {lista.data && lista.data.length === 0 && <EmptyState title="Nenhum prestador" description="Cadastre a rede própria e os contratados que executam consultas, exames e procedimentos." />}
          {lista.data && lista.data.length > 0 && (
            <Table>
              <THead>
                <TR>
                  <TH>Prestador</TH>
                  <TH>Contrato</TH>
                  <TH>Tetos</TH>
                  <TH>Cotas em {competencia}</TH>
                  <TH>Agendas</TH>
                  <TH></TH>
                </TR>
              </THead>
              <TBody>
                {lista.data.map((p) => (
                  <TR key={p.id} className={p.active ? '' : 'opacity-60'}>
                    <TD>
                      {p.name}
                      <span className="block text-xs text-slate-500">
                        {p.kindLabel}
                        {p.unit ? ` · ${p.unit.name}` : ''}
                        {p.cnpj ? ` · CNPJ ${p.cnpj}` : ''}
                        {!p.active ? ' · inativo' : ''}
                      </span>
                    </TD>
                    <TD className="text-xs">
                      {p.contractNumber ?? '—'}
                      {p.contractStart && (
                        <span className="block text-slate-500">
                          {fmtDate(p.contractStart)} a {p.contractEnd ? fmtDate(p.contractEnd) : '—'}
                        </span>
                      )}
                    </TD>
                    <TD className="text-xs">
                      {p.physicalCeiling !== null ? `${p.physicalCeiling}/mês` : '—'}
                      {p.resumo.tetoFisicoUsadoPct !== null && (
                        <Badge tone={p.resumo.tetoFisicoUsadoPct >= 100 ? 'red' : p.resumo.tetoFisicoUsadoPct >= 80 ? 'amber' : 'green'} className="ml-1">
                          {p.resumo.tetoFisicoUsadoPct}%
                        </Badge>
                      )}
                      {p.financialCeiling !== null && (
                        <span className="block text-slate-500">
                          {fmtMoney(p.financialCeiling)}/mês
                          {p.resumo.tetoFinanceiroUsadoPct !== null && (
                            <Badge tone={p.resumo.tetoFinanceiroUsadoPct >= 100 ? 'red' : p.resumo.tetoFinanceiroUsadoPct >= 80 ? 'amber' : 'green'} className="ml-1">
                              {p.resumo.tetoFinanceiroUsadoPct}%
                            </Badge>
                          )}
                        </span>
                      )}
                    </TD>
                    <TD className="text-xs">
                      {p.resumo.cotas} cota(s) · {p.resumo.usadas}/{p.resumo.quantidade} usadas
                      {p.resumo.valorUsado > 0 && <span className="block text-slate-500">{fmtMoney(p.resumo.valorUsado)} executados</span>}
                    </TD>
                    <TD className="text-xs">{p.unit ? `${p.agendas} agenda(s)` : 'externo'}</TD>
                    <TD className="whitespace-nowrap">
                      <Button size="sm" variant="secondary" onClick={() => setCotasDe(p)}>
                        Cotas
                      </Button>
                      {podeGerir && (
                        <Button size="sm" variant="ghost" onClick={() => setEditando(p)} className="ml-1">
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
      </Card>

      <Dialog
        open={!!editando}
        onOpenChange={(o) => !o && setEditando(null)}
        title={editando === 'novo' ? 'Novo prestador' : 'Editar prestador'}
        description="Rede própria (unidade do sistema) ou serviço contratado, com contrato e tetos mensais"
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditando(null)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={salvar} loading={busy} id="prest-salvar">
              Salvar
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {erro && <Alert tone="error">{erro}</Alert>}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Nome" htmlFor="prest-nome" className="sm:col-span-2">
              <Input id="prest-nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Tipo" htmlFor="prest-tipo">
              <Select id="prest-tipo" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as TipoPrestador })}>
                {(Object.keys(TIPO_PRESTADOR) as TipoPrestador[]).map((k) => (
                  <option key={k} value={k}>
                    {TIPO_PRESTADOR[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Unidade da rede (quando própria)" htmlFor="prest-unidade" className="sm:col-span-2">
              <Select id="prest-unidade" value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })}>
                <option value="">Prestador externo</option>
                {unidades.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="CNES" htmlFor="prest-cnes">
              <Input id="prest-cnes" value={form.cnes} onChange={(e) => setForm({ ...form, cnes: e.target.value })} />
            </Field>
            <Field label="CNPJ" htmlFor="prest-cnpj">
              <Input id="prest-cnpj" value={form.cnpj} onChange={(e) => setForm({ ...form, cnpj: e.target.value })} />
            </Field>
            <Field label="Contrato" htmlFor="prest-contrato">
              <Input id="prest-contrato" value={form.contractNumber} onChange={(e) => setForm({ ...form, contractNumber: e.target.value })} />
            </Field>
            <Field label="Vigência" htmlFor="prest-ini">
              <div className="flex gap-1">
                <Input id="prest-ini" type="date" value={form.contractStart} onChange={(e) => setForm({ ...form, contractStart: e.target.value })} />
                <Input type="date" value={form.contractEnd} onChange={(e) => setForm({ ...form, contractEnd: e.target.value })} aria-label="Fim da vigência" />
              </div>
            </Field>
            <Field label="Teto físico (proc./mês)" htmlFor="prest-tf">
              <Input id="prest-tf" inputMode="numeric" value={form.physicalCeiling} onChange={(e) => setForm({ ...form, physicalCeiling: e.target.value })} />
            </Field>
            <Field label="Teto financeiro (R$/mês)" htmlFor="prest-tfin">
              <Input id="prest-tfin" inputMode="decimal" value={form.financialCeiling} onChange={(e) => setForm({ ...form, financialCeiling: e.target.value })} />
            </Field>
            <Field label="Telefone" htmlFor="prest-tel">
              <Input id="prest-tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            <Field label="Endereço" htmlFor="prest-end" className="sm:col-span-2">
              <Input id="prest-end" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
            <Field label="Observações" htmlFor="prest-obs" className="sm:col-span-3">
              <Textarea id="prest-obs" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
            {editando !== 'novo' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Ativo
              </label>
            )}
          </div>
        </div>
      </Dialog>

      {cotasDe && (
        <QuotasDialog prestador={cotasDe} competencia={competencia} podeGerir={podeGerir} protocolos={protocolos.data ?? null} unidades={unidades} onClose={() => setCotasDe(null)} onChanged={() => void lista.reload()} />
      )}
    </>
  );
}

interface LinhaCota {
  id?: string;
  kind: TipoSolicitacao;
  specialty: string;
  quantity: string;
  unitValue: string;
  originUnitId: string;
  notes: string;
  used?: number;
}

function QuotasDialog({
  prestador,
  competencia,
  podeGerir,
  protocolos,
  unidades,
  onClose,
  onChanged,
}: {
  prestador: Prestador;
  competencia: string;
  podeGerir: boolean;
  protocolos: Protocolos | null;
  unidades: { id: string; name: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [comp, setComp] = useState(competencia);
  const cotas = useApi<Cota[]>(`/regulacao/prestadores/${prestador.id}/cotas?competencia=${comp}`, [comp]);
  const [linhas, setLinhas] = useState<LinhaCota[]>([]);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => {
    if (cotas.data)
      setLinhas(
        cotas.data.map((c) => ({
          id: c.id,
          kind: c.kind,
          specialty: c.specialty,
          quantity: String(c.quantity),
          unitValue: c.unitValue?.toString() ?? '',
          originUnitId: c.originUnitId ?? '',
          notes: c.notes ?? '',
          used: c.used,
        })),
      );
  }, [cotas.data]);
  const opcoes = [
    ...(protocolos?.especialidades.map((e) => ({ kind: 'CONSULTA' as const, codigo: e.codigo, nome: `Consulta · ${e.nome}` })) ?? []),
    ...(protocolos?.procedimentos.map((p) => ({ kind: p.tipo, codigo: p.codigo, nome: `${p.tipo === 'EXAME' ? 'Exame' : 'Procedimento'} · ${p.nome}` })) ?? []),
  ];

  async function salvar() {
    setErro(null);
    for (const l of linhas) {
      if (!l.specialty) return setErro('Escolha a especialidade ou o procedimento de cada cota');
      if (!/^\d+$/.test(l.quantity) || Number(l.quantity) < 0) return setErro('Quantidade inválida');
    }
    setBusy(true);
    try {
      await api.put(`/regulacao/prestadores/${prestador.id}/cotas`, {
        competencia: comp,
        cotas: linhas.map((l) => ({
          id: l.id,
          kind: l.kind,
          specialty: l.specialty,
          quantity: Number(l.quantity),
          unitValue: l.unitValue ? Number(l.unitValue.replace(',', '.')) : null,
          originUnitId: l.originUnitId || null,
          notes: l.notes.trim() || null,
        })),
      });
      toast.success('Cotas salvas');
      await cotas.reload();
      onChanged();
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
      title={`Cotas · ${prestador.name}`}
      description="PPI por competência: quantidade pactuada por especialidade ou procedimento, valor unitário e, se for o caso, a unidade solicitante que tem a reserva"
      size="xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Fechar
          </Button>
          {podeGerir && (
            <Button onClick={salvar} loading={busy} id="cotas-salvar">
              Salvar cotas
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {erro && <Alert tone="error">{erro}</Alert>}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Competência" htmlFor="cotas-comp">
            <Input id="cotas-comp" type="month" value={comp} onChange={(e) => setComp(e.target.value || competencia)} />
          </Field>
          {podeGerir && (
            <Button variant="secondary" onClick={() => setLinhas((l) => [...l, { kind: 'CONSULTA', specialty: '', quantity: '0', unitValue: '', originUnitId: '', notes: '' }])} id="cotas-adicionar">
              <Plus className="h-4 w-4" /> Adicionar cota
            </Button>
          )}
          <span className="text-xs text-slate-500">
            Prazos das prioridades: {(Object.keys(PRIORIDADES) as (keyof typeof PRIORIDADES)[]).map((p) => `${PRIORIDADES[p].label} ${PRIORIDADES[p].prazoDias}d`).join(' · ')}
          </span>
        </div>
        {cotas.loading && !cotas.data && <Spinner />}
        {linhas.length === 0 && cotas.data && <p className="text-sm text-slate-500">Sem cotas nesta competência: as autorizações para este prestador não são limitadas.</p>}
        {linhas.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>Especialidade / procedimento</TH>
                <TH>Quantidade</TH>
                <TH>Valor unitário</TH>
                <TH>Reserva (PPI)</TH>
                <TH>Uso</TH>
                <TH></TH>
              </TR>
            </THead>
            <TBody>
              {linhas.map((l, i) => (
                <TR key={l.id ?? `n${i}`}>
                  <TD>
                    <Select
                      value={l.specialty ? `${l.kind}:${l.specialty}` : ''}
                      disabled={!podeGerir}
                      onChange={(e) => {
                        const [kind, specialty] = e.target.value.split(':') as [TipoSolicitacao, string];
                        setLinhas((x) => x.map((y, j) => (j === i ? { ...y, kind, specialty } : y)));
                      }}
                      className="min-w-56"
                    >
                      <option value="">Escolha…</option>
                      {opcoes.map((o) => (
                        <option key={`${o.kind}:${o.codigo}`} value={`${o.kind}:${o.codigo}`}>
                          {o.nome}
                        </option>
                      ))}
                    </Select>
                  </TD>
                  <TD>
                    <Input
                      inputMode="numeric"
                      value={l.quantity}
                      disabled={!podeGerir}
                      onChange={(e) => setLinhas((x) => x.map((y, j) => (j === i ? { ...y, quantity: e.target.value } : y)))}
                      className="w-24"
                      aria-label="Quantidade"
                    />
                  </TD>
                  <TD>
                    <Input
                      inputMode="decimal"
                      value={l.unitValue}
                      disabled={!podeGerir}
                      onChange={(e) => setLinhas((x) => x.map((y, j) => (j === i ? { ...y, unitValue: e.target.value } : y)))}
                      className="w-28"
                      aria-label="Valor unitário"
                    />
                  </TD>
                  <TD>
                    <Select value={l.originUnitId} disabled={!podeGerir} onChange={(e) => setLinhas((x) => x.map((y, j) => (j === i ? { ...y, originUnitId: e.target.value } : y)))} className="min-w-44">
                      <option value="">Todas as origens</option>
                      {unidades.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                  </TD>
                  <TD className="text-xs">{l.used !== undefined ? `${l.used}/${l.quantity}` : 'nova'}</TD>
                  <TD>
                    {podeGerir && (
                      <Button size="sm" variant="ghost" onClick={() => setLinhas((x) => x.filter((_, j) => j !== i))} aria-label="Remover cota">
                        ×
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </Dialog>
  );
}
