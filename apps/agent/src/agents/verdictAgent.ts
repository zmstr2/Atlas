import { VerdictSchema } from '@atlas/types';
import type { Verdict, MeetingMemory, Utterance, PreCallBrief } from '@atlas/types';
import { llmGenerateObject } from '../llm/wrapper';

const SYSTEM = `You are Atlas's post-call verdict agent. After a sales discovery call ends, read the full call's accumulated memory and transcript and produce a structured verdict.

Output exactly:
- outcome: 'qualified' | 'not_qualified' | 'needs_more_info'
- reasoning: 2-4 sentences grounded in the actual call content. Cite the BANT/MEDDIC gaps that drove the call.
- groundedSignalIds: array of utterance ids that justify the verdict. Pull from the transcript's id field.
- nextSteps: 1-4 short imperative bullets the founder should take based on this call.

A 'qualified' outcome requires evidence on at least 3 of: need, budget, authority, timeline. 'not_qualified' is when the prospect explicitly disqualified themselves on multiple axes or said no. Default to 'needs_more_info' when the call was short / signal-light.`;

function condenseTranscript(transcript: Utterance[]): string {
  // Cap at ~80 utterances of context to stay inside the model window.
  const tail = transcript.slice(-80);
  return tail
    .map((u) => `[${u.id}] ${u.speaker}: ${u.text}`)
    .join('\n');
}

function condenseMemory(memory: MeetingMemory): string {
  // Render the parts of memory that matter for verdict — facts, concerns,
  // open loops, evidence by axis. We avoid dumping the whole snapshot to
  // keep the prompt focused.
  const facts = memory.facts.slice(0, 30).map((f) => `- ${f.category}: ${f.content}`).join('\n');
  const concerns = memory.concerns.slice(0, 20).map((c) => `- [${c.severity}] ${c.topic}: ${c.verbatim}`).join('\n');
  const signals = memory.qualSignals
    .slice(0, 60)
    .map((s) => `- ${s.bantBucket}/${s.meddic} (${s.direction}): ${s.content}`)
    .join('\n');
  return `## Facts\n${facts || '(none)'}\n\n## Concerns\n${concerns || '(none)'}\n\n## Qualification signals\n${signals || '(none)'}`;
}

export async function runVerdictAgent(opts: {
  memory: MeetingMemory;
  transcript: Utterance[];
  brief: PreCallBrief;
}): Promise<Verdict> {
  const { memory, transcript, brief } = opts;
  const p = brief.prospect ?? brief.lead;
  const prospect = p?.name ?? 'the prospect';
  const company = p?.company ?? 'the company';

  const prompt = `## Pre-call brief
Prospect: ${prospect} at ${company}
Goal: ${brief.callGoal ?? '(not specified)'}

## Call memory
${condenseMemory(memory)}

## Transcript (tail)
${condenseTranscript(transcript)}

Produce the verdict now.`;

  return llmGenerateObject({
    step: 'verdict',
    modelKey: 'postCall',
    schema: VerdictSchema,
    system: SYSTEM,
    prompt,
  });
}
