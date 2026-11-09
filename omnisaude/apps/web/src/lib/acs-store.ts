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

/** A lista da fila se inscreve aqui para recarregar a cada mudança feita nesta aba; devolve o cancelamento. */
export function ouvirFila(fn: () => void): () => void {
  ouvintes.add(fn);
  return () => {
    ouvintes.delete(fn);
  };
}

/**
 * Envio da fila do ACS, um por vez, nesta aba e entre as abas do app (o banco do aparelho é o mesmo): duas abas não mandam
 * a mesma fila ao mesmo tempo, e a segunda lê a fila depois que a primeira tirou dela o que levou. A trava fica com o envio
 * inteiro, com a espera pelo servidor (sem prazo: com sinal fraco, leva minutos). O registro não pega trava nenhuma e
 * nunca espera a rede: ele entra na fila numa transação só do banco (gravarNaFila), e nenhuma leitura, desta aba ou de
 * outra, vê parte dele. Entre abas vale a trava do navegador (Web Locks API, com nome do ACS: a do ACE é outra); sem ela
 * (navegador antigo, página fora de HTTPS) ou com o pedido recusado, a ordem é só desta aba.
 */
const TRAVA_ENVIO = 'omnisaude-campo-acs:envio';
let ultimoEnvio: Promise<unknown> = Promise.resolve();
function emSequencia<T>(fn: () => Promise<T>): Promise<T> {
  const rodar = () => entreAbas(fn);
  const r = ultimoEnvio.then(rodar, rodar);
  // O próximo envio espera este terminar, com sucesso ou com falha.
  ultimoEnvio = r.catch(() => undefined);
  return r;
}

async function entreAbas<T>(fn: () => Promise<T>): Promise<T> {
  const travas = typeof navigator === 'undefined' ? undefined : (navigator as { locks?: LockManager }).locks;
  if (typeof travas?.request !== 'function') return fn();
  let rodou = false;
  try {
    return await travas.request(TRAVA_ENVIO, () => {
      rodou = true;
      return fn();
    });
  } catch (e) {
    if (rodou) throw e;
    // O navegador recusou a trava (ex.: documento sem permissão): segue só com a ordem desta aba.
    console.warn('Trava entre abas indisponível', e);
    return fn();
  }
}

export const filaCampo = {
  async listar(): Promise<ItemFila[]> {
    const itens = await local.all<ItemFila>('fila');
    return itens.sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  },
  async adicionar(op: OperacaoCampo, rotulo: string): Promise<ItemFila> {
    const [item] = await gravarNaFila([op], rotulo);
    return item!;
  },
  async remover(clientId: string) {
    await local.delete('fila', clientId);
    avisar();
  },
  async tentarDeNovo(clientId: string) {
    // Lê e grava numa transação só: o descartado noutra aba nesse meio-tempo não volta como pendente.
    await local.atualizar<ItemFila>('fila', clientId, (item) => (item ? { ...item, status: 'PENDENTE', erro: null } : undefined));
    avisar();
  },
  /**
   * Envia o que está pendente e devolve o resumo; fora da rede, não faz nada. Um envio por vez, nesta aba e entre as abas
   * (TRAVA_ENVIO): o que outra aba já levou não vai de novo. Não lança: a falha do banco do aparelho no meio do envio vem
   * em `falha`, e a lista da fila é avisada de qualquer jeito.
   */
  async sincronizar(): Promise<ResumoEnvioAcs> {
    const resumo: ResumoEnvioAcs = { enviados: 0, duplicados: 0, erros: 0, offline: false, falha: null };
    if (!estaOnline()) return { ...resumo, offline: true };
    return emSequencia(async () => {
      try {
        // O registro gravado agora (nesta aba ou noutra) entra inteiro nesta leitura ou fica inteiro para o próximo envio.
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
            const erro = err instanceof Error ? err.message : String(err);
            for (const op of lote) if (await marcarErro(op.clientId, erro)) resumo.erros++;
            continue;
          }
          const historico = await historicoEnvios.listar();
          try {
            for (const r of resultados) {
              const item = pendentes.find((p) => p.clientId === r.clientId);
              if (!item) continue;
              if (r.status === 'ERRO') {
                if (await marcarErro(r.clientId, r.erro)) resumo.erros++;
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
    });
  },
};

/**
 * Registro feito num formulário: grava as operações na fila (todas ou nenhuma, numa transação só) e dispara o envio sem
 * esperar por ele. A falha ao gravar volta para o formulário (nada ficou guardado, e salvar de novo não duplica). A do
 * envio não volta: o registro já está na fila, e o formulário aberto com o erro levaria o agente a salvar de novo, com
 * outro clientId (o registro em dobro). Quem envia avisa o resultado (toast).
 */
export async function registrarNaFila(ops: OperacaoCampo[], rotulo: string, enviar: () => Promise<unknown>): Promise<void> {
  await gravarNaFila(ops, rotulo);
  // Sem esperar: o formulário fecha já, e nada do envio (nem uma falha imediata) volta para ele.
  void Promise.resolve()
    .then(enviar)
    .catch((e) => console.warn('Envio em segundo plano não concluído', e));
}

/**
 * Marca o erro do servidor no registro que ainda está na fila, e diz se marcou: o descartado durante o envio (nesta aba ou
 * noutra) não volta para a fila com o erro, como no app do ACE. Lê e grava numa transação só: o descarte de outra aba não
 * entra entre a leitura e a gravação (antes, a gravação desfazia o descarte).
 */
async function marcarErro(clientId: string, erro: string | null): Promise<boolean> {
  const marcado = await local.atualizar<ItemFila>('fila', clientId, (atual) => (atual ? { ...atual, status: 'ERRO', erro } : undefined));
  return marcado !== undefined;
}

/**
 * Põe as operações na fila numa transação só do banco do aparelho: todas ou nenhuma, e a falha sobe. Nenhuma leitura (do
 * envio, desta aba ou de outra) vê parte do registro, e a aba que morre no meio (o Android fecha a aba em segundo plano,
 * o agente fecha a aba) não deixa o responsável sozinho na fila, para ir no próximo envio sem o domicílio.
 */
async function gravarNaFila(ops: OperacaoCampo[], rotulo: string): Promise<ItemFila[]> {
  const quando = instantes(ops.length);
  const itens = ops.map((op, i): ItemFila => ({ clientId: op.clientId, op, status: 'PENDENTE', erro: null, criadoEm: quando[i]!, rotulo }));
  await local.gravar(itens.map((item) => ({ store: 'fila', put: item })));
  avisar();
  return itens;
}

/** Último instante dado a um item da fila nesta aba. */
let ultimoInstante = 0;
/** Quanto o relógio pode estar atrás do último instante e os itens novos ainda irem depois dele. */
const FOLGA_DO_RELOGIO_MS = 1000;
/**
 * Instantes para os itens novos, depois do último dado nesta aba: a lista da fila (pelo criadoEm) mostra o registro na
 * ordem das operações e depois dos anteriores, mesmo no mesmo milissegundo. Se o relógio voltou mais que a folga (a hora
 * da rede depois de um tempo sem sinal), vale a hora do relógio: os itens novos não ficam com a hora adiantada.
 */
function instantes(n: number): string[] {
  const agora = Date.now();
  const inicio = ultimoInstante - agora <= FOLGA_DO_RELOGIO_MS ? Math.max(agora, ultimoInstante + 1) : agora;
  ultimoInstante = inicio + n - 1;
  return Array.from({ length: n }, (_, i) => new Date(inicio + i).toISOString());
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
    return ouvirFila(carregar);
  }, [carregar]);
  return { itens, pendentes: itens.filter((i) => i.status === 'PENDENTE').length, erros: itens.filter((i) => i.status === 'ERRO').length, recarregar: carregar };
}
