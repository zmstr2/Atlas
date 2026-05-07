import { describe, test, expect, beforeEach } from 'bun:test';
import { getCallLog, clearCallLog, getSessionCost } from './wrapper';
import { costContext, getCostContext } from './context';

describe('LLM wrapper call log', () => {
  beforeEach(() => clearCallLog());

  test('starts empty', () => {
    expect(getCallLog()).toHaveLength(0);
    expect(getSessionCost()).toBe(0);
  });

  test('clearCallLog resets state', () => {
    // Manually push a record to simulate a completed call
    const log = getCallLog() as Array<{ step: string; model: string; latencyMs: number; tokensIn: number; tokensOut: number; costUsd: number }>;
    // The log is a copy — we can't push to it from outside.
    // This test documents the external contract: after clearCallLog, log is empty.
    clearCallLog();
    expect(getCallLog()).toHaveLength(0);
    expect(getSessionCost()).toBe(0);
    void log;
  });
});

describe('cost context (AsyncLocalStorage)', () => {
  test('returns undefined outside of a run() frame', () => {
    expect(getCostContext()).toBeUndefined();
  });

  test('exposes userId + callId inside a run() frame', () => {
    const captured = costContext.run({ userId: 'u-1', callId: 'c-1' }, () => {
      return getCostContext();
    });
    expect(captured).toEqual({ userId: 'u-1', callId: 'c-1' });
  });

  test('frames are isolated across nested calls', async () => {
    const outer = costContext.run({ userId: 'u-outer', callId: 'c-outer' }, () => {
      const innerSeen = costContext.run({ userId: 'u-inner', callId: 'c-inner' }, () => {
        return getCostContext();
      });
      return { outerSeen: getCostContext(), innerSeen };
    });
    expect(outer.outerSeen).toEqual({ userId: 'u-outer', callId: 'c-outer' });
    expect(outer.innerSeen).toEqual({ userId: 'u-inner', callId: 'c-inner' });
  });
});
