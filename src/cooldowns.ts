import { prisma } from './database.js';
export async function claimCooldown(guildId: string, userId: string, key: string, durationMs: number): Promise<boolean> {
  const now = new Date(); const expiresAt = new Date(now.getTime() + durationMs);
  return prisma.$transaction(async (tx) => {
    const current = await tx.cooldown.findUnique({ where: { guildId_userId_key: { guildId, userId, key } } });
    if (current && current.expiresAt > now) return false;
    await tx.cooldown.upsert({ where: { guildId_userId_key: { guildId, userId, key } }, create: { guildId, userId, key, expiresAt }, update: { expiresAt } });
    return true;
  });
}
