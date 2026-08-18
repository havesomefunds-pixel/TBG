import { Prisma, type LedgerKind } from '@prisma/client';
import { prisma } from './database.js';
import { levelForXp, type ProgressionConfig } from './progression.js';

export class EconomyError extends Error {}
export type Mutation = { guildId: string; userId: string; delta: number; kind: LedgerKind; reason: string; idempotencyKey: string; configVersion: number; targetUserId?: string; gameId?: string; metadata?: Prisma.InputJsonValue };
async function member(tx: Prisma.TransactionClient, guildId: string, userId: string) { return tx.member.upsert({ where: { guildId_userId: { guildId, userId } }, create: { guildId, userId }, update: {} }); }
export async function mutateBalance(m: Mutation, curve: ProgressionConfig) {
  return prisma.$transaction(async (tx) => {
    const prior = await tx.ledger.findUnique({ where: { idempotencyKey: m.idempotencyKey } });
    if (prior) return prior;
    const actor = await member(tx, m.guildId, m.userId);
    if (actor.frozenUntil && actor.frozenUntil > new Date()) throw new EconomyError('Account is frozen');
    const next = actor.xp + m.delta; if (next < 0) throw new EconomyError('Insufficient XP');
    const nextLevel = levelForXp(next, curve);
    const updated = await tx.member.update({ where: { id: actor.id }, data: { xp: next, lifetimeXp: m.delta > 0 ? { increment: m.delta } : undefined, level: nextLevel } });
    const target = m.targetUserId ? await member(tx, m.guildId, m.targetUserId) : undefined;
    return tx.ledger.create({ data: { guildId: m.guildId, actorId: actor.id, targetId: target?.id, kind: m.kind, amount: m.delta, balanceAfter: updated.xp, reason: m.reason, gameId: m.gameId, idempotencyKey: m.idempotencyKey, configVersion: m.configVersion, metadata: m.metadata } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
export async function transfer(guildId: string, senderId: string, recipientId: string, amount: number, idempotencyKey: string, configVersion: number, curve: ProgressionConfig) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || senderId === recipientId) throw new EconomyError('Invalid transfer');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ledger.findUnique({ where: { idempotencyKey } }); if (existing) return existing;
    const [sender, recipient] = await Promise.all([member(tx, guildId, senderId), member(tx, guildId, recipientId)]);
    if (sender.xp < amount) throw new EconomyError('Insufficient XP');
    const senderUpdated = await tx.member.update({ where: { id: sender.id }, data: { xp: { decrement: amount }, level: levelForXp(sender.xp - amount, curve) } });
    await tx.member.update({ where: { id: recipient.id }, data: { xp: { increment: amount }, lifetimeXp: { increment: amount }, level: levelForXp(recipient.xp + amount, curve) } });
    return tx.ledger.create({ data: { guildId, actorId: sender.id, targetId: recipient.id, kind: 'TRANSFER', amount: -amount, balanceAfter: senderUpdated.xp, reason: 'player transfer', idempotencyKey, configVersion } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
export async function settleWager(guildId: string, userId: string, wager: number, payout: number, gameId: string, key: string, configVersion: number, curve: ProgressionConfig) {
  if (wager <= 0 || payout < 0) throw new EconomyError('Invalid wager');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ledger.findUnique({ where: { idempotencyKey: `${key}:debit` } }); if (existing) return existing;
    const m = await member(tx, guildId, userId); if (m.xp < wager) throw new EconomyError('Insufficient XP');
    const after = m.xp - wager + payout;
    const changed = await tx.member.update({ where: { id: m.id }, data: { xp: after, lifetimeXp: payout > 0 ? { increment: payout } : undefined, level: levelForXp(after, curve) } });
    await tx.ledger.create({ data: { guildId, actorId: m.id, kind: 'XP_DEBIT', amount: -wager, balanceAfter: m.xp - wager, reason: 'game wager', gameId, idempotencyKey: `${key}:debit`, configVersion } });
    return tx.ledger.create({ data: { guildId, actorId: m.id, kind: 'PAYOUT', amount: payout, balanceAfter: changed.xp, reason: 'game settlement', gameId, idempotencyKey: `${key}:payout`, configVersion } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
export async function prestige(guildId: string, userId: string, key: string, configVersion: number, curve: ProgressionConfig) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ledger.findUnique({ where: { idempotencyKey: key } }); if (existing) return existing;
    const m = await member(tx, guildId, userId); if (m.level < 50 || m.prestige >= curve.prestigeCap) throw new EconomyError('Prestige requirements not met');
    const updated = await tx.member.update({ where: { id: m.id }, data: { xp: curve.prestigeBaseline, level: levelForXp(curve.prestigeBaseline, curve), prestige: { increment: 1 } } });
    return tx.ledger.create({ data: { guildId, actorId: m.id, kind: 'PRESTIGE', amount: curve.prestigeBaseline - m.xp, balanceAfter: updated.xp, reason: 'prestige reset', idempotencyKey: key, configVersion } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
