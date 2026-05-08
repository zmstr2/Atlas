import { describe, test, expect } from 'bun:test';
import { SpeakerMap } from './speakerMap';

describe('SpeakerMap', () => {
  test('first speaker inferred as founder, rest unknown', () => {
    const m = new SpeakerMap();
    expect(m.getRole('speaker_0')).toBe('founder');
    expect(m.getRole('speaker_1')).toBe('unknown');
    expect(m.getRole('speaker_2')).toBe('unknown');
  });

  test('explicit setRole overrides heuristic', () => {
    const m = new SpeakerMap();
    m.setFounder('speaker_3');
    expect(m.getRole('speaker_3')).toBe('founder');
    // First-arrival heuristic should NOT promote speaker_0 to founder
    // since one was set explicitly.
    expect(m.getRole('speaker_0')).toBe('unknown');
  });

  test('reassigning founder demotes prior founder', () => {
    const m = new SpeakerMap();
    expect(m.getRole('speaker_0')).toBe('founder'); // heuristic
    m.setFounder('speaker_1');
    expect(m.getRole('speaker_0')).toBe('unknown');
    expect(m.getRole('speaker_1')).toBe('founder');
  });

  test('setRole supports multiparty roles', () => {
    const m = new SpeakerMap();
    m.setRole('speaker_0', 'founder');
    m.setRole('speaker_1', 'customer');
    m.setRole('speaker_2', 'colleague');
    m.setRole('speaker_3', 'other');
    expect(m.getRole('speaker_0')).toBe('founder');
    expect(m.getRole('speaker_1')).toBe('customer');
    expect(m.getRole('speaker_2')).toBe('colleague');
    expect(m.getRole('speaker_3')).toBe('other');
  });

  test('snapshot + fromSnapshot round-trip', () => {
    const m = new SpeakerMap();
    m.setRole('a', 'founder');
    m.setRole('b', 'customer');
    m.getRole('c'); // unknown via heuristic-skip (not first)

    const snap = m.snapshot();
    const m2 = SpeakerMap.fromSnapshot(snap);
    expect(m2.getRole('a')).toBe('founder');
    expect(m2.getRole('b')).toBe('customer');
    expect(m2.getRole('c')).toBe('unknown');

    // New participant arriving after hydration → unknown (existing founder set)
    expect(m2.getRole('d')).toBe('unknown');
  });
});
