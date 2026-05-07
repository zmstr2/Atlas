import type { PreCallBrief } from '@atlas/types';
import { broadcastEvent } from '../sse/handler';
import {
  saveCoachingArtifact,
  saveFollowUpEmail,
  saveVerdict,
  setPostCallStatus,
} from '../db/sqlite';
import { runVerdictAgent } from '../agents/verdictAgent';
import { runCoachingAgent } from '../agents/coachingAgent';
import { runFollowupAgent } from '../agents/followupAgent';
import { costContext } from '../llm/context';
import type { PipelineSession } from './pipeline';

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Post-call agent chain. Runs after `/calls/:callId/end` finalizes the DB
 * row. Each step persists its result + a status column so the
 * `/call/[id]/coaching` view can distinguish "still running" from "failed
 * permanently" after an SSE drop and reload.
 *
 * Per-step failures (verdict / coaching / followup) are isolated — coaching
 * doesn't strictly need verdict and the follow-up agent can fall back on a
 * stub. A chain-level failure (e.g. costContext.run throws) is caught by the
 * caller in ingest.ts.
 *
 * Wrapped in `costContext.run()` so all LLM calls inside attribute spend to
 * the right user via the AsyncLocalStorage path that wrapper.ts reads.
 */
export async function runPostCallChain(opts: {
  callId: string;
  userId: string;
  session: PipelineSession;
  brief: PreCallBrief;
}): Promise<void> {
  const { callId, userId, session, brief } = opts;

  return costContext.run({ userId, callId }, async () => {
    const memory = session.store.snapshot;
    const transcript = session.transcript;

    // 1. Verdict
    let verdict: Awaited<ReturnType<typeof runVerdictAgent>> | null = null;
    try {
      verdict = await runVerdictAgent({ memory, transcript, brief });
      saveVerdict(callId, verdict);
      setPostCallStatus(callId, 'verdict', 'ok');
      broadcastEvent(callId, { type: 'verdict', verdict, callId });
    } catch (err) {
      const message = failureMessage(err);
      console.error('[postCall] verdict agent failed', callId, err);
      setPostCallStatus(callId, 'verdict', `failed:${message}`);
      broadcastEvent(callId, {
        type: 'post_call_failed',
        callId,
        step: 'verdict',
        message,
      });
    }

    // Fall back to a stub verdict so coaching + followup can still run.
    const verdictForDownstream = verdict ?? {
      outcome: 'needs_more_info' as const,
      reasoning: 'Verdict agent did not complete; downstream agents ran with a placeholder.',
      groundedSignalIds: [],
      nextSteps: [],
    };

    // 2. Coaching artifact
    try {
      const artifact = await runCoachingAgent({
        memory,
        transcript,
        verdict: verdictForDownstream,
        brief,
      });
      saveCoachingArtifact(callId, artifact);
      setPostCallStatus(callId, 'coaching', 'ok');
      broadcastEvent(callId, {
        type: 'coaching_ready',
        callId,
        artifact: artifact as unknown as Record<string, unknown>,
      });
    } catch (err) {
      const message = failureMessage(err);
      console.error('[postCall] coaching agent failed', callId, err);
      setPostCallStatus(callId, 'coaching', `failed:${message}`);
      broadcastEvent(callId, {
        type: 'post_call_failed',
        callId,
        step: 'coaching',
        message,
      });
    }

    // 3. Follow-up email
    try {
      const email = await runFollowupAgent({
        memory,
        verdict: verdictForDownstream,
        brief,
      });
      saveFollowUpEmail(callId, email);
      setPostCallStatus(callId, 'followup', 'ok');
      broadcastEvent(callId, { type: 'followup_ready', callId, email });
    } catch (err) {
      const message = failureMessage(err);
      console.error('[postCall] followup agent failed', callId, err);
      setPostCallStatus(callId, 'followup', `failed:${message}`);
      broadcastEvent(callId, {
        type: 'post_call_failed',
        callId,
        step: 'followup',
        message,
      });
    }
  });
}
