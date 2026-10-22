const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;

/**
 * Normaliza o endereço do servidor. Exige HTTPS, exceto em rede local/desenvolvimento
 * (a senha nunca trafega — só um derivado — mas os metadados e o token sim).
 */
export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  if (!url) throw new Error('Informe o endereço do servidor');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Endereço do servidor inválido');
  }
  if (parsed.protocol === 'http:' && !PRIVATE_HOST.test(parsed.hostname)) {
    throw new Error('Use HTTPS. HTTP só é aceito em rede local (para testes).');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function normalizeHandle(input: string): string {
  return input.trim().toLowerCase();
}
