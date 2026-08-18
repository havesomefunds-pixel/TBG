import { describe, expect, it } from 'vitest';
import { isGuildAdmin, isGuildModerator } from '../src/authorization.js';
import { parseConfig } from '../src/config.js';
import { defaultSettings } from '../src/default-settings.js';
describe('guild authorization and defaults', () => {
  const roleMember = (id: string, roles: string[], permissions: string[] = []) => ({ id, roles: { cache: new Map(roles.map((x) => [x, true])) }, permissions: { has: (p: string) => permissions.includes(p) } });
  it('honors a guild owner, Administrator, and current-guild configured role', () => {
    expect(isGuildAdmin(roleMember('owner', []) as never, 'owner', null)).toBe(true);
    expect(isGuildAdmin(roleMember('admin', [], ['Administrator']) as never, 'owner', null)).toBe(true);
    expect(isGuildAdmin(roleMember('role-user', ['guild-admin']) as never, 'owner', 'guild-admin')).toBe(true);
    expect(isGuildAdmin(roleMember('other', ['guild-admin']) as never, 'owner', null)).toBe(false);
  });
  it('does not grant a legacy role to a new guild and honors moderation permission', () => {
    expect(isGuildAdmin(roleMember('user', ['legacy-admin']) as never, 'owner', null)).toBe(false);
    expect(isGuildModerator(roleMember('mod', [], ['ModerateMembers']) as never, 'owner', null, null)).toBe(true);
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
