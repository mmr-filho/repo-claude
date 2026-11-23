import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErroAgente, parecerDoMotor } from '../src/agente';
import { criaApi, memoria } from '../src/api';
import { assinaSessao, autorizaPorAssinatura, type Sessao } from '../src/auth';
import type { Parecer } from '../src/tipos';
import { analise, c } from './apoio';

const SEGREDO = 'segredo-de-teste-com-mais-de-32-caracteres';
const URL_BASE = 'https://mm.api.br/api/transferencias';

function monta(agente?: () => Promise<Parecer>, limitePorHora = 10) {
  let chamadas = 0;
  const api = criaApi({
    base: '/api/transferencias',
    dados: {
      indice: async () => ({ municipios: [{ ibge: analise.ibge }, { ibge: 1700251 }] }),
      analise: async (ibge) => (ibge === analise.ibge ? analise : null),
      corpus: async () => c,
    },
    guarda: memoria(),
    autoriza: autorizaPorAssinatura(SEGREDO),
    agente: agente ? async () => { chamadas++; return agente(); } : undefined,
    limitePorHora,
  });
  return { api, chamadas: () => chamadas };
}

const sessao = (m: Partial<Sessao> = {}): Sessao => ({ usuario: 'tecnico@prefeitura', municipios: [analise.ibge], pode_gerar: true, ...m });
async function pede(api: (r: Request) => Promise<Response | null>, caminho: string, s: Sessao | null, init: RequestInit = {}) {
  const h = new Headers(init.headers);
  if (s) for (const [k, v] of Object.entries(await assinaSessao(SEGREDO, s))) h.set(k, v);
  const r = await api(new Request(URL_BASE + caminho, { ...init, headers: h }));
  assert.ok(r, 'rota não atendida');
  return r;
}
const post = { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://mm.api.br' }, body: '{}' };

test('autenticação: sem sessão, assinatura adulterada ou vencida → 401', async () => {
  const { api } = monta();
  assert.equal((await pede(api, `/${analise.ibge}`, null)).status, 401);
  const h = await assinaSessao(SEGREDO, sessao());
  const adulterada = new Request(`${URL_BASE}/${analise.ibge}`, { headers: { ...h, 'x-mm-sessao': h['x-mm-sessao']!.slice(0, -2) + 'AA' } });
  assert.equal((await api(adulterada))?.status, 401);
  const vencida = await assinaSessao(SEGREDO, sessao(), 60, Date.now() - 3600_000);
  assert.equal((await api(new Request(`${URL_BASE}/${analise.ibge}`, { headers: vencida })))?.status, 401);
  const outroSegredo = await assinaSessao('outro-segredo-qualquer-com-32-caracteres!!', sessao());
  assert.equal((await api(new Request(`${URL_BASE}/${analise.ibge}`, { headers: outroSegredo })))?.status, 401);
  assert.throws(() => autorizaPorAssinatura('curto'));
});

test('acesso por prefeitura: lista filtrada, 403 fora da sessão, análise do motor', async () => {
  const { api } = monta();
  const lista = await (await pede(api, '/municipios', sessao())).json();
  assert.deepEqual(lista.municipios.map((m: { ibge: number }) => m.ibge), [analise.ibge]);
  assert.equal((await pede(api, '/1700251', sessao())).status, 403);
  const r = await pede(api, `/${analise.ibge}`, sessao());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await r.json()).achados.length, analise.achados.length);
  assert.equal((await pede(api, '/abc', sessao())).status, 404);
  assert.equal(await api(new Request('https://mm.api.br/outra')), null, 'fora da base: a rota é do site');
});

test('parecer: protege contra outra origem e falta de permissão', async () => {
  const { api } = monta(async () => parecerDoMotor(analise));
  assert.equal((await pede(api, `/${analise.ibge}/parecer`, sessao(), { ...post, headers: { 'content-type': 'text/plain' } })).status, 403);
  assert.equal((await pede(api, `/${analise.ibge}/parecer`, sessao(), { ...post, headers: { ...post.headers, origin: 'https://outro.site' } })).status, 403);
  assert.equal((await pede(api, `/${analise.ibge}/parecer`, sessao({ pode_gerar: false }), post)).status, 403);
  assert.equal((await pede(api, `/${analise.ibge}/parecer`, sessao())).status, 404); // nenhum gerado ainda
});

test('parecer: gera com o agente, reaproveita, refaz sob pedido e respeita o limite por hora', async () => {
  const agente = async (): Promise<Parecer> => ({ ...parecerDoMotor(analise), origem: 'agente', modelo: 'claude-opus-5-5' });
  const { api, chamadas } = monta(agente, 2);
  const r1 = await (await pede(api, `/${analise.ibge}/parecer`, sessao(), post)).json();
  assert.equal(r1.origem, 'agente');
  assert.equal(r1.pedido_por, 'tecnico@prefeitura');
  await pede(api, `/${analise.ibge}/parecer`, sessao(), post);
  assert.equal(chamadas(), 1, 'segundo pedido reaproveita o parecer');
  assert.equal((await pede(api, `/${analise.ibge}/parecer`, sessao())).status, 200);
  await pede(api, `/${analise.ibge}/parecer`, sessao(), { ...post, body: '{"refazer":true}' });
  assert.equal(chamadas(), 2);
  assert.equal((await pede(api, `/${analise.ibge}/parecer`, sessao(), { ...post, body: '{"refazer":true}' })).status, 429);
});

test('parecer: se o agente falha, o prefeito recebe o texto do motor com o aviso', async () => {
  const { api } = monta(async () => { throw new ErroAgente('o modelo recusou o pedido'); });
  const r = await (await pede(api, `/${analise.ibge}/parecer`, sessao(), post)).json();
  assert.equal(r.origem, 'motor');
  assert.match(r.ajustes[0], /agente indisponível \(o modelo recusou o pedido\)/);
  assert.equal(r.gargalos.length, analise.achados.length);
});
