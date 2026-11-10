import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations, type SchemaKind } from '../src/migrate';

/**
 * Migração publicada é imutável: o branch de produção publica a cada commit e a API aplica as migrações na partida,
 * gravando o SHA-256 de cada uma. Se o arquivo muda depois, a partida para com "A migração X foi alterada depois de
 * aplicada" (foi o que derrubou a publicação com a 0029). prisma/migracoes-publicadas.json guarda o SHA-256 de cada
 * migração já publicada: mudança vai numa migração nova. Ao publicar uma migração, inclua-a no arquivo no mesmo commit.
 */
const publicadas = JSON.parse(readFileSync(join(__dirname, '..', 'prisma', 'migracoes-publicadas.json'), 'utf8')) as Record<SchemaKind, Record<string, string>>;

describe.each(['master', 'tenant'] as const)('migrações publicadas (%s)', (kind) => {
  const atuais = loadMigrations(kind);
  const travadas = Object.entries(publicadas[kind]);

  it('nenhuma migração publicada mudou de conteúdo nem sumiu', () => {
    const porNome = new Map(atuais.map((m) => [m.name, m.checksum]));
    for (const [nome, checksum] of travadas) expect({ nome, checksum: porNome.get(nome) ?? 'arquivo removido' }).toEqual({ nome, checksum });
  });

  it('migração nova entra depois da última publicada (a ordem de aplicação é a mesma em todo banco)', () => {
    const ultima =
      travadas
        .map(([nome]) => nome)
        .sort()
        .at(-1) ?? '';
    const novasNoMeio = atuais.filter((m) => m.name < ultima && !(m.name in publicadas[kind])).map((m) => m.name);
    expect(novasNoMeio).toEqual([]);
  });
});
