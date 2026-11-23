import { describe, expect, mock, test } from 'bun:test';
import type { TurnEvent, TurnRequest } from '@/lib/coach/protocol';
import { MemoryStore } from '@/lib/memory/store';
import { HotTail } from '@/lib/memory/hotTail';

// Fake LLM: canned structured output per pipeline step, so the whole turn runs
// without network access or API keys.
let panelCalls = 0;
mock.module('../llm/wrapper', () => ({
  MODELS: {},
  llmGenerateObject: async (opts: { step: string }) => {
    switch (opts.step) {
      case 'memory_agent':
        return {
          facts: [{ op: 'upsert', key: 'budget.range', category: 'budget', content: '$40k budgeted', confidence: 0.9 }],
          concerns: null, openLoops: null, decisionGeography: null, flow: null, evidence: null,
        };
      case 'panel_agent':
        panelCalls += 1;
        return {
          bantRender: {
            need: { state: 'soft', headline: 'Manual work', detail: null, anchorTurnId: null },
            budget: { state: 'confirmed', headline: '$40k', detail: null, anchorTurnId: null },
            authority: { state: 'unknown', headline: null, detail: null, anchorTurnId: null },
            timeline: { state: 'unknown', headline: null, detail: null, anchorTurnId: null },
          },
          relevantFacts: [],
        };
      default: // prospect_suggester / rep_watcher
        return {
          shouldFire: true, priority: 'nudge', play: 'none', axis: null,
          markdown: 'Ask how they got to $40k.', reasoning: 'budget surfaced',
          groundedInUtteranceIds: ['u1'],
        };
    }
  },
}));

const { runTurn } = await import('./turn');

function makeRequest(speaker: 'rep' | 'customer'): TurnRequest {
  const store = new MemoryStore();
  const tail = new HotTail(5);
  tail.push({
    id: 'u1', speaker, text: 'We have about forty thousand set aside.',
    startMs: 0, endMs: 0, confidence: 1, derivedFromLowConfidence: false,
  });
  store.recordUtteranceStats(speaker, 'We have about forty thousand set aside.');
  return {
    callId: 'call_test', personaId: 'mia', turnId: 't001', elapsedMs: 1000,
    utterance: { id: 'u1', speaker, text: 'We have about forty thousand set aside.' },
    snapshot: { memory: store.snapshot, stats: store.getStats(), hotTail: tail.snapshot() },
  };
}

describe('runTurn (stateless coach turn)', () => {
  test('prospect turn: emits a suggestion, a memory patch, then a panel patch', async () => {
    const events: TurnEvent[] = [];
    await runTurn(makeRequest('customer'), (e) => events.push(e));

    const types = events.map((e) => e.type);
    expect(types).toContain('suggestion');
    expect(types).toContain('memory.patch');
    expect(types).toContain('panel.patch');
    // Panel rewrite only happens after the extractor patch it depends on.
    expect(types.indexOf('panel.patch')).toBeGreaterThan(types.indexOf('memory.patch'));
    expect(events.some((e) => e.type === 'error')).toBe(false);

    const sug = events.find((e) => e.type === 'suggestion');
    expect(sug && sug.type === 'suggestion' && sug.content).toBe('Ask how they got to $40k.');
  });

  test('patches applied client-side reproduce the memory the server computed', async () => {
    const events: TurnEvent[] = [];
    await runTurn(makeRequest('customer'), (e) => events.push(e));

    const clientStore = new MemoryStore(makeRequest('customer').snapshot.memory);
    for (const e of events) {
      if (e.type === 'memory.patch') clientStore.applyMemoryPatch(e.patch);
      if (e.type === 'panel.patch') clientStore.applyPanelPatch(e.patch, e.turnId);
    }
    expect(clientStore.snapshot.facts.some((f) => f.key === 'budget.range')).toBe(true);
  });

  test('rep turn does not trigger the panel agent', async () => {
    panelCalls = 0;
    const events: TurnEvent[] = [];
    await runTurn(makeRequest('rep'), (e) => events.push(e));
    expect(panelCalls).toBe(0);
    expect(events.some((e) => e.type === 'panel.patch')).toBe(false);
  });
});
