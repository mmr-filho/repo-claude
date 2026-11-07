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

/** Resumo de um envio da fila. */
export interface ResumoEnvioAcs {
  enviados: number;
  duplicados: number;
  erros: number;
  /** Sem conexão com o servidor: o que faltava continua na fila. */
  offline: boolean;
  /**
   * O banco do aparelho falhou no meio do envio (ex.: ao tirar da fila o que o servidor aceitou). Nada se perde: o que
   * ficou na fila vai no próximo envio, e o servidor reconhece o que já recebeu (DUPLICADA).
   */
  falha: string | null;
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

/**
 * Registro em gravação (registrarNaFila): o envio que começa no meio espera ele entrar inteiro ou sair da fila antes de
 * ler, para não levar só parte dele (ex.: o responsável sem o domicílio novo). Nunca rejeita.
 */
let gravacaoEmCurso: Promise<unknown> = Promise.resolve();

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
  /**
   * Envia o que está pendente e devolve o resumo; fora da rede, não faz nada. Não lança: a falha do banco do aparelho no
   * meio do envio vem em `falha`, e a lista da fila é avisada de qualquer jeito.
   */
  async sincronizar(): Promise<ResumoEnvioAcs> {
    const resumo: ResumoEnvioAcs = { enviados: 0, duplicados: 0, erros: 0, offline: false, falha: null };
    if (!estaOnline()) return { ...resumo, offline: true };
    try {
      await gravacaoEmCurso;
      const pendentes = (await this.listar()).filter((i) => i.status === 'PENDENTE');
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
        try {
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
        } finally {
          await historicoEnvios.salvar(historico.slice(0, 200));
        }
      }
    } catch (e) {
      // O servidor pode já ter gravado o que não saiu da fila: no próximo envio ele responde DUPLICADA e nada se repete.
      resumo.falha = e instanceof Error ? e.message : String(e);
    } finally {
      avisar();
    }
    return resumo;
  },
};

/**
 * Registro feito num formulário: grava as operações na fila (todas ou nenhuma) e dispara o envio sem esperar por ele. A
 * falha ao gravar volta para o formulário (nada ficou guardado, e salvar de novo não duplica). A do envio não volta: o
 * registro já está na fila, e o formulário aberto com o erro levaria o agente a salvar de novo, com outro clientId (o
 * registro em dobro). Quem envia avisa o resultado (toast).
 */
export async function registrarNaFila(ops: OperacaoCampo[], rotulo: string, enviar: () => Promise<unknown>): Promise<void> {
  const gravacao = gravarInteiro(ops, rotulo);
  const anterior = gravacaoEmCurso;
  gravacaoEmCurso = anterior.then(() => gravacao.catch(() => undefined));
  await gravacao;
  // Sem esperar: o formulário fecha já, e nada do envio (nem uma falha imediata) volta para ele.
  void Promise.resolve()
    .then(enviar)
    .catch((e) => console.warn('Envio em segundo plano não concluído', e));
}

/** Todas as operações na fila, ou nenhuma: se uma falhar, as que já tinham entrado saem, e a falha sobe. */
async function gravarInteiro(ops: OperacaoCampo[], rotulo: string): Promise<void> {
  const gravados: string[] = [];
  try {
    for (const op of ops) {
      await filaCampo.adicionar(op, rotulo);
      gravados.push(op.clientId);
    }
  } catch (e) {
    for (const clientId of gravados) await local.delete('fila', clientId).catch((err) => console.warn('Registro incompleto não saiu da fila do aparelho', err));
    if (gravados.length) avisar();
    throw e;
  }
}

/** Aviso (toast) depois de um envio. */
export interface AvisoEnvio {
  tipo: 'success' | 'error';
  texto: string;
}

/**
 * O que a tela avisa depois de um envio; null quando não há o que dizer. `silencioso` (envio automático) só fala do que
 * foi enviado ou deu errado; `registrado` (logo depois de guardar um registro) confirma, sem conexão, que ele ficou no
 * aparelho.
 */
export function avisoDoEnvio(r: ResumoEnvioAcs, opcoes: { silencioso?: boolean; registrado?: boolean } = {}): AvisoEnvio | null {
  const { silencioso = false, registrado = false } = opcoes;
  if (r.falha) {
    const inicio = r.enviados ? `${r.enviados} registro(s) enviado(s), mas o envio parou.` : 'O envio parou.';
    return { tipo: 'error', texto: `${inicio} ${r.falha.replace(/\.?$/, '.')} Nada se perde: o que ficou na fila vai no próximo envio, sem duplicar.` };
  }
  if (r.offline) {
    if (registrado) return { tipo: 'success', texto: 'Registrado no aparelho. Será enviado quando houver conexão.' };
    return silencioso ? null : { tipo: 'error', texto: 'Sem conexão: os registros ficam guardados no aparelho e são enviados quando a rede voltar.' };
  }
  if (r.erros) return { tipo: 'error', texto: `${r.enviados} registro(s) enviado(s); ${r.erros} com erro (veja a aba Visitas).` };
  if (r.enviados || (r.duplicados && !silencioso)) return { tipo: 'success', texto: `${r.enviados} registro(s) enviado(s)${r.duplicados ? `, ${r.duplicados} já estavam no servidor` : ''}.` };
  if (silencioso) return null;
  return { tipo: 'success', texto: 'Nada pendente: tudo já está no servidor.' };
}

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
