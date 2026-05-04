import type { Utterance } from '@atlas/types';

export type ReplayOptions = {
  transcript: Utterance[];
  onUtterance: (utterance: Utterance) => void | Promise<void>;
  onEnd: () => void | Promise<void>;
  speedMultiplier?: number;
};

export class ReplayTimer {
  private paused = false;
  private stopped = false;
  private currentIndex = 0;
  private startWallTime = 0;
  private startMediaTime = 0;
  private timeouts: ReturnType<typeof setTimeout>[] = [];

  constructor(private opts: ReplayOptions) {}

  start() {
    this.startWallTime = Date.now();
    this.startMediaTime = 0;
    this.scheduleAll();
  }

  pause(atMediaTimeMs: number) {
    this.paused = true;
    this.startMediaTime = atMediaTimeMs;
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts = [];
  }

  resume(atMediaTimeMs: number) {
    if (!this.paused) return;
    this.paused = false;
    this.startWallTime = Date.now();
    this.startMediaTime = atMediaTimeMs;
    this.scheduleFrom(atMediaTimeMs);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts = [];
  }

  private scheduleAll() {
    this.scheduleFrom(0);
  }

  private scheduleFrom(fromMs: number) {
    const speed = this.opts.speedMultiplier ?? 1;
    const { transcript } = this.opts;

    for (let i = 0; i < transcript.length; i++) {
      const u = transcript[i];
      if (u.startMs < fromMs) continue;

      const delay = (u.startMs - fromMs) / speed;
      const t = setTimeout(async () => {
        if (this.stopped || this.paused) return;
        this.currentIndex = i;
        await this.opts.onUtterance(u);
      }, delay);
      this.timeouts.push(t);
    }

    // end event — 500ms grace period also scaled by speed
    const lastMs = transcript[transcript.length - 1]?.endMs ?? 0;
    const endDelay = (lastMs - fromMs + 500) / speed;
    const t = setTimeout(async () => {
      if (this.stopped || this.paused) return;
      await this.opts.onEnd();
    }, endDelay);
    this.timeouts.push(t);
  }
}
