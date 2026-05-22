import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set.');
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: databaseUrl,
  },
  adapter: async () => new PrismaMariaDb(databaseUrl),
});
