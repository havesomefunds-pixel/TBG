import { describe, expect, it } from 'vitest';
import { applyTicTacToeMove, parsePrefixCommand, ticTacToeWinner, type TicTacToeState } from '../src/bot.js';

describe('prefix command parser', () => {
  it('recognizes ! commands and normalizes the supported vibecheck alias', () => {
    expect(parsePrefixCommand('hello world')).toBeNull();
    expect(parsePrefixCommand('!BJ 100')).toEqual({ name: 'bj', args: ['100'] });
    expect(parsePrefixCommand('!vibe-check <@123>')).toEqual({ name: 'vibecheck', args: ['<@123>'] });
  });

  it('keeps quoted admin-freeze reasons together', () => {
    expect(parsePrefixCommand('!admin-freeze <@123> 30 "Repeated chargeback attempts"')).toEqual({ name: 'admin-freeze', args: ['<@123>', '30', 'Repeated chargeback attempts'] });
  });
});

describe('tic-tac-toe rules', () => {
  const players = { actor: 'x-player', target: 'o-player' };
  const initial = (): TicTacToeState => ({ board: Array.from({ length: 9 }, () => null), turnUserId: players.actor });

  it('enforces player ownership, alternating turns, and occupied cells', () => {
    expect(() => applyTicTacToeMove(initial(), 'spectator', players.actor, players.target, 0)).toThrow('Only the two challenged players');
    expect(() => applyTicTacToeMove(initial(), players.target, players.actor, players.target, 0)).toThrow('not your turn');
    const afterFirst = applyTicTacToeMove(initial(), players.actor, players.actor, players.target, 0).state;
    expect(() => applyTicTacToeMove(afterFirst, players.target, players.actor, players.target, 0)).toThrow('already taken');
  });

  it('detects a win and a draw', () => {
    let state = initial();
    state = applyTicTacToeMove(state, players.actor, players.actor, players.target, 0).state;
    state = applyTicTacToeMove(state, players.target, players.actor, players.target, 3).state;
    state = applyTicTacToeMove(state, players.actor, players.actor, players.target, 1).state;
    state = applyTicTacToeMove(state, players.target, players.actor, players.target, 4).state;
    expect(applyTicTacToeMove(state, players.actor, players.actor, players.target, 2).winner).toBe('X');
    expect(ticTacToeWinner(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'])).toBe('DRAW');
  });
});
