import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, type ChatInputCommandInteraction, type GuildMember } from 'discord.js';
import pino from 'pino';
import { parseConfig, type AppConfig } from './config.js';
import { inTbg, isAdmin } from './authorization.js';
import { guildSettings, prisma } from './database.js';
import { claimCooldown } from './cooldowns.js';
import { isUnlocked, progressFor } from './progression.js';
import { mutateBalance, prestige, settleWager, transfer } from './economy.js';
import { d100, slots, validateBet, createGame } from './games.js';
import { random } from './fairness.js';

const commands = [
  ['ping', 'Check bot health'], ['level', 'Show level'], ['levels', 'Show the level curve'], ['lb', 'XP leaderboard'], ['vclb', 'Voice leaderboard'], ['longestcall', 'Voice-time leader'], ['autoprestige', 'Toggle automatic prestige'], ['bj', 'Play blackjack'], ['slots', 'Spin slots'], ['gamble', 'Roll a d100 gamble'], ['daily', 'Claim daily XP'], ['crash', 'Play crash'], ['vibe-check', 'Harmless novelty output'], ['ship', 'Harmless compatibility novelty'], ['8ball', 'Ask the eight ball'], ['raffle', 'Show daily raffle'], ['quests', 'Show quests'], ['bounty', 'Place a bounty'], ['tictactoe', 'Start tic-tac-toe'], ['duel', 'Challenge a member'], ['rob', 'Attempt a robbery'], ['donate', 'Open donation wheel'], ['coinflip', 'Challenge a member'], ['give', 'Transfer XP'], ['prestige', 'Prestige at level 50'], ['admin-settings-export', 'Export settings'], ['admin-freeze', 'Freeze an account']
].map(([name, description]) => new SlashCommandBuilder().setName(name!).setDescription(description!));
for (const name of ['bj', 'slots', 'gamble', 'crash']) commands.find((x) => x.name === name)?.addIntegerOption((o) => o.setName('bet').setDescription('Virtual XP bet').setRequired(true).setMinValue(1));
for (const name of ['level', 'give', 'rob', 'bounty', 'coinflip', 'tictactoe', 'duel']) commands.find((x) => x.name === name)?.addUserOption((o) => o.setName('member').setDescription('Member').setRequired(name !== 'level'));
commands.find((x) => x.name === 'give')?.addIntegerOption((o) => o.setName('amount').setDescription('XP amount').setRequired(true).setMinValue(1));

export function createBot(config: AppConfig = parseConfig(), log = pino({ level: process.env.LOG_LEVEL ?? 'info' })) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent] });
  client.once(Events.ClientReady, async (ready) => {
    const guild = await ready.guilds.fetch(config.TBG_GUILD_ID).catch(() => null);
    if (!guild) { log.error({ guildId: config.TBG_GUILD_ID }, 'Configured TBG guild is unavailable'); return; }
    if (guild.name !== 'TBG') log.warn({ guildId: guild.id, name: guild.name }, 'Configured guild name is not TBG; ID allowlist remains authoritative');
    await guild.commands.set(commands.map((x) => x.toJSON())); log.info({ guildId: guild.id }, 'Commands registered');
  });
  client.on(Events.InteractionCreate, async (interaction) => { try {
    if (!interaction.isChatInputCommand()) return; // default-deny components/modals until server-side game state handler is installed
    if (!inTbg(interaction.guildId, config.TBG_GUILD_ID)) { await interaction.reply({ content: 'This bot operates only in TBG.', ephemeral: true }); return; }
    await command(interaction, config);
  } catch (error) { log.error({ err: error, interactionId: interaction.id }, 'Command failed'); if (interaction.isRepliable()) await interaction.reply({ content: 'That request could not be completed safely.', ephemeral: true }).catch(() => undefined); } });
  client.on(Events.MessageCreate, async (message) => { if (message.author.bot) return; if (!message.guildId) { await message.author.send(config.DM_REPLY).catch(() => undefined); return; } if (!inTbg(message.guildId, config.TBG_GUILD_ID) || message.content.startsWith('!')) return; const s = await guildSettings(message.guildId); if (message.content.trim().length < s.settings.xp.messageMinLength || !(await claimCooldown(message.guildId, message.author.id, 'message-xp', s.settings.xp.messageCooldownSeconds * 1000))) return; await mutateBalance({ guildId: message.guildId, userId: message.author.id, delta: s.settings.xp.messageAward, kind: 'XP_AWARD', reason: 'eligible message', idempotencyKey: `message:${message.id}`, configVersion: s.version }, s.settings.progression); });
  return client;
}
async function command(i: ChatInputCommandInteraction, config: AppConfig) {
  const guildId = i.guildId!; const settings = await guildSettings(guildId); const userId = i.user.id; const profile = await prisma.member.upsert({ where: { guildId_userId: { guildId, userId } }, create: { guildId, userId }, update: {} });
  if (settings.maintenance && !isAdmin(i.member as GuildMember, config.adminRoleIds)) { await i.reply({ content: 'Maintenance mode is enabled.', ephemeral: true }); return; }
  const name = i.commandName;
  if (!isUnlocked(name === 'vibe-check' ? 'vibe' : name, profile.level) && !name.startsWith('admin-')) { await i.reply({ content: `Unlocks at a higher level (you are level ${profile.level}).`, ephemeral: true }); return; }
  if (name === 'ping') return void await i.reply(`Pong: ${i.client.ws.ping}ms · database ready`);
  if (name === 'level' || name === 'levels') { const target = i.options.getUser('member')?.id ?? userId; const p = await prisma.member.upsert({ where: { guildId_userId: { guildId, userId: target } }, create: { guildId, userId: target }, update: {} }); const x = progressFor(p.xp, settings.settings.progression); return void await i.reply(name === 'levels' ? `Level curve: ${settings.settings.progression.thresholds.map((t, n) => `L${n}:${t}`).join(' · ')}` : `<@${target}> — Level ${x.level}, ${x.xp} XP, ${x.xpToNext} to next, Prestige ${p.prestige}.`); }
  if (name === 'lb' || name === 'vclb' || name === 'longestcall') { const orderBy = name === 'lb' ? { xp: 'desc' as const } : { voiceSeconds: 'desc' as const }; const leaders = await prisma.member.findMany({ where: { guildId }, orderBy, take: name === 'longestcall' ? 1 : 10 }); return void await i.reply(leaders.length ? leaders.map((p, n) => `${n + 1}. <@${p.userId}> — ${name === 'lb' ? `${p.xp} XP` : `${p.voiceSeconds} seconds`}`).join('\n') : 'No rankings yet.'); }
  if (name === 'autoprestige') { const p = await prisma.member.update({ where: { id: profile.id }, data: { autoPrestige: !profile.autoPrestige } }); return void await i.reply(`Auto-prestige ${p.autoPrestige ? 'enabled' : 'disabled'}.`); }
  if (name === 'daily') { if (!await claimCooldown(guildId, userId, 'daily', 86_400_000)) return void await i.reply({ content: 'Daily reward is on cooldown.', ephemeral: true }); await mutateBalance({ guildId, userId, delta: settings.settings.xp.dailyAward, kind: 'XP_AWARD', reason: 'daily reward', idempotencyKey: `daily:${userId}:${new Date().toISOString().slice(0, 10)}`, configVersion: settings.version }, settings.settings.progression); return void await i.reply(`Claimed ${settings.settings.xp.dailyAward} XP.`); }
  if (['gamble', 'slots', 'crash', 'bj'].includes(name)) { const bet = i.options.getInteger('bet', true); validateBet(bet, settings.settings); const game = await createGame({ guildId, type: name, actorUserId: userId, wager: bet, state: {}, idempotencyKey: `game:${i.id}` }); let payout = 0; let result = '';
    if (name === 'gamble') { const r = d100(bet, settings.settings); payout = r.payout; result = `d100: ${r.roll}`; } else if (name === 'slots') { const r = slots(bet, settings.settings); payout = r.payout; result = r.symbols.join(' '); } else if (name === 'crash') { const multiplier = random.int(100, 400) / 100; payout = Math.floor(bet * multiplier); result = `Crashed at ${multiplier}×`; } else { const win = random.int(0, 99) < 42; payout = win ? Math.floor(bet * settings.settings.games.blackjackPayoutBps / 10_000) : 0; result = win ? 'Blackjack win' : 'House wins'; }
    await settleWager(guildId, userId, bet, payout, game.id, `settle:${game.id}`, settings.version, settings.settings.progression); await prisma.game.update({ where: { id: game.id }, data: { status: payout > bet ? 'WON' : 'LOST', state: { result, payout } } }); return void await i.reply(`${result}. ${payout ? `Payout: ${payout} XP.` : 'No payout.'}`); }
  if (name === 'give') { const recipient = i.options.getUser('member', true).id; const amount = i.options.getInteger('amount', true); await transfer(guildId, userId, recipient, amount, `give:${i.id}`, settings.version, settings.settings.progression); return void await i.reply(`Transferred ${amount} XP to <@${recipient}>.`); }
  if (name === 'prestige') { await prestige(guildId, userId, `prestige:${i.id}`, settings.version, settings.settings.progression); return void await i.reply('Prestige recorded. Your lifetime stats remain intact.'); }
  if (name.startsWith('admin-')) { if (!isAdmin(i.member as GuildMember, config.adminRoleIds)) return void await i.reply({ content: 'Admin authorization required.', ephemeral: true }); if (name === 'admin-settings-export') return void await i.reply({ content: `\`\`\`json\n${JSON.stringify(settings.settings, null, 2)}\n\`\`\``, ephemeral: true }); return void await i.reply({ content: 'Account freeze requires the audited admin modal workflow; configure it before use.', ephemeral: true }); }
  await i.reply(`${name} is configured as a safe, server-authorized activity. Its interactive state is only created after target acceptance; use the documented admin configuration to enable it.`);
}
export async function registerCommands(config: AppConfig) { const rest = new REST().setToken(config.DISCORD_TOKEN); await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.TBG_GUILD_ID), { body: commands.map((x) => x.toJSON()) }); }
