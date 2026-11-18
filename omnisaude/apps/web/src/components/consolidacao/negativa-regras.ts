import {
  arredondar,
  ROTULO_SITUACAO_UNIDADE_SEMANA,
  ROTULO_STATUS_ATESTO,
  UNIT_TYPE_LABELS,
  type AtestoNegativa,
  type CelulaGrade,
  type ColunaGrade,
  type FontesCelula,
  type LinhaGradeNegativa,
  type PeriodoNotificante,
  type ResponsavelNegativa,
  type RespostaGradeNegativa,
  type RespostaMinhasNegativas,
  type SemanaParaAtestar,
  type SituacaoUnidadeSemana,
  type StatusAtesto,
  type UnidadeNotificante,
  type UnidadeRef,
  type UnitType,
  type UsuarioLotado,
} from '@omnisaude/shared';
import { fmtDateTimeTz } from '@/lib/format';

/*
 * Regras da notificação negativa sem React (testadas em apps/web/test/negativa-regras.test.ts): cores e textos da
 * grade unidade × semana, linha do percentual com a meta, cartões (silenciosas, só negativas, regularidade), filtros,
 * configuração das unidades notificantes e dos responsáveis, e a tela do responsável.
 */

export type Tom = 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

/** Data civil AAAA-MM-DD como dd/mm/aaaa (ou dd/mm sem o ano). */
export const dataBr = (iso: string | null | undefined, comAno = true) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}${comAno ? `/${iso.slice(0, 4)}` : ''}` : '—');
/** Semana AAAASS como SS/AAAA. */
export const rotuloSemana = (semana: string) => `${semana.slice(4)}/${semana.slice(0, 4)}`;

/** Cor e texto de cada situação da célula: o texto vai sempre junto da cor (acessibilidade). Contraste AA nos dois tons. */
export const CELULA: Record<SituacaoUnidadeSemana, { texto: string; classe: string }> = {
  POSITIVA: { texto: ROTULO_SITUACAO_UNIDADE_SEMANA.POSITIVA, classe: 'bg-sky-100 text-sky-900' },
  NEGATIVA: { texto: ROTULO_SITUACAO_UNIDADE_SEMANA.NEGATIVA, classe: 'bg-emerald-100 text-emerald-900' },
  NEGATIVA_ATRASADA: { texto: ROTULO_SITUACAO_UNIDADE_SEMANA.NEGATIVA_ATRASADA, classe: 'bg-amber-100 text-amber-900' },
  SEM_INFORMACAO: { texto: ROTULO_SITUACAO_UNIDADE_SEMANA.SEM_INFORMACAO, classe: 'bg-red-100 text-red-900 font-semibold' },
  AGUARDANDO: { texto: ROTULO_SITUACAO_UNIDADE_SEMANA.AGUARDANDO, classe: 'bg-slate-100 text-slate-700' },
  EM_CURSO: { texto: ROTULO_SITUACAO_UNIDADE_SEMANA.EM_CURSO, classe: 'bg-white text-slate-600 border border-dashed border-slate-300' },
  NAO_NOTIFICANTE: { texto: ROTULO_SITUACAO_UNIDADE_SEMANA.NAO_NOTIFICANTE, classe: 'bg-slate-50 text-slate-600' },
};

/** Ordem da legenda. */
export const LEGENDA_GRADE: SituacaoUnidadeSemana[] = ['POSITIVA', 'NEGATIVA', 'NEGATIVA_ATRASADA', 'SEM_INFORMACAO', 'AGUARDANDO', 'EM_CURSO', 'NAO_NOTIFICANTE'];

export const DESCRICAO_SITUACAO: Record<SituacaoUnidadeSemana, string> = {
  POSITIVA: 'Teve notificação, surto ou registro oficial na semana.',
  NEGATIVA: 'Atesto da negativa no prazo (ou negativa digitada no Sinan).',
  NEGATIVA_ATRASADA: 'Atesto da negativa depois do prazo.',
  SEM_INFORMACAO: 'Prazo vencido sem notificação nem atesto.',
  AGUARDANDO: 'Semana terminada, ainda dentro do prazo do atesto.',
  EM_CURSO: 'Semana ainda não terminou.',
  NAO_NOTIFICANTE: 'Fora do período de unidade notificante.',
};

/** Tom do selo da situação (tela do responsável). */
export const TOM_SITUACAO: Record<SituacaoUnidadeSemana, Tom> = {
  POSITIVA: 'blue',
  NEGATIVA: 'green',
  NEGATIVA_ATRASADA: 'amber',
  SEM_INFORMACAO: 'red',
  AGUARDANDO: 'slate',
  EM_CURSO: 'slate',
  NAO_NOTIFICANTE: 'slate',
};

export const TOM_STATUS_ATESTO: Record<StatusAtesto, Tom> = { ATESTADA: 'green', CANCELADA: 'amber', ANULADA: 'red' };

/** Tipo do estabelecimento pelo nome ("Policlínica / especialidades"), não pelo código do cadastro. */
export const rotuloTipoUnidade = (tipo: string | null | undefined) => (tipo ? (UNIT_TYPE_LABELS[tipo as UnitType] ?? tipo) : '—');

/**
 * Linha da semana na tela do responsável: quando foi atestada, o prazo vencido ou o prazo. Os instantes saem no fuso da
 * instituição (`tz`), o mesmo em que a API calcula o prazo e o PDF do atesto o mostra.
 */
export function textoDaSemanaDoResponsavel(s: Pick<SemanaParaAtestar, 'atesto' | 'prazo' | 'prazoPassou' | 'podeAtestar'>, tz: string): string {
  if (s.atesto) return `Atestada em ${fmtDateTimeTz(s.atesto.atestadoEm, tz)} por ${s.atesto.atestadoPor}${s.atesto.atrasado ? ', fora do prazo' : ', no prazo'}${s.atesto.emNome ? ' (registrada pela vigilância)' : ''}.`;
  if (s.prazoPassou) return `Prazo vencido em ${fmtDateTimeTz(s.prazo, tz)}${s.podeAtestar ? ': o atesto ainda é aceito e fica marcado como fora do prazo.' : '.'}`;
  return `Prazo: ${fmtDateTimeTz(s.prazo, tz)}.`;
}

/**
 * Subtítulo do detalhe da célula da grade, no fuso da instituição: CNES, período da semana, o prazo da semana (o da
 * coluna, pela regra de agora) e, com atesto, o prazo do atesto (o gravado com ele, que decidiu o "fora do prazo").
 */
export function descricaoDaCelula(
  linha: Pick<LinhaGradeNegativa, 'unidade'>,
  coluna: Pick<ColunaGrade, 'semana' | 'inicio' | 'fim' | 'prazo'>,
  tz: string,
  atesto?: Pick<NonNullable<FontesCelula['atesto']>, 'prazo'> | null,
): string {
  const semana = `CNES ${linha.unidade.cnes} · de ${rotuloColuna(coluna).periodo} · prazo da semana: ${fmtDateTimeTz(coluna.prazo, tz)}`;
  return atesto ? `${semana} · prazo do atesto: ${fmtDateTimeTz(atesto.prazo, tz)}` : semana;
}

/** Por que o prazo do atesto difere do prazo da semana (a regra mudou depois do atesto); null quando são o mesmo. */
export function notaPrazoDoAtesto(coluna: Pick<ColunaGrade, 'prazo'>, atesto: Pick<NonNullable<FontesCelula['atesto']>, 'prazo'> | null | undefined): string | null {
  if (!atesto || Date.parse(atesto.prazo) === Date.parse(coluna.prazo)) return null;
  return 'O prazo do atesto é o que valia quando ele foi feito; a regra do prazo mudou depois.';
}

/** Cabeçalho da coluna: "SE 44/2026" e o período "dd/mm a dd/mm". */
export function rotuloColuna(c: Pick<ColunaGrade, 'semana' | 'inicio' | 'fim'>): { titulo: string; periodo: string } {
  return { titulo: `SE ${rotuloSemana(c.semana)}`, periodo: `${dataBr(c.inicio, false)} a ${dataBr(c.fim, false)}` };
}

/** Fontes da célula em texto ("2 notificações, atesto no prazo"). */
export function textoFontes(f: FontesCelula): string {
  const partes: string[] = [];
  if (f.notificacoes) partes.push(`${f.notificacoes} ${f.notificacoes === 1 ? 'notificação' : 'notificações'}`);
  if (f.surtos) partes.push(`${f.surtos} ${f.surtos === 1 ? 'surto' : 'surtos'}`);
  if (f.registrosOficiais) partes.push(`${f.registrosOficiais} ${f.registrosOficiais === 1 ? 'registro oficial' : 'registros oficiais'}`);
  if (f.atesto) partes.push(f.atesto.atrasado ? 'atesto fora do prazo' : 'atesto no prazo');
  if (f.negativaSinan) partes.push('negativa digitada no Sinan');
  return partes.length ? partes.join(', ') : 'nenhuma informação';
}

/** Rótulo acessível da célula; `unidade.nome` é o nome com que a grade chama a unidade (`nomeDaUnidadeNaTela`). */
export function tituloCelula(unidade: Pick<UnidadeRef, 'nome'>, c: Pick<CelulaGrade, 'semana' | 'situacao' | 'fontes'>): string {
  return `${unidade.nome}, SE ${rotuloSemana(c.semana)}: ${CELULA[c.situacao].texto}. ${textoFontes(c.fontes)}.`;
}

/** Percentual com uma casa (ARRED do Excel), sem casa quando inteiro. */
export const percentualBr = (p: number) => `${arredondar(p, 1).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export interface PercentualColuna {
  semana: string;
  comInformacao: number;
  notificantes: number;
  percentual: number | null;
  texto: string;
  /** null enquanto o prazo da semana não venceu (não se julga a meta) ou sem unidade notificante. */
  abaixoDaMeta: boolean | null;
}

/** Linha do % de unidades com informação por semana, com a meta (só julgada depois do prazo). */
export function percentuaisDaGrade(g: Pick<RespostaGradeNegativa, 'colunas' | 'analise' | 'metaPercentual'>, agora: Date): PercentualColuna[] {
  return g.colunas.map((c, i) => {
    const p = g.analise.percentualPorSemana.find((x) => x.semana === i) ?? null;
    const percentual = p?.percentual ?? null;
    const vencido = Date.parse(c.prazo) < agora.getTime();
    return {
      semana: c.semana,
      comInformacao: p?.comInformacao ?? 0,
      notificantes: p?.notificantes ?? 0,
      percentual,
      texto: percentual === null ? '—' : percentualBr(percentual),
      abaixoDaMeta: percentual === null || !vencido ? null : percentual < g.metaPercentual,
    };
  });
}

export interface CartoesGrade {
  silenciosas: { unidade: UnidadeRef; semanasSeguidas: number }[];
  soNegativas: { unidade: UnidadeRef; semanas: number }[];
  regularidade: { semanasSemInformacao: number; irregular: boolean; texto: string };
  /** A última semana com o prazo vencido (a que vale para a meta). */
  ultimaFechada: PercentualColuna | null;
}

/** Cartões da grade: unidades silenciosas, só negativas, regularidade do município e a meta da última semana fechada. */
export function cartoesDaGrade(g: RespostaGradeNegativa, agora: Date): CartoesGrade {
  const unidade = new Map(g.linhas.map((l) => [l.unidade.id, l.unidade]));
  const nome = (id: string): UnidadeRef => unidade.get(id) ?? { id, nome: 'Unidade', cnes: '' };
  const r = g.analise.regularidadeMunicipal;
  const percentuais = percentuaisDaGrade(g, agora);
  let ultima: PercentualColuna | null = null;
  for (let i = g.colunas.length - 1; i >= 0 && !ultima; i--) if (Date.parse(g.colunas[i]!.prazo) < agora.getTime()) ultima = percentuais[i] ?? null;
  return {
    silenciosas: g.analise.silenciosas
      .map((s) => ({ unidade: nome(s.unitId), semanasSeguidas: s.semanasSeguidas }))
      .sort((a, b) => b.semanasSeguidas - a.semanasSeguidas || a.unidade.nome.localeCompare(b.unidade.nome, 'pt-BR')),
    soNegativas: g.analise.soNegativas.map((s) => ({ unidade: nome(s.unitId), semanas: s.semanas })).sort((a, b) => b.semanas - a.semanas || a.unidade.nome.localeCompare(b.unidade.nome, 'pt-BR')),
    regularidade: {
      ...r,
      texto: r.irregular
        ? `Irregular: ${r.semanasSemInformacao} semanas fechadas seguidas sem nenhuma informação no município (PRC GM/MS nº 6/2017, art. 454-E).`
        : r.semanasSemInformacao
          ? `${r.semanasSemInformacao} semana(s) fechada(s) seguida(s) sem nenhuma informação no município.`
          : 'Regular: o município teve informação na última semana fechada.',
    },
    ultimaFechada: ultima,
  };
}

export type FiltroGrade = 'TODAS' | 'SILENCIOSAS' | 'SO_NEGATIVAS' | 'SEM_INFORMACAO';

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Chave do nome da unidade para saber se duas têm o mesmo nome: sem maiúsculas, acentos e espaços repetidos. */
const chaveDoNome = (nome: string) => normalizar(nome).replace(/\s+/g, ' ');

/**
 * Como os nomes acessíveis de uma tela chamam a unidade: pelo nome e, quando outra unidade da mesma tela tem o mesmo
 * nome (o nome não é único, só o CNES é), pelo nome e o CNES, "Posto de Saúde (CNES 9100001)". `unidades` são todas as
 * da tela, as da lista inteira e não só as que o filtro mostra (o nome do botão não muda com a busca). Maiúsculas,
 * acentos e espaços repetidos não distinguem os nomes (o leitor de tela lê igual); a mesma unidade (o mesmo id) em dois
 * lugares da tela não conta como outra.
 */
export function nomeDaUnidadeNaTela(unidades: Iterable<Pick<UnidadeRef, 'id' | 'nome'>>): (u: Pick<UnidadeRef, 'nome' | 'cnes'>) => string {
  const ids = new Map<string, Set<string>>();
  for (const u of unidades) {
    const chave = chaveDoNome(u.nome);
    ids.set(chave, (ids.get(chave) ?? new Set<string>()).add(u.id));
  }
  return (u) => ((ids.get(chaveDoNome(u.nome))?.size ?? 0) > 1 && u.cnes ? `${u.nome} (CNES ${u.cnes})` : u.nome);
}

/** Linhas da grade pelo filtro e pela busca (nome ou CNES). */
export function filtrarLinhas(g: Pick<RespostaGradeNegativa, 'linhas' | 'analise'>, filtro: FiltroGrade, busca: string): LinhaGradeNegativa[] {
  const silenciosas = new Set(g.analise.silenciosas.map((s) => s.unitId));
  const soNegativas = new Set(g.analise.soNegativas.map((s) => s.unitId));
  const termo = normalizar(busca);
  return g.linhas.filter((l) => {
    if (filtro === 'SILENCIOSAS' && !silenciosas.has(l.unidade.id)) return false;
    if (filtro === 'SO_NEGATIVAS' && !soNegativas.has(l.unidade.id)) return false;
    if (filtro === 'SEM_INFORMACAO' && !l.celulas.some((c) => c.situacao === 'SEM_INFORMACAO')) return false;
    return !termo || normalizar(l.unidade.nome).includes(termo) || l.unidade.cnes.includes(termo);
  });
}

/** A vigilância pode atestar em nome da unidade a semana terminada sem informação nem atesto (a API confere o resto). */
export const podeAtestarEmNome = (c: Pick<CelulaGrade, 'situacao' | 'fontes'>, coluna: Pick<ColunaGrade, 'fechada'>) =>
  coluna.fechada && (c.situacao === 'SEM_INFORMACAO' || c.situacao === 'AGUARDANDO') && !c.fontes.atesto;

/** Semanas para o seletor "até": a semana em curso e as anteriores (AAAASS). */
export function semanasParaSeletor(semanasAteHoje: string[]): { valor: string; rotulo: string }[] {
  return [...semanasAteHoje].reverse().map((s, i) => ({ valor: s, rotulo: `SE ${rotuloSemana(s)}${i === 0 ? ' (em curso)' : ''}` }));
}

// ───────────── Seções e atalhos ─────────────

/** Seções da aba Notificação negativa; `?secao=` na URL abre uma delas (a da permissão de quem abre). */
export type SecaoNegativa = 'grade' | 'unidades' | 'parametros';

/** Atalho para Consolidação e surtos > Notificação negativa > Prazos e parâmetros (usado na gestão da vigilância). */
export const LINK_PARAMETROS_NEGATIVA = '/vigilancia/consolidacao?aba=negativa&secao=parametros';

/** A seção pedida na URL, se a pessoa pode vê-la; senão, a grade. */
export function secaoInicial(pedida: string | null | undefined, disponiveis: string[]): string {
  return pedida && disponiveis.includes(pedida) ? pedida : 'grade';
}

// ───────────── Unidades notificantes e responsáveis ─────────────

export const responsaveisAtivos = (u: Pick<UnidadeNotificante, 'responsaveis'>): ResponsavelNegativa[] => u.responsaveis.filter((r) => r.ate === null);
/**
 * A designação ativa vale (a API marca `valido`: usuário ativo, com lotação ativa na unidade em papel que atesta). A que
 * não vale não deixa ninguém atestar: não conta como titular nem como responsável.
 */
export const designacaoValida = (r: Pick<ResponsavelNegativa, 'valido'>) => r.valido !== false;
export const responsaveisValidos = (u: Pick<UnidadeNotificante, 'responsaveis'>): ResponsavelNegativa[] => responsaveisAtivos(u).filter(designacaoValida);
/** Período aberto (sem fim): a condição da API para designar responsáveis. */
export const periodoAberto = (u: Pick<UnidadeNotificante, 'periodos'>): PeriodoNotificante | null => u.periodos.find((p) => p.ate === null) ?? null;
/** Notificante sem titular cuja designação vale. */
export const semTitular = (u: UnidadeNotificante) => !!periodoAberto(u) && !responsaveisValidos(u).some((r) => r.tipo === 'TITULAR');
/** Notificante sem nenhuma designação que valha: ninguém pode atestar a negativa. */
export const semResponsavel = (u: UnidadeNotificante) => !!periodoAberto(u) && !responsaveisValidos(u).length;
/** O titular ativo cuja designação não vale: designar outro titular encerra a dele hoje (a API faz na mesma transação). */
export const titularQueNaoVale = (u: Pick<UnidadeNotificante, 'responsaveis'>): ResponsavelNegativa | null => responsaveisAtivos(u).find((r) => r.tipo === 'TITULAR' && !designacaoValida(r)) ?? null;
/**
 * Nome acessível do botão "Revogar" de cada responsável: de quem é a designação e de qual unidade (a mesma pessoa pode
 * ser responsável em mais de uma). `unidade` é o nome com que a tela chama a unidade (`nomeDaUnidadeNaTela`: com o
 * CNES quando outra unidade da lista tem o mesmo nome).
 */
export const rotuloRevogar = (r: Pick<ResponsavelNegativa, 'nome'>, unidade: string) => `Revogar a designação de ${r.nome} como responsável da unidade ${unidade}`;
/** Nomes acessíveis dos outros botões que se repetem em cada linha das unidades notificantes (dizem de qual unidade são). */
export const rotuloDesignar = (unidade: string) => `Designar responsável da unidade ${unidade}`;
export const rotuloEncerrarPeriodo = (unidade: string) => `Encerrar o período da unidade ${unidade}`;
export const rotuloTornarNotificante = (unidade: string) => `Tornar ${unidade} notificante`;
/**
 * Nome acessível do botão Atestar da tela do responsável, um por semana: a SE e, quando a tela tem mais de uma unidade,
 * a unidade (o nome com que a tela a chama: `nomesDaTelaDoResponsavel`).
 */
export const rotuloAtestar = (semana: string, unidade?: string) => `Atestar a SE ${rotuloSemana(semana)}${unidade ? `, ${unidade}` : ''}`;

const FUSO_BRASILIA = 'America/Sao_Paulo';

/** Data e hora com os segundos no fuso da instituição; um fuso desconhecido cai no de Brasília, como no `fmtDateTimeTz`. */
function dataHoraComSegundos(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const formato = { dateStyle: 'short', timeStyle: 'medium' } as const;
  try {
    return d.toLocaleString('pt-BR', { ...formato, timeZone: tz || FUSO_BRASILIA });
  } catch {
    return d.toLocaleString('pt-BR', { ...formato, timeZone: FUSO_BRASILIA });
  }
}

/**
 * Nome acessível do botão do espelho em PDF, um por semana ou por atesto: a SE; com `unidade` (o histórico, que junta
 * as unidades, e a tela com mais de uma unidade), a unidade, pelo nome com que a tela a chama; e, no atesto que não é o
 * vigente (anulado ou cancelado), a situação e quando foi atestado, com os segundos, no fuso da instituição (o anulado
 * e o refeito da mesma SE e unidade ficam distintos, e também dois anulados do mesmo minuto).
 */
export function rotuloEspelhoPdf(a: Pick<AtestoNegativa, 'semana' | 'status' | 'atestadoEm'>, tz: string, unidade?: string): string {
  const partes = [`Espelho em PDF da SE ${rotuloSemana(a.semana)}`];
  if (unidade) partes.push(unidade);
  if (a.status !== 'ATESTADA') partes.push(`${ROTULO_STATUS_ATESTO[a.status].toLowerCase()}, atestada em ${dataHoraComSegundos(a.atestadoEm, tz)}`);
  return partes.join(', ');
}

/** Nomes acessíveis dos botões que se repetem na tela do responsável. */
export interface NomesDaTelaDoResponsavel {
  /** O Atestar da semana da unidade. */
  atestar: (unidade: Pick<UnidadeRef, 'nome' | 'cnes'>, semana: string) => string;
  /** O PDF do atesto, na semana da unidade ou no histórico. */
  pdf: (a: AtestoNegativa, lugar: 'semana' | 'historico') => string;
}

/**
 * Nomes acessíveis da tela do responsável, sem repetição para botões que fazem coisas diferentes:
 * - Atestar e o PDF dizem a SE; com mais de uma unidade na tela, também a unidade; o PDF do histórico, que junta as
 *   unidades, sempre a unidade;
 * - a unidade pelo nome e, quando outra unidade da tela (das semanas ou do histórico) tem o mesmo nome, também o CNES;
 * - o PDF do atesto que não é o vigente diz a situação e quando foi atestado, com os segundos (`rotuloEspelhoPdf`);
 * - se ainda assim dois atestos diferentes ficarem com o mesmo nome (não vigentes da mesma SE, unidade e situação,
 *   atestados no mesmo segundo), cada um diz a sua ordem pela hora do atesto: "(1 de 2)", "(2 de 2)".
 * Com mais de uma unidade, o mesmo atesto na semana e no histórico tem o mesmo nome: é o mesmo espelho.
 */
export function nomesDaTelaDoResponsavel(r: Pick<RespostaMinhasNegativas, 'unidades' | 'historico'>, tz: string): NomesDaTelaDoResponsavel {
  const variasUnidades = r.unidades.length > 1;
  const unidadeDoAtesto = (a: Pick<AtestoNegativa, 'unitId' | 'unidade' | 'cnes'>) => ({ id: a.unitId, nome: a.unidade, cnes: a.cnes });
  const nome = nomeDaUnidadeNaTela([...r.unidades.map((u) => u.unidade), ...r.historico.map(unidadeDoAtesto)]);
  const nomeDoPdf = (a: AtestoNegativa, lugar: 'semana' | 'historico') => rotuloEspelhoPdf(a, tz, lugar === 'historico' || variasUnidades ? nome(unidadeDoAtesto(a)) : undefined);
  // Os atestos diferentes de cada nome, pela hora do atesto (e pelo id, no mesmo instante).
  const porNome = new Map<string, AtestoNegativa[]>();
  const anotar = (a: AtestoNegativa, lugar: 'semana' | 'historico') => {
    const n = nomeDoPdf(a, lugar);
    const atestos = porNome.get(n) ?? [];
    if (!atestos.some((x) => x.id === a.id)) porNome.set(n, [...atestos, a]);
  };
  for (const u of r.unidades) for (const s of u.semanas) if (s.atesto) anotar(s.atesto, 'semana');
  for (const a of r.historico) anotar(a, 'historico');
  for (const atestos of porNome.values()) atestos.sort((x, y) => Date.parse(x.atestadoEm) - Date.parse(y.atestadoEm) || x.id.localeCompare(y.id));
  return {
    atestar: (u, semana) => rotuloAtestar(semana, variasUnidades ? nome(u) : undefined),
    pdf: (a, lugar) => {
      const n = nomeDoPdf(a, lugar);
      const atestos = porNome.get(n) ?? [];
      const ordem = atestos.findIndex((x) => x.id === a.id);
      return atestos.length > 1 && ordem >= 0 ? `${n} (${ordem + 1} de ${atestos.length})` : n;
    },
  };
}

/**
 * O período que o encerramento alcança: o aberto; na unidade inativa, também o que ainda termina depois de hoje (dado
 * anterior; a API encurta o fim para a data informada, até hoje). O mais recente, como na API.
 */
export function periodoParaEncerrar(u: Pick<UnidadeNotificante, 'ativa' | 'periodos'>, hoje: string): PeriodoNotificante | null {
  const aberto = periodoAberto(u);
  if (aberto || u.ativa) return aberto;
  return [...u.periodos].filter((p) => p.ate !== null && p.ate > hoje).sort((a, b) => b.desde.localeCompare(a.desde))[0] ?? null;
}

/** Situação da unidade na configuração. */
export function situacaoDaUnidade(u: UnidadeNotificante): { texto: string; tom: Tom } {
  const aberto = periodoAberto(u);
  if (aberto) return { texto: `Notificante desde ${dataBr(aberto.desde)}`, tom: 'green' };
  if (u.periodoAtual?.ate) return { texto: `Notificante até ${dataBr(u.periodoAtual.ate)}`, tom: 'amber' };
  if (!u.ativa) return { texto: 'Unidade inativa', tom: 'slate' };
  if (u.semConfiguracao) return { texto: 'Sem configuração', tom: 'red' };
  return { texto: 'Não notificante', tom: 'slate' };
}

export type FiltroUnidades = 'TODAS' | 'NOTIFICANTES' | 'SEM_CONFIGURACAO' | 'SEM_TITULAR' | 'NAO_NOTIFICANTES';

export function filtrarUnidades(lista: UnidadeNotificante[], filtro: FiltroUnidades, busca: string): UnidadeNotificante[] {
  const termo = normalizar(busca);
  return lista.filter((u) => {
    if (filtro === 'NOTIFICANTES' && !periodoAberto(u)) return false;
    if (filtro === 'SEM_CONFIGURACAO' && !u.semConfiguracao) return false;
    if (filtro === 'SEM_TITULAR' && !semTitular(u)) return false;
    if (filtro === 'NAO_NOTIFICANTES' && periodoAberto(u)) return false;
    return !termo || normalizar(u.unidade.nome).includes(termo) || u.unidade.cnes.includes(termo);
  });
}

/**
 * Contadores da configuração. "Sem configuração" é a marca da API (a ativa que nunca teve período e a reativada cujo
 * período terminou na desativação); titular e responsável contam só com designação que vale.
 */
export function resumoUnidades(lista: UnidadeNotificante[]): { notificantes: number; semConfiguracao: number; semTitular: number; semResponsavel: number } {
  return {
    notificantes: lista.filter((u) => !!periodoAberto(u)).length,
    semConfiguracao: lista.filter((u) => u.semConfiguracao).length,
    semTitular: lista.filter(semTitular).length,
    semResponsavel: lista.filter(semResponsavel).length,
  };
}

/** Pendências para abrir o período de notificante (as mesmas regras da API). */
export function pendenciasAbrirPeriodo(u: UnidadeNotificante, desde: string): string[] {
  const erros: string[] = [];
  if (!u.ativa) erros.push('Unidade inativa não é notificante.');
  const aberto = periodoAberto(u);
  if (aberto) erros.push(`A unidade já é notificante desde ${dataBr(aberto.desde)}: encerre o período antes de abrir outro.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) erros.push('Informe o início do período.');
  else {
    const sobreposto = u.periodos.find((p) => p.ate !== null && p.ate >= desde);
    if (sobreposto) erros.push(`O novo período não pode começar antes do fim do anterior (${dataBr(sobreposto.ate)}).`);
  }
  return erros;
}

export const MINIMO_MOTIVO_FIM = 5;

/**
 * Pendências para encerrar o período (as mesmas regras da API). Com `hoje` (no fuso da instituição), a da unidade
 * inativa: o fim não passa de hoje, e o período que termina depois de hoje também se encerra.
 */
export function pendenciasEncerrarPeriodo(u: UnidadeNotificante, ate: string, motivo: string, hoje?: string): string[] {
  const erros: string[] = [];
  const alvo = hoje ? periodoParaEncerrar(u, hoje) : periodoAberto(u);
  if (!alvo) erros.push('A unidade não tem período de notificante aberto.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ate)) erros.push('Informe o fim do período.');
  else {
    if (alvo && ate < alvo.desde) erros.push('O fim não pode ser antes do início do período.');
    if (!u.ativa && hoje && ate > hoje) erros.push(`A unidade está inativa: o fim do período não pode passar de hoje (${dataBr(hoje)}). Use a data da desativação.`);
  }
  if (motivo.trim().length < MINIMO_MOTIVO_FIM) erros.push(`Escreva o motivo (pelo menos ${MINIMO_MOTIVO_FIM} caracteres).`);
  return erros;
}

/** Por que o lotado não pode ser designado (nenhum papel dele na unidade atesta a negativa); null quando pode. */
export const motivoNaoAtesta = (l: Pick<UsuarioLotado, 'podeAtestar'>) => (l.podeAtestar ? null : 'Papel sem a negativa nesta unidade: não pode ser designado.');

export function pendenciasDesignacao(
  u: UnidadeNotificante,
  f: { userId: string; tipo: 'TITULAR' | 'SUBSTITUTO'; desde: string },
  nomeDoUsuario?: string | null,
  escolhido?: Pick<UsuarioLotado, 'podeAtestar'> | null,
): string[] {
  const erros: string[] = [];
  if (!periodoAberto(u)) erros.push('A unidade não é notificante: abra o período antes de designar responsáveis.');
  if (!f.userId) erros.push('Escolha um usuário lotado na unidade.');
  // A API recusa (422 PAPEL_SEM_NEGATIVA): a designação de quem não atesta deixaria a unidade sem ninguém para atestar.
  if (f.userId && escolhido && !escolhido.podeAtestar) erros.push(`${nomeDoUsuario ?? 'O usuário'} não tem, nesta unidade, papel que atesta a negativa. Escolha quem tem lotação em papel que atesta.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.desde)) erros.push('Informe o início da designação.');
  const ativos = responsaveisAtivos(u);
  const ja = ativos.find((r) => r.userId === f.userId);
  if (f.userId && ja) erros.push(`${nomeDoUsuario ?? ja.nome} já é ${ja.tipo === 'TITULAR' ? 'titular' : 'substituto(a)'} desta unidade.`);
  // O titular cuja designação não vale não trava a vaga: a API encerra a designação dele ao designar o novo.
  const titular = ativos.find((r) => r.tipo === 'TITULAR');
  if (f.tipo === 'TITULAR' && titular && titular.userId !== f.userId && designacaoValida(titular)) erros.push(`A unidade já tem titular (${titular.nome}): revogue a designação antes.`);
  return erros;
}

/** Aviso do diálogo de designação quando o novo titular substitui o titular cuja designação não vale; null se não for o caso. */
export function avisoTitularSubstituido(u: Pick<UnidadeNotificante, 'responsaveis'>, tipo: 'TITULAR' | 'SUBSTITUTO'): string | null {
  const antigo = tipo === 'TITULAR' ? titularQueNaoVale(u) : null;
  if (!antigo) return null;
  return `A designação de ${antigo.nome} como titular não vale${antigo.motivoInvalido ? ` (${antigo.motivoInvalido.toLowerCase()})` : ''}: ao designar o novo titular, ela termina hoje.`;
}

// ───────────── Tela do responsável ─────────────

/** Contagens da tela do responsável: semanas a atestar, das quais com o prazo vencido. */
export function resumoMinhas(r: RespostaMinhasNegativas): { aAtestar: number; vencidas: number; unidades: number } {
  const semanas = r.unidades.flatMap((u) => u.semanas);
  return { aAtestar: semanas.filter((s) => s.podeAtestar).length, vencidas: semanas.filter((s) => s.podeAtestar && s.prazoPassou).length, unidades: r.unidades.length };
}

/** Por que o atesto deixou de valer. */
export function textoCancelamento(a: Pick<AtestoNegativa, 'status' | 'causa' | 'motivoCancelamento'>): string | null {
  if (a.status === 'ANULADA') return `Anulado pela vigilância${a.motivoCancelamento ? `: ${a.motivoCancelamento}` : '.'}`;
  if (a.status !== 'CANCELADA') return null;
  const causa = a.causa ? { NOTIFICACAO: 'uma notificação', REGISTRO_OFICIAL: 'um registro oficial importado', SURTO: 'um surto' }[a.causa.tipo] : null;
  return causa ? `Cancelado: a unidade passou a ter ${causa} na semana.` : `Cancelado${a.motivoCancelamento ? `: ${a.motivoCancelamento}` : '.'}`;
}
