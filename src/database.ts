import { PrismaClient } from '@prisma/client';
import { DEFAULT_SETTINGS, type Settings } from './default-settings.js';

export const prisma = new PrismaClient();
export async function ensureGuildConfig(guildId: string) {
  return prisma.guildConfig.upsert({ where: { guildId }, create: { guildId, settings: DEFAULT_SETTINGS }, update: {} });
}
export async function guildSettings(guildId: string): Promise<{ version: number; settings: Settings; maintenance: boolean }> {
  const config = await ensureGuildConfig(guildId);
  return { version: config.version, maintenance: config.maintenance, settings: { ...DEFAULT_SETTINGS, ...(config.settings as Partial<Settings>) } };
}
export async function updateSettings(guildId: string, settings: Settings, actorUserId: string) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.guildConfig.findUniqueOrThrow({ where: { guildId } });
    const result = await tx.guildConfig.update({ where: { guildId }, data: { settings, version: { increment: 1 } } });
    await tx.auditLog.create({ data: { guildId, actorUserId, action: 'SETTINGS_UPDATED', detail: { before: before.settings, after: settings } } });
    return result;
  });
}
