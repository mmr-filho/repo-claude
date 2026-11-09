'use client';

import { ordenarOperacoesAce, type OperacaoAce, type ResultadoSyncAce } from '@omnisaude/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PacoteCampo } from '@/components/endemias/types';
import { aplicarAceitosNoPacote, classificarFalha, daLotacao, errosPorOperacao, type AceitoAce, type FalhaSync } from './ace-campo';
import { api, ApiError, errorMessage } from './api';
import { comPrazo, ErroAparelho, estaOnline, localAce, type Gravacao } from './offline';

/**
 * Fila de campo do agente de combate às endemias: o que o ACE registra (visitas e imóveis novos) fica no aparelho
 * (IndexedDB) e vai para /endemias/campo/sync quando há conexão. Cada item guarda quem registrou e em que lotação: outro
 * usuário no mesmo aparelho não envia o trabalho alheio, e o registro feito numa unidade só vai com a sessão dessa unidade
 * (a visita, a baixa do larvicida e a ficha do e-SUS são da unidade). Queda de rede, sessão vencida, servidor fora e
 * falha passageira (TENTAR_DE_NOVO) deixam o item pendente; só a recusa da operação vira erro, com a mensagem. O
 * resultado de um envio é da versão enviada: a correção salva no meio dele não fica com o resultado (ItemFilaAce.versao).
 * Sem a resposta, o registro lembra a versão que foi (ItemFilaAce.semResposta): o servidor pode tê-la gravado.
 */
export interface ContextoAce {
  userId: string;
  /** Unidade da lotação ativa. */
  unitId: string | null;
}

export interface ItemFilaAce {
  clientId: string;
  op: OperacaoAce;
  userId: string;
  /** Unidade da lotação ativa no registro; ausente nos registros de antes da regra (vão com qualquer lotação). */
  unitId?: string | null;
  status: 'PENDENTE' | 'ERRO';
  erro: string | null;
  /** Falha passageira na última tentativa: continua pendente e vai no próximo envio. */
  adiado?: string | null;
  avisos?: string[];
  criadoEm: string;
  rotulo: string;
  /**
   * Versão do registro (ausente = 0): só a correção a incrementa. O resultado de um envio só vale para o item se a versão
   * não mudou no meio; a regravação pelo imóvel novo aceito e o tentar de novo não mudam a versão.
   */
  versao?: number;
  /**
   * Versão que o servidor gravou enquanto o agente corrigia o registro. O servidor fica com ela: o reenvio da correção
   * (mesmo clientId) volta DUPLICADA sem gravar nada, e o registro continua com o erro até ser descartado.
   */
  versaoGravada?: number;
  /**
   * Versão enviada que ficou sem resposta (sem rede, prazo, servidor fora, aba fechada, falha ao gravar o resultado): o
   * servidor pode tê-la gravado. Marcada antes do POST, só se o registro ainda não tem uma (fica a mais antiga: o servidor
   * grava a primeira versão que chega). A resposta do registro a apaga (OK, DUPLICADA e ERRO); a falha passageira, não.
   * O lote recusado inteiro antes de o servidor processá-lo (400 ou 422 do lote, sessão, permissão, limite) apaga só a
   * marca que o próprio POST pôs, e só com a trava entre abas (sem ela, outra aba pode estar contando com a mesma marca).
   * A DUPLICADA de outra versão quer dizer que o servidor ficou com esta: o histórico e o pacote recebem o efeito dela, e
   * o registro fica com o erro da versão anterior gravada.
   */
  semResposta?: { versao: number; op: OperacaoAce; rotulo: string };
}

export interface EnviadoAce {
  clientId: string;
  tipo: OperacaoAce['tipo'];
  rotulo: string;
  id: string | null;
  em: string;
  avisos?: string[];
}

export interface ResumoSyncAce {
  enviados: number;
  duplicados: number;
  erros: number;
  /** Ficaram para o próximo envio (falha passageira no servidor). */
  adiados: number;
  avisos: number;
  /** Pendentes desta lotação no início da rodada. */
  pendentes: number;
  /** Pendentes desta lotação que continuam no aparelho no fim. */
  restantes: number;
  /** Motivo da interrupção; null quando a rodada foi até o fim. */
  falha: FalhaSync | null;
  mensagem: string | null;
  /** Aceitos pelo servidor (OK e DUPLICADA), para aplicar no pacote da tela. */
  aceitos: AceitoAce[];
}

export interface PacoteGuardado {
  data: PacoteCampo;
  /** Quando o pacote foi baixado do servidor. */
  savedAt: string;
}

/** O envio tem até 100 operações pequenas; o pacote pode ser grande (zona inteira com as geometrias). */
const PRAZO_ENVIO_MS = 20_000;
const PRAZO_PACOTE_MS = 30_000;
const FALHA_PASSAGEIRA = 'Falha passageira no servidor: vai no próximo envio';
const VERSAO_ANTERIOR_GRAVADA = 'O servidor gravou a versão anterior deste registro enquanto você corrigia: a correção não foi enviada. Confira e descarte o registro.';

const ouvintes = new Set<() => void>();
const avisar = () => ouvintes.forEach((f) => f());
const chaveHistorico = (userId: string) => `historico-ace:${userId}`;
const chaveTubito = (userId: string) => `tubito:${userId}`;
const chavePacote = (ctx: ContextoAce) => `pacote:ace:${ctx.unitId ?? ''}:${ctx.userId}`;

/**
 * Envio e download do pacote, um por vez, nesta aba e entre as abas do app (o banco do aparelho é o mesmo): o pacote
 * baixado durante um envio não traria o efeito dele, e o efeito aplicado depois contaria duas vezes o larvicida; duas abas
 * enviando a mesma fila receberiam OK numa e DUPLICADA na outra, e as duas aplicariam o efeito no pacote guardado. Entre
 * abas vale a trava do navegador (Web Locks API); sem ela (navegador antigo, página fora de HTTPS), a ordem é só desta
 * aba, e gravarResultados não aplica de novo o que a outra aba já tirou da fila e pôs no histórico.
 */
const TRAVA_ENVIO = 'omnisaude-campo-ace:envio';
let ultimo: Promise<unknown> = Promise.resolve();
/** `fn` recebe se roda com a trava entre abas (nenhuma outra aba envia nem baixa ao mesmo tempo). */
function emSequencia<T>(fn: (comTrava: boolean) => Promise<T>): Promise<T> {
  const rodar = () => entreAbas(fn);
  const r = ultimo.then(rodar, rodar);
  ultimo = r.catch(() => undefined);
  return r;
}

async function entreAbas<T>(fn: (comTrava: boolean) => Promise<T>): Promise<T> {
  const travas = typeof navigator === 'undefined' ? undefined : (navigator as { locks?: LockManager }).locks;
  if (typeof travas?.request !== 'function') return fn(false);
  let rodou = false;
  try {
    return await travas.request(TRAVA_ENVIO, () => {
      rodou = true;
      return fn(true);
    });
  } catch (e) {
    if (rodou) throw e;
    // O navegador recusou a trava (ex.: documento sem permissão): segue só com a ordem desta aba.
    console.warn('Trava entre abas indisponível', e);
    return fn(false);
  }
}

async function itensDoUsuario(userId: string): Promise<ItemFilaAce[]> {
  return (await localAce.all<ItemFilaAce>('fila')).filter((i) => i.userId === userId).sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
}

/** Contador de tubitos gravado junto com o registro (na mesma transação): só avança se a visita foi guardada. */
function gravacaoDoTubito(userId: string, ultimoTubito: number | null | undefined): Gravacao[] {
  return ultimoTubito != null ? [{ store: 'cache', put: { key: chaveTubito(userId), data: ultimoTubito, savedAt: new Date().toISOString() } }] : [];
}

/** Versão do registro na fila; ausente nos de antes da regra. */
const versaoDe = (item: ItemFilaAce) => item.versao ?? 0;

/** O registro foi corrigido depois de lido para o envio: o resultado que volta é da versão anterior. */
const mudouNoEnvio = (item: ItemFilaAce, enviado: ItemFilaAce | undefined) => !!enviado && versaoDe(item) !== versaoDe(enviado);

/** O registro sem a marca da versão enviada sem resposta. */
function semMarca(item: ItemFilaAce): ItemFilaAce {
  const { semResposta: _semResposta, ...resto } = item;
  return resto;
}

/** A mesma marca (versão e operação): a posta por outro envio não sai no lugar desta. */
function mesmaMarca(a: ItemFilaAce['semResposta'], b: ItemFilaAce['semResposta']) {
  return !!a && !!b && a.versao === b.versao && JSON.stringify(a.op) === JSON.stringify(b.op);
}

/** A visita que cita o imóvel novo aceito pelo clientId, citando o id do servidor (é o mesmo imóvel); null se não cita. */
function comImovelDoServidor(op: OperacaoAce, idDoImovel: ReadonlyMap<string, string>): OperacaoAce | null {
  if (op.tipo !== 'VISITA_VETORIAL' || !op.householdClientId) return null;
  const id = idDoImovel.get(op.householdClientId);
  return id ? { ...op, householdId: id, householdClientId: null } : null;
}

/** Imóveis novos aceitos: clientId → id no servidor. */
const idsDosImoveisNovos = (aceitos: readonly AceitoAce[]) => new Map(aceitos.flatMap((a) => (a.op.tipo === 'IMOVEL' && a.id ? [[a.op.clientId, a.id] as const] : [])));

/** Histórico com os mais novos primeiro e sem repetição (duas sincronizações não duplicam a entrada). */
function semRepetidos(lista: EnviadoAce[]): EnviadoAce[] {
  const vistos = new Set<string>();
  return lista.filter((e) => !vistos.has(e.clientId) && !!vistos.add(e.clientId));
}

export const historicoAce = {
  listar: async (userId: string) => semRepetidos((await localAce.get<{ data: EnviadoAce[] }>('cache', chaveHistorico(userId)))?.data ?? []),
};

export const contadorTubito = {
  /** Posição da sequência de tubitos do agente: o último número dado pelo botão (0 quando nunca usou). */
  ler: async (userId: string) => (await localAce.get<{ data: number }>('cache', chaveTubito(userId)))?.data ?? 0,
};

export const pacoteAce = {
  async guardado(ctx: ContextoAce): Promise<PacoteGuardado | null> {
    const e = await localAce.get<{ data: PacoteCampo; savedAt: string }>('cache', chavePacote(ctx));
    return e ? { data: e.data, savedAt: e.savedAt } : null;
  },
  /**
   * Baixa o pacote (com prazo), guarda e devolve. Espera o envio em andamento. A falha sobe para a tela, que continua com
   * o pacote que tem (nunca volta para uma cópia mais velha).
   */
  baixar(ctx: ContextoAce): Promise<PacoteGuardado> {
    return emSequencia(async () => {
      const data = await api.get<PacoteCampo>('/endemias/campo/pacote', { signal: comPrazo(PRAZO_PACOTE_MS) });
      const g: PacoteGuardado = { data, savedAt: new Date().toISOString() };
      await localAce.put('cache', { key: chavePacote(ctx), ...g }).catch((e) => console.warn('Pacote do campo não guardado no aparelho', e));
      return g;
    });
  },
  /**
   * Aplica no pacote guardado o que o servidor aceitou (a tela aplica no que está em memória). Lê e grava numa transação
   * só: o pacote baixado noutra aba nesse meio-tempo não é sobrescrito pelo antigo.
   */
  async aplicar(ctx: ContextoAce, aceitos: AceitoAce[]) {
    if (!aceitos.length) return;
    await localAce.atualizar<PacoteGuardado & { key: string; atualizadoEm?: string }>(
      'cache',
      chavePacote(ctx),
      (e) => e && { ...e, data: aplicarAceitosNoPacote(e.data, aceitos), atualizadoEm: new Date().toISOString() },
    );
  },
};

/**
 * Grava o resultado de um lote: fila, histórico e as visitas que citavam um imóvel novo aceito. Lê a fila e o histórico e
 * grava numa transação só (nada de outra aba entra no meio): o resultado vale sobre o que está na fila nessa hora. O
 * resultado é da versão enviada (porId): o registro corrigido no meio do envio, nesta aba ou noutra, não fica com ele.
 * Com uma versão enviada antes e sem resposta (ItemFilaAce.semResposta), a DUPLICADA de outra versão é dela: o servidor
 * ficou com aquela.
 */
async function gravarResultados(ctx: ContextoAce, resultados: ResultadoSyncAce[], porId: Map<string, ItemFilaAce>, resumo: ResumoSyncAce) {
  const chave = chaveHistorico(ctx.userId);
  const aceitos: AceitoAce[] = [];
  const noPacote: AceitoAce[] = [];
  // Imóvel novo aceito num lote anterior deste envio: a visita lida antes disso (porId, ou a marca dela) ainda o cita pelo
  // clientId, e o pacote guardado, que recebe cada lote à parte, só acha a casa pelo id do servidor.
  const idDosLotesAnteriores = idsDosImoveisNovos(resumo.aceitos);
  await localAce.atualizarVarios({ fila: 'todas', cache: [chave] }, (lidos) => {
    const atuais = new Map(([...lidos.fila.values()] as ItemFilaAce[]).filter((i) => i.userId === ctx.userId).map((i) => [i.clientId, i]));
    const historico = semRepetidos((lidos.cache.get(chave) as { data: EnviadoAce[] } | undefined)?.data ?? []);
    const jaNoHistorico = new Set(historico.map((h) => h.clientId));
    const saida = new Map<string, ItemFilaAce | null>();
    const novos: EnviadoAce[] = [];
    const agora = new Date().toISOString();
    for (const r of resultados) {
      const enviado = porId.get(r.clientId);
      if (!enviado) continue;
      const item = atuais.get(r.clientId);
      const corrigido = item && mudouNoEnvio(item, enviado) ? item : null;
      // O descartado durante o envio (nesta aba ou noutra) não volta com o erro, e o aviso não manda procurá-lo na fila. O
      // corrigido no meio não leva o erro nem o adiamento da versão anterior: continua pendente e vai no próximo envio.
      if (r.status === 'ERRO') {
        if (!item) continue;
        // O servidor confere o clientId antes de recusar (campo.service.ts, sync): nenhuma versão estava gravada, nem a que
        // foi sem resposta até este envio, e a marca sai. A de um envio posterior a este (outra aba) fica.
        const base = item.semResposta && item.semResposta.versao <= versaoDe(enviado) ? semMarca(item) : item;
        if (corrigido) {
          if (base !== item) saida.set(item.clientId, base);
          continue;
        }
        saida.set(item.clientId, { ...base, status: 'ERRO', erro: r.erro || 'Recusado pelo servidor', adiado: null });
        resumo.erros++;
      } else if (r.status === 'TENTAR_DE_NOVO') {
        // Não diz se o servidor gravou (o banco pode ter caído no meio da gravação): a marca do envio sem resposta fica.
        if (!item || corrigido) continue;
        saida.set(item.clientId, { ...item, status: 'PENDENTE', adiado: r.erro || FALHA_PASSAGEIRA });
        resumo.adiados++;
      } else if (r.status === 'OK' || r.status === 'DUPLICADA') {
        // O servidor ficou com a versão anterior, cujo efeito já entrou no histórico e no pacote: reenvio da correção
        // (tentar de novo, nova correção, outra aba) ou, sem a trava entre abas, a resposta da outra aba que levou a mesma
        // versão (OK lá e DUPLICADA aqui, em qualquer ordem). O registro continua com o erro, e nada se aplica de novo.
        if ((item?.versaoGravada ?? enviado.versaoGravada) !== undefined) {
          if (!item) continue;
          saida.set(item.clientId, { ...semMarca(item), status: 'ERRO', erro: VERSAO_ANTERIOR_GRAVADA, adiado: null });
          resumo.erros++;
          continue;
        }
        // A versão que o servidor tem: a enviada (OK, ou DUPLICADA dela). A DUPLICADA de outra versão é da que foi antes
        // sem resposta (o servidor a gravou e a resposta se perdeu): o histórico e o pacote recebem a dela. O OK diz que
        // a que foi sem resposta não chegou a ser gravada.
        const marca = item ? item.semResposta : enviado.semResposta;
        const gravada = r.status === 'DUPLICADA' && marca && marca.versao !== versaoDe(enviado) ? marca : { versao: versaoDe(enviado), op: enviado.op, rotulo: enviado.rotulo };
        // Outra versão na fila (corrigida no meio do envio, ou depois do envio sem resposta) não vai mais: o servidor não
        // grava outra versão do mesmo clientId. Fica na fila com o erro, para o agente conferir e descartar.
        const outra = item && versaoDe(item) !== gravada.versao ? item : null;
        saida.set(r.clientId, outra && { ...semMarca(outra), status: 'ERRO', erro: VERSAO_ANTERIOR_GRAVADA, adiado: null, versaoGravada: gravada.versao });
        if (outra) resumo.erros++;
        novos.push({ clientId: r.clientId, tipo: r.tipo, rotulo: gravada.rotulo, id: r.id, em: agora, ...(r.avisos?.length ? { avisos: r.avisos } : {}) });
        // A visita vai para o pacote na ordem em que o servidor a gravou; sem o campo (servidor de antes), na informada.
        const aceito: AceitoAce = { op: comImovelDoServidor(gravada.op, idDosLotesAnteriores) ?? gravada.op, id: r.id, ...(r.ordemId !== undefined ? { ordemId: r.ordemId } : {}) };
        aceitos.push(aceito);
        // O pacote guardado não recebe de novo o que outra aba já tirou da fila e pôs no histórico (OK lá, DUPLICADA
        // aqui): ela aplicou o efeito. O descartado durante o envio não está no histórico e recebe (o servidor gravou).
        if (item || !jaNoHistorico.has(r.clientId)) noPacote.push(aceito);
        if (r.status === 'OK') resumo.enviados++;
        else resumo.duplicados++;
        resumo.avisos += r.avisos?.length ?? 0;
      }
    }
    // Imóvel novo aceito: as visitas que o citam pelo clientId passam a citar o id do servidor, e as recusadas antes por
    // falta dele voltam a pendente. A recusada neste mesmo envio fica com o erro: o imóvel já estava antes dela no lote.
    // Regravar não é corrigir nem enviar: a versão não muda, o resultado da visita em envio continua valendo para ela, e
    // a marca do envio sem resposta fica, também citando o id (se o servidor ficou com ela, o pacote marca a casa).
    const idDoImovel = idsDosImoveisNovos(aceitos);
    const nesteEnvio = new Set(resultados.map((r) => r.clientId));
    if (idDoImovel.size) {
      for (const i of atuais.values()) {
        const base = saida.has(i.clientId) ? saida.get(i.clientId) : i;
        if (!base) continue;
        const op = comImovelDoServidor(base.op, idDoImovel);
        const opSemResposta = base.semResposta ? comImovelDoServidor(base.semResposta.op, idDoImovel) : null;
        if (!op && !opSemResposta) continue;
        const voltaAPendente = !!op && base.status === 'ERRO' && !nesteEnvio.has(i.clientId);
        saida.set(i.clientId, {
          ...base,
          ...(op ? { op } : {}),
          ...(base.semResposta && opSemResposta ? { semResposta: { ...base.semResposta, op: opSemResposta } } : {}),
          ...(voltaAPendente ? { status: 'PENDENTE' as const, erro: null } : {}),
        });
      }
    }
    const gravacoes: Gravacao[] = [...saida].map(([clientId, item]) => (item ? { store: 'fila', put: item } : { store: 'fila', delete: clientId }));
    if (novos.length) gravacoes.push({ store: 'cache', put: { key: chave, data: semRepetidos([...novos.reverse(), ...historico]).slice(0, 300), savedAt: agora } });
    return gravacoes;
  });
  // A tela aplica todos os aceitos no pacote que tem em memória (lido antes deste envio, sem o efeito deles).
  resumo.aceitos.push(...aceitos);
  if (noPacote.length) await pacoteAce.aplicar(ctx, noPacote).catch((e) => console.warn('Pacote do aparelho não atualizado', e));
}

async function enviar(ctx: ContextoAce, comTrava: boolean): Promise<ResumoSyncAce> {
  const resumo: ResumoSyncAce = { enviados: 0, duplicados: 0, erros: 0, adiados: 0, avisos: 0, pendentes: 0, restantes: 0, falha: null, mensagem: null, aceitos: [] };
  const daVez = (itens: ItemFilaAce[]) => itens.filter((i) => i.status === 'PENDENTE' && daLotacao(i, ctx.unitId));
  try {
    resumo.pendentes = daVez(await itensDoUsuario(ctx.userId)).length;
    if (!estaOnline()) {
      resumo.falha = 'rede';
      resumo.restantes = resumo.pendentes;
      return resumo;
    }
    // Cada item vai uma vez por chamada; uma nova rodada leva os que voltaram a pendente no meio (visitas de um imóvel novo
    // aceito, operações não apontadas num lote recusado).
    const tentados = new Set<string>();
    rodadas: for (let rodada = 0; rodada < 3; rodada++) {
      const pendentes = daVez(await itensDoUsuario(ctx.userId)).filter((i) => !tentados.has(i.clientId));
      if (!pendentes.length) break;
      const porId = new Map(pendentes.map((i) => [i.clientId, i]));
      const ops = ordenarOperacoesAce(pendentes.map((i) => i.op));
      for (let k = 0; k < ops.length; k += 100) {
        const lote = ops.slice(k, k + 100);
        for (const op of lote) tentados.add(op.clientId);
        // Antes do POST, cada registro do lote guarda a versão que vai, se ainda não guarda uma: sem a resposta, o envio
        // seguinte (nesta aba ou noutra) sabe qual versão o servidor pode ter gravado. Lê e grava numa transação só; se o
        // aparelho não grava, o POST não sai (falha do aparelho).
        const marcasPostas = await localAce.atualizarVarios({ fila: lote.map((op) => op.clientId) }, (lidos) =>
          lote.flatMap((op): Gravacao[] => {
            const item = lidos.fila.get(op.clientId) as ItemFilaAce | undefined;
            const enviado = porId.get(op.clientId);
            if (!item || !enviado || item.semResposta) return [];
            return [{ store: 'fila', put: { ...item, semResposta: { versao: versaoDe(enviado), op, rotulo: enviado.rotulo } } satisfies ItemFilaAce }];
          }),
        );
        /** As marcas que este POST pôs (clientId → marca): as de um envio anterior sem resposta não estão aqui. */
        const marcadas = new Map(marcasPostas.flatMap((g) => ((g.put as ItemFilaAce | undefined)?.semResposta ? [[(g.put as ItemFilaAce).clientId, (g.put as ItemFilaAce).semResposta!] as const] : [])));
        let resultados: ResultadoSyncAce[];
        try {
          resultados = (await api.post<{ resultados?: ResultadoSyncAce[] }>('/endemias/campo/sync', { operacoes: lote }, { signal: comPrazo(PRAZO_ENVIO_MS) })).resultados ?? [];
        } catch (err) {
          const motivo = classificarFalha(err);
          // Lote recusado inteiro antes de o servidor processá-lo (400 ou 422 do lote, sessão, permissão, limite de
          // requisições): nada deste POST foi gravado, e a marca que ele pôs sai. A de um envio anterior sem resposta fica
          // (o servidor pode tê-la gravado). Sem resposta (rede, prazo) ou com o servidor fora (5xx, que pode vir depois de
          // gravar), a marca fica. Sem a trava entre abas também fica: outra aba pode ter mandado a mesma versão ao mesmo
          // tempo contando com esta marca (ela não marca de novo), e o POST dela pode ter sido gravado sem resposta.
          const tiraAMarca = comTrava && (motivo === 'conteudo' || motivo === 'sessao' || motivo === 'permissao' || motivo === 'limite');
          const semAMarcaDoPost = (item: ItemFilaAce) => (tiraAMarca && mesmaMarca(item.semResposta, marcadas.get(item.clientId)) ? semMarca(item) : item);
          if (motivo !== 'conteudo') {
            if (tiraAMarca && marcadas.size)
              await localAce
                .atualizarVarios({ fila: [...marcadas.keys()] }, (lidos) =>
                  [...lidos.fila.values()].flatMap((lido): Gravacao[] => {
                    const item = semAMarcaDoPost(lido as ItemFilaAce);
                    return item !== lido ? [{ store: 'fila', put: item }] : [];
                  }),
                )
                // Se o aparelho não apaga a marca, vale a regra de quando não há resposta: a DUPLICADA de outra versão é
                // tomada como da versão marcada.
                .catch((e) => console.warn('Marca do envio recusado não apagada', e));
            resumo.falha = motivo;
            resumo.mensagem = errorMessage(err);
            break rodadas;
          }
          // Lote recusado inteiro pelo conteúdo: cada operação apontada leva a mensagem dela, e as outras vão de novo na
          // próxima rodada; sem apontar, todas levam a mensagem real do servidor. Lê e grava numa transação só: o item
          // descartado durante o envio (nesta aba ou noutra) não volta com o erro, e o corrigido no meio não leva a recusa
          // da versão anterior (continua pendente e vai no próximo envio).
          const porOp = errosPorOperacao(err instanceof ApiError ? err.details : null, lote);
          await localAce.atualizarVarios({ fila: lote.map((op) => op.clientId) }, (lidos) => {
            const gravacoes: Gravacao[] = [];
            for (const op of lote) {
              const lido = lidos.fila.get(op.clientId) as ItemFilaAce | undefined;
              const msg = porOp ? porOp.get(op.clientId) : errorMessage(err);
              if (!lido) continue;
              const item = semAMarcaDoPost(lido);
              if (msg && !mudouNoEnvio(item, porId.get(op.clientId))) {
                gravacoes.push({ store: 'fila', put: { ...item, status: 'ERRO', erro: msg, adiado: null } satisfies ItemFilaAce });
                resumo.erros++;
              } else if (item !== lido) gravacoes.push({ store: 'fila', put: item });
              if (!msg) tentados.delete(op.clientId);
            }
            return gravacoes;
          });
          continue;
        }
        await gravarResultados(ctx, resultados, porId, resumo);
      }
    }
    resumo.restantes = daVez(await itensDoUsuario(ctx.userId)).length;
  } catch (e) {
    // Banco do aparelho: o que o servidor aceitou e não saiu da fila volta como DUPLICADA no próximo envio.
    resumo.falha = 'aparelho';
    resumo.mensagem = e instanceof Error ? e.message : String(e);
    resumo.restantes = Math.max(0, resumo.pendentes - resumo.enviados - resumo.duplicados - resumo.erros);
  } finally {
    avisar();
  }
  return resumo;
}

let emCurso: Promise<ResumoSyncAce> | null = null;
let proxima: { ctx: ContextoAce; promessa: Promise<ResumoSyncAce> } | null = null;

/**
 * Envia o que está pendente deste usuário nesta lotação, em lotes de 100. Chamada durante outra espera ela terminar e
 * roda de novo (o que foi registrado no meio vai junto); várias chamadas no meio viram uma só rodada.
 */
function sincronizar(ctx: ContextoAce): Promise<ResumoSyncAce> {
  if (!emCurso) {
    const atual: Promise<ResumoSyncAce> = emSequencia((comTrava) => enviar(ctx, comTrava)).finally(() => {
      if (emCurso === atual) emCurso = null;
    });
    emCurso = atual;
    return atual;
  }
  if (proxima) {
    proxima.ctx = ctx;
    return proxima.promessa;
  }
  const p: { ctx: ContextoAce; promessa: Promise<ResumoSyncAce> } = { ctx, promessa: Promise.resolve() as unknown as Promise<ResumoSyncAce> };
  p.promessa = emCurso
    .catch(() => undefined)
    .then(() => {
      proxima = null;
      return sincronizar(p.ctx);
    });
  proxima = p;
  return p.promessa;
}

export const filaAce = {
  listar: itensDoUsuario,
  /** Guarda o registro com a lotação ativa (e, na mesma transação, a posição dos tubitos). A falha sobe para a tela. */
  async adicionar(op: OperacaoAce, ctx: ContextoAce, rotulo: string, extras?: { ultimoTubito?: number | null }): Promise<ItemFilaAce> {
    const unitId = ctx.unitId ?? null;
    const item: ItemFilaAce = { clientId: op.clientId, op: { ...op, unitId }, userId: ctx.userId, unitId, status: 'PENDENTE', erro: null, criadoEm: new Date().toISOString(), rotulo };
    await localAce.gravar([{ store: 'fila', put: item }, ...gravacaoDoTubito(ctx.userId, extras?.ultimoTubito)]);
    avisar();
    return item;
  },
  /**
   * Regrava o registro corrigido com o mesmo clientId (o servidor continua reconhecendo o reenvio), na versão seguinte, e
   * volta a pendente: o resultado do envio da versão anterior, se estiver em curso, não vale para a correção, e a marca
   * da versão enviada sem resposta fica. Lê e grava numa transação só, com a posição dos tubitos: o descartado noutra aba
   * nesse meio-tempo não volta.
   */
  async corrigir(clientId: string, op: OperacaoAce, rotulo: string, extras?: { ultimoTubito?: number | null }) {
    const feitas = await localAce.atualizarVarios({ fila: [clientId] }, (lidos) => {
      const atual = lidos.fila.get(clientId) as ItemFilaAce | undefined;
      if (!atual) return [];
      const unitId = atual.unitId ?? null;
      const item: ItemFilaAce = { ...atual, op: { ...op, clientId, unitId }, rotulo, status: 'PENDENTE', erro: null, adiado: null, avisos: undefined, versao: versaoDe(atual) + 1 };
      return [{ store: 'fila', put: item }, ...gravacaoDoTubito(atual.userId, extras?.ultimoTubito)];
    });
    if (!feitas.length) throw new ErroAparelho('O registro não está mais na fila do aparelho: já foi enviado ou descartado');
    avisar();
  },
  async remover(clientIds: string | string[]) {
    await localAce.gravar((Array.isArray(clientIds) ? clientIds : [clientIds]).map((clientId) => ({ store: 'fila' as const, delete: clientId })));
    avisar();
  },
  async tentarDeNovo(clientId: string) {
    // Lê e grava numa transação só: o descartado noutra aba nesse meio-tempo não volta como pendente. Não é correção nem
    // resposta: a versão e a marca do envio sem resposta não mudam, e o resultado do envio em curso vale para o registro.
    await localAce.atualizar<ItemFilaAce>('fila', clientId, (item) => item && { ...item, status: 'PENDENTE', erro: null, adiado: null });
    avisar();
  },
  sincronizar,
};

/** Fila reativa do usuário, separada pela lotação ativa, atualizada a cada mudança. */
export function useFilaAce(userId: string | null | undefined, unitId: string | null | undefined) {
  const [estado, setEstado] = useState<{ itens: ItemFilaAce[]; deOutros: number; erro: string | null }>({ itens: [], deOutros: 0, erro: null });
  const carregar = useCallback(async () => {
    if (!userId) return;
    try {
      const todos = await localAce.all<ItemFilaAce>('fila');
      setEstado({
        itens: todos.filter((i) => i.userId === userId).sort((a, b) => a.criadoEm.localeCompare(b.criadoEm)),
        deOutros: todos.filter((i) => i.userId !== userId).length,
        erro: null,
      });
    } catch (e) {
      setEstado((s) => ({ ...s, erro: e instanceof Error ? e.message : String(e) }));
    }
  }, [userId]);
  useEffect(() => {
    void carregar();
    ouvintes.add(carregar);
    return () => {
      ouvintes.delete(carregar);
    };
  }, [carregar]);
  return useMemo(() => {
    const doContexto = estado.itens.filter((i) => daLotacao(i, unitId ?? null));
    return {
      itens: estado.itens,
      /** Desta lotação (e os de antes da regra): são os enviados com a sessão ativa. */
      daLotacao: doContexto,
      /** Registrados em outra lotação: esperam a troca de lotação. */
      deOutraLotacao: estado.itens.filter((i) => !daLotacao(i, unitId ?? null)),
      pendentes: doContexto.filter((i) => i.status === 'PENDENTE').length,
      erros: doContexto.filter((i) => i.status === 'ERRO').length,
      deOutros: estado.deOutros,
      /** Falha ao ler o banco do aparelho (a fila mostrada pode estar desatualizada). */
      erroAparelho: estado.erro,
      recarregar: carregar,
    };
  }, [estado, unitId, carregar]);
}
