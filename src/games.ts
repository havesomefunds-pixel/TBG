import { createHash } from 'node:crypto';
import { prisma } from './database.js';
import { random } from './fairness.js';
import type { Settings } from './default-settings.js';

export class GameError extends Error {}
export function validateBet(bet: number, settings: Settings) { if (!Number.isSafeInteger(bet) || bet < settings.games.minBet || bet > settings.games.maxBet) throw new GameError(`Bet must be ${settings.games.minBet}-${settings.games.maxBet} XP`); }
export function d100(bet: number, settings: Settings, roll = random.int(1, 100)) { const band = settings.games.gamble.find((x) => roll <= x.max); if (!band) throw new GameError('Invalid payout table'); return { roll, payout: Math.floor(bet * band.payoutBps / 10_000), multiplierBps: band.payoutBps }; }
export function slots(bet: number, settings: Settings, rolls = [random.int(1, 100), random.int(1, 100), random.int(1, 100)]) {
  const spin = rolls.map((roll) => { let total = 0; const choice = settings.games.slots.find((x) => (total += x.weight) >= roll); return choice ?? settings.games.slots[settings.games.slots.length - 1]!; });
  const same = spin.every((x) => x.symbol === spin[0]?.symbol); const payout = same ? Math.floor(bet * spin[0]!.payoutBps / 10_000) : 0;
  return { symbols: spin.map((x) => x.symbol), payout };
}
export function crashPoint(seed: string): number { const n = createHash('sha256').update(seed).digest().readUInt32BE(0); return Math.max(1, Math.floor((100 / Math.max(1, n / 0xffffffff * 100)) * 100) / 100); }
export async function createGame(input: { guildId: string; type: string; actorUserId: string; targetUserId?: string; wager: number; state: object; idempotencyKey: string; expiresAt?: Date }) {
  return prisma.game.upsert({ where: { idempotencyKey: input.idempotencyKey }, create: { ...input, state: input.state }, update: {} });
}
export async function completeGame(id: string, status: 'WON' | 'LOST' | 'DRAW' | 'CANCELLED' | 'EXPIRED', state: object) { return prisma.game.update({ where: { id }, data: { status, state } }); }
export function blackjackValue(cards: number[]) { let total = cards.reduce((sum, card) => sum + (card === 1 ? 11 : Math.min(card, 10)), 0); let aces = cards.filter((x) => x === 1).length; while (total > 21 && aces > 0) { total -= 10; aces -= 1; } return total; }
export function newDeck() { const deck = Array.from({ length: 52 }, (_, i) => i % 13 + 1); for (let i = deck.length - 1; i > 0; i -= 1) { const j = random.int(0, i); [deck[i], deck[j]] = [deck[j]!, deck[i]!]; } return deck; }
