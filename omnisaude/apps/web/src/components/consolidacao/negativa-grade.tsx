'use client';

import { deslocarSemana, semanaEpidemiologica, semanasEntre, type AtestoNegativa, type CelulaGrade, type ColunaGrade, type LinhaGradeNegativa, type RespostaGradeNegativa } from '@omnisaude/shared';
import { AlertTriangle, CheckCircle2, Download, FileWarning } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, Stat } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import {
  CELULA,
  cartoesDaGrade,
  DESCRICAO_SITUACAO,
  filtrarLinhas,
  LEGENDA_GRADE,
  percentuaisDaGrade,
  podeAtestarEmNome,
  rotuloColuna,
  rotuloSemana,
  semanasParaSeletor,
  textoFontes,
  tituloCelula,
  type FiltroGrade,
} from './negativa-regras';

const MINIMO_MOTIVO = 10;

interface CelulaAberta {
  linha: LinhaGradeNegativa;
  celula: CelulaGrade;
  coluna: ColunaGrade;
}

/** Detalhe da célula: as fontes e, para a vigilância, anular o atesto ou atestar em nome da unidade. */
function CelulaDialog({ aberta, podeConfigurar, onFechar, onMudou }: { aberta: CelulaAberta; podeConfigurar: boolean; onFechar: () => void; onMudou: () => void }) {
  const toast = useToast();
  const { linha, celula, coluna } = aberta;
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState<'anular' | 'atestar' | 'pdf' | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const atesto = celula.fontes.atesto;
  const emNome = podeConfigurar && podeAtestarEmNome(celula, coluna);
  const falta = Math.max(0, MINIMO_MOTIVO - motivo.trim().length);
  const { titulo, periodo } = rotuloColuna(coluna);

  async function anular() {
    if (!atesto) return;
    setBusy('anular');
    setErro(null);
    try {
      await api.post<AtestoNegativa>(`/vigilancia/negativas/${atesto.id}/anular`, { motivo: motivo.trim() });
      toast.success(`Atesto da ${titulo} de ${linha.unidade.nome} anulado.`);
      onFechar();
      onMudou();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function atestarEmNome() {
    setBusy('atestar');
    setErro(null);
    try {
      await api.post<AtestoNegativa>('/vigilancia/negativas', { unitId: linha.unidade.id, semana: celula.semana, emNome: { motivo: motivo.trim() } });
      toast.success(`Negativa da ${titulo} registrada em nome de ${linha.unidade.nome}.`);
      onFechar();
      onMudou();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function pdf() {
    if (!atesto) return;
    setBusy('pdf');
    try {
      const { blob, fileName } = await api.download(`/vigilancia/negativas/${atesto.id}/espelho.pdf`);
      saveBlob(blob, fileName ?? `negativa-${linha.unidade.cnes}-${celula.semana}.pdf`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onFechar()} title={`${linha.unidade.nome} · ${titulo}`} description={`CNES ${linha.unidade.cnes} · de ${periodo} · prazo do atesto: ${fmtDateTime(coluna.prazo)}`}>
      <div className="space-y-3 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded px-2 py-0.5 text-xs', CELULA[celula.situacao].classe)}>{CELULA[celula.situacao].texto}</span>
          <span className="text-slate-600">{DESCRICAO_SITUACAO[celula.situacao]}</span>
        </p>
        <p>
          <span className="font-medium">Fontes da semana:</span> {textoFontes(celula.fontes)}.
        </p>
        {/* O espelho é de quem atestou, dos responsáveis da unidade e da vigilância (a API confere). */}
        {atesto && podeConfigurar && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={pdf} loading={busy === 'pdf'}>
              <Download className="h-4 w-4" /> Espelho do atesto (PDF)
            </Button>
          </div>
        )}
        {podeConfigurar && atesto && (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="font-medium">Anular o atesto</p>
            <p className="text-xs text-slate-600">Use quando o atesto foi feito por engano. A anulação fica registrada com o motivo e a semana volta a ficar sem informação.</p>
            <Field label="Motivo" htmlFor="neg-anular-motivo" hint={falta ? `Pelo menos ${MINIMO_MOTIVO} caracteres (faltam ${falta}).` : undefined}>
              <Textarea id="neg-anular-motivo" rows={2} maxLength={1000} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            </Field>
            <Button size="sm" variant="danger" disabled={falta > 0} loading={busy === 'anular'} onClick={anular}>
              Anular o atesto
            </Button>
          </div>
        )}
        {emNome && (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="font-medium">Atestar em nome da unidade</p>
            <p className="text-xs text-slate-600">
              Para quando a unidade informou a negativa por outro meio (telefone, e-mail, planilha). O atesto fica marcado como feito pela vigilância, com o motivo. A API recusa a semana fora do período de atesto ou com
              notificação.
            </p>
            <Field label="Motivo" htmlFor="neg-emnome-motivo" hint={falta ? `Pelo menos ${MINIMO_MOTIVO} caracteres (faltam ${falta}).` : undefined}>
              <Textarea id="neg-emnome-motivo" rows={2} maxLength={500} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: negativa informada por telefone pela enfermeira responsável." />
            </Field>
            <Button size="sm" disabled={falta > 0} loading={busy === 'atestar'} onClick={atestarEmNome}>
              <CheckCircle2 className="h-4 w-4" /> Atestar em nome da unidade
            </Button>
          </div>
        )}
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/** Cartão com a lista de unidades (silenciosas ou só negativas). */
function ListaUnidades({ titulo, descricao, itens, vazio, tom }: { titulo: string; descricao: string; itens: { id: string; nome: string; detalhe: string }[]; vazio: string; tom: 'red' | 'amber' }) {
  return (
    <Card>
      <CardHeader title={titulo} description={descricao} />
      <CardBody className="pt-3">
        {itens.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-800">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> {vazio}
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {itens.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{i.nome}</span>
                <Badge tone={tom}>{i.detalhe}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/** Grade unidade × semana da notificação negativa, com a meta, as silenciosas e a regularidade do município. */
export function NegativaGrade({ podeConfigurar }: { podeConfigurar: boolean }) {
  const session = useSession();
  const tz = session.me?.tenant.timeZone ?? 'America/Sao_Paulo';
  const semanaAtual = useMemo(() => semanaEpidemiologica(new Date(), tz).codigo, [tz]);
  const opcoesAte = useMemo(() => semanasParaSeletor(semanasEntre(deslocarSemana(semanaAtual, -52), semanaAtual)), [semanaAtual]);
  const [qtd, setQtd] = useState(12);
  const [ate, setAte] = useState('');
  const [filtro, setFiltro] = useState<FiltroGrade>('TODAS');
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState<CelulaAberta | null>(null);
  const g = useApi<RespostaGradeNegativa>(`/vigilancia/negativas/grade?${new URLSearchParams({ semanas: String(qtd), ...(ate ? { ate } : {}) })}`);
  const dados = g.data;
  // O relógio da tela só decide se a meta da semana já se julga (prazo vencido); a situação de cada célula vem da API.
  const agora = useMemo(() => new Date(), [dados]);
  const cartoes = useMemo(() => (dados ? cartoesDaGrade(dados, agora) : null), [dados, agora]);
  const percentuais = useMemo(() => (dados ? percentuaisDaGrade(dados, agora) : []), [dados, agora]);
  const linhas = useMemo(() => (dados ? filtrarLinhas(dados, filtro, busca) : []), [dados, filtro, busca]);
  const silenciosas = useMemo(() => new Set(dados?.analise.silenciosas.map((s) => s.unitId) ?? []), [dados]);
  const soNegativas = useMemo(() => new Set(dados?.analise.soNegativas.map((s) => s.unitId) ?? []), [dados]);

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Semanas na grade" htmlFor="neg-qtd">
            <Select id="neg-qtd" value={qtd} onChange={(e) => setQtd(Number(e.target.value))}>
              {[8, 12, 26, 52].map((n) => (
                <option key={n} value={n}>
                  {n} semanas
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Até a semana" htmlFor="neg-ate">
            <Select id="neg-ate" value={ate || semanaAtual} onChange={(e) => setAte(e.target.value === semanaAtual ? '' : e.target.value)}>
              {opcoesAte.map((o) => (
                <option key={o.valor} value={o.valor}>
                  {o.rotulo}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mostrar" htmlFor="neg-filtro">
            <Select id="neg-filtro" value={filtro} onChange={(e) => setFiltro(e.target.value as FiltroGrade)}>
              <option value="TODAS">Todas as unidades</option>
              <option value="SILENCIOSAS">Só as silenciosas</option>
              <option value="SO_NEGATIVAS">Só as que só mandam negativa</option>
              <option value="SEM_INFORMACAO">Com alguma semana sem informação</option>
            </Select>
          </Field>
          <Field label="Buscar unidade" htmlFor="neg-busca">
            <Input id="neg-busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nome ou CNES" />
          </Field>
        </CardBody>
      </Card>

      {g.error && !g.loading && <Alert tone="error">{g.error}</Alert>}
      {!dados && g.loading && <Spinner label="Montando a grade…" />}

      {dados && cartoes && (
        <div className={g.loading ? 'space-y-4 opacity-60 transition-opacity' : 'space-y-4 transition-opacity'} aria-busy={g.loading}>
          {dados.avisos.length > 0 && (
            <Alert tone="warn" title="Avisos">
              <ul className="list-inside list-disc space-y-0.5">
                {dados.avisos.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Alert>
          )}

          <div className="grid gap-3 md:grid-cols-3">
            <Stat label="Unidades notificantes na grade" value={dados.linhas.length} />
            <Stat
              label="Unidades com informação"
              value={cartoes.ultimaFechada?.texto ?? '—'}
              tone={cartoes.ultimaFechada?.abaixoDaMeta ? 'bad' : cartoes.ultimaFechada?.abaixoDaMeta === false ? 'good' : 'default'}
              hint={
                cartoes.ultimaFechada
                  ? `SE ${rotuloSemana(cartoes.ultimaFechada.semana)}: ${cartoes.ultimaFechada.comInformacao} de ${cartoes.ultimaFechada.notificantes}; meta ${dados.metaPercentual}%`
                  : 'Nenhuma semana da grade com o prazo vencido'
              }
            />
            <Stat
              label="Regularidade do município"
              value={dados.analise.regularidadeMunicipal.irregular ? 'Irregular' : 'Regular'}
              tone={dados.analise.regularidadeMunicipal.irregular ? 'bad' : dados.analise.regularidadeMunicipal.semanasSemInformacao ? 'warn' : 'good'}
              hint={cartoes.regularidade.texto}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ListaUnidades
              titulo="Unidades silenciosas"
              descricao="Semanas fechadas seguidas sem notificação nem atesto, até a última com o prazo vencido. Pedem busca ativa e visita técnica."
              itens={cartoes.silenciosas.map((s) => ({ id: s.unidade.id, nome: s.unidade.nome, detalhe: `${s.semanasSeguidas} semana(s) sem informação` }))}
              vazio="Nenhuma unidade silenciosa nas semanas da grade."
              tom="red"
            />
            <ListaUnidades
              titulo="Só negativas"
              descricao="Unidades que só atestam negativa há muitas semanas: o manual do Sinan manda fazer busca ativa nelas."
              itens={cartoes.soNegativas.map((s) => ({ id: s.unidade.id, nome: s.unidade.nome, detalhe: `${s.semanas} semana(s) só com negativa` }))}
              vazio="Nenhuma unidade só com negativas no período."
              tom="amber"
            />
          </div>

          <Card>
            <CardHeader title="Unidades × semanas" description="Toque na célula para ver as fontes da semana. A semana com notificação é positiva; sem notificação, vale o atesto do responsável até o prazo." />
            {linhas.length === 0 ? (
              <EmptyState title={dados.linhas.length ? 'Nenhuma unidade com este filtro' : 'Nenhuma unidade notificante no período'} />
            ) : (
              <Table className="text-xs">
                <THead>
                  <tr>
                    <TH className="sticky left-0 z-10 min-w-[14rem] bg-slate-50">Unidade</TH>
                    {dados.colunas.map((c) => {
                      const r = rotuloColuna(c);
                      return (
                        <TH key={c.semana} className="min-w-[6.5rem] text-center">
                          <span className="block">{r.titulo}</span>
                          <span className="block font-normal normal-case">{r.periodo}</span>
                        </TH>
                      );
                    })}
                  </tr>
                </THead>
                <TBody>
                  {linhas.map((l) => (
                    <TR key={l.unidade.id}>
                      <TD className="sticky left-0 z-10 bg-white">
                        <span className="block text-sm font-medium text-slate-900">{l.unidade.nome}</span>
                        <span className="block text-slate-500">
                          CNES {l.unidade.cnes} · {l.tipoUnidade}
                        </span>
                        <span className="mt-1 flex flex-wrap gap-1">
                          {silenciosas.has(l.unidade.id) && (
                            <Badge tone="red">
                              <AlertTriangle className="h-3 w-3" aria-hidden /> Silenciosa
                            </Badge>
                          )}
                          {soNegativas.has(l.unidade.id) && <Badge tone="amber">Só negativas</Badge>}
                        </span>
                      </TD>
                      {l.celulas.map((c, i) => {
                        const coluna = dados.colunas[i]!;
                        const titulo = tituloCelula(l.unidade, c);
                        return (
                          <TD key={c.semana} className="p-1 align-middle">
                            <button
                              type="button"
                              className={cn('w-full rounded px-1.5 py-1.5 text-center leading-tight hover:brightness-95 focus-visible:outline-2', CELULA[c.situacao].classe)}
                              title={titulo}
                              aria-label={titulo}
                              onClick={() => setAberta({ linha: l, celula: c, coluna })}
                            >
                              {CELULA[c.situacao].texto}
                              {c.situacao === 'POSITIVA' && c.fontes.notificacoes + c.fontes.surtos + c.fontes.registrosOficiais > 1 && (
                                <span className="block text-[11px] font-normal">{c.fontes.notificacoes + c.fontes.surtos + c.fontes.registrosOficiais} registros</span>
                              )}
                              {c.fontes.negativaSinan && !c.fontes.atesto && <span className="block text-[11px] font-normal">no Sinan</span>}
                            </button>
                          </TD>
                        );
                      })}
                    </TR>
                  ))}
                  <TR className="bg-slate-50 hover:bg-slate-50">
                    <TD className="sticky left-0 z-10 bg-slate-50 text-sm font-medium text-slate-900">
                      % com informação
                      <span className="block text-xs font-normal text-slate-500">Meta: {dados.metaPercentual}% das unidades notificantes (positiva ou negativa)</span>
                    </TD>
                    {percentuais.map((p) => (
                      <TD key={p.semana} className="text-center align-middle">
                        <span className={cn('text-sm tabular-nums', p.abaixoDaMeta ? 'font-semibold text-red-700' : p.abaixoDaMeta === false ? 'font-medium text-emerald-800' : 'text-slate-700')}>{p.texto}</span>
                        {p.notificantes > 0 && (
                          <span className="block text-[11px] text-slate-500">
                            {p.comInformacao} de {p.notificantes}
                          </span>
                        )}
                        {p.abaixoDaMeta !== null && <span className="block text-[11px] text-slate-600">{p.abaixoDaMeta ? 'abaixo da meta' : 'meta atingida'}</span>}
                      </TD>
                    ))}
                  </TR>
                </TBody>
              </Table>
            )}
            <CardBody className="border-t border-slate-100">
              <p className="mb-2 text-xs font-medium text-slate-700">Legenda</p>
              <ul className="grid gap-1.5 text-xs text-slate-700 sm:grid-cols-2 lg:grid-cols-3">
                {LEGENDA_GRADE.map((s) => (
                  <li key={s} className="flex items-start gap-2">
                    <span className={cn('inline-block min-w-[6.5rem] shrink-0 rounded px-1.5 py-0.5 text-center', CELULA[s].classe)}>{CELULA[s].texto}</span>
                    <span>{DESCRICAO_SITUACAO[s]}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <DiferencasSinan titulo="Atestado e não digitado no Sinan" descricao="Atesto no OmniSaúde sem a negativa no Sinan Net (NNEGANET importado). Digite a negativa no Sinan." itens={dados.atestadoSemSinan} />
            <DiferencasSinan titulo="Digitado no Sinan sem atesto" descricao="Negativa digitada no Sinan Net sem o atesto do responsável no OmniSaúde." itens={dados.sinanSemAtesto} />
          </div>
        </div>
      )}
      {aberta && <CelulaDialog key={`${aberta.linha.unidade.id}-${aberta.celula.semana}`} aberta={aberta} podeConfigurar={podeConfigurar} onFechar={() => setAberta(null)} onMudou={() => void g.reload()} />}
    </div>
  );
}

function DiferencasSinan({ titulo, descricao, itens }: { titulo: string; descricao: string; itens: RespostaGradeNegativa['atestadoSemSinan'] }) {
  return (
    <Card>
      <CardHeader title={titulo} description={descricao} />
      {itens.length === 0 ? (
        <CardBody className="pt-3 text-sm text-slate-600">Nenhuma diferença nas semanas da grade.</CardBody>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Unidade</TH>
              <TH>CNES</TH>
              <TH>Semana</TH>
            </tr>
          </THead>
          <TBody>
            {itens.map((d) => (
              <TR key={`${d.unidade.id}-${d.semana}`}>
                <TD>
                  <span className="inline-flex items-center gap-1.5">
                    <FileWarning className="h-4 w-4 text-amber-600" aria-hidden /> {d.unidade.nome}
                  </span>
                </TD>
                <TD className="tabular-nums">{d.unidade.cnes}</TD>
                <TD className="tabular-nums">SE {rotuloSemana(d.semana)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
