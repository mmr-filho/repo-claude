import { describe, expect, it } from 'vitest';
import { connectionUrl, envCredentials, roleName, TenantConnectionManager, type MasterClient } from '@omnisaude/database';

/**
 * Catálogo do mestre falso: cada leitura tira o retrato da configuração gravada (`noBanco`) e, quando `segurar` está
 * ligado, só devolve depois de `soltar()`, para intercalar a leitura com um salvamento e a invalidação.
 */
function mestreFalso() {
  const ID = '00000000-0000-0000-0000-000000000001';
  const estado = { noBanco: '14:00', segurar: false, leituras: 0, soltar: () => {} };
  const mestre = {
    tenant: {
      findUnique: async () => {
        estado.leituras++;
        const retrato = {
          id: ID,
          slug: 'cache-teste',
          name: 'Instituição de teste',
          status: 'ATIVO',
          timeZone: 'America/Sao_Paulo',
          settings: { vigilancia: { negativa: { prazoHora: estado.noBanco } } },
          database: { dbName: 'x', primaryHost: 'h', primaryPort: 1, replicaHost: null, replicaPort: null, credentialsRef: 'default' },
        };
        if (estado.segurar) {
          estado.segurar = false;
          await new Promise<void>((r) => (estado.soltar = r));
        }
        return retrato;
      },
    },
  } as unknown as MasterClient;
  return { ID, estado, gerenciador: new TenantConnectionManager(mestre, { credentials: () => ({ user: 'u', password: 'p' }) }) };
}

describe('cache do catálogo: a leitura que atravessa a invalidação (N13)', () => {
  const prazo = (i: { settings: { vigilancia: { negativa: { prazoHora: string } } } }) => i.settings.vigilancia.negativa.prazoHora;

  it('a leitura que começou antes do salvamento devolve o que leu, mas não regrava o cache com a configuração velha', async () => {
    const { ID, estado, gerenciador: m } = mestreFalso();
    estado.segurar = true;
    const lenta = m.resolve('cache-teste');
    // O salvamento grava 18:00 e invalida as duas chaves enquanto a leitura (com 14:00) não terminou.
    estado.noBanco = '18:00';
    m.invalidate('cache-teste');
    m.invalidate(ID);
    estado.soltar();
    expect(prazo(await lenta)).toBe('14:00');
    // A próxima leitura vai ao banco: o cache não ficou com 14:00 por 60 s.
    expect(prazo(await m.resolve('cache-teste'))).toBe('18:00');
    expect(estado.leituras).toBe(2);
    // Sem invalidação no meio, o cache vale para as duas chaves (nenhuma leitura a mais).
    expect(prazo(await m.resolve(ID))).toBe('18:00');
    expect(prazo(await m.resolve('cache-teste'))).toBe('18:00');
    expect(estado.leituras).toBe(2);
  });

  it('invalidar só a outra chave, ou o catálogo inteiro, durante a leitura também impede o cache', async () => {
    for (const invalidar of [(m: TenantConnectionManager, id: string) => m.invalidate(id), (m: TenantConnectionManager) => m.invalidate()]) {
      const { ID, estado, gerenciador: m } = mestreFalso();
      estado.segurar = true;
      // Lê pelo slug; o salvamento invalida só o id (ou tudo).
      const lenta = m.resolve('cache-teste');
      estado.noBanco = '18:00';
      invalidar(m, ID);
      estado.soltar();
      expect(prazo(await lenta)).toBe('14:00');
      expect(prazo(await m.resolve(ID))).toBe('18:00');
      expect(prazo(await m.resolve('cache-teste'))).toBe('18:00');
      expect(estado.leituras).toBe(2);
    }
  });

  it('a invalidação feita antes da leitura não impede o cache da leitura seguinte', async () => {
    const { estado, gerenciador: m } = mestreFalso();
    m.invalidate('cache-teste');
    m.invalidate();
    expect(prazo(await m.resolve('cache-teste'))).toBe('14:00');
    estado.noBanco = '18:00';
    // Ainda no cache (o TTL de 60 s vale para a leitura que não atravessou invalidação).
    expect(prazo(await m.resolve('cache-teste'))).toBe('14:00');
    expect(estado.leituras).toBe(1);
  });
});

describe('conexões com bancos gerenciados', () => {
  it('extrai o papel do usuário de conexão do PlanetScale', () => {
    expect(roleName('omni_app')).toBe('omni_app');
    expect(roleName('omni_app.nk35mx55qq')).toBe('omni_app');
    expect(roleName('omni_bi_reader.nk35mx55qq|replica')).toBe('omni_bi_reader');
    expect(roleName('omni_bi_reader|replica')).toBe('omni_bi_reader');
  });

  it('mantém o usuário completo (com branch e réplica) na URL de conexão', () => {
    const url = new URL(connectionUrl('db.exemplo', 5432, 'tenant_db_demo', { user: 'omni_bi_reader.nk35|replica', password: 'p@ss/1' }, true));
    expect(decodeURIComponent(url.username)).toBe('omni_bi_reader.nk35|replica');
    expect(decodeURIComponent(url.password)).toBe('p@ss/1');
    expect(url.searchParams.get('sslmode')).toBe('require');
  });

  it('resolve credenciais por finalidade', () => {
    const creds = envCredentials({ TENANT_DB_USER: 'a', TENANT_DB_PASSWORD: '1', TENANT_BI_USER: 'b', TENANT_BI_PASSWORD: '2' });
    expect(creds('default', 'oltp')).toEqual({ user: 'a', password: '1' });
    expect(creds('default', 'readonly')).toEqual({ user: 'b', password: '2' });
    expect(() => creds('default', 'admin')).toThrow();
  });
});
