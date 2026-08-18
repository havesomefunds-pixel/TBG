import { z } from 'zod';

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1), DISCORD_CLIENT_ID: z.string().min(1), TBG_GUILD_ID: z.string().regex(/^\d+$/),
  DATABASE_URL: z.string().url(), OWNER_ROLE_IDS: z.string().default('1458348294123159683'), ADMIN_ROLE_IDS: z.string().default('1458348294123159684'), MODERATOR_ROLE_IDS: z.string().default('1458348294123159684'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HEALTHCHECK_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DM_REPLY: z.string().max(500).default('This bot only operates in the TBG Discord server.')
});
export type AppConfig = z.infer<typeof envSchema> & { ownerRoleIds: Set<string>; adminRoleIds: Set<string>; moderatorRoleIds: Set<string> };
export function parseConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = envSchema.parse(env);
  const ids = (value: string) => new Set(value.split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)));
  return { ...raw, ownerRoleIds: ids(raw.OWNER_ROLE_IDS), adminRoleIds: ids(raw.ADMIN_ROLE_IDS), moderatorRoleIds: ids(raw.MODERATOR_ROLE_IDS) };
}
