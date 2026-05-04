import type { Utterance } from '@atlas/types';

export type HotTailEntry = {
  id: string;
  speaker: 'rep' | 'customer';
  text: string;
  ts: number;
};

const DEFAULT_K = 5;

/**
 * Synchronous ring buffer of the last K raw utterances. No LLM, never lags.
 * Suggesters read this as ground truth for "what was literally just said,"
 * regardless of whether the structured memory has caught up.
 */
export class HotTail {
  private buf: HotTailEntry[] = [];
  constructor(private readonly k: number = DEFAULT_K) {}

  push(u: Utterance): void {
    this.buf.push({ id: u.id, speaker: u.speaker, text: u.text, ts: Date.now() });
    if (this.buf.length > this.k) this.buf.shift();
  }

  /** Returns a snapshot copy ordered oldest → newest. */
  snapshot(): HotTailEntry[] {
    return [...this.buf];
  }

  /** Most recent utterance from the *other* speaker (for short-answer interpretation). */
  lastFromOtherSpeaker(currentSpeaker: 'rep' | 'customer'): HotTailEntry | null {
    for (let i = this.buf.length - 1; i >= 0; i--) {
      if (this.buf[i].speaker !== currentSpeaker) return this.buf[i];
    }
    return null;
  }

  size(): number { return this.buf.length; }
  capacity(): number { return this.k; }
}
