import { DEFAULT_PROGRESSION } from './progression.js';
export type XpSettings = {
  messageMinLength: number;
  messageAward: number;
  messageCooldownSeconds: number;
  dailyAward: number;
  maxPerHour: number;
  voicePerMinute: number;
  reactionAward: number;
};

export type GameSettings = {
  minBet: number;
  maxBet: number;
  blackjackPayoutBps: number;
  slots: Array<{ symbol: string; weight: number; payoutBps: number }>;
  gamble: Array<{ max: number; payoutBps: number }>;
  duelReward: number;
  rob: { successChanceBps: number; minTransfer: number; maxTransfer: number; failurePenalty: number };
};

export type Settings = {
  prefix: string;
  progression: typeof DEFAULT_PROGRESSION;
  xp: XpSettings;
  games: GameSettings;
  enabled: Record<string, boolean>;
  allowedChannels: string[];
  roles: { adminRoleId: string | null; moderatorRoleId: string | null };
  economyName: string;
  maintenance: boolean;
  logChannelId: string;
};

export const DEFAULT_SETTINGS: Settings = {
  prefix: '!',
  progression: DEFAULT_PROGRESSION,
  xp: { messageMinLength: 8, messageAward: 15, messageCooldownSeconds: 60, dailyAward: 250, maxPerHour: 600, voicePerMinute: 5, reactionAward: 2 },
  games: {
    minBet: 10,
    maxBet: 5_000,
    blackjackPayoutBps: 15000,
    slots: [{ symbol: '🍒', weight: 45, payoutBps: 15000 }, { symbol: '🍋', weight: 35, payoutBps: 25000 }, { symbol: '⭐', weight: 20, payoutBps: 60000 }],
    gamble: [{ max: 49, payoutBps: 0 }, { max: 89, payoutBps: 15000 }, { max: 99, payoutBps: 30000 }, { max: 100, payoutBps: 100000 }],
    // Social-game awards and robbery consequences remain configurable with the
    // rest of the XP economy. Amounts are virtual XP only.
    duelReward: 100,
    rob: { successChanceBps: 4_500, minTransfer: 25, maxTransfer: 250, failurePenalty: 50 }
  },
  // Missing feature keys mean enabled, which preserves existing deployments. A
  // key explicitly set to false disables that command/event at runtime.
  enabled: {},
  allowedChannels: [],
  roles: { adminRoleId: null, moderatorRoleId: null },
  economyName: 'TBG',
  logChannelId: '',
  maintenance: false
};

/** A fresh value prevents one guild's settings object from leaking into another. */
export function defaultSettings(): Settings {
  return structuredClone(DEFAULT_SETTINGS);
}
