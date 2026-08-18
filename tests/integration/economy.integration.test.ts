import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROGRESSION } from '../../src/progression.js';

const integration = process.env.TBG_INTEGRATION === '1';
const suite = integration ? describe : describe.skip;

suite('PostgreSQL escrow and game lifecycle integration', () => {
  let database: typeof import('../../src/database.js');
  let economy: typeof import('../../src/economy.js');
  let bot: typeof import('../../src/bot.js');
  const guildId = 'integration-guild';
  const configVersion = 1;

  beforeAll(async () => {
    database = await import('../../src/database.js');
    economy = await import('../../src/economy.js');
    bot = await import('../../src/bot.js');
    await database.prisma.$connect();
  });

  afterAll(async () => { await database.prisma.$disconnect(); });
  beforeEach(async () => {
    await database.prisma.$executeRawUnsafe('TRUNCATE TABLE "Ledger", "Game", "Cooldown", "VoiceSession", "AuditLog", "GuildConfig", "Member", "Raffle", "QuestProgress", "Bounty" CASCADE');
  });

  async function seed(userId = 'player', balance = 1_000) {
    await economy.mutateBalance({ guildId, userId, delta: balance, kind: 'XP_AWARD', reason: 'test seed', idempotencyKey: `seed:${userId}`, configVersion }, DEFAULT_PROGRESSION);
  }
  async function balance(userId = 'player') {
    return (await database.prisma.member.findUniqueOrThrow({ where: { guildId_userId: { guildId, userId } } })).xp;
  }
  async function open(type = 'bj', userId = 'player', key = `game:${type}:${userId}`, expiresAt = new Date(Date.now() + 60_000)) {
    return economy.openEscrowGame({ guildId, type, actorUserId: userId, wager: 100, state: {}, idempotencyKey: key, configVersion, curve: DEFAULT_PROGRESSION, expiresAt });
  }

  it('escrows a wager and refunds it exactly once', async () => {
    await seed(); const game = await open();
    expect(await balance()).toBe(900);
    await economy.settleEscrowGame({ gameId: game.id, status: 'EXPIRED', payout: 0, refund: true, state: { expired: true }, configVersion, curve: DEFAULT_PROGRESSION });
    await economy.settleEscrowGame({ gameId: game.id, status: 'EXPIRED', payout: 0, refund: true, state: { expired: true }, configVersion, curve: DEFAULT_PROGRESSION });
    expect(await balance()).toBe(1_000);
    expect(await database.prisma.ledger.count({ where: { gameId: game.id, kind: 'REFUND' } })).toBe(1);
  });

  it('prevents duplicate and concurrent settlement payouts', async () => {
    await seed(); const game = await open();
    await Promise.allSettled([
      economy.settleEscrowGame({ gameId: game.id, status: 'WON', payout: 200, state: { winner: true }, configVersion, curve: DEFAULT_PROGRESSION }),
      economy.settleEscrowGame({ gameId: game.id, status: 'WON', payout: 200, state: { winner: true }, configVersion, curve: DEFAULT_PROGRESSION })
    ]);
    expect(await balance()).toBe(1_100);
    expect(await database.prisma.ledger.count({ where: { gameId: game.id, kind: 'PAYOUT' } })).toBe(1);
  });

  it('rejects unauthorized component-layer game actions without changing escrow', async () => {
    await seed('owner'); const game = await open('bj', 'owner');
    await expect(economy.doubleEscrowGame({ gameId: game.id, userId: 'attacker', expectedUpdatedAt: game.updatedAt, nextState: {}, configVersion, curve: DEFAULT_PROGRESSION })).rejects.toThrow('not your game');
    expect(await balance('owner')).toBe(900);
    expect(await database.prisma.ledger.count({ where: { gameId: game.id } })).toBe(1);
  });

  it('recovers persisted expired games with a refund', async () => {
    await seed(); const game = await open('bj', 'player', 'expired-game', new Date(Date.now() - 1_000));
    await bot.recoverGames({ info: () => undefined } as never);
    expect((await database.prisma.game.findUniqueOrThrow({ where: { id: game.id } })).status).toBe('EXPIRED');
    expect(await balance()).toBe(1_000);
  });

  it('prevents a negative balance before opening escrow', async () => {
    await seed('low', 99);
    await expect(economy.openEscrowGame({ guildId, type: 'bj', actorUserId: 'low', wager: 100, state: {}, idempotencyKey: 'too-large', configVersion, curve: DEFAULT_PROGRESSION, expiresAt: new Date(Date.now() + 60_000) })).rejects.toThrow('Insufficient XP');
    expect(await balance('low')).toBe(99);
    expect(await database.prisma.game.count({ where: { actorUserId: 'low' } })).toBe(0);
  });

  it('settles a crash lifecycle from escrow to payout', async () => {
    await seed(); const game = await open('crash');
    await economy.settleEscrowGame({ gameId: game.id, status: 'WON', payout: 150, state: { cashedOutAt: 1.5 }, configVersion, curve: DEFAULT_PROGRESSION });
    expect(await balance()).toBe(1_050);
    expect((await database.prisma.game.findUniqueOrThrow({ where: { id: game.id } })).status).toBe('WON');
  });

  it('settles coinflip escrow and payout atomically and idempotently', async () => {
    await seed();
    const input = { guildId, type: 'coinflip', actorUserId: 'player', wager: 100, payout: 200, status: 'WON' as const, state: { result: 'heads — win' }, idempotencyKey: 'coinflip:atomic', configVersion, curve: DEFAULT_PROGRESSION, expiresAt: new Date(Date.now() + 60_000) };
    const first = await economy.playInstantEscrowGame(input); const second = await economy.playInstantEscrowGame(input);
    expect(second.id).toBe(first.id);
    expect(await balance()).toBe(1_100);
    expect(await database.prisma.ledger.count({ where: { gameId: first.id } })).toBe(2);
    expect((await database.prisma.game.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('WON');
  });

  it('settles a successful robbery only once with no negative balances', async () => {
    await seed('robber', 100); await seed('target', 60);
    const input = { guildId, robberUserId: 'robber', targetUserId: 'target', success: true, minTransfer: 25, maxTransfer: 250, failurePenalty: 50, idempotencyKey: 'rob:success', configVersion, curve: DEFAULT_PROGRESSION };
    const first = await economy.resolveRobbery(input);
    const repeated = await economy.resolveRobbery(input);
    expect(first.success).toBe(true);
    expect(repeated).toEqual(first);
    expect(await balance('robber')).toBe(125);
    expect(await balance('target')).toBe(35);
    expect(await database.prisma.ledger.count({ where: { gameId: first.gameId, kind: 'TRANSFER' } })).toBe(2);
  });

  it('moves the configured robbery failure penalty to the target', async () => {
    await seed('robber', 100); await seed('target', 100);
    const result = await economy.resolveRobbery({ guildId, robberUserId: 'robber', targetUserId: 'target', success: false, minTransfer: 25, maxTransfer: 250, failurePenalty: 50, idempotencyKey: 'rob:failure', configVersion, curve: DEFAULT_PROGRESSION });
    expect(result).toMatchObject({ success: false, amount: 50, robberBalance: 50, targetBalance: 150 });
    expect(await balance('robber')).toBe(50);
    expect(await balance('target')).toBe(150);
  });

  it('awards a duel reward exactly once', async () => {
    await seed('challenger'); await seed('opponent');
    const game = await database.prisma.game.create({ data: { guildId, type: 'duel', actorUserId: 'challenger', targetUserId: 'opponent', state: { challenged: true }, expiresAt: new Date(Date.now() + 60_000), idempotencyKey: 'duel:once' } });
    await economy.resolveDuel({ gameId: game.id, winnerUserId: 'challenger', reward: 100, configVersion, curve: DEFAULT_PROGRESSION });
    await economy.resolveDuel({ gameId: game.id, winnerUserId: 'challenger', reward: 100, configVersion, curve: DEFAULT_PROGRESSION });
    expect(await balance('challenger')).toBe(1_100);
    expect(await database.prisma.ledger.count({ where: { gameId: game.id, kind: 'XP_AWARD' } })).toBe(1);
  });
});
