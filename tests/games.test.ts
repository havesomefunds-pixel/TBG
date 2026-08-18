import { describe, expect, it } from 'vitest';
import { blackjackValue, d100, slots } from '../src/games.js';
import { DEFAULT_SETTINGS } from '../src/default-settings.js';
describe('deterministic game rules', () => {
  it('handles soft aces in blackjack', () => { expect(blackjackValue([1, 1, 9])).toBe(21); expect(blackjackValue([1, 1, 10])).toBe(12); });
  it('uses transparent d100 table', () => { expect(d100(100, DEFAULT_SETTINGS, 1).payout).toBe(0); expect(d100(100, DEFAULT_SETTINGS, 100).payout).toBe(1000); });
  it('only pays matching slots', () => { expect(slots(100, DEFAULT_SETTINGS, [1, 1, 1]).payout).toBeGreaterThan(0); expect(slots(100, DEFAULT_SETTINGS, [1, 50, 90]).payout).toBe(0); });
});
