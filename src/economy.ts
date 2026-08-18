import { Prisma, type GameStatus, type LedgerKind } from '@prisma/client';
import { prisma } from './database.js';
import { levelForXp, type ProgressionConfig } from './progression.js';

export class EconomyError extends Error {}
export type Mutation = { guildId: string; userId: string; delta: number; kind: LedgerKind; reason: string; idempotencyKey: string; configVersion: number; targetUserId?: string; gameId?: string; metadata?: Prisma.InputJsonValue };
type Tx = Prisma.TransactionClient;

async function member(tx: Tx, guildId: string, userId: string) {
  return tx.member.upsert({ where: { guildId_userId: { guildId, userId } }, create: { guildId, userId }, update: {} });
}

async function applyAutoPrestige(tx: Tx, actor: { id: string; guildId: string; userId: string; level: number; xp: number; prestige: number; autoPrestige: boolean }, awardKey: string, configVersion: number, curve: ProgressionConfig) {
  const requiredLevel = curve.thresholds.length - 1;
  if (!actor.autoPrestige || actor.level < requiredLevel || actor.prestige >= curve.prestigeCap) return;
  const key = `auto-prestige:${awardKey}`;
  if (await tx.ledger.findUnique({ where: { idempotencyKey: key } })) return;
  const updated = await tx.member.update({ where: { id: actor.id }, data: { xp: curve.prestigeBaseline, level: levelForXp(curve.prestigeBaseline, curve), prestige: { increment: 1 } } });
  await tx.ledger.create({ data: { guildId: actor.guildId, actorId: actor.id, kind: 'PRESTIGE', amount: curve.prestigeBaseline - actor.xp, balanceAfter: updated.xp, reason: 'automatic prestige reset', idempotencyKey: key, configVersion } });
}

export async function mutateBalance(m: Mutation, curve: ProgressionConfig) {
  return prisma.$transaction(async (tx) => {
    const prior = await tx.ledger.findUnique({ where: { idempotencyKey: m.idempotencyKey } });
    if (prior) return prior;
    const actor = await member(tx, m.guildId, m.userId);
    if (actor.frozenUntil && actor.frozenUntil > new Date()) throw new EconomyError('Account is frozen');
    const next = actor.xp + m.delta;
    if (next < 0) throw new EconomyError('Insufficient XP');
    const updated = await tx.member.update({ where: { id: actor.id }, data: { xp: next, lifetimeXp: m.delta > 0 ? { increment: m.delta } : undefined, level: levelForXp(next, curve) } });
    const target = m.targetUserId ? await member(tx, m.guildId, m.targetUserId) : undefined;
    const ledger = await tx.ledger.create({ data: { guildId: m.guildId, actorId: actor.id, targetId: target?.id, kind: m.kind, amount: m.delta, balanceAfter: updated.xp, reason: m.reason, gameId: m.gameId, idempotencyKey: m.idempotencyKey, configVersion: m.configVersion, metadata: m.metadata } });
    if (m.delta > 0) await applyAutoPrestige(tx, updated, m.idempotencyKey, m.configVersion, curve);
    return ledger;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function grantCappedXp(m: Omit<Mutation, 'delta'> & { requested: number; hourlyCap: number }, curve: ProgressionConfig) {
  if (!Number.isSafeInteger(m.requested) || m.requested <= 0) throw new EconomyError('Invalid XP award');
  return prisma.$transaction(async (tx) => {
    const prior = await tx.ledger.findUnique({ where: { idempotencyKey: m.idempotencyKey } });
    if (prior) return prior;
    const actor = await member(tx, m.guildId, m.userId);
    const since = new Date(Date.now() - 3_600_000);
    const aggregate = await tx.ledger.aggregate({ where: { guildId: m.guildId, actorId: actor.id, kind: 'XP_AWARD', createdAt: { gte: since } }, _sum: { amount: true } });
    const delta = Math.min(m.requested, Math.max(0, m.hourlyCap - (aggregate._sum.amount ?? 0)));
    if (delta === 0) return null;
    if (actor.frozenUntil && actor.frozenUntil > new Date()) return null;
    const next = actor.xp + delta;
    const updated = await tx.member.update({ where: { id: actor.id }, data: { xp: next, lifetimeXp: { increment: delta }, level: levelForXp(next, curve) } });
    const ledger = await tx.ledger.create({ data: { guildId: m.guildId, actorId: actor.id, kind: 'XP_AWARD', amount: delta, balanceAfter: updated.xp, reason: m.reason, gameId: m.gameId, idempotencyKey: m.idempotencyKey, configVersion: m.configVersion, metadata: m.metadata } });
    await applyAutoPrestige(tx, updated, m.idempotencyKey, m.configVersion, curve);
    return ledger;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Admin XP grants intentionally use the same ledgered, guild-scoped award path. */
export async function grantAdminXp(input: Omit<Mutation, 'delta'> & { requested: number }, curve: ProgressionConfig) {
  return grantCappedXp({ ...input, hourlyCap: Number.MAX_SAFE_INTEGER }, curve);
}

export async function transfer(guildId: string, senderId: string, recipientId: string, amount: number, idempotencyKey: string, configVersion: number, curve: ProgressionConfig) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || senderId === recipientId) throw new EconomyError('Invalid transfer');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ledger.findUnique({ where: { idempotencyKey } }); if (existing) return existing;
    const [sender, recipient] = await Promise.all([member(tx, guildId, senderId), member(tx, guildId, recipientId)]);
    if (sender.xp < amount) throw new EconomyError('Insufficient XP');
    const senderUpdated = await tx.member.update({ where: { id: sender.id }, data: { xp: { decrement: amount }, level: levelForXp(sender.xp - amount, curve) } });
    const recipientUpdated = await tx.member.update({ where: { id: recipient.id }, data: { xp: { increment: amount }, lifetimeXp: { increment: amount }, level: levelForXp(recipient.xp + amount, curve) } });
    await applyAutoPrestige(tx, recipientUpdated, idempotencyKey, configVersion, curve);
    return tx.ledger.create({ data: { guildId, actorId: sender.id, targetId: recipient.id, kind: 'TRANSFER', amount: -amount, balanceAfter: senderUpdated.xp, reason: 'player transfer', idempotencyKey, configVersion } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export type RobberyResult = { success: boolean; amount: number; robberBalance: number; targetBalance: number; gameId: string };

/**
 * Resolve a robbery exactly once. A Game row is used as the durable settlement
 * guard and both balance changes and ledger rows commit in one serializable
 * transaction, so a retry cannot duplicate a transfer or push a balance below
 * zero.
 */
export async function resolveRobbery(input: {
  guildId: string;
  robberUserId: string;
  targetUserId: string;
  success: boolean;
  minTransfer: number;
  maxTransfer: number;
  failurePenalty: number;
  idempotencyKey: string;
  configVersion: number;
  curve: ProgressionConfig;
}) : Promise<RobberyResult> {
  if (input.robberUserId === input.targetUserId) throw new EconomyError('You cannot rob yourself');
  if (![input.minTransfer, input.maxTransfer, input.failurePenalty].every((amount) => Number.isSafeInteger(amount) && amount > 0) || input.minTransfer > input.maxTransfer) throw new EconomyError('Invalid robbery settings');

  await prisma.game.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: {
      guildId: input.guildId,
      type: 'rob',
      actorUserId: input.robberUserId,
      targetUserId: input.targetUserId,
      state: { pending: true },
      idempotencyKey: input.idempotencyKey
    },
    update: {}
  });

  return prisma.$transaction(async (tx) => {
    const game = await tx.game.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
    const completed = jsonRobbery(game.state);
    if (game.status !== 'PENDING') {
      if (!completed) throw new EconomyError('Robbery is already being settled');
      return { ...completed, gameId: game.id };
    }
    const claimed = await tx.game.updateMany({ where: { id: game.id, status: 'PENDING' }, data: { status: 'ACTIVE' } });
    if (claimed.count !== 1) throw new EconomyError('Robbery is already being settled');

    const robber = await member(tx, input.guildId, input.robberUserId);
    const target = await member(tx, input.guildId, input.targetUserId);
    if (robber.frozenUntil && robber.frozenUntil > new Date()) throw new EconomyError('Account is frozen');
    let success = input.success;
    let amount: number;
    let debit = robber;
    let credit = target;
    if (success) {
      if (target.xp <= 0) {
        success = false;
        amount = input.failurePenalty;
        debit = robber;
        credit = target;
      } else {
        amount = Math.min(input.maxTransfer, Math.max(1, Math.min(target.xp, input.minTransfer)));
        debit = target;
        credit = robber;
      }
    } else {
      amount = input.failurePenalty;
    }
    if (debit.xp < amount) throw new EconomyError(success ? 'Target has insufficient XP' : 'Insufficient XP to pay the robbery penalty');

    const debited = await tx.member.update({ where: { id: debit.id }, data: { xp: { decrement: amount }, level: levelForXp(debit.xp - amount, input.curve) } });
    const credited = await tx.member.update({ where: { id: credit.id }, data: { xp: { increment: amount }, lifetimeXp: { increment: amount }, level: levelForXp(credit.xp + amount, input.curve) } });
    await applyAutoPrestige(tx, credited, `rob-credit:${game.id}`, input.configVersion, input.curve);
    const robberAfter = debit.id === robber.id ? debited.xp : credited.xp;
    const targetAfter = debit.id === target.id ? debited.xp : credited.xp;
    const state = { success, amount, robberBalance: robberAfter, targetBalance: targetAfter };
    await tx.ledger.create({ data: { guildId: input.guildId, actorId: debit.id, targetId: credit.id, kind: 'TRANSFER', amount: -amount, balanceAfter: debited.xp, reason: success ? 'robbery loss' : 'robbery penalty', gameId: game.id, idempotencyKey: `rob-debit:${game.id}`, configVersion: input.configVersion, metadata: state } });
    await tx.ledger.create({ data: { guildId: input.guildId, actorId: credit.id, targetId: debit.id, kind: 'TRANSFER', amount, balanceAfter: credited.xp, reason: success ? 'robbery success' : 'robbery penalty received', gameId: game.id, idempotencyKey: `rob-credit:${game.id}`, configVersion: input.configVersion, metadata: state } });
    await tx.game.update({ where: { id: game.id }, data: { status: success ? 'WON' : 'LOST', state } });
    return { ...state, gameId: game.id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function jsonRobbery(value: Prisma.JsonValue): Omit<RobberyResult, 'gameId'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.success === 'boolean' && typeof candidate.amount === 'number' && typeof candidate.robberBalance === 'number' && typeof candidate.targetBalance === 'number'
    ? { success: candidate.success, amount: candidate.amount, robberBalance: candidate.robberBalance, targetBalance: candidate.targetBalance }
    : null;
}

export async function resolveDuel(input: { gameId: string; winnerUserId: string; reward: number; configVersion: number; curve: ProgressionConfig }) {
  if (!Number.isSafeInteger(input.reward) || input.reward <= 0) throw new EconomyError('Invalid duel reward');
  return prisma.$transaction(async (tx) => {
    const game = await tx.game.findUniqueOrThrow({ where: { id: input.gameId } });
    if (game.type !== 'duel' || !game.targetUserId || ![game.actorUserId, game.targetUserId].includes(input.winnerUserId)) throw new EconomyError('Invalid duel');
    if (game.status !== 'PENDING') return game;
    if (game.expiresAt && game.expiresAt <= new Date()) return tx.game.update({ where: { id: game.id }, data: { status: 'EXPIRED', state: { expired: true } } });
    const winner = await member(tx, game.guildId, input.winnerUserId);
    const updated = await tx.member.update({ where: { id: winner.id }, data: { xp: { increment: input.reward }, lifetimeXp: { increment: input.reward }, level: levelForXp(winner.xp + input.reward, input.curve) } });
    await tx.ledger.create({ data: { guildId: game.guildId, actorId: winner.id, kind: 'XP_AWARD', amount: input.reward, balanceAfter: updated.xp, reason: 'duel victory reward', gameId: game.id, idempotencyKey: `duel-reward:${game.id}`, configVersion: input.configVersion } });
    await applyAutoPrestige(tx, updated, `duel-reward:${game.id}`, input.configVersion, input.curve);
    return tx.game.update({ where: { id: game.id }, data: { status: 'WON', state: { winnerUserId: input.winnerUserId, reward: input.reward, balanceAfter: updated.xp } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export type OpenGame = { guildId: string; type: string; actorUserId: string; wager: number; state: Prisma.InputJsonValue; idempotencyKey: string; configVersion: number; curve: ProgressionConfig; expiresAt: Date; fairness?: Prisma.InputJsonValue };
export async function openEscrowGame(input: OpenGame) {
  if (!Number.isSafeInteger(input.wager) || input.wager <= 0) throw new EconomyError('Invalid wager');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.game.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;
    const active = await tx.game.findFirst({ where: { guildId: input.guildId, actorUserId: input.actorUserId, type: input.type, status: { in: ['PENDING', 'ACTIVE'] } } });
    if (active) throw new EconomyError(`You already have an active ${input.type} game`);
    const actor = await member(tx, input.guildId, input.actorUserId);
    if (actor.frozenUntil && actor.frozenUntil > new Date()) throw new EconomyError('Account is frozen');
    if (actor.xp < input.wager) throw new EconomyError('Insufficient XP');
    const updated = await tx.member.update({ where: { id: actor.id }, data: { xp: { decrement: input.wager }, level: levelForXp(actor.xp - input.wager, input.curve) } });
    const game = await tx.game.create({ data: { guildId: input.guildId, type: input.type, status: 'ACTIVE', actorUserId: input.actorUserId, wager: input.wager, escrow: input.wager, state: input.state, fairness: input.fairness, expiresAt: input.expiresAt, idempotencyKey: input.idempotencyKey } });
    await tx.ledger.create({ data: { guildId: input.guildId, actorId: actor.id, kind: 'ESCROW', amount: -input.wager, balanceAfter: updated.xp, reason: `${input.type} wager escrow`, gameId: game.id, idempotencyKey: `escrow:${game.id}`, configVersion: input.configVersion } });
    return game;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

// Instant games still record escrow and settlement, but perform both steps in
// one serializable transaction.  This prevents an exception from stranding a
// wager between game creation and settlement.
export async function playInstantEscrowGame(input: OpenGame & { status: Exclude<GameStatus, 'PENDING' | 'ACTIVE'>; payout: number }) {
  if (!Number.isSafeInteger(input.wager) || input.wager <= 0 || !Number.isSafeInteger(input.payout) || input.payout < 0) throw new EconomyError('Invalid wager');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.game.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;
    const actor = await member(tx, input.guildId, input.actorUserId);
    if (actor.frozenUntil && actor.frozenUntil > new Date()) throw new EconomyError('Account is frozen');
    if (actor.xp < input.wager) throw new EconomyError('Insufficient XP');
    const afterEscrow = actor.xp - input.wager;
    const debited = await tx.member.update({ where: { id: actor.id }, data: { xp: afterEscrow, level: levelForXp(afterEscrow, input.curve) } });
    const game = await tx.game.create({ data: { guildId: input.guildId, type: input.type, status: input.status, actorUserId: input.actorUserId, wager: input.wager, escrow: input.wager, state: input.state, fairness: input.fairness, expiresAt: input.expiresAt, idempotencyKey: input.idempotencyKey } });
    await tx.ledger.create({ data: { guildId: input.guildId, actorId: actor.id, kind: 'ESCROW', amount: -input.wager, balanceAfter: debited.xp, reason: `${input.type} wager escrow`, gameId: game.id, idempotencyKey: `escrow:${game.id}`, configVersion: input.configVersion } });
    const afterPayout = afterEscrow + input.payout;
    const settled = await tx.member.update({ where: { id: actor.id }, data: { xp: afterPayout, lifetimeXp: input.payout > 0 ? { increment: input.payout } : undefined, level: levelForXp(afterPayout, input.curve) } });
    await tx.ledger.create({ data: { guildId: input.guildId, actorId: actor.id, kind: 'PAYOUT', amount: input.payout, balanceAfter: settled.xp, reason: `${input.type} settlement`, gameId: game.id, idempotencyKey: `payout:${game.id}`, configVersion: input.configVersion } });
    if (input.payout > 0) await applyAutoPrestige(tx, settled, `payout:${game.id}`, input.configVersion, input.curve);
    return game;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function doubleEscrowGame(input: { gameId: string; userId: string; expectedUpdatedAt: Date; nextState: Prisma.InputJsonValue; configVersion: number; curve: ProgressionConfig }) {
  return prisma.$transaction(async (tx) => {
    const game = await tx.game.findUniqueOrThrow({ where: { id: input.gameId } });
    if (game.actorUserId !== input.userId) throw new EconomyError('This is not your game');
    if (game.status !== 'ACTIVE' || game.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) throw new EconomyError('Game state has changed; try again');
    const prior = await tx.ledger.findUnique({ where: { idempotencyKey: `double:${game.id}` } });
    if (prior) throw new EconomyError('Double down has already been used');
    const actor = await member(tx, game.guildId, game.actorUserId);
    if (actor.xp < game.wager) throw new EconomyError('Insufficient XP to double down');
    const updated = await tx.member.update({ where: { id: actor.id }, data: { xp: { decrement: game.wager }, level: levelForXp(actor.xp - game.wager, input.curve) } });
    const changed = await tx.game.updateMany({ where: { id: game.id, status: 'ACTIVE', updatedAt: game.updatedAt }, data: { wager: { increment: game.wager }, escrow: { increment: game.wager }, state: input.nextState } });
    if (changed.count !== 1) throw new EconomyError('Game state has changed; try again');
    await tx.ledger.create({ data: { guildId: game.guildId, actorId: actor.id, kind: 'ESCROW', amount: -game.wager, balanceAfter: updated.xp, reason: 'blackjack double-down escrow', gameId: game.id, idempotencyKey: `double:${game.id}`, configVersion: input.configVersion } });
    return tx.game.findUniqueOrThrow({ where: { id: game.id } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function updateActiveGame(input: { gameId: string; userId: string; expectedUpdatedAt: Date; state: Prisma.InputJsonValue }) {
  const changed = await prisma.game.updateMany({ where: { id: input.gameId, actorUserId: input.userId, status: 'ACTIVE', updatedAt: input.expectedUpdatedAt }, data: { state: input.state } });
  if (changed.count !== 1) throw new EconomyError('Game state has changed; try again');
  return prisma.game.findUniqueOrThrow({ where: { id: input.gameId } });
}

export async function settleEscrowGame(input: { gameId: string; status: Exclude<GameStatus, 'PENDING' | 'ACTIVE'>; payout: number; state: Prisma.InputJsonValue; configVersion: number; curve: ProgressionConfig; refund?: boolean }) {
  if (!Number.isSafeInteger(input.payout) || input.payout < 0) throw new EconomyError('Invalid payout');
  return prisma.$transaction(async (tx) => {
    const game = await tx.game.findUniqueOrThrow({ where: { id: input.gameId } });
    if (game.status !== 'ACTIVE' && game.status !== 'PENDING') return game;
    const actor = await member(tx, game.guildId, game.actorUserId);
    const amount = input.refund ? game.escrow : input.payout;
    const kind: LedgerKind = input.refund ? 'REFUND' : 'PAYOUT';
    const key = `${kind.toLowerCase()}:${game.id}`;
    const existing = await tx.ledger.findUnique({ where: { idempotencyKey: key } });
    if (!existing && amount > 0) {
      const next = actor.xp + amount;
      const updated = await tx.member.update({ where: { id: actor.id }, data: { xp: next, lifetimeXp: { increment: amount }, level: levelForXp(next, input.curve) } });
      await tx.ledger.create({ data: { guildId: game.guildId, actorId: actor.id, kind, amount, balanceAfter: updated.xp, reason: input.refund ? `${game.type} cancelled/expired refund` : `${game.type} settlement`, gameId: game.id, idempotencyKey: key, configVersion: input.configVersion } });
      await applyAutoPrestige(tx, updated, key, input.configVersion, input.curve);
    }
    return tx.game.update({ where: { id: game.id }, data: { status: input.status, state: input.state } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

// Retained for the instant games. New interactive games use escrow from creation.
export async function settleWager(guildId: string, userId: string, wager: number, payout: number, gameId: string, key: string, configVersion: number, curve: ProgressionConfig) {
  if (wager <= 0 || payout < 0) throw new EconomyError('Invalid wager');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ledger.findUnique({ where: { idempotencyKey: `${key}:debit` } }); if (existing) return existing;
    const m = await member(tx, guildId, userId); if (m.xp < wager) throw new EconomyError('Insufficient XP');
    const after = m.xp - wager + payout;
    const changed = await tx.member.update({ where: { id: m.id }, data: { xp: after, lifetimeXp: payout > 0 ? { increment: payout } : undefined, level: levelForXp(after, curve) } });
    await tx.ledger.create({ data: { guildId, actorId: m.id, kind: 'XP_DEBIT', amount: -wager, balanceAfter: m.xp - wager, reason: 'game wager', gameId, idempotencyKey: `${key}:debit`, configVersion } });
    const payoutEntry = await tx.ledger.create({ data: { guildId, actorId: m.id, kind: 'PAYOUT', amount: payout, balanceAfter: changed.xp, reason: 'game settlement', gameId, idempotencyKey: `${key}:payout`, configVersion } });
    if (payout > 0) await applyAutoPrestige(tx, changed, `${key}:payout`, configVersion, curve);
    return payoutEntry;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function prestige(guildId: string, userId: string, key: string, configVersion: number, curve: ProgressionConfig) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ledger.findUnique({ where: { idempotencyKey: key } }); if (existing) return existing;
    const m = await member(tx, guildId, userId); const requiredLevel = curve.thresholds.length - 1;
    if (m.level < requiredLevel || m.prestige >= curve.prestigeCap) throw new EconomyError('Prestige requirements not met');
    const updated = await tx.member.update({ where: { id: m.id }, data: { xp: curve.prestigeBaseline, level: levelForXp(curve.prestigeBaseline, curve), prestige: { increment: 1 } } });
    return tx.ledger.create({ data: { guildId, actorId: m.id, kind: 'PRESTIGE', amount: curve.prestigeBaseline - m.xp, balanceAfter: updated.xp, reason: 'prestige reset', idempotencyKey: key, configVersion } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
