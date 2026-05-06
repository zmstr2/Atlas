import type { SpeakerRole } from '@atlas/types';

/**
 * Maps a local diarizer's stable speaker label (e.g. "speaker_0", "speaker_1")
 * onto Atlas's coaching role taxonomy. The Tauri Rust core hands us
 * arbitrary participant ids; only the founder + customer need real labels for
 * the suggester to fire correctly. Colleagues/other participants degrade
 * gracefully via the multiparty SpeakerRole.
 *
 * Defaults: the FIRST participant we see is treated as the founder (because the
 * desktop app is invoked by the founder on their own machine, so their voice
 * almost always speaks first). The user can override any role mid-call via
 * PATCH /calls/:callId/participants/:participantId.
 */
export class SpeakerMap {
  private readonly byParticipantId = new Map<string, SpeakerRole>();
  private readonly arrivalOrder: string[] = [];
  private explicitFounderId: string | null = null;

  /** Explicit override — usually called from a UI relabel action. */
  setRole(participantId: string, role: SpeakerRole): void {
    this.byParticipantId.set(participantId, role);
    if (role === 'founder') {
      this.explicitFounderId = participantId;
      // Demote any other participant previously inferred as founder.
      for (const [pid, r] of this.byParticipantId) {
        if (pid !== participantId && r === 'founder') {
          this.byParticipantId.set(pid, 'unknown');
        }
      }
    } else if (this.explicitFounderId === participantId) {
      this.explicitFounderId = null;
    }
  }

  /** Force-mark a specific participant as the founder. */
  setFounder(participantId: string): void {
    this.setRole(participantId, 'founder');
  }

  /**
   * Resolve a role for an incoming utterance. Records arrival order on first
   * sight; applies the heuristic (first speaker = founder) only when no
   * explicit role has been set yet.
   */
  getRole(participantId: string): SpeakerRole {
    if (!this.byParticipantId.has(participantId)) {
      this.arrivalOrder.push(participantId);
      // Heuristic: first speaker is the founder unless one was set explicitly.
      const inferred: SpeakerRole =
        this.arrivalOrder.length === 1 && !this.explicitFounderId ? 'founder' : 'unknown';
      this.byParticipantId.set(participantId, inferred);
    }
    return this.byParticipantId.get(participantId)!;
  }

  /** Returns the current mapping for persistence/UI. */
  snapshot(): Array<{ participantId: string; role: SpeakerRole }> {
    return Array.from(this.byParticipantId, ([participantId, role]) => ({ participantId, role }));
  }

  /** Hydrate from a stored mapping (e.g. on call recovery). */
  static fromSnapshot(snap: Array<{ participantId: string; role: SpeakerRole }>): SpeakerMap {
    const m = new SpeakerMap();
    for (const { participantId, role } of snap) {
      m.byParticipantId.set(participantId, role);
      m.arrivalOrder.push(participantId);
      if (role === 'founder') m.explicitFounderId = participantId;
    }
    return m;
  }
}
