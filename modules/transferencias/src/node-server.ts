import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parecer } from './agente';
import { criaApi, type Guarda } from './api';
import { autorizaPorAssinatura, type Sessao } from './auth';
import { corpus, DADOS, RAIZ } from './dados';
import type { Analise } from './tipos';

/*
 * Servidor Node do módulo: a página (index.html, transferencias.js, dados/) e a API em /api/transferencias.
 *
 *   TF_SEGREDO_SESSAO   segredo do HMAC da sessão repassada pelo mm.api.br (auth.ts). Sem ele, só aceita pedidos
 *                       da própria máquina, como usuário "local" (desenvolvimento).
 *   ANTHROPIC_API_KEY   liga o agente; sem ela, o parecer é o texto do motor de regras.
 *   TF_MODELO, TF_ESFORCO, PORT
 *
 *   npm run dev -w @mm/transferencias
 */

const PORTA = Number(process.env.PORT ?? 8090);
const BASE = '/api/transferencias';
const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:";
const TIPOS: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

const ler = <T>(p: string): T | null => (fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as T) : null);
let corpusCache: ReturnType<typeof corpus> | null = null;

function guardaEmArquivo(dir: string): Guarda {
  fs.mkdirSync(dir, { recursive: true });
  const arq = (k: string) => path.join(dir, k.replace(/[^a-z0-9_-]/gi, '_') + '.json');
  return {
    get: async (k) => (fs.existsSync(arq(k)) ? fs.readFileSync(arq(k), 'utf8') : null),
    put: async (k, v) => fs.writeFileSync(arq(k), v),
  };
}

const segredo = process.env.TF_SEGREDO_SESSAO;
if (!segredo && process.env.NODE_ENV === 'production') throw new Error('defina TF_SEGREDO_SESSAO em produção');
if (!segredo) console.warn('sem TF_SEGREDO_SESSAO: modo de desenvolvimento, a API só atende pedidos desta máquina');
const local = async (req: Request): Promise<Sessao | null> =>
  req.headers.get('x-tf-remoto') === '0' ? { usuario: 'local', municipios: 'todos', pode_gerar: true } : null;

const api = criaApi({
  base: BASE,
  dados: {
    indice: async () => ler(path.join(DADOS, 'indice.json')) ?? { municipios: [] },
    analise: async (ibge) => ler<Analise>(path.join(DADOS, 'analise', `${ibge}.json`)),
    corpus: async () => (corpusCache ??= corpus()),
  },
  guarda: guardaEmArquivo(path.join(DADOS, 'pareceres')),
  autoriza: segredo ? autorizaPorAssinatura(segredo) : local,
  agente: process.env.ANTHROPIC_API_KEY
    ? (a, c) => parecer(a, c, { modelo: process.env.TF_MODELO, esforco: process.env.TF_ESFORCO as never })
    : undefined,
  registra: (e) => console.log(JSON.stringify({ ...e, em: new Date().toISOString() })),
});

/** Arquivos da página: só index.html, transferencias.js e o que está em dados/ (exceto os pareceres). */
function estatico(p: string): string | null {
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  if (!(rel === 'index.html' || rel === 'transferencias.js' || (rel.startsWith('dados/') && !rel.startsWith('dados/pareceres/')))) return null;
  const f = path.resolve(RAIZ, rel);
  return f.startsWith(RAIZ + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const remoto = !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
      const cabecalhos = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'x-tf-remoto') cabecalhos.set(k, v);
      cabecalhos.set('x-tf-remoto', remoto ? '1' : '0');
      const corpo = req.method === 'POST' ? await new Promise<Buffer>((ok) => {
        const partes: Buffer[] = [];
        let tam = 0;
        req.on('data', (c: Buffer) => { tam += c.length; if (tam <= 10_000) partes.push(c); });
        req.on('end', () => ok(Buffer.concat(partes)));
      }) : undefined;
      const resposta = await api(new Request(url, { method: req.method, headers: cabecalhos, body: corpo ? new Uint8Array(corpo) : undefined }));
      if (resposta) {
        res.writeHead(resposta.status, Object.fromEntries(resposta.headers));
        res.end(Buffer.from(await resposta.arrayBuffer()));
        return;
      }
      const f = req.method === 'GET' ? estatico(url.pathname) : null;
      if (!f) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': TIPOS[path.extname(f)] ?? 'application/octet-stream',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      });
      fs.createReadStream(f).pipe(res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  })
  .listen(PORTA, () => console.log(`transferências: http://localhost:${PORTA}/ (agente ${process.env.ANTHROPIC_API_KEY ? 'ligado' : 'desligado'})`));
