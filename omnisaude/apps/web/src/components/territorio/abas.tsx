'use client';

import { CATEGORIAS_LOCALIDADE, CATEGORIA_LOCALIDADE_LABEL, PRECISAO_INFO, ZONAS, type PrecisaoGeo } from '@omnisaude/shared';
import { Crosshair, FileUp, Link2, MapPinned, Plus, Wand2 } from 'lucide-react';
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
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { Bairro, ImovelPendente, Localidade, ResumoTerritorio } from './types';

const ZONA_LABEL: Record<string, string> = { URBANA: 'Urbana', RURAL: 'Rural', PERIURBANA: 'Periurbana' };

// ───────────── Localidades e bairros ─────────────

export function AbaLocalidades({ podeEditar, onAlterado }: { podeEditar: boolean; onAlterado?: () => void }) {
  const toast = useToast();
  const localidades = useApi<Localidade[]>('/territorio/localidades');
  const [sel, setSel] = useState<string | null>(null);
  const bairros = useApi<Bairro[]>(sel ? `/territorio/bairros?localidade=${sel}` : null, [sel]);
  const [novaLoc, setNovaLoc] = useState(false);
  const [loc, setLoc] = useState({ code: '', name: '', category: 'CIDADE', zone: 'URBANA', notes: '' });
  const [novoBairro, setNovoBairro] = useState(false);
  const [bairro, setBairro] = useState({ name: '', code: '', official: true, aliases: '' });
  const [busy, setBusy] = useState(false);
  const atual = localidades.data?.find((l) => l.id === sel) ?? null;

  async function criarLocalidade() {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/territorio/localidades', { code: loc.code, name: loc.name, category: loc.category, zone: loc.zone, notes: loc.notes || null });
      toast.success('Localidade cadastrada.');
      setNovaLoc(false);
      setLoc({ code: '', name: '', category: 'CIDADE', zone: 'URBANA', notes: '' });
      await localidades.reload();
      setSel(r.id);
      onAlterado?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function criarBairro() {
    if (!sel) return;
    setBusy(true);
    try {
      await api.post('/territorio/bairros', {
        localityId: sel,
        name: bairro.name,
        code: bairro.code || null,
        official: bairro.official,
        aliases: bairro.aliases
          .split(/[;\n]/)
          .map((a) => a.trim())
          .filter(Boolean),
      });
      toast.success('Bairro cadastrado.');
      setNovoBairro(false);
      setBairro({ name: '', code: '', official: true, aliases: '' });
      await Promise.all([bairros.reload(), localidades.reload()]);
      onAlterado?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function alternarStatus(l: Localidade) {
    try {
      await api.patch(`/territorio/localidades/${l.id}`, { status: l.status === 'ATIVA' ? 'EXTINTA' : 'ATIVA' });
      await localidades.reload();
      onAlterado?.();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader
          title="Localidades"
          description="Código único no município (até 8 dígitos, padrão do PNCD): cidade, vila, povoado, fazenda ou sítio."
          actions={
            podeEditar ? (
              <Button size="sm" id="terr-nova-localidade" onClick={() => setNovaLoc(true)}>
                <Plus className="h-4 w-4" /> Localidade
              </Button>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          {localidades.loading && !localidades.data ? (
            <Spinner className="m-4" />
          ) : !localidades.data?.length ? (
            <EmptyState title="Nenhuma localidade" description="Cadastre a sede do município ou importe a camada de localidades." icon={<MapPinned className="h-8 w-8" />} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Código</TH>
                  <TH>Nome</TH>
                  <TH>Categoria</TH>
                  <TH>Quarteirões</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {localidades.data.map((l) => (
                  <TR key={l.id} className={l.id === sel ? 'bg-brand-50' : undefined}>
                    <TD className="font-mono">{l.code}</TD>
                    <TD>
                      <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setSel(l.id)}>
                        {l.name}
                      </button>
                      {l.status !== 'ATIVA' && (
                        <Badge tone="slate" className="ml-2">
                          Extinta
                        </Badge>
                      )}
                    </TD>
                    <TD>
                      {CATEGORIA_LOCALIDADE_LABEL[l.category as keyof typeof CATEGORIA_LOCALIDADE_LABEL] ?? l.category} · {ZONA_LABEL[l.zone] ?? l.zone}
                    </TD>
                    <TD>{l._count.blocks}</TD>
                    <TD className="text-right">
                      {podeEditar && (
                        <Button size="sm" variant="ghost" onClick={() => alternarStatus(l)}>
                          {l.status === 'ATIVA' ? 'Extinguir' : 'Reativar'}
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

      <Card>
        <CardHeader
          title={atual ? `Bairros de ${atual.name}` : 'Bairros'}
          description="Sublocalidade do PNCD. Os apelidos ligam o bairro escrito no cadastro ao bairro oficial."
          actions={
            podeEditar && sel ? (
              <Button size="sm" id="terr-novo-bairro" onClick={() => setNovoBairro(true)}>
                <Plus className="h-4 w-4" /> Bairro
              </Button>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          {!sel ? (
            <p className="p-4 text-sm text-slate-500">Escolha uma localidade.</p>
          ) : bairros.loading && !bairros.data ? (
            <Spinner className="m-4" />
          ) : !bairros.data?.length ? (
            <p className="p-4 text-sm text-slate-500">Nenhum bairro cadastrado nesta localidade.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Nome</TH>
                  <TH>Apelidos</TH>
                  <TH>Quarteirões</TH>
                </TR>
              </THead>
              <TBody>
                {bairros.data.map((b) => (
                  <TR key={b.id}>
                    <TD>
                      {b.name}
                      {!b.official && (
                        <Badge tone="amber" className="ml-2">
                          Não oficial
                        </Badge>
                      )}
                    </TD>
                    <TD className="text-xs text-slate-500">{b.aliases.join('; ') || '—'}</TD>
                    <TD>{b._count.blocks}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Dialog
        open={novaLoc}
        onOpenChange={setNovaLoc}
        title="Nova localidade"
        footer={
          <Button id="terr-localidade-salvar" loading={busy} disabled={!/^\d{1,8}$/.test(loc.code) || loc.name.trim().length < 2} onClick={criarLocalidade}>
            Salvar
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Código" htmlFor="terr-loc-codigo" hint="Até 8 dígitos, único no município">
            <Input id="terr-loc-codigo" inputMode="numeric" value={loc.code} onChange={(e) => setLoc({ ...loc, code: e.target.value.replace(/\D/g, '').slice(0, 8) })} />
          </Field>
          <Field label="Nome" htmlFor="terr-loc-nome">
            <Input id="terr-loc-nome" value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} />
          </Field>
          <Field label="Categoria" htmlFor="terr-loc-categoria">
            <Select id="terr-loc-categoria" value={loc.category} onChange={(e) => setLoc({ ...loc, category: e.target.value })}>
              {CATEGORIAS_LOCALIDADE.map((c) => (
                <option key={c} value={c}>
                  {CATEGORIA_LOCALIDADE_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Zona" htmlFor="terr-loc-zona">
            <Select id="terr-loc-zona" value={loc.zone} onChange={(e) => setLoc({ ...loc, zone: e.target.value })}>
              {ZONAS.map((z) => (
                <option key={z} value={z}>
                  {ZONA_LABEL[z] ?? z}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Observações" htmlFor="terr-loc-notas" className="sm:col-span-2">
            <Textarea id="terr-loc-notas" rows={2} value={loc.notes} onChange={(e) => setLoc({ ...loc, notes: e.target.value })} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={novoBairro}
        onOpenChange={setNovoBairro}
        title={`Novo bairro${atual ? ` em ${atual.name}` : ''}`}
        footer={
          <Button id="terr-bairro-salvar" loading={busy} disabled={bairro.name.trim().length < 2} onClick={criarBairro}>
            Salvar
          </Button>
        }
      >
        <div className="grid gap-3">
          <Field label="Nome" htmlFor="terr-bairro-nome">
            <Input id="terr-bairro-nome" value={bairro.name} onChange={(e) => setBairro({ ...bairro, name: e.target.value })} />
          </Field>
          <Field label="Código (opcional)" htmlFor="terr-bairro-codigo">
            <Input id="terr-bairro-codigo" value={bairro.code} onChange={(e) => setBairro({ ...bairro, code: e.target.value })} />
          </Field>
          <Field label="Apelidos" htmlFor="terr-bairro-apelidos" hint="Separados por ponto e vírgula: como o bairro aparece escrito no cadastro">
            <Textarea id="terr-bairro-apelidos" rows={2} value={bairro.aliases} onChange={(e) => setBairro({ ...bairro, aliases: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={bairro.official} onChange={(e) => setBairro({ ...bairro, official: e.target.checked })} /> Bairro oficial (lei municipal)
          </label>
        </div>
      </Dialog>
    </div>
  );
}

// ───────────── Importação da malha ─────────────

type TipoImportacao = 'QUARTEIROES' | 'BAIRROS' | 'LOCALIDADES' | 'ENDERECOS';

interface Previa {
  id: string;
  tipo: TipoImportacao;
  formato?: string;
  src?: string;
  total: number;
  validas?: number;
  invalidas?: { indice: number; motivo: string }[];
  totalInvalidas?: number;
  tipos?: Record<string, number>;
  propriedades?: { nome: string; exemplos: string[] }[];
  sugestao?: Record<string, string | undefined>;
  avisos: string[];
  ignorados?: number;
  municipios?: string[];
  niveis?: Record<string, number>;
  fonte?: string;
}

interface Importacao {
  id: string;
  kind: TipoImportacao;
  fileName: string;
  crs: string | null;
  status: string;
  summary: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  appliedAt: string | null;
}

const TIPO_LABEL: Record<TipoImportacao, string> = {
  QUARTEIROES: 'Quarteirões',
  BAIRROS: 'Bairros',
  LOCALIDADES: 'Localidades',
  ENDERECOS: 'Endereços do IBGE (CNEFE)',
};

/** Colunas que cada tipo de malha usa (o que é obrigatório vem primeiro). */
const CAMPOS: Record<Exclude<TipoImportacao, 'ENDERECOS'>, { chave: string; label: string }[]> = {
  QUARTEIROES: [
    { chave: 'numero', label: 'Número do quarteirão' },
    { chave: 'localidade', label: 'Localidade (código ou nome)' },
    { chave: 'bairro', label: 'Bairro (nome)' },
  ],
  BAIRROS: [
    { chave: 'nome', label: 'Nome do bairro' },
    { chave: 'codigo', label: 'Código' },
    { chave: 'localidade', label: 'Localidade (código ou nome)' },
  ],
  LOCALIDADES: [
    { chave: 'codigo', label: 'Código da localidade' },
    { chave: 'nome', label: 'Nome' },
    { chave: 'categoria', label: 'Categoria' },
    { chave: 'zona', label: 'Zona' },
  ],
};

/** NV_GEO_COORD do CNEFE 2022 (os níveis 1 a 3 servem como endereço; 4 é a face de quadra). */
const NIVEL_CNEFE: Record<string, string> = {
  '1': 'Endereço (coordenada coletada)',
  '2': 'Endereço (coordenada ajustada)',
  '3': 'Endereço (coordenada estimada)',
  '4': 'Face de quadra',
  '5': 'Localidade',
  '6': 'Setor censitário',
};

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Não foi possível ler o arquivo'));
    r.readAsDataURL(file);
  });
}

export function AbaImportar({ srcAceitos, onAplicada }: { srcAceitos: { codigo: string; label: string }[]; onAplicada: () => void }) {
  const toast = useToast();
  const historico = useApi<Importacao[]>('/territorio/importacoes');
  const localidades = useApi<Localidade[]>('/territorio/localidades');
  const [tipo, setTipo] = useState<TipoImportacao>('QUARTEIROES');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [src, setSrc] = useState('');
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [mapa, setMapa] = useState<Record<string, string>>({});
  const [localidadeFixa, setLocalidadeFixa] = useState('');
  const [bairroFixo, setBairroFixo] = useState('');
  const bairros = useApi<Bairro[]>(localidadeFixa ? `/territorio/bairros?localidade=${localidadeFixa}` : null, [localidadeFixa]);
  const [oficial, setOficial] = useState(true);
  const [desativarAusentes, setDesativarAusentes] = useState(false);
  const [resultado, setResultado] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  async function enviar() {
    if (!arquivo) return;
    if (arquivo.size > 10 * 1024 * 1024) {
      toast.error('Arquivo acima de 10 MB: recorte a camada do município antes de enviar.');
      return;
    }
    setBusy(true);
    setResultado(null);
    try {
      const p = await api.post<Previa>('/territorio/importacoes/previa', { tipo, nomeArquivo: arquivo.name, arquivoBase64: await base64(arquivo), src: src || null });
      setPrevia(p);
      setMapa(Object.fromEntries(Object.entries(p.sugestao ?? {}).filter((e): e is [string, string] => !!e[1])));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function aplicar() {
    if (!previa) return;
    setBusy(true);
    try {
      const r = await api.post<Record<string, unknown>>(`/territorio/importacoes/${previa.id}/aplicar`, {
        mapeamento: mapa,
        localidadeFixa: localidadeFixa || null,
        bairroFixo: bairroFixo || null,
        oficial,
        desativarAusentes,
      });
      setResultado(r);
      setPrevia(null);
      setArquivo(null);
      toast.success('Importação aplicada.');
      await historico.reload();
      onAplicada();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const campos = tipo === 'ENDERECOS' ? [] : CAMPOS[tipo];
  const faltaNumero = tipo === 'QUARTEIROES' && !mapa.numero;
  const faltaLocalidade = (tipo === 'QUARTEIROES' || tipo === 'BAIRROS') && !mapa.localidade && !localidadeFixa;
  const faltaCodigo = tipo === 'LOCALIDADES' && (!mapa.codigo || !mapa.nome);
  const faltaNome = tipo === 'BAIRROS' && !mapa.nome;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="1. Arquivo" description="Shapefile compactado (.zip com .shp, .dbf e .prj) ou GeoJSON, até 10 MB. A prévia não muda o território." />
          <CardBody className="grid gap-3 sm:grid-cols-2">
            <Field label="O que o arquivo traz" htmlFor="terr-imp-tipo">
              <Select
                id="terr-imp-tipo"
                value={tipo}
                onChange={(e) => {
                  setTipo(e.target.value as TipoImportacao);
                  setPrevia(null);
                }}
              >
                {(Object.keys(TIPO_LABEL) as TipoImportacao[]).map((t) => (
                  <option key={t} value={t}>
                    {TIPO_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
            {tipo !== 'ENDERECOS' && (
              <Field label="Sistema de coordenadas" htmlFor="terr-imp-src" hint="Só quando o arquivo não traz o .prj">
                <Select id="terr-imp-src" value={src} onChange={(e) => setSrc(e.target.value)}>
                  <option value="">Ler do arquivo</option>
                  {srcAceitos.map((s) => (
                    <option key={s.codigo} value={s.codigo}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Arquivo" htmlFor="terr-imp-arquivo" className="sm:col-span-2" hint={tipo === 'ENDERECOS' ? 'CSV do CNEFE 2022 do município (ou o .zip baixado do IBGE)' : undefined}>
              <Input id="terr-imp-arquivo" type="file" accept={tipo === 'ENDERECOS' ? '.csv,.zip' : '.zip,.geojson,.json'} onChange={(e) => (setArquivo(e.target.files?.[0] ?? null), setPrevia(null))} />
            </Field>
            <div className="sm:col-span-2">
              <Button id="terr-imp-previa" loading={busy && !previa} disabled={!arquivo} onClick={enviar}>
                <FileUp className="h-4 w-4" /> Ler e conferir
              </Button>
            </div>
          </CardBody>
        </Card>

        {previa && (
          <Card id="terr-imp-conferencia">
            <CardHeader
              title="2. Conferência"
              description={
                previa.tipo === 'ENDERECOS'
                  ? `${previa.total.toLocaleString('pt-BR')} endereços com coordenada · ${previa.fonte}`
                  : `${previa.validas} de ${previa.total} feições válidas · ${previa.formato} · ${previa.src}`
              }
            />
            <CardBody className="flex flex-col gap-3">
              {previa.avisos.map((a) => (
                <Alert key={a} tone="warn">
                  {a}
                </Alert>
              ))}
              {!!previa.totalInvalidas && (
                <Alert tone="warn" title={`${previa.totalInvalidas} feição(ões) recusada(s)`}>
                  <ul className="list-disc pl-5 text-xs">
                    {previa.invalidas?.slice(0, 8).map((i) => (
                      <li key={i.indice}>
                        Feição {i.indice}: {i.motivo}
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}
              {previa.tipo === 'ENDERECOS' ? (
                <div className="text-sm">
                  <p className="mb-2">Precisão das coordenadas no arquivo:</p>
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {Object.entries(previa.niveis ?? {}).map(([n, q]) => (
                      <li key={n} className="flex justify-between rounded bg-slate-50 px-2 py-1">
                        <span>{NIVEL_CNEFE[n] ?? `Nível ${n}`}</span>
                        <b>{q.toLocaleString('pt-BR')}</b>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-slate-500">Aplicar substitui a base de endereços deste(s) município(s): {previa.municipios?.join(', ')}. Nada sai do sistema: a geocodificação é feita aqui.</p>
                </div>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {campos.map((c) => (
                      <Field key={c.chave} label={c.label} htmlFor={`terr-imp-col-${c.chave}`}>
                        <Select id={`terr-imp-col-${c.chave}`} value={mapa[c.chave] ?? ''} onChange={(e) => setMapa({ ...mapa, [c.chave]: e.target.value })}>
                          <option value="">— (não usar)</option>
                          {previa.propriedades?.map((p) => (
                            <option key={p.nome} value={p.nome}>
                              {p.nome}
                              {p.exemplos.length ? ` (ex.: ${p.exemplos.join(', ')})` : ''}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ))}
                    {(tipo === 'QUARTEIROES' || tipo === 'BAIRROS') && (
                      <Field label="Localidade de todas as feições" htmlFor="terr-imp-localidade" hint="Use quando o arquivo é de uma localidade só">
                        <Select id="terr-imp-localidade" value={localidadeFixa} onChange={(e) => (setLocalidadeFixa(e.target.value), setBairroFixo(''))}>
                          <option value="">— (pela coluna)</option>
                          {localidades.data
                            ?.filter((l) => l.status === 'ATIVA')
                            .map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.code} · {l.name}
                              </option>
                            ))}
                        </Select>
                      </Field>
                    )}
                    {tipo === 'QUARTEIROES' && localidadeFixa && (
                      <Field label="Bairro de todas as feições" htmlFor="terr-imp-bairro" hint="Sem coluna nem bairro fixo, o bairro sai do contorno do bairro">
                        <Select id="terr-imp-bairro" value={bairroFixo} onChange={(e) => setBairroFixo(e.target.value)}>
                          <option value="">— (pela coluna ou pelo mapa)</option>
                          {bairros.data?.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                  </div>
                  {tipo === 'BAIRROS' && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={oficial} onChange={(e) => setOficial(e.target.checked)} /> Bairros oficiais (lei municipal)
                    </label>
                  )}
                  {tipo === 'QUARTEIROES' && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={desativarAusentes} onChange={(e) => setDesativarAusentes(e.target.checked)} /> Desativar quarteirões da(s) localidade(s) que não vieram no arquivo (malha completa)
                    </label>
                  )}
                </>
              )}
              <div className="flex gap-2">
                <Button id="terr-imp-aplicar" loading={busy} disabled={faltaNumero || faltaLocalidade || faltaCodigo || faltaNome} onClick={aplicar}>
                  Aplicar no território
                </Button>
                <Button variant="ghost" onClick={() => setPrevia(null)}>
                  Descartar
                </Button>
              </div>
              {(faltaNumero || faltaLocalidade || faltaCodigo || faltaNome) && (
                <p className="text-xs text-amber-700">Indique {faltaNumero ? 'a coluna do número' : faltaCodigo ? 'as colunas do código e do nome' : faltaNome ? 'a coluna do nome' : 'a localidade (coluna ou fixa)'}.</p>
              )}
            </CardBody>
          </Card>
        )}

        {resultado && (
          <Card id="terr-imp-resultado">
            <CardHeader title="3. Resultado" />
            <CardBody>
              <Resultado r={resultado} />
            </CardBody>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader title="Histórico de importações" />
        <CardBody className="p-0">
          {!historico.data?.length ? (
            <p className="p-4 text-sm text-slate-500">Nenhuma importação.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {historico.data.map((h) => (
                <li key={h.id} className="px-4 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{TIPO_LABEL[h.kind]}</span>
                    <Badge tone={h.status === 'APLICADA' ? 'green' : 'slate'}>{h.status === 'APLICADA' ? 'Aplicada' : h.status === 'PREVIA' ? 'Prévia' : h.status}</Badge>
                  </div>
                  <p className="text-xs text-slate-500">
                    {h.fileName} · {fmtDateTime(h.appliedAt ?? h.createdAt)}
                    {h.crs ? ` · ${h.crs}` : ''}
                  </p>
                  {h.result && <Resultado r={h.result} compacto />}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Resultado({ r, compacto }: { r: Record<string, unknown>; compacto?: boolean }) {
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : null);
  const imoveis = r.imoveis as { comQuarteirao: number; semQuarteirao: number; alterados: number } | undefined;
  const erros = (r.erros as { indice?: number; motivo: string }[] | undefined) ?? [];
  const sobreposicoes = (r.sobreposicoes as string[] | undefined) ?? [];
  const avisos = (r.avisos as string[] | undefined) ?? [];
  const sobre = sobreposicoes.length;
  const partes = [n('criadas') ?? n('criados'), n('atualizadas') ?? n('atualizados'), n('desativados'), n('enderecos')];
  const texto = [
    partes[0] != null ? `${partes[0]} criado(s)` : null,
    partes[1] != null ? `${partes[1]} atualizado(s)` : null,
    partes[2] ? `${partes[2]} desativado(s)` : null,
    partes[3] != null ? `${partes[3].toLocaleString('pt-BR')} endereços` : null,
    n('totalErros') ? `${n('totalErros')} erro(s)` : null,
    sobre ? `${sobre} sobreposição(ões)` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={compacto ? 'text-xs text-slate-600' : 'flex flex-col gap-2 text-sm'}>
      <p>{texto}</p>
      {imoveis && (
        <p className={compacto ? '' : 'font-medium text-emerald-700'}>
          Imóveis: {imoveis.comQuarteirao} ligados a quarteirão, {imoveis.semQuarteirao} fora de quarteirão ({imoveis.alterados} mudaram).
        </p>
      )}
      {avisos.map((a) => (
        <p key={a} className="text-xs font-medium text-amber-700">
          {a}
        </p>
      ))}
      {!compacto && sobre > 0 && <p className="text-xs text-amber-700">Quarteirões que se sobrepõem no arquivo (confira no mapa): {sobreposicoes.join('; ')}</p>}
      {!compacto && erros.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-red-700">
          {erros.slice(0, 10).map((e, i) => (
            <li key={i}>
              {e.indice ? `Feição ${e.indice}: ` : ''}
              {e.motivo}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────── Pendências dos imóveis ─────────────

const SITUACOES = [
  { value: 'SEM_POSICAO', label: 'Sem posição no mapa' },
  { value: 'SEM_QUARTEIRAO', label: 'Com posição, fora de quarteirão' },
  { value: 'BAIXA_PRECISAO', label: 'Posição que não serve ao bloqueio' },
] as const;

export function AbaPendencias({
  podeEditar,
  podePosicionar = podeEditar,
  onMarcar,
  versao,
  onAlterado,
}: {
  podeEditar: boolean;
  podePosicionar?: boolean;
  onMarcar: (h: ImovelPendente) => void;
  versao: number;
  onAlterado?: () => void;
}) {
  const toast = useToast();
  const [situacao, setSituacao] = useState<(typeof SITUACOES)[number]['value']>('SEM_POSICAO');
  const lista = useApi<ImovelPendente[]>(`/territorio/imoveis?situacao=${situacao}`, [situacao, versao]);
  const [busy, setBusy] = useState<string | null>(null);

  async function geocodificar() {
    setBusy('geo');
    try {
      const r = await api.post<{ analisados: number; atualizados: number; semResultado: number; baseDeEnderecos: number }>('/territorio/imoveis/geocodificar', {});
      toast.success(
        r.baseDeEnderecos
          ? `${r.atualizados} de ${r.analisados} imóvel(is) localizados pela base local de endereços.`
          : `${r.atualizados} de ${r.analisados} imóvel(is) localizados (sem a base do IBGE: só pelo bairro e quarteirão).`,
      );
      if (onAlterado) onAlterado();
      else await lista.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function vincular() {
    setBusy('vinc');
    try {
      const r = await api.post<{ comQuarteirao: number; semQuarteirao: number; alterados: number }>('/territorio/imoveis/vincular', {});
      toast.success(`${r.comQuarteirao} imóvel(is) com quarteirão; ${r.alterados} mudaram.`);
      if (onAlterado) onAlterado();
      else await lista.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Imóveis com pendência"
        description="A posição do imóvel define o quarteirão. Endereço da base do IBGE serve ao bloqueio; centro de bairro ou de logradouro pede confirmação em campo."
        actions={
          podeEditar ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" id="terr-geocodificar" loading={busy === 'geo'} onClick={geocodificar}>
                <Wand2 className="h-4 w-4" /> Localizar pelo endereço
              </Button>
              <Button size="sm" variant="secondary" id="terr-vincular" loading={busy === 'vinc'} onClick={vincular}>
                <Link2 className="h-4 w-4" /> Religar todos aos quarteirões
              </Button>
            </div>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Situação">
          {SITUACOES.map((s) => (
            <Button key={s.value} size="sm" variant={situacao === s.value ? 'primary' : 'secondary'} onClick={() => setSituacao(s.value)}>
              {s.label}
            </Button>
          ))}
        </div>
        {lista.loading && !lista.data ? (
          <Spinner />
        ) : !lista.data?.length ? (
          <p className="text-sm text-slate-500">Nenhum imóvel nesta situação.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Endereço</TH>
                <TH>Bairro</TH>
                <TH>Microárea</TH>
                <TH>Posição</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {lista.data.map((h) => (
                <TR key={h.id}>
                  <TD>{h.endereco || '—'}</TD>
                  <TD>{h.district ?? '—'}</TD>
                  <TD>{h.microArea ?? '—'}</TD>
                  <TD className="text-xs">
                    {h.geoPrecision ? (
                      <Badge tone={PRECISAO_INFO[h.geoPrecision as PrecisaoGeo].bloqueio === 'AUTOMATICO' ? 'green' : PRECISAO_INFO[h.geoPrecision as PrecisaoGeo].bloqueio === 'COM_AVISO' ? 'amber' : 'red'}>
                        {h.precisaoLabel}
                      </Badge>
                    ) : (
                      'Sem posição'
                    )}
                  </TD>
                  <TD className="text-right">
                    {podePosicionar && (
                      <Button size="sm" variant="ghost" onClick={() => onMarcar(h)}>
                        <Crosshair className="h-4 w-4" /> Marcar no mapa
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {lista.data && lista.data.length >= 200 && <p className="text-xs text-slate-500">Mostrando os 200 primeiros.</p>}
      </CardBody>
    </Card>
  );
}

// ───────────── Configuração ─────────────

export function AbaConfiguracao({ resumo, podeEditar, onSalvo }: { resumo: ResumoTerritorio; podeEditar: boolean; onSalvo: () => void }) {
  const toast = useToast();
  const [numeracao, setNumeracao] = useState(resumo.config.numeracaoQuarteirao);
  const [raio, setRaio] = useState(String(resumo.config.raioBloqueioM));
  const [busy, setBusy] = useState(false);
  async function salvar() {
    setBusy(true);
    try {
      await api.patch('/territorio/configuracoes', { numeracaoQuarteirao: numeracao, raioBloqueioM: Number(raio) });
      toast.success('Configuração salva.');
      onSalvo();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="max-w-2xl">
      <CardHeader title="Regras do território" description="Valem para o editor, a importação e o raio do bloqueio." />
      <CardBody className="flex flex-col gap-3">
        <Field label="Numeração dos quarteirões" htmlFor="terr-cfg-numeracao" hint="O PNCD numera a partir de 1 em cada localidade; há municípios que recomeçam em cada bairro.">
          <Select id="terr-cfg-numeracao" disabled={!podeEditar} value={numeracao} onChange={(e) => setNumeracao(e.target.value as 'LOCALIDADE' | 'BAIRRO')}>
            <option value="LOCALIDADE">Única em cada localidade</option>
            <option value="BAIRRO">Recomeça em cada bairro</option>
          </Select>
        </Field>
        <Field label="Raio do bloqueio (metros)" htmlFor="terr-cfg-raio" hint="Padrão de 150 m (Diretrizes Nacionais para Prevenção e Controle das Arboviroses Urbanas, 2025); entre 50 e 1.000 m.">
          <Input id="terr-cfg-raio" disabled={!podeEditar} inputMode="numeric" value={raio} onChange={(e) => setRaio(e.target.value.replace(/\D/g, ''))} />
        </Field>
        {podeEditar && (
          <div>
            <Button id="terr-cfg-salvar" loading={busy} onClick={salvar}>
              Salvar
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
