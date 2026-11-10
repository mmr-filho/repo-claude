import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

/**
 * Diagnóstico da partida do container (Cloudflare Containers). Quando a preparação do banco (`cli.js boot`) ou a
 * própria API não sobem, o container não morre: um servidor mínimo responde 503 em todas as rotas com a etapa e o
 * motivo, sem segredos. A tela de login mostra essa mensagem no lugar de "O OmniSaúde está iniciando" para sempre.
 * Depois de alguns minutos o servidor sai com erro e o Worker tenta a partida de novo na requisição seguinte.
 */

/** Onde a falha fica registrada entre o `cli.js boot` e o servidor de diagnóstico. */
export const ARQUIVO_FALHA_PARTIDA = '/tmp/omnisaude-partida.json';

/** Valores que nunca aparecem na mensagem (trocados por ***). */
const SEGREDOS = [
  'MASTER_DATABASE_URL',
  'TENANT_ADMIN_PASSWORD',
  'TENANT_DB_PASSWORD',
  'TENANT_BI_PASSWORD',
  'JWT_SECRET',
  'DATA_KEY',
  'JOBS_SECRET',
  'PLATFORM_ADMIN_PASSWORD',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'ANTHROPIC_API_KEY',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'RNDS_CERT_PASSPHRASE',
  'PEC_SENHA',
  'LIBRAS_INTERPRETER_KEY',
  'TURN_CREDENTIAL',
] as const;

/** Valores trocados pelo nome da variável do painel: a mensagem continua útil sem expor endereço e usuários do banco. */
const NOMEADOS = [
  ['TENANT_DB_HOST', '<PG_HOST>'],
  ['TENANT_REPLICA_HOST', '<PG_HOST da réplica>'],
  ['TENANT_ADMIN_USER', '<PG_ADMIN_USER>'],
  ['TENANT_BI_USER', '<usuário do BI>'],
  ['TENANT_DB_USER', '<usuário da aplicação>'],
] as const;

export interface FalhaDePartida {
  /** Em que passo a partida parou (ex.: "papéis e banco master", "API"). */
  etapa: string;
  /** Mensagem do erro, sem segredos. */
  mensagem: string;
  /** Código do erro quando há (ex.: 28P01 senha recusada pelo PostgreSQL, ENOTFOUND endereço não encontrado). */
  codigo?: string;
  em: string;
}

/** Tira da mensagem as credenciais de URL, os segredos e o endereço e os usuários do banco. */
export function redigirSegredos(texto: string, env: NodeJS.ProcessEnv = process.env): string {
  let t = texto.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
  const trocas: { valor: string; troca: string }[] = [];
  for (const k of SEGREDOS) trocas.push({ valor: env[k] ?? '', troca: '***' });
  for (const [k, troca] of NOMEADOS) trocas.push({ valor: env[k] ?? '', troca });
  // O valor mais longo primeiro: um usuário com o sufixo do branch não pode ser trocado só pela metade.
  for (const { valor, troca } of trocas.filter((x) => x.valor.length >= 4).sort((a, b) => b.valor.length - a.valor.length)) t = t.split(valor).join(troca);
  return t;
}

/** Grava a falha para o servidor de diagnóstico e devolve o que foi gravado. */
export function registrarFalhaDePartida(etapa: string, err: unknown, arquivo = ARQUIVO_FALHA_PARTIDA, env: NodeJS.ProcessEnv = process.env): FalhaDePartida {
  const bruta = err instanceof Error ? err.message : String(err);
  const codigo = (err as { code?: unknown } | null)?.code;
  const falha: FalhaDePartida = {
    etapa,
    mensagem: redigirSegredos(bruta, env).replace(/\s+/g, ' ').trim().slice(0, 600),
    ...(typeof codigo === 'string' && /^[A-Za-z0-9_]{2,40}$/.test(codigo) ? { codigo } : {}),
    em: new Date().toISOString(),
  };
  try {
    writeFileSync(arquivo, JSON.stringify(falha));
  } catch {
    // Sem o arquivo, o servidor de diagnóstico responde com a mensagem genérica; o log do container tem o erro.
  }
  return falha;
}

export function lerFalhaDePartida(arquivo = ARQUIVO_FALHA_PARTIDA): FalhaDePartida | null {
  try {
    const f = JSON.parse(readFileSync(arquivo, 'utf8')) as FalhaDePartida;
    return typeof f?.etapa === 'string' && typeof f?.mensagem === 'string' ? f : null;
  } catch {
    return null;
  }
}

export function mensagemDaFalha(falha: FalhaDePartida | null): string {
  const onde = 'O detalhe completo está no log do container (Cloudflare: Workers & Pages > repo-claude > Containers).';
  if (!falha) return `O OmniSaúde não conseguiu subir. ${onde}`;
  const codigo = falha.codigo ? ` (código ${falha.codigo})` : '';
  return `O OmniSaúde não conseguiu subir na etapa "${falha.etapa}": ${falha.mensagem}${codigo}. Corrija no painel da Cloudflare (Settings > Variables and Secrets); a partida é refeita sozinha em instantes. ${onde}`;
}

/**
 * Responde 503 com o motivo em todas as rotas por `duracaoMs` e depois sai com código 1, para o Worker refazer a
 * partida na requisição seguinte (a falha pode ter sido passageira, ou o segredo pode ter sido corrigido).
 */
export function servirFalhaDePartida(opts: { porta: number; falha: FalhaDePartida | null; duracaoMs?: number; sair?: () => void }): Server {
  const corpo = JSON.stringify({ statusCode: 503, code: 'PARTIDA_FALHOU', message: mensagemDaFalha(opts.falha), etapa: opts.falha?.etapa ?? null, em: opts.falha?.em ?? null });
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' });
    res.end(corpo);
  });
  const sair = opts.sair ?? (() => process.exit(1));
  // Porta ocupada ou outro erro do próprio servidor: sai com erro e o Worker registra o código da parada.
  server.on('error', (err) => {
    console.error(`Servidor de diagnóstico da partida: ${err.message}`);
    sair();
  });
  server.listen(opts.porta, '0.0.0.0');
  const timer = setTimeout(() => server.close(() => sair()), opts.duracaoMs ?? 180_000);
  server.on('close', () => clearTimeout(timer));
  return server;
}
