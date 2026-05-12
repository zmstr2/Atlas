/**
 * Markdown writer — second stage of the split suggester architecture (Wave 3.1).
 *
 * Given a fired signal type + evidence quote + play, writes the one-sentence
 * coaching whisper. Tightly scoped: no fire/silent decision, no play selection
 * — just composing the action verb and behavior the rep should change.
 *
 * Status: PROTOTYPE. Used by the eval-split-architecture script for
 * benchmarking; not wired into the live pipeline.
 */

import { z } from 'zod';
import type { Utterance, PreCallBrief, SuggestionPlay } from '@atlas/types';
import type { SignalType } from './triggerDetector';
import { llmGenerateObject } from '../llm/wrapper';

export const MarkdownOutputSchema = z.object({
  markdown: z.string(),
});
export type MarkdownOutput = z.infer<typeof MarkdownOutputSchema>;

export const MARKDOWN_WRITER_SYSTEM = `You are Atlas's coach whispering ONE sentence to a sales rep mid-call. The decision to fire has already been made — your only job is to write the coaching sentence.

# Constraints
- ONE sentence, ≥5 words, ≤15 words.
- Action verb first ("Pin", "Anchor", "Drill", "Probe", "Reframe", "Acknowledge", "Quantify", "Loop", "Redirect", "Lock").
- No bullets. No quoted lines. No "say X" or "ask X". No buyer's name.
- Don't parrot the speaker. Don't pitch features.
- The sentence describes the behavior the rep should change, NOT the feature being sold.

# Examples by signal type
- pain_vague: "Drill what 'messy' means — specific workflow or owner before moving on."
- pain_quantified: "Quantify the time loss — translate hours to weekly pipeline impact."
- objection_first: "Acknowledge the concern, then explore the root before responding."
- objection_repeat: "Re-anchor the repeated concern — it didn't land the first time."
- champion_behavior: "Equip the champion with a specific artifact and a date to follow up."
- stakeholder_named: "Probe the new stakeholder's decision criteria before pitching further."
- rep_feature_dump: "Stop pitching features — tie each capability to a named pain first."
- rep_skipped_drill: "Pin the number you just heard — what is it costing them weekly?"
- rep_defended: "Pause and acknowledge the concern before responding — confirm it landed."
- rep_no_next_step: "Anchor a specific next step — date, owner, and agenda."

Output ONLY the markdown string in a JSON object: {"markdown": "..."}.`;

export async function runMarkdownWriter(opts: {
  utterance: Utterance;
  signalType: SignalType;
  play: SuggestionPlay;
  evidenceQuote: string;
  brief: PreCallBrief;
}): Promise<string> {
  const prompt = `# SIGNAL
Type: ${opts.signalType}
Play: ${opts.play}
Evidence quote: "${opts.evidenceQuote}"

# LATEST UTTERANCE (the one that triggered this signal)
[${opts.utterance.id}] ${opts.utterance.speaker.toUpperCase()}: ${opts.utterance.text}

# PRE-CALL BRIEF
Lead: ${opts.brief.lead.name}, ${opts.brief.lead.title} @ ${opts.brief.lead.company}
Call goal: ${opts.brief.callGoal}

Write the one-sentence whisper. Action verb first, ≤15 words, no buyer's name.`;

  const result = await llmGenerateObject({
    step: 'markdown_writer',
    modelKey: 'suggester',
    schema: MarkdownOutputSchema,
    prompt,
    system: MARKDOWN_WRITER_SYSTEM,
  });
  return result.markdown.trim();
}
