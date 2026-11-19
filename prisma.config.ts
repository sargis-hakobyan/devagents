import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'infra/postgres/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
