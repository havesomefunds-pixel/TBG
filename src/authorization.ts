import type { PermissionResolvable } from 'discord.js';
export type MemberLike = { permissions: { has(permission: PermissionResolvable): boolean }; roles: { cache: Map<string, unknown> } };
export function isAdmin(member: MemberLike, roleIds: Set<string>): boolean { return member.permissions.has('Administrator') || [...roleIds].some((id) => member.roles.cache.has(id)); }
export function isModerator(member: MemberLike, adminIds: Set<string>, moderatorIds: Set<string>): boolean { return isAdmin(member, adminIds) || member.permissions.has('ModerateMembers') || [...moderatorIds].some((id) => member.roles.cache.has(id)); }
export function inTbg(guildId: string | null | undefined, tbgGuildId: string): boolean { return guildId === tbgGuildId; }
