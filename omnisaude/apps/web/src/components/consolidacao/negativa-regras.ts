import {
  arredondar,
  ROTULO_SITUACAO_UNIDADE_SEMANA,
  type AtestoNegativa,
  type CelulaGrade,
  type ColunaGrade,
  type FontesCelula,
  type LinhaGradeNegativa,
  type PeriodoNotificante,
  type ResponsavelNegativa,
  type RespostaGradeNegativa,
  type RespostaMinhasNegativas,
  type SituacaoUnidadeSemana,
  type StatusAtesto,
  type UnidadeNotificante,
  type UnidadeRef,
} from '@omnisaude/shared';

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

/** Rótulo acessível da célula. */
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

// ───────────── Unidades notificantes e responsáveis ─────────────

export const responsaveisAtivos = (u: Pick<UnidadeNotificante, 'responsaveis'>): ResponsavelNegativa[] => u.responsaveis.filter((r) => r.ate === null);
/** Período aberto (sem fim): a condição da API para designar responsáveis. */
export const periodoAberto = (u: Pick<UnidadeNotificante, 'periodos'>): PeriodoNotificante | null => u.periodos.find((p) => p.ate === null) ?? null;
export const semTitular = (u: UnidadeNotificante) => !!periodoAberto(u) && !responsaveisAtivos(u).some((r) => r.tipo === 'TITULAR');

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

export function resumoUnidades(lista: UnidadeNotificante[]): { notificantes: number; semConfiguracao: number; semTitular: number; semResponsavel: number } {
  return {
    notificantes: lista.filter((u) => !!periodoAberto(u)).length,
    semConfiguracao: lista.filter((u) => u.semConfiguracao).length,
    semTitular: lista.filter(semTitular).length,
    semResponsavel: lista.filter((u) => !!periodoAberto(u) && !responsaveisAtivos(u).length).length,
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

export function pendenciasEncerrarPeriodo(u: UnidadeNotificante, ate: string, motivo: string): string[] {
  const erros: string[] = [];
  const aberto = periodoAberto(u);
  if (!aberto) erros.push('A unidade não tem período de notificante aberto.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ate)) erros.push('Informe o fim do período.');
  else if (aberto && ate < aberto.desde) erros.push('O fim não pode ser antes do início do período.');
  if (motivo.trim().length < MINIMO_MOTIVO_FIM) erros.push(`Escreva o motivo (pelo menos ${MINIMO_MOTIVO_FIM} caracteres).`);
  return erros;
}

export function pendenciasDesignacao(u: UnidadeNotificante, f: { userId: string; tipo: 'TITULAR' | 'SUBSTITUTO'; desde: string }, nomeDoUsuario?: string | null): string[] {
  const erros: string[] = [];
  if (!periodoAberto(u)) erros.push('A unidade não é notificante: abra o período antes de designar responsáveis.');
  if (!f.userId) erros.push('Escolha um usuário lotado na unidade.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.desde)) erros.push('Informe o início da designação.');
  const ativos = responsaveisAtivos(u);
  const ja = ativos.find((r) => r.userId === f.userId);
  if (f.userId && ja) erros.push(`${nomeDoUsuario ?? ja.nome} já é ${ja.tipo === 'TITULAR' ? 'titular' : 'substituto(a)'} desta unidade.`);
  const titular = ativos.find((r) => r.tipo === 'TITULAR');
  if (f.tipo === 'TITULAR' && titular && titular.userId !== f.userId) erros.push(`A unidade já tem titular (${titular.nome}): revogue a designação antes.`);
  return erros;
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
