import { defineConfig } from 'prisma/config';

// A URL só é usada pelos comandos do Prisma CLI (diff/studio); em produção as migrações
// são aplicadas pelo nosso executor (src/migrate.ts), em todos os bancos de tenant.
export default defineConfig({
  schema: 'prisma/master/schema.prisma',
  migrations: { path: 'prisma/master/migrations' },
  datasource: { url: process.env.MASTER_DATABASE_URL ?? 'postgresql://localhost:5432/master_auth_db' },
});
