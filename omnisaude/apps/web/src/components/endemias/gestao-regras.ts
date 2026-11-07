import { lerNumeroPtBr } from '@omnisaude/shared';
import { GRUPO_LABEL, type AgenteEndemias, type BaixaPendente, type DepositoEndemias, type LoteDeposito } from './types';

/*
 * Regras das telas de gestão das endemias (ordens de bloqueio, zonas, larvicidas, pendências e produção), sem React,
 * para serem testadas à parte (packages/shared/test/endemias-telas-gestao.test.ts).
 */

// ─── Números no formato brasileiro ──────────────────────────────────────────

/** Quantidade de estoque com até três casas decimais: 25000 → "25.000"; 2,5 → "2,5". */
export function fmtQuantidade(n: number): string {
  return (Math.round(n * 1000) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** Índice com duas casas, como a Nota Informativa nº 11/2026 apresenta (0,99; 1,00; 3,90); sem base, "—". */
export function fmtIndice(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const fmtPercentual = (n: number | null) => (n === null ? '—' : `${fmtIndice(n)}%`);

// ─── Entrada por remessa ────────────────────────────────────────────────────

/** Teto de uma entrada na API. */
export const QUANTIDADE_MAXIMA_ENTRADA = 10_000_000;

/**
 * Quantidade da guia no formato brasileiro (vírgula decimal, ponto de milhar): "25.000" são 25 mil, não 25. O que não dá
 * para ler sem dúvida ("2.5") volta com a explicação, em vez de virar um número mil vezes menor ou maior.
 */
export function lerQuantidadeEntrada(texto: string): { valor: number | null; erro: string | null } {
  if (!texto.trim()) return { valor: null, erro: null };
  const valor = lerNumeroPtBr(texto);
  if (valor === null)
    return {
      valor: null,
      erro: /^\s*\d+\.\d+\s*$/.test(texto)
        ? 'Quantidade ambígua: use vírgula para as casas decimais (2,5) e ponto só para o milhar (2.500)'
        : 'Quantidade inválida: use só números, com vírgula nas casas decimais (ex.: 25.000 ou 1.000,5)',
    };
  if (!(valor > 0)) return { valor: null, erro: 'A quantidade precisa ser maior que zero' };
  // O estoque guarda três casas: abaixo de 0,001 a entrada seria zero.
  if (Math.round(valor * 1000) < 1) return { valor: null, erro: 'A quantidade mínima é 0,001' };
  if (valor > QUANTIDADE_MAXIMA_ENTRADA) return { valor: null, erro: `A quantidade máxima por entrada é ${fmtQuantidade(QUANTIDADE_MAXIMA_ENTRADA)}` };
  return { valor, erro: null };
}

/** O valor interpretado, mostrado antes de confirmar a entrada. */
export const textoSeraLancado = (valor: number, unidade: string) => `Será lançado: ${fmtQuantidade(valor)} ${unidade}`.trim();

// ─── Ordens de bloqueio ─────────────────────────────────────────────────────

/** Teto da lista de ordens na API. */
export const LIMITE_LISTA_ORDENS = 500;

/** Aviso de lista cheia: as ativas vêm pelas mais urgentes (atrasadas, depois as mais antigas); as demais, pelas mais recentes. */
export function avisoLimiteOrdens(situacao: 'ATIVAS' | 'ENCERRADAS' | 'TODAS', quantas: number): string | null {
  if (quantas < LIMITE_LISTA_ORDENS) return null;
  return situacao === 'ATIVAS'
    ? `Mostrando as ${LIMITE_LISTA_ORDENS} mais urgentes: as atrasadas primeiro, depois da mais antiga para a mais nova. Conclua ou cancele as que já terminaram para ver as outras.`
    : `Mostrando as ${LIMITE_LISTA_ORDENS} mais recentes.`;
}

/**
 * A distância de cada quarteirão até o caso só vem para quem vê o mapa de casos (a vigilância). Fora dela vem null e a
 * coluna não aparece: as distâncias até as bordas devolveriam o ponto da residência (Lei 6.259/1975, art. 10).
 */
export const temDistancia = (quarteiroes: readonly { distanciaM: number | null }[]) => quarteiroes.some((q) => q.distanciaM !== null);

export const textoDistancia = (m: number | null) => (m === null ? '—' : `${Math.round(m).toLocaleString('pt-BR')} m`);

/** Agravos por extenso; a lista vem vazia para quem não vê o mapa de casos, e então nada aparece. */
export const textoAgravos = (grupos: readonly string[]) => grupos.map((g) => GRUPO_LABEL[g] ?? g).join(', ');

export type AcaoOrdem = 'concluir' | 'reabrir' | 'cancelar' | 'designar';

/** Ação aberta no detalhe da ordem e o texto dela (justificativa da conclusão ou motivo da reabertura e do cancelamento). */
export interface EstadoAcaoOrdem {
  acao: AcaoOrdem | null;
  texto: string;
}

/** Abrir outra ação (ou voltar) sempre começa com o texto vazio: a justificativa de uma ação não vira o motivo de outra. */
export const trocarAcaoOrdem = (acao: AcaoOrdem | null): EstadoAcaoOrdem => ({ acao, texto: '' });

/**
 * Tamanho mínimo do texto, o mesmo que a API exige: o motivo da reabertura e do cancelamento tem 5 caracteres; a
 * conclusão só pede justificativa (10) quando ficou imóvel sem visita ou pendente.
 */
export function textoMinimoAcao(acao: AcaoOrdem, progresso: { semVisita: number; pendentes: number }): number {
  if (acao === 'cancelar' || acao === 'reabrir') return 5;
  if (acao === 'concluir' && (progresso.semVisita > 0 || progresso.pendentes > 0)) return 10;
  return 0;
}

/** Caminho e corpo do pedido de cada ação da ordem. */
export function pedidoAcaoOrdem(id: string, acao: AcaoOrdem, texto: string, agentes: readonly string[]): { caminho: string; corpo: Record<string, unknown> } {
  const t = texto.trim();
  if (acao === 'designar') return { caminho: `/endemias/bloqueios/${id}/agentes`, corpo: { agentes: [...agentes] } };
  if (acao === 'concluir') return { caminho: `/endemias/bloqueios/${id}/concluir`, corpo: { nota: t || null } };
  return { caminho: `/endemias/bloqueios/${id}/${acao}`, corpo: { motivo: t } };
}

// ─── Agentes das ordens e titular das zonas ─────────────────────────────────

export interface OpcaoAgente {
  id: string;
  nome: string;
  unidades: string[];
  /** Falso para o designado que perdeu a lotação de campo ou o usuário: aparece só para ser desmarcado. */
  elegivel: boolean;
}

/**
 * Caixas da designação: os agentes elegíveis (lotação de campo ativa e usuário ativo) mais os já designados que deixaram
 * de ser, marcados "sem lotação ativa", primeiro. Sem eles na tela, o designado oculto voltaria no envio sem que a
 * supervisão pudesse tirá-lo.
 */
export function opcoesDesignacao(elegiveis: readonly AgenteEndemias[], designados: readonly { id: string; nome: string | null }[]): OpcaoAgente[] {
  const ids = new Set(elegiveis.map((a) => a.id));
  const fora = designados.filter((d) => !ids.has(d.id)).map((d) => ({ id: d.id, nome: d.nome ?? 'Agente sem nome', unidades: [], elegivel: false }));
  return [...fora, ...elegiveis.map((a) => ({ id: a.id, nome: a.nome, unidades: [...a.unidades], elegivel: true }))];
}

/** Marca ou desmarca um agente; quem está sem lotação ativa só pode sair. */
export function marcarAgente(escolhidos: readonly string[], opcao: OpcaoAgente, marcado: boolean): string[] {
  if (!marcado) return escolhidos.filter((x) => x !== opcao.id);
  return opcao.elegivel && !escolhidos.includes(opcao.id) ? [...escolhidos, opcao.id] : [...escolhidos];
}

export interface OpcaoTitular {
  id: string;
  rotulo: string;
  semLotacao: boolean;
}

/**
 * Opções de titular da zona: os agentes elegíveis e, se o titular atual não estiver entre eles, ele mesmo como "(nome) —
 * sem lotação ativa". Sem essa opção, o campo mostraria "Descoberta" e mandaria o titular antigo. Enquanto a lista
 * carrega (null), o titular aparece sem o aviso.
 */
export function opcoesTitular(agentes: readonly AgenteEndemias[] | null, titular: { id: string; nome: string | null } | null): OpcaoTitular[] {
  const lista: OpcaoTitular[] = (agentes ?? []).map((a) => ({ id: a.id, rotulo: a.nome, semLotacao: false }));
  if (titular && !lista.some((a) => a.id === titular.id)) {
    const semLotacao = agentes !== null;
    const nome = titular.nome ?? 'Titular atual';
    lista.unshift({ id: titular.id, rotulo: semLotacao ? `${nome} — sem lotação ativa` : nome, semLotacao });
  }
  return lista;
}

// ─── Quarteirões da zona ────────────────────────────────────────────────────

export interface OpcaoQuarteiraoZona {
  id: string;
  numero: string;
  localidade: string | null;
  /** "Q 12"; o da zona que a malha desativou, "Q 12 (desativado na malha)". */
  rotulo: string;
}

/**
 * Caixas dos quarteirões no diálogo da zona: os desta zona e depois os livres (ativos e sem zona), filtrados pelo número,
 * localidade ou bairro. O desativado na malha que continua na zona aparece marcado, como no cadastro do imóvel: a API
 * aceita salvar a zona com ele (só o quarteirão que entra é conferido), e ele fica até a supervisão tirá-lo; depois de
 * sair, não volta (não está entre os livres).
 */
export function opcoesQuarteiraoZona(
  daZona: readonly { id: string; numero: string; ativo: boolean }[],
  livres: readonly { id: string; numero: string; localidade: string | null; bairro: string | null }[],
  filtro: string,
): OpcaoQuarteiraoZona[] {
  const busca = filtro.trim().toLowerCase();
  const naZona = new Set(daZona.map((q) => q.id));
  const todos = [
    ...daZona.map((q) => ({ id: q.id, numero: q.numero, localidade: null, bairro: null, rotulo: `Q ${q.numero}${q.ativo ? '' : ' (desativado na malha)'}` })),
    ...livres.filter((q) => !naZona.has(q.id)).map((q) => ({ id: q.id, numero: q.numero, localidade: q.localidade, bairro: q.bairro, rotulo: `Q ${q.numero}` })),
  ];
  return todos.filter((q) => !busca || `${q.numero} ${q.localidade ?? ''} ${q.bairro ?? ''}`.toLowerCase().includes(busca)).map(({ id, numero, localidade, rotulo }) => ({ id, numero, localidade, rotulo }));
}

// ─── Baixas de larvicida pendentes ──────────────────────────────────────────

/**
 * Depósito sugerido para resolver a baixa: o da própria baixa; senão, o depósito de endemias da unidade da visita, se
 * houver um só; senão nenhum, e a supervisão escolhe de qual depósito saiu o larvicida.
 */
export function depositoSugerido(baixa: Pick<BaixaPendente, 'depositoId' | 'unidadeVisita'>, depositos: readonly DepositoEndemias[]): string {
  if (baixa.depositoId && depositos.some((d) => d.id === baixa.depositoId)) return baixa.depositoId;
  const daUnidade = baixa.unidadeVisita === null ? [] : depositos.filter((d) => d.unidade === baixa.unidadeVisita);
  return daUnidade.length === 1 ? (daUnidade[0]?.id ?? '') : '';
}

export interface OpcaoLote {
  id: string;
  rotulo: string;
  desabilitado: boolean;
}

const dataBr = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/**
 * Lotes para resolver a baixa no depósito escolhido. BAIXAR sai do saldo desse depósito: só os lotes do produto com
 * saldo nele, e o que não cobre a quantidade aparece desabilitado. REGULARIZAR ajusta a diferença e baixa no mesmo
 * depósito: vale qualquer lote conhecido do produto, a começar pelo lote anotado na visita.
 */
export function lotesParaResolver(p: { acao: 'BAIXAR' | 'REGULARIZAR'; lotes: readonly LoteDeposito[]; depositoId: string; baixa: Pick<BaixaPendente, 'loteId' | 'lote' | 'quantidade' | 'unidade'> }): OpcaoLote[] {
  if (!p.depositoId) return [];
  const un = p.baixa.unidade;
  const noDeposito = p.lotes.filter((l) => l.depositoId === p.depositoId);
  const validade = (l: LoteDeposito) => `validade ${dataBr(l.validade)}${l.vencido ? ' (vencido)' : ''}`;
  if (p.acao === 'BAIXAR')
    return noDeposito
      .filter((l) => l.saldo > 0)
      .map((l) => {
        const falta = l.saldo < p.baixa.quantidade;
        return { id: l.loteId, rotulo: `${l.lote} · saldo ${fmtQuantidade(l.saldo)} ${un} · ${validade(l)}${falta ? ' · saldo insuficiente' : ''}`, desabilitado: falta };
      });
  const porLote = new Map<string, OpcaoLote>();
  const daVisita = p.baixa.loteId ? p.lotes.find((l) => l.loteId === p.baixa.loteId) : undefined;
  if (p.baixa.loteId && !daVisita) porLote.set(p.baixa.loteId, { id: p.baixa.loteId, rotulo: `${p.baixa.lote ?? 'Lote da visita'} · lote da visita, sem saldo nos depósitos`, desabilitado: false });
  for (const l of daVisita ? [daVisita, ...p.lotes] : p.lotes) {
    if (porLote.has(l.loteId)) continue;
    const saldo = noDeposito.find((x) => x.loteId === l.loteId)?.saldo ?? 0;
    porLote.set(l.loteId, { id: l.loteId, rotulo: `${l.lote} · saldo neste depósito ${fmtQuantidade(saldo)} ${un} · ${validade(l)}`, desabilitado: false });
  }
  return [...porLote.values()];
}

/** O valor escolhido só vale se estiver entre as opções habilitadas; senão o campo mostraria uma opção e mandaria outra. */
export const valorEntre = (valor: string, opcoes: readonly { id: string; desabilitado?: boolean }[]) => (opcoes.some((o) => o.id === valor && !o.desabilitado) ? valor : '');

// ─── Pendências ─────────────────────────────────────────────────────────────

/** Teto da lista de imóveis pendentes na API (os de última visita mais recente). */
export const LIMITE_PENDENCIAS = 2000;

export const avisoLimitePendencias = (quantos: number) =>
  quantos >= LIMITE_PENDENCIAS ? `Mostrando os ${LIMITE_PENDENCIAS.toLocaleString('pt-BR')} imóveis com a última visita mais recente: recupere estes para ver os demais.` : null;

/**
 * Tentativas desde a última visita trabalhada, separando o imóvel fechado da recusa e do abandono: na Lei 13.301/2016
 * (art. 1º, § 2º) são hipóteses diferentes, e só o fechado conta para a ausência.
 */
export function textoTentativas(p: { tentativas: number; fechados: number; recusas: number }): string {
  const abandonos = Math.max(0, p.tentativas - p.fechados - p.recusas);
  return [
    p.fechados ? `${p.fechados} com o imóvel fechado` : null,
    p.recusas ? `${p.recusas} ${p.recusas === 1 ? 'recusa' : 'recusas'}` : null,
    abandonos ? `${abandonos} ${abandonos === 1 ? 'abandonado' : 'abandonados'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
