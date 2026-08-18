import { DEFAULT_PROGRESSION } from './progression.js';
export const DEFAULT_SETTINGS = {
  progression: DEFAULT_PROGRESSION,
  xp: { messageMinLength: 8, messageAward: 15, messageCooldownSeconds: 60, dailyAward: 250, maxPerHour: 600, voicePerMinute: 5, reactionAward: 2 },
  games: { minBet: 10, maxBet: 5_000, blackjackPayoutBps: 15000, slots: [{ symbol: '🍒', weight: 45, payoutBps: 15000 }, { symbol: '🍋', weight: 35, payoutBps: 25000 }, { symbol: '⭐', weight: 20, payoutBps: 60000 }], gamble: [{ max: 49, payoutBps: 0 }, { max: 89, payoutBps: 15000 }, { max: 99, payoutBps: 30000 }, { max: 100, payoutBps: 100000 }] },
  enabled: {}, allowedChannels: [] as string[], logChannelId: '', maintenance: false
};
export type Settings = typeof DEFAULT_SETTINGS;
