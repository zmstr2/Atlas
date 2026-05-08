import type { MeetingMemory, PreCallBrief, Verdict } from '@atlas/types';
import { llmGenerateText } from '../llm/wrapper';

const SYSTEM = `You are Atlas's post-call follow-up email agent. Draft the email the founder will send to the prospect right after the discovery call.

Style: confident, terse, peer-to-peer. No "great chatting today!" filler. Reference SPECIFIC things the prospect said — facts, pains, metrics, stakeholders. Recap any commitments made on the call. Close with a concrete next step.

Format: plain-text email body. Include a subject line on the first line as "Subject: ...", a blank line, then the body. No HTML, no markdown.

Length: 80-150 words. Shorter is better when it can be.

Tailor the email's tone to the verdict:
- 'qualified': forward-momentum, propose the next step concretely (demo, pricing call, intro to a teammate).
- 'needs_more_info': name what you'd like to dig into next, propose a short follow-up call.
- 'not_qualified': polite, leave the door open without pretending the fit was there.`;

export async function runFollowupAgent(opts: {
  memory: MeetingMemory;
  verdict: Verdict;
  brief: PreCallBrief;
}): Promise<string> {
  const { memory, verdict, brief } = opts;
  const p = brief.prospect ?? brief.lead;
  const prospect = p?.name ?? 'the prospect';
  const company = p?.company ?? '';

  const facts = memory.facts.slice(0, 12).map((f) => `- ${f.content}`).join('\n');
  const concerns = memory.concerns.slice(0, 6).map((c) => `- ${c.topic}: ${c.verbatim}`).join('\n');
  const openLoops = memory.openLoops.slice(0, 6).map((l) => `- (${l.owner}) ${l.description}`).join('\n');

  const prompt = `## Recipient
${prospect}${company ? ` at ${company}` : ''}

## Verdict
${verdict.outcome} — ${verdict.reasoning}

Next steps suggested by the verdict agent:
${verdict.nextSteps.map((s) => `- ${s}`).join('\n')}

## What we learned about them
${facts || '(none)'}

## Concerns they raised
${concerns || '(none)'}

## Open loops / commitments
${openLoops || '(none)'}

Write the email now.`;

  return llmGenerateText({
    step: 'followup_email',
    modelKey: 'postCall',
    system: SYSTEM,
    prompt,
  });
}
