export type ProgressionConfig = { thresholds: number[]; prestigeBaseline: number; prestigeCap: number; prestigeMultiplierBps: number };
export const DEFAULT_PROGRESSION: ProgressionConfig = {
  // cumulative XP to enter levels 0-50; active members reach 50 at 127,500 XP.
  thresholds: Array.from({ length: 51 }, (_, level) => level === 0 ? 0 : Math.round(100 * level * level / 2)),
  prestigeBaseline: 0, prestigeCap: 100, prestigeMultiplierBps: 0
};
export function levelForXp(xp: number, cfg = DEFAULT_PROGRESSION): number {
  if (!Number.isInteger(xp) || xp < 0) throw new Error('XP must be a non-negative integer');
  let level = 0; for (let i = 1; i < cfg.thresholds.length; i += 1) if (xp >= cfg.thresholds[i]!) level = i; else break;
  return level;
}
export function progressFor(xp: number, cfg = DEFAULT_PROGRESSION) {
  const level = levelForXp(xp, cfg); const next = cfg.thresholds[level + 1] ?? null; const current = cfg.thresholds[level] ?? 0;
  return { level, xp, nextLevelXp: next, xpToNext: next === null ? 0 : next - xp, progress: next === null ? 1 : (xp - current) / (next - current) };
}
// These values are prefix-command names. Keep them in one place so the runtime
// parser and progression gate use the same canonical command surface.
export const UNLOCKS: Record<number, string[]> = {
  0: ['ping', 'level', 'levels', 'lb', 'vclb', 'longestcall', 'autoprestige', 'bj', 'slots', 'gamble', 'daily', 'crash', 'vibecheck', 'ship', '8ball', 'raffle', 'quests', 'bounty', 'tictactoe', 'duel'],
  5: ['rob'],
  15: ['donate', 'coinflip'],
  20: ['give'],
  50: ['prestige']
};
export function isUnlocked(command: string, level: number): boolean { return Object.entries(UNLOCKS).some(([min, values]) => level >= Number(min) && values.includes(command)); }
