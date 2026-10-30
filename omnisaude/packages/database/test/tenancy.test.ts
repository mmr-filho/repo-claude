import { describe, expect, it } from 'vitest';
import { connectionUrl, envCredentials, roleName } from '@omnisaude/database';

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
