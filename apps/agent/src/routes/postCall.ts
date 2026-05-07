import type { PreCallBrief } from '@atlas/types';
import { broadcastEvent } from '../sse/handler';
import {
  saveCoachingArtifact,
  saveFollowUpEmail,
  saveVerdict,
} from '../db/sqlite';
import { runVerdictAgent } from '../agents/verdictAgent';
import { runCoachingAgent } from '../agents/coachingAgent';
import { runFollowupAgent } from '../agents/followupAgent';
import { costContext } from '../llm/context';
import type { PipelineSession } from './pipeline';

/**
 * Post-call agent chain. Runs after `/calls/:callId/end` finalizes the DB
 * row. Each step persists its result and broadcasts an SSE event so the
 * `/call/[id]/coaching` view can stream artifacts in as they finish.
 *
 * Failures in any step are reported via a `post_call_failed` SSE event but
 * do NOT abort the rest of the chain — the coaching agent doesn't strictly
 * need the verdict and the follow-up agent can fall back if either upstream
 * fails (we surface a stub verdict in that case).
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
      broadcastEvent(callId, { type: 'verdict', verdict, callId });
    } catch (err) {
      console.error('[postCall] verdict agent failed', callId, err);
      broadcastEvent(callId, {
        type: 'post_call_failed',
        callId,
        step: 'verdict',
        message: err instanceof Error ? err.message : String(err),
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
      broadcastEvent(callId, {
        type: 'coaching_ready',
        callId,
        artifact: artifact as unknown as Record<string, unknown>,
      });
    } catch (err) {
      console.error('[postCall] coaching agent failed', callId, err);
      broadcastEvent(callId, {
        type: 'post_call_failed',
        callId,
        step: 'coaching',
        message: err instanceof Error ? err.message : String(err),
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
      broadcastEvent(callId, { type: 'followup_ready', callId, email });
    } catch (err) {
      console.error('[postCall] followup agent failed', callId, err);
      broadcastEvent(callId, {
        type: 'post_call_failed',
        callId,
        step: 'followup',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
