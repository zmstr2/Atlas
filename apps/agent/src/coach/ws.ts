import type { ServerWebSocket } from 'bun';
import { nanoid } from 'nanoid';
import {
  CoachWSClientEventSchema,
  type CoachWSServerEvent,
  PersonaIdSchema,
  type PersonaId,
  type Utterance,
} from '@atlas/types';

const INTRO_BY_PERSONA: Record<PersonaId, string> = {
  jordan:
    "I'm watching this call live and will surface suggestions when something interesting comes up — objections, decision-maker hints, budget signals.\n\nJordan is your champion, but Marcus Liu (VP RevOps, ex-Gong, joined 3 months ago) is the economic buyer above ~$120k. Priya Shah (demand gen manager) owns Salesloft workflows and has de facto veto on tooling changes there — get her name on the demo invite.\n\nBest opener: lead with the LinkedIn post he wrote about scaling outbound without headcount. That's what got him on the call. Do not pitch AI features generically — he's already skeptical of what HubSpot is shipping.",
};
import {
  createCoachState,
  getCoachState,
  endCall,
  appendUtterance,
  appendSuggestion,
  nextTurnId,
  type CoachState,
} from './state';
import { runMemoryAgent } from '../agents/memoryAgent';
import { runPanelAgent, shouldRunPanelAgent } from '../agents/panelAgent';
import { runProspectSuggester } from '../agents/prospectSuggester';
import { runRepWatcher } from '../agents/repWatcher';
import { enqueuePipeline } from './pipelineChain';
import { broadcastEvent, updateSessionMemory, getOrCreateSession } from '../sse/handler';
import { buildCallFactsUI } from '../memory/factsUI';

type WSData = {
  callId: string | null;
};

function send(ws: ServerWebSocket<WSData>, event: CoachWSServerEvent): void {
  ws.send(JSON.stringify(event));
}

async function streamSuggestion(
  ws: ServerWebSocket<WSData>,
  id: string,
  content: string,
  reason?: string,
  groundedInUtteranceIds?: string[],
): Promise<void> {
  for (const chunk of content.split(/(\s+)/)) {
    if (chunk) {
      send(ws, { type: 'suggestion.delta', id, token: chunk });
      await Bun.sleep(25);
    }
  }
  send(ws, { type: 'suggestion.complete', id, content, reason, groundedInUtteranceIds });
}

async function runPipeline(
  ws: ServerWebSocket<WSData>,
  state: CoachState,
  utterance: Utterance,
): Promise<void> {
  // Snapshot from PREVIOUS turn — current utterance hasn't been digested yet.
  // Hot tail IS current (synchronously appended in appendUtterance).
  const prevMemory = state.memoryStore.snapshot;
  const tail = state.hotTail.snapshot();
  const turnId = nextTurnId(state);

  // Speaker-conditional suggester (BLOCKING)
  const suggesterPromise = utterance.speaker === 'customer'
    ? runProspectSuggester({ utterance, hotTail: tail, prevMemory, brief: state.brief })
    : runRepWatcher({ utterance, hotTail: tail, prevMemory, brief: state.brief });

  // Memory agent (NON-BLOCKING)
  const memoryPromise = runMemoryAgent({
    utterance,
    turnId,
    prevMemory,
    hotTail: tail,
  });

  // Memory agent: apply patch + emit memory.patch over WS + memory_diff/facts_ui_delta over SSE.
  // After the extractor patch lands, conditionally fire the panel agent (separate LLM call)
  // to rewrite the rep-facing memory panel from accumulated state.
  memoryPromise
    .then(async (patch) => {
      try {
        state.memoryStore.applyMemoryPatch(patch);
        send(ws, { type: 'memory.patch', patch });
        const snapshot = state.memoryStore.snapshot;
        updateSessionMemory(state.callId, snapshot);
        broadcastEvent(state.callId, { type: 'memory_diff', snapshot, utteranceId: utterance.id });
        broadcastEvent(state.callId, { type: 'facts_ui_delta', ui: buildCallFactsUI(snapshot) });

        if (shouldRunPanelAgent(patch)) {
          try {
            const panel = await runPanelAgent({ memory: state.memoryStore.snapshot });
            const changed = state.memoryStore.applyPanelPatch(panel, turnId);
            if (changed) {
              const updated = state.memoryStore.snapshot;
              updateSessionMemory(state.callId, updated);
              broadcastEvent(state.callId, { type: 'memory_diff', snapshot: updated, utteranceId: utterance.id });
              broadcastEvent(state.callId, { type: 'facts_ui_delta', ui: buildCallFactsUI(updated) });
            }
          } catch (panelErr) {
            console.error('[coach panel agent]', utterance.id, panelErr);
          }
        }
      } catch (err) {
        console.error('[coach memory]', utterance.id, err);
      }
    })
    .catch((err) => console.error('[coach memory agent]', utterance.id, err));

  // Suggester: deliver suggestion if it fired
  try {
    const suggestion = await suggesterPromise;
    if (!suggestion.shouldFire) {
      return;
    }
    const suggestionId = nanoid();
    appendSuggestion(state.callId, {
      id: suggestionId,
      ts: Date.now(),
      content: suggestion.markdown,
      reason: suggestion.reasoning,
      groundedInUtteranceIds: suggestion.groundedInUtteranceIds,
    });
    await streamSuggestion(
      ws,
      suggestionId,
      suggestion.markdown,
      suggestion.reasoning,
      suggestion.groundedInUtteranceIds,
    );
  } catch (err) {
    console.error('[coach suggester]', utterance.id, err);
    send(ws, { type: 'error', message: err instanceof Error ? err.message : 'suggester_failed' });
  }
}

async function handleTranscript(
  ws: ServerWebSocket<WSData>,
  state: CoachState,
  speaker: 'rep' | 'persona',
  text: string,
  itemId: string,
): Promise<void> {
  const utterance: Utterance = {
    id: itemId,
    speaker: speaker === 'persona' ? 'customer' : 'rep',
    text,
    startMs: Date.now() - state.createdAt,
    endMs: Date.now() - state.createdAt,
    confidence: 1,
    derivedFromLowConfidence: false,
  };
  // Synchronous: append to transcript + hot tail + stats counter (so the next turn's
  // suggester sees this utterance in the hot tail even if memory agent is mid-flight).
  appendUtterance(state.callId, utterance);

  // Both speakers now drive the pipeline. Rep turns fire rep-watcher; persona/customer
  // turns fire prospect-suggester. Memory agent runs on every turn.
  enqueuePipeline(state.callId, () => runPipeline(ws, state, utterance));
}

function handleCallEnd(_ws: ServerWebSocket<WSData>, state: CoachState): void {
  endCall(state.callId);
}

export const coachWebSocketHandler = {
  open(ws: ServerWebSocket<WSData>): void {
    if (!ws.data) ws.data = { callId: null };
  },

  async message(ws: ServerWebSocket<WSData>, raw: string | Buffer): Promise<void> {
    const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      send(ws, { type: 'error', message: 'invalid_json' });
      return;
    }

    const event = CoachWSClientEventSchema.safeParse(parsed);
    if (!event.success) {
      send(ws, { type: 'error', message: `invalid_event: ${event.error.message.slice(0, 200)}` });
      return;
    }

    if (event.data.type === 'hello') {
      const personaCheck = PersonaIdSchema.safeParse(event.data.personaId);
      if (!personaCheck.success) {
        send(ws, { type: 'error', message: 'invalid_persona' });
        return;
      }
      let state = getCoachState(event.data.callId);
      const isNew = !state;
      if (!state) {
        state = createCoachState({ callId: event.data.callId, personaId: event.data.personaId });
      }
      ws.data.callId = event.data.callId;

      if (isNew) {
        // Ensure an SSE session exists so the UI can subscribe before any utterances.
        getOrCreateSession(event.data.callId);
        const intro = INTRO_BY_PERSONA[personaCheck.data];
        if (intro) {
          void streamSuggestion(ws, nanoid(), intro, 'call_intro');
        }
      }
      return;
    }

    const callId = ws.data.callId;
    if (!callId) {
      send(ws, { type: 'error', message: 'must_send_hello_first' });
      return;
    }
    const state = getCoachState(callId);
    if (!state) {
      send(ws, { type: 'error', message: 'unknown_call' });
      return;
    }

    switch (event.data.type) {
      case 'transcript':
        if (event.data.isFinal) {
          await handleTranscript(ws, state, event.data.speaker, event.data.text, event.data.itemId);
        }
        return;
      case 'persona.tool_call':
        void streamSuggestion(
          ws,
          nanoid(),
          `Persona invoked \`${event.data.name}\` with ${JSON.stringify(event.data.args)}`,
          'persona_tool_call',
        );
        return;
      case 'call.end':
        handleCallEnd(ws, state);
        return;
    }
  },

  close(_ws: ServerWebSocket<WSData>): void {
    // State persists in coach/state.ts for reconnect; eviction handled by TTL.
  },
};

export type CoachWebSocketData = WSData;
