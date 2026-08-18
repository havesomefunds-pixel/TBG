import type { PermissionResolvable } from 'discord.js';
export type MemberLike = { id?: string; permissions: { has(permission: PermissionResolvable): boolean }; roles: { cache: Map<string, unknown> } };
export function isAdmin(member: MemberLike, roleIds: Set<string>): boolean { return member.permissions.has('Administrator') || [...roleIds].some((id) => member.roles.cache.has(id)); }
export function isModerator(member: MemberLike, adminIds: Set<string>, moderatorIds: Set<string>): boolean { return isAdmin(member, adminIds) || member.permissions.has('ModerateMembers') || [...moderatorIds].some((id) => member.roles.cache.has(id)); }

/**
 * Guild ownership is a recovery path for configuration. Configured roles are
 * supplied by the current guild only; legacy roles are added only by the
 * caller for the optional home guild.
 */
export function isGuildAdmin(member: MemberLike, guildOwnerId: string | null | undefined, configuredRoleId: string | null | undefined, legacyRoleIds: Set<string> = new Set()): boolean {
  return Boolean(guildOwnerId && member.id === guildOwnerId) || isAdmin(member, new Set([...legacyRoleIds, ...(configuredRoleId ? [configuredRoleId] : [])]));
}

export function isGuildModerator(member: MemberLike, guildOwnerId: string | null | undefined, configuredAdminRoleId: string | null | undefined, configuredModeratorRoleId: string | null | undefined, legacyAdminRoleIds: Set<string> = new Set(), legacyModeratorRoleIds: Set<string> = new Set()): boolean {
  if (isGuildAdmin(member, guildOwnerId, configuredAdminRoleId, legacyAdminRoleIds)) return true;
  return member.permissions.has('ModerateMembers') || [...legacyModeratorRoleIds, ...(configuredModeratorRoleId ? [configuredModeratorRoleId] : [])].some((id) => member.roles.cache.has(id));
}
