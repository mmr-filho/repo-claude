'use client';

import { PRAZO_ENCERRAMENTO_AGUDOS, PRAZOS_ENCERRAMENTO_REFERENCIA, MODELO_POLICIAL_PADRAO } from '@omnisaude/shared';
import { CheckCheck, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { CondicaoCatalogo, MapaCodigo, RotaSistema, VersaoCatalogo } from './types';

const ESCOPO: Record<string, string> = { NACIONAL: 'Nacional', ESTADUAL: 'Estadual', MUNICIPAL: 'Municipal' };
const marcas = (c: { immediateMs: boolean; immediateSes: boolean; immediateSms: boolean; weekly: boolean }) =>
  c.weekly ? 'Semanal' : `Imediata · ${[c.immediateMs && 'MS', c.immediateSes && 'SES', c.immediateSms && 'SMS'].filter(Boolean).join(', ')}`;

/** Versões da Lista Nacional de Notificação Compulsória e complementos estadual e municipal. */
export function CatalogoTab({ podeGerir }: { podeGerir: boolean }) {
  const toast = useToast();
  const versoes = useApi<VersaoCatalogo[]>('/vigilancia/catalogo/versoes');
  const [sel, setSel] = useState<string | null>(null);
  const atual = sel ?? versoes.data?.find((v) => v.vigente && v.escopo === 'NACIONAL')?.id ?? null;
  const linhas = useApi<CondicaoCatalogo[]>(atual ? `/vigilancia/catalogo/versoes/${atual}` : null, [atual]);
  const [nova, setNova] = useState(false);
  const [form, setForm] = useState({ scope: 'MUNICIPAL', act: '', validFrom: todayIso(), validTo: '', notes: '', name: '', item: '100', periodicidade: 'SEMANAL', sensitive: false });
  const [busy, setBusy] = useState(false);
  const v = versoes.data?.find((x) => x.id === atual);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]">
      <Card>
        <CardHeader
          title="Versões"
          actions={
            podeGerir ? (
              <Button size="sm" variant="secondary" onClick={() => setNova(true)} id="vig-versao-nova">
                <Plus className="h-4 w-4" /> Lista local
              </Button>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          {versoes.loading && !versoes.data && <Spinner />}
          <ul className="divide-y divide-slate-100">
            {versoes.data?.map((x) => (
              <li key={x.id}>
                <button type="button" onClick={() => setSel(x.id)} className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-slate-50 ${atual === x.id ? 'bg-brand-50' : ''}`}>
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {ESCOPO[x.escopo]} {x.uf ?? x.ibgeCode ?? ''} {x.vigente ? <Badge tone="green">Vigente</Badge> : <Badge tone="slate">Histórica</Badge>}
                  </span>
                  <span className="text-xs text-slate-600">{x.ato}</span>
                  <span className="text-xs text-slate-500">
                    de {fmtDate(x.vigenteDe)}
                    {x.vigenteAte ? ` até ${fmtDate(x.vigenteAte)}` : ''} · {x.linhas} linhas
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title={v ? v.ato : 'Linhas da lista'}
          description={v ? [v.publicacao, v.consultadoEm ? `conferido em ${fmtDate(v.consultadoEm)}` : null, v.hashFonte ? `SHA-256 da fonte ${v.hashFonte.slice(0, 12)}…` : null].filter(Boolean).join(' · ') : undefined}
        />
        <CardBody className="p-0">
          {v?.notas && (
            <div className="p-4">
              <Alert tone="info">{v.notas}</Alert>
            </div>
          )}
          {linhas.loading && !linhas.data && <Spinner />}
          {linhas.data && (
            <Table>
              <THead>
                <TR>
                  <TH>Item</TH>
                  <TH>Agravo</TH>
                  <TH>Prazo</TH>
                  <TH>Critério</TH>
                  <TH>Observações</TH>
                </TR>
              </THead>
              <TBody>
                {linhas.data.map((c) => (
                  <TR key={c.id}>
                    <TD className="whitespace-nowrap text-sm">
                      {c.item}
                      {c.subitem ?? ''}
                    </TD>
                    <TD className="text-sm">{c.name}</TD>
                    <TD className="whitespace-nowrap text-xs">
                      <Badge tone={c.weekly ? 'amber' : 'red'}>{marcas(c)}</Badge>
                    </TD>
                    <TD className="text-xs">{c.notifyOn === 'CONFIRMACAO' ? 'Confirmação' : 'Suspeita'}</TD>
                    <TD className="text-xs">
                      {c.sensitive && <Badge tone="violet">Sigiloso</Badge>} {c.once && <Badge tone="slate">Uma vez por pessoa</Badge>} {c.normativeStatus === 'EM_REVISAO' && <Badge tone="amber">Em revisão</Badge>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
      <Dialog
        open={nova}
        onOpenChange={setNova}
        title="Nova lista estadual ou municipal"
        description="Acrescenta agravos à lista nacional na unidade federada ou no município (art. 2º, Anexo V). Para mais de um agravo, cadastre a versão e peça o complemento ao suporte."
        footer={
          <Button
            loading={busy}
            disabled={form.act.trim().length < 5 || form.name.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                const imediata = form.periodicidade === 'IMEDIATA';
                // Prefixo local: a lista local só acrescenta agravos, nunca substitui uma chave nacional.
                const slug = form.name
                  .normalize('NFD')
                  .replace(/[\u0300-\u036f]/g, '')
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-|-$/g, '')
                  .slice(0, 55);
                const key = `${form.scope === 'MUNICIPAL' ? 'mun' : 'est'}-${slug}`;
                await api.post('/vigilancia/catalogo/versoes', {
                  scope: form.scope,
                  act: form.act,
                  validFrom: form.validFrom,
                  validTo: form.validTo || null,
                  notes: form.notes || null,
                  conditions: [{ key, item: Number(form.item), name: form.name, immediateMs: false, immediateSes: false, immediateSms: imediata, weekly: !imediata, sensitive: form.sensitive }],
                });
                toast.success('Lista local cadastrada.');
                setNova(false);
                await versoes.reload();
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Cadastrar
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Escopo" htmlFor="ll-escopo">
            <Select id="ll-escopo" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              <option value="MUNICIPAL">Municipal</option>
              <option value="ESTADUAL">Estadual</option>
            </Select>
          </Field>
          <Field label="Ato normativo" htmlFor="ll-ato">
            <Input id="ll-ato" value={form.act} onChange={(e) => setForm({ ...form, act: e.target.value })} placeholder="Portaria SMS nº …/2026" />
          </Field>
          <Field label="Vigente a partir de" htmlFor="ll-de">
            <Input id="ll-de" type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
          </Field>
          <Field label="Vigente até (opcional)" htmlFor="ll-ate">
            <Input id="ll-ate" type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
          </Field>
          <Field label="Agravo" htmlFor="ll-nome" className="sm:col-span-2">
            <Input id="ll-nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Nº do item na lista local" htmlFor="ll-item">
            <Input id="ll-item" type="number" min={1} value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} />
          </Field>
          <Field label="Periodicidade" htmlFor="ll-per">
            <Select id="ll-per" value={form.periodicidade} onChange={(e) => setForm({ ...form, periodicidade: e.target.value })}>
              <option value="SEMANAL">Semanal (7 dias)</option>
              <option value="IMEDIATA">Imediata para a SMS (24 h)</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.sensitive} onChange={(e) => setForm({ ...form, sensitive: e.target.checked })} /> Agravo sigiloso
          </label>
          <Field label="Notas" htmlFor="ll-notas" className="sm:col-span-2">
            <Textarea id="ll-notas" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

/** De-para CID-10/CIAP-2 → agravo: o que dispara o rascunho; propostos aguardam homologação da vigilância. */
export function CodigosTab({ podeGerir }: { podeGerir: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState('PROPOSTO');
  const [busca, setBusca] = useState('');
  const lista = useApi<MapaCodigo[]>(`/vigilancia/codigos?${new URLSearchParams({ ...(status ? { status } : {}), ...(busca ? { busca } : {}) })}`, [status, busca]);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [novo, setNovo] = useState<{ system: string; codePrefix: string; groupKey: string; source: string } | null>(null);
  const alternar = (id: string) =>
    setMarcados((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Card>
      <CardHeader
        title="De-para de códigos"
        description="Código CID-10 ou CIAP-2 (prefixo) que abre o rascunho de um agravo. O rascunho de mapeamento proposto mostra o aviso “não homologado”."
        actions={
          <div className="flex flex-wrap gap-2">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação do mapeamento">
              <option value="PROPOSTO">Propostos</option>
              <option value="HOMOLOGADO">Homologados</option>
              <option value="INATIVO">Inativos</option>
              <option value="">Todos</option>
            </Select>
            <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Código ou agravo" aria-label="Buscar código" className="w-40" />
            {podeGerir && (
              <>
                <Button
                  size="sm"
                  disabled={marcados.size === 0}
                  id="vig-homologar"
                  onClick={async () => {
                    try {
                      const r = await api.post<{ homologados: number }>('/vigilancia/codigos/homologar', { ids: [...marcados] });
                      toast.success(`${r.homologados} mapeamento(s) homologado(s).`);
                      setMarcados(new Set());
                      await lista.reload();
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  <CheckCheck className="h-4 w-4" /> Homologar {marcados.size || ''}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setNovo({ system: 'CID10', codePrefix: '', groupKey: '', source: '' })}>
                  <Plus className="h-4 w-4" /> Código
                </Button>
              </>
            )}
          </div>
        }
      />
      <CardBody className="p-0">
        {lista.loading && !lista.data && <Spinner />}
        {lista.data?.length === 0 && <EmptyState title="Nenhum mapeamento" />}
        {lista.data && lista.data.length > 0 && (
          <Table>
            <THead>
              <TR>
                {podeGerir && <TH className="w-8" />}
                <TH>Código</TH>
                <TH>Agravo (grupo)</TH>
                <TH>Situação</TH>
                <TH>Fonte</TH>
                {podeGerir && <TH />}
              </TR>
            </THead>
            <TBody>
              {lista.data.map((m) => (
                <TR key={m.id}>
                  {podeGerir && <TD>{m.status === 'PROPOSTO' && <input type="checkbox" aria-label={`Marcar ${m.codePrefix}`} checked={marcados.has(m.id)} onChange={() => alternar(m.id)} />}</TD>}
                  <TD className="whitespace-nowrap font-mono text-sm">
                    {m.system === 'CIAP2' ? 'CIAP-2 ' : ''}
                    {m.codePrefix}
                  </TD>
                  <TD className="text-sm">
                    {m.groupKey}
                    {m.context ? <span className="text-xs text-slate-500"> · {m.context}</span> : null}
                  </TD>
                  <TD>
                    <Badge tone={m.status === 'HOMOLOGADO' ? 'green' : m.status === 'PROPOSTO' ? 'amber' : 'slate'}>{m.status === 'HOMOLOGADO' ? 'Homologado' : m.status === 'PROPOSTO' ? 'Proposto' : 'Inativo'}</Badge>
                  </TD>
                  <TD className="max-w-xs truncate text-xs text-slate-500" title={m.source}>
                    {m.source}
                  </TD>
                  {podeGerir && (
                    <TD>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await api.patch(`/vigilancia/codigos/${m.id}`, { status: m.status === 'INATIVO' ? 'PROPOSTO' : 'INATIVO' });
                            await lista.reload();
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      >
                        {m.status === 'INATIVO' ? 'Reativar' : 'Inativar'}
                      </Button>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardBody>
      <Dialog
        open={!!novo}
        onOpenChange={(o) => !o && setNovo(null)}
        title="Novo mapeamento de código"
        description="Entra como proposto; passa a abrir o rascunho já com o aviso até ser homologado."
        footer={
          <Button
            disabled={!novo || novo.codePrefix.trim().length < 1 || novo.groupKey.trim().length < 2 || novo.source.trim().length < 3}
            onClick={async () => {
              if (!novo) return;
              try {
                await api.post('/vigilancia/codigos', novo);
                toast.success('Mapeamento proposto.');
                setNovo(null);
                setStatus('PROPOSTO');
                await lista.reload();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            Salvar
          </Button>
        }
      >
        {novo && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Classificação" htmlFor="map-sis">
              <Select id="map-sis" value={novo.system} onChange={(e) => setNovo({ ...novo, system: e.target.value })}>
                <option value="CID10">CID-10</option>
                <option value="CIAP2">CIAP-2</option>
              </Select>
            </Field>
            <Field label="Código ou prefixo" htmlFor="map-cod">
              <Input id="map-cod" value={novo.codePrefix} onChange={(e) => setNovo({ ...novo, codePrefix: e.target.value })} placeholder="Ex.: A92.8" />
            </Field>
            <Field label="Grupo do agravo" htmlFor="map-grupo" hint="Chave do grupo no catálogo, ex.: dengue, zika, violencia" className="sm:col-span-2">
              <Input id="map-grupo" value={novo.groupKey} onChange={(e) => setNovo({ ...novo, groupKey: e.target.value })} />
            </Field>
            <Field label="Fonte (guia, nota técnica)" htmlFor="map-fonte" className="sm:col-span-2">
              <Input id="map-fonte" value={novo.source} onChange={(e) => setNovo({ ...novo, source: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

interface Configuracoes {
  ackMinutes: number;
  onCallPhones: string[];
  whatsappAlerts: boolean;
  whatsappEnabled: boolean;
  relEnabled: boolean;
  prazosEncerramento: Record<string, number>;
  modeloPolicial: string | null;
}
interface ContatoLinha {
  id: string;
  sphere: 'SMS' | 'SES' | 'MS';
  label: string;
  phone: string | null;
  email: string | null;
  formUrl: string | null;
  hours: string | null;
  onCall: boolean;
  active: boolean;
  sort: number;
}

/** Plantão (escalonamento por WhatsApp sem dado do paciente) e agenda de contatos das três esferas. */
export function PlantaoTab() {
  const toast = useToast();
  const cfg = useApi<Configuracoes>('/vigilancia/configuracoes');
  const contatos = useApi<ContatoLinha[]>('/vigilancia/contatos');
  const [form, setForm] = useState<{ ackMinutes: string; telefones: string; whatsappAlerts: boolean } | null>(null);
  const [contato, setContato] = useState<(Omit<ContatoLinha, 'id'> & { id: string | null }) | null>(null);
  const f = form ?? (cfg.data ? { ackMinutes: String(cfg.data.ackMinutes), telefones: cfg.data.onCallPhones.join('\n'), whatsappAlerts: cfg.data.whatsappAlerts } : null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Plantão e escalonamento" description="Notificação imediata confirmada sem ciência da vigilância no tempo abaixo é escalada ao plantão." />
        <CardBody className="flex flex-col gap-3">
          {!f && <Spinner />}
          {f && (
            <>
              {cfg.data && !cfg.data.whatsappEnabled && <Alert tone="warn">O WhatsApp está desligado nesta instituição: o escalonamento aparece só no painel.</Alert>}
              <Field label="Minutos para a ciência antes de escalar" htmlFor="cfg-ack">
                <Input id="cfg-ack" type="number" min={5} max={720} value={f.ackMinutes} onChange={(e) => setForm({ ...f, ackMinutes: e.target.value })} />
              </Field>
              <Field label="Celulares do plantão (um por linha)" htmlFor="cfg-tel" hint="Recebem o modelo “vigilancia_alerta”: número da notificação, agravo e unidade, sem nome nem documento do paciente.">
                <Textarea id="cfg-tel" rows={3} value={f.telefones} onChange={(e) => setForm({ ...f, telefones: e.target.value })} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.whatsappAlerts} onChange={(e) => setForm({ ...f, whatsappAlerts: e.target.checked })} /> Enviar o alerta por WhatsApp
              </label>
              <div>
                <Button
                  onClick={async () => {
                    try {
                      await api.patch('/vigilancia/configuracoes', {
                        ackMinutes: Number(f.ackMinutes),
                        onCallPhones: f.telefones
                          .split(/\n|,/)
                          .map((t) => t.trim())
                          .filter(Boolean),
                        whatsappAlerts: f.whatsappAlerts,
                      });
                      toast.success('Plantão atualizado.');
                      setForm(null);
                      await cfg.reload();
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  Salvar
                </Button>
              </div>
            </>
          )}
        </CardBody>
      </Card>
      <EnvioEncerramento cfg={cfg.data ?? null} onSaved={() => cfg.reload()} />
      <Card>
        <CardHeader
          title="Contatos das esferas"
          description="Usados no registro de comunicação. O CIEVS Nacional vem cadastrado; inclua a vigilância municipal e o CIEVS estadual."
          actions={
            <Button size="sm" variant="secondary" onClick={() => setContato({ id: null, sphere: 'SES', label: '', phone: '', email: '', formUrl: '', hours: '', onCall: false, active: true, sort: 0 })}>
              <Plus className="h-4 w-4" /> Contato
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-2 text-sm">
          {contatos.data?.map((c) => (
            <button key={c.id} type="button" className="rounded border border-slate-200 p-2 text-left hover:bg-slate-50" onClick={() => setContato({ ...c })}>
              <p className="font-medium">
                {c.sphere} · {c.label} {c.onCall && <Badge tone="blue">Plantão</Badge>} {!c.active && <Badge tone="slate">Inativo</Badge>}
              </p>
              <p className="text-xs text-slate-600">{[c.phone, c.email, c.hours].filter(Boolean).join(' · ')}</p>
            </button>
          ))}
        </CardBody>
      </Card>
      <Dialog
        open={!!contato}
        onOpenChange={(o) => !o && setContato(null)}
        title={contato?.id ? 'Editar contato' : 'Novo contato'}
        footer={
          <Button
            disabled={!contato || contato.label.trim().length < 2}
            onClick={async () => {
              if (!contato) return;
              const body = {
                sphere: contato.sphere,
                label: contato.label,
                phone: contato.phone || null,
                email: contato.email || null,
                formUrl: contato.formUrl || null,
                hours: contato.hours || null,
                onCall: contato.onCall,
                active: contato.active,
                sort: contato.sort,
              };
              try {
                if (contato.id) await api.put(`/vigilancia/contatos/${contato.id}`, body);
                else await api.post('/vigilancia/contatos', body);
                toast.success('Contato salvo.');
                setContato(null);
                await contatos.reload();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            Salvar
          </Button>
        }
      >
        {contato && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Esfera" htmlFor="ct-esfera">
              <Select id="ct-esfera" value={contato.sphere} onChange={(e) => setContato({ ...contato, sphere: e.target.value as ContatoLinha['sphere'] })}>
                <option value="SMS">SMS (municipal)</option>
                <option value="SES">SES (estadual)</option>
                <option value="MS">MS (nacional)</option>
              </Select>
            </Field>
            <Field label="Nome" htmlFor="ct-nome">
              <Input id="ct-nome" value={contato.label} onChange={(e) => setContato({ ...contato, label: e.target.value })} />
            </Field>
            <Field label="Telefone" htmlFor="ct-tel">
              <Input id="ct-tel" value={contato.phone ?? ''} onChange={(e) => setContato({ ...contato, phone: e.target.value })} />
            </Field>
            <Field label="E-mail" htmlFor="ct-email">
              <Input id="ct-email" type="email" value={contato.email ?? ''} onChange={(e) => setContato({ ...contato, email: e.target.value })} />
            </Field>
            <Field label="Formulário (endereço)" htmlFor="ct-form">
              <Input id="ct-form" value={contato.formUrl ?? ''} onChange={(e) => setContato({ ...contato, formUrl: e.target.value })} />
            </Field>
            <Field label="Horário" htmlFor="ct-hora">
              <Input id="ct-hora" value={contato.hours ?? ''} onChange={(e) => setContato({ ...contato, hours: e.target.value })} placeholder="24 horas" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={contato.onCall} onChange={(e) => setContato({ ...contato, onCall: e.target.checked })} /> Plantão
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={contato.active} onChange={(e) => setContato({ ...contato, active: e.target.checked })} /> Ativo
            </label>
          </div>
        )}
      </Dialog>
    </div>
  );
}

/** REL de covid-19 e mpox, prazos de encerramento por agravo e modelo da comunicação policial. */
function EnvioEncerramento({ cfg, onSaved }: { cfg: Configuracoes | null; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<{ rel: boolean; prazos: string; modelo: string } | null>(null);
  const linhas = (p: Record<string, number>) =>
    Object.entries(p)
      .map(([g, d]) => `${g}=${d}`)
      .join('\n');
  const f = form ?? (cfg ? { rel: cfg.relEnabled, prazos: linhas(cfg.prazosEncerramento), modelo: cfg.modeloPolicial ?? MODELO_POLICIAL_PADRAO } : null);
  if (!f) return <Spinner />;
  return (
    <Card className="lg:col-span-2" id="vig-envio-encerramento">
      <CardHeader title="Envio, encerramento e comunicação policial" />
      <CardBody className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.rel} onChange={(e) => setForm({ ...f, rel: e.target.checked })} id="cfg-rel" /> Enviar à RNDS os resultados de covid-19 e mpox (REL)
          </label>
          <p className="text-xs text-slate-500">
            Todo resultado (positivo, negativo ou inconclusivo) em até 24 h (Anexo V da PRC GM/MS nº 4/2017, arts. 22 a 26). Deixe desligado se a rede não faz esses testes. Exige a RNDS ligada e credenciada.
          </p>
        </div>
        <Field label="Prazos de encerramento (grupo=dias, um por linha)" htmlFor="cfg-prazos" hint="Sem prazo definido, o agravo não entra no cartão de encerramento vencido.">
          <Textarea id="cfg-prazos" rows={5} value={f.prazos} onChange={(e) => setForm({ ...f, prazos: e.target.value })} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setForm({
                ...f,
                prazos: [
                  ...PRAZOS_ENCERRAMENTO_REFERENCIA.flatMap((r) => r.grupos.map((g) => `${g}=${r.dias}`)),
                  ...['dengue', 'chikungunya', 'zika', 'coqueluche', 'meningites', 'leptospirose'].map((g) => `${g}=${PRAZO_ENCERRAMENTO_AGUDOS}`),
                ].join('\n'),
              })
            }
          >
            Usar prazos de referência (Manual de Normas e Rotinas do Sinan)
          </Button>
        </Field>
        <Field
          label="Modelo da comunicação à autoridade policial"
          htmlFor="cfg-modelo"
          hint="Campos: {unidade} {cnes} {atendimento} {numero}. {paciente}, {nascimento} e {endereco} identificam a vítima e só cabem em caráter excepcional, com o conhecimento prévio dela (Lei nº 10.778/2003, art. 3º). Conteúdo a aprovar pela procuradoria (os arts. 14-D a 14-F foram revogados)."
        >
          <Textarea id="cfg-modelo" rows={7} value={f.modelo} onChange={(e) => setForm({ ...f, modelo: e.target.value })} />
        </Field>
        <div className="lg:col-span-3">
          <Button
            id="cfg-envio-salvar"
            onClick={async () => {
              // Uma linha "grupo=dias" por agravo; linha mal escrita impede salvar (não some em silêncio).
              const prazos: Record<string, number> = {};
              const recusadas: string[] = [];
              for (const l of f.prazos
                .split('\n')
                .map((x) => x.trim())
                .filter(Boolean)) {
                const [g, d, ...resto] = l.split('=').map((x) => x.trim());
                const grupo = (g ?? '').toLowerCase();
                const dias = Number(d);
                if (resto.length || !/^[a-z0-9-]{2,40}$/.test(grupo) || !Number.isInteger(dias) || dias < 1 || dias > 365) recusadas.push(l);
                else prazos[grupo] = dias;
              }
              if (recusadas.length) {
                toast.error(`Corrija as linhas de prazo (grupo=dias, de 1 a 365): ${recusadas.join('; ')}`);
                return;
              }
              try {
                await api.patch('/vigilancia/configuracoes', { relEnabled: f.rel, prazosEncerramento: prazos, modeloPolicial: f.modelo.trim() === MODELO_POLICIAL_PADRAO ? null : f.modelo });
                toast.success('Configuração salva.');
                setForm(null);
                onSaved();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            Salvar
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

const SISTEMAS: Record<string, string> = {
  SINAN_NET: 'Sinan Net',
  SINAN_ONLINE: 'Sinan Online',
  ESUS_SINAN: 'e-SUS Sinan',
  ESUS_NOTIFICA: 'e-SUS Notifica',
  SIVEP_GRIPE: 'Sivep-Gripe',
  SINASC_SIM: 'DNV (Sinasc) / DO (SIM)',
};

/** Rotas agravo → sistema oficial, com vigência; o que não está na tabela vai para o Sinan Net. */
export function SistemasTab({ podeGerir }: { podeGerir: boolean }) {
  const toast = useToast();
  const rotas = useApi<RotaSistema[]>('/vigilancia/sistemas');
  const [nova, setNova] = useState<{ groupKey: string; conditionKey: string; system: string; status: string; validFrom: string; source: string; notes: string } | null>(null);
  return (
    <Card>
      <CardHeader
        title="Sistemas oficiais de destino"
        description="Para onde vai cada agravo depois de confirmado (fila de digitação). O que não está aqui vai para o Sinan Net. Uma mudança pactuada com a SES abre nova vigência."
        actions={
          podeGerir ? (
            <Button size="sm" variant="secondary" onClick={() => setNova({ groupKey: '', conditionKey: '', system: 'SINAN_NET', status: 'CONFIRMADO', validFrom: todayIso(), source: '', notes: '' })} id="vig-rota-nova">
              <Plus className="h-4 w-4" /> Nova vigência
            </Button>
          ) : undefined
        }
      />
      <CardBody className="p-0">
        {rotas.loading && !rotas.data && <Spinner />}
        {rotas.data && (
          <Table>
            <THead>
              <TR>
                <TH>Agravo (grupo)</TH>
                <TH>Sistema</TH>
                <TH>Situação</TH>
                <TH>Vigência</TH>
                <TH>Fonte</TH>
              </TR>
            </THead>
            <TBody>
              {rotas.data.map((r) => (
                <TR key={r.id} className={r.vigente ? '' : 'opacity-60'}>
                  <TD className="text-sm">
                    {r.grupo}
                    {r.chave ? <span className="text-xs text-slate-500"> · linha {r.chave}</span> : null}
                  </TD>
                  <TD className="text-sm">{r.sistemaLabel}</TD>
                  <TD>
                    <Badge tone={r.situacao === 'CONFIRMADO' ? 'green' : 'amber'}>{r.situacaoLabel}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-xs">
                    {fmtDate(r.vigenteDe)}
                    {r.vigenteAte ? ` a ${fmtDate(r.vigenteAte)}` : ' em diante'}
                  </TD>
                  <TD className="max-w-md text-xs text-slate-600">
                    {r.fonte}
                    {r.notas ? <span className="block text-slate-500">{r.notas}</span> : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardBody>
      <Dialog
        open={!!nova}
        onOpenChange={(o) => !o && setNova(null)}
        title="Nova vigência de rota"
        description="A vigência anterior do mesmo agravo é encerrada na véspera."
        footer={
          <Button
            disabled={!nova || nova.groupKey.trim().length < 2 || nova.source.trim().length < 3}
            onClick={async () => {
              if (!nova) return;
              try {
                await api.post('/vigilancia/sistemas', { ...nova, conditionKey: nova.conditionKey || null, notes: nova.notes || null });
                toast.success('Rota salva.');
                setNova(null);
                await rotas.reload();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            Salvar
          </Button>
        }
      >
        {nova && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Grupo do agravo" htmlFor="rota-grupo" hint="Ex.: caxumba, dengue, oropouche">
              <Input id="rota-grupo" value={nova.groupKey} onChange={(e) => setNova({ ...nova, groupKey: e.target.value })} />
            </Field>
            <Field label="Linha específica (opcional)" htmlFor="rota-linha" hint="Chave da linha do catálogo; vazio vale para o grupo">
              <Input id="rota-linha" value={nova.conditionKey} onChange={(e) => setNova({ ...nova, conditionKey: e.target.value })} />
            </Field>
            <Field label="Sistema" htmlFor="rota-sistema">
              <Select id="rota-sistema" value={nova.system} onChange={(e) => setNova({ ...nova, system: e.target.value })}>
                {Object.entries(SISTEMAS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Situação" htmlFor="rota-situacao">
              <Select id="rota-situacao" value={nova.status} onChange={(e) => setNova({ ...nova, status: e.target.value })}>
                <option value="CONFIRMADO">Confirmado</option>
                <option value="A_DEFINIR">A definir com a SES</option>
                <option value="NAO_CONFIRMADO">Não confirmado</option>
              </Select>
            </Field>
            <Field label="Vigente a partir de" htmlFor="rota-de">
              <Input id="rota-de" type="date" value={nova.validFrom} onChange={(e) => setNova({ ...nova, validFrom: e.target.value })} />
            </Field>
            <Field label="Fonte (ofício, nota técnica, pactuação)" htmlFor="rota-fonte">
              <Input id="rota-fonte" value={nova.source} onChange={(e) => setNova({ ...nova, source: e.target.value })} />
            </Field>
            <Field label="Notas" htmlFor="rota-notas" className="sm:col-span-2">
              <Textarea id="rota-notas" rows={2} value={nova.notes} onChange={(e) => setNova({ ...nova, notes: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
