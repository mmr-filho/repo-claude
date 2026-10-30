import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/tenant/schema.prisma',
  migrations: { path: 'prisma/tenant/migrations' },
  datasource: { url: process.env.TENANT_DATABASE_URL ?? 'postgresql://localhost:5432/tenant_db_dev' },
});
