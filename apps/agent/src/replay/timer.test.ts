import { describe, test, expect } from 'bun:test';
import { ReplayTimer } from './timer';
import type { Utterance } from '@atlas/types';

const makeUtterance = (id: string, speaker: 'rep' | 'customer', startMs: number, endMs: number): Utterance => ({
  id,
  speaker,
  text: `Text for ${id}`,
  startMs,
  endMs,
  confidence: 1,
  derivedFromLowConfidence: false,
});

describe('ReplayTimer', () => {
  test('fires utterances in timestamp order', async () => {
    const transcript: Utterance[] = [
      makeUtterance('u1', 'rep', 0, 1000),
      makeUtterance('u2', 'customer', 1100, 2000),
      makeUtterance('u3', 'rep', 2100, 3000),
    ];

    const fired: string[] = [];
    let ended = false;

    const timer = new ReplayTimer({
      transcript,
      speedMultiplier: 100, // 100x speed for tests
      onUtterance: (u) => { fired.push(u.id); },
      onEnd: () => { ended = true; },
    });

    timer.start();

    // Wait for all events at 100x speed: last utterance at 3000ms / 100 = 30ms + 500ms end buffer / 100 = 5ms
    await new Promise(r => setTimeout(r, 100));

    expect(fired).toEqual(['u1', 'u2', 'u3']);
    expect(ended).toBe(true);
  });

  test('pause stops firing new events', async () => {
    const transcript: Utterance[] = [
      makeUtterance('u1', 'rep', 0, 500),
      makeUtterance('u2', 'customer', 100, 600),
      makeUtterance('u3', 'rep', 5000, 6000), // far in the future
    ];

    const fired: string[] = [];
    const timer = new ReplayTimer({
      transcript,
      speedMultiplier: 10,
      onUtterance: (u) => { fired.push(u.id); },
      onEnd: () => {},
    });

    timer.start();
    await new Promise(r => setTimeout(r, 30));
    timer.pause(600); // pause at 600ms media time

    const firedAtPause = [...fired];
    await new Promise(r => setTimeout(r, 100));

    // No new events fired after pause
    expect(fired).toEqual(firedAtPause);
    expect(fired).not.toContain('u3');

    timer.stop();
  });

  test('stop prevents all future events', async () => {
    const transcript: Utterance[] = [
      makeUtterance('u1', 'rep', 0, 100),
      makeUtterance('u2', 'customer', 200, 300),
    ];

    const fired: string[] = [];
    const timer = new ReplayTimer({
      transcript,
      speedMultiplier: 1,
      onUtterance: (u) => { fired.push(u.id); },
      onEnd: () => {},
    });

    timer.start();
    timer.stop(); // stop immediately

    await new Promise(r => setTimeout(r, 400));
    expect(fired).toHaveLength(0);
  });
});
