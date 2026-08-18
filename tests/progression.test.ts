import { describe, expect, it } from 'vitest';
import { DEFAULT_PROGRESSION, isUnlocked, levelForXp, progressFor } from '../src/progression.js';
describe('progression', () => {
  it('contains exactly 50 configurable levels plus level zero', () => { expect(DEFAULT_PROGRESSION.thresholds).toHaveLength(51); expect(levelForXp(DEFAULT_PROGRESSION.thresholds[50]!)).toBe(50); });
  it('reports unlock boundaries and progress', () => { expect(isUnlocked('rob', 4)).toBe(false); expect(isUnlocked('rob', 5)).toBe(true); expect(isUnlocked('prestige', 50)).toBe(true); expect(progressFor(0).xpToNext).toBeGreaterThan(0); });
  it('uses the exact registered names for foundational commands', () => {
    for (const command of ['bj', 'level', 'levels', 'lb', 'vclb', 'longestcall', 'autoprestige']) expect(isUnlocked(command, 0)).toBe(true);
    expect(isUnlocked('blackjack', 50)).toBe(false);
  });
});
