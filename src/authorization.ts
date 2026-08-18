import { PermissionFlagsBits, type PermissionResolvable } from 'discord.js';

export type GuildMemberLike = {
  id: string;
  guild: { ownerId: string };
  permissions: { has(permission: PermissionResolvable): boolean };
  roles: { cache: Map<string, unknown> };
};

function hasAnyRole(member: GuildMemberLike, roleIds: Iterable<string>): boolean {
  return [...roleIds].some((id) => member.roles.cache.has(id));
}

/**
 * Canonical authorization for guild administration. The owner check is
 * intentionally derived from the member's guild so it cannot depend on a
 * configured role, an unrelated guild, or a separately supplied owner ID.
 */
export function isGuildAdmin(member: GuildMemberLike, configuredRoleId: string | null | undefined, legacyRoleIds: Set<string> = new Set()): boolean {
  return member.id === member.guild.ownerId
    || member.permissions.has(PermissionFlagsBits.Administrator)
    || hasAnyRole(member, [...legacyRoleIds, ...(configuredRoleId ? [configuredRoleId] : [])]);
}

export function isGuildModerator(member: GuildMemberLike, configuredAdminRoleId: string | null | undefined, configuredModeratorRoleId: string | null | undefined, legacyAdminRoleIds: Set<string> = new Set(), legacyModeratorRoleIds: Set<string> = new Set()): boolean {
  if (isGuildAdmin(member, configuredAdminRoleId, legacyAdminRoleIds)) return true;
  return member.permissions.has(PermissionFlagsBits.ModerateMembers)
    || hasAnyRole(member, [...legacyModeratorRoleIds, ...(configuredModeratorRoleId ? [configuredModeratorRoleId] : [])]);
}
