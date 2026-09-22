import { z } from 'zod';
const EnvSchema = z.object({
  COOKIE_SECRET: z.string().min(32),
  LOG_FORMAT: z.string().default('combined'),
  PUBLIC_DIR: z.string().default('public'),
});
export const env = EnvSchema.parse(process.env);
