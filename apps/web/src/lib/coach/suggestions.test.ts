import { describe, expect, test } from 'bun:test';
import {
  addSuggestion, ageLabel, deriveView, markCovered, openForModel, promote, restore, settle,
  COVERED_FLASH_MS, EXPIRE_AFTER_MS, MAX_OPEN, UNDO_MS, type CoachSuggestion,
} from './suggestions';

const NONE = () => false;
let n = 0;
const sug = (over: Partial<CoachSuggestion> = {}): Omit<CoachSuggestion, 'status' | 'settledAt'> => ({
  id: `s${++n}`, content: 'Ask about budget', kind: 'question', topic: 'budget', ts: 1000 * n, turn: n, ...over,
});
const ctx = (over: Partial<Parameters<typeof deriveView>[1]> = {}) => ({ now: 5000, turn: 3, axisConfirmed: NONE, ...over });

describe('suggestion lifecycle', () => {
  test('newest is current; an unasked question on a different topic parks', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget' }), 1);
    l = addSuggestion(l, sug({ id: 'b', topic: 'authority' }), 2);
    const v = deriveView(l, ctx());
    expect(v.current?.id).toBe('b');
    expect(v.tray.map((s) => s.id)).toEqual(['a']);
  });

  test('a newer take on the same topic replaces the old one (one slot per topic)', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget' }), 1);
    l = addSuggestion(l, sug({ id: 'b', topic: 'budget' }), 2);
    const v = deriveView(l, ctx());
    expect(v.current?.id).toBe('b');
    expect(v.tray).toHaveLength(0);
    expect(v.history.map((s) => s.id)).toContain('a');
  });

  test('a one-shot note never parks', () => {
    let l = addSuggestion([], sug({ id: 'a', kind: 'note', topic: 'budget' }), 1);
    l = addSuggestion(l, sug({ id: 'b', topic: 'authority' }), 2);
    expect(deriveView(l, ctx()).tray).toHaveLength(0);
  });

  test('empty topics do not collide with each other', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: '' }), 1);
    l = addSuggestion(l, sug({ id: 'b', topic: '' }), 2);
    expect(deriveView(l, ctx()).tray.map((s) => s.id)).toEqual(['a']);
  });

  test('the tray is capped; the oldest parked item ages out', () => {
    let l: CoachSuggestion[] = [];
    for (let i = 0; i < MAX_OPEN + 3; i++) l = addSuggestion(l, sug({ topic: `t${i}`, ts: 100 + i, turn: 1 }), 100 + i);
    const v = deriveView(l, ctx({ now: 200, turn: 2 }));
    expect(v.tray).toHaveLength(MAX_OPEN);
  });

  test('model-reported coverage clears it and flashes "Covered" briefly', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget' }), 1);
    l = addSuggestion(l, sug({ id: 'b', topic: 'authority' }), 2);
    l = markCovered(l, ['a'], 4000);
    expect(deriveView(l, ctx({ now: 4000 + 100 })).covering.map((s) => s.id)).toEqual(['a']);
    expect(deriveView(l, ctx({ now: 4000 + COVERED_FLASH_MS + 1 })).covering).toHaveLength(0);
    expect(deriveView(l, ctx()).tray).toHaveLength(0);
  });

  test('a confirmed qualification axis answers questions about it', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget' }), 1);
    l = addSuggestion(l, sug({ id: 'b', topic: 'authority' }), 2);
    const v = deriveView(l, ctx({ axisConfirmed: (t) => t === 'budget' }));
    expect(v.tray).toHaveLength(0);
    expect(v.current?.id).toBe('b');
    // It shows in history as covered, never with a blank status.
    expect(v.history.find((s) => s.id === 'a')?.status).toBe('covered');
  });

  test('age is only a backstop: old parked questions expire, young ones stay', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget', ts: 1000, turn: 1 }), 1000);
    l = addSuggestion(l, sug({ id: 'b', topic: 'authority', ts: 2000, turn: 2 }), 2000);
    expect(deriveView(l, ctx({ now: 3000, turn: 3 })).tray).toHaveLength(1);
    expect(deriveView(l, ctx({ now: 3000, turn: 12 })).tray).toHaveLength(0); // by turns
    expect(deriveView(l, ctx({ now: 1000 + EXPIRE_AFTER_MS + 1, turn: 3 })).tray).toHaveLength(0); // by time
  });

  test('manual Asked and Drop remove an item; promote swaps it with current', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget' }), 1);
    l = addSuggestion(l, sug({ id: 'b', topic: 'authority' }), 2);
    const swapped = promote(l, 'a', 3);
    const v = deriveView(swapped, ctx());
    expect(v.current?.id).toBe('a');
    expect(v.tray.map((s) => s.id)).toEqual(['b']);
    expect(deriveView(settle(l, 'a', 'dropped', 3), ctx()).tray).toHaveLength(0);
    expect(deriveView(settle(l, 'a', 'asked', 3), ctx()).tray).toHaveLength(0);
  });

  test('when the current question is covered, the newest parked one steps up', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget' }), 1);
    l = addSuggestion(l, sug({ id: 'b', topic: 'authority' }), 2);
    l = markCovered(l, ['b'], 3);
    expect(deriveView(l, ctx({ now: 99999 })).current?.id).toBe('a');
  });

  test('duplicate ids are ignored; only live questions are sent to the model', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget' }), 1);
    expect(addSuggestion(l, sug({ id: 'a' }), 2)).toBe(l);
    l = addSuggestion(l, sug({ id: 'b', kind: 'note', topic: 'authority' }), 2);
    expect(openForModel(deriveView(l, ctx())).map((o) => o.id)).toEqual(['a']);
  });

  test('Undo is offered briefly after Drop or Asked, and restores the item', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget' }), 1);
    l = addSuggestion(l, sug({ id: 'b', topic: 'authority' }), 2);
    const dropped = settle(l, 'b', 'dropped', 10_000);
    expect(deriveView(dropped, ctx({ now: 10_000 + 100 })).undoable?.id).toBe('b');
    expect(deriveView(dropped, ctx({ now: 10_000 + UNDO_MS + 1 })).undoable).toBeNull();
    // Undo puts the dropped current suggestion back exactly where it was.
    const undone = restore(dropped, 'b', 10_200);
    const v = deriveView(undone, ctx({ now: 10_300 }));
    expect(v.current?.id).toBe('b');
    expect(v.tray.map((s) => s.id)).toEqual(['a']);
  });

  test('restoring from history becomes current when nothing else is', () => {
    let l = addSuggestion([], sug({ id: 'a', topic: 'budget' }), 1);
    l = settle(l, 'a', 'asked', 5);
    expect(deriveView(restore(l, 'a', 6), ctx({ now: 7 })).current?.id).toBe('a');
  });

  test('ageLabel is coarse', () => {
    expect(ageLabel(1000, 4000)).toBe('now');
    expect(ageLabel(0, 42000)).toBe('40s');
    expect(ageLabel(0, 150000)).toBe('3m');
  });
});
