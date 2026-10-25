import { parecer } from './agente';
import { criaApi, type Guarda } from './api';
import { autorizaPorAssinatura } from './auth';
import { Corpus } from './rag';
import type { Analise, Trecho } from './tipos';

/*
 * O módulo no Cloudflare Workers. A página e dados/ são arquivos estáticos (binding ASSETS); a API usa a mesma função
 * do Node. Os pareceres ficam no KV PARECERES. Configuração em wrangler.jsonc; os segredos (TF_SEGREDO_SESSAO,
 * ANTHROPIC_API_KEY) entram com `wrangler secret put`.
 */

interface Ativos {
  fetch(req: Request | string): Promise<Response>;
}
interface Kv {
  get(chave: string): Promise<string | null>;
  put(chave: string, valor: string): Promise<void>;
}
export interface Env {
  ASSETS: Ativos;
  PARECERES: Kv;
  TF_SEGREDO_SESSAO: string;
  ANTHROPIC_API_KEY?: string;
  TF_MODELO?: string;
}

let corpus: Corpus | null = null;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origem = new URL(req.url).origin;
    const ativo = async <T>(p: string): Promise<T | null> => {
      const r = await env.ASSETS.fetch(new Request(origem + p));
      return r.ok ? ((await r.json()) as T) : null;
    };
    const guarda: Guarda = { get: (k) => env.PARECERES.get(k), put: (k, v) => env.PARECERES.put(k, v) };
    const api = criaApi({
      base: '/api/transferencias',
      dados: {
        indice: async () => (await ativo<{ municipios: { ibge: number }[] }>('/dados/indice.json')) ?? { municipios: [] },
        analise: (ibge) => ativo<Analise>(`/dados/analise/${ibge}.json`),
        corpus: async () => (corpus ??= new Corpus((await ativo<{ chunks: Trecho[] }>('/dados/rag/chunks.json'))?.chunks ?? [])),
      },
      guarda,
      autoriza: autorizaPorAssinatura(env.TF_SEGREDO_SESSAO),
      agente: env.ANTHROPIC_API_KEY
        ? (a, c) => parecer(a, c, { apiKey: env.ANTHROPIC_API_KEY, modelo: env.TF_MODELO })
        : undefined,
      registra: (e) => console.log(JSON.stringify(e)),
    });
    const resposta = await api(req);
    if (resposta) return resposta;
    if (new URL(req.url).pathname.startsWith('/dados/pareceres/')) return new Response(null, { status: 404 });
    return env.ASSETS.fetch(req);
  },
};
