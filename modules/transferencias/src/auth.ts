/*
 * Sessão vinda do mm.api.br. O módulo não tem login próprio: o middleware do site (o mesmo que protege os outros
 * módulos, atrás do Cloudflare/API Gateway) autentica o usuário e repassa a sessão em dois cabeçalhos:
 *
 *   x-mm-sessao      base64url de {"u": "<usuário>", "m": [<ibge>, ...] ou "*", "g": <pode gerar parecer>, "exp": <unix>}
 *   x-mm-assinatura  base64url do HMAC-SHA256 de x-mm-sessao com o segredo compartilhado (TF_SEGREDO_SESSAO)
 *
 * Funciona em Node e no Workers (Web Crypto). Pedido sem assinatura válida ou vencido não tem sessão.
 */

export interface Sessao {
  usuario: string;
  /** prefeituras que o usuário pode ver; "todos" para equipe estadual ou administração */
  municipios: number[] | 'todos';
  /** pode pedir um parecer novo ao agente (consome a API do modelo) */
  pode_gerar: boolean;
}

const b64url = {
  de: (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)),
  para: (b: ArrayBuffer | Uint8Array): string =>
    btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};

const chave = (segredo: string, uso: KeyUsage) =>
  crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, [uso]);

/** Usado pelo middleware do site (e pelos testes) para montar os cabeçalhos. */
export async function assinaSessao(segredo: string, s: Sessao, validadeSeg = 300, agora = Date.now()): Promise<Record<string, string>> {
  const corpo = b64url.para(new TextEncoder().encode(JSON.stringify({
    u: s.usuario, m: s.municipios === 'todos' ? '*' : s.municipios, g: s.pode_gerar, exp: Math.floor(agora / 1000) + validadeSeg,
  })));
  const assinatura = await crypto.subtle.sign('HMAC', await chave(segredo, 'sign'), new TextEncoder().encode(corpo));
  return { 'x-mm-sessao': corpo, 'x-mm-assinatura': b64url.para(assinatura) };
}

export function autorizaPorAssinatura(segredo: string, agora = () => Date.now()) {
  if (segredo.length < 32) throw new Error('TF_SEGREDO_SESSAO precisa de pelo menos 32 caracteres');
  return async (req: Request): Promise<Sessao | null> => {
    const corpo = req.headers.get('x-mm-sessao');
    const assinatura = req.headers.get('x-mm-assinatura');
    if (!corpo || !assinatura || corpo.length > 4096) return null;
    try {
      // verify compara em tempo constante
      const ok = await crypto.subtle.verify('HMAC', await chave(segredo, 'verify'), b64url.de(assinatura) as BufferSource, new TextEncoder().encode(corpo));
      if (!ok) return null;
      const s = JSON.parse(new TextDecoder().decode(b64url.de(corpo))) as { u?: unknown; m?: unknown; g?: unknown; exp?: unknown };
      if (typeof s.u !== 'string' || !s.u || typeof s.exp !== 'number' || s.exp * 1000 < agora()) return null;
      const municipios = s.m === '*' ? 'todos' : Array.isArray(s.m) && s.m.every((x) => Number.isInteger(x)) ? (s.m as number[]) : null;
      if (!municipios) return null;
      return { usuario: s.u, municipios, pode_gerar: s.g === true };
    } catch {
      return null;
    }
  };
}
