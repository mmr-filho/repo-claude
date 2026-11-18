'use client';

import {
  CLASSIFICACAO_CASO_SURTO,
  CRITERIO_CASO_SURTO,
  localDateString,
  ROTULO_SITUACAO_CASO,
  type CasoSurto,
  type DetalheSurto,
  type RespostaCandidatasSurto,
  type RespostaCasoSurto,
  type RespostaRegistrosCandidatosSurto,
} from '@omnisaude/shared';
import { FileSearch, Link2, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { STATUS } from '@/components/vigilancia/types';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/hooks';
import { useTerritorios } from './diagrama-seletores';
import { useDataHora, useFuso } from './fuso';
import {
  buscaDaPlanilhaValida,
  candidatasParaPlanilha,
  consultaCandidatas,
  corpoLinhaCaso,
  dataBr,
  linhaVazia,
  origemDoCaso,
  pendenciasLinhaCaso,
  ROTULO_SEXO,
  rotuloSistemaOficial,
  simNao,
  textoCriterioCaso,
  type FormLinhaCaso,
} from './surto-regras';

/** Mostra a resposta da inclusão: o caso e os avisos (agravo diferente, rascunho, caso em outro surto, sem notificação individual). */
function avisar(toast: ReturnType<typeof useToast>, r: RespostaCasoSurto) {
  toast.success(`Caso ${r.caso.numero} incluído na planilha.`);
  for (const a of r.avisos) toast.info(a);
}

/**
 * Busca da inclusão: o texto (número, nome, CNS ou CPF; de 2 a 60 caracteres) vai à API ao buscar, não a cada letra
 * (a busca fica na auditoria). Com o agravo do surto, a lista começa nele; "todos os agravos" tira o filtro.
 */
function BuscaDaPlanilha({ id, rotulo, grupo, todos, onTodos, onBuscar }: { id: string; rotulo: string; grupo: string | null; todos: boolean; onTodos: (v: boolean) => void; onBuscar: (texto: string) => void }) {
  const [texto, setTexto] = useState('');
  const valida = buscaDaPlanilhaValida(texto);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valida) onBuscar(texto.trim());
      }}
    >
      <Field label={rotulo} htmlFor={id} className="min-w-64 flex-1" error={valida ? null : 'Digite de 2 a 60 caracteres.'}>
        <Input id={id} value={texto} maxLength={60} onChange={(e) => setTexto(e.target.value)} placeholder="Número, nome, CNS ou CPF" autoComplete="off" />
      </Field>
      <Button type="submit" variant="secondary" disabled={!valida}>
        <Search className="h-4 w-4" /> Buscar
      </Button>
      {grupo && (
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" checked={todos} onChange={(e) => onTodos(e.target.checked)} /> Todos os agravos
        </label>
      )}
    </form>
  );
}

/** Surtos abertos em que o caso já está (o caso pode entrar em mais de um; a API avisa). */
function EmSurtos({ numeros }: { numeros: string[] }) {
  if (!numeros.length) return null;
  return <Badge tone="amber">Já no surto {numeros.join(', ')}</Badge>;
}

/** Inclui uma notificação individual (do agravo do surto, quando houver) na planilha (GET /vigilancia/surtos/candidatas). */
function IncluirNotificacao({ d, onFechar, onFeito }: { d: DetalheSurto; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const { dataHora } = useDataHora();
  const [todos, setTodos] = useState(!d.grupo);
  const [busca, setBusca] = useState('');
  const candidatas = useApi<RespostaCandidatasSurto>(`/vigilancia/surtos/candidatas${consultaCandidatas({ grupo: todos ? undefined : (d.grupo ?? undefined), busca, surtoId: d.id })}`);
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // A API já tira as da planilha (surtoId) e as descartadas; aqui, de novo, para a lista não mostrar a recém-incluída.
  const lista = useMemo(() => candidatasParaPlanilha(candidatas.data?.itens ?? [], d.planilha), [candidatas.data, d.planilha]);
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onFechar()}
      title="Incluir notificação na planilha"
      description={`Notificações individuais ${d.grupo && !todos ? `de ${d.agravo} ` : ''}fora da planilha, da conhecida mais recentemente para a mais antiga (até 100). O surto não substitui a notificação individual.`}
      footer={
        <Button
          disabled={!sel}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const r = await api.post<RespostaCasoSurto>(`/vigilancia/surtos/${d.id}/casos`, { notificationId: sel });
              avisar(toast, r);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Link2 className="h-4 w-4" /> Incluir
        </Button>
      }
    >
      <div className="space-y-3">
        <BuscaDaPlanilha
          id="sp-busca"
          rotulo="Buscar a notificação"
          grupo={d.grupo}
          todos={todos}
          onTodos={(v) => {
            setTodos(v);
            setSel('');
          }}
          onBuscar={(t) => {
            setBusca(t);
            setSel('');
          }}
        />
        {candidatas.error && <Alert tone="error">{candidatas.error}</Alert>}
        {candidatas.loading && !candidatas.data && <Spinner />}
        {candidatas.data && lista.length === 0 && <p className="text-sm text-slate-600">Nenhuma notificação para incluir{busca ? ' com essa busca' : ''}.</p>}
        {lista.length > 0 && (
          <fieldset className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            <legend className="sr-only">Notificações</legend>
            {lista.map((n) => (
              <label key={n.id} className={cn('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50', sel === n.id && 'bg-brand-50')}>
                <input type="radio" name="sp-notificacao" className="mt-1" checked={sel === n.id} onChange={() => setSel(n.id)} />
                <span className="flex-1">
                  <span className="font-medium tabular-nums">{n.numero}</span> · {n.agravo}
                  <span className="block text-xs text-slate-600">
                    {n.paciente} · {n.unidade.nome} · conhecida em {dataHora(n.conhecidoEm)}
                    {n.inicioSintomas ? ` · sintomas em ${dataBr(n.inicioSintomas)}` : ''}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {n.sigilosa && <Badge tone="violet">Sigilosa</Badge>}
                    <EmSurtos numeros={n.emSurtos} />
                  </span>
                </span>
                <Badge tone={STATUS[n.status]?.tone ?? 'slate'}>{STATUS[n.status]?.label ?? n.status}</Badge>
              </label>
            ))}
          </fieldset>
        )}
        {candidatas.data?.limitado && <p className="text-xs text-slate-500">Há mais notificações do que as mostradas: refine a busca.</p>}
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/** Paciente do registro oficial na lista: nome, ou o motivo de não aparecer. */
const pacienteDoRegistro = (r: RespostaRegistrosCandidatosSurto['itens'][number]) => r.paciente?.nome ?? (r.sigiloso ? 'paciente sob sigilo' : 'sem identificação no arquivo');

/**
 * Inclui um registro oficial individual (importado do Sinan ou do e-SUS) na planilha (GET /vigilancia/surtos/registros):
 * para o caso que chegou pelo sistema oficial sem notificação no OmniSaúde.
 */
function IncluirRegistro({ d, onFechar, onFeito }: { d: DetalheSurto; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const { data } = useDataHora();
  const [todos, setTodos] = useState(!d.grupo);
  const [busca, setBusca] = useState('');
  const registros = useApi<RespostaRegistrosCandidatosSurto>(`/vigilancia/surtos/registros${consultaCandidatas({ grupo: todos ? undefined : (d.grupo ?? undefined), busca, surtoId: d.id })}`);
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const ja = useMemo(() => new Set(d.planilha.map((c) => c.officialRecordId).filter(Boolean)), [d.planilha]);
  const lista = (registros.data?.itens ?? []).filter((r) => !ja.has(r.id));
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onFechar()}
      title="Incluir registro oficial na planilha"
      description={`Registros individuais das exportações oficiais ${d.grupo && !todos ? `de ${d.agravo} ` : ''}fora da planilha, do notificado mais recentemente para o mais antigo (até 100). A lista fica na auditoria.`}
      footer={
        <Button
          disabled={!sel}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const r = await api.post<RespostaCasoSurto>(`/vigilancia/surtos/${d.id}/casos`, { officialRecordId: sel });
              avisar(toast, r);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Link2 className="h-4 w-4" /> Incluir
        </Button>
      }
    >
      <div className="space-y-3">
        <BuscaDaPlanilha
          id="sp-reg-busca"
          rotulo="Buscar o registro oficial"
          grupo={d.grupo}
          todos={todos}
          onTodos={(v) => {
            setTodos(v);
            setSel('');
          }}
          onBuscar={(t) => {
            setBusca(t);
            setSel('');
          }}
        />
        {registros.error && <Alert tone="error">{registros.error}</Alert>}
        {registros.loading && !registros.data && <Spinner />}
        {registros.data && lista.length === 0 && <p className="text-sm text-slate-600">Nenhum registro oficial para incluir{busca ? ' com essa busca' : ''}.</p>}
        {lista.length > 0 && (
          <fieldset className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            <legend className="sr-only">Registros oficiais</legend>
            {lista.map((r) => (
              <label key={r.id} className={cn('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50', sel === r.id && 'bg-brand-50')}>
                <input type="radio" name="sp-registro" className="mt-1" checked={sel === r.id} onChange={() => setSel(r.id)} />
                <span className="flex-1">
                  <span className="font-medium tabular-nums">{r.numero}</span>
                  <span className="ml-1.5 text-xs text-slate-500">{rotuloSistemaOficial(r.sistema)}</span> · {r.agravoNome ?? r.grupo ?? r.agravo ?? 'agravo não identificado'}
                  <span className="block text-xs text-slate-600">
                    {pacienteDoRegistro(r)} · {r.unidade.nome ?? (r.unidade.cnes ? `CNES ${r.unidade.cnes}` : 'unidade não informada')} · notificado em {dataBr(r.notificadoEm)}
                    {r.inicioSintomas ? ` · sintomas em ${dataBr(r.inicioSintomas)}` : ''}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    <Badge tone="slate">{ROTULO_SITUACAO_CASO[r.situacao] ?? r.situacao}</Badge>
                    {r.sigiloso && <Badge tone="violet">Sigiloso</Badge>}
                    {r.ausenteDesde && <Badge tone="amber">Não veio na última exportação ({data(r.ausenteDesde)})</Badge>}
                    <EmSurtos numeros={r.emSurtos} />
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {registros.data?.limitado && <p className="text-xs text-slate-500">Há mais registros do que os mostrados: refine a busca.</p>}
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/** A linha ainda vazia: o botão fica desabilitado, sem aviso. */
const VAZIA = 'Preencha ao menos um campo da linha.';

/** Linha manual da planilha (caso sem notificação no OmniSaúde). */
function LinhaManual({ d, onFechar, onFeito }: { d: DetalheSurto; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const hoje = localDateString(new Date(), useFuso());
  const t = useTerritorios('BAIRRO');
  const [f, setF] = useState<FormLinhaCaso>(linhaVazia());
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pend = pendenciasLinhaCaso(f, hoje);
  const set = (patch: Partial<FormLinhaCaso>) => setF((x) => ({ ...x, ...patch }));
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onFechar()}
      title="Incluir linha na planilha"
      description="Para o caso sem notificação no OmniSaúde. Use só as iniciais do nome. Caso de agravo da lista continua precisando da notificação individual."
      footer={
        <Button
          disabled={pend.length > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const r = await api.post<RespostaCasoSurto>(`/vigilancia/surtos/${d.id}/casos`, { linha: { ...corpoLinhaCaso(f) } });
              avisar(toast, r);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Plus className="h-4 w-4" /> Incluir linha
        </Button>
      }
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Iniciais" htmlFor="sl-iniciais">
          <Input id="sl-iniciais" maxLength={15} value={f.iniciais} onChange={(e) => set({ iniciais: e.target.value.toUpperCase() })} placeholder="Ex.: MAS" />
        </Field>
        <Field label="Sexo" htmlFor="sl-sexo">
          <Select id="sl-sexo" value={f.sexo} onChange={(e) => set({ sexo: e.target.value })}>
            <option value="">Não informado</option>
            {Object.entries(ROTULO_SEXO).map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Idade" htmlFor="sl-idade" hint="Ex.: 34 anos, 5 meses, 10 dias.">
          <Input id="sl-idade" maxLength={12} value={f.idade} onChange={(e) => set({ idade: e.target.value })} />
        </Field>
        <Field label="Município de residência (IBGE)" htmlFor="sl-ibge">
          <Input id="sl-ibge" inputMode="numeric" maxLength={7} value={f.municipioResidencia} onChange={(e) => set({ municipioResidencia: e.target.value.replace(/\D/g, '') })} />
        </Field>
        {t.pode && (
          <Field label="Bairro" htmlFor="sl-bairro">
            <Select id="sl-bairro" value={f.bairroId} onChange={(e) => set({ bairroId: e.target.value })} disabled={t.carregando}>
              <option value="">Não informado</option>
              {[...t.bairros]
                .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label="Início dos sintomas" htmlFor="sl-sintomas">
          <Input id="sl-sintomas" type="date" max={hoje} value={f.inicioSintomas} onChange={(e) => set({ inicioSintomas: e.target.value })} />
        </Field>
        <Field label="Hospitalizado" htmlFor="sl-hosp">
          <Select id="sl-hosp" value={f.hospitalizado} onChange={(e) => set({ hospitalizado: e.target.value as FormLinhaCaso['hospitalizado'] })}>
            <option value="">Ignorado</option>
            <option value="S">Sim</option>
            <option value="N">Não</option>
          </Select>
        </Field>
        <Field label="Óbito" htmlFor="sl-obito">
          <Select id="sl-obito" value={f.obito} onChange={(e) => set({ obito: e.target.value as FormLinhaCaso['obito'] })}>
            <option value="">Ignorado</option>
            <option value="S">Sim</option>
            <option value="N">Não</option>
          </Select>
        </Field>
        <Field label="Classificação final" htmlFor="sl-classi">
          <Select id="sl-classi" value={f.classificacao} onChange={(e) => set({ classificacao: e.target.value })}>
            <option value="">Não informada</option>
            {Object.entries(CLASSIFICACAO_CASO_SURTO).map(([c, n]) => (
              <option key={c} value={c}>
                {c} - {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Critério de confirmação" htmlFor="sl-criterio" hint="Códigos do dicionário de dados (a legenda da planilha impressa diverge).">
          <Select id="sl-criterio" value={f.criterio} onChange={(e) => set({ criterio: e.target.value })}>
            <option value="">Não informado</option>
            {Object.entries(CRITERIO_CASO_SURTO).map(([c, n]) => (
              <option key={c} value={c}>
                {c} - {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Diagnóstico final (CID-10)" htmlFor="sl-cid">
          <Input id="sl-cid" maxLength={6} value={f.cidFinal} onChange={(e) => set({ cidFinal: e.target.value })} />
        </Field>
        {pend.some((p) => p !== VAZIA) && (
          <Alert tone="warn" className="md:col-span-3">
            <ul className="list-inside list-disc space-y-0.5">
              {pend.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        {erro && (
          <Alert tone="error" className="md:col-span-3">
            {erro}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

/** Retira o caso da planilha (o número do caso não se reaproveita). */
function Retirar({ d, c, onFechar, onFeito }: { d: DetalheSurto; c: CasoSurto; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(o) => !o && onFechar()}
      title={`Retirar o caso ${c.numero}`}
      description={`${origemDoCaso(c)}. A retirada fica na linha do tempo do surto; o número ${c.numero} não volta a ser usado.`}
      footer={
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              await api.delete(`/vigilancia/surtos/${d.id}/casos/${c.id}`);
              toast.success(`Caso ${c.numero} retirado da planilha.`);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Trash2 className="h-4 w-4" /> Retirar
        </Button>
      }
    >
      {erro ? <Alert tone="error">{erro}</Alert> : <p className="text-sm text-slate-700">Confirme para retirar o caso da planilha.</p>}
    </Dialog>
  );
}

/**
 * Marcas do mesmo caso em duas linhas (a notificação e o registro oficial conciliado com ela), por NU_CASO, para a
 * planilha e o espelho. O par em que uma das linhas é sob sigilo para quem lê não é revelado (R5-8): a API não manda
 * `mesmoCasoQue` nele, e a tela também não o marca.
 */
export function marcasMesmoCaso(planilha: Pick<CasoSurto, 'numero' | 'mesmoCasoQue' | 'restrito'>[]): Map<number, number> {
  const sobSigilo = new Set(planilha.filter((c) => c.restrito).map((c) => c.numero));
  return new Map(planilha.filter((c) => c.mesmoCasoQue != null && !sobSigilo.has(c.numero) && !sobSigilo.has(c.mesmoCasoQue)).map((c) => [c.numero, c.mesmoCasoQue!]));
}

/** Marca da linha que é o mesmo caso de outra (`outra`, o NU_CASO dela, de `marcasMesmoCaso`). */
function MarcaMesmoCaso({ outra }: { outra: number | undefined }) {
  if (outra == null) return null;
  return (
    <Badge tone="amber" className="mt-0.5" title="A notificação e o registro oficial conciliado com ela: o mesmo caso em duas linhas.">
      Mesmo caso do caso {outra}
    </Badge>
  );
}

/**
 * Planilha de acompanhamento do surto: uma linha por caso (notificação, registro oficial ou linha manual). A linha de
 * origem sigilosa que quem lê não pode abrir vem só com o número do caso, sem a marca do mesmo caso (R5-8).
 */
export function SurtoPlanilha({ d, onMudou }: { d: DetalheSurto; onMudou: () => void }) {
  const editavel = d.permissoes.editar;
  const marcas = useMemo(() => marcasMesmoCaso(d.planilha), [d.planilha]);
  const [acao, setAcao] = useState<{ tipo: 'notificacao' | 'registro' | 'manual' } | { tipo: 'retirar'; c: CasoSurto } | null>(null);
  const feito = () => {
    setAcao(null);
    onMudou();
  };
  return (
    <Card>
      <CardHeader
        title={`Planilha de casos (${d.casosNaPlanilha} de ${d.casos} informados)`}
        description="Preenchida ao fim de cada semana epidemiológica até o encerramento. Caso de agravo da lista sem notificação individual fica marcado."
        actions={
          editavel ? (
            <>
              <Button size="sm" onClick={() => setAcao({ tipo: 'notificacao' })}>
                <Link2 className="h-4 w-4" /> Incluir notificação
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAcao({ tipo: 'registro' })}>
                <FileSearch className="h-4 w-4" /> Incluir registro oficial
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAcao({ tipo: 'manual' })}>
                <Plus className="h-4 w-4" /> Linha manual
              </Button>
            </>
          ) : undefined
        }
      />
      {d.planilha.length === 0 ? (
        <EmptyState title="Nenhum caso na planilha" description={editavel ? 'Inclua as notificações dos casos ou linhas manuais.' : undefined} />
      ) : (
        <Table className="text-xs">
          <THead>
            <tr>
              <TH>Nº</TH>
              <TH>Iniciais</TH>
              <TH>Sexo</TH>
              <TH>Idade</TH>
              <TH>Residência</TH>
              <TH>Início dos sintomas</TH>
              <TH>Hospitalizado</TH>
              <TH>Óbito</TH>
              <TH>Classificação</TH>
              <TH>Critério</TH>
              <TH>CID final</TH>
              <TH>Origem</TH>
              {editavel && <TH className="text-right">Retirar</TH>}
            </tr>
          </THead>
          <TBody>
            {d.planilha.map((c) =>
              c.restrito ? (
                <TR key={c.id}>
                  <TD className="font-medium tabular-nums">{c.numero}</TD>
                  <TD colSpan={10} className="text-slate-500">
                    Dados sob sigilo: só quem pode abrir {c.notificationId ? 'a notificação' : 'o registro oficial'} vê a linha.
                  </TD>
                  <TD>
                    {origemDoCaso(c)}
                    <Badge tone="violet" className="mt-0.5">
                      Sob sigilo
                    </Badge>
                    {c.semNotificacaoIndividual && (
                      <Badge tone="amber" className="mt-0.5">
                        Sem notificação individual
                      </Badge>
                    )}
                  </TD>
                  {editavel && (
                    <TD className="text-right">
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-red-700" aria-label={`Retirar o caso ${c.numero}`} onClick={() => setAcao({ tipo: 'retirar', c })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TD>
                  )}
                </TR>
              ) : (
                <TR key={c.id}>
                  <TD className="font-medium tabular-nums">{c.numero}</TD>
                  <TD>{c.iniciais ?? '—'}</TD>
                  <TD>{c.sexo ? (ROTULO_SEXO[c.sexo] ?? c.sexo) : '—'}</TD>
                  <TD className="whitespace-nowrap">{c.idade ?? '—'}</TD>
                  <TD>
                    {c.bairroNome ?? '—'}
                    {c.municipioResidencia && <span className="block text-slate-500">IBGE {c.municipioResidencia}</span>}
                  </TD>
                  <TD className="tabular-nums">{dataBr(c.inicioSintomas)}</TD>
                  <TD>{simNao(c.hospitalizado)}</TD>
                  <TD>{simNao(c.obito)}</TD>
                  <TD>{c.classificacao ? `${c.classificacao} - ${CLASSIFICACAO_CASO_SURTO[c.classificacao] ?? '?'}` : '—'}</TD>
                  <TD>{textoCriterioCaso(c.criterio)}</TD>
                  <TD>{c.cidFinal ?? '—'}</TD>
                  <TD>
                    {origemDoCaso(c)}
                    {c.semNotificacaoIndividual && (
                      <Badge tone="amber" className="mt-0.5">
                        Sem notificação individual
                      </Badge>
                    )}
                    <MarcaMesmoCaso outra={marcas.get(c.numero)} />
                  </TD>
                  {editavel && (
                    <TD className="text-right">
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-red-700" aria-label={`Retirar o caso ${c.numero}`} onClick={() => setAcao({ tipo: 'retirar', c })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TD>
                  )}
                </TR>
              ),
            )}
          </TBody>
        </Table>
      )}
      {acao?.tipo === 'notificacao' && <IncluirNotificacao d={d} onFechar={() => setAcao(null)} onFeito={feito} />}
      {acao?.tipo === 'registro' && <IncluirRegistro d={d} onFechar={() => setAcao(null)} onFeito={feito} />}
      {acao?.tipo === 'manual' && <LinhaManual d={d} onFechar={() => setAcao(null)} onFeito={feito} />}
      {acao?.tipo === 'retirar' && <Retirar d={d} c={acao.c} onFechar={() => setAcao(null)} onFeito={feito} />}
    </Card>
  );
}
