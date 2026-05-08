import { describe, test, expect, beforeEach } from 'bun:test';
import { runPostCallChain } from './postCall';
import { createPipelineSession } from './pipeline';
import { createCall, _resetDbForTests, loadCall, DEMO_USER_ID } from '../db/sqlite';
import type { PreCallBrief } from '@atlas/types';

const STUB_BRIEF: PreCallBrief = {
  prospect: { name: 'Test Prospect', company: 'Acme Inc.', title: 'CTO' },
  callGoal: 'Discovery',
};

describe('runPostCallChain (smoke)', () => {
  beforeEach(() => {
    _resetDbForTests();
  });

  test('does not throw on a minimal session even when LLM gateway is unreachable', async () => {
    const callId = 'test-call-' + Math.random().toString(36).slice(2, 10);
    createCall(callId, DEMO_USER_ID, { brief: STUB_BRIEF });
    const session = createPipelineSession(callId, DEMO_USER_ID, STUB_BRIEF);

    // The chain catches all errors per-step and emits SSE events; the outer
    // promise must resolve cleanly even when the LLM gateway can't be reached.
    await expect(
      runPostCallChain({ callId, userId: DEMO_USER_ID, session, brief: STUB_BRIEF }),
    ).resolves.toBeUndefined();

    // Call row should still exist after the chain runs.
    const row = loadCall(callId, DEMO_USER_ID);
    expect(row).not.toBeNull();
  });
});
