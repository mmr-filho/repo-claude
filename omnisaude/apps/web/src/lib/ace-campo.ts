import { LIMITES_CAMPO_ACE, TIPO_IMOVEL, type AtividadeVetorial, type OperacaoAce, type TratamentoCampo } from '@omnisaude/shared';
import type { ImovelCampoView, LoteCampo, PacoteCampo, ProdutoCampo } from '@/components/endemias/types';
import { ApiError } from './api';

/**
 * Regras do app de campo do ACE que não dependem da tela nem do banco do aparelho: lote e produto sugeridos, numeração
 * dos tubitos, linha de larvicida puxada pela tabela de depósitos, ordem da visita, efeito no pacote do que o servidor
 * aceitou, registros da fila na tela e leitura das falhas da sincronização.
 */

export type ImovelOp = Extract<OperacaoAce, { tipo: 'IMOVEL' }>;
export type VisitaOp = Extract<OperacaoAce, { tipo: 'VISITA_VETORIAL' }>;

// ─── Larvicida ────────────────────────────────────────────────────────────────

/** Lote sugerido: o primeiro não vencido (os lotes vêm do mais perto de vencer); só com vencidos, o primeiro; sem lote, nenhum. */
export function loteSugerido(lotes: readonly LoteCampo[]): string | null {
  return lotes.find((l) => !l.vencido)?.loteId ?? lotes[0]?.loteId ?? null;
}

export interface ProdutoDoFormulario {
  id: string;
  nome: string;
  unidade: string;
  /** Lotes com saldo no depósito da unidade (sugestão); vazio quando o produto não tem saldo no pacote. */
  lotes: LoteCampo[];
}

/**
 * Produtos do formulário: o catálogo do pacote (com ou sem saldo), cada um com os lotes com saldo. O pacote guardado por
 * versão anterior do app não tem o catálogo: aí só os produtos com lote.
 */
export function produtosDoFormulario(produtos: readonly ProdutoCampo[] | null | undefined, estoque: readonly LoteCampo[]): ProdutoDoFormulario[] {
  const m = new Map<string, ProdutoDoFormulario>();
  for (const p of produtos ?? []) m.set(p.id, { id: p.id, nome: p.descricao, unidade: p.unidade, lotes: [] });
  for (const l of estoque) {
    const p = m.get(l.produtoId) ?? { id: l.produtoId, nome: l.produto, unidade: l.unidade, lotes: [] };
    p.lotes.push(l);
    m.set(l.produtoId, p);
  }
  return [...m.values()];
}

/**
 * Produto de uma linha nova: o primeiro com lote válido no depósito, depois o primeiro com algum lote, depois o primeiro
 * do catálogo; os que já estão em outra linha ficam para o fim.
 */
export function produtoSugerido(produtos: readonly ProdutoDoFormulario[], emUso: ReadonlySet<string> = new Set()): ProdutoDoFormulario | null {
  const livres = produtos.filter((p) => !emUso.has(p.id));
  for (const lista of [livres, produtos]) {
    const p = lista.find((x) => x.lotes.some((l) => !l.vencido)) ?? lista.find((x) => x.lotes.length) ?? lista[0];
    if (p) return p;
  }
  return null;
}

/** Linha de larvicida do formulário: a quantidade fica como digitada ("1," a caminho de "1,5"). */
export interface LinhaTratamento extends TratamentoCampo {
  chave: string;
  qtdTexto: string;
  /** Criada pela tabela de depósitos: acompanha o total de tratados até o agente mexer nos depósitos dela. */
  automatica?: boolean;
}

/**
 * Linha de larvicida puxada pela tabela de depósitos: aparece quando o total de tratados passa de zero, acompanha o total
 * enquanto o agente não mexer nos depósitos dela (digitar "12" passa por "1") e some se o total voltar a zero sem
 * quantidade digitada. Devolve o mesmo array quando nada muda.
 */
export function ajustarLinhaAutomatica<T extends LinhaTratamento>(linhas: T[], totalTratados: number, criar: (depositos: number) => T | null): T[] {
  if (!linhas.length) {
    if (totalTratados <= 0) return linhas;
    const nova = criar(totalTratados);
    return nova ? [nova] : linhas;
  }
  const unica = linhas[0];
  if (linhas.length !== 1 || !unica || !unica.automatica) return linhas;
  if (totalTratados <= 0) return unica.qtdTexto.trim() ? linhas : [];
  return unica.depositos === totalTratados ? linhas : [{ ...unica, depositos: totalTratados }];
}

/** Quantidade guardada de volta no formato do campo ("2,5"; sem separador de milhar). */
export function quantidadeParaTexto(n: number | null | undefined): string {
  return n != null && Number.isFinite(n) && n > 0 ? n.toLocaleString('pt-BR', { maximumFractionDigits: 3, useGrouping: false }) : '';
}

// ─── Tubitos ──────────────────────────────────────────────────────────────────

/** Número seguinte na sequência do agente: de 1 a 999 e recomeça em 1 (sem número válido, começa no 1). */
export function seguinteTubito(n: number | null | undefined): number {
  const atual = n != null && Number.isInteger(n) && n >= 1 && n <= LIMITES_CAMPO_ACE.tubito ? n : 0;
  return (atual % LIMITES_CAMPO_ACE.tubito) + 1;
}

/** Número que o botão dá: a posição atual da sequência, pulando os que já estão na visita. */
export function numeroDoBotao(proximo: number, usados: ReadonlySet<number>): number {
  let n = Number.isInteger(proximo) && proximo >= 1 && proximo <= LIMITES_CAMPO_ACE.tubito ? proximo : 1;
  for (let i = 0; i < LIMITES_CAMPO_ACE.tubito && usados.has(n); i++) n = seguinteTubito(n);
  return n;
}

// ─── Datas ────────────────────────────────────────────────────────────────────

const doisDigitos = (n: number) => String(n).padStart(2, '0');

/** Data (AAAA-MM-DD) de um instante no fuso do aparelho. */
export function dataLocal(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;
}

/** 'AAAA-MM-DDTHH:mm' no fuso do aparelho, para o campo datetime-local (instante inválido: agora). */
export function paraDataHoraLocal(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const v = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${dataLocal(v.toISOString())}T${doisDigitos(v.getHours())}:${doisDigitos(v.getMinutes())}`;
}

// ─── Efeito no pacote do que o servidor aceitou ───────────────────────────────

/** Operação aceita pelo servidor (OK ou DUPLICADA) e o id do que ela gravou. */
export interface AceitoAce {
  op: OperacaoAce;
  id: string | null;
  /**
   * Visita: a ordem de bloqueio em que o servidor a gravou (null: sem ordem). Ausente quando o servidor não diz (versão
   * anterior): aí vale só a ordem informada na visita.
   */
  ordemId?: string | null;
}

/** Imóvel novo como aparece na lista: com o id do servidor depois de aceito, ou com o clientId enquanto está na fila. */
export function imovelDaOperacao(op: ImovelOp, id: string, pendente: boolean): ImovelCampoView {
  const d = op.dados;
  return {
    id,
    quarteiraoId: d.blockId,
    sequencia: d.sequencia?.trim().toUpperCase() || null,
    endereco:
      [d.street, d.number, d.complement]
        .map((x) => x?.trim())
        .filter(Boolean)
        .join(', ') ||
      d.observacoes?.trim() ||
      'Imóvel novo',
    tipo: d.propertyType,
    tipoLabel: TIPO_IMOVEL[d.propertyType] ?? 'Outros',
    lat: d.latitude ?? null,
    lng: d.longitude ?? null,
    posicaoAproximada: d.latitude == null,
    precisaoLabel: d.latitude != null ? 'GPS em campo' : 'Sem posição',
    observacao: d.observacoes?.trim() || null,
    noCiclo: null,
    ...(pendente ? { pendente: true } : {}),
  };
}

/** Ordem do contexto do formulário da visita: o número para o agente e a abertura para a regra da data. */
export interface OrdemDoContexto {
  id: string;
  numero: string;
  /** Abertura da ordem, do pacote. Sem ela, o formulário manda a ordem com qualquer data, e o servidor confere. */
  abertaEm?: string | null;
}

/** Ordem ativa mais recente do pacote que contém o quarteirão: a do roteiro, que abre a visita nova já com ela. */
export function ordemMaisRecente(ordens: PacoteCampo['ordens'], quarteiraoId: string): OrdemDoContexto | null {
  const o = ordens.filter((x) => x.quarteiroes.some((q) => q.id === quarteiraoId)).sort((a, b) => Date.parse(b.abertaEm) - Date.parse(a.abertaEm))[0];
  return o ? { id: o.id, numero: o.numero, abertaEm: o.abertaEm } : null;
}

/**
 * Ordem que o formulário da visita recebe, sempre com a abertura do pacote (sem ela, a regra da data do formulário não
 * liga). Com a ordem informada (a da lista da ordem, ou a da visita da fila que está sendo corrigida), essa; a que saiu
 * do pacote vai sem a abertura, e o servidor confere. Sem ordem informada (roteiro e mapa, ou a visita da fila gravada sem
 * a ordem pela data, pela atividade ou por falta de ordem no quarteirão), a ordem do quarteirão do imóvel, como no
 * roteiro: corrigida a data ou a atividade, a visita volta para a ordem.
 */
export function ordemDoContexto(ordens: PacoteCampo['ordens'] | null | undefined, quarteiraoId: string | null | undefined, ordemId?: string | null): OrdemDoContexto | null {
  if (ordemId) {
    const o = ordens?.find((x) => x.id === ordemId);
    return o ? { id: o.id, numero: o.numero, abertaEm: o.abertaEm } : { id: ordemId, numero: '?', abertaEm: null };
  }
  return ordens && quarteiraoId ? ordemMaisRecente(ordens, quarteiraoId) : null;
}

/**
 * Ordens ativas do pacote que contêm o quarteirão do imóvel, com a abertura: as candidatas da visita de bloqueio de dia
 * anterior ao da abertura da ordem do contexto (ver `ordemDoFormulario`). O pacote só traz as abertas e em campo
 * designadas ao agente.
 */
export function ordensDoQuarteirao(ordens: PacoteCampo['ordens'] | null | undefined, quarteiraoId: string | null | undefined): OrdemDoContexto[] {
  if (!ordens || !quarteiraoId) return [];
  return ordens.filter((o) => (o.status === 'ABERTA' || o.status === 'EM_CAMPO') && o.quarteiroes.some((q) => q.id === quarteiraoId)).map((o) => ({ id: o.id, numero: o.numero, abertaEm: o.abertaEm }));
}

/** Dia da abertura no fuso do aparelho; null sem a abertura ou com ela ilegível. */
const diaDaAbertura = (o: OrdemDoContexto) => (o.abertaEm && !Number.isNaN(Date.parse(o.abertaEm)) ? dataLocal(o.abertaEm) : null);

/**
 * A mais recente das candidatas aberta até o dia da visita, como o servidor escolhe a ordem da visita de bloqueio sem
 * ordem informada (pela abertura e, no empate, pelo id). A de abertura ilegível fica de fora.
 */
function ordemAbertaAte(candidatas: readonly OrdemDoContexto[], dia: string, exceto: string): OrdemDoContexto | null {
  let achada: { ordem: OrdemDoContexto; em: number } | null = null;
  for (const o of candidatas) {
    const abertura = diaDaAbertura(o);
    if (o.id === exceto || !abertura || abertura > dia) continue;
    const em = Date.parse(o.abertaEm!);
    if (!achada || em > achada.em || (em === achada.em && o.id > achada.ordem.id)) achada = { ordem: o, em };
  }
  return achada?.ordem ?? null;
}

/**
 * Ordem que a visita do formulário leva: a do contexto (ver `ordemDoContexto`), só na visita de bloqueio e com a data a
 * partir do dia da abertura, no fuso do aparelho. A do dia da abertura, mesmo antes da hora dela, vai com a ordem. A de
 * dia anterior (visita anotada em papel e registrada depois) não entra nela: a ordem não existia quando ela foi feita.
 * Ela segue a regra do servidor para a de bloqueio sem ordem, com as ordens do pacote que contêm o quarteirão
 * (`candidatas`, ver `ordensDoQuarteirao`): vai para a mais recente já aberta no dia dela, ou sem ordem, com o aviso na
 * tela. Assim a lista da ordem em que o servidor vai gravá-la já mostra a casa na fila. Sem a abertura no contexto ou com
 * a data ilegível, vai a ordem do contexto, e o servidor confere.
 */
export function ordemDoFormulario(
  ordem: OrdemDoContexto | null | undefined,
  atividade: AtividadeVetorial,
  quando: string,
  candidatas?: readonly OrdemDoContexto[] | null,
): { ordemId: string | null; aviso: string | null } {
  if (!ordem || atividade !== 'BLOQUEIO') return { ordemId: null, aviso: null };
  const abertura = diaDaAbertura(ordem);
  if (!abertura || Number.isNaN(new Date(quando).getTime())) return { ordemId: ordem.id, aviso: null };
  const dia = dataLocal(quando);
  if (dia >= abertura) return { ordemId: ordem.id, aviso: null };
  const antes = `A data é anterior à abertura da ordem ${ordem.numero}`;
  const ja = ordemAbertaAte(candidatas ?? [], dia, ordem.id);
  return ja ? { ordemId: ja.id, aviso: `${antes}: a visita vai para a ordem ${ja.numero}, já aberta no dia dela` } : { ordemId: null, aviso: `${antes}: a visita não vai entrar nela` };
}

const maisNova = (atual: { em: string } | null | undefined, em: string) => !atual || Date.parse(em) >= Date.parse(atual.em);

/**
 * Aplica no pacote o que o servidor aceitou, para a tela não voltar ao estado do pacote baixado antes do envio (o imóvel
 * visitado como "sem visita", o imóvel novo sumindo da lista): o imóvel novo entra com o id do servidor; a visita marca a
 * situação do imóvel no ciclo (quando a data cai no ciclo do pacote) e na ordem de bloqueio em que o servidor a gravou
 * (sem a resposta dele, só na informada: a de bloqueio sem ordem pode ter ficado fora da ordem aberta depois do dia dela);
 * o larvicida com lote sai do saldo do lote. O pacote baixado depois do envio substitui tudo (o servidor já tem o efeito).
 */
export function aplicarAceitosNoPacote(pacote: PacoteCampo, aceitos: readonly AceitoAce[]): PacoteCampo {
  if (!aceitos.length) return pacote;
  let imoveis = pacote.imoveis;
  let ordens = pacote.ordens;
  let estoque = pacote.estoque;
  const idDoImovelNovo = new Map<string, string>();
  for (const a of aceitos) if (a.op.tipo === 'IMOVEL' && a.id) idDoImovelNovo.set(a.op.clientId, a.id);
  for (const { op, id, ordemId: gravadaEm } of aceitos) {
    if (op.tipo === 'IMOVEL') {
      if (id && !imoveis.some((i) => i.id === id)) imoveis = [...imoveis, imovelDaOperacao(op, id, false)];
      continue;
    }
    const v = op.visita;
    const householdId = op.householdId ?? (op.householdClientId ? idDoImovelNovo.get(op.householdClientId) : undefined) ?? null;
    if (householdId) {
      const marca = { situacao: v.situacao, em: op.registradoEm };
      const dia = dataLocal(op.registradoEm);
      if (dia >= pacote.ciclo.inicio && dia <= pacote.ciclo.fim) imoveis = imoveis.map((i) => (i.id === householdId && maisNova(i.noCiclo, marca.em) ? { ...i, noCiclo: marca } : i));
      const ordemId = gravadaEm !== undefined ? gravadaEm : (v.ordemId ?? null);
      if (ordemId) ordens = ordens.map((o) => (o.id === ordemId && maisNova(o.visitados[householdId], marca.em) ? { ...o, visitados: { ...o.visitados, [householdId]: marca } } : o));
    }
    for (const t of v.tratamentos ?? []) {
      if (!t.loteId || !(t.quantidade > 0)) continue;
      estoque = estoque.map((l) => (l.loteId === t.loteId ? { ...l, saldo: Math.round((l.saldo - t.quantidade) * 1000) / 1000 } : l));
    }
  }
  return { ...pacote, imoveis, ordens, estoque };
}

// ─── Fila e falhas da sincronização ───────────────────────────────────────────

/** O item é desta lotação, ou é de antes da regra (sem unidade): só esses vão com a sessão ativa. */
export function daLotacao(item: { unitId?: string | null }, unitId: string | null): boolean {
  return item.unitId == null || item.unitId === unitId;
}

/** Registro da fila do aparelho como as regras da tela o leem (ver ItemFilaAce em ace-store.ts). */
export interface RegistroDaFila {
  clientId: string;
  op: OperacaoAce;
  status: 'PENDENTE' | 'ERRO';
  erro?: string | null;
  /** Versão que o servidor gravou enquanto o agente corrigia o registro (ver ItemFilaAce.versaoGravada; pode ser 0). */
  versaoGravada?: number | null;
}

/**
 * O servidor gravou a versão anterior do registro enquanto o agente o corrigia: a correção não vai mais (o reenvio volta
 * DUPLICADA e o registro volta ao erro), e o efeito da versão gravada já entrou no pacote. O registro só espera o
 * descarte: não é corrigido nem reenviado, não entra nas listas da tela e não conta no saldo do larvicida.
 */
export function comVersaoGravada(item: { versaoGravada?: number | null }): boolean {
  return item.versaoGravada != null;
}

export type AcaoDaFila = 'corrigir' | 'tentarDeNovo' | 'descartar';

/**
 * Botões do registro na aba Fila. Corrigir e tentar de novo só no recusado desta lotação; o com a versão anterior gravada
 * só sai pelo descarte (corrigido ou reenviado, o servidor responde DUPLICADA e ele volta ao mesmo erro).
 */
export function acoesDoItem(item: RegistroDaFila, daLotacaoAtiva: boolean): AcaoDaFila[] {
  return item.status === 'ERRO' && daLotacaoAtiva && !comVersaoGravada(item) ? ['corrigir', 'tentarDeNovo', 'descartar'] : ['descartar'];
}

/**
 * Visitas da fila que saem junto com o imóvel novo descartado: as que o citam pelo clientId (sem ele no servidor, não têm
 * como ser gravadas). Com a versão anterior do imóvel gravada, nenhuma: o servidor acha o imóvel pelo clientId (o registro
 * da sincronização em que ele foi gravado) e grava as visitas nele.
 */
export function dependentesDoImovel<T extends { op: OperacaoAce }>(itens: readonly T[], imovel: { clientId: string; versaoGravada?: number | null }): T[] {
  if (comVersaoGravada(imovel)) return [];
  return itens.filter((i) => i.op.tipo === 'VISITA_VETORIAL' && i.op.householdClientId === imovel.clientId);
}

/**
 * Imóveis novos da fila na lista do quarteirão (já podem ser visitados), com a recusa do envio. O com a versão anterior
 * gravada fica de fora: o pacote já tem o imóvel, com o id do servidor.
 */
export function imoveisDaFila(itens: readonly RegistroDaFila[]): ImovelCampoView[] {
  return itens.flatMap((i) => (i.op.tipo === 'IMOVEL' && !comVersaoGravada(i) ? [{ ...imovelDaOperacao(i.op, i.clientId, true), erroNaFila: i.status === 'ERRO' ? (i.erro ?? null) : null }] : []));
}

/** Situação de um imóvel pela fila: a da última visita dele que ainda está no aparelho, com a ordem dela. */
export interface VisitaNaFila {
  situacao: string;
  em: string;
  ordemId: string | null;
}

/**
 * Última visita de cada imóvel na fila (pelo id, ou pelo clientId do imóvel novo): sobrepõe a situação baixada. A com a
 * versão anterior gravada fica de fora: vale a gravada, que já entrou no pacote.
 */
export function visitasNaFila(itens: readonly RegistroDaFila[]): Map<string, VisitaNaFila> {
  const m = new Map<string, VisitaNaFila>();
  for (const i of itens) {
    if (i.op.tipo !== 'VISITA_VETORIAL' || comVersaoGravada(i)) continue;
    const alvo = i.op.householdId ?? i.op.householdClientId;
    const atual = alvo ? m.get(alvo) : undefined;
    if (alvo && (!atual || Date.parse(i.op.registradoEm) >= Date.parse(atual.em))) m.set(alvo, { situacao: i.op.visita.situacao, em: i.op.registradoEm, ordemId: i.op.visita.ordemId ?? null });
  }
  return m;
}

/**
 * Larvicida por lote nas visitas da fila: o saldo da tela é o do pacote menos este. A com a versão anterior gravada fica
 * de fora: o pacote já descontou o da versão gravada.
 */
export function usoDaFila(itens: readonly RegistroDaFila[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of itens) {
    if (i.op.tipo !== 'VISITA_VETORIAL' || comVersaoGravada(i)) continue;
    for (const t of i.op.visita.tratamentos ?? []) if (t.loteId) m.set(t.loteId, (m.get(t.loteId) ?? 0) + t.quantidade);
  }
  return m;
}

/** Motivo de uma rodada de envio interrompida (os itens não enviados continuam pendentes no aparelho). */
export type FalhaSync = 'rede' | 'servidor' | 'sessao' | 'limite' | 'permissao' | 'aparelho';

/**
 * Lê a falha do envio de um lote. 'conteudo' (400 e 422) é a recusa do lote pelo que ele contém: os itens viram erro com
 * a mensagem. O resto interrompe a rodada e mantém os itens pendentes: sem rede ou sem resposta no prazo, sessão vencida,
 * sem permissão, limite de requisições e servidor fora (5xx, 404 durante uma publicação).
 */
export function classificarFalha(err: unknown): FalhaSync | 'conteudo' {
  if (!(err instanceof ApiError)) return 'rede';
  if (err.status === 0 || err.status === 408) return 'rede';
  if (err.status === 401) return 'sessao';
  if (err.status === 403) return 'permissao';
  if (err.status === 429) return 'limite';
  if (err.status === 400 || err.status === 422) return 'conteudo';
  return 'servidor';
}

/**
 * Erros por operação num 400 do lote inteiro: 'operacoes.N.campo' aponta a operação N do lote. Devolve clientId →
 * mensagem, ou null quando os detalhes não apontam operações (aí todas levam a mensagem do servidor).
 */
export function errosPorOperacao(details: unknown, lote: readonly { clientId: string }[]): Map<string, string> | null {
  if (!Array.isArray(details) || !details.length) return null;
  const porOp = new Map<string, string[]>();
  for (const d of details as { path?: unknown; message?: unknown }[]) {
    const caminho = typeof d?.path === 'string' ? d.path : Array.isArray(d?.path) ? d.path.join('.') : '';
    const m = /^operacoes\.(\d+)(?:\.(.+))?$/.exec(caminho);
    const op = m ? lote[Number(m[1])] : undefined;
    if (!m || !op) return null;
    const texto = `${m[2] ? `${m[2]}: ` : ''}${typeof d.message === 'string' && d.message ? d.message : 'valor inválido'}`;
    porOp.set(op.clientId, [...(porOp.get(op.clientId) ?? []), texto]);
  }
  return new Map([...porOp].map(([clientId, textos]) => [clientId, `Dados inválidos: ${textos.join('; ')}`]));
}
