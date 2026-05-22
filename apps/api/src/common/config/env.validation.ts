import { z } from 'zod';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
}

export const envSchema = z.object({
  NODE_ENV: z.enum(NodeEnv).default(NodeEnv.Development),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL must not be empty.')
    .refine((v) => v.startsWith('mysql://') || v.startsWith('mysqls://'), {
      message: 'DATABASE_URL must start with mysql:// or mysqls://.',
    }),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const formatted = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`Environment variable validation failed:\n${formatted}`);
  }

  return result.data;
}
