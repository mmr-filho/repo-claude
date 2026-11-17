import { afterEach, describe, expect, it, vi } from 'vitest';
import { erroDaConsulta } from '../src/components/consolidacao/consulta';
import { api, ApiError, errorMessage, MENSAGEM_SERVIDOR_DEMOROU } from '../src/lib/api';

/*
 * Mensagem do erro que não vem em JSON (TELAS-6): a página HTML da borda da Cloudflare (524, 502), do proxy ou do
 * Worker nunca vira o texto do alerta nas abas. 502, 503, 504 e 524 dizem que o servidor demorou; os demais,
 * "Erro <status>". Texto curto sem HTML continua valendo, e a 503 da partida do Worker ("está iniciando", em JSON)
 * mantém a mensagem dela. fetch simulado.
 */

const PAGINA_524 =
  '<!DOCTYPE html>\n<html lang="en-US"><head><title>mm.api.br | 524: A timeout occurred</title></head><body><h1>A timeout occurred</h1><p>The origin web server timed out responding to this request.</p></body></html>';

/** Resposta simulada do fetch; devolve o erro que o api.get lançou. */
async function erroDe(resposta: () => Response): Promise<ApiError> {
  vi.stubGlobal('fetch', async () => resposta());
  try {
    await api.get('/vigilancia/surtos/sugestoes', { token: null });
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('o pedido deveria falhar');
}

afterEach(() => vi.unstubAllGlobals());

describe('TELAS-6: corpo de erro que não é JSON', () => {
  it('a página HTML da borda (524, 502, 503, 504) vira "O servidor demorou a responder", nas abas e na consulta', async () => {
    for (const status of [524, 502, 503, 504]) {
      const e = await erroDe(() => new Response(PAGINA_524, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } }));
      expect(e).toBeInstanceOf(ApiError);
      expect(e.status).toBe(status);
      expect(errorMessage(e)).toBe(MENSAGEM_SERVIDOR_DEMOROU);
      expect(erroDaConsulta(e)).toMatchObject({ mensagem: MENSAGEM_SERVIDOR_DEMOROU, status });
    }
    expect(MENSAGEM_SERVIDOR_DEMOROU).toBe('O servidor demorou a responder. Tente de novo em instantes.');
    // Sem o content-type de HTML, mas começando com '<' (o proxy do Next, a página do nginx): também não vira mensagem.
    const semTipo = await erroDe(() => new Response('  <html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502 }));
    expect(errorMessage(semTipo)).toBe(MENSAGEM_SERVIDOR_DEMOROU);
  });

  it('nos demais status, HTML e corpo vazio viram "Erro <status>"', async () => {
    const e500 = await erroDe(() => new Response('<html><body>Worker threw exception</body></html>', { status: 500, headers: { 'content-type': 'text/html' } }));
    expect(errorMessage(e500)).toBe('Erro 500');
    const e404 = await erroDe(() => new Response('<!doctype html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } }));
    expect(errorMessage(e404)).toBe('Erro 404');
    const vazio = await erroDe(() => new Response('', { status: 504 }));
    expect(errorMessage(vazio)).toBe(MENSAGEM_SERVIDOR_DEMOROU);
    expect(errorMessage(await erroDe(() => new Response('', { status: 418 })))).toBe('Erro 418');
  });

  it('texto curto sem HTML continua como mensagem; texto longo, não', async () => {
    expect(errorMessage(await erroDe(() => new Response('Arquivo inválido', { status: 400, headers: { 'content-type': 'text/plain' } })))).toBe('Arquivo inválido');
    expect(errorMessage(await erroDe(() => new Response('x'.repeat(301), { status: 400, headers: { 'content-type': 'text/plain' } })))).toBe('Erro 400');
  });

  it('JSON continua igual: a 503 da partida do Worker ("está iniciando") e o erro da API com código', async () => {
    const partida = await erroDe(() => Response.json({ message: 'O OmniSaúde está iniciando. Tente de novo em instantes.', detalhe: 'Container is starting' }, { status: 503, headers: { 'retry-after': '15' } }));
    expect(errorMessage(partida)).toBe('O OmniSaúde está iniciando. Tente de novo em instantes.');
    const api409 = await erroDe(() => Response.json({ message: 'Outra importação está sendo processada agora.', code: 'IMPORTACAO_OCUPADA' }, { status: 409 }));
    expect(api409).toMatchObject({ status: 409, code: 'IMPORTACAO_OCUPADA', message: 'Outra importação está sendo processada agora.' });
    // JSON quebrado de um 502: sem mensagem utilizável, o texto pronto.
    expect(errorMessage(await erroDe(() => new Response('{"mess', { status: 502, headers: { 'content-type': 'application/json' } })))).toBe(MENSAGEM_SERVIDOR_DEMOROU);
  });
});
