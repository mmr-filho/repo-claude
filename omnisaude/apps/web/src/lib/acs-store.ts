'use client';

import { ordenarOperacoes, type OperacaoCampo, type ResultadoSync } from '@omnisaude/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { estaOnline, local } from './offline';

/**
 * Fila de campo do ACS: tudo o que o agente registra entra aqui (IndexedDB) e é enviado a /acs/sync quando
 * há conexão. A resposta diz, operação a operação, o que foi aceito (OK ou DUPLICADA) e o que deu erro; os
 * erros ficam na fila com a mensagem até o agente corrigir ou descartar.
 */
export interface ItemFila {
  clientId: string;
  op: OperacaoCampo;
  status: 'PENDENTE' | 'ERRO';
  erro: string | null;
  criadoEm: string;
  /** Texto curto para a lista (quem/onde). */
  rotulo: string;
}

export interface Enviado {
  clientId: string;
  tipo: OperacaoCampo['tipo'];
  rotulo: string;
  id: string | null;
  em: string;
}

interface CacheEntry<T> {
  key: string;
  data: T;
  savedAt: string;
}

const ouvintes = new Set<() => void>();
const avisar = () => ouvintes.forEach((f) => f());

export const filaCampo = {
  async listar(): Promise<ItemFila[]> {
    const itens = await local.all<ItemFila>('fila');
    return itens.sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  },
  async adicionar(op: OperacaoCampo, rotulo: string) {
    const item: ItemFila = { clientId: op.clientId, op, status: 'PENDENTE', erro: null, criadoEm: new Date().toISOString(), rotulo };
    await local.put('fila', item);
    avisar();
    return item;
  },
  async remover(clientId: string) {
    await local.delete('fila', clientId);
    avisar();
  },
  async tentarDeNovo(clientId: string) {
    const item = await local.get<ItemFila>('fila', clientId);
    if (item) await local.put('fila', { ...item, status: 'PENDENTE', erro: null });
    avisar();
  },
  /** Envia o que está pendente; devolve o resumo. Fora da rede, não faz nada. */
  async sincronizar(): Promise<{ enviados: number; duplicados: number; erros: number; offline: boolean }> {
    if (!estaOnline()) return { enviados: 0, duplicados: 0, erros: 0, offline: true };
    const pendentes = (await this.listar()).filter((i) => i.status === 'PENDENTE');
    const resumo = { enviados: 0, duplicados: 0, erros: 0, offline: false };
    if (!pendentes.length) return resumo;
    const ops = ordenarOperacoes(pendentes.map((i) => i.op));
    for (let i = 0; i < ops.length; i += 100) {
      const lote = ops.slice(i, i + 100);
      let resultados: ResultadoSync[];
      try {
        resultados = (await api.post<{ resultados: ResultadoSync[] }>('/acs/sync', { operacoes: lote })).resultados;
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) return { ...resumo, offline: true };
        // Lote recusado inteiro (validação): marca cada item com a mensagem.
        for (const op of lote) {
          const item = pendentes.find((p) => p.clientId === op.clientId);
          if (item) await local.put('fila', { ...item, status: 'ERRO', erro: err instanceof Error ? err.message : String(err) });
        }
        resumo.erros += lote.length;
        continue;
      }
      const historico = await historicoEnvios.listar();
      for (const r of resultados) {
        const item = pendentes.find((p) => p.clientId === r.clientId);
        if (!item) continue;
        if (r.status === 'ERRO') {
          await local.put('fila', { ...item, status: 'ERRO', erro: r.erro });
          resumo.erros++;
          continue;
        }
        await local.delete('fila', r.clientId);
        historico.unshift({ clientId: r.clientId, tipo: r.tipo, rotulo: item.rotulo, id: r.id, em: new Date().toISOString() });
        if (r.status === 'OK') resumo.enviados++;
        else resumo.duplicados++;
      }
      await historicoEnvios.salvar(historico.slice(0, 200));
    }
    avisar();
    return resumo;
  },
};

export const historicoEnvios = {
  listar: async () => (await local.get<CacheEntry<Enviado[]>>('cache', 'historico'))?.data ?? [],
  salvar: (data: Enviado[]) => local.put('cache', { key: 'historico', data, savedAt: new Date().toISOString() } satisfies CacheEntry<Enviado[]>),
};

/** Busca na API e guarda no cache; sem rede, devolve a cópia guardada (com a data). */
export async function comCache<T>(key: string, path: string): Promise<{ data: T; deCache: boolean; savedAt: string | null }> {
  try {
    const data = await api.get<T>(path);
    await local.put('cache', { key, data, savedAt: new Date().toISOString() } satisfies CacheEntry<T>);
    return { data, deCache: false, savedAt: new Date().toISOString() };
  } catch (err) {
    const guardado = await local.get<CacheEntry<T>>('cache', key);
    if (guardado) return { data: guardado.data, deCache: true, savedAt: guardado.savedAt };
    throw err;
  }
}

/** Fila reativa: a lista e o total de pendências, atualizados a cada mudança. */
export function useFila() {
  const [itens, setItens] = useState<ItemFila[]>([]);
  const carregar = useCallback(async () => setItens(await filaCampo.listar()), []);
  useEffect(() => {
    void carregar();
    ouvintes.add(carregar);
    return () => {
      ouvintes.delete(carregar);
    };
  }, [carregar]);
  return { itens, pendentes: itens.filter((i) => i.status === 'PENDENTE').length, erros: itens.filter((i) => i.status === 'ERRO').length, recarregar: carregar };
}
