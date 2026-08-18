import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { claimCooldown } from '../src/cooldowns.js';
import { prisma } from '../src/database.js';
import { EconomyError, mutateBalance, settleWager, transfer } from '../src/economy.js';
import { DEFAULT_PROGRESSION } from '../src/progression.js';
import { startVoice, stopVoice } from '../src/voice.js';

const guildId = 'integration-guild';
const curve = DEFAULT_PROGRESSION;

beforeEach(async () => {
  await prisma.ledger.deleteMany();
  await prisma.member.deleteMany();
  await prisma.cooldown.deleteMany();
  await prisma.voiceSession.deleteMany();
});
afterAll(async () => { await prisma.$disconnect(); });

describe('PostgreSQL integration', () => {
  it('applies the Prisma schema to the disposable database', async () => {
    await expect(prisma.$queryRaw`SELECT 1`).resolves.toBeTruthy();
    await expect(prisma.member.count()).resolves.toBe(0);
  });

  it('records an XP award and resulting balance atomically', async () => {
    const ledger = await mutateBalance({ guildId, userId: 'alice', delta: 150, kind: 'XP_AWARD', reason: 'test', idempotencyKey: 'award-1', configVersion: 1 }, curve);
    const member = await prisma.member.findUniqueOrThrow({ where: { guildId_userId: { guildId, userId: 'alice' } } });
    expect([ledger.amount, ledger.balanceAfter, member.xp, member.lifetimeXp]).toEqual([150, 150, 150, 150]);
  });

  it('makes balance mutations idempotent', async () => {
    const mutation = { guildId, userId: 'alice', delta: 100, kind: 'XP_AWARD' as const, reason: 'test', idempotencyKey: 'same-award', configVersion: 1 };
    const first = await mutateBalance(mutation, curve);
    const second = await mutateBalance(mutation, curve);
    expect(first.id).toBe(second.id);
    await expect(prisma.member.findUniqueOrThrow({ where: { guildId_userId: { guildId, userId: 'alice' } } })).resolves.toMatchObject({ xp: 100 });
  });

  it('rejects an overdraft without creating a ledger entry', async () => {
    await expect(mutateBalance({ guildId, userId: 'alice', delta: -1, kind: 'XP_DEBIT', reason: 'test', idempotencyKey: 'overdraft', configVersion: 1 }, curve)).rejects.toBeInstanceOf(EconomyError);
    await expect(prisma.ledger.count()).resolves.toBe(0);
  });

  it('transfers XP with a matching sender ledger record', async () => {
    await mutateBalance({ guildId, userId: 'alice', delta: 100, kind: 'XP_AWARD', reason: 'seed', idempotencyKey: 'seed-transfer', configVersion: 1 }, curve);
    await transfer(guildId, 'alice', 'bob', 40, 'transfer-1', 1, curve);
    const members = await prisma.member.findMany({ where: { guildId }, orderBy: { userId: 'asc' } });
    expect(members.map(({ userId, xp }) => [userId, xp])).toEqual([['alice', 60], ['bob', 40]]);
  });

  it('settles a wager with debit and payout ledger rows', async () => {
    await mutateBalance({ guildId, userId: 'alice', delta: 100, kind: 'XP_AWARD', reason: 'seed', idempotencyKey: 'seed-wager', configVersion: 1 }, curve);
    await settleWager(guildId, 'alice', 30, 75, 'game-1', 'settle-1', 1, curve);
    await expect(prisma.ledger.findMany({ where: { gameId: 'game-1' }, orderBy: { reason: 'asc' } })).resolves.toHaveLength(2);
    await expect(prisma.member.findUniqueOrThrow({ where: { guildId_userId: { guildId, userId: 'alice' } } })).resolves.toMatchObject({ xp: 145 });
  });

  it('enforces cooldowns and accrues voice time in PostgreSQL', async () => {
    expect(await claimCooldown(guildId, 'alice', 'daily', 60_000)).toBe(true);
    expect(await claimCooldown(guildId, 'alice', 'daily', 60_000)).toBe(false);
    const start = new Date('2026-01-01T00:00:00.000Z');
    await startVoice(guildId, 'alice', 'channel', start);
    expect(await stopVoice(guildId, 'alice', new Date('2026-01-01T00:01:30.000Z'))).toBe(90);
  });
});
