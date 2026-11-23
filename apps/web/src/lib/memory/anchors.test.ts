import { describe, test, expect } from 'bun:test';
import { detectAnchorContradictions } from './anchors';
import { createEmptyMemory } from './store';

describe('detectAnchorContradictions', () => {
  test('budget anchor $30-50k + rep pitches $100k → contradiction', () => {
    const memory = createEmptyMemory();
    memory.verbatimAnchors.push({
      turnId: 't08', axis: 'budget',
      verbatim: 'budget is around 30 to 50k for this',
      utteranceIds: ['u8'],
    });
    const out = detectAnchorContradictions(memory, 'we have a great package at $100k');
    expect(out.length).toBe(1);
    expect(out[0].axis).toBe('budget');
  });

  test('budget anchor + rep pitch within range → no contradiction', () => {
    const memory = createEmptyMemory();
    memory.verbatimAnchors.push({
      turnId: 't08', axis: 'budget',
      verbatim: '30 to 50 thousand',
      utteranceIds: ['u8'],
    });
    const out = detectAnchorContradictions(memory, 'our $40k tier looks like a great fit');
    expect(out.length).toBe(0);
  });

  test('authority cap $25k + rep mentions $50k → contradiction', () => {
    const memory = createEmptyMemory();
    memory.verbatimAnchors.push({
      turnId: 't10', axis: 'authority',
      verbatim: 'I sign up to twenty-five thousand without going to the CFO',
      utteranceIds: ['u10'],
    });
    const out = detectAnchorContradictions(memory, 'this would be around $50k for what you need');
    expect(out.length).toBe(1);
    expect(out[0].axis).toBe('authority');
  });

  test('no numeric mention → no contradiction', () => {
    const memory = createEmptyMemory();
    memory.verbatimAnchors.push({
      turnId: 't08', axis: 'budget',
      verbatim: '30 to 50k',
      utteranceIds: ['u8'],
    });
    const out = detectAnchorContradictions(memory, 'let me show you how the demo flows');
    expect(out.length).toBe(0);
  });

  test('non-budget non-authority anchor → no contradiction triggered', () => {
    const memory = createEmptyMemory();
    memory.verbatimAnchors.push({
      turnId: 't12', axis: 'timeline',
      verbatim: 'end of Q2',
      utteranceIds: ['u12'],
    });
    const out = detectAnchorContradictions(memory, 'we could ship by $200k of effort');
    // timeline anchor doesn't engage the contradiction detector for $ amounts
    expect(out.length).toBe(0);
  });
});
