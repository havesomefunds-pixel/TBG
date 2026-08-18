import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits, type ButtonInteraction, type GuildMember, type Message, type User } from 'discord.js';
import pino from 'pino';
import { parseConfig, type AppConfig } from './config.js';
import { isGuildAdmin, isGuildModerator } from './authorization.js';
import { ensureGuildConfig, guildSettings, prisma, updateSettings } from './database.js';
import { claimCooldown } from './cooldowns.js';
import { isUnlocked, progressFor } from './progression.js';
import { doubleEscrowGame, grantAdminXp, grantCappedXp, openEscrowGame, playInstantEscrowGame, prestige, resolveDuel, resolveRobbery, settleEscrowGame, transfer, updateActiveGame } from './economy.js';
import { blackjackPayout, blackjackResult, blackjackValue, cardLabel, crashMultiplier, crashPoint, d100, dealerPlay, hitBlackjack, isNaturalBlackjack, slots, startBlackjack, type BlackjackState, validateBet } from './games.js';
import { fairnessMetadata, random } from './fairness.js';
import { awardVoiceXp, startVoice, stopVoice } from './voice.js';
import { DEFAULT_SETTINGS, defaultSettings, type Settings } from './default-settings.js';

export const PREFIX = DEFAULT_SETTINGS.prefix;
const COLORS = { brand: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c, muted: 0x99aab5 };
const COMMANDS = new Set(['ping', 'help', 'setup', 'settings', 'level', 'levels', 'lb', 'vclb', 'longestcall', 'autoprestige', 'bj', 'slots', 'gamble', 'daily', 'crash', 'vibecheck', 'ship', '8ball', 'raffle', 'quests', 'bounty', 'tictactoe', 'duel', 'rob', 'donate', 'coinflip', 'give', 'givexp', 'prestige', 'admin-settings-export', 'admin-settings', 'admin-freeze']);
const EIGHT_BALL = ['Absolutely.', 'Signs point to yes.', 'Ask again after the next round.', 'The vibes say no.', 'Without a doubt.', 'Not today.', 'It is decidedly so.', 'Better not tell you now.'];

export type PrefixInvocation = { name: string; args: string[] };

export function parsePrefixCommand(content: string, prefix = PREFIX): PrefixInvocation | null {
  if (!prefix || !content.startsWith(prefix)) return null;
  const parts = content.slice(prefix.length).trim().match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
  const rawName = parts.shift();
  if (!rawName) return null;
  const raw = rawName.toLowerCase();
  return { name: raw === 'vibe-check' ? 'vibecheck' : raw, args: parts.map((part) => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')) };
}

export type TicTacToeMark = 'X' | 'O';
export type TicTacToeState = { board: Array<TicTacToeMark | null>; turnUserId: string };
type TicTacToeMove = { state: TicTacToeState; mark: TicTacToeMark; winner: TicTacToeMark | 'DRAW' | null };
const WINNING_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]] as const;

export function ticTacToeWinner(board: readonly (TicTacToeMark | null)[]): TicTacToeMark | 'DRAW' | null {
  for (const [a, b, c] of WINNING_LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return board.every(Boolean) ? 'DRAW' : null;
}

export function applyTicTacToeMove(state: TicTacToeState, userId: string, actorUserId: string, targetUserId: string, cell: number): TicTacToeMove {
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new Error('Invalid board position.');
  if (![actorUserId, targetUserId].includes(userId)) throw new Error('Only the two challenged players can use this board.');
  if (state.turnUserId !== userId) throw new Error('It is not your turn.');
  if (state.board.length !== 9 || state.board[cell]) throw new Error('That square is already taken.');
  const mark: TicTacToeMark = userId === actorUserId ? 'X' : 'O';
  const board = [...state.board];
  board[cell] = mark;
  return { state: { board, turnUserId: userId === actorUserId ? targetUserId : actorUserId }, mark, winner: ticTacToeWinner(board) };
}

function legacyAdminRoles(config: AppConfig, guildId: string) {
  return config.TBG_GUILD_ID === guildId ? new Set([...config.ownerRoleIds, ...config.adminRoleIds]) : new Set<string>();
}
function legacyModeratorRoles(config: AppConfig, guildId: string) {
  return config.TBG_GUILD_ID === guildId ? config.moderatorRoleIds : new Set<string>();
}
function isGuildAdministrator(member: GuildMember, guildId: string, guildOwnerId: string | null | undefined, settings: Settings, config: AppConfig) {
  return isGuildAdmin(member, guildOwnerId, settings.roles.adminRoleId, legacyAdminRoles(config, guildId));
}
function isGuildModeration(member: GuildMember, guildId: string, guildOwnerId: string | null | undefined, settings: Settings, config: AppConfig) {
  return isGuildModerator(member, guildOwnerId, settings.roles.adminRoleId, settings.roles.moderatorRoleId, legacyAdminRoles(config, guildId), legacyModeratorRoles(config, guildId));
}
const gameButtons = (gameId: string, includeDouble = true) => [
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj:hit:${gameId}`)
      .setLabel('Hit')
      .setEmoji('👆')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`bj:stand:${gameId}`)
      .setLabel('Stand')
      .setEmoji('✋')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bj:double:${gameId}`)
      .setLabel('Double Down')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!includeDouble)
  )
];
const crashButtons = (gameId: string) => [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`crash:cashout:${gameId}`).setLabel('Cash Out').setStyle(ButtonStyle.Success))];
const duelButtons = (gameId: string) => [new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(`duel:accept:${gameId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`duel:decline:${gameId}`).setLabel('Decline').setStyle(ButtonStyle.Danger)
)];

function featureEnabled(settings: Awaited<ReturnType<typeof guildSettings>>['settings'], name: string) { return settings.enabled[name] !== false; }
function allowed(settings: Awaited<ReturnType<typeof guildSettings>>['settings'], channelId: string | null) { return settings.allowedChannels.length === 0 || (channelId !== null && settings.allowedChannels.includes(channelId)); }
export function gameMatchesInteractionGuild(gameGuildId: string, interactionGuildId: string | null) { return gameGuildId === interactionGuildId; }
function jsonState<T>(state: unknown) { return state as T; }
function signedXp(value: number) { return `${value >= 0 ? '+' : '−'}${Math.abs(value)} XP`; }
function money(value: number) { return `${value.toLocaleString()} XP`; }
function multiplier(bps: number) { return `${Number((bps / 10_000).toFixed(2))}×`; }
function embed(title: string, description: string, color = COLORS.brand) { return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: 'TBG • Virtual XP only' }); }
function stateOf<T>(value: unknown) { return jsonState<T>(value); }
function requireInteger(value: string | undefined, usage: string) {
  if (!value || !/^\d+$/.test(value)) throw new Error(`Usage: ${usage}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Usage: ${usage}`);
  return parsed;
}
function requireConfigInteger(value: string | undefined, usage: string) {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`Usage: ${usage}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Usage: ${usage}`);
  return parsed;
}
function requireMention(message: Message, value: string | undefined, usage: string) {
  const match = /^<@!?(\d+)>$/.exec(value ?? '');
  const user = match ? message.mentions.users.get(match[1]!) : undefined;
  if (!user) throw new Error(`Usage: ${usage}`);
  return user;
}
function assertOtherHuman(target: User, actorId: string, action: string) {
  if (target.bot) throw new Error(`You cannot ${action} a bot.`);
  if (target.id === actorId) throw new Error(`You cannot ${action} yourself.`);
}
async function balanceFor(guildId: string, userId: string) { return (await prisma.member.findUniqueOrThrow({ where: { guildId_userId: { guildId, userId } } })).xp; }

function tttButtons(gameId: string, board: readonly (TicTacToeMark | null)[], disabled = false) {
  return [0, 3, 6].map((offset) => new ActionRowBuilder<ButtonBuilder>().addComponents(...[0, 1, 2].map((cell) => new ButtonBuilder()
    .setCustomId(`ttt:move:${gameId}:${offset + cell}`)
    .setLabel(board[offset + cell] ?? '·')
    .setStyle(board[offset + cell] === 'X' ? ButtonStyle.Primary : board[offset + cell] === 'O' ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(disabled || Boolean(board[offset + cell])))));
}
function tttEmbed(game: { actorUserId: string; targetUserId: string | null }, state: TicTacToeState, winner: TicTacToeMark | 'DRAW' | null = null) {
  const result = winner === 'DRAW' ? 'The board is full — it is a draw.' : winner ? `<@${winner === 'X' ? game.actorUserId : game.targetUserId}> wins the match!` : `<@${state.turnUserId}>'s turn.`;
  return embed('TBG Tic-Tac-Toe', `<@${game.actorUserId}> is **X**\n<@${game.targetUserId}> is **O**\n\n${result}`, winner === 'DRAW' ? COLORS.warning : winner ? COLORS.success : COLORS.brand);
}
function cardEmoji(card: Parameters<typeof cardLabel>[0]): string {
  const label = cardLabel(card);
  const suit = label.slice(-1);
  const rank = label.slice(0, -1);

  const suitBase: Record<string, number> = {
    '♠': 0x1F0A0,
    '♥': 0x1F0B0,
    '♦': 0x1F0C0,
    '♣': 0x1F0D0,
  };

  const rankOffset: Record<string, number> = {
    A: 1,
    '2': 2,
    '3': 3,
    '4': 4,
    '5': 5,
    '6': 6,
    '7': 7,
    '8': 8,
    '9': 9,
    '10': 10,
    J: 11,
    Q: 13,
    K: 14,
  };

  const base = suitBase[suit];
  const offset = rankOffset[rank];

  if (base === undefined || offset === undefined) return label;
  return String.fromCodePoint(base + offset);
}
function blackjackEmbed(
  state: BlackjackState,
  wager: number,
  balance: number,
  terminal = false,
  result = '',
  payout = 0
) {
    void result;

  const playerCards = state.player.map(cardEmoji).join(' ');
  const dealerCards = terminal
    ? state.dealer.map(cardEmoji).join(' ')
    : `${cardEmoji(state.dealer[0]!)} 🂠`;

  const playerValue = blackjackValue(state.player);
  const dealerVisible = blackjackValue([state.dealer[0]!]);
  const dealerValue = blackjackValue(state.dealer);

  const playerBlackjack = isNaturalBlackjack(state.player);
  const dealerBlackjack = isNaturalBlackjack(state.dealer);

  let title = '🃏 TBG Blackjack';
  let description =
    'Dealer acts after you **Stand**.\nChoose **Hit**, **Stand**, or **Double Down**.';
  let color = COLORS.brand;

  if (terminal) {
    if (playerValue > 21) {
      title = '🔴 TBG Blackjack — BUST';
      description = `You went over 21 with **${playerValue}**.`;
      color = COLORS.danger;
    } else if (playerBlackjack && dealerBlackjack) {
      title = '🟡 TBG Blackjack — PUSH';
      description = 'You and the dealer both have **Blackjack**.';
      color = COLORS.warning;
    } else if (playerBlackjack) {
      title = '🟢 TBG Blackjack — BLACKJACK!';
      description = 'Natural **Blackjack**. You win!';
      color = COLORS.success;
    } else if (dealerBlackjack) {
      title = '🔴 TBG Blackjack — DEALER BLACKJACK';
      description = 'The dealer has a natural **Blackjack**.';
      color = COLORS.danger;
    } else if (dealerValue > 21) {
      title = '🟢 TBG Blackjack — YOU WIN';
      description = `Dealer busts with **${dealerValue}**.`;
      color = COLORS.success;
    } else if (payout === wager) {
      title = '🟡 TBG Blackjack — PUSH';
      description = `You and the dealer both finish with **${playerValue}**.`;
      color = COLORS.warning;
    } else if (payout > wager) {
      title = '🟢 TBG Blackjack — YOU WIN';
      description = `You beat the dealer **${playerValue} to ${dealerValue}**.`;
      color = COLORS.success;
    } else {
      title = '🔴 TBG Blackjack — YOU LOSE';
      description = `Dealer wins **${dealerValue} to ${playerValue}**.`;
      color = COLORS.danger;
    }
  }

  const game = embed(title, description, color).addFields(
    {
      name: '🎩 DEALER',
      value: terminal
        ? `${dealerCards}\n\n**Total: ${dealerValue}**`
        : `${dealerCards}\n\n**Visible: ${dealerVisible}**`,
      inline: false,
    },
    {
      name: '👤 YOUR HAND',
      value: `${playerCards}\n\n**Total: ${playerValue}**`,
      inline: false,
    }
  );

  if (terminal) {
    game.addFields({
      name: '💰 GAME SUMMARY',
      value: [
        `💵 **Wager:** ${money(wager)}`,
        `📈 **Net XP:** ${signedXp(payout - wager)}`,
        `💰 **Payout:** ${money(payout)}`,
        `🏦 **New Balance:** ${money(balance)}`,
      ].join('\n'),
      inline: false,
    });
  } else {
    game.addFields({
      name: '💰 GAME SUMMARY',
      value: [
        `💵 **Wager:** ${money(wager)}`,
        `🔒 **In Play:** ${money(wager)}`,
        `🏦 **Available Balance:** ${money(balance)}`,
      ].join('\n'),
      inline: false,
    });
  }

  return game;
}
function crashEmbed(description: string, wager: number, balance: number, color = COLORS.brand, point?: number, payout?: number) {
  return embed('📈 TBG Crash', description, color).addFields(
    { name: 'Stake', value: money(wager), inline: true },
    ...(point === undefined ? [{ name: 'Escrowed', value: signedXp(-wager), inline: true }] : [{ name: 'Multiplier', value: `${point.toFixed(2)}×`, inline: true }]),
    ...(payout === undefined ? [{ name: 'Balance', value: money(balance), inline: true }] : [{ name: 'XP change', value: signedXp(payout - wager), inline: true }, { name: 'New balance', value: money(balance), inline: true }])
  );
}
function gambleTable(settings: Awaited<ReturnType<typeof guildSettings>>['settings']) {
  let lower = 1;
  return settings.games.gamble.map((band) => { const range = lower === band.max ? `${band.max}` : `${lower}–${band.max}`; lower = band.max + 1; return `${range}: ${multiplier(band.payoutBps)}`; }).join('\n');
}
function requiredGambleRoll(settings: Awaited<ReturnType<typeof guildSettings>>['settings']) {
  let lower = 1;
  for (const band of settings.games.gamble) { if (band.payoutBps > 0) return `${lower}+`; lower = band.max + 1; }
  return 'No winning roll configured';
}

export function createBot(config: AppConfig = parseConfig(), log = pino({ level: process.env.LOG_LEVEL ?? 'info' })) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent] });
  client.once(Events.ClientReady, async (ready) => {
    const guilds = [...ready.guilds.cache.values()];
    await Promise.all(guilds.map((guild) => ensureGuildConfig(guild.id)));
    await recoverGames(log);
    log.info({ guildCount: guilds.length }, 'Guild settings initialized; prefix commands and persisted games are ready');
  });
  client.on(Events.GuildCreate, async (guild) => {
    try {
      await ensureGuildConfig(guild.id);
      log.info({ guildId: guild.id }, 'Initialized settings for newly joined guild');
    } catch (error) {
      log.error({ err: error, guildId: guild.id }, 'Unable to initialize newly joined guild');
    }
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    try {
      if (!interaction.guildId) return void await interaction.reply({ content: config.DM_REPLY, ephemeral: true });
      await component(interaction);
    } catch (error) {
      log.error({ err: error, interactionId: interaction.id }, 'Component interaction failed');
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: error instanceof Error ? error.message : 'That action could not be completed safely.', ephemeral: true }).catch(() => undefined);
    }
  });
  client.on(Events.MessageCreate, async (message) => { try {
    if (message.author.bot) return;
    if (!message.guildId) { await message.author.send(config.DM_REPLY).catch(() => undefined); return; }
    const initialSettings = await guildSettings(message.guildId);
    const command = parsePrefixCommand(message.content, initialSettings.settings.prefix);
    if (command) { await prefixCommand(message, command, config); return; }
    if (message.content.startsWith(initialSettings.settings.prefix)) return;
    if (!featureEnabled(initialSettings.settings, 'message-xp') || !allowed(initialSettings.settings, message.channelId) || message.content.trim().length < initialSettings.settings.xp.messageMinLength || !(await claimCooldown(message.guildId, message.author.id, 'message-xp', initialSettings.settings.xp.messageCooldownSeconds * 1000))) return;
    await grantCappedXp({ guildId: message.guildId, userId: message.author.id, requested: initialSettings.settings.xp.messageAward, hourlyCap: initialSettings.settings.xp.maxPerHour, kind: 'XP_AWARD', reason: 'eligible message', idempotencyKey: `message:${message.id}`, configVersion: initialSettings.version }, initialSettings.settings.progression);
  } catch (error) {
    log.error({ err: error, messageId: message.id }, 'Prefix command failed');
    await message.reply({ content: error instanceof Error ? `⚠️ ${error.message}` : '⚠️ That command could not be completed safely.' }).catch(() => undefined);
  } });
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot || !reaction.message.guildId) return;
    const settings = await guildSettings(reaction.message.guildId);
    if (!featureEnabled(settings.settings, 'reaction-xp') || !allowed(settings.settings, reaction.message.channelId) || !(await claimCooldown(reaction.message.guildId, user.id, 'reaction-xp', 60_000))) return;
    await grantCappedXp({ guildId: reaction.message.guildId, userId: user.id, requested: settings.settings.xp.reactionAward, hourlyCap: settings.settings.xp.maxPerHour, kind: 'XP_AWARD', reason: 'eligible reaction', idempotencyKey: `reaction:${reaction.message.id}:${user.id}:${reaction.emoji.identifier}`, configVersion: settings.version }, settings.settings.progression);
  });
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const guildId = newState.guild.id;
    if (newState.member?.user.bot) return;
    const settings = await guildSettings(guildId);
    const oldEligible = Boolean(oldState.channelId && !oldState.selfDeaf && !oldState.serverDeaf && allowed(settings.settings, oldState.channelId));
    const newEligible = Boolean(newState.channelId && !newState.selfDeaf && !newState.serverDeaf && allowed(settings.settings, newState.channelId) && featureEnabled(settings.settings, 'voice-xp'));
    if (oldState.channelId === newState.channelId && oldEligible === newEligible) return;
    const ended = await stopVoice(guildId, newState.id);
    if (ended && featureEnabled(settings.settings, 'voice-xp')) await awardVoiceXp({ guildId, userId: newState.id, sessionId: ended.sessionId, seconds: ended.seconds, settings: settings.settings, configVersion: settings.version });
    if (newEligible) await startVoice(guildId, newState.id, newState.channelId!);
  });
  return client;
}

async function prefixCommand(message: Message, command: PrefixInvocation, config: AppConfig) {
  const { name, args } = command;
  const guildId = message.guildId!;
  const userId = message.author.id;
  const settings = await guildSettings(guildId);
  const prefix = settings.settings.prefix;
  if (!COMMANDS.has(name)) return void await message.reply(`Unknown command. TBGBot commands use ${prefix}; try ${prefix}help, ${prefix}level, or ${prefix}bj.`);
  const profile = await prisma.member.upsert({ where: { guildId_userId: { guildId, userId } }, create: { guildId, userId }, update: {} });
  const member = message.member as GuildMember | null;
  if (!member) throw new Error('Your guild membership could not be verified. Please try again.');
  const guildOwnerId = message.guild?.ownerId;
  const administrator = isGuildAdministrator(member, guildId, guildOwnerId, settings.settings, config);
  if (settings.maintenance && !administrator) throw new Error('Maintenance mode is enabled.');
  if (name === 'givexp') {
    if (!administrator) {
      throw new Error('Admin authorization required.');
    }
    if (!allowed(settings.settings, message.channelId)) throw new Error('This command is not enabled in this channel.');

    const target = requireMention(message, args[0], `${prefix}givexp @user <amount>`);

    if (target.bot) {
      throw new Error('You cannot give XP to a bot.');
    }

    const amount = requireInteger(args[1], `${prefix}givexp @user <amount>`);

    if (amount < 1 || amount > 1_000_000) {
      throw new Error('XP amount must be between 1 and 1,000,000.');
    }

    await grantAdminXp(
      {
        guildId,
        userId: target.id,
        requested: amount,
        kind: 'XP_AWARD',
        reason: `admin XP grant by ${message.author.id}`,
        idempotencyKey: `admin-givexp:${message.id}`,
        configVersion: settings.version,
      },
      settings.settings.progression
    );

    const updated = await prisma.member.findUnique({
      where: {
        guildId_userId: {
          guildId,
          userId: target.id,
        },
      },
    });

    if (!updated) {
      throw new Error('The user XP profile could not be loaded after the grant.');
    }

    const progress = progressFor(
      updated.xp,
      settings.settings.progression
    );

    return void await message.reply({
      embeds: [
        embed(
          '💰 Admin XP Grant',
          [
            `<@${target.id}> received **${money(amount)}**.`,
            '',
            `**New XP:** ${money(updated.xp)}`,
            `**Level:** ${progress.level}`,
            `**To next level:** ${money(progress.xpToNext)}`,
            '',
            `Granted by <@${message.author.id}>`,
          ].join('\n'),
          COLORS.success
        ),
      ],
    });
  }
  if (name === 'setup') return void await showSetup(message, settings.settings);
  if (name === 'help') return void await showHelp(message, settings.settings, administrator, profile.level);
  if (name === 'settings') {
    if (!administrator) throw new Error('Admin authorization required.');
    return void await settingsCommand(message, args, settings.settings);
  }
  if (!featureEnabled(settings.settings, name)) throw new Error('This feature is currently disabled.');
  if (!allowed(settings.settings, message.channelId) && !name.startsWith('admin-')) throw new Error('This command is not enabled in this channel.');
  if (!isUnlocked(name, profile.level) && !name.startsWith('admin-')) throw new Error(`Unlocks at a higher level (you are level ${profile.level}).`);
  if (name === 'ping') return void await message.reply(`Pong: ${message.client.ws.ping}ms · database ready`);
  if (name === 'level' || name === 'levels') {
    if (name === 'levels') return void await message.reply(`Level curve: ${settings.settings.progression.thresholds.map((threshold, level) => `L${level}:${threshold}`).join(' · ')}`);
    const target = args[0] ? requireMention(message, args[0], `${prefix}level [@user]`) : message.author;
    const targetProfile = await prisma.member.upsert({ where: { guildId_userId: { guildId, userId: target.id } }, create: { guildId, userId: target.id }, update: {} });
    const progress = progressFor(targetProfile.xp, settings.settings.progression);
    return void await message.reply(`<@${target.id}> — Level ${progress.level}, ${money(progress.xp)}, ${money(progress.xpToNext)} to next, Prestige ${targetProfile.prestige}.`);
  }
  if (name === 'lb' || name === 'vclb' || name === 'longestcall') {
    const orderBy = name === 'lb' ? { xp: 'desc' as const } : { voiceSeconds: 'desc' as const };
    const leaders = await prisma.member.findMany({ where: { guildId }, orderBy, take: name === 'longestcall' ? 1 : 10 });
    return void await message.reply(leaders.length ? leaders.map((leader, index) => `${index + 1}. <@${leader.userId}> — ${name === 'lb' ? money(leader.xp) : `${leader.voiceSeconds.toString()} seconds`}`).join('\n') : 'No rankings yet.');
  }
  if (name === 'autoprestige') { const updated = await prisma.member.update({ where: { id: profile.id }, data: { autoPrestige: !profile.autoPrestige } }); return void await message.reply(`Auto-prestige ${updated.autoPrestige ? 'enabled' : 'disabled'}.`); }
  if (name === 'daily') {
    if (!await claimCooldown(guildId, userId, 'daily', 86_400_000)) throw new Error('Daily reward is on cooldown.');
    const granted = await grantCappedXp({ guildId, userId, requested: settings.settings.xp.dailyAward, hourlyCap: settings.settings.xp.maxPerHour, kind: 'XP_AWARD', reason: 'daily reward', idempotencyKey: `daily:${userId}:${new Date().toISOString().slice(0, 10)}`, configVersion: settings.version }, settings.settings.progression);
    return void await message.reply(granted ? `Claimed ${money(granted.amount)}. New balance: ${money(granted.balanceAfter)}.` : 'Your hourly XP cap has been reached.');
  }
  if (name === 'bj') return void await startBj(message, requireInteger(args[0], `${prefix}bj <wager>`), settings);
  if (name === 'crash') return void await startCrash(message, requireInteger(args[0], `${prefix}crash <wager>`), settings);
  if (name === 'coinflip') return void await startCoinflip(message, requireInteger(args[0], `${prefix}coinflip <wager>`), settings);
  if (name === 'gamble') return void await startGamble(message, requireInteger(args[0], `${prefix}gamble <wager>`), settings);
  if (name === 'slots') return void await startSlots(message, requireInteger(args[0], `${prefix}slots <wager>`), settings);
  if (name === 'give') {
    const target = requireMention(message, args[0], `${prefix}give @user <amount>`); assertOtherHuman(target, userId, 'give XP to');
    const amount = requireInteger(args[1], `${prefix}give @user <amount>`); await transfer(guildId, userId, target.id, amount, `give:${message.id}`, settings.version, settings.settings.progression);
    return void await message.reply(`Transferred ${money(amount)} to <@${target.id}>.`);
  }
  if (name === 'prestige') { await prestige(guildId, userId, `prestige:${message.id}`, settings.version, settings.settings.progression); return void await message.reply('Prestige recorded. Your lifetime stats remain intact.'); }
  if (name === 'rob') return void await startRobbery(message, requireMention(message, args[0], `${prefix}rob @user`), settings);
  if (name === 'duel') return void await startDuel(message, requireMention(message, args[0], `${prefix}duel @user`), settings);
  if (name === 'tictactoe') return void await startTicTacToe(message, requireMention(message, args[0], `${prefix}tictactoe @user`));
  if (name === '8ball') return void await message.reply({ embeds: [embed('🎱 TBG 8-Ball', args.length ? `**Question:** ${args.join(' ')}\n\n**Answer:** ${EIGHT_BALL[random.int(0, EIGHT_BALL.length - 1)]!}` : `Ask a question: \`${prefix}8ball <question>\`.`, COLORS.muted)] });
  if (name === 'ship') { const target = requireMention(message, args[0], `${prefix}ship @user`); const score = random.int(0, 100); return void await message.reply({ embeds: [embed('💞 TBG Ship', `<@${userId}> + <@${target.id}>\n\n**Compatibility:** ${score}%`, score >= 70 ? COLORS.success : score >= 40 ? COLORS.warning : COLORS.danger)] }); }
  if (name === 'vibecheck') { const target = args[0] ? requireMention(message, args[0], `${prefix}vibecheck [@user]`) : message.author; const vibes = ['immaculate', 'locked in', 'chaotic good', 'mysterious', 'main-character']; return void await message.reply({ embeds: [embed('✨ TBG Vibe Check', `<@${target.id}> is **${vibes[random.int(0, vibes.length - 1)]!}** today.`, COLORS.muted)] }); }
  if (name === 'raffle') return void await showRaffle(message);
  if (name === 'quests') return void await showQuests(message);
  if (name === 'bounty') return void await showBounties(message, args[0], prefix);
  if (name === 'donate') return void await message.reply({ embeds: [embed('🎁 TBG Donate', 'There is no active donation-wheel event right now. This command does not move XP while the event is inactive.', COLORS.muted)] });
  if (name.startsWith('admin-')) return void await adminCommand(message, name, args, config, settings);
}

const FEATURE_NAMES: Record<string, string> = {
  blackjack: 'bj', bj: 'bj', slots: 'slots', gamble: 'gamble', coinflip: 'coinflip', crash: 'crash',
  robbery: 'rob', rob: 'rob', 'message-xp': 'message-xp', messagexp: 'message-xp',
  'reaction-xp': 'reaction-xp', reactionxp: 'reaction-xp', 'voice-xp': 'voice-xp', voicexp: 'voice-xp'
};

function settingsEmbed(settings: Settings) {
  const channelSummary = settings.allowedChannels.length ? settings.allowedChannels.map((id) => `<#${id}>`).join(', ') : 'All channels';
  const disabled = Object.entries(settings.enabled).filter(([, enabled]) => !enabled).map(([name]) => name).join(', ') || 'None';
  return embed('TBGBot Server Settings', `Settings are isolated to this server. Use \`${settings.prefix}setup\` for the admin guide.`, COLORS.brand).addFields(
    { name: 'Prefix', value: `\`${settings.prefix}\``, inline: true },
    { name: 'Command channels', value: channelSummary.slice(0, 1_000), inline: true },
    { name: 'Disabled features', value: disabled.slice(0, 1_000), inline: false },
    { name: 'XP', value: `Message ${settings.xp.messageAward} · daily ${settings.xp.dailyAward} · reaction ${settings.xp.reactionAward} · voice ${settings.xp.voicePerMinute}/min`, inline: false },
    { name: 'Games', value: `Bets ${settings.games.minBet}–${settings.games.maxBet} XP · duel reward ${settings.games.duelReward} XP`, inline: false },
    { name: 'Roles', value: `Admin: ${settings.roles.adminRoleId ? `<@&${settings.roles.adminRoleId}>` : 'Discord Administrator / owner'}\nModerator: ${settings.roles.moderatorRoleId ? `<@&${settings.roles.moderatorRoleId}>` : 'Moderate Members / admin'}`, inline: false }
  );
}

async function showSetup(message: Message, settings: Settings) {
  const prefix = settings.prefix;
  await message.reply({ embeds: [embed('TBGBot setup', [
    'This server starts with an empty, isolated virtual-XP economy.',
    '',
    `**1.** Review settings: \`${prefix}settings show\``,
    `**2.** Set a prefix: \`${prefix}settings prefix ?\``,
    `**3.** Limit command channels: \`${prefix}settings channel add #bot-commands\``,
    `**4.** Tune XP and bets: \`${prefix}settings xp messageaward 15\` and \`${prefix}settings games maxbet 5000\``,
    `**5.** Turn games on/off: \`${prefix}settings feature blackjack off\``,
    `**6.** Optionally set bot roles: \`${prefix}settings adminrole @BotAdmin\``,
    '',
    'Server owners and Discord Administrators always retain configuration access.'
  ].join('\n'), COLORS.success)] });
}

async function showHelp(message: Message, settings: Settings, administrator: boolean, level: number) {
  const prefix = settings.prefix;
  const publicCommands = ['level', 'lb', 'daily', 'bj', 'slots', 'gamble', 'crash', 'duel', 'tictactoe', 'rob', 'coinflip', 'give', 'prestige']
    .filter((command) => featureEnabled(settings, command) && isUnlocked(command, level));
  const adminCommands = administrator ? `\n\n**Admin:** \`${prefix}setup\`, \`${prefix}settings\`, \`${prefix}givexp @user <amount>\`, \`${prefix}admin-freeze @user <minutes> <reason>\`` : '';
  await message.reply({ embeds: [embed('TBGBot help', `Use \`${prefix}<command>\` in this server.\n\n**Available now:** ${publicCommands.map((command) => `\`${prefix}${command}\``).join(' ') || 'No public commands are enabled.'}\n\n**Unlocks:** rob at level 5 · coinflip at 15 · give at 20 · prestige at 50.${adminCommands}`, COLORS.brand)] });
}

function guildChannelId(message: Message, value: string | undefined, usage: string) {
  const match = /^(?:<#(\d+)>|(\d+))$/.exec(value ?? '');
  const channelId = match?.[1] ?? match?.[2];
  const channel = channelId ? message.guild?.channels.cache.get(channelId) : undefined;
  if (!channel || !channel.isTextBased()) throw new Error(`Usage: ${usage}`);
  return channel.id;
}

function guildRoleId(message: Message, value: string | undefined, usage: string) {
  const match = /^(?:<@&(\d+)>|(\d+))$/.exec(value ?? '');
  const roleId = match?.[1] ?? match?.[2];
  const role = roleId ? message.guild?.roles.cache.get(roleId) : undefined;
  if (!role || role.id === message.guildId) throw new Error(`Usage: ${usage}`);
  return role.id;
}

async function saveSettings(message: Message, settings: Settings, notice: string) {
  await updateSettings(message.guildId!, settings, message.author.id);
  await message.reply(notice);
}

async function settingsCommand(message: Message, args: string[], current: Settings) {
  const prefix = current.prefix;
  const section = args[0]?.toLowerCase();
  if (!section || section === 'show') return void await message.reply({ embeds: [settingsEmbed(current)] });
  if (section === 'prefix') {
    const value = args[1];
    if (!value || !/^\S{1,5}$/.test(value)) throw new Error(`Usage: ${prefix}settings prefix <1-5 non-space characters>`);
    return void await saveSettings(message, { ...current, prefix: value }, `Prefix changed to \`${value}\` for this server. Use \`${value}settings\` from now on.`);
  }
  if (section === 'channel' || section === 'channels') {
    const action = args[1]?.toLowerCase();
    if (action === 'all') return void await saveSettings(message, { ...current, allowedChannels: [] }, 'Commands are now allowed in all channels in this server.');
    const channelId = guildChannelId(message, args[2], `${prefix}settings channel <add|remove> #channel`);
    if (action === 'add') {
      const allowedChannels = [...new Set([...current.allowedChannels, channelId])];
      return void await saveSettings(message, { ...current, allowedChannels }, `Commands are now allowed in <#${channelId}>.`);
    }
    if (action === 'remove') {
      const allowedChannels = current.allowedChannels.filter((id) => id !== channelId);
      return void await saveSettings(message, { ...current, allowedChannels }, `Removed <#${channelId}> from the command-channel list.`);
    }
    throw new Error(`Usage: ${prefix}settings channel <add|remove> #channel | ${prefix}settings channel all`);
  }
  if (section === 'xp') {
    const key = args[1]?.toLowerCase().replace(/[-_]/g, '');
    const limits: Record<string, { field: keyof Settings['xp']; min: number; max: number }> = {
      messageaward: { field: 'messageAward', min: 0, max: 1_000 }, messageminlength: { field: 'messageMinLength', min: 0, max: 4_000 },
      messagecooldown: { field: 'messageCooldownSeconds', min: 0, max: 3_600 }, maxperhour: { field: 'maxPerHour', min: 0, max: 50_000 },
      dailyaward: { field: 'dailyAward', min: 0, max: 100_000 }, reactionaward: { field: 'reactionAward', min: 0, max: 1_000 }, voiceperminute: { field: 'voicePerMinute', min: 0, max: 1_000 }
    };
    const rule = key ? limits[key] : undefined;
    if (!rule) throw new Error(`Usage: ${prefix}settings xp <messageaward|messageminlength|messagecooldown|maxperhour|dailyaward|reactionaward|voiceperminute> <value>`);
    const value = requireConfigInteger(args[2], `${prefix}settings xp ${key} <value>`);
    if (value < rule.min || value > rule.max) throw new Error(`XP setting must be between ${rule.min} and ${rule.max}.`);
    return void await saveSettings(message, { ...current, xp: { ...current.xp, [rule.field]: value } }, `Updated XP setting \`${key}\` to ${value}.`);
  }
  if (section === 'games' || section === 'game') {
    const key = args[1]?.toLowerCase().replace(/[-_]/g, '');
    const limits: Record<string, { field: 'minBet' | 'maxBet' | 'duelReward'; min: number; max: number }> = {
      minbet: { field: 'minBet', min: 1, max: 1_000_000 }, maxbet: { field: 'maxBet', min: 1, max: 10_000_000 }, duelreward: { field: 'duelReward', min: 0, max: 1_000_000 }
    };
    const rule = key ? limits[key] : undefined;
    if (!rule) throw new Error(`Usage: ${prefix}settings games <minbet|maxbet|duelreward> <value>`);
    const value = requireConfigInteger(args[2], `${prefix}settings games ${key} <value>`);
    if (value < rule.min || value > rule.max) throw new Error(`Game setting must be between ${rule.min} and ${rule.max}.`);
    const games = { ...current.games, [rule.field]: value };
    if (games.minBet > games.maxBet) throw new Error('Minimum bet cannot exceed maximum bet.');
    return void await saveSettings(message, { ...current, games }, `Updated game setting \`${key}\` to ${value}.`);
  }
  if (section === 'feature') {
    const feature = FEATURE_NAMES[args[1]?.toLowerCase() ?? ''];
    const value = args[2]?.toLowerCase();
    if (!feature || (value !== 'on' && value !== 'off')) throw new Error(`Usage: ${prefix}settings feature <blackjack|slots|gamble|coinflip|crash|robbery|message-xp|reaction-xp|voice-xp> <on|off>`);
    return void await saveSettings(message, { ...current, enabled: { ...current.enabled, [feature]: value === 'on' } }, `${args[1]} is now ${value} in this server.`);
  }
  if (section === 'adminrole' || section === 'modrole' || section === 'moderatorrole') {
    const field = section === 'adminrole' ? 'adminRoleId' : 'moderatorRoleId';
    const value = args[1]?.toLowerCase() === 'clear' ? null : guildRoleId(message, args[1], `${prefix}settings ${section} <@role|roleId|clear>`);
    return void await saveSettings(message, { ...current, roles: { ...current.roles, [field]: value } }, `${section === 'adminrole' ? 'Admin' : 'Moderator'} role ${value ? `set to <@&${value}>` : 'cleared'}.`);
  }
  if (section === 'reset') {
    const target = args[1]?.toLowerCase();
    const defaults = defaultSettings();
    let next: Settings;
    if (target === 'prefix') next = { ...current, prefix: defaults.prefix };
    else if (target === 'channels') next = { ...current, allowedChannels: defaults.allowedChannels };
    else if (target === 'xp') next = { ...current, xp: defaults.xp };
    else if (target === 'games') next = { ...current, games: defaults.games };
    else if (target === 'features') next = { ...current, enabled: defaults.enabled };
    else if (target === 'roles') next = { ...current, roles: defaults.roles };
    else throw new Error(`Usage: ${prefix}settings reset <prefix|channels|xp|games|features|roles>`);
    return void await saveSettings(message, next, `Reset ${target} to this bot's safe defaults for this server.`);
  }
  throw new Error(`Unknown settings section. Try ${prefix}settings show.`);
}

async function startBj(message: Message, wager: number, settings: Awaited<ReturnType<typeof guildSettings>>) {
  validateBet(wager, settings.settings);
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const game = await openEscrowGame({ guildId: message.guildId!, type: 'bj', actorUserId: message.author.id, wager, state: startBlackjack(), fairness: fairnessMetadata(message.id), idempotencyKey: `bj:${message.id}`, configVersion: settings.version, curve: settings.settings.progression, expiresAt });
  if (game.status !== 'ACTIVE') return void await message.reply({ embeds: [embed('🂡 TBG Blackjack', 'This blackjack message was already settled.', COLORS.muted)] });
  const state = stateOf<BlackjackState>(game.state);
  scheduleExpiry(game.id, game.expiresAt ?? expiresAt, settings);
  if (isNaturalBlackjack(state.player) || isNaturalBlackjack(state.dealer)) {
    const final = dealerPlay(state); const result = blackjackResult(final); const payout = blackjackPayout(game.wager, result); const status = result === 'PUSH' ? 'DRAW' : payout > 0 ? 'WON' : 'LOST';
    await settleEscrowGame({ gameId: game.id, status, payout, state: { ...final, result, payout }, configVersion: settings.version, curve: settings.settings.progression });
    return void await message.reply({ embeds: [blackjackEmbed(final, game.wager, await balanceFor(game.guildId, game.actorUserId), true, result, payout)] });
  }
  await message.reply({ embeds: [blackjackEmbed(state, game.wager, await balanceFor(game.guildId, game.actorUserId))], components: gameButtons(game.id) });
}
async function startCrash(message: Message, wager: number, settings: Awaited<ReturnType<typeof guildSettings>>) {
  validateBet(wager, settings.settings);
  const fairness = fairnessMetadata(message.id); const startedAt = new Date(); const point = Math.min(10, crashPoint(fairness.seed));
  const game = await openEscrowGame({ guildId: message.guildId!, type: 'crash', actorUserId: message.author.id, wager, state: { startedAt: startedAt.toISOString(), crashPoint: point }, fairness, idempotencyKey: `crash:${message.id}`, configVersion: settings.version, curve: settings.settings.progression, expiresAt: new Date(Date.now() + 3 * 60_000) });
  if (game.status !== 'ACTIVE') return void await message.reply({ embeds: [embed('📈 TBG Crash', 'This crash message was already settled.', COLORS.muted)] });
  const state = stateOf<{ startedAt: string; crashPoint: number }>(game.state);
  scheduleCrash(game.id, state.crashPoint, new Date(state.startedAt), settings);
  await message.reply({ embeds: [crashEmbed('Multiplier is climbing from **1.00×**. Cash out before the crash.', game.wager, await balanceFor(game.guildId, game.actorUserId))], components: crashButtons(game.id) });
}
async function startCoinflip(message: Message, wager: number, settings: Awaited<ReturnType<typeof guildSettings>>) {
  validateBet(wager, settings.settings);
  if (!await claimCooldown(message.guildId!, message.author.id, 'coinflip', 3_000)) throw new Error('Coinflip is briefly on cooldown.');
  const heads = random.int(0, 1) === 0;
  const game = await playInstantEscrowGame({ guildId: message.guildId!, type: 'coinflip', actorUserId: message.author.id, wager, payout: heads ? wager * 2 : 0, status: heads ? 'WON' : 'LOST', state: { heads, payout: heads ? wager * 2 : 0 }, idempotencyKey: `coinflip:${message.id}`, configVersion: settings.version, curve: settings.settings.progression, expiresAt: new Date(Date.now() + 60_000) });
  const state = stateOf<{ heads: boolean; payout: number }>(game.state); const balance = await balanceFor(game.guildId, game.actorUserId);
  await message.reply({ embeds: [embed('🪙 TBG Coinflip', `The coin landed **${state.heads ? 'Heads' : 'Tails'}**.`, state.payout ? COLORS.success : COLORS.danger).addFields({ name: 'Stake', value: money(game.wager), inline: true }, { name: 'XP change', value: signedXp(state.payout - game.wager), inline: true }, { name: 'New balance', value: money(balance), inline: true })] });
}
async function startGamble(message: Message, wager: number, settings: Awaited<ReturnType<typeof guildSettings>>) {
  validateBet(wager, settings.settings);
  const outcome = d100(wager, settings.settings); const status = outcome.payout > wager ? 'WON' : outcome.payout === wager ? 'DRAW' : 'LOST';
  const game = await playInstantEscrowGame({ guildId: message.guildId!, type: 'gamble', actorUserId: message.author.id, wager, payout: outcome.payout, status, state: outcome, idempotencyKey: `gamble:${message.id}`, configVersion: settings.version, curve: settings.settings.progression, expiresAt: new Date(Date.now() + 60_000) });
  const state = stateOf<{ roll: number; payout: number; multiplierBps: number }>(game.state); const balance = await balanceFor(game.guildId, game.actorUserId);
  await message.reply({ embeds: [embed('🎲 TBG Gamble', `You rolled **${state.roll}** — ${state.payout ? `payout ${multiplier(state.multiplierBps)}` : 'no payout'}.`, state.payout > wager ? COLORS.success : state.payout === wager ? COLORS.warning : COLORS.danger).addFields(
    { name: 'Stake', value: money(game.wager), inline: true }, { name: 'Required roll', value: requiredGambleRoll(settings.settings), inline: true }, { name: 'XP change', value: signedXp(state.payout - game.wager), inline: true }, { name: 'New balance', value: money(balance), inline: true }, { name: 'Payout table', value: gambleTable(settings.settings), inline: false }
  )] });
}
async function startSlots(message: Message, wager: number, settings: Awaited<ReturnType<typeof guildSettings>>) {
  validateBet(wager, settings.settings);
  const outcome = slots(wager, settings.settings); const status = outcome.payout > wager ? 'WON' : outcome.payout === wager ? 'DRAW' : 'LOST';
  const game = await playInstantEscrowGame({ guildId: message.guildId!, type: 'slots', actorUserId: message.author.id, wager, payout: outcome.payout, status, state: outcome, idempotencyKey: `slots:${message.id}`, configVersion: settings.version, curve: settings.settings.progression, expiresAt: new Date(Date.now() + 60_000) });
  const state = stateOf<{ symbols: string[]; payout: number }>(game.state); const balance = await balanceFor(game.guildId, game.actorUserId);
  await message.reply({ embeds: [embed('🎰 TBG Slots', `**${state.symbols.join('  ')}**`, state.payout > wager ? COLORS.success : state.payout === wager ? COLORS.warning : COLORS.danger).addFields({ name: 'Stake', value: money(game.wager), inline: true }, { name: 'XP change', value: signedXp(state.payout - game.wager), inline: true }, { name: 'New balance', value: money(balance), inline: true })] });
}
async function startRobbery(message: Message, target: User, settings: Awaited<ReturnType<typeof guildSettings>>) {
  assertOtherHuman(target, message.author.id, 'rob'); const rules = settings.settings.games.rob;
  const result = await resolveRobbery({ guildId: message.guildId!, robberUserId: message.author.id, targetUserId: target.id, success: random.int(1, 10_000) <= rules.successChanceBps, minTransfer: rules.minTransfer, maxTransfer: rules.maxTransfer, failurePenalty: rules.failurePenalty, idempotencyKey: `rob:${message.id}`, configVersion: settings.version, curve: settings.settings.progression });
  const description = result.success ? `<@${message.author.id}> slipped past <@${target.id}> and stole **${money(result.amount)}**.` : `<@${message.author.id}> was caught by <@${target.id}> and paid **${money(result.amount)}**.`;
  await message.reply({ embeds: [embed('🥷 TBG Robbery', description, result.success ? COLORS.success : COLORS.danger).addFields({ name: 'Your XP change', value: signedXp(result.success ? result.amount : -result.amount), inline: true }, { name: 'Your balance', value: money(result.robberBalance), inline: true }, { name: 'Target balance', value: money(result.targetBalance), inline: true })] });
}
async function startDuel(message: Message, target: User, settings: Awaited<ReturnType<typeof guildSettings>>) {
  assertOtherHuman(target, message.author.id, 'duel'); const expiresAt = new Date(Date.now() + 2 * 60_000);
  const game = await prisma.game.upsert({ where: { idempotencyKey: `duel:${message.id}` }, create: { guildId: message.guildId!, type: 'duel', actorUserId: message.author.id, targetUserId: target.id, state: { challengedAt: new Date().toISOString() }, expiresAt, idempotencyKey: `duel:${message.id}` }, update: {} });
  scheduleSocialExpiry(game.id, game.expiresAt ?? expiresAt);
  await message.reply({ embeds: [embed('⚔️ TBG Duel', `<@${target.id}>, <@${message.author.id}> has challenged you.\n\nAccept within two minutes to fight for **${money(settings.settings.games.duelReward)}**.`, COLORS.warning)], components: duelButtons(game.id) });
}
async function startTicTacToe(message: Message, target: User) {
  assertOtherHuman(target, message.author.id, 'play tic-tac-toe with'); const expiresAt = new Date(Date.now() + 10 * 60_000); const state: TicTacToeState = { board: Array.from({ length: 9 }, () => null), turnUserId: message.author.id };
  const game = await prisma.game.upsert({ where: { idempotencyKey: `tictactoe:${message.id}` }, create: { guildId: message.guildId!, type: 'tictactoe', status: 'ACTIVE', actorUserId: message.author.id, targetUserId: target.id, state, expiresAt, idempotencyKey: `tictactoe:${message.id}` }, update: {} });
  const persisted = stateOf<TicTacToeState>(game.state); scheduleSocialExpiry(game.id, game.expiresAt ?? expiresAt);
  await message.reply({ embeds: [tttEmbed(game, persisted)], components: tttButtons(game.id, persisted.board) });
}

async function component(interaction: ButtonInteraction) {
  const [type, action, gameId, detail] = interaction.customId.split(':');
  if (!gameId) return;
  if (type === 'duel') return void await duelComponent(interaction, action ?? '', gameId);
  if (type === 'ttt') return void await ticTacToeComponent(interaction, action ?? '', gameId, detail);
  if (!['bj', 'crash'].includes(type ?? '')) return;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game || !gameMatchesInteractionGuild(game.guildId, interaction.guildId) || game.actorUserId !== interaction.user.id) return void await interaction.reply({ content: 'Only the player who opened this game can use these controls.', ephemeral: true });
  const settings = await guildSettings(game.guildId);
  if (game.status !== 'ACTIVE') return void await interaction.reply({ content: 'This game has already been settled.', ephemeral: true });
  if (game.expiresAt && game.expiresAt <= new Date()) {
    await settleEscrowGame({ gameId: game.id, status: 'EXPIRED', payout: 0, refund: true, state: { ...stateOf<object>(game.state), expired: true }, configVersion: settings.version, curve: settings.settings.progression });
    return void await interaction.update({ embeds: [embed('TBG Game Expired', 'Your escrow was refunded.', COLORS.warning)], components: [] });
  }
  if (type === 'crash' && action === 'cashout') return void await crashComponent(interaction, game, settings);
  if (type === 'bj') return void await blackjackComponent(interaction, game, settings, action ?? '');
}
async function crashComponent(interaction: ButtonInteraction, game: NonNullable<Awaited<ReturnType<typeof prisma.game.findUnique>>>, settings: Awaited<ReturnType<typeof guildSettings>>) {
  const state = stateOf<{ startedAt: string; crashPoint: number }>(game.state); const current = crashMultiplier(new Date(state.startedAt));
  if (current >= state.crashPoint) {
    await settleEscrowGame({ gameId: game.id, status: 'LOST', payout: 0, state: { ...state, crashedAt: state.crashPoint }, configVersion: settings.version, curve: settings.settings.progression });
    return void await interaction.update({ embeds: [crashEmbed(`Crashed at **${state.crashPoint.toFixed(2)}×**.`, game.wager, await balanceFor(game.guildId, game.actorUserId), COLORS.danger, state.crashPoint, 0)], components: [] });
  }
  const payout = Math.floor(game.escrow * current);
  await settleEscrowGame({ gameId: game.id, status: 'WON', payout, state: { ...state, cashedOutAt: current, payout }, configVersion: settings.version, curve: settings.settings.progression });
  await interaction.update({ embeds: [crashEmbed(`Cashed out at **${current.toFixed(2)}×**.`, game.wager, await balanceFor(game.guildId, game.actorUserId), COLORS.success, current, payout)], components: [] });
}
async function blackjackComponent(interaction: ButtonInteraction, game: NonNullable<Awaited<ReturnType<typeof prisma.game.findUnique>>>, settings: Awaited<ReturnType<typeof guildSettings>>, action: string) {
  let state = stateOf<BlackjackState>(game.state);
  if (action === 'hit') {
    state = hitBlackjack(state);
    if (blackjackValue(state.player) <= 21) {
      const changed = await updateActiveGame({ gameId: game.id, userId: interaction.user.id, expectedUpdatedAt: game.updatedAt, state });
      return void await interaction.update({ embeds: [blackjackEmbed(state, changed.wager, await balanceFor(game.guildId, game.actorUserId))], components: gameButtons(changed.id, false) });
    }
    await settleEscrowGame({ gameId: game.id, status: 'LOST', payout: 0, state: { ...state, result: 'PLAYER_BUST', payout: 0 }, configVersion: settings.version, curve: settings.settings.progression });
    return void await interaction.update({ embeds: [blackjackEmbed(state, game.wager, await balanceFor(game.guildId, game.actorUserId), true, 'PLAYER BUST', 0)], components: [] });
  }
  if (action === 'stand' || action === 'double') {
    if (action === 'double') {
      if (state.player.length !== 2 || state.doubled) return void await interaction.reply({ content: 'Double down is only available on your first decision.', ephemeral: true });
      state = { ...hitBlackjack(state), doubled: true };
      game = await doubleEscrowGame({ gameId: game.id, userId: interaction.user.id, expectedUpdatedAt: game.updatedAt, nextState: state, configVersion: settings.version, curve: settings.settings.progression });
    }
    const final = blackjackValue(state.player) > 21 ? state : dealerPlay(state); const result = blackjackResult(final); const payout = blackjackPayout(game.wager, result); const status = result === 'PUSH' ? 'DRAW' : payout > 0 ? 'WON' : 'LOST';
    await settleEscrowGame({ gameId: game.id, status, payout, state: { ...final, result, payout }, configVersion: settings.version, curve: settings.settings.progression });
    return void await interaction.update({ embeds: [blackjackEmbed(final, game.wager, await balanceFor(game.guildId, game.actorUserId), true, result, payout)], components: [] });
  }
  await interaction.reply({ content: 'Unknown game action.', ephemeral: true });
}
async function duelComponent(interaction: ButtonInteraction, action: string, gameId: string) {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game || game.type !== 'duel' || !gameMatchesInteractionGuild(game.guildId, interaction.guildId)) return void await interaction.reply({ content: 'That duel no longer exists.', ephemeral: true });
  if (game.targetUserId !== interaction.user.id) return void await interaction.reply({ content: 'Only the challenged player can accept or decline this duel.', ephemeral: true });
  if (game.status !== 'PENDING') return void await interaction.reply({ content: 'This duel has already been settled.', ephemeral: true });
  if (game.expiresAt && game.expiresAt <= new Date()) {
    const expired = await prisma.game.updateMany({ where: { id: game.id, status: 'PENDING' }, data: { status: 'EXPIRED', state: { expired: true } } });
    if (expired.count) return void await interaction.update({ embeds: [embed('⚔️ TBG Duel', 'The challenge expired.', COLORS.muted)], components: [] });
    return void await interaction.reply({ content: 'This duel has already been settled.', ephemeral: true });
  }
  if (action === 'decline') {
    const declined = await prisma.game.updateMany({ where: { id: game.id, status: 'PENDING' }, data: { status: 'CANCELLED', state: { declinedBy: interaction.user.id } } });
    if (!declined.count) return void await interaction.reply({ content: 'This duel has already been settled.', ephemeral: true });
    return void await interaction.update({ embeds: [embed('⚔️ TBG Duel', `<@${interaction.user.id}> declined the challenge.`, COLORS.muted)], components: [] });
  }
  if (action !== 'accept') return void await interaction.reply({ content: 'Unknown duel action.', ephemeral: true });
  const settings = await guildSettings(game.guildId); const winnerUserId = random.int(0, 1) === 0 ? game.actorUserId : game.targetUserId;
  const settled = await resolveDuel({ gameId: game.id, winnerUserId, reward: settings.settings.games.duelReward, configVersion: settings.version, curve: settings.settings.progression });
  const state = stateOf<{ winnerUserId?: string; reward?: number; balanceAfter?: number }>(settled.state);
  if (settled.status !== 'WON' || !state.winnerUserId || !state.reward || state.balanceAfter === undefined) return void await interaction.reply({ content: 'This duel has already been settled.', ephemeral: true });
  await interaction.update({ embeds: [embed('⚔️ TBG Duel', `<@${state.winnerUserId}> wins the duel!`, COLORS.success).addFields({ name: 'Reward', value: signedXp(state.reward), inline: true }, { name: 'Winner balance', value: money(state.balanceAfter), inline: true })], components: [] });
}
async function ticTacToeComponent(interaction: ButtonInteraction, action: string, gameId: string, detail: string | undefined) {
  if (action !== 'move') return void await interaction.reply({ content: 'Unknown board action.', ephemeral: true });
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game || game.type !== 'tictactoe' || !game.targetUserId || !gameMatchesInteractionGuild(game.guildId, interaction.guildId)) return void await interaction.reply({ content: 'That board no longer exists.', ephemeral: true });
  if (![game.actorUserId, game.targetUserId].includes(interaction.user.id)) return void await interaction.reply({ content: 'Only the two challenged players can use this board.', ephemeral: true });
  if (game.status !== 'ACTIVE') return void await interaction.reply({ content: 'This match has already ended.', ephemeral: true });
  const prior = stateOf<TicTacToeState>(game.state);
  if (game.expiresAt && game.expiresAt <= new Date()) {
    const expired = await prisma.game.updateMany({ where: { id: game.id, status: 'ACTIVE', updatedAt: game.updatedAt }, data: { status: 'EXPIRED', state: { ...prior, expired: true } } });
    if (expired.count) return void await interaction.update({ embeds: [embed('TBG Tic-Tac-Toe', 'This board expired.', COLORS.muted)], components: tttButtons(game.id, prior.board, true) });
    return void await interaction.reply({ content: 'The board changed; try again.', ephemeral: true });
  }
  const move = applyTicTacToeMove(prior, interaction.user.id, game.actorUserId, game.targetUserId, requireInteger(detail, 'a valid board position'));
  const changed = await prisma.game.updateMany({ where: { id: game.id, status: 'ACTIVE', updatedAt: game.updatedAt }, data: { status: move.winner === 'DRAW' ? 'DRAW' : move.winner ? 'WON' : 'ACTIVE', state: move.state } });
  if (!changed.count) return void await interaction.reply({ content: 'The board changed; try again.', ephemeral: true });
  await interaction.update({ embeds: [tttEmbed(game, move.state, move.winner)], components: tttButtons(game.id, move.state.board, move.winner !== null) });
}

function scheduleCrash(gameId: string, point: number, startedAt: Date, settings: Awaited<ReturnType<typeof guildSettings>>) {
  const delay = Math.max(0, Math.ceil((point - 1) / 0.06 * 1000));
  setTimeout(() => { void (async () => { const game = await prisma.game.findUnique({ where: { id: gameId } }); if (!game || game.status !== 'ACTIVE') return; await settleEscrowGame({ gameId, status: 'LOST', payout: 0, state: { ...stateOf<object>(game.state), crashedAt: point }, configVersion: settings.version, curve: settings.settings.progression }); })().catch(() => undefined); }, delay).unref();
}
function scheduleExpiry(gameId: string, expiresAt: Date, settings: Awaited<ReturnType<typeof guildSettings>>) {
  setTimeout(() => { void (async () => { const game = await prisma.game.findUnique({ where: { id: gameId } }); if (!game || game.status !== 'ACTIVE') return; await settleEscrowGame({ gameId, status: 'EXPIRED', payout: 0, refund: true, state: { ...stateOf<object>(game.state), expired: true }, configVersion: settings.version, curve: settings.settings.progression }); })().catch(() => undefined); }, Math.max(0, expiresAt.getTime() - Date.now())).unref();
}
function scheduleSocialExpiry(gameId: string, expiresAt: Date) {
  setTimeout(() => { void prisma.game.updateMany({ where: { id: gameId, status: { in: ['PENDING', 'ACTIVE'] } }, data: { status: 'EXPIRED', state: { expired: true } } }).catch(() => undefined); }, Math.max(0, expiresAt.getTime() - Date.now())).unref();
}

export async function recoverGames(log: pino.Logger) {
  const games = await prisma.game.findMany({ where: { status: { in: ['PENDING', 'ACTIVE'] } } });
  for (const game of games) {
    const settings = await guildSettings(game.guildId);
    if (game.type === 'crash') {
      const state = stateOf<{ startedAt: string; crashPoint: number }>(game.state); const startedAt = new Date(state.startedAt); const current = crashMultiplier(startedAt);
      if (current >= state.crashPoint) await settleEscrowGame({ gameId: game.id, status: 'LOST', payout: 0, state: { ...state, crashedAt: state.crashPoint, recovered: true }, configVersion: settings.version, curve: settings.settings.progression });
      else if (game.expiresAt && game.expiresAt <= new Date()) await settleEscrowGame({ gameId: game.id, status: 'EXPIRED', payout: 0, refund: true, state: { ...state, expired: true, recovered: true }, configVersion: settings.version, curve: settings.settings.progression });
      else scheduleCrash(game.id, state.crashPoint, startedAt, settings);
    } else if (game.type === 'bj') {
      if (game.expiresAt && game.expiresAt <= new Date()) await settleEscrowGame({ gameId: game.id, status: 'EXPIRED', payout: 0, refund: true, state: { ...stateOf<object>(game.state), expired: true, recovered: true }, configVersion: settings.version, curve: settings.settings.progression });
      else if (game.expiresAt) scheduleExpiry(game.id, game.expiresAt, settings);
    } else if (game.expiresAt && game.expiresAt <= new Date()) {
      await prisma.game.updateMany({ where: { id: game.id, status: { in: ['PENDING', 'ACTIVE'] } }, data: { status: 'EXPIRED', state: { ...stateOf<object>(game.state), expired: true, recovered: true } } });
    } else if (game.expiresAt) scheduleSocialExpiry(game.id, game.expiresAt);
  }
  if (games.length) log.info({ games: games.length }, 'Recovered unsettled games');
}

async function showRaffle(message: Message) {
  const day = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const raffle = await prisma.raffle.findUnique({ where: { guildId_day: { guildId: message.guildId!, day } } });
  await message.reply({ embeds: [raffle ? embed('🎟️ TBG Raffle', `Today's raffle is **${raffle.status}**.`, raffle.status === 'OPEN' ? COLORS.brand : COLORS.muted) : embed('🎟️ TBG Raffle', 'No raffle is open today.', COLORS.muted)] });
}
async function showQuests(message: Message) {
  const day = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const quests = await prisma.questProgress.findMany({ where: { guildId: message.guildId!, userId: message.author.id, day }, orderBy: { questKey: 'asc' } });
  await message.reply({ embeds: [quests.length ? embed('📜 TBG Quests', quests.map((quest) => `• **${quest.questKey}** — ${quest.progress}${quest.claimed ? ' (claimed)' : ''}`).join('\n')) : embed('📜 TBG Quests', 'No daily quest progress yet.', COLORS.muted)] });
}
async function showBounties(message: Message, targetArgument: string | undefined, prefix: string) {
  const target = targetArgument ? requireMention(message, targetArgument, `${prefix}bounty [@user]`) : null;
  const bounties = await prisma.bounty.findMany({ where: { guildId: message.guildId!, status: 'OPEN', expiresAt: { gt: new Date() }, ...(target ? { targetUserId: target.id } : {}) }, orderBy: { expiresAt: 'asc' }, take: 10 });
  const description = bounties.length ? bounties.map((bounty) => `• <@${bounty.targetUserId}> — ${money(bounty.escrow)} · expires <t:${Math.floor(bounty.expiresAt.getTime() / 1000)}:R>`).join('\n') : target ? `No open bounty for <@${target.id}>.` : 'No open bounties.';
  await message.reply({ embeds: [embed('🎯 TBG Bounty Board', description, bounties.length ? COLORS.warning : COLORS.muted)] });
}
async function adminCommand(message: Message, name: string, args: string[], config: AppConfig, settings: Awaited<ReturnType<typeof guildSettings>>) {
  const member = message.member as GuildMember | null; if (!member) throw new Error('Your guild membership could not be verified. Please try again.'); const guildId = message.guildId!; const guildOwnerId = message.guild?.ownerId; const prefix = settings.settings.prefix;
  if (name === 'admin-freeze') {
    if (!isGuildModeration(member, guildId, guildOwnerId, settings.settings, config)) throw new Error('Moderator authorization required.');
    const target = requireMention(message, args[0], `${prefix}admin-freeze @user <minutes> <reason>`); const minutes = requireInteger(args[1], `${prefix}admin-freeze @user <minutes> <reason>`); const reason = args.slice(2).join(' ');
    if (minutes < 1 || minutes > 10_080 || !reason || reason.length > 250) throw new Error(`Usage: ${prefix}admin-freeze @user <minutes 1-10080> <reason>`);
    const until = new Date(Date.now() + minutes * 60_000);
    await prisma.$transaction(async (tx) => { const frozen = await tx.member.upsert({ where: { guildId_userId: { guildId, userId: target.id } }, create: { guildId, userId: target.id }, update: {} }); await tx.member.update({ where: { id: frozen.id }, data: { frozenUntil: until, freezeReason: reason } }); await tx.auditLog.create({ data: { guildId, actorUserId: message.author.id, action: 'ACCOUNT_FROZEN', detail: { targetUserId: target.id, until: until.toISOString(), reason } } }); });
    return void await message.reply(`<@${target.id}> frozen until <t:${Math.floor(until.getTime() / 1000)}:f>.`);
  }
  if (!isGuildAdministrator(member, guildId, guildOwnerId, settings.settings, config)) throw new Error('Admin authorization required.');
  if (name === 'admin-settings-export') return void await message.reply(`\`\`\`json\n${JSON.stringify(settings.settings, null, 2)}\n\`\`\``);
  if (name === 'admin-settings') {
    const value = args[0]?.toLowerCase(); if (value !== 'on' && value !== 'off') throw new Error(`Usage: ${prefix}admin-settings <on|off>`); const maintenance = value === 'on';
    await updateSettings(guildId, { ...settings.settings, maintenance }, message.author.id); await prisma.guildConfig.update({ where: { guildId }, data: { maintenance } });
    return void await message.reply(`Maintenance mode ${maintenance ? 'enabled' : 'disabled'} and settings audit logged.`);
  }
}
