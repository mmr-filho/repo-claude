import { ErroAgente, parecerDoMotor } from './agente';
import type { Sessao } from './auth';
import type { Corpus } from './rag';
import type { Analise, Parecer } from './tipos';

/*
 * API do módulo, em Request/Response padrão: a mesma função atende no Node (node-server.ts) e no Cloudflare Workers
 * (worker.ts). Rotas, sob `base` (ex.: /api/transferencias):
 *
 *   GET  {base}/municipios         lista com o resumo de cada prefeitura (as que a sessão pode ver)
 *   GET  {base}/{ibge}             análise do motor de regras
 *   GET  {base}/{ibge}/parecer     último parecer gerado (404 se não há)
 *   POST {base}/{ibge}/parecer     gera o parecer (agente; sem agente ou se ele falhar, o texto do motor)
 *                                  corpo opcional {"refazer": true} para não reaproveitar o último
 */

export interface FonteDados {
  indice(): Promise<{ municipios: { ibge: number }[] } & Record<string, unknown>>;
  analise(ibge: number): Promise<Analise | null>;
  corpus(): Promise<Corpus>;
}

/** Onde os pareceres ficam guardados (arquivo no Node, KV no Workers). */
export interface Guarda {
  get(chave: string): Promise<string | null>;
  put(chave: string, valor: string): Promise<void>;
}

export interface OpcoesApi {
  base: string;
  dados: FonteDados;
  guarda: Guarda;
  autoriza(req: Request): Promise<Sessao | null>;
  /** gera o parecer com o agente; ausente quando o agente não está configurado */
  agente?: (a: Analise, corpus: Corpus) => Promise<Parecer>;
  /** pareceres novos por usuário por hora */
  limitePorHora?: number;
  agora?: () => Date;
  registra?: (evento: Record<string, unknown>) => void;
}

const json = (corpo: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
  });
const erro = (status: number, mensagem: string, extra: Record<string, string> = {}) => json({ erro: mensagem }, status, extra);

const pode = (s: Sessao, ibge: number) => s.municipios === 'todos' || s.municipios.includes(ibge);

export function memoria(): Guarda {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
}

export function criaApi(op: OpcoesApi): (req: Request) => Promise<Response | null> {
  const agora = op.agora ?? (() => new Date());
  const limite = op.limitePorHora ?? 10;
  const uso = new Map<string, number[]>();
  const registra = op.registra ?? (() => {});

  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== op.base && !url.pathname.startsWith(op.base + '/')) return null;
    const partes = url.pathname.slice(op.base.length).split('/').filter(Boolean);
    const sessao = await op.autoriza(req);
    if (!sessao) return erro(401, 'sessão ausente ou inválida');

    if (partes.length === 1 && partes[0] === 'municipios') {
      if (req.method !== 'GET') return erro(405, 'método não permitido', { allow: 'GET' });
      const idx = await op.dados.indice();
      return json({ ...idx, municipios: idx.municipios.filter((m) => pode(sessao, m.ibge)) });
    }
    const ibge = Number(partes[0]);
    if (!/^17\d{5}$/.test(partes[0] ?? '') || partes.length > 2 || (partes[1] && partes[1] !== 'parecer')) return erro(404, 'rota desconhecida');
    if (!pode(sessao, ibge)) return erro(403, 'sem acesso a esta prefeitura');
    const analise = await op.dados.analise(ibge);
    if (!analise) return erro(404, 'prefeitura sem análise');

    if (partes.length === 1) {
      if (req.method !== 'GET') return erro(405, 'método não permitido', { allow: 'GET' });
      return json(analise);
    }
    const chave = `parecer:${ibge}`;
    if (req.method === 'GET') {
      const salvo = await op.guarda.get(chave);
      return salvo ? json(JSON.parse(salvo)) : erro(404, 'nenhum parecer gerado ainda');
    }
    if (req.method !== 'POST') return erro(405, 'método não permitido', { allow: 'GET, POST' });
    // pedido de outra origem, ou formulário simples (sem preflight), não gera parecer
    const origem = req.headers.get('origin');
    if ((origem && origem !== url.origin) || !(req.headers.get('content-type') ?? '').startsWith('application/json')) {
      return erro(403, 'pedido de outra origem');
    }
    if (!sessao.pode_gerar) return erro(403, 'usuário sem permissão para gerar parecer');
    let corpo: { refazer?: unknown } = {};
    try {
      const texto = await req.text();
      corpo = texto ? (JSON.parse(texto) as typeof corpo) : {};
    } catch {
      return erro(400, 'corpo inválido');
    }
    if (corpo.refazer !== true) {
      const salvo = await op.guarda.get(chave);
      const anterior = salvo ? (JSON.parse(salvo) as Parecer & { base?: string }) : null;
      if (anterior && anterior.base === analise.gerado_em) return json(anterior);
    }
    const t = agora().getTime();
    const recentes = (uso.get(sessao.usuario) ?? []).filter((x) => t - x < 3600_000);
    if (recentes.length >= limite) return erro(429, 'limite de pareceres por hora atingido', { 'retry-after': '600' });
    uso.set(sessao.usuario, [...recentes, t]);

    let parecer: Parecer;
    if (op.agente) {
      try {
        parecer = await op.agente(analise, await op.dados.corpus());
      } catch (e) {
        // agente indisponível (sem crédito, rede, recusa, formato): o prefeito recebe o texto do motor, avisado
        const motivo = e instanceof ErroAgente ? e.message : 'falha na chamada ao modelo';
        registra({ evento: 'agente_falhou', ibge, usuario: sessao.usuario, motivo, detalhe: e instanceof Error ? e.message : String(e) });
        parecer = { ...parecerDoMotor(analise, agora()), ajustes: [`agente indisponível (${motivo}): texto do motor de regras`] };
      }
    } else {
      parecer = parecerDoMotor(analise, agora());
    }
    const guardado = { ...parecer, base: analise.gerado_em, pedido_por: sessao.usuario };
    await op.guarda.put(chave, JSON.stringify(guardado));
    registra({ evento: 'parecer', ibge, usuario: sessao.usuario, origem: parecer.origem, ajustes: parecer.ajustes.length });
    return json(guardado);
  };
}
