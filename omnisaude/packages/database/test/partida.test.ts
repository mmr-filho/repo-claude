import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { lerFalhaDePartida, mensagemDaFalha, redigirSegredos, registrarFalhaDePartida, servirFalhaDePartida } from '../src/partida';

const env = {
  MASTER_DATABASE_URL: 'postgresql://omni_app.br4nch:segredoDoApp99@aws-sa-east-1-1.pg.psdb.cloud:5432/master_auth_db?sslmode=require',
  TENANT_DB_HOST: 'aws-sa-east-1-1.pg.psdb.cloud',
  TENANT_DB_USER: 'omni_app.br4nch',
  TENANT_DB_PASSWORD: 'segredoDoApp99',
  TENANT_ADMIN_USER: 'postgres.br4nch',
  TENANT_ADMIN_PASSWORD: 'senhaDoAdmin42',
  TENANT_BI_USER: 'omni_bi_reader.br4nch|replica',
  TENANT_BI_PASSWORD: 'senhaDoBi77',
  JWT_SECRET: 'j'.repeat(48),
  DATA_KEY: 'q83vEjRWeJASNFZ4kBI0VniQEjRWeJASNFZ4kBI0Vng=',
} as NodeJS.ProcessEnv;

const pasta = mkdtempSync(join(tmpdir(), 'omni-partida-'));
afterAll(() => rmSync(pasta, { recursive: true, force: true }));

describe('diagnóstico da partida do container', () => {
  it('tira credenciais de URL, segredos, endereço e usuários do banco da mensagem', () => {
    const texto = [
      `password authentication failed for user "omni_app.br4nch"`,
      `connect to postgresql://postgres.br4nch:senhaDoAdmin42@aws-sa-east-1-1.pg.psdb.cloud:5432/postgres`,
      `getaddrinfo ENOTFOUND aws-sa-east-1-1.pg.psdb.cloud`,
      `bi omni_bi_reader.br4nch|replica senha senhaDoBi77 chave ${env.DATA_KEY} jwt ${env.JWT_SECRET}`,
    ].join(' | ');
    const r = redigirSegredos(texto, env);
    for (const segredo of ['senhaDoAdmin42', 'senhaDoBi77', 'segredoDoApp99', env.DATA_KEY!, env.JWT_SECRET!, 'psdb.cloud', 'br4nch']) expect(r).not.toContain(segredo);
    expect(r).toContain('user "<usuário da aplicação>"');
    expect(r).toContain('ENOTFOUND <PG_HOST>');
    expect(r).toContain('postgresql://***@<PG_HOST>:5432/postgres');
    expect(r).toContain('bi <usuário do BI> senha ***');
  });

  it('grava a etapa, o motivo sem segredo e o código do erro, e lê de volta', () => {
    const arquivo = join(pasta, 'falha.json');
    const erro = Object.assign(new Error('password authentication failed for user "postgres.br4nch"'), { code: '28P01' });
    const falha = registrarFalhaDePartida('papéis e banco master (conexão com PG_ADMIN_USER)', erro, arquivo, env);
    expect(falha).toMatchObject({ etapa: 'papéis e banco master (conexão com PG_ADMIN_USER)', mensagem: 'password authentication failed for user "<PG_ADMIN_USER>"', codigo: '28P01' });
    expect(readFileSync(arquivo, 'utf8')).not.toContain('br4nch');
    expect(lerFalhaDePartida(arquivo)).toEqual(falha);
    expect(lerFalhaDePartida(join(pasta, 'nao-existe.json'))).toBeNull();
    // Configuração inválida da API: a mensagem do zod chega inteira (não tem segredo).
    const api = registrarFalhaDePartida('API', new Error('Configuração inválida:\nDATA_KEY: DATA_KEY deve ser 32 bytes em base64'), arquivo, env);
    expect(api.mensagem).toBe('Configuração inválida: DATA_KEY: DATA_KEY deve ser 32 bytes em base64');
    expect(api.codigo).toBeUndefined();
    expect(mensagemDaFalha(api)).toContain('etapa "API"');
    expect(mensagemDaFalha(null)).toContain('log do container');
  });

  it('responde 503 com o motivo em qualquer rota e sai depois do tempo combinado', async () => {
    const falha = { etapa: 'API', mensagem: 'Configuração inválida: JWT_SECRET: JWT_SECRET deve ter pelo menos 32 caracteres', em: '2026-11-10T00:00:00.000Z' };
    let saiu = false;
    const server = servirFalhaDePartida({ porta: 0, falha, duracaoMs: 300, sair: () => (saiu = true) });
    await new Promise((r) => server.once('listening', r));
    const porta = (server.address() as AddressInfo).port;
    for (const rota of ['/api/health', '/api/auth/login']) {
      const res = await fetch(`http://127.0.0.1:${porta}${rota}`, { method: rota.endsWith('login') ? 'POST' : 'GET' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('60');
      const corpo = (await res.json()) as { code: string; message: string; etapa: string };
      expect(corpo.code).toBe('PARTIDA_FALHOU');
      expect(corpo.etapa).toBe('API');
      expect(corpo.message).toContain('JWT_SECRET deve ter pelo menos 32 caracteres');
    }
    await new Promise((r) => setTimeout(r, 600));
    expect(saiu).toBe(true);
    expect(server.listening).toBe(false);
  });
});
