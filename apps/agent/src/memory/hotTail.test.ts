import { describe, test, expect } from 'bun:test';
import { HotTail } from './hotTail';
import type { Utterance } from '@atlas/types';

function u(id: string, speaker: 'rep' | 'customer', text: string): Utterance {
  return { id, speaker, text, startMs: 0, endMs: 0, confidence: 1, derivedFromLowConfidence: false };
}

describe('HotTail', () => {
  test('FIFO with K=5 cap', () => {
    const tail = new HotTail(5);
    for (let i = 0; i < 6; i++) {
      tail.push(u(`u${i}`, i % 2 === 0 ? 'rep' : 'customer', `text ${i}`));
    }
    const snap = tail.snapshot();
    expect(snap.length).toBe(5);
    expect(snap[0].id).toBe('u1'); // u0 evicted
    expect(snap[4].id).toBe('u5');
  });

  test('preserves speaker tags', () => {
    const tail = new HotTail();
    tail.push(u('a', 'rep', 'hi'));
    tail.push(u('b', 'customer', 'yes'));
    tail.push(u('c', 'rep', 'why'));
    const snap = tail.snapshot();
    expect(snap.map((h) => h.speaker)).toEqual(['rep', 'customer', 'rep']);
  });

  test('lastFromOtherSpeaker', () => {
    const tail = new HotTail();
    tail.push(u('a', 'rep', 'do you have budget?'));
    tail.push(u('b', 'customer', 'yes'));
    expect(tail.lastFromOtherSpeaker('customer')?.id).toBe('a');
    expect(tail.lastFromOtherSpeaker('rep')?.id).toBe('b');
  });

  test('lastFromOtherSpeaker returns null when none', () => {
    const tail = new HotTail();
    tail.push(u('a', 'rep', 'hi'));
    expect(tail.lastFromOtherSpeaker('rep')).toBeNull();
  });
});
