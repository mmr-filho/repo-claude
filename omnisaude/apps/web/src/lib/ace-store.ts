'use client';

import { ordenarOperacoesAce, type OperacaoAce, type ResultadoSyncAce } from '@omnisaude/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { estaOnline, local } from './offline';

/**
 * Fila de campo do agente de combate às endemias: o que o ACE registra (visitas e imóveis novos) fica no aparelho
 * (IndexedDB) e vai para /endemias/campo/sync quando há conexão. Cada item guarda quem registrou: outro usuário que
 * entrar no mesmo aparelho não envia o trabalho alheio. Queda de rede, sessão vencida e erro do servidor deixam o item
 * pendente (nova tentativa depois); só a recusa da operação (validação) vira erro, com a mensagem.
 */
export interface ItemFilaAce {
  clientId: string;
  op: OperacaoAce;
  userId: string;
  status: 'PENDENTE' | 'ERRO';
  erro: string | null;
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

const ouvintes = new Set<() => void>();
const avisar = () => ouvintes.forEach((f) => f());
const chaveHistorico = (userId: string) => `historico-ace:${userId}`;
/** Falhas que não dizem nada da operação: rede, sessão, limite de requisições e servidor. */
const transitorio = (err: unknown) => err instanceof ApiError && (err.status === 0 || err.status === 401 || err.status === 408 || err.status === 429 || err.status >= 500);

export const filaAce = {
  async listar(userId?: string): Promise<ItemFilaAce[]> {
    const itens = await local.all<ItemFilaAce>('filaAce');
    return itens.filter((i) => !userId || i.userId === userId).sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  },
  /** Itens deixados no aparelho por outro usuário (não são enviados com esta sessão). */
  async deOutros(userId: string): Promise<number> {
    return (await local.all<ItemFilaAce>('filaAce')).filter((i) => i.userId !== userId).length;
  },
  async adicionar(op: OperacaoAce, userId: string, rotulo: string) {
    const item: ItemFilaAce = { clientId: op.clientId, op, userId, status: 'PENDENTE', erro: null, criadoEm: new Date().toISOString(), rotulo };
    await local.put('filaAce', item);
    avisar();
    return item;
  },
  async remover(clientId: string) {
    await local.delete('filaAce', clientId);
    avisar();
  },
  async tentarDeNovo(clientId: string) {
    const item = await local.get<ItemFilaAce>('filaAce', clientId);
    if (item) await local.put('filaAce', { ...item, status: 'PENDENTE', erro: null });
    avisar();
  },
  /** Envia o que está pendente deste usuário, em lotes de 100; devolve o resumo (avisos da supervisão incluídos). */
  async sincronizar(userId: string): Promise<{ enviados: number; duplicados: number; erros: number; avisos: number; offline: boolean }> {
    const resumo = { enviados: 0, duplicados: 0, erros: 0, avisos: 0, offline: false };
    if (!estaOnline()) return { ...resumo, offline: true };
    const pendentes = (await this.listar(userId)).filter((i) => i.status === 'PENDENTE');
    if (!pendentes.length) return resumo;
    const ops = ordenarOperacoesAce(pendentes.map((i) => i.op));
    for (let i = 0; i < ops.length; i += 100) {
      const lote = ops.slice(i, i + 100);
      let resultados: ResultadoSyncAce[];
      try {
        resultados = (await api.post<{ resultados: ResultadoSyncAce[] }>('/endemias/campo/sync', { operacoes: lote })).resultados;
      } catch (err) {
        if (transitorio(err)) {
          avisar();
          return { ...resumo, offline: err instanceof ApiError && err.status === 0 };
        }
        for (const op of lote) {
          const item = pendentes.find((p) => p.clientId === op.clientId);
          if (item) await local.put('filaAce', { ...item, status: 'ERRO', erro: err instanceof Error ? err.message : String(err) });
        }
        resumo.erros += lote.length;
        continue;
      }
      const historico = await historicoAce.listar(userId);
      for (const r of resultados) {
        const item = pendentes.find((p) => p.clientId === r.clientId);
        if (!item) continue;
        if (r.status === 'ERRO') {
          await local.put('filaAce', { ...item, status: 'ERRO', erro: r.erro });
          resumo.erros++;
          continue;
        }
        await local.delete('filaAce', r.clientId);
        historico.unshift({ clientId: r.clientId, tipo: r.tipo, rotulo: item.rotulo, id: r.id, em: new Date().toISOString(), avisos: r.avisos });
        if (r.status === 'OK') resumo.enviados++;
        else resumo.duplicados++;
        resumo.avisos += r.avisos?.length ?? 0;
      }
      await historicoAce.salvar(userId, historico.slice(0, 300));
    }
    avisar();
    return resumo;
  },
};

export const historicoAce = {
  listar: async (userId: string) => (await local.get<{ key: string; data: EnviadoAce[] }>('cache', chaveHistorico(userId)))?.data ?? [],
  salvar: (userId: string, data: EnviadoAce[]) => local.put('cache', { key: chaveHistorico(userId), data, savedAt: new Date().toISOString() }),
};

/** Fila reativa do usuário: itens, pendentes e erros, atualizados a cada mudança. */
export function useFilaAce(userId: string | null | undefined) {
  const [itens, setItens] = useState<ItemFilaAce[]>([]);
  const [deOutros, setDeOutros] = useState(0);
  const carregar = useCallback(async () => {
    if (!userId) return;
    setItens(await filaAce.listar(userId));
    setDeOutros(await filaAce.deOutros(userId));
  }, [userId]);
  useEffect(() => {
    void carregar();
    ouvintes.add(carregar);
    return () => {
      ouvintes.delete(carregar);
    };
  }, [carregar]);
  return { itens, pendentes: itens.filter((i) => i.status === 'PENDENTE').length, erros: itens.filter((i) => i.status === 'ERRO').length, deOutros, recarregar: carregar };
}
