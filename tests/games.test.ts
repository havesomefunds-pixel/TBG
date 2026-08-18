import { describe, expect, it } from 'vitest';
import { blackjackPayout, blackjackResult, blackjackValue, crashMultiplier, dealerPlay, d100, hitBlackjack, isNaturalBlackjack, slots, startBlackjack, type Card } from '../src/games.js';
import { DEFAULT_SETTINGS } from '../src/default-settings.js';
describe('deterministic game rules', () => {
  it('handles soft aces in blackjack', () => { expect(blackjackValue([1, 1, 9])).toBe(21); expect(blackjackValue([1, 1, 10])).toBe(12); });
  it('detects a natural blackjack and pays 3:2 plus returned wager', () => {
    const state = startBlackjack(['AS', 'KS', '9H', '7C'] as Card[]);
    expect(isNaturalBlackjack(state.player)).toBe(true);
    expect(blackjackResult(state)).toBe('BLACKJACK');
    expect(blackjackPayout(100, 'BLACKJACK')).toBe(250);
  });
  it('resolves normal wins, losses and pushes after dealer play', () => {
    const win = dealerPlay(startBlackjack(['10S', 'QH', '9D', '8C'] as Card[]));
    const loss = dealerPlay(startBlackjack(['8S', '7H', '10D', '9C'] as Card[]));
    const push = dealerPlay(startBlackjack(['10S', '8H', '9D', '7C', '2S'] as Card[]));
    expect(blackjackResult(win)).toBe('WIN');
    expect(blackjackPayout(100, blackjackResult(win))).toBe(200);
    expect(blackjackResult(loss)).toBe('LOSS');
    expect(blackjackPayout(100, blackjackResult(loss))).toBe(0);
    expect(blackjackResult(push)).toBe('PUSH');
    expect(blackjackPayout(100, blackjackResult(push))).toBe(100);
  });
  it('handles hit, player bust, dealer bust, stand, and double-down payout rules', () => {
    const hit = hitBlackjack(startBlackjack(['10S', '6H', '9D', '7C', '8S'] as Card[]));
    const playerBust = hitBlackjack(startBlackjack(['10S', '8H', '9D', '7C', '5S'] as Card[]));
    const dealerBust = dealerPlay(startBlackjack(['10S', 'QH', '9D', '7C', '10C'] as Card[]));
    expect(blackjackValue(hit.player)).toBe(24);
    expect(blackjackResult(playerBust)).toBe('PLAYER_BUST');
    expect(blackjackResult(dealerBust)).toBe('DEALER_BUST');
    expect(blackjackPayout(200, 'WIN')).toBe(400);
  });
  it('calculates a monotonic crash multiplier for cash-out checks', () => {
    const started = new Date('2026-01-01T00:00:00.000Z');
    expect(crashMultiplier(started, started)).toBe(1);
    expect(crashMultiplier(started, new Date('2026-01-01T00:00:10.000Z'))).toBe(1.6);
  });
  it('uses transparent d100 table', () => { expect(d100(100, DEFAULT_SETTINGS, 1).payout).toBe(0); expect(d100(100, DEFAULT_SETTINGS, 100).payout).toBe(1000); });
  it('only pays matching slots', () => { expect(slots(100, DEFAULT_SETTINGS, [1, 1, 1]).payout).toBeGreaterThan(0); expect(slots(100, DEFAULT_SETTINGS, [1, 50, 90]).payout).toBe(0); });
});
