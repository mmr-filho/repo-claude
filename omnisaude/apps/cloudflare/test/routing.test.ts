import { describe, expect, it } from 'vitest';
import {
  apiPath,
  basePath,
  branchSuffix,
  configFingerprint,
  containerEnv,
  isInternalOnly,
  toContainerRequest,
  type OmniVars,
} from '../src/routing';

const vars: OmniVars = {
  PUBLIC_ORIGIN: 'https://mm.api.br/',
  BASE_PATH: '/omnisaude',
  PG_HOST: 'aws-sa-east-1-1.pg.psdb.cloud',
  PG_ADMIN_USER: 'postgres.nk35mx55qq',
  PG_ADMIN_PASSWORD: 'pscale_pw_admin',
  APP_DB_PASSWORD: 'senha-app',
  BI_DB_PASSWORD: 'senha-bi',
  JWT_SECRET: 'x'.repeat(48),
  DATA_KEY: Buffer.alloc(32, 1).toString('base64'),
  JOBS_SECRET: 'y'.repeat(32),
  PLATFORM_ADMIN_PASSWORD: 'Operacao2026segura',
};

describe('roteamento de mm.api.br/omnisaude', () => {
  it('separa API e Socket.IO das telas', () => {
    expect(apiPath('/omnisaude/api/auth/login', '/omnisaude')).toBe('/api/auth/login');
    expect(apiPath('/omnisaude/api', '/omnisaude')).toBe('/api');
    expect(apiPath('/omnisaude/socket.io/', '/omnisaude')).toBe('/socket.io/');
    expect(apiPath('/omnisaude/login/', '/omnisaude')).toBeNull();
    expect(apiPath('/omnisaude/apis', '/omnisaude')).toBeNull();
    expect(apiPath('/api/auth/login', '/omnisaude')).toBeNull();
    expect(apiPath('/api/health', '')).toBe('/api/health');
  });

  it('normaliza o caminho de publicação', () => {
    expect(basePath({ BASE_PATH: 'omnisaude/' })).toBe('/omnisaude');
    expect(basePath({ BASE_PATH: '' })).toBe('');
  });

  it('não expõe o disparo de jobs', () => {
    expect(isInternalOnly('/api/jobs/tick')).toBe(true);
    expect(isInternalOnly('/api/jobsx')).toBe(false);
    expect(isInternalOnly('/api/patients')).toBe(false);
  });

  it('repassa ao container sem o prefixo e com o IP real do cliente', async () => {
    const original = new Request('https://mm.api.br/omnisaude/api/auth/login?x=1', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ cpf: '1' }),
    });
    const forwarded = toContainerRequest(original, '/api/auth/login');
    expect(new URL(forwarded.url).pathname).toBe('/api/auth/login');
    expect(new URL(forwarded.url).search).toBe('?x=1');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(forwarded.headers.get('x-forwarded-proto')).toBe('https');
    expect(forwarded.headers.get('x-forwarded-host')).toBe('mm.api.br');
    expect(await forwarded.json()).toEqual({ cpf: '1' });
  });

  it('descarta X-Forwarded-For forjado sem o IP da Cloudflare', () => {
    const original = new Request('https://mm.api.br/omnisaude/api/x', { headers: { 'x-forwarded-for': '6.6.6.6' } });
    expect(toContainerRequest(original, '/api/x').headers.get('x-forwarded-for')).toBeNull();
  });
});

describe('variáveis da API no container', () => {
  it('monta as conexões do PlanetScale com o branch e a réplica', () => {
    const env = containerEnv(vars);
    expect(branchSuffix('postgres.nk35mx55qq|replica')).toBe('.nk35mx55qq');
    expect(env.TENANT_DB_USER).toBe('omni_app.nk35mx55qq');
    expect(env.TENANT_BI_USER).toBe('omni_bi_reader.nk35mx55qq|replica');
    expect(env.TENANT_ADMIN_USER).toBe('postgres.nk35mx55qq');
    expect(env.TENANT_DB_PORT).toBe('5432');
    const master = new URL(env.MASTER_DATABASE_URL!);
    expect(master.hostname).toBe('aws-sa-east-1-1.pg.psdb.cloud');
    expect(master.pathname).toBe('/master_auth_db');
    expect(decodeURIComponent(master.username)).toBe('omni_app.nk35mx55qq');
    expect(master.searchParams.get('sslmode')).toBe('require');
    expect(env.DB_SSL).toBe('true');
    expect(env.RUN_JOBS).toBe('false');
    expect(env.PUBLIC_API_URL).toBe('https://mm.api.br/omnisaude');
    expect(env.CORS_ORIGINS.split(',')[0]).toBe('https://mm.api.br');
  });

  it('sem réplica, o BI usa o primário', () => {
    expect(containerEnv({ ...vars, PG_USE_REPLICA: 'false' }).TENANT_BI_USER).toBe('omni_bi_reader.nk35mx55qq');
  });

  it('liga os simulados só na demonstração e repassa integrações configuradas', () => {
    expect(containerEnv(vars).MOCKS_URL).toBeUndefined();
    const demo = containerEnv({ ...vars, DEMO_MOCKS: 'true', SEED_DEMO: 'true', R2_BUCKET: 'omnisaude', ANTHROPIC_API_KEY: '' });
    expect(demo.MOCKS_URL).toBe('http://127.0.0.1:4010');
    expect(demo.SEED_DEMO).toBe('true');
    expect(demo.R2_BUCKET).toBe('omnisaude');
    expect('ANTHROPIC_API_KEY' in demo).toBe(false);
  });

  it('aponta o que falta configurar', () => {
    expect(() => containerEnv({ ...vars, JWT_SECRET: '', PG_HOST: '' })).toThrow(/PG_HOST, .*JWT_SECRET/);
    // Sem senha própria, a conta da plataforma ficaria com a senha pública da demonstração.
    expect(() => containerEnv({ ...vars, PLATFORM_ADMIN_PASSWORD: '' })).toThrow(/PLATFORM_ADMIN_PASSWORD/);
    expect(() => containerEnv({ ...vars, PLATFORM_ADMIN_PASSWORD: 'semnumerosaqui' })).toThrow(/letras e números/);
  });

  it('a impressão digital muda quando um segredo muda', async () => {
    const a = await configFingerprint(containerEnv(vars), ['sh']);
    expect(await configFingerprint({ ...containerEnv(vars) }, ['sh'])).toBe(a);
    expect(await configFingerprint(containerEnv({ ...vars, JWT_SECRET: 'z'.repeat(48) }), ['sh'])).not.toBe(a);
  });
});
