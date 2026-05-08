import { z } from 'zod';
import type { MeetingMemory, Utterance, PreCallBrief, Verdict } from '@atlas/types';
import { llmGenerateObject } from '../llm/wrapper';

// Loose schema — we're iterating on the exact shape. Frontend renders
// whatever is here; tightening will happen once the UX stabilizes.
export const CoachingArtifactSchema = z.object({
  summary: z.string(),
  whatWorked: z.array(z.object({
    moment: z.string(),
    why: z.string(),
    utteranceId: z.string().nullable(),
  })),
  whatToImprove: z.array(z.object({
    moment: z.string(),
    issue: z.string(),
    suggestedAlternative: z.string(),
    utteranceId: z.string().nullable(),
  })),
  keyMoments: z.array(z.object({
    label: z.string(),
    verbatim: z.string(),
    utteranceId: z.string().nullable(),
  })),
});
export type CoachingArtifact = z.infer<typeof CoachingArtifactSchema>;

const SYSTEM = `You are Atlas's post-call coaching agent. After a sales discovery call ends, produce a structured coaching artifact for the founder reviewing their own call.

Be specific. Cite verbatim quotes. Reference utterance ids where you can. Prefer one sharp observation over five generic ones.

Output:
- summary: 2-3 sentences. What kind of call was this, what was the trajectory.
- whatWorked: 1-3 entries. Each is a specific moment where the founder did the right thing. Cite the utterance and explain why it worked.
- whatToImprove: 1-3 entries. Each is a specific moment to coach on — leading question, feature dump, missed cue, defended objection, premature discount, missed next step. Include a concrete suggested alternative the founder could have said.
- keyMoments: 2-4 critical exchanges (verbatim) that define the call — buying signals, objections, anchoring moments, qualification facts.

Never invent quotes — every verbatim must be drawn from the transcript.`;

function condenseTranscript(transcript: Utterance[]): string {
  const tail = transcript.slice(-100);
  return tail.map((u) => `[${u.id}] ${u.speaker}: ${u.text}`).join('\n');
}

export async function runCoachingAgent(opts: {
  memory: MeetingMemory;
  transcript: Utterance[];
  verdict: Verdict;
  brief: PreCallBrief;
}): Promise<CoachingArtifact> {
  const { memory, transcript, verdict, brief } = opts;
  const p = brief.prospect ?? brief.lead;
  const prospect = p?.name ?? 'the prospect';

  const flowSummary = memory.flow
    .slice(-40)
    .map((f) => `[${f.turnId} ${f.tag}] ${f.content}`)
    .join('\n');

  const prompt = `## Pre-call brief
Prospect: ${prospect}
Goal: ${brief.callGoal ?? '(not specified)'}

## Verdict (already produced)
Outcome: ${verdict.outcome}
Reasoning: ${verdict.reasoning}

## Flow summary
${flowSummary || '(empty)'}

## Transcript (tail)
${condenseTranscript(transcript)}

Produce the coaching artifact now.`;

  return llmGenerateObject({
    step: 'coaching_artifact',
    modelKey: 'postCall',
    schema: CoachingArtifactSchema,
    system: SYSTEM,
    prompt,
  });
}
