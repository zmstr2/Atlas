import type { Utterance, PreCallBrief, MemoryPatch, Suggestion } from '@atlas/types';
import { MemoryStore } from '../memory/store';
import { HotTail } from '../memory/hotTail';
import { buildCallFactsUI } from '../memory/factsUI';
import { runMemoryAgent } from '../agents/memoryAgent';
import { runPanelAgent, shouldRunPanelAgent } from '../agents/panelAgent';
import { runProspectSuggester } from '../agents/prospectSuggester';
import { runRepWatcher } from '../agents/repWatcher';
import { runSuggester, type RecentSuggestionEntry } from '../agents/suggester';
import { broadcastEvent, updateSessionMemory } from '../sse/handler';
import { saveMemorySnapshot, recordUtterance, recordSuggestion } from '../db/sqlite';

export type PipelineSession = {
  callId: string;
  brief: PreCallBrief;
  store: MemoryStore;
  hotTail: HotTail;
  transcript: Utterance[];
  turnCounter: number;
  snapshotDebounce: ReturnType<typeof setTimeout> | null;
  snapshotPatchCount: number;
  lastSuggestionTurn: number | null;
  lastSuggestionAgent: 'prospect_suggester' | 'rep_watcher' | null;
  recentSuggestions: RecentSuggestionEntry[];
};

const RECENT_SUGGESTIONS_WINDOW = 6;
const SUGGESTER_MODE = (process.env.SUGGESTER_MODE ?? 'merged') as 'split' | 'merged';

export function createPipelineSession(callId: string, brief: PreCallBrief): PipelineSession {
  const store = new MemoryStore();
  const hotTail = new HotTail(5);

  const session: PipelineSession = {
    callId,
    brief,
    store,
    hotTail,
    transcript: [],
    turnCounter: 0,
    snapshotDebounce: null,
    snapshotPatchCount: 0,
    lastSuggestionTurn: null,
    lastSuggestionAgent: null,
    recentSuggestions: [],
  };

  store.onChange((memory, utteranceId) => {
    updateSessionMemory(callId, memory);
    broadcastEvent(callId, { type: 'memory_diff', snapshot: memory, utteranceId });

    session.snapshotPatchCount++;
    if (session.snapshotDebounce) clearTimeout(session.snapshotDebounce);
    if (session.snapshotPatchCount >= 5) {
      setImmediate(() => saveMemorySnapshot(callId, memory));
      session.snapshotPatchCount = 0;
    } else {
      session.snapshotDebounce = setTimeout(() => {
        const snap = store.snapshot;
        setImmediate(() => saveMemorySnapshot(callId, snap));
        session.snapshotPatchCount = 0;
      }, 2000);
    }
  });

  return session;
}

function nextTurnId(session: PipelineSession): string {
  session.turnCounter += 1;
  return `t${String(session.turnCounter).padStart(3, '0')}`;
}

function shouldBroadcastSuggestion(session: PipelineSession, s: Suggestion): boolean {
  if (!s.shouldFire) return false;
  if (s.priority === 'fyi') return false;
  if (s.priority === 'critical') return true;
  // Cross-agent stacking gate is only meaningful in split mode; in merged mode
  // the single agent self-paces through recentSuggestions.
  if (
    SUGGESTER_MODE === 'split' &&
    s.agent === 'rep_watcher' &&
    session.lastSuggestionAgent === 'prospect_suggester' &&
    session.lastSuggestionTurn === session.turnCounter - 1
  ) {
    return false;
  }
  return true;
}

function pushRecent(session: PipelineSession, s: Suggestion, fired: boolean, speaker: 'rep' | 'customer') {
  session.recentSuggestions.push({
    turn: session.turnCounter,
    speaker,
    agent: s.agent,
    fired,
    priority: s.priority,
    play: s.play,
    markdown: s.markdown,
  });
  if (session.recentSuggestions.length > RECENT_SUGGESTIONS_WINDOW) {
    session.recentSuggestions.splice(0, session.recentSuggestions.length - RECENT_SUGGESTIONS_WINDOW);
  }
}

export async function processUtterance(session: PipelineSession, utterance: Utterance) {
  const { callId, brief, store, hotTail, transcript } = session;

  // Synchronous bookkeeping
  transcript.push(utterance);
  hotTail.push(utterance);
  store.recordUtteranceStats(utterance.speaker, utterance.text);
  recordUtterance(callId, utterance);
  broadcastEvent(callId, { type: 'utterance', utterance });
  broadcastEvent(callId, { type: 'pulse', utteranceId: utterance.id });

  // Snapshot from PREVIOUS turn — current utterance hasn't been digested yet.
  // Suggesters read this + hotTail (which IS current).
  const prevMemory = store.snapshot;
  const tail = hotTail.snapshot();
  const turnId = nextTurnId(session);

  // Suggester dispatch — split (legacy) vs merged (one agent, self-pacing).
  const suggesterPromise: Promise<Suggestion> = SUGGESTER_MODE === 'merged'
    ? runSuggester({
        utterance,
        hotTail: tail,
        prevMemory,
        brief,
        recentSuggestions: [...session.recentSuggestions],
      })
    : utterance.speaker === 'customer'
      ? runProspectSuggester({ utterance, hotTail: tail, prevMemory, brief })
      : runRepWatcher({ utterance, hotTail: tail, prevMemory, brief });

  // Memory agent (NON-BLOCKING, runs in parallel)
  const memoryPromise = runMemoryAgent({
    utterance,
    turnId,
    prevMemory,
    hotTail: tail,
  });

  // Await suggester first (rep needs the suggestion fast)
  try {
    const suggestion = await suggesterPromise;
    if (shouldBroadcastSuggestion(session, suggestion)) {
      broadcastEvent(callId, {
        type: 'suggestion',
        utteranceId: utterance.id,
        suggestion,
      });
      session.lastSuggestionTurn = session.turnCounter;
      session.lastSuggestionAgent = suggestion.agent;
      pushRecent(session, suggestion, true, utterance.speaker);
      recordSuggestion(callId, utterance.id, session.turnCounter, suggestion, false);
    } else if (suggestion.shouldFire) {
      // Record what the model wanted to fire even when gated, so we can audit
      // suppression decisions offline. Also feed the recent-suggestions window so
      // the merged agent can see what it almost-fired.
      pushRecent(session, suggestion, false, utterance.speaker);
      recordSuggestion(callId, utterance.id, session.turnCounter, suggestion, true);
    } else {
      // Model chose silence. Push to the in-memory window (not the DB) so the
      // cadence rule "3 of last 5 fired" measures last-5-TURNS, not
      // last-5-fire-attempts. Without this, a model that's correctly silent for
      // 10 turns still sees "3 of last 5 fired" in its prompt and over-throttles.
      pushRecent(session, suggestion, false, utterance.speaker);
    }
  } catch (err) {
    console.error('[pipeline] suggester failed', utterance.id, err);
  }

  // Memory agent completes in background; apply patch + emit facts UI when ready.
  // Panel agent runs after, conditionally, to rewrite the rep-facing memory panel
  // from accumulated state (separate cadence from extraction).
  memoryPromise
    .then(async (patch: MemoryPatch) => {
      try {
        store.applyMemoryPatch(patch);
        broadcastEvent(callId, {
          type: 'memory_patch_applied',
          utteranceId: utterance.id,
          turnId,
        });
        if (utterance.speaker === 'customer') {
          const ui = buildCallFactsUI(store.snapshot);
          broadcastEvent(callId, { type: 'facts_ui_delta', ui });
        }

        if (shouldRunPanelAgent(patch)) {
          try {
            const panel = await runPanelAgent({ memory: store.snapshot });
            const changed = store.applyPanelPatch(panel, turnId);
            if (changed) {
              updateSessionMemory(callId, store.snapshot);
              const ui = buildCallFactsUI(store.snapshot);
              broadcastEvent(callId, { type: 'facts_ui_delta', ui });
            }
          } catch (panelErr) {
            console.error('[pipeline] panel agent failed', utterance.id, panelErr);
          }
        }
      } catch (err) {
        console.error('[pipeline] applyMemoryPatch failed', utterance.id, err);
      }
    })
    .catch((err) => {
      console.error('[pipeline] memory agent failed', utterance.id, err);
    });
}

const activeSessions = new Map<string, PipelineSession>();

export function registerSession(session: PipelineSession) {
  activeSessions.set(session.callId, session);
}

export function getSession(callId: string): PipelineSession | undefined {
  return activeSessions.get(callId);
}

export function removeSession(callId: string) {
  activeSessions.delete(callId);
}
