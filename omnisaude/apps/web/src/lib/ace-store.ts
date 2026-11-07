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
 * falha passageira (TENTAR_DE_NOVO) deixam o item pendente; só a recusa da operação vira erro, com a mensagem.
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

const ouvintes = new Set<() => void>();
const avisar = () => ouvintes.forEach((f) => f());
const chaveHistorico = (userId: string) => `historico-ace:${userId}`;
const chaveTubito = (userId: string) => `tubito:${userId}`;
const chavePacote = (ctx: ContextoAce) => `pacote:ace:${ctx.unitId ?? ''}:${ctx.userId}`;

/**
 * Envio e download do pacote, um por vez: o pacote baixado durante um envio não traria o efeito dele, e o efeito
 * aplicado depois contaria duas vezes o larvicida.
 */
let ultimo: Promise<unknown> = Promise.resolve();
function emSequencia<T>(fn: () => Promise<T>): Promise<T> {
  const r = ultimo.then(fn, fn);
  ultimo = r.catch(() => undefined);
  return r;
}

async function itensDoUsuario(userId: string): Promise<ItemFilaAce[]> {
  return (await localAce.all<ItemFilaAce>('fila')).filter((i) => i.userId === userId).sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
}

/** Contador de tubitos gravado junto com o registro (na mesma transação): só avança se a visita foi guardada. */
function gravacaoDoTubito(userId: string, ultimoTubito: number | null | undefined): Gravacao[] {
  return ultimoTubito != null ? [{ store: 'cache', put: { key: chaveTubito(userId), data: ultimoTubito, savedAt: new Date().toISOString() } }] : [];
}

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
  /** Aplica no pacote guardado o que o servidor aceitou (a tela aplica no que está em memória). */
  async aplicar(ctx: ContextoAce, aceitos: AceitoAce[]) {
    if (!aceitos.length) return;
    const e = await localAce.get<{ key: string; data: PacoteCampo; savedAt: string }>('cache', chavePacote(ctx));
    if (e) await localAce.put('cache', { ...e, data: aplicarAceitosNoPacote(e.data, aceitos), atualizadoEm: new Date().toISOString() });
  },
};

/** Grava o resultado de um lote: fila, histórico e as visitas que citavam um imóvel novo aceito, numa transação só. */
async function gravarResultados(ctx: ContextoAce, resultados: ResultadoSyncAce[], porId: Map<string, ItemFilaAce>, resumo: ResumoSyncAce) {
  // O resultado vale sobre o que está na fila agora: o item descartado durante o envio não volta.
  const atuais = new Map((await itensDoUsuario(ctx.userId)).map((i) => [i.clientId, i]));
  const saida = new Map<string, ItemFilaAce | null>();
  const novos: EnviadoAce[] = [];
  const aceitos: AceitoAce[] = [];
  const agora = new Date().toISOString();
  for (const r of resultados) {
    const enviado = porId.get(r.clientId);
    if (!enviado) continue;
    const item = atuais.get(r.clientId);
    if (r.status === 'ERRO') {
      if (item) saida.set(item.clientId, { ...item, status: 'ERRO', erro: r.erro || 'Recusado pelo servidor', adiado: null });
      resumo.erros++;
    } else if (r.status === 'TENTAR_DE_NOVO') {
      if (item) saida.set(item.clientId, { ...item, status: 'PENDENTE', adiado: r.erro || FALHA_PASSAGEIRA });
      resumo.adiados++;
    } else if (r.status === 'OK' || r.status === 'DUPLICADA') {
      saida.set(enviado.clientId, null);
      novos.push({ clientId: r.clientId, tipo: r.tipo, rotulo: enviado.rotulo, id: r.id, em: agora, ...(r.avisos?.length ? { avisos: r.avisos } : {}) });
      aceitos.push({ op: enviado.op, id: r.id });
      if (r.status === 'OK') resumo.enviados++;
      else resumo.duplicados++;
      resumo.avisos += r.avisos?.length ?? 0;
    }
  }
  // Imóvel novo aceito: as visitas que o citam pelo clientId passam a citar o id do servidor, e as recusadas antes por
  // falta dele voltam a pendente. A recusada neste mesmo envio fica com o erro: o imóvel já estava antes dela no lote.
  const idDoImovel = new Map(aceitos.flatMap((a) => (a.op.tipo === 'IMOVEL' && a.id ? [[a.op.clientId, a.id] as const] : [])));
  const nesteEnvio = new Set(resultados.map((r) => r.clientId));
  if (idDoImovel.size) {
    for (const i of atuais.values()) {
      const base = saida.has(i.clientId) ? saida.get(i.clientId) : i;
      if (!base || base.op.tipo !== 'VISITA_VETORIAL' || !base.op.householdClientId) continue;
      const id = idDoImovel.get(base.op.householdClientId);
      if (!id) continue;
      const voltaAPendente = base.status === 'ERRO' && !nesteEnvio.has(i.clientId);
      saida.set(i.clientId, { ...base, op: { ...base.op, householdId: id, householdClientId: null }, ...(voltaAPendente ? { status: 'PENDENTE' as const, erro: null } : {}) });
    }
  }
  const gravacoes: Gravacao[] = [...saida].map(([clientId, item]) => (item ? { store: 'fila', put: item } : { store: 'fila', delete: clientId }));
  if (novos.length) {
    const historico = semRepetidos([...novos.reverse(), ...(await historicoAce.listar(ctx.userId))]).slice(0, 300);
    gravacoes.push({ store: 'cache', put: { key: chaveHistorico(ctx.userId), data: historico, savedAt: agora } });
  }
  await localAce.gravar(gravacoes);
  if (aceitos.length) {
    resumo.aceitos.push(...aceitos);
    await pacoteAce.aplicar(ctx, aceitos).catch((e) => console.warn('Pacote do aparelho não atualizado', e));
  }
}

async function enviar(ctx: ContextoAce): Promise<ResumoSyncAce> {
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
        let resultados: ResultadoSyncAce[];
        try {
          resultados = (await api.post<{ resultados?: ResultadoSyncAce[] }>('/endemias/campo/sync', { operacoes: lote }, { signal: comPrazo(PRAZO_ENVIO_MS) })).resultados ?? [];
        } catch (err) {
          const motivo = classificarFalha(err);
          if (motivo !== 'conteudo') {
            resumo.falha = motivo;
            resumo.mensagem = errorMessage(err);
            break rodadas;
          }
          // Lote recusado inteiro pelo conteúdo: cada operação apontada leva a mensagem dela, e as outras vão de novo na
          // próxima rodada; sem apontar, todas levam a mensagem real do servidor.
          const porOp = errosPorOperacao(err instanceof ApiError ? err.details : null, lote);
          const atuais = new Map((await itensDoUsuario(ctx.userId)).map((i) => [i.clientId, i]));
          const gravacoes: Gravacao[] = [];
          for (const op of lote) {
            const item = atuais.get(op.clientId);
            const msg = porOp ? porOp.get(op.clientId) : errorMessage(err);
            if (!item) continue;
            if (msg) {
              gravacoes.push({ store: 'fila', put: { ...item, status: 'ERRO', erro: msg, adiado: null } satisfies ItemFilaAce });
              resumo.erros++;
            } else tentados.delete(op.clientId);
          }
          await localAce.gravar(gravacoes);
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
    const atual: Promise<ResumoSyncAce> = emSequencia(() => enviar(ctx)).finally(() => {
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
  /** Regrava o registro corrigido com o mesmo clientId (o servidor continua reconhecendo o reenvio) e volta a pendente. */
  async corrigir(clientId: string, op: OperacaoAce, rotulo: string, extras?: { ultimoTubito?: number | null }) {
    const atual = await localAce.get<ItemFilaAce>('fila', clientId);
    if (!atual) throw new ErroAparelho('O registro não está mais na fila do aparelho: já foi enviado ou descartado');
    const unitId = atual.unitId ?? null;
    const item: ItemFilaAce = { ...atual, op: { ...op, clientId, unitId }, rotulo, status: 'PENDENTE', erro: null, adiado: null, avisos: undefined };
    await localAce.gravar([{ store: 'fila', put: item }, ...gravacaoDoTubito(atual.userId, extras?.ultimoTubito)]);
    avisar();
  },
  async remover(clientIds: string | string[]) {
    await localAce.gravar((Array.isArray(clientIds) ? clientIds : [clientIds]).map((clientId) => ({ store: 'fila' as const, delete: clientId })));
    avisar();
  },
  async tentarDeNovo(clientId: string) {
    const item = await localAce.get<ItemFilaAce>('fila', clientId);
    if (item) await localAce.put('fila', { ...item, status: 'PENDENTE', erro: null, adiado: null } satisfies ItemFilaAce);
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
