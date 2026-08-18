import { PrismaClient } from '@prisma/client';
import { DEFAULT_SETTINGS, defaultSettings, type Settings } from './default-settings.js';

export const prisma = new PrismaClient();
export async function ensureGuildConfig(guildId: string) {
  return prisma.guildConfig.upsert({ where: { guildId }, create: { guildId, settings: defaultSettings() }, update: {} });
}
export async function guildSettings(guildId: string): Promise<{ version: number; settings: Settings; maintenance: boolean }> {
  const config = await ensureGuildConfig(guildId);
  // Settings are versioned JSON. Merge nested groups as well so adding a safe
  // default (for example a new game setting) does not break an existing guild
  // configuration that predates that field.
  const saved = config.settings as Partial<Settings>;
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    progression: { ...DEFAULT_SETTINGS.progression, ...saved.progression },
    xp: { ...DEFAULT_SETTINGS.xp, ...saved.xp },
    games: { ...DEFAULT_SETTINGS.games, ...saved.games },
    enabled: { ...DEFAULT_SETTINGS.enabled, ...saved.enabled },
    allowedChannels: saved.allowedChannels ?? DEFAULT_SETTINGS.allowedChannels,
    roles: { ...DEFAULT_SETTINGS.roles, ...saved.roles }
  };
  return { version: config.version, maintenance: config.maintenance, settings };
}
export async function updateSettings(guildId: string, settings: Settings, actorUserId: string) {
  await ensureGuildConfig(guildId);
  return prisma.$transaction(async (tx) => {
    const before = await tx.guildConfig.findUniqueOrThrow({ where: { guildId } });
    const result = await tx.guildConfig.update({ where: { guildId }, data: { settings, version: { increment: 1 } } });
    await tx.auditLog.create({ data: { guildId, actorUserId, action: 'SETTINGS_UPDATED', detail: { before: before.settings, after: settings } } });
    return result;
  });
}
