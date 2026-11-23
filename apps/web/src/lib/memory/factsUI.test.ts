import { describe, test, expect } from 'bun:test';
import { buildCallFactsUI } from './factsUI';
import { computeScorecard } from './scorecard';
import { createEmptyMemory } from './store';

const baseStats = {
  repWords: 100,
  prospectWords: 100,
  turnsSinceLastRepQuestion: 0,
  turnsSinceLastNextStepProposal: 0,
  callMinute: 5,
};

describe('buildCallFactsUI', () => {
  test('empty memory → all axes unknown, pushNext=need', () => {
    const memory = createEmptyMemory();
    memory.scorecard = computeScorecard(memory, baseStats);
    const ui = buildCallFactsUI(memory);
    expect(ui.bant.need.state).toBe('unknown');
    expect(ui.bant.budget.state).toBe('unknown');
    expect(ui.pushNext?.axis).toBe('need');
    expect(ui.disqualifiers.hard).toBe(false);
  });

  test('quantified pain → need card firm + metric anchor evidence', () => {
    const memory = createEmptyMemory();
    memory.facts.push({
      id: 'f1', key: 'pain.cost_per_week', category: 'other', content: '$15k/wk',
      utteranceIds: ['u1'], confidence: 0.9, extractedAt: 0, revisions: [],
    });
    memory.verbatimAnchors.push({
      turnId: 't06', axis: 'metric',
      verbatim: 'six hours every Tuesday',
      utteranceIds: ['u6'],
    });
    memory.scorecard = computeScorecard(memory, baseStats);
    const ui = buildCallFactsUI(memory);
    expect(ui.bant.need.state).toBe('firm');
    expect(ui.meddic.metrics.state).toBe('firm');
    expect(ui.meddic.metrics.anchorTurnId).toBe('t06');
    // Until the panel agent writes bantRender, a scored axis falls back to its
    // strongest evidence so it never renders as "Confirmed" with no content.
    expect(ui.meddic.metrics.headline).toBe('six hours every Tuesday');
    // Verbatim anchors are surfaced as the prospect's own words.
    expect(ui.meddic.metrics.quote).toBe('six hours every Tuesday');
    // Unscored axes stay empty.
    expect(ui.bant.authority.state).toBe('unknown');
    expect(ui.bant.authority.headline).toBeNull();
  });

  test('budget confirmed_negative → hard disqualifier flag', () => {
    const memory = createEmptyMemory();
    memory.qualSignals.push({
      id: 'q1', direction: 'negative', meddic: 'budget', bantBucket: 'budget',
      content: 'no budget', utteranceIds: ['u1'],
    });
    memory.scorecard = computeScorecard(memory, baseStats);
    const ui = buildCallFactsUI(memory);
    expect(ui.bant.budget.state).toBe('confirmed_negative');
    expect(ui.disqualifiers.hard).toBe(true);
    // pushNext should not be budget
    expect(ui.pushNext?.axis).not.toBe('budget');
  });

  test('exec stakeholder with positive sentiment → champion_candidate hint', () => {
    const memory = createEmptyMemory();
    memory.decisionGeography.push({
      name: 'Diane', role: 'CFO', sentiment: 'positive', utteranceIds: ['u1'],
    });
    memory.scorecard = computeScorecard(memory, baseStats);
    const ui = buildCallFactsUI(memory);
    expect(ui.stakeholders.length).toBe(1);
    expect(ui.stakeholders[0].name).toBe('Diane');
    expect(ui.stakeholders[0].role_hint).toBe('champion_candidate');
  });

  test('open loops surfaced; closed loops filtered', () => {
    const memory = createEmptyMemory();
    memory.openLoops.push({ id: 'l1', description: 'circle back to Marcus', owner: 'rep', status: 'open' });
    memory.openLoops.push({ id: 'l2', description: 'send pricing', owner: 'rep', status: 'addressed' });
    memory.scorecard = computeScorecard(memory, baseStats);
    const ui = buildCallFactsUI(memory);
    expect(ui.openLoops.length).toBe(1);
    expect(ui.openLoops[0].id).toBe('l1');
  });

  test('talk ratio normalized', () => {
    const memory = createEmptyMemory();
    memory.scorecard = computeScorecard(memory, { ...baseStats, repWords: 300, prospectWords: 100 });
    const ui = buildCallFactsUI(memory);
    expect(ui.stage.talkRatio.rep).toBeCloseTo(0.75);
    expect(ui.stage.talkRatio.prospect).toBeCloseTo(0.25);
  });
});
