import * as http from 'node:http';
import * as https from 'node:https';
import { isValidCns, isValidCpf, onlyDigits } from '@omnisaude/shared';
import { NAMING_SYSTEMS } from './rnds';
import type { Bundle, OperationOutcome, Organization } from 'fhir/r4';

/**
 * Cliente da RNDS com autenticação mútua (mTLS) pelo certificado ICP-Brasil do estabelecimento/ente.
 *
 * Conforme o guia e a coleção oficial de requisições da RNDS:
 * - token: GET {authUrl}/api/token com o certificado cliente (e-CNPJ do estabelecimento); resposta
 *   { access_token, token_type: "jwt", scope: "read write", expires_in } (30 minutos);
 * - chamadas EHR: cabeçalho "X-Authorization-Server: Bearer <token>" e "Authorization: <CNS do profissional
 *   em nome de quem a requisição é feita, lotado no estabelecimento>";
 * - envio de documentos: POST {ehrUrl}/api/fhir/r4/Bundle; o id do recurso criado volta no cabeçalho Location.
 */

export type RndsTlsOptions = { pfx: Buffer | string; passphrase?: string; ca?: Buffer | string } | { cert: Buffer | string; key: Buffer | string; passphrase?: string; ca?: Buffer | string };

export interface RndsClientOptions {
  authUrl: string;
  ehrUrl: string;
  /** Certificado cliente. Pode ser omitido apenas contra o servidor simulado (http). */
  tls?: RndsTlsOptions;
  /** CNS do profissional em nome de quem as requisições são feitas (cabeçalho Authorization). */
  requesterCns?: string;
  /** Compatibilidade: CPF usado no cabeçalho Authorization quando não há CNS (ambientes antigos/simulados). */
  requesterCpf?: string;
  timeoutMs?: number;
  /** Margem de renovação antecipada do token, em ms (padrão 60s). */
  tokenRenewMarginMs?: number;
  now?: () => number;
}

export class RndsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly outcome?: OperationOutcome,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'RndsError';
  }
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export const FHIR_JSON = 'application/fhir+json';

export class RndsClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly agent: https.Agent | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: RndsClientOptions) {
    if (opts.requesterCns) {
      if (!isValidCns(opts.requesterCns)) throw new Error('CNS do solicitante RNDS inválido');
    } else if (!opts.requesterCpf || !isValidCpf(opts.requesterCpf)) throw new Error('Informe o CNS (ou, na falta, o CPF) do solicitante RNDS');
    this.agent = opts.tls ? new https.Agent({ ...opts.tls, keepAlive: true }) : undefined;
    this.now = opts.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    const res = await this.request('GET', `${trimSlash(this.opts.authUrl)}/api/token`, { Accept: 'application/json' });
    if (res.status !== 200) throw new RndsError(`Falha ao obter token da RNDS (${res.status})`, res.status, undefined, res.body);
    let parsed: { access_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new RndsError('Resposta de token da RNDS não é JSON', res.status, undefined, res.body);
    }
    if (!parsed.access_token) throw new RndsError('Resposta de token da RNDS sem access_token', res.status, undefined, res.body);
    // A RNDS informa expires_in em milissegundos (1800000); tolera segundos quando o valor for pequeno.
    const expires = parsed.expires_in ?? 1_800_000;
    const ttlMs = expires > 100_000 ? expires : expires * 1000;
    this.token = { value: parsed.access_token, expiresAt: this.now() + ttlMs - (this.opts.tokenRenewMarginMs ?? 60_000) };
    return parsed.access_token;
  }

  invalidateToken(): void {
    this.token = null;
  }

  /** Envia um documento; devolve o identificador atribuído pela RNDS. */
  async sendBundle(bundle: Bundle): Promise<{ id: string; location: string }> {
    const res = await this.ehr('POST', '/api/fhir/r4/Bundle', JSON.stringify(bundle));
    if (res.status !== 200 && res.status !== 201) throw toRndsError('Documento recusado pela RNDS', res);
    const location = headerValue(res.headers.location) ?? headerValue(res.headers['content-location']);
    if (!location) throw new RndsError('RNDS não devolveu o cabeçalho Location', res.status, undefined, res.body);
    const id = location
      .replace(/\/_history\/.*$/, '')
      .split('/')
      .filter(Boolean)
      .at(-1)!;
    return { id, location };
  }

  /** Estabelecimento pelo CNES; serve como teste de conexão, certificado e credencial. */
  async getOrganization(cnes: string): Promise<Organization> {
    const res = await this.ehr('GET', `/api/fhir/r4/Organization/${onlyDigits(cnes)}`);
    if (res.status !== 200) throw toRndsError('Falha ao consultar o estabelecimento na RNDS', res);
    return JSON.parse(res.body) as Organization;
  }

  /** Consulta de cidadão (CADSUS via RNDS): devolve os Patient encontrados. */
  async searchPatient(query: { cpf: string } | { cns: string }): Promise<Bundle> {
    const [system, value] = 'cpf' in query ? ['cpf', onlyDigits(query.cpf)] : ['cns', onlyDigits(query.cns)];
    const identifier = encodeURIComponent(`${NAMING_SYSTEMS[system as 'cpf' | 'cns']}|${value}`);
    const res = await this.ehr('GET', `/api/fhir/r4/Patient?identifier=${identifier}`);
    if (res.status === 404) return { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] };
    if (res.status !== 200) throw toRndsError('Falha na consulta de cidadão na RNDS', res);
    return JSON.parse(res.body) as Bundle;
  }

  private async ehr(method: 'GET' | 'POST', path: string, body?: string): Promise<HttpResponse> {
    const url = `${trimSlash(this.opts.ehrUrl)}${path}`;
    const call = async () =>
      this.request(
        method,
        url,
        {
          Accept: FHIR_JSON,
          'X-Authorization-Server': `Bearer ${await this.getAccessToken()}`,
          Authorization: onlyDigits(this.opts.requesterCns ?? this.opts.requesterCpf ?? ''),
          ...(body ? { 'Content-Type': FHIR_JSON } : {}),
        },
        body,
      );
    let res = await call();
    if (res.status === 401) {
      // Token revogado ou expirado antes do previsto: renova uma vez.
      this.invalidateToken();
      res = await call();
    }
    return res;
  }

  private request(method: string, url: string, headers: Record<string, string>, body?: string): Promise<HttpResponse> {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    if (!isHttps && this.opts.tls) throw new Error('Certificado cliente configurado, mas a URL não é HTTPS');
    const lib = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        target,
        {
          method,
          headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}) },
          ...(isHttps && this.agent ? { agent: this.agent } : {}),
          timeout: this.opts.timeoutMs ?? 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Tempo esgotado na requisição à RNDS: ${method} ${target.pathname}`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function toRndsError(message: string, res: HttpResponse): RndsError {
  let outcome: OperationOutcome | undefined;
  try {
    const parsed = JSON.parse(res.body);
    if (parsed?.resourceType === 'OperationOutcome') outcome = parsed;
  } catch {
    // corpo não-JSON
  }
  const details = outcome?.issue
    ?.map((i) => i.diagnostics ?? i.details?.text)
    .filter(Boolean)
    .join('; ');
  return new RndsError(details ? `${message}: ${details}` : `${message} (${res.status})`, res.status, outcome, res.body);
}
