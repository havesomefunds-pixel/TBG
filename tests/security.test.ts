import { describe, expect, it } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { isGuildAdmin, isGuildModerator } from '../src/authorization.js';
import { parseConfig } from '../src/config.js';
import { defaultSettings } from '../src/default-settings.js';
describe('guild authorization and defaults', () => {
  const roleMember = (id: string, ownerId: string, roles: string[], permissions: unknown[] = []) => ({
    id,
    guild: { ownerId },
    roles: { cache: new Map(roles.map((x) => [x, true])) },
    permissions: { has: (permission: unknown) => permissions.includes(permission) }
  });

  it('allows a guild owner to bootstrap setup and settings with default roles', () => {
    const defaults = defaultSettings();
    const owner = roleMember('owner', 'owner', []);
    expect(isGuildAdmin(owner as never, defaults.roles.adminRoleId)).toBe(true);
    expect(isGuildAdmin(owner as never, defaults.roles.adminRoleId)).toBe(true);
  });

  it('allows a Discord Administrator to bootstrap setup and settings', () => {
    const administrator = roleMember('administrator', 'owner', [], [PermissionFlagsBits.Administrator]);
    expect(isGuildAdmin(administrator as never, null)).toBe(true);
    expect(isGuildAdmin(administrator as never, null)).toBe(true);
  });

  it('rejects a normal member from setup and settings administration', () => {
    expect(isGuildAdmin(roleMember('member', 'owner', []) as never, null)).toBe(false);
  });

  it('honors only the configured admin role for the current guild', () => {
    expect(isGuildAdmin(roleMember('role-user', 'owner', ['guild-a-admin']) as never, 'guild-a-admin')).toBe(true);
    expect(isGuildAdmin(roleMember('same-user', 'different-owner', ['guild-a-admin']) as never, 'guild-b-admin')).toBe(false);
  });

  it('does not grant legacy roles outside the legacy guild and preserves moderator access', () => {
    const legacyRoleUser = roleMember('user', 'owner', ['legacy-admin']);
    expect(isGuildAdmin(legacyRoleUser as never, null)).toBe(false);
    expect(isGuildModerator(roleMember('mod', 'owner', [], [PermissionFlagsBits.ModerateMembers]) as never, null, null)).toBe(true);
  });

  it('keeps setup authorization independent of level, channels, and feature settings', () => {
    const settings = defaultSettings();
    settings.allowedChannels = ['restricted-channel'];
    settings.enabled.setup = false;
    const owner = roleMember('owner', 'owner', []);
    expect(isGuildAdmin(owner as never, settings.roles.adminRoleId)).toBe(true);
  });

  it('authorizes a new-guild owner for the givexp admin path with no configured role', () => {
    const owner = roleMember('owner', 'owner', []);
    expect(isGuildAdmin(owner as never, defaultSettings().roles.adminRoleId)).toBe(true);
  });
  it('creates independent default setting objects for new guilds', () => {
    const guildA = defaultSettings(); const guildB = defaultSettings();
    guildA.prefix = '?'; guildA.enabled.blackjack = false;
    expect(guildB.prefix).toBe('!');
    expect(guildB.enabled.blackjack).toBeUndefined();
  });
  it('allows the legacy home-guild variable to be absent', () => {
    const config = parseConfig({ DISCORD_TOKEN: 'token', DISCORD_CLIENT_ID: 'client', DATABASE_URL: 'postgresql://user:password@localhost:5432/tbg' });
    expect(config.TBG_GUILD_ID).toBeUndefined();
  });
});
