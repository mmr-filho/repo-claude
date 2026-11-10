'use client';

import { localDateString, ROTULO_EIXO_ACAO, ROTULO_STATUS_PLANO, ROTULO_TIPO_CRITERIO, type CriterioPlano, type DetalhePlano, type EixoAcao, type ListaPlanos, type PlanoContingencia } from '@omnisaude/shared';
import { CalendarCheck, Copy, FilePlus2, Plus, Save, Trash2, Undo2 } from 'lucide-react';
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
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import {
  acoesPorEstagio,
  classeDoEstagio,
  dataBr,
  definicaoParaEnvio,
  ehCriterioDeCanal,
  ehCriterioNumerico,
  estagiosOrdenados,
  exigenciaDoCriterio,
  incluirAcao,
  incluirCriterioManual,
  lerNumero,
  removerAcao,
  removerCriterio,
  textoVigencia,
  TOM_STATUS_PLANO,
  trocarAcao,
  trocarCriterio,
  validarPlano,
} from './contingencia-regras';
import { nomeDoAgravo, type OpcaoAgravo } from './diagrama-agravos';

const EIXOS = Object.keys(ROTULO_EIXO_ACAO) as EixoAcao[];
const copia = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Campo numérico que aceita vírgula: guarda o texto enquanto se digita e entrega o número (undefined quando vazio). */
function CampoNumero({ id, rotulo, valor, onChange, decimal, disabled }: { id: string; rotulo: string; valor: number | undefined; onChange: (v: number | undefined) => void; decimal?: boolean; disabled?: boolean }) {
  const [texto, setTexto] = useState(valor === undefined ? '' : String(valor).replace('.', ','));
  return (
    <Field label={rotulo} htmlFor={id}>
      <Input
        id={id}
        inputMode={decimal ? 'decimal' : 'numeric'}
        className="h-9"
        disabled={disabled}
        value={texto}
        onChange={(e) => {
          setTexto(e.target.value);
          onChange(lerNumero(e.target.value));
        }}
      />
    </Field>
  );
}

/** Parâmetros editáveis do critério: semanas e modo nos de canal; comparador e limiar nos numéricos. */
function ParametrosCriterio({ c, onChange }: { c: CriterioPlano; onChange: (patch: Partial<CriterioPlano>) => void }) {
  const id = `ct-plano-${c.id}`;
  if (ehCriterioDeCanal(c.tipo)) {
    const kDeN = c.modo === 'K_DE_N';
    return (
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Contagem" htmlFor={`${id}-modo`}>
          <Select
            id={`${id}-modo`}
            className="h-9"
            value={c.modo ?? 'CONSECUTIVAS'}
            onChange={(e) =>
              onChange(e.target.value === 'K_DE_N' ? { modo: 'K_DE_N', k: c.k ?? c.semanas ?? 1, n: c.n ?? c.semanas ?? 1 } : { modo: 'CONSECUTIVAS', k: undefined, n: undefined, semanas: c.semanas ?? c.n ?? 1 })
            }
          >
            <option value="CONSECUTIVAS">Semanas seguidas</option>
            <option value="K_DE_N">k das últimas n semanas</option>
          </Select>
        </Field>
        {kDeN ? (
          <>
            <CampoNumero id={`${id}-k`} rotulo="k (semanas no canal)" valor={c.k} onChange={(k) => onChange({ k })} />
            <CampoNumero id={`${id}-n`} rotulo="n (últimas semanas)" valor={c.n ?? c.semanas} onChange={(n) => onChange({ n })} />
          </>
        ) : (
          <CampoNumero id={`${id}-semanas`} rotulo="Semanas seguidas" valor={c.semanas} onChange={(semanas) => onChange({ semanas })} />
        )}
      </div>
    );
  }
  if (ehCriterioNumerico(c.tipo))
    return (
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Comparação" htmlFor={`${id}-comp`}>
          <Select id={`${id}-comp`} className="h-9" value={c.comparador ?? '>'} onChange={(e) => onChange({ comparador: e.target.value as '>' | '>=' })}>
            <option value=">">maior que</option>
            <option value=">=">maior ou igual a</option>
          </Select>
        </Field>
        <CampoNumero id={`${id}-limiar`} rotulo={c.tipo === 'INCIDENCIA_ACUMULADA' ? 'Limiar (por 100 mil)' : 'Limiar (%)'} valor={c.limiar} onChange={(limiar) => onChange({ limiar })} decimal />
      </div>
    );
  return null;
}

/** Inclui critério manual ou ação: um campo de texto e o botão. */
function Inclusao({ id, rotulo, minimo, onIncluir, children }: { id: string; rotulo: string; minimo: number; onIncluir: (texto: string) => void; children?: React.ReactNode }) {
  const [texto, setTexto] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-2">
      {children}
      <Field label={rotulo} htmlFor={id} className="min-w-[16rem] flex-1">
        <Input id={id} className="h-9" maxLength={500} value={texto} onChange={(e) => setTexto(e.target.value)} />
      </Field>
      <Button
        size="sm"
        variant="secondary"
        className="h-9"
        disabled={texto.trim().length < minimo}
        onClick={() => {
          onIncluir(texto.trim());
          setTexto('');
        }}
      >
        <Plus className="h-4 w-4" /> Incluir
      </Button>
    </div>
  );
}

/** Põe o rascunho em vigor; o plano em vigor do mesmo escopo é arquivado na véspera. */
function PorEmVigor({ plano, onFechar, onFeito }: { plano: DetalhePlano; onFechar: () => void; onFeito: (p: DetalhePlano) => void }) {
  const toast = useToast();
  const session = useSession();
  // "Hoje" no fuso da instituição, como a API confere.
  const hoje = localDateString(new Date(), session.me?.tenant.timeZone ?? 'America/Sao_Paulo');
  const [desde, setDesde] = useState(hoje);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const invalida = !/^\d{4}-\d{2}-\d{2}$/.test(desde) || desde > hoje;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title={`Pôr em vigor: ${plano.nome}`}
      description="O plano passa a valer na data escolhida (hoje ou antes). O plano em vigor hoje é arquivado na véspera. O estágio acionado continua até o próximo acionamento."
      footer={
        <Button
          disabled={invalida}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const p = await api.post<DetalhePlano>(`/vigilancia/contingencia/planos/${plano.id}/vigencia`, { desde });
              toast.success(`${p.nome} em vigor desde ${dataBr(desde)}.`);
              onFeito(p);
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <CalendarCheck className="h-4 w-4" /> Pôr em vigor
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Em vigor desde" htmlFor="ct-vigencia-desde" error={desde > hoje ? 'A vigência começa hoje ou numa data passada.' : null}>
          <Input id="ct-vigencia-desde" type="date" max={hoje} value={desde} onChange={(e) => setDesde(e.target.value)} />
        </Field>
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/** Ver e editar o plano. Só o rascunho se edita; o vigente e o arquivado se copiam para um novo rascunho. */
function EditorPlano({
  plano,
  podeAgir,
  opcoes,
  onSalvo,
  onCopiado,
  onVigente,
}: {
  plano: DetalhePlano;
  podeAgir: boolean;
  opcoes: OpcaoAgravo[];
  onSalvo: (p: DetalhePlano) => void;
  onCopiado: (p: DetalhePlano) => void;
  onVigente: (p: DetalhePlano) => void;
}) {
  const toast = useToast();
  const editavel = podeAgir && plano.status === 'RASCUNHO';
  const [def, setDef] = useState<PlanoContingencia>(() => copia(plano.definicao));
  const [nome, setNome] = useState(plano.nome);
  const [fonte, setFonte] = useState(plano.fonte ?? '');
  const [sujo, setSujo] = useState(false);
  const [busy, setBusy] = useState<'salvar' | 'copiar' | null>(null);
  const [vigencia, setVigencia] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [eixoNovo, setEixoNovo] = useState<Record<string, EixoAcao>>({});
  const erros = useMemo(() => [...(nome.trim().length < 3 ? ['O nome do plano tem pelo menos 3 caracteres.'] : []), ...validarPlano(def)], [def, nome]);
  const mudar = (d: PlanoContingencia) => {
    setDef(d);
    setSujo(true);
  };
  const estagios = estagiosOrdenados(def);
  const porEstagio = acoesPorEstagio(def);
  const selo = (chave: string) => <Badge className={classeDoEstagio(def, chave)}>{def.estagios.find((e) => e.chave === chave)?.nome ?? chave}</Badge>;

  async function salvar() {
    setBusy('salvar');
    setErro(null);
    try {
      const p = await api.put<DetalhePlano>(`/vigilancia/contingencia/planos/${plano.id}`, { nome: nome.trim(), fonte: fonte.trim() || null, definicao: definicaoParaEnvio(def) });
      toast.success('Rascunho do plano salvo.');
      onSalvo(p);
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function copiar() {
    setBusy('copiar');
    setErro(null);
    try {
      const p = await api.post<DetalhePlano>('/vigilancia/contingencia/planos', { copiarDe: plano.id });
      toast.success(`Rascunho criado: ${p.nome} (versão ${p.versao}).`);
      onCopiado(p);
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={plano.nome}
          description={`Versão ${plano.versao} · ${textoVigencia(plano)} · atualizado em ${fmtDateTime(plano.atualizadoEm)}`}
          actions={
            <>
              <Badge tone={TOM_STATUS_PLANO[plano.status]}>{ROTULO_STATUS_PLANO[plano.status]}</Badge>
              {podeAgir && (
                <Button size="sm" variant="secondary" onClick={copiar} loading={busy === 'copiar'}>
                  <Copy className="h-4 w-4" /> Copiar para novo rascunho
                </Button>
              )}
              {editavel && sujo && (
                <Button size="sm" variant="ghost" onClick={() => onSalvo(plano)}>
                  <Undo2 className="h-4 w-4" /> Descartar alterações
                </Button>
              )}
              {editavel && (
                <Button size="sm" onClick={salvar} disabled={!sujo || erros.length > 0} loading={busy === 'salvar'}>
                  <Save className="h-4 w-4" /> Salvar rascunho
                </Button>
              )}
              {editavel && (
                <Button size="sm" variant="success" onClick={() => setVigencia(true)} disabled={sujo} title={sujo ? 'Salve as alterações antes' : undefined}>
                  <CalendarCheck className="h-4 w-4" /> Pôr em vigor
                </Button>
              )}
            </>
          }
        />
        <CardBody className="space-y-3 pt-4">
          {!editavel && (
            <p className="text-sm text-slate-600">
              {plano.status === 'RASCUNHO' ? 'Só quem tem a permissão do plano de contingência edita o rascunho.' : 'Plano em vigor ou arquivado não se edita: copie para um novo rascunho, edite e ponha em vigor.'}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Nome" htmlFor="ct-plano-nome">
              <Input
                id="ct-plano-nome"
                disabled={!editavel}
                maxLength={200}
                value={nome}
                onChange={(e) => {
                  setNome(e.target.value);
                  setSujo(true);
                }}
              />
            </Field>
            <Field label="Fonte" htmlFor="ct-plano-fonte" hint="Ex.: Plano Municipal de Contingência das Arboviroses 2026, aprovado pelo CMS.">
              <Input
                id="ct-plano-fonte"
                disabled={!editavel}
                maxLength={500}
                value={fonte}
                onChange={(e) => {
                  setFonte(e.target.value);
                  setSujo(true);
                }}
              />
            </Field>
          </div>
          <div className="space-y-1 text-sm">
            <p className="font-medium text-slate-800">Estágios</p>
            <p className="flex flex-wrap gap-1.5">
              {estagios.map((e) => (
                <span key={e.chave}>{selo(e.chave)}</span>
              ))}
            </p>
          </div>
          <p className="text-sm text-slate-700">
            <span className="font-medium text-slate-800">Agravos do plano:</span> {def.agravos.map((g) => nomeDoAgravo(opcoes, g)).join(', ')}
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Como os critérios se combinam" htmlFor="ct-plano-combinacao">
              <Select id="ct-plano-combinacao" disabled={!editavel} value={def.combinacao} onChange={(e) => mudar({ ...def, combinacao: e.target.value as PlanoContingencia['combinacao'] })}>
                <option value="QUALQUER">Qualquer critério atendido basta (o “E/OU” do MS)</option>
                <option value="DOIS_OU_MAIS">Dois ou mais no estágio; o mais alto exige todos (SES-MG)</option>
              </Select>
            </Field>
            <div className="grid grid-cols-[8rem_1fr] gap-2">
              <CampoNumero
                id="ct-plano-desmob-semanas"
                rotulo="Desmobilização (SE)"
                disabled={!editavel}
                valor={def.desmobilizacao.semanas}
                onChange={(semanas) => mudar({ ...def, desmobilizacao: { ...def.desmobilizacao, semanas: semanas ?? 0 } })}
              />
              <Field label="Regra da desmobilização" htmlFor="ct-plano-desmob">
                <Input
                  id="ct-plano-desmob"
                  className="h-9"
                  disabled={!editavel}
                  maxLength={1000}
                  value={def.desmobilizacao.descricao}
                  onChange={(e) => mudar({ ...def, desmobilizacao: { ...def.desmobilizacao, descricao: e.target.value } })}
                />
              </Field>
            </div>
          </div>
          {editavel && sujo && erros.length > 0 && (
            <Alert tone="warn" title="Corrija antes de salvar">
              <ul className="list-inside list-disc space-y-0.5">
                {erros.slice(0, 12).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          )}
          {erro && <Alert tone="error">{erro}</Alert>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Critérios por estágio"
          description="A normalidade não tem critério: é o estado padrão. Os critérios automáticos usam o diagrama de controle e os indicadores; os manuais são respondidos pela vigilância toda semana."
        />
        <div className="divide-y divide-slate-100">
          {estagios
            .filter((e) => e.ordem > 0)
            .map((e) => {
              const criterios = def.criterios.filter((c) => c.estagio === e.chave);
              return (
                <section key={e.chave} className="space-y-2 px-5 py-4" aria-label={`Critérios do estágio ${e.nome}`}>
                  <p className="flex items-center gap-2">{selo(e.chave)}</p>
                  {criterios.map((c) => (
                    <div key={c.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="text-xs text-slate-500">
                          {ROTULO_TIPO_CRITERIO[c.tipo]} · {c.agravos.length ? c.agravos.map((g) => nomeDoAgravo(opcoes, g)).join(', ') : 'todos os agravos do plano'} · {c.id}
                        </span>
                        {editavel && c.tipo === 'MANUAL' && (
                          <Button size="sm" variant="ghost" className="h-7 text-red-700" onClick={() => mudar(removerCriterio(def, c.id))}>
                            <Trash2 className="h-4 w-4" /> Remover
                          </Button>
                        )}
                      </div>
                      {editavel ? (
                        <Textarea aria-label={`Descrição do critério ${c.id}`} rows={2} maxLength={500} value={c.descricao} onChange={(ev) => mudar(trocarCriterio(def, c.id, { descricao: ev.target.value }))} />
                      ) : (
                        <p className="text-sm text-slate-900">{c.descricao}</p>
                      )}
                      {editavel ? (
                        <ParametrosCriterio c={c} onChange={(patch) => mudar(trocarCriterio(def, c.id, patch))} />
                      ) : (
                        c.tipo !== 'MANUAL' && <p className="text-xs text-slate-700">Exige: {exigenciaDoCriterio(c)}</p>
                      )}
                      {c.fonte && <p className="text-[11px] text-slate-500">{c.fonte}</p>}
                    </div>
                  ))}
                  {criterios.length === 0 && <p className="text-sm text-slate-600">Nenhum critério neste estágio.</p>}
                  {editavel && <Inclusao id={`ct-plano-novo-${e.chave}`} rotulo="Novo critério manual (respondido toda semana)" minimo={5} onIncluir={(t) => mudar(incluirCriterioManual(def, e.chave, t))} />}
                </section>
              );
            })}
        </div>
      </Card>

      <Card>
        <CardHeader title="Ações por estágio e eixo" description='Viram o checklist no acionamento: as do estágio e as dos anteriores ("manter e intensificar").' />
        <div className="divide-y divide-slate-100">
          {porEstagio.map((g) => (
            <section key={g.estagio.chave} className="space-y-3 px-5 py-4" aria-label={`Ações do estágio ${g.estagio.nome}`}>
              <p>{selo(g.estagio.chave)}</p>
              {g.eixos.length === 0 && <p className="text-sm text-slate-600">Nenhuma ação neste estágio.</p>}
              {g.eixos.map((eixo) => (
                <div key={eixo.eixo} className="space-y-1.5">
                  <p className="text-sm font-medium text-slate-800">{eixo.rotulo}</p>
                  <ul className="space-y-1.5">
                    {eixo.acoes.map(({ indice, acao }) => (
                      <li key={indice} className="flex items-start gap-2">
                        {editavel ? (
                          <>
                            <Input aria-label="Descrição da ação" className="h-9" maxLength={500} value={acao.descricao} onChange={(ev) => mudar(trocarAcao(def, indice, { descricao: ev.target.value }))} />
                            <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0 text-red-700" aria-label="Remover a ação" onClick={() => mudar(removerAcao(def, indice))}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <span className="text-sm text-slate-800">{acao.descricao}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {editavel && (
                <Inclusao
                  id={`ct-plano-acao-${g.estagio.chave}`}
                  rotulo="Nova ação"
                  minimo={3}
                  onIncluir={(t) => mudar(incluirAcao(def, { estagio: g.estagio.chave, eixo: eixoNovo[g.estagio.chave] ?? 'VIGILANCIA', descricao: t }))}
                >
                  <Field label="Eixo" htmlFor={`ct-plano-acao-eixo-${g.estagio.chave}`}>
                    <Select
                      id={`ct-plano-acao-eixo-${g.estagio.chave}`}
                      className={cn('h-9 w-56')}
                      value={eixoNovo[g.estagio.chave] ?? 'VIGILANCIA'}
                      onChange={(ev) => setEixoNovo({ ...eixoNovo, [g.estagio.chave]: ev.target.value as EixoAcao })}
                    >
                      {EIXOS.map((x) => (
                        <option key={x} value={x}>
                          {ROTULO_EIXO_ACAO[x]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </Inclusao>
              )}
            </section>
          ))}
        </div>
      </Card>
      {vigencia && (
        <PorEmVigor
          plano={plano}
          onFechar={() => setVigencia(false)}
          onFeito={(p) => {
            setVigencia(false);
            onVigente(p);
          }}
        />
      )}
    </div>
  );
}

/** Planos de contingência: lista, rascunho a partir do modelo do MS (2025), cópia, edição e vigência. */
export function ContingenciaPlano({ podeAgir, opcoes, onVigenteMudou }: { podeAgir: boolean; opcoes: OpcaoAgravo[]; onVigenteMudou: () => void }) {
  const toast = useToast();
  const planos = useApi<ListaPlanos>('/vigilancia/contingencia/planos');
  const [sel, setSel] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [versaoEditor, setVersaoEditor] = useState(0);
  const atual = sel ?? planos.data?.find((p) => p.status === 'VIGENTE')?.id ?? planos.data?.[0]?.id ?? null;
  const detalhe = useApi<DetalhePlano>(atual ? `/vigilancia/contingencia/planos/${atual}` : null);
  const mostrado = detalhe.data && detalhe.data.id === atual ? detalhe.data : null;

  async function novoDoModelo() {
    setCriando(true);
    try {
      const p = await api.post<DetalhePlano>('/vigilancia/contingencia/planos', { modelo: 'MS_2025' });
      toast.success(`Rascunho criado a partir do modelo do MS (versão ${p.versao}).`);
      setSel(p.id);
      void planos.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCriando(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Planos de contingência das arboviroses"
          description="O plano é dado, não código: estágios, critérios com limiar e semanas, e ações por eixo. Carregue o modelo do MS (Apêndice B, 2025) e ajuste ao plano municipal."
          actions={
            podeAgir ? (
              <Button size="sm" onClick={novoDoModelo} loading={criando}>
                <FilePlus2 className="h-4 w-4" /> Novo rascunho do modelo do MS
              </Button>
            ) : undefined
          }
        />
        {planos.loading && !planos.data && <Spinner />}
        {planos.error && (
          <CardBody>
            <Alert tone="error">{planos.error}</Alert>
          </CardBody>
        )}
        {planos.data && planos.data.length === 0 && (
          <EmptyState title="Nenhum plano cadastrado" description={podeAgir ? 'Crie um rascunho a partir do modelo do MS, revise e ponha em vigor.' : 'A vigilância epidemiológica cria e põe o plano em vigor.'} />
        )}
        {!!planos.data?.length && (
          <Table>
            <THead>
              <tr>
                <TH>Plano</TH>
                <TH>Versão</TH>
                <TH>Situação</TH>
                <TH>Vigência</TH>
                <TH>Atualizado em</TH>
              </tr>
            </THead>
            <TBody>
              {planos.data.map((p) => (
                <TR key={p.id} className={cn('cursor-pointer', p.id === atual && 'bg-brand-50 hover:bg-brand-50')} onClick={() => setSel(p.id)}>
                  <TD>
                    <button type="button" className="text-left font-medium text-brand-700 hover:underline" onClick={() => setSel(p.id)} aria-current={p.id === atual ? 'true' : undefined}>
                      {p.nome}
                    </button>
                  </TD>
                  <TD className="tabular-nums">{p.versao}</TD>
                  <TD>
                    <Badge tone={TOM_STATUS_PLANO[p.status]}>{ROTULO_STATUS_PLANO[p.status]}</Badge>
                  </TD>
                  <TD className="text-xs">{textoVigencia(p)}</TD>
                  <TD className="text-xs">{fmtDateTime(p.atualizadoEm)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {atual && detalhe.error && <Alert tone="error">{detalhe.error}</Alert>}
      {atual && !mostrado && detalhe.loading && <Spinner label="Abrindo o plano…" />}
      {mostrado && (
        <EditorPlano
          key={`${mostrado.id}-${mostrado.atualizadoEm}-${versaoEditor}`}
          plano={mostrado}
          podeAgir={podeAgir}
          opcoes={opcoes}
          onSalvo={(p) => {
            detalhe.setData(p);
            setVersaoEditor((v) => v + 1);
            void planos.reload();
          }}
          onCopiado={(p) => {
            setSel(p.id);
            void planos.reload();
          }}
          onVigente={(p) => {
            detalhe.setData(p);
            void planos.reload();
            onVigenteMudou();
          }}
        />
      )}
    </div>
  );
}
