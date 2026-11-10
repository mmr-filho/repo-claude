import {
  arredondar,
  ROTULO_EIXO_ACAO,
  type AcaoChecklist,
  type AcaoPlano,
  type AvaliacaoCriterio,
  type AvaliacaoPlano,
  type CorpoAtualizarAcao,
  type CriterioPlano,
  type EixoAcao,
  type EstagioPlano,
  type IndicadoresAgravo,
  type NivelTerritorio,
  type PlanoContingencia,
  type PlanoResumo,
  type RespostaManualCriterio,
  type StatusAcao,
  type StatusPlano,
  type StatusSemana,
  type TipoCriterio,
} from '@omnisaude/shared';

/*
 * Regras da aba Contingência sem React (testadas em apps/web/test/contingencia-regras.test.ts): critérios por
 * estágio, textos dos valores, respostas manuais da semana, checklist por eixo, acionamento e edição do plano. A API
 * valida tudo de novo; aqui a tela só avisa antes de enviar.
 */

export type Tom = 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

/** Território da aba (município, localidade ou bairro). */
export interface TerritorioDaContingencia {
  nivel: NivelTerritorio;
  territorio: string | null;
}

/** Data civil AAAA-MM-DD como dd/mm/aaaa. */
export const dataBr = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');

/** Semana AAAASS como SS/AAAA. */
export const rotuloSemana = (semana: string) => `${semana.slice(4)}/${semana.slice(0, 4)}`;

/** Número em português: 2 casas (3 abaixo de 1), com o ARRED do Excel. */
export function numeroBr(x: number): string {
  return arredondar(x, Math.abs(x) < 1 ? 3 : 2).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

// ───────────── Estágios ─────────────

/** Estágios na ordem do plano (0 = normalidade). */
export const estagiosOrdenados = (plano: Pick<PlanoContingencia, 'estagios'>): EstagioPlano[] => [...plano.estagios].sort((a, b) => a.ordem - b.ordem);

/** Cores do estágio, da normalidade à epidemia (sempre com o nome escrito; a cor não fala sozinha). */
const CORES_ESTAGIO = ['bg-emerald-50 text-emerald-800 ring-emerald-300', 'bg-yellow-50 text-yellow-900 ring-yellow-400', 'bg-orange-50 text-orange-900 ring-orange-300', 'bg-red-50 text-red-800 ring-red-300'];

/** Classe do selo do estágio pela posição no plano: o primeiro verde, o último vermelho, os do meio em amarelo e laranja. */
export function classeDoEstagio(plano: Pick<PlanoContingencia, 'estagios'> | null, chave: string): string {
  const lista = plano ? estagiosOrdenados(plano) : [];
  const i = lista.findIndex((e) => e.chave === chave);
  if (i < 0) return 'bg-slate-100 text-slate-700 ring-slate-200';
  const nivel = lista.length <= 1 ? 0 : Math.round((i * (CORES_ESTAGIO.length - 1)) / (lista.length - 1));
  return CORES_ESTAGIO[nivel]!;
}

export const nomeDoEstagio = (plano: Pick<PlanoContingencia, 'estagios'> | null, chave: string) => plano?.estagios.find((e) => e.chave === chave)?.nome ?? chave;

/**
 * A sugestão comparada ao estágio em vigor. Estágio fora do plano vigente (de outra versão do plano) não se compara:
 * a API já avisa que é preciso registrar um novo acionamento.
 */
export function comparacaoSugestao(plano: Pick<PlanoContingencia, 'estagios'>, atual: string, sugerido: string): 'IGUAL' | 'ACIMA' | 'ABAIXO' {
  const ordem = new Map(plano.estagios.map((e) => [e.chave, e.ordem]));
  const a = ordem.get(atual);
  const s = ordem.get(sugerido);
  if (a === undefined || s === undefined || a === s) return 'IGUAL';
  return s > a ? 'ACIMA' : 'ABAIXO';
}

/** Frase da sugestão para a tela. */
export function textoSugestao(plano: Pick<PlanoContingencia, 'estagios'>, atual: string, avaliacao: Pick<AvaliacaoPlano, 'sugerido' | 'desmobilizacao'>): string {
  const comp = comparacaoSugestao(plano, atual, avaliacao.sugerido);
  const nome = nomeDoEstagio(plano, avaliacao.sugerido);
  if (comp === 'ACIMA') return `Os critérios sugerem ${nome}, acima do estágio em vigor. A decisão é da vigilância: avalie acionar o estágio.`;
  if (comp === 'ABAIXO') return `Os critérios sugerem descer para ${nome}. ${avaliacao.desmobilizacao.detalhe}`.trim();
  return avaliacao.desmobilizacao.detalhe || 'Os critérios confirmam o estágio em vigor.';
}

// ───────────── Critérios ─────────────

const CANAL: TipoCriterio[] = ['CANAL_ACIMA_CENTRO', 'CANAL_ENTRE_CENTRO_E_LS', 'CANAL_ACIMA_LS'];
const PERCENTUAIS: TipoCriterio[] = ['PERCENTUAL_GRAVES', 'LETALIDADE', 'LETALIDADE_GRAVES', 'OBITOS_INVESTIGACAO_PERCENTUAL'];
export const ehCriterioDeCanal = (tipo: TipoCriterio) => CANAL.includes(tipo);
export const ehCriterioPercentual = (tipo: TipoCriterio) => PERCENTUAIS.includes(tipo);
export const ehCriterioNumerico = (tipo: TipoCriterio) => PERCENTUAIS.includes(tipo) || tipo === 'INCIDENCIA_ACUMULADA';

/** Valor do critério na semana: semanas no canal, percentual ou incidência; "—" sem valor. */
export function textoValor(tipo: TipoCriterio, valor: number | null | undefined): string {
  if (valor === null || valor === undefined || !Number.isFinite(valor) || tipo === 'MANUAL') return '—';
  if (CANAL.includes(tipo)) return `${valor} SE`;
  if (tipo === 'INCIDENCIA_ACUMULADA') return `${numeroBr(valor)} por 100 mil`;
  return `${numeroBr(valor)}%`;
}

/** Situação do critério: atendido, não atendido ou não avaliado (manual sem resposta, sem canal, sem indicadores). */
export function situacaoDoCriterio(atendido: boolean | null): { texto: string; tom: Tom } {
  if (atendido === true) return { texto: 'Atendido', tom: 'red' };
  if (atendido === false) return { texto: 'Não atendido', tom: 'green' };
  return { texto: 'Não avaliado', tom: 'slate' };
}

/** Exigência do critério em texto curto (ex.: "4 SE seguidas", "3 de 5 SE", "> 1%"). */
export function exigenciaDoCriterio(c: CriterioPlano): string {
  if (CANAL.includes(c.tipo)) {
    if (c.modo === 'K_DE_N') return `${c.k ?? '?'} de ${c.n ?? c.semanas ?? '?'} SE`;
    return `${c.semanas ?? '?'} SE seguidas`;
  }
  if (c.tipo === 'MANUAL') return 'Resposta da vigilância';
  if (c.limiar === undefined || c.limiar === null) return 'Sem limiar';
  const comp = c.comparador ?? '>';
  return c.tipo === 'INCIDENCIA_ACUMULADA' ? `${comp} ${numeroBr(c.limiar)} por 100 mil` : `${comp} ${numeroBr(c.limiar)}%`;
}

export interface ItemCriterio {
  criterio: CriterioPlano;
  /** Um item por agravo nos critérios automáticos; um só nos manuais. */
  avaliacoes: AvaliacaoCriterio[];
}

export interface GrupoCriterios {
  estagio: EstagioPlano;
  atendidos: number;
  itens: ItemCriterio[];
}

/** Critérios do plano agrupados por estágio (na ordem do plano), com a avaliação da semana. A normalidade não tem critério. */
export function criteriosPorEstagio(plano: PlanoContingencia, avaliacao: Pick<AvaliacaoPlano, 'criterios' | 'porEstagio'> | null): GrupoCriterios[] {
  return estagiosOrdenados(plano)
    .map((estagio) => {
      const itens = plano.criterios.filter((c) => c.estagio === estagio.chave).map((criterio) => ({ criterio, avaliacoes: avaliacao?.criterios.filter((a) => a.id === criterio.id) ?? [] }));
      const atendidos = avaliacao?.porEstagio[estagio.chave] ?? itens.filter((i) => i.avaliacoes.some((a) => a.atendido === true)).length;
      return { estagio, atendidos, itens };
    })
    .filter((g) => g.itens.length > 0);
}

export interface ManualDaSemana {
  criterio: CriterioPlano;
  estagio: EstagioPlano | null;
  resposta: RespostaManualCriterio | null;
}

/** Critérios manuais do plano com a resposta da semana de referência (na ordem dos estágios). */
export function manuaisDaSemana(plano: PlanoContingencia, respostas: RespostaManualCriterio[], semana: string): ManualDaSemana[] {
  const ordem = new Map(plano.estagios.map((e) => [e.chave, e]));
  const daSemana = respostas.filter((r) => r.semana === semana);
  return plano.criterios
    .map((criterio, i) => ({ criterio, i, estagio: ordem.get(criterio.estagio) ?? null }))
    .filter((x) => x.criterio.tipo === 'MANUAL')
    .sort((a, b) => (a.estagio?.ordem ?? 99) - (b.estagio?.ordem ?? 99) || a.i - b.i)
    .map(({ criterio, estagio }) => ({ criterio, estagio, resposta: daSemana.find((r) => r.criterio === criterio.id) ?? null }));
}

// ───────────── Indicadores ─────────────

/** Números do ano em análise de um agravo, para a tela. */
export function resumoIndicadores(ind: IndicadoresAgravo): { rotulo: string; valor: string }[] {
  const n = (x: number) => x.toLocaleString('pt-BR');
  return [
    { rotulo: 'Casos prováveis', valor: n(ind.provaveis) },
    { rotulo: 'Graves', valor: n(ind.graves) },
    { rotulo: 'Com sinais de alarme', valor: n(ind.sinaisAlarme) },
    { rotulo: 'Óbitos pelo agravo', valor: n(ind.obitosAgravo) },
    { rotulo: 'Óbitos em investigação', valor: n(ind.obitosInvestigacao) },
    { rotulo: 'Incidência acumulada', valor: ind.incidenciaAcumulada === null ? 'sem população' : `${numeroBr(ind.incidenciaAcumulada)} por 100 mil` },
  ];
}

/** As últimas `n` semanas do agravo no canal (da mais antiga à mais recente). */
export function ultimasSemanas(ind: IndicadoresAgravo, n = 8): { semana: string; rotulo: string; status: StatusSemana; completa: boolean }[] {
  return ind.semanas.slice(-Math.max(1, n)).map((s) => ({ ...s, rotulo: rotuloSemana(s.semana) }));
}

// ───────────── Acionamento ─────────────

export const MINIMO_JUSTIFICATIVA = 20;

/** O que falta para acionar um estágio (a API confere de novo). */
export function errosAcionamento(f: { estagio: string; justificativa: string; ato: string }): string[] {
  const erros: string[] = [];
  if (!f.estagio) erros.push('Escolha o estágio.');
  const falta = MINIMO_JUSTIFICATIVA - f.justificativa.trim().length;
  if (falta > 0) erros.push(`Escreva a justificativa com pelo menos ${MINIMO_JUSTIFICATIVA} caracteres (faltam ${falta}).`);
  if (f.justificativa.trim().length > 4000) erros.push('A justificativa tem até 4.000 caracteres.');
  if (f.ato.trim().length > 300) erros.push('O ato tem até 300 caracteres.');
  return erros;
}

/** Justificativa proposta a partir dos critérios atendidos do estágio (a vigilância revisa antes de gravar). */
export function justificativaSugerida(plano: PlanoContingencia, avaliacao: Pick<AvaliacaoPlano, 'criterios'> | null, estagio: string, semana: string): string {
  if (!avaliacao) return '';
  const atendidos = plano.criterios.filter((c) => c.estagio === estagio && avaliacao.criterios.some((a) => a.id === c.id && a.atendido === true));
  if (!atendidos.length) return '';
  return `Critérios atendidos na SE ${rotuloSemana(semana)}: ${atendidos.map((c) => c.descricao).join('; ')}.`;
}

// ───────────── Checklist ─────────────

export const TOM_STATUS_ACAO: Record<StatusAcao, Tom> = { PENDENTE: 'amber', EM_ANDAMENTO: 'blue', FEITA: 'green', NAO_SE_APLICA: 'slate' };

export interface GrupoAcoes {
  eixo: EixoAcao;
  rotulo: string;
  acoes: AcaoChecklist[];
  feitas: number;
  /** Ações que contam (sem as que não se aplicam). */
  total: number;
}

const ORDEM_EIXOS = Object.keys(ROTULO_EIXO_ACAO) as EixoAcao[];

/** Checklist agrupado por eixo, na ordem dos eixos; dentro do eixo, pela ordem dos estágios e depois a original. */
export function checklistPorEixo(lista: AcaoChecklist[], plano?: Pick<PlanoContingencia, 'estagios'> | null): GrupoAcoes[] {
  const ordem = new Map((plano?.estagios ?? []).map((e) => [e.chave, e.ordem]));
  return ORDEM_EIXOS.map((eixo) => {
    const acoes = lista
      .map((a, i) => ({ a, i }))
      .filter((x) => x.a.eixo === eixo)
      .sort((x, y) => (ordem.get(x.a.estagio) ?? 99) - (ordem.get(y.a.estagio) ?? 99) || x.i - y.i)
      .map((x) => x.a);
    return { eixo, rotulo: ROTULO_EIXO_ACAO[eixo], acoes, feitas: acoes.filter((a) => a.status === 'FEITA').length, total: acoes.filter((a) => a.status !== 'NAO_SE_APLICA').length };
  }).filter((g) => g.acoes.length > 0);
}

/** Progresso do checklist inteiro. */
export function progressoChecklist(lista: AcaoChecklist[]): { feitas: number; emAndamento: number; pendentes: number; total: number } {
  return {
    feitas: lista.filter((a) => a.status === 'FEITA').length,
    emAndamento: lista.filter((a) => a.status === 'EM_ANDAMENTO').length,
    pendentes: lista.filter((a) => a.status === 'PENDENTE').length,
    total: lista.filter((a) => a.status !== 'NAO_SE_APLICA').length,
  };
}

/** Só o que mudou na ação (texto vazio = apagar); null quando nada mudou. */
export function patchAcao(original: Pick<AcaoChecklist, 'status' | 'responsavel' | 'nota'>, edicao: { status: StatusAcao; responsavel: string; nota: string }): CorpoAtualizarAcao | null {
  const patch: CorpoAtualizarAcao = {};
  if (edicao.status !== original.status) patch.status = edicao.status;
  const responsavel = edicao.responsavel.trim() || null;
  if (responsavel !== (original.responsavel ?? null)) patch.responsavel = responsavel;
  const nota = edicao.nota.trim() || null;
  if (nota !== (original.nota ?? null)) patch.nota = nota;
  return Object.keys(patch).length ? patch : null;
}

// ───────────── Plano ─────────────

export const TOM_STATUS_PLANO: Record<StatusPlano, Tom> = { VIGENTE: 'green', RASCUNHO: 'amber', ARQUIVADO: 'slate' };

/** Vigência do plano em texto. */
export function textoVigencia(p: Pick<PlanoResumo, 'status' | 'vigenteDesde' | 'vigenteAte'>): string {
  if (p.status === 'VIGENTE') return `Em vigor desde ${dataBr(p.vigenteDesde)}`;
  if (p.status === 'ARQUIVADO') return p.vigenteDesde ? `Vigorou de ${dataBr(p.vigenteDesde)} a ${dataBr(p.vigenteAte)}` : 'Arquivado sem ter vigorado';
  return 'Rascunho: ainda não vigorou';
}

const copia = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Troca campos de um critério (os campos com `undefined` saem da definição). */
export function trocarCriterio(d: PlanoContingencia, id: string, patch: Partial<CriterioPlano>): PlanoContingencia {
  return {
    ...d,
    criterios: d.criterios.map((c) => {
      if (c.id !== id) return c;
      const novo = { ...c, ...patch } as CriterioPlano & Record<string, unknown>;
      for (const k of Object.keys(novo)) if (novo[k] === undefined) delete novo[k];
      return novo;
    }),
  };
}

export const removerCriterio = (d: PlanoContingencia, id: string): PlanoContingencia => ({ ...d, criterios: d.criterios.filter((c) => c.id !== id) });

/** Identificador novo e único para um critério manual do estágio (ex.: "mob-manual-1"). */
export function novoIdCriterio(d: PlanoContingencia, estagio: string): string {
  const prefixo =
    estagio
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 3) || 'est';
  const usados = new Set(d.criterios.map((c) => c.id));
  for (let n = 1; ; n++) {
    const id = `${prefixo}-manual-${n}`;
    if (!usados.has(id)) return id;
  }
}

/** Acrescenta um critério manual (respondido pela vigilância a cada semana) ao estágio. */
export function incluirCriterioManual(d: PlanoContingencia, estagio: string, descricao: string, agravos: string[] = []): PlanoContingencia {
  return { ...d, criterios: [...d.criterios, { id: novoIdCriterio(d, estagio), estagio, agravos: [...agravos], tipo: 'MANUAL', descricao: descricao.trim(), fonte: 'Plano municipal' }] };
}

export const trocarAcao = (d: PlanoContingencia, indice: number, patch: Partial<AcaoPlano>): PlanoContingencia => ({ ...d, acoes: d.acoes.map((a, i) => (i === indice ? { ...a, ...patch } : a)) });
export const removerAcao = (d: PlanoContingencia, indice: number): PlanoContingencia => ({ ...d, acoes: d.acoes.filter((_, i) => i !== indice) });
export const incluirAcao = (d: PlanoContingencia, acao: AcaoPlano): PlanoContingencia => ({ ...d, acoes: [...d.acoes, { ...acao, descricao: acao.descricao.trim() }] });

/** Ações do plano por estágio e eixo, com o índice de cada uma na definição (para editar e remover). */
export function acoesPorEstagio(d: PlanoContingencia): { estagio: EstagioPlano; eixos: { eixo: EixoAcao; rotulo: string; acoes: { indice: number; acao: AcaoPlano }[] }[] }[] {
  return estagiosOrdenados(d).map((estagio) => ({
    estagio,
    eixos: ORDEM_EIXOS.map((eixo) => ({
      eixo,
      rotulo: ROTULO_EIXO_ACAO[eixo],
      acoes: d.acoes.map((acao, indice) => ({ indice, acao })).filter((x) => x.acao.estagio === estagio.chave && x.acao.eixo === eixo),
    })).filter((e) => e.acoes.length > 0),
  }));
}

const ID_CRITERIO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const CHAVE_ESTAGIO = /^[A-Z][A-Z0-9_]{1,29}$/;
const GRUPO = /^[a-z0-9-]{2,40}$/;
const inteiroEntre = (v: number | undefined, min: number, max: number) => v === undefined || (Number.isInteger(v) && v >= min && v <= max);

/**
 * Conferência da definição antes de gravar: as regras de `validarDefinicao` da API (estágios e critérios únicos,
 * normalidade sem critério, agravos dentro do plano, semanas nos critérios de canal, limiar nos numéricos, ações de
 * estágios que existem) e os limites do formato.
 */
export function validarPlano(d: PlanoContingencia): string[] {
  const erros: string[] = [];
  if (d.estagios.length < 2 || d.estagios.length > 10) erros.push('O plano tem de 2 a 10 estágios.');
  const chaves = d.estagios.map((e) => e.chave);
  if (new Set(chaves).size !== chaves.length) erros.push('Há estágios com a mesma chave.');
  if (new Set(d.estagios.map((e) => e.ordem)).size !== d.estagios.length) erros.push('Há estágios com a mesma ordem.');
  if (d.estagios.length && Math.min(...d.estagios.map((e) => e.ordem)) !== 0) erros.push('O primeiro estágio (normalidade) tem ordem 0.');
  for (const e of d.estagios) {
    if (!CHAVE_ESTAGIO.test(e.chave)) erros.push(`Estágio ${e.chave}: chave inválida.`);
    if (e.nome.trim().length < 2 || e.nome.trim().length > 60) erros.push(`Estágio ${e.chave}: o nome tem de 2 a 60 caracteres.`);
  }
  if (!d.agravos.length) erros.push('O plano precisa de pelo menos um agravo.');
  if (new Set(d.agravos).size !== d.agravos.length) erros.push('Há agravos repetidos no plano.');
  for (const a of d.agravos) if (!GRUPO.test(a)) erros.push(`Agravo ${a}: identificador inválido.`);
  const ordem = new Map(d.estagios.map((e) => [e.chave, e.ordem]));
  if (d.criterios.length > 200) erros.push('O plano tem no máximo 200 critérios.');
  const ids = new Set<string>();
  for (const c of d.criterios) {
    const onde = `Critério ${c.id}`;
    if (!ID_CRITERIO.test(c.id)) erros.push(`${onde}: identificador inválido.`);
    if (ids.has(c.id)) erros.push(`${onde}: identificador repetido.`);
    ids.add(c.id);
    if (!ordem.has(c.estagio)) erros.push(`${onde}: estágio ${c.estagio} não existe no plano.`);
    else if (ordem.get(c.estagio) === 0) erros.push(`${onde}: a normalidade não tem critério (é o estado padrão).`);
    const fora = c.agravos.filter((a) => !d.agravos.includes(a));
    if (fora.length) erros.push(`${onde}: agravo(s) fora do plano (${fora.join(', ')}).`);
    const descricao = c.descricao.trim().length;
    if (descricao < 5 || descricao > 500) erros.push(`${onde}: a descrição tem de 5 a 500 caracteres.`);
    if ((c.fonte ?? '').trim().length > 300) erros.push(`${onde}: a fonte tem até 300 caracteres.`);
    if (CANAL.includes(c.tipo)) {
      if (!inteiroEntre(c.semanas, 1, 52) || !inteiroEntre(c.k, 1, 52) || !inteiroEntre(c.n, 1, 52)) erros.push(`${onde}: semanas, k e n são inteiros de 1 a 52.`);
      if (c.modo === 'K_DE_N') {
        const n = c.n ?? c.semanas;
        if (!c.k || !n) erros.push(`${onde}: informe k e n (pelo menos k das últimas n semanas).`);
        else if (c.k > n) erros.push(`${onde}: k não pode ser maior que n.`);
      } else if (!c.semanas) erros.push(`${onde}: informe quantas semanas seguidas o critério pede.`);
    } else if (c.tipo !== 'MANUAL') {
      if (c.limiar === undefined || c.limiar === null || !Number.isFinite(c.limiar)) erros.push(`${onde}: informe o limiar.`);
      else if (c.limiar < 0) erros.push(`${onde}: o limiar não pode ser negativo.`);
      else if (PERCENTUAIS.includes(c.tipo) && c.limiar > 100) erros.push(`${onde}: o limiar é um percentual (até 100).`);
      else if (c.limiar > 1_000_000) erros.push(`${onde}: limiar grande demais.`);
    }
  }
  if (d.acoes.length > 500) erros.push('O plano tem no máximo 500 ações.');
  for (const a of d.acoes) {
    if (!ordem.has(a.estagio)) erros.push(`Ação "${a.descricao}": estágio ${a.estagio} não existe no plano.`);
    const n = a.descricao.trim().length;
    if (n < 3 || n > 500) erros.push(`Ação "${a.descricao || '(vazia)'}": a descrição tem de 3 a 500 caracteres.`);
  }
  if (!inteiroEntre(d.desmobilizacao.semanas, 1, 52) || !d.desmobilizacao.semanas) erros.push('Desmobilização: semanas inteiras de 1 a 52.');
  const desc = d.desmobilizacao.descricao.trim().length;
  if (desc < 3 || desc > 1000) erros.push('Desmobilização: a descrição tem de 3 a 1.000 caracteres.');
  return erros;
}

/** Definição pronta para gravar: textos aparados e, em cada critério, só os campos do tipo dele. */
export function definicaoParaEnvio(d: PlanoContingencia): PlanoContingencia {
  const x = copia(d);
  return {
    ...x,
    criterios: x.criterios.map((c) => {
      const base: CriterioPlano = { id: c.id, estagio: c.estagio, agravos: c.agravos, tipo: c.tipo, descricao: c.descricao.trim() };
      if (c.fonte?.trim()) base.fonte = c.fonte.trim();
      if (CANAL.includes(c.tipo)) {
        base.modo = c.modo ?? 'CONSECUTIVAS';
        if (c.semanas !== undefined) base.semanas = c.semanas;
        if (base.modo === 'K_DE_N') {
          if (c.k !== undefined) base.k = c.k;
          if (c.n !== undefined) base.n = c.n;
        }
      } else if (c.tipo !== 'MANUAL') {
        if (c.limiar !== undefined && Number.isFinite(c.limiar)) base.limiar = c.limiar;
        base.comparador = c.comparador ?? '>';
      }
      return base;
    }),
    acoes: x.acoes.map((a) => ({ ...a, descricao: a.descricao.trim() })),
    desmobilizacao: { semanas: x.desmobilizacao.semanas, descricao: x.desmobilizacao.descricao.trim() },
  };
}

/** Número digitado (vírgula ou ponto); undefined quando vazio ou inválido. */
export function lerNumero(texto: string): number | undefined {
  const t = texto.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
