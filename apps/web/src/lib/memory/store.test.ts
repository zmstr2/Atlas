import { describe, test, expect } from 'bun:test';
import { MemoryStore } from './store';
import { emptyScorecard } from '@atlas/types';

describe('MemoryStore.applyPatch', () => {
  test('new key → appends as new fact', () => {
    const store = new MemoryStore();
    store.applyPatch({
      utteranceId: 'u1',
      facts: [{ op: 'upsert', key: 'budget.amount', category: 'budget', content: '$50k/year', confidence: 0.9 }],
    });
    const snap = store.snapshot;
    expect(snap.facts).toHaveLength(1);
    expect(snap.facts[0].key).toBe('budget.amount');
    expect(snap.facts[0].content).toBe('$50k/year');
    expect(snap.facts[0].revisions).toHaveLength(0);
  });

  test('same key twice → updates content, prior version in revisions[]', () => {
    const store = new MemoryStore();
    store.applyPatch({
      utteranceId: 'u1',
      facts: [{ op: 'upsert', key: 'budget.amount', category: 'budget', content: '$50k', confidence: 0.8 }],
    });
    store.applyPatch({
      utteranceId: 'u2',
      facts: [{ op: 'upsert', key: 'budget.amount', category: 'budget', content: '$60k', confidence: 0.95 }],
    });
    const snap = store.snapshot;
    expect(snap.facts).toHaveLength(1);
    expect(snap.facts[0].content).toBe('$60k');
    expect(snap.facts[0].revisions).toHaveLength(1);
    expect(snap.facts[0].revisions[0].previousContent).toBe('$50k');
  });

  test('different keys → both appended', () => {
    const store = new MemoryStore();
    store.applyPatch({
      utteranceId: 'u1',
      facts: [
        { op: 'upsert', key: 'budget.amount', category: 'budget', content: '$50k', confidence: 0.9 },
        { op: 'upsert', key: 'timeline.target_date', category: 'timeline', content: 'Q2 2026', confidence: 0.85 },
      ],
    });
    expect(store.snapshot.facts).toHaveLength(2);
  });

  test('concern upsert → escalates severity, never downgrades', () => {
    const store = new MemoryStore();
    store.applyPatch({
      utteranceId: 'u1',
      concerns: [{ op: 'upsert', topic: 'implementation', verbatim: 'could be slow', severity: 'mentioned' }],
    });
    store.applyPatch({
      utteranceId: 'u2',
      concerns: [{ op: 'upsert', topic: 'implementation', verbatim: '9 months for Marketo', severity: 'blocking' }],
    });
    store.applyPatch({
      utteranceId: 'u3',
      concerns: [{ op: 'upsert', topic: 'implementation', verbatim: 'generic followup', severity: 'mentioned' }],
    });
    const snap = store.snapshot;
    expect(snap.concerns).toHaveLength(1);
    expect(snap.concerns[0].severity).toBe('blocking'); // never downgraded
    // verbatim follows severity — we keep the strongest evidence quote
    expect(snap.concerns[0].verbatim).toBe('9 months for Marketo');
  });

  test('free-form concern append → no dedup', () => {
    const store = new MemoryStore();
    store.applyPatch({
      utteranceId: 'u1',
      concerns: [{ op: 'append', topic: 'pricing', verbatim: 'seems expensive', severity: 'mentioned' }],
    });
    store.applyPatch({
      utteranceId: 'u2',
      concerns: [{ op: 'append', topic: 'pricing', verbatim: 'too costly', severity: 'mentioned' }],
    });
    expect(store.snapshot.concerns).toHaveLength(2);
  });

  test('qual signals append-only', () => {
    const store = new MemoryStore();
    store.applyPatch({
      utteranceId: 'u1',
      qualSignals: [{ op: 'append', direction: 'positive', meddic: 'budget', bantBucket: 'budget', content: 'has $50k budget' }],
    });
    store.applyPatch({
      utteranceId: 'u2',
      qualSignals: [{ op: 'append', direction: 'positive', meddic: 'budget', bantBucket: 'budget', content: 'confirmed annual contract' }],
    });
    expect(store.snapshot.qualSignals).toHaveLength(2);
  });

  test('openLoop append then close', () => {
    const store = new MemoryStore();
    store.applyPatch({
      utteranceId: 'u1',
      openLoops: [{ op: 'append', description: 'send one-pager to Marcus', owner: 'rep', closeDescription: null }],
    });
    expect(store.snapshot.openLoops[0].status).toBe('open');
    store.applyPatch({
      utteranceId: 'u2',
      openLoops: [{ op: 'close', description: 'send one-pager to Marcus', owner: 'rep', closeDescription: null }],
    });
    expect(store.snapshot.openLoops[0].status).toBe('addressed');
  });

  test('decision actor upsert by name', () => {
    const store = new MemoryStore();
    store.applyPatch({
      utteranceId: 'u1',
      decisionGeography: [{ op: 'upsert', name: 'Marcus', role: 'RevOps', sentiment: 'unknown' }],
    });
    store.applyPatch({
      utteranceId: 'u2',
      decisionGeography: [{ op: 'upsert', name: 'Marcus', role: 'RevOps', sentiment: 'positive' }],
    });
    const snap = store.snapshot;
    expect(snap.decisionGeography).toHaveLength(1);
    expect(snap.decisionGeography[0].sentiment).toBe('positive');
  });

  test('constructor rebuilds indices from initial memory — upsert mutates existing record', () => {
    // 100 pre-existing facts, target one in the middle
    const facts = Array.from({ length: 100 }, (_, i) => ({
      id: `f${i}`,
      key: `k${i}`,
      category: 'other' as const,
      content: `v${i}`,
      utteranceIds: ['u-seed'],
      confidence: 0.8,
      extractedAt: 0,
      revisions: [],
    }));
    const store = new MemoryStore({
      facts,
      concerns: [],
      openLoops: [],
      qualSignals: [],
      decisionGeography: [],
      silenceTopics: [],
      narrative: '',
      flow: [],
      verbatimAnchors: [],
      scorecard: emptyScorecard(),
      bantRender: {},
      relevantFacts: [],
    });
    store.applyPatch({
      utteranceId: 'u1',
      facts: [{ op: 'upsert', key: 'k50', category: 'other', content: 'updated', confidence: 0.95 }],
    });
    const snap = store.snapshot;
    expect(snap.facts).toHaveLength(100); // not appended as new
    const target = snap.facts.find(f => f.key === 'k50')!;
    expect(target.content).toBe('updated');
    expect(target.revisions).toHaveLength(1);
    expect(target.revisions[0].previousContent).toBe('v50');
  });

  test('snapshot is cached until next mutation', () => {
    const store = new MemoryStore();
    store.applyPatch({ utteranceId: 'u1', facts: [{ op: 'upsert', key: 'k', category: 'other', content: 'v', confidence: 0.9 }] });
    const a = store.snapshot;
    const b = store.snapshot;
    expect(a).toBe(b); // same reference until mutation
    store.applyPatch({ utteranceId: 'u2', facts: [{ op: 'upsert', key: 'k2', category: 'other', content: 'v2', confidence: 0.9 }] });
    const c = store.snapshot;
    expect(c).not.toBe(a); // new clone after mutation
  });

  test('onChange fires once per applyPatch', () => {
    const store = new MemoryStore();
    let count = 0;
    store.onChange(() => { count++; });
    store.applyPatch({ utteranceId: 'u1', facts: [{ op: 'upsert', key: 'k', category: 'other', content: 'v', confidence: 0.9 }] });
    store.applyPatch({ utteranceId: 'u2', facts: [{ op: 'upsert', key: 'k2', category: 'other', content: 'v2', confidence: 0.9 }] });
    expect(count).toBe(2);
  });
});
