import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  adapter: async () => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set.');
    }
    return new PrismaMariaDb(url);
  },
});
