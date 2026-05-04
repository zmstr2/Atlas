import { describe, test, expect } from 'bun:test';
import { computeScorecard } from './scorecard';
import { createEmptyMemory } from './store';
import type { MeetingMemory } from '@atlas/types';

const baseStats = {
  repWords: 100,
  prospectWords: 100,
  turnsSinceLastRepQuestion: 0,
  turnsSinceLastNextStepProposal: 0,
  callMinute: 5,
};

function withSignal(memory: MeetingMemory, sig: Parameters<typeof memory.qualSignals.push>[0]) {
  memory.qualSignals.push(sig);
}

describe('computeScorecard', () => {
  test('empty memory → all axes unknown, no disqualify', () => {
    const memory = createEmptyMemory();
    const sc = computeScorecard(memory, baseStats);
    expect(sc.bant.need).toBe('unknown');
    expect(sc.bant.budget).toBe('unknown');
    expect(sc.meddic.champion).toBe('unknown');
    expect(sc.hardDisqualify).toBe(false);
    // pushQueue should include all axes (excludes none yet)
    expect(sc.pushQueue.length).toBeGreaterThanOrEqual(9);
    expect(sc.pushQueue[0]).toBe('need'); // priority order
  });

  test('positive Need signal → need axis soft', () => {
    const memory = createEmptyMemory();
    withSignal(memory, {
      id: 'q1', direction: 'positive', meddic: 'identify_pain', bantBucket: 'need',
      content: 'manual reconciliation pain', utteranceIds: ['u1'],
    });
    const sc = computeScorecard(memory, baseStats);
    expect(sc.bant.need).toBe('soft');
    expect(sc.meddic.identifyPain).toBe('soft');
  });

  test('Budget confirmed_negative → hardDisqualify + budget excluded from pushQueue', () => {
    const memory = createEmptyMemory();
    withSignal(memory, {
      id: 'q1', direction: 'negative', meddic: 'budget', bantBucket: 'budget',
      content: 'no budget for this fiscal year', utteranceIds: ['u1'],
    });
    const sc = computeScorecard(memory, baseStats);
    expect(sc.bant.budget).toBe('confirmed_negative');
    expect(sc.hardDisqualify).toBe(true);
    expect(sc.pushQueue).not.toContain('budget');
  });

  test('Need confirmed_negative → hardDisqualify', () => {
    const memory = createEmptyMemory();
    withSignal(memory, {
      id: 'q1', direction: 'negative', meddic: 'identify_pain', bantBucket: 'need',
      content: 'no real pain — exploring', utteranceIds: ['u1'],
    });
    const sc = computeScorecard(memory, baseStats);
    expect(sc.bant.need).toBe('confirmed_negative');
    expect(sc.hardDisqualify).toBe(true);
    expect(sc.pushQueue).not.toContain('need');
  });

  test('pain.cost_* fact → need=confirmed AND metrics=firm', () => {
    const memory = createEmptyMemory();
    memory.facts.push({
      id: 'f1', key: 'pain.cost_per_week', category: 'other', content: '$15k/wk',
      utteranceIds: ['u1'], confidence: 0.9, extractedAt: 0, revisions: [],
    });
    const sc = computeScorecard(memory, baseStats);
    expect(sc.bant.need).toBe('confirmed');
    expect(sc.meddic.metrics).toBe('firm');
    // confirmed need is high enough that it should drop out of pushQueue
    expect(sc.pushQueue).not.toContain('need');
  });

  test('pushQueue priority: need > budget > authority', () => {
    const memory = createEmptyMemory();
    const sc = computeScorecard(memory, baseStats);
    expect(sc.pushQueue.indexOf('need')).toBeLessThan(sc.pushQueue.indexOf('budget'));
    expect(sc.pushQueue.indexOf('budget')).toBeLessThan(sc.pushQueue.indexOf('authority'));
    expect(sc.pushQueue.indexOf('authority')).toBeLessThan(sc.pushQueue.indexOf('timeline'));
    expect(sc.pushQueue.indexOf('timeline')).toBeLessThan(sc.pushQueue.indexOf('champion'));
  });

  test('softDisqualify on send_info_deflection', () => {
    const memory = createEmptyMemory();
    memory.concerns.push({
      id: 'c1', topic: 'info_request', verbatim: 'just send me the deck',
      severity: 'mentioned', addressed: false, utteranceIds: ['u1'],
    });
    const sc = computeScorecard(memory, baseStats);
    expect(sc.softDisqualifySignals).toContain('send_info_deflection');
  });

  test('softDisqualify on late+vague_need', () => {
    const memory = createEmptyMemory();
    const sc = computeScorecard(memory, { ...baseStats, callMinute: 22 });
    expect(sc.softDisqualifySignals).toContain('late_with_vague_need');
  });

  test('positive champion signal + exec role → champion=firm', () => {
    const memory = createEmptyMemory();
    memory.decisionGeography.push({
      name: 'Diane', role: 'CFO', sentiment: 'positive', utteranceIds: ['u1'],
    });
    const sc = computeScorecard(memory, baseStats);
    expect(sc.meddic.champion).toBe('firm');
    expect(sc.meddic.economicBuyer).toBe('firm');
  });

  test('talk ratio passes through', () => {
    const memory = createEmptyMemory();
    const sc = computeScorecard(memory, { ...baseStats, repWords: 200, prospectWords: 100 });
    expect(sc.talkRatio.repWords).toBe(200);
    expect(sc.talkRatio.prospectWords).toBe(100);
  });
});
