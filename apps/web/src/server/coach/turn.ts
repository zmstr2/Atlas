import { MemoryStore } from '@/lib/memory/store';
import type { Utterance } from '@atlas/types';
import type { HotTailEntry } from '@/lib/memory/hotTail';
import type { TurnRequest, TurnEvent } from '@/lib/coach/protocol';
import { runMemoryAgent } from '../agents/memoryAgent';
import { runPanelAgent, shouldRunPanelAgent } from '../agents/panelAgent';
import { runProspectSuggester } from '../agents/prospectSuggester';
import { runRepWatcher } from '../agents/repWatcher';
import { BRIEFS } from './context';

/**
 * Process one finalized utterance. Same pipeline the old WebSocket server ran,
 * but stateless: everything it needs arrives in `req.snapshot`, and results are
 * pushed through `emit` as they finish (suggestion and memory run in parallel).
 */
export async function runTurn(req: TurnRequest, emit: (e: TurnEvent) => void): Promise<void> {
  const brief = BRIEFS[req.personaId];
  const { utterance: u, turnId } = req;

  const utterance: Utterance = {
    id: u.id,
    speaker: u.speaker,
    text: u.text,
    startMs: req.elapsedMs,
    endMs: req.elapsedMs,
    confidence: 1,
    derivedFromLowConfidence: false,
  };

  // Memory from the PREVIOUS turn; the hot tail already includes this utterance.
  const store = new MemoryStore(req.snapshot.memory);
  store.setStats(req.snapshot.stats);
  const prevMemory = store.snapshot;
  const tail: HotTailEntry[] = req.snapshot.hotTail;

  const suggesterPromise =
    utterance.speaker === 'customer'
      ? runProspectSuggester({ utterance, hotTail: tail, prevMemory, brief })
      : runRepWatcher({ utterance, hotTail: tail, prevMemory, brief });

  const memoryDone = runMemoryAgent({ utterance, turnId, prevMemory, hotTail: tail })
    .then(async (patch) => {
      store.applyMemoryPatch(patch);
      emit({ type: 'memory.patch', patch });

      // After the extractor patch lands, conditionally rewrite the rep-facing panel.
      if (shouldRunPanelAgent(patch)) {
        try {
          const panel = await runPanelAgent({ memory: store.snapshot });
          if (store.applyPanelPatch(panel, turnId)) {
            emit({ type: 'panel.patch', patch: panel, turnId });
          }
        } catch (err) {
          console.error('[coach panel agent]', u.id, err);
        }
      }
    })
    .catch((err) => console.error('[coach memory agent]', u.id, err));

  try {
    const suggestion = await suggesterPromise;
    if (suggestion.shouldFire) {
      emit({
        type: 'suggestion',
        id: `s-${u.id}`,
        content: suggestion.markdown,
        reason: suggestion.reasoning,
        groundedInUtteranceIds: suggestion.groundedInUtteranceIds,
      });
    }
  } catch (err) {
    console.error('[coach suggester]', u.id, err);
    emit({ type: 'error', message: err instanceof Error ? err.message : 'suggester_failed' });
  }

  await memoryDone;
}
