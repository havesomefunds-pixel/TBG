import { describe, expect, it } from 'vitest';
import { inTbg, isAdmin, isModerator } from '../src/authorization.js';
describe('TBG boundary and authorization', () => {
  const roleMember = (roles: string[], permissions: string[] = []) => ({ roles: { cache: new Map(roles.map((x) => [x, true])) }, permissions: { has: (p: string) => permissions.includes(p) } });
  it('accepts only the configured guild ID', () => { expect(inTbg('123', '123')).toBe(true); expect(inTbg('TBG', '123')).toBe(false); expect(inTbg(undefined, '123')).toBe(false); });
  it('uses roles or Discord permissions, never usernames', () => { expect(isAdmin(roleMember(['admin']) as never, new Set(['admin']))).toBe(true); expect(isModerator(roleMember(['mod']) as never, new Set(), new Set(['mod']))).toBe(true); expect(isAdmin(roleMember([]) as never, new Set(['admin']))).toBe(false); });
});
