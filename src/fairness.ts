import { createHash, randomInt, randomUUID } from 'node:crypto';
export const random = { int: (min: number, max: number) => randomInt(min, max + 1), id: () => randomUUID() };
export function fairnessMetadata(gameId: string) { const seed = randomUUID(); return { commitment: createHash('sha256').update(`${seed}:${gameId}`).digest('hex'), seed }; }
