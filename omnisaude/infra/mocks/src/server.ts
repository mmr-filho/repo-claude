import { randomBytes, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { citizenToPatient, NAMING_SYSTEMS, validateRndsBundle, type CadsusCitizen } from '@omnisaude/fhir';
import { isValidCns, isValidCpf, onlyDigits } from '@omnisaude/shared';
import { DEFAULT_FIXTURES_DIR, loadNfeFixtures, MOCK_CITIZENS, type NfeFixture } from './fixtures';

/**
 * Servidor simulado para desenvolvimento e testes: RNDS/CADSUS (FHIR), SEFAZ (NF-e) e WhatsApp Cloud API.
 * Sem dependências externas; o estado fica em memória e some ao reiniciar.
 */

export interface MockServerOptions {
  citizens?: CadsusCitizen[];
  fixturesDir?: string;
  tokenTtlSeconds?: number;
  log?: (line: string) => void;
}

export interface ReceivedBundle {
  id: string;
  receivedAt: string;
  requesterCpf: string;
  bundle: unknown;
}

export interface SentWhatsAppMessage {
  id: string;
  receivedAt: string;
  apiVersion: string;
  phoneNumberId: string;
  to: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface MockState {
  tokens: Map<string, number>;
  bundles: ReceivedBundle[];
  whatsapp: SentWhatsAppMessage[];
  nfe: NfeFixture[];
  citizens: CadsusCitizen[];
}

const MAX_BODY = 5 * 1024 * 1024;

/**
 * Recorte do CNES de Gurupi/TO (código IBGE 170950) no formato da API de dados abertos do Ministério da
 * Saúde (/cnes/estabelecimentos). O CNES 9000011 coincide com a "UBS Centro" da demonstração, para testar
 * a conciliação; os demais são novos. Um está desativado.
 */
const CNES_ESTABELECIMENTOS = [
  {
    codigo_cnes: 9000011,
    nome_fantasia: 'UBS CENTRO',
    codigo_tipo_unidade: 2,
    nat: '1244',
    esfera: 'MUNICIPAL',
    tel: '63-3315-0100',
    email: 'ubs.centro@gurupi.to.gov.br',
    end: ['RUA 7', '120', 'CENTRO', '77405070'],
    turno: 'ATENDIMENTO NOS TURNOS DA MANHA, TARDE E NOITE',
    sus: 'SIM',
    lat: -11.7292,
    lon: -49.0686,
    motivo: null,
  },
  {
    codigo_cnes: 2546434,
    nome_fantasia: 'UNIDADE BASICA DE SAUDE ULISSES MOREIRA MILHOMEM',
    codigo_tipo_unidade: 2,
    nat: '1244',
    esfera: 'MUNICIPAL',
    tel: '(63) 3315-0114',
    email: null,
    end: ['RUA 12', 'S/N', 'VILA NOVA', '77410000'],
    turno: 'ATENDIMENTO NOS TURNOS DA MANHA, TARDE E NOITE',
    sus: 'SIM',
    lat: -11.73,
    lon: -49.07,
    motivo: null,
  },
  {
    codigo_cnes: 3331326,
    nome_fantasia: 'UPA DRA MARCIA MUCKY',
    codigo_tipo_unidade: 73,
    nat: '1244',
    esfera: 'MUNICIPAL',
    tel: '(63)3315-0027',
    email: null,
    end: ['AV GOIAS', '1500', 'CENTRO', '77403000'],
    turno: 'ATENDIMENTO CONTINUO DE 24 HORAS/DIA (PLANTAO:INCLUI SABADOS, DOMINGOS E FERIADOS)',
    sus: 'SIM',
    lat: -11.74,
    lon: -49.06,
    motivo: null,
  },
  {
    codigo_cnes: 2786109,
    nome_fantasia: 'HOSPITAL REGIONAL DE GURUPI',
    codigo_tipo_unidade: 5,
    nat: '1023',
    esfera: 'ESTADUAL',
    tel: '3027 5147',
    email: null,
    end: ['AV PARA', '1800', 'CENTRO', '77403010'],
    turno: 'ATENDIMENTO CONTINUO DE 24 HORAS/DIA (PLANTAO:INCLUI SABADOS, DOMINGOS E FERIADOS)',
    sus: 'SIM',
    lat: -11.735,
    lon: -49.065,
    motivo: null,
  },
  {
    codigo_cnes: 8395594,
    nome_fantasia: 'FARMACIA CENTRAL',
    codigo_tipo_unidade: 43,
    nat: '1244',
    esfera: 'MUNICIPAL',
    tel: null,
    email: null,
    end: ['RUA 3', '45', 'CENTRO', '77403050'],
    turno: 'ATENDIMENTOS NOS TURNOS DA MANHA E A TARDE',
    sus: 'NAO',
    lat: null,
    lon: null,
    motivo: null,
  },
  {
    codigo_cnes: 549126,
    nome_fantasia: 'COORDENADORIA DE VIGILANCIA EPIDEMIOLOGICA',
    codigo_tipo_unidade: 50,
    nat: '1244',
    esfera: 'MUNICIPAL',
    tel: '6333150088',
    email: null,
    end: ['PERNAMBUCO', '1345', 'CENTRO', '77403020'],
    turno: 'ATENDIMENTOS NOS TURNOS DA MANHA E A TARDE',
    sus: 'NAO',
    lat: null,
    lon: null,
    motivo: null,
  },
  {
    codigo_cnes: 9695214,
    nome_fantasia: 'REAVITTA CENTRO DE SAUDE E ESTETICA AVANCADA',
    codigo_tipo_unidade: 36,
    nat: '2135',
    esfera: 'MUNICIPAL',
    tel: null,
    email: null,
    end: ['RUA 20', '300', 'CENTRO', '77403100'],
    turno: 'ATENDIMENTOS NOS TURNOS DA MANHA E A TARDE',
    sus: 'NAO',
    lat: null,
    lon: null,
    motivo: null,
  },
  {
    codigo_cnes: 2546523,
    nome_fantasia: 'POSTO ANTIGO DESATIVADO',
    codigo_tipo_unidade: 1,
    nat: '1244',
    esfera: 'MUNICIPAL',
    tel: null,
    email: null,
    end: ['RUA 1', '1', 'CENTRO', '77403000'],
    turno: 'ATENDIMENTOS NOS TURNOS DA MANHA E A TARDE',
    sus: 'NAO',
    lat: null,
    lon: null,
    motivo: '08',
  },
].map((e) => ({
  codigo_cnes: e.codigo_cnes,
  nome_razao_social: e.esfera === 'ESTADUAL' ? 'TOCANTINS SECRETARIA DE ESTADO DA SAUDE' : 'PREFEITURA MUNICIPAL DE GURUPI',
  nome_fantasia: e.nome_fantasia,
  tipo_gestao: e.esfera === 'ESTADUAL' ? 'E' : 'M',
  descricao_esfera_administrativa: e.esfera,
  codigo_tipo_unidade: e.codigo_tipo_unidade,
  codigo_cep_estabelecimento: e.end[3],
  endereco_estabelecimento: e.end[0],
  numero_estabelecimento: e.end[1],
  bairro_estabelecimento: e.end[2],
  numero_telefone_estabelecimento: e.tel,
  latitude_estabelecimento_decimo_grau: e.lat,
  longitude_estabelecimento_decimo_grau: e.lon,
  endereco_email_estabelecimento: e.email,
  descricao_turno_atendimento: e.turno,
  estabelecimento_faz_atendimento_ambulatorial_sus: e.sus,
  codigo_uf: 17,
  codigo_municipio: 170950,
  descricao_natureza_juridica_estabelecimento: e.nat,
  codigo_motivo_desabilitacao_estabelecimento: e.motivo,
  data_atualizacao: '2026-09-15',
}));

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

function outcome(severity: 'error' | 'information', code: string, diagnostics: string, expression?: string) {
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity, code, diagnostics, ...(expression ? { expression: [expression] } : {}) }],
  };
}

function graphError(status: number, message: string, code = 100) {
  return new HttpError(status, { error: { message, type: 'OAuthException', code, fbtrace_id: randomBytes(6).toString('hex') } });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, { error: 'Corpo excede 5 MB' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text: string, onError: () => HttpError): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw onError();
  }
}

export function createMockServer(opts: MockServerOptions = {}): http.Server & { state: MockState } {
  const state: MockState = {
    tokens: new Map(),
    bundles: [],
    whatsapp: [],
    nfe: loadNfeFixtures(opts.fixturesDir ?? DEFAULT_FIXTURES_DIR),
    citizens: opts.citizens ?? MOCK_CITIZENS,
  };
  const ttl = opts.tokenTtlSeconds ?? 1800;

  const requireRndsAuth = (req: http.IncomingMessage): string => {
    const header = String(req.headers['x-authorization-server'] ?? '');
    const token = /^Bearer (.+)$/.exec(header)?.[1];
    const expiresAt = token ? state.tokens.get(token) : undefined;
    if (!expiresAt || expiresAt < Date.now()) throw new HttpError(401, outcome('error', 'login', 'Token de acesso ausente ou expirado'));
    // A RNDS exige o CNS do profissional em nome de quem a requisição é feita; o simulador também aceita CPF.
    const requester = onlyDigits(String(req.headers.authorization ?? ''));
    if (!isValidCns(requester) && !isValidCpf(requester)) throw new HttpError(403, outcome('error', 'forbidden', 'Cabeçalho Authorization deve conter o CNS (ou CPF) do solicitante'));
    return requester;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const json = (status: number, body: unknown, headers: Record<string, string> = {}, type = 'application/json') => {
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, ...headers }).end(JSON.stringify(body));
    };

    if (path === '/health' && method === 'GET') {
      return json(200, { status: 'ok', services: ['rnds', 'cadsus', 'sefaz', 'whatsapp', 'cnes', 'viacep'] });
    }

    // ViaCEP: consulta de endereço por CEP (dois CEPs conhecidos; os demais devolvem {"erro": true}).
    const cepMatch = path.match(/^\/ws\/(\d{8})\/json$/);
    if (cepMatch && method === 'GET') {
      const known: Record<string, object> = {
        '77405070': { cep: '77405-070', logradouro: 'Rua de 14 Novembro', complemento: 'de 1500/1501 ao fim', bairro: 'Setor Central', localidade: 'Gurupi', uf: 'TO', ibge: '1709500', ddd: '63' },
        '01001000': { cep: '01001-000', logradouro: 'Praça da Sé', complemento: 'lado ímpar', bairro: 'Sé', localidade: 'São Paulo', uf: 'SP', ibge: '3550308', ddd: '11' },
      };
      return json(200, known[cepMatch[1]!] ?? { erro: true });
    }

    // API de dados abertos do Ministério da Saúde: estabelecimentos do CNES por município (páginas de 20).
    if (path === '/cnes/estabelecimentos' && method === 'GET') {
      const municipio = url.searchParams.get('codigo_municipio');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 20);
      const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
      const all = municipio === '170950' ? CNES_ESTABELECIMENTOS : [];
      return json(200, { estabelecimentos: all.slice(offset, offset + limit) });
    }

    // RNDS: autenticação (o mTLS real é dispensado no simulador)
    if (path === '/rnds/auth/api/token' && (method === 'GET' || method === 'POST')) {
      const token = `mock-${randomBytes(16).toString('hex')}`;
      state.tokens.set(token, Date.now() + ttl * 1000);
      return json(200, { access_token: token, scope: 'read write', token_type: 'jwt', expires_in: ttl });
    }

    if (path === '/rnds/ehr/api/fhir/r4/Bundle' && method === 'POST') {
      const requesterCpf = requireRndsAuth(req);
      const body = parseJson(await readBody(req), () => new HttpError(400, outcome('error', 'structure', 'JSON inválido')));
      const result = validateRndsBundle(body);
      if (!result.valid) {
        return json(
          422,
          {
            resourceType: 'OperationOutcome',
            issue: result.issues.filter((i) => i.severity === 'error').map((i) => ({ severity: 'error', code: 'invalid', diagnostics: i.message, expression: [i.path] })),
          },
          {},
          'application/fhir+json',
        );
      }
      const id = randomUUID();
      state.bundles.push({ id, receivedAt: new Date().toISOString(), requesterCpf, bundle: body });
      return json(201, outcome('information', 'informational', 'Documento recebido'), { location: `/rnds/ehr/api/fhir/r4/Bundle/${id}` }, 'application/fhir+json');
    }

    const organization = /^\/rnds\/ehr\/api\/fhir\/r4\/Organization\/(\d{7})$/.exec(path);
    if (organization && method === 'GET') {
      requireRndsAuth(req);
      const cnes = organization[1]!;
      return json(
        200,
        {
          resourceType: 'Organization',
          id: cnes,
          meta: { profile: ['http://www.saude.gov.br/fhir/r4/StructureDefinition/BREstabelecimentoSaude-1.0'] },
          identifier: [{ system: 'http://rnds.saude.gov.br/fhir/r4/NamingSystem/cnes', value: cnes }],
          active: true,
          name: `ESTABELECIMENTO SIMULADO ${cnes}`,
        },
        {},
        'application/fhir+json',
      );
    }
    if (path === '/rnds/ehr/api/fhir/r4/Patient' && method === 'GET') {
      requireRndsAuth(req);
      const identifier = url.searchParams.get('identifier') ?? '';
      const [system, value] = identifier.split('|');
      if (!system || !value) throw new HttpError(400, outcome('error', 'required', 'Parâmetro identifier=<sistema>|<valor> obrigatório'));
      const digits = onlyDigits(value);
      const found = state.citizens.filter((c) => (system === NAMING_SYSTEMS.cpf ? c.cpf === digits : system === NAMING_SYSTEMS.cns ? c.cns.includes(digits) : false));
      return json(
        200,
        {
          resourceType: 'Bundle',
          type: 'searchset',
          total: found.length,
          entry: found.map((c) => {
            const id = c.cns[0]!;
            return { fullUrl: `${url.origin}/rnds/ehr/api/fhir/r4/Patient/${id}`, resource: citizenToPatient(c, id), search: { mode: 'match' } };
          }),
        },
        {},
        'application/fhir+json',
      );
    }

    if (path === '/rnds/_received') {
      if (method === 'GET') return json(200, state.bundles);
      if (method === 'DELETE') {
        state.bundles.length = 0;
        return json(200, { cleared: true });
      }
    }

    // SEFAZ: distribuição de NF-e destinadas ao CNPJ (simplificado em JSON; a real é SOAP + mTLS)
    if (path === '/sefaz/nfe' && method === 'GET') {
      const cnpj = onlyDigits(url.searchParams.get('cnpj') ?? '');
      if (cnpj.length !== 14) throw new HttpError(400, { error: 'Informe o CNPJ do destinatário (?cnpj=)' });
      const docs = state.nfe.filter((n) => n.destCnpj === cnpj);
      return json(200, {
        cnpj,
        total: docs.length,
        documentos: docs.map((n) => ({
          chave: n.chave,
          emitente: { cnpj: n.emitCnpj, nome: n.emitName },
          dataEmissao: n.issuedAt,
          valor: n.total,
          xml: n.xml,
        })),
      });
    }
    const nfeMatch = /^\/sefaz\/nfe\/(\d{44})$/.exec(path);
    if (nfeMatch && method === 'GET') {
      const doc = state.nfe.find((n) => n.chave === nfeMatch[1]);
      if (!doc) throw new HttpError(404, { error: 'NF-e não encontrada' });
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' }).end(doc.xml);
      return;
    }

    // WhatsApp Cloud API
    if (path === '/whatsapp/_sent') {
      if (method === 'GET') return json(200, state.whatsapp);
      if (method === 'DELETE') {
        state.whatsapp.length = 0;
        return json(200, { cleared: true });
      }
    }
    const waMatch = /^\/whatsapp\/(v\d+\.\d+)\/([^/]+)\/messages$/.exec(path);
    if (waMatch && method === 'POST') {
      if (!/^Bearer .+/.test(String(req.headers.authorization ?? ''))) throw graphError(401, 'Invalid OAuth access token.', 190);
      const body = parseJson(await readBody(req), () => graphError(400, 'Invalid JSON')) as Record<string, unknown>;
      if (body?.messaging_product !== 'whatsapp') throw graphError(400, '(#100) The parameter messaging_product is required.');
      const to = typeof body.to === 'string' ? onlyDigits(body.to) : '';
      if (!to) throw graphError(400, '(#100) The parameter to is required.');
      const id = `wamid.MOCK${randomBytes(12).toString('hex').toUpperCase()}`;
      state.whatsapp.push({
        id,
        receivedAt: new Date().toISOString(),
        apiVersion: waMatch[1]!,
        phoneNumberId: waMatch[2]!,
        to,
        type: String(body.type ?? 'text'),
        payload: body,
      });
      return json(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: to }], messages: [{ id }] });
    }

    throw new HttpError(404, { error: `Rota não encontrada: ${method} ${path}` });
  };

  const server = http.createServer((req, res) => {
    handle(req, res)
      .then(() => opts.log?.(`${req.method} ${req.url} -> ${res.statusCode}`))
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        const body = err instanceof HttpError ? err.body : { error: 'Erro interno no simulador' };
        if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
        opts.log?.(`${req.method} ${req.url} -> ${status}`);
      });
  });
  return Object.assign(server, { state });
}
