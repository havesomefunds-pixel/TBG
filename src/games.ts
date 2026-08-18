import { createHash } from 'node:crypto';
import { prisma } from './database.js';
import { random } from './fairness.js';
import type { Settings } from './default-settings.js';

export class GameError extends Error {}

export type Card = `${'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'}${'S' | 'H' | 'D' | 'C'}`;
export type BlackjackState = {
  deck: Card[];
  player: Card[];
  dealer: Card[];
  doubled: boolean;
};

const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
const suits = ['S', 'H', 'D', 'C'] as const;
const symbols: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

export function validateBet(bet: number, settings: Settings) {
  if (!Number.isSafeInteger(bet) || bet < settings.games.minBet || bet > settings.games.maxBet) throw new GameError(`Bet must be ${settings.games.minBet}-${settings.games.maxBet} XP`);
}

export function d100(bet: number, settings: Settings, roll = random.int(1, 100)) {
  const band = settings.games.gamble.find((x) => roll <= x.max);
  if (!band) throw new GameError('Invalid payout table');
  return { roll, payout: Math.floor(bet * band.payoutBps / 10_000), multiplierBps: band.payoutBps };
}

export function slots(bet: number, settings: Settings, rolls = [random.int(1, 100), random.int(1, 100), random.int(1, 100)]) {
  const spin = rolls.map((roll) => {
    let total = 0;
    const choice = settings.games.slots.find((x) => (total += x.weight) >= roll);
    return choice ?? settings.games.slots[settings.games.slots.length - 1]!;
  });
  const same = spin.every((x) => x.symbol === spin[0]?.symbol);
  return { symbols: spin.map((x) => x.symbol), payout: same ? Math.floor(bet * spin[0]!.payoutBps / 10_000) : 0 };
}

export function crashPoint(seed: string): number {
  const n = createHash('sha256').update(seed).digest().readUInt32BE(0);
  // The point is deterministic from the retained seed and is never below 1.00x.
  return Math.max(1, Math.floor((100 / Math.max(1, n / 0xffffffff * 100)) * 100) / 100);
}

export function crashMultiplier(startedAt: Date, now = new Date()): number {
  // A gentle linear ramp keeps the round readable and makes the exact cash-out
  // multiplier independently reproducible from its persisted start time.
  return Math.max(1, Math.floor((1 + Math.max(0, now.getTime() - startedAt.getTime()) / 1000 * 0.06) * 100) / 100);
}

export function newDeck(): Card[] {
  const deck = suits.flatMap((suit) => ranks.map((rank) => `${rank}${suit}` as Card));
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = random.int(0, i);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

function rankValue(card: Card | number): number {
  if (typeof card === 'number') return card === 1 ? 1 : Math.min(card, 10);
  const rank = card.slice(0, -1);
  return rank === 'A' ? 1 : ['J', 'Q', 'K'].includes(rank) ? 10 : Number(rank);
}

export function blackjackValue(cards: readonly (Card | number)[]): number {
  let total = cards.reduce<number>((sum, card) => sum + (rankValue(card) === 1 ? 11 : rankValue(card)), 0);
  let aces = cards.filter((card) => rankValue(card) === 1).length;
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}

export function isNaturalBlackjack(cards: readonly (Card | number)[]) { return cards.length === 2 && blackjackValue(cards) === 21; }
export function cardLabel(card: Card) { return `${card.slice(0, -1)}${symbols[card.slice(-1)]!}`; }
export function handLabel(cards: readonly Card[]) { return cards.map(cardLabel).join(' '); }

export function startBlackjack(deck = newDeck()): BlackjackState {
  if (deck.length < 4) throw new GameError('Deck does not contain enough cards');
  const working = [...deck];
  return { player: [working.shift()!, working.shift()!], dealer: [working.shift()!, working.shift()!], deck: working, doubled: false };
}

export function hitBlackjack(state: BlackjackState): BlackjackState {
  if (state.deck.length === 0) throw new GameError('Deck is exhausted');
  return { ...state, player: [...state.player, state.deck[0]!], deck: state.deck.slice(1) };
}

export function dealerPlay(state: BlackjackState): BlackjackState {
  const next = { ...state, dealer: [...state.dealer], deck: [...state.deck] };
  while (blackjackValue(next.dealer) < 17) {
    if (!next.deck.length) throw new GameError('Deck is exhausted');
    next.dealer.push(next.deck.shift()!);
  }
  return next;
}

export type BlackjackResult = 'BLACKJACK' | 'WIN' | 'LOSS' | 'PUSH' | 'PLAYER_BUST' | 'DEALER_BUST';
export function blackjackResult(state: BlackjackState): BlackjackResult {
  const player = blackjackValue(state.player);
  const dealer = blackjackValue(state.dealer);
  if (player > 21) return 'PLAYER_BUST';
  if (dealer > 21) return 'DEALER_BUST';
  if (isNaturalBlackjack(state.player) && !isNaturalBlackjack(state.dealer)) return 'BLACKJACK';
  if (player > dealer) return 'WIN';
  if (player < dealer) return 'LOSS';
  return 'PUSH';
}

export function blackjackPayout(wager: number, result: BlackjackResult): number {
  if (result === 'BLACKJACK') return Math.floor(wager * 2.5);
  if (result === 'WIN' || result === 'DEALER_BUST') return wager * 2;
  if (result === 'PUSH') return wager;
  return 0;
}

export async function createGame(input: { guildId: string; type: string; actorUserId: string; targetUserId?: string; wager: number; state: object; idempotencyKey: string; expiresAt?: Date }) {
  return prisma.game.upsert({ where: { idempotencyKey: input.idempotencyKey }, create: { ...input, state: input.state }, update: {} });
}

export async function completeGame(id: string, status: 'WON' | 'LOST' | 'DRAW' | 'CANCELLED' | 'EXPIRED', state: object) {
  return prisma.game.update({ where: { id }, data: { status, state } });
}
