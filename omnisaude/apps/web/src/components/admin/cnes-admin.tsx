'use client';

import { UNIT_TYPE_LABELS, UNIT_TYPES, type UnitType } from '@omnisaude/shared';
import { Copy, Download, FileSpreadsheet, Globe, Upload, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime, formatCpf } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { AdminUnit } from './types';

interface EstablishmentRow {
  cnes: string;
  name: string;
  typeCode: string;
  typeLabel: string;
  suggestedType: UnitType | null;
  isPublic: boolean;
  susAmbulatory: boolean | null;
  address: string | null;
  phone: string | null;
  openingHours: string | null;
  active: boolean;
  existing: { id: string; name: string; type: string } | null;
  action: 'novo' | 'atualizar' | 'igual' | 'inativo';
  changes: string[];
  preselected: boolean;
}
interface EstablishmentPreview {
  importId: string;
  ibgeCode: string;
  summary: { total: number; publicos: number; privadosSus: number; novos: number; atualizar: number; iguais: number; inativos: number; foraDoCnes: number };
  rows: EstablishmentRow[];
  missing: { id: string; cnes: string; name: string }[];
}
interface ProfessionalRow {
  line: number;
  name: string;
  cpf: string | null;
  cbo: string;
  cboLabel: string | null;
  unitName: string | null;
  ine: string | null;
  teamFound: boolean;
  role: string | null;
  status: 'acesso' | 'existente' | 'pre_cadastro' | 'erro';
  errors: string[];
}
interface TeamRow {
  line: number;
  ine: string;
  typeLabel: string | null;
  name: string;
  unitName: string | null;
  status: 'nova' | 'atualizar' | 'erro';
  errors: string[];
}
interface CsvPreview<R> {
  importId: string;
  summary: Record<string, number>;
  rows: R[];
}
interface AccessResult {
  access: { name: string; cpf: string; provisionalPassword: string }[];
  linked: string[];
  staged: string[];
  warnings: string[];
  errors: string[];
}
interface Team {
  id: string;
  ine: string;
  name: string;
  typeLabel: string;
  unitName: string;
  area: string | null;
  members: number;
  active: boolean;
}
interface ImportLog {
  id: string;
  kind: string;
  status: string;
  ibgeCode: string | null;
  createdAt: string;
  summary: Record<string, unknown>;
}

const ACTION: Record<EstablishmentRow['action'], { label: string; tone: 'green' | 'blue' | 'slate' | 'amber' }> = {
  novo: { label: 'Nova', tone: 'green' },
  atualizar: { label: 'Completar', tone: 'blue' },
  igual: { label: 'Já cadastrada', tone: 'slate' },
  inativo: { label: 'Desativada no CNES', tone: 'amber' },
};
const PROF_STATUS: Record<ProfessionalRow['status'], { label: string; tone: 'green' | 'blue' | 'amber' | 'red' }> = {
  acesso: { label: 'Criar acesso', tone: 'green' },
  existente: { label: 'Já tem acesso: inclui lotação', tone: 'blue' },
  pre_cadastro: { label: 'Pré-cadastro (sem CPF)', tone: 'amber' },
  erro: { label: 'Erro', tone: 'red' },
};

function downloadText(fileName: string, content: string) {
  const url = URL.createObjectURL(new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Importação do CNES: estabelecimentos pela API do DATASUS; profissionais e equipes por planilha. */
export function CnesAdmin() {
  return (
    <div className="flex flex-col gap-4">
      <EstablishmentsImport />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TeamsImport />
        <ProfessionalsImport />
      </div>
      <ImportsHistory />
    </div>
  );
}

function EstablishmentsImport() {
  const toast = useToast();
  const session = useSession();
  const units = useApi<AdminUnit[]>('/admin/units');
  const [ibge, setIbge] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<EstablishmentPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Record<string, UnitType>>({});
  const [filter, setFilter] = useState<'publicos' | 'sus' | 'todos'>('publicos');
  const [updateNames, setUpdateNames] = useState(false);
  const [busy, setBusy] = useState(false);
  // Município da unidade em que a gestora está trabalhando (num consórcio, as unidades são de vários municípios).
  const ibgeValue = ibge || units.data?.find((u) => u.id === session.me?.context.unitId)?.ibgeCode || '';

  async function search() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const res = await api.post<EstablishmentPreview>('/admin/cnes/estabelecimentos/previa', { ibgeCode: ibgeValue.replace(/\D/g, '') });
      setPreview(res);
      setSelected(new Set(res.rows.filter((r) => r.preselected).map((r) => r.cnes)));
      setTypes({});
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyAll() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await api.post<{ created: string[]; updated: string[]; unchanged: string[] }>(`/admin/cnes/imports/${preview.importId}/aplicar`, { cnes: [...selected], types, updateNames });
      toast.success(`${res.created.length} unidade(s) criada(s), ${res.updated.length} completada(s)`);
      setPreview(null);
      await units.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const visible = preview?.rows.filter((r) => (filter === 'publicos' ? r.isPublic : filter === 'sus' ? r.isPublic || r.susAmbulatory : true)) ?? [];
  const toggle = (cnes: string, on: boolean) => setSelected((s) => {
    const n = new Set(s);
    if (on) n.add(cnes);
    else n.delete(cnes);
    return n;
  });
  const typeOf = (r: EstablishmentRow) => types[r.cnes] ?? r.suggestedType ?? '';
  const needsType = [...selected].some((c) => {
    const r = preview?.rows.find((x) => x.cnes === c);
    return r && !r.existing && !typeOf(r);
  });

  return (
    <Card>
      <CardHeader
        title="Estabelecimentos do CNES"
        description="Busca no Cadastro Nacional (DATASUS) todos os estabelecimentos do município e compara com as unidades cadastradas. Nada é alterado antes de você aplicar."
      />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Código IBGE do município" htmlFor="cnes-ibge" hint="6 ou 7 dígitos (Gurupi: 1709500)">
            <Input id="cnes-ibge" inputMode="numeric" maxLength={7} value={ibgeValue} onChange={(e) => setIbge(e.target.value.replace(/\D/g, ''))} className="w-44" />
          </Field>
          <Button loading={busy} disabled={!/^\d{6,7}$/.test(ibgeValue)} onClick={search}>
            <Globe className="h-4 w-4" /> Buscar no CNES
          </Button>
          {busy && <span className="text-sm text-slate-500">Consultando o DATASUS… em cidades grandes pode levar um minuto.</span>}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        {preview && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="slate">{preview.summary.total} no CNES</Badge>
              <Badge tone="green">{preview.summary.novos} novas</Badge>
              <Badge tone="blue">{preview.summary.atualizar} a completar</Badge>
              <Badge tone="slate">{preview.summary.iguais} iguais</Badge>
              <Badge tone="amber">{preview.summary.inativos} desativadas</Badge>
              <span className="mx-2 text-slate-300">|</span>
              {(['publicos', 'sus', 'todos'] as const).map((f) => (
                <Button key={f} size="sm" variant={filter === f ? 'primary' : 'secondary'} onClick={() => setFilter(f)}>
                  {f === 'publicos' ? `Públicos (${preview.summary.publicos})` : f === 'sus' ? `Públicos + privados SUS (${preview.summary.publicos + preview.summary.privadosSus})` : `Todos (${preview.summary.total})`}
                </Button>
              ))}
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <Table>
                <THead>
                  <TR>
                    <TH>
                      <input
                        type="checkbox"
                        aria-label="Selecionar visíveis"
                        checked={visible.filter((r) => r.action === 'novo' || r.action === 'atualizar').every((r) => selected.has(r.cnes)) && visible.length > 0}
                        onChange={(e) => setSelected(new Set(e.target.checked ? visible.filter((r) => r.action === 'novo' || r.action === 'atualizar').map((r) => r.cnes) : []))}
                      />
                    </TH>
                    <TH>CNES</TH>
                    <TH>Estabelecimento</TH>
                    <TH>Tipo no CNES</TH>
                    <TH>Tipo no OmniSaúde</TH>
                    <TH>Situação</TH>
                  </TR>
                </THead>
                <TBody>
                  {visible.map((r) => {
                    const selectable = r.action === 'novo' || r.action === 'atualizar';
                    return (
                      <TR key={r.cnes} className={!r.isPublic ? 'text-slate-500' : undefined}>
                        <TD>
                          <input type="checkbox" aria-label={`Selecionar ${r.name}`} disabled={!selectable} checked={selected.has(r.cnes)} onChange={(e) => toggle(r.cnes, e.target.checked)} />
                        </TD>
                        <TD className="font-mono text-xs">{r.cnes}</TD>
                        <TD>
                          <p className="font-medium">{r.name}</p>
                          <p className="text-xs text-slate-500">
                            {r.isPublic ? 'Público' : r.susAmbulatory ? 'Privado, atende SUS' : 'Privado'}
                            {r.openingHours ? ` · ${r.openingHours}` : ''}
                            {r.phone ? ` · ${r.phone}` : ''}
                          </p>
                          {r.address && <p className="text-xs text-slate-400">{r.address}</p>}
                        </TD>
                        <TD className="text-sm">{r.typeLabel}</TD>
                        <TD>
                          {r.existing ? (
                            <span className="text-sm">{UNIT_TYPE_LABELS[r.existing.type as UnitType] ?? r.existing.type}</span>
                          ) : selectable ? (
                            <Select aria-label={`Tipo de ${r.name}`} value={typeOf(r)} onChange={(e) => setTypes((t) => ({ ...t, [r.cnes]: e.target.value as UnitType }))} className={!typeOf(r) && selected.has(r.cnes) ? 'border-amber-400' : undefined}>
                              <option value="">Escolher…</option>
                              {UNIT_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {UNIT_TYPE_LABELS[t]}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <span className="text-sm text-slate-400">—</span>
                          )}
                        </TD>
                        <TD>
                          <Badge tone={ACTION[r.action].tone}>{ACTION[r.action].label}</Badge>
                          {r.action === 'atualizar' && <p className="mt-1 text-xs text-slate-500">Preenche: {r.changes.join(', ')}</p>}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            {preview.missing.length > 0 && (
              <Alert tone="warn" title={`${preview.missing.length} unidade(s) cadastrada(s) não constam no CNES deste município`}>
                {preview.missing.map((m) => `${m.name} (${m.cnes})`).join(' · ')}. Confira o CNES ou desative-as em Unidades.
              </Alert>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={updateNames} onChange={(e) => setUpdateNames(e.target.checked)} /> Substituir os nomes das unidades já cadastradas pelos do CNES
              </label>
              <div className="flex items-center gap-3">
                {needsType && <span className="text-sm text-amber-700">Escolha o tipo das unidades marcadas em laranja.</span>}
                <Button loading={busy} disabled={selected.size === 0 || needsType} onClick={applyAll}>
                  Aplicar {selected.size} selecionada(s)
                </Button>
              </div>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function CsvDropzone({ onText, label }: { onText: (text: string) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".csv,.txt,text/csv"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) onText(await f.text());
          e.target.value = '';
        }}
      />
      <Button variant="secondary" onClick={() => ref.current?.click()}>
        <Upload className="h-4 w-4" /> {label}
      </Button>
    </>
  );
}

function TeamsImport() {
  const toast = useToast();
  const teams = useApi<Team[]>('/admin/teams');
  const [preview, setPreview] = useState<CsvPreview<TeamRow> | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(text: string) {
    setBusy(true);
    try {
      setPreview(await api.post<CsvPreview<TeamRow>>('/admin/cnes/equipes/previa', { csv: text }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function applyAll() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await api.post<{ created: string[]; updated: string[] }>(`/admin/cnes/imports/${preview.importId}/aplicar`, {});
      toast.success(`${res.created.length} equipe(s) criada(s), ${res.updated.length} atualizada(s)`);
      setPreview(null);
      await teams.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Equipes (INE)"
        description="Equipes de Saúde da Família, Saúde Bucal, eMulti e outras, com o Identificador Nacional de Equipe. Planilha com colunas ine, tipo, nome, cnes e area."
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={async () => downloadText(...(Object.values(await api.get<{ fileName: string; content: string }>('/admin/cnes/modelos/equipes')) as [string, string]))}>
              <Download className="h-4 w-4" /> Modelo
            </Button>
            <CsvDropzone label="Enviar planilha" onText={load} />
          </div>
        }
      />
      <CardBody className="flex flex-col gap-3">
        {busy && <Spinner className="py-2" />}
        {preview && (
          <>
            <p className="text-sm text-slate-600">
              {preview.summary.novas} nova(s), {preview.summary.atualizar} a atualizar, {preview.summary.erros} com erro.
            </p>
            <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
              <Table>
                <THead>
                  <TR>
                    <TH>Linha</TH>
                    <TH>INE</TH>
                    <TH>Equipe</TH>
                    <TH>Unidade</TH>
                    <TH>Situação</TH>
                  </TR>
                </THead>
                <TBody>
                  {preview.rows.map((r) => (
                    <TR key={r.line}>
                      <TD className="text-xs text-slate-500">{r.line}</TD>
                      <TD className="font-mono text-xs">{r.ine}</TD>
                      <TD>
                        <p className="text-sm font-medium">{r.name || '—'}</p>
                        <p className="text-xs text-slate-500">{r.typeLabel ?? ''}</p>
                      </TD>
                      <TD className="text-sm">{r.unitName ?? '—'}</TD>
                      <TD>{r.status === 'erro' ? <span className="text-xs text-red-700">{r.errors.join('; ')}</span> : <Badge tone={r.status === 'nova' ? 'green' : 'blue'}>{r.status === 'nova' ? 'Nova' : 'Atualizar'}</Badge>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPreview(null)}>
                Descartar
              </Button>
              <Button loading={busy} disabled={preview.summary.novas + preview.summary.atualizar === 0} onClick={applyAll}>
                Aplicar
              </Button>
            </div>
          </>
        )}
        {!preview &&
          (teams.data?.length ? (
            <div className="max-h-72 overflow-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>INE</TH>
                    <TH>Equipe</TH>
                    <TH>Unidade</TH>
                    <TH>Membros</TH>
                  </TR>
                </THead>
                <TBody>
                  {teams.data.map((t) => (
                    <TR key={t.id}>
                      <TD className="font-mono text-xs">{t.ine}</TD>
                      <TD>
                        <p className="text-sm font-medium">{t.name}</p>
                        <p className="text-xs text-slate-500">
                          {t.typeLabel}
                          {t.area ? ` · área ${t.area}` : ''}
                        </p>
                      </TD>
                      <TD className="text-sm">{t.unitName}</TD>
                      <TD>{t.members}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Nenhuma equipe cadastrada" description="Envie a planilha de equipes do CNES do município." icon={<Users className="h-6 w-6" />} />
          ))}
      </CardBody>
    </Card>
  );
}

function ProfessionalsImport() {
  const toast = useToast();
  const [preview, setPreview] = useState<CsvPreview<ProfessionalRow> | null>(null);
  const [createAccess, setCreateAccess] = useState(true);
  const [result, setResult] = useState<AccessResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(text: string) {
    setBusy(true);
    try {
      setPreview(await api.post<CsvPreview<ProfessionalRow>>('/admin/cnes/profissionais/previa', { csv: text }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function applyAll() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await api.post<AccessResult>(`/admin/cnes/imports/${preview.importId}/aplicar`, { createAccess });
      setResult(res);
      setPreview(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const accessCsv = () => ['nome;cpf;senha_provisoria', ...(result?.access.map((a) => `${a.name};${formatCpf(a.cpf)};${a.provisionalPassword}`) ?? [])].join('\n');

  return (
    <Card>
      <CardHeader
        title="Profissionais por planilha"
        description="Colunas nome, cbo e cnes (obrigatórias); cpf, cns, ine, papel, conselho, email e telefone (opcionais). Quem tem CPF ganha acesso com senha provisória; sem CPF fica como pré-cadastro para completar depois."
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={async () => downloadText(...(Object.values(await api.get<{ fileName: string; content: string }>('/admin/cnes/modelos/profissionais')) as [string, string]))}>
              <Download className="h-4 w-4" /> Modelo
            </Button>
            <CsvDropzone label="Enviar planilha" onText={load} />
          </div>
        }
      />
      <CardBody className="flex flex-col gap-3">
        {busy && <Spinner className="py-2" />}
        {!preview && !busy && <EmptyState title="Nenhuma planilha carregada" description="Baixe o modelo, preencha com os profissionais do CNES e envie." icon={<FileSpreadsheet className="h-6 w-6" />} />}
        {preview && (
          <>
            <p className="text-sm text-slate-600">
              {preview.summary.acessos} acesso(s) a criar, {preview.summary.existentes} lotação(ões) em quem já tem acesso, {preview.summary.preCadastro} pré-cadastro(s), {preview.summary.erros} com erro
              {preview.summary.semEquipe ? `, ${preview.summary.semEquipe} com equipe ainda não cadastrada` : ''}.
            </p>
            <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
              <Table>
                <THead>
                  <TR>
                    <TH>Linha</TH>
                    <TH>Profissional</TH>
                    <TH>Lotação</TH>
                    <TH>Situação</TH>
                  </TR>
                </THead>
                <TBody>
                  {preview.rows.map((r) => (
                    <TR key={r.line}>
                      <TD className="text-xs text-slate-500">{r.line}</TD>
                      <TD>
                        <p className="text-sm font-medium">{r.name}</p>
                        <p className="text-xs text-slate-500">{r.cpf ? `CPF ${formatCpf(r.cpf)}` : 'sem CPF'}</p>
                      </TD>
                      <TD className="text-sm">
                        {r.unitName ?? '—'} · {r.role ?? '—'}
                        <p className="text-xs text-slate-500">
                          CBO {r.cbo}
                          {r.cboLabel ? ` ${r.cboLabel}` : ''}
                          {r.ine ? ` · INE ${r.ine}${r.teamFound ? '' : ' (equipe não cadastrada)'}` : ''}
                        </p>
                      </TD>
                      <TD>
                        <Badge tone={PROF_STATUS[r.status].tone}>{PROF_STATUS[r.status].label}</Badge>
                        {r.errors.length > 0 && <p className="mt-1 text-xs text-red-700">{r.errors.join('; ')}</p>}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={createAccess} onChange={(e) => setCreateAccess(e.target.checked)} /> Criar acessos (senha provisória) para quem tem CPF
              </label>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setPreview(null)}>
                  Descartar
                </Button>
                <Button loading={busy} disabled={preview.rows.every((r) => r.status === 'erro')} onClick={applyAll}>
                  Aplicar
                </Button>
              </div>
            </div>
          </>
        )}
      </CardBody>
      <Dialog open={!!result} onOpenChange={(o) => !o && setResult(null)} title="Planilha aplicada" size="lg">
        {result && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-700">
              {result.access.length} acesso(s) criado(s), {result.linked.length} profissional(is) já existente(s) com lotação incluída, {result.staged.length} pré-cadastro(s).
            </p>
            {result.access.length > 0 && (
              <>
                <Alert tone="warn" title="Senhas provisórias: mostradas uma única vez">
                  Entregue a cada profissional a senha abaixo. Ela precisa ser trocada no primeiro acesso.
                </Alert>
                <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Profissional</TH>
                        <TH>CPF</TH>
                        <TH>Senha provisória</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {result.access.map((a) => (
                        <TR key={a.cpf}>
                          <TD className="text-sm">{a.name}</TD>
                          <TD className="font-mono text-xs">{formatCpf(a.cpf)}</TD>
                          <TD className="font-mono">{a.provisionalPassword}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => downloadText('acessos-provisorios.csv', accessCsv())}>
                    <Download className="h-4 w-4" /> Baixar CSV
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(accessCsv());
                        toast.success('Lista copiada');
                      } catch {
                        toast.error('Não foi possível copiar');
                      }
                    }}
                  >
                    <Copy className="h-4 w-4" /> Copiar
                  </Button>
                </div>
              </>
            )}
            {result.warnings.length > 0 && <Alert tone="info" title="Avisos">{result.warnings.join(' · ')}</Alert>}
            {result.errors.length > 0 && <Alert tone="error" title="Linhas não importadas">{result.errors.join(' · ')}</Alert>}
          </div>
        )}
      </Dialog>
    </Card>
  );
}

function ImportsHistory() {
  const { data } = useApi<ImportLog[]>('/admin/cnes/imports');
  if (!data?.length) return null;
  return (
    <Card>
      <CardHeader title="Histórico de importações" />
      <CardBody className="p-0">
        <Table>
          <THead>
            <TR>
              <TH>Quando</TH>
              <TH>Tipo</TH>
              <TH>Situação</TH>
              <TH>Resumo</TH>
            </TR>
          </THead>
          <TBody>
            {data.map((i) => (
              <TR key={i.id}>
                <TD className="text-sm">{fmtDateTime(i.createdAt)}</TD>
                <TD className="text-sm">
                  {i.kind === 'ESTABELECIMENTOS' ? `Estabelecimentos (IBGE ${i.ibgeCode})` : i.kind === 'PROFISSIONAIS' ? 'Profissionais (planilha)' : 'Equipes (planilha)'}
                </TD>
                <TD>
                  <Badge tone={i.status === 'APLICADA' ? 'green' : 'slate'}>{i.status === 'APLICADA' ? 'Aplicada' : 'Prévia'}</Badge>
                </TD>
                <TD className="text-xs text-slate-600">
                  {Object.entries(i.summary)
                    .filter(([, v]) => typeof v === 'number')
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(' · ')}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}
