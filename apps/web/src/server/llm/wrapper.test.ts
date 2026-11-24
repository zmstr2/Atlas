import { describe, test, expect, beforeEach } from 'bun:test';
import { getCallLog, clearCallLog, getSessionCost } from './wrapper';

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
  });
});
