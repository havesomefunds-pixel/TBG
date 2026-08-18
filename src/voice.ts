import { prisma } from './database.js';
import { grantCappedXp } from './economy.js';
import type { Settings } from './default-settings.js';

export async function startVoice(guildId: string, userId: string, channelId: string, now = new Date()) {
  return prisma.voiceSession.upsert({ where: { guildId_userId: { guildId, userId } }, create: { guildId, userId, channelId, startedAt: now, lastAccruedAt: now }, update: { channelId, lastAccruedAt: now } });
}

export async function stopVoice(guildId: string, userId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.voiceSession.findUnique({ where: { guildId_userId: { guildId, userId } } });
    if (!session) return null;
    const seconds = Math.max(0, Math.floor((now.getTime() - session.lastAccruedAt.getTime()) / 1000));
    await tx.voiceSession.delete({ where: { id: session.id } });
    await tx.member.upsert({ where: { guildId_userId: { guildId, userId } }, create: { guildId, userId, voiceSeconds: BigInt(seconds) }, update: { voiceSeconds: { increment: BigInt(seconds) } } });
    return { seconds, sessionId: session.id, channelId: session.channelId };
  });
}

export async function awardVoiceXp(input: { guildId: string; userId: string; sessionId: string; seconds: number; settings: Settings; configVersion: number }) {
  const minutes = Math.floor(input.seconds / 60);
  if (minutes <= 0 || input.settings.xp.voicePerMinute <= 0) return null;
  return grantCappedXp({ guildId: input.guildId, userId: input.userId, requested: minutes * input.settings.xp.voicePerMinute, hourlyCap: input.settings.xp.maxPerHour, kind: 'XP_AWARD', reason: 'eligible voice session', idempotencyKey: `voice:${input.sessionId}`, configVersion: input.configVersion }, input.settings.progression);
}
