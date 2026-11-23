import type Anthropic from '@anthropic-ai/sdk';
import { corpus, perfis } from '../src/dados';
import { estatisticas } from '../src/pares';
import { analisa } from '../src/regras';
import type { Analise } from '../src/tipos';

export const c = corpus();
const lista = perfis();
const est = estatisticas(lista);

/** Uma análise real com vários achados, inclusive um com norma externa (escolhida nos dados, para não quebrar com a atualização). */
export const analise: Analise = (() => {
  for (const p of lista) {
    const a = analisa(p, est, c.trechos);
    if (a.achados.length >= 3 && a.achados.some((x) => x.normas_externas.length)) return a;
  }
  throw new Error('nenhuma análise com 3 achados e norma externa nos dados');
})();

export interface Simulado {
  cliente: Pick<Anthropic, 'beta'>;
  pedidos: Record<string, unknown>[];
}

/** Cliente da API simulado: devolve a mensagem dada e guarda os parâmetros de cada pedido. */
export function clienteSimulado(resposta: (params: Record<string, unknown>) => Record<string, unknown>): Simulado {
  const pedidos: Record<string, unknown>[] = [];
  const cliente = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          pedidos.push(params);
          return { finalMessage: async () => resposta(params) };
        },
      },
    },
  } as unknown as Pick<Anthropic, 'beta'>;
  return { cliente, pedidos };
}

export const mensagemComTexto = (texto: string, stop_reason = 'end_turn') => ({
  id: 'msg_teste', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason, stop_details: null,
  content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: texto }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
