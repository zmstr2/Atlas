#!/usr/bin/env bun
/**
 * 13-model suggester bench — 40-turn realistic transcript.
 *
 * Models (all run in non-reasoning / minimal-reasoning mode):
 *   qwen/qwen3.6-35b-a3b          reasoning: { enabled: false }
 *   qwen/qwen3.6-27b               reasoning: { enabled: false }
 *   qwen/qwen3.5-9b                reasoning: { enabled: false }
 *   google/gemma-4-31b-it          reasoning: { enabled: false }
 *   google/gemma-4-26b-a4b-it      reasoning: { enabled: false }
 *   z-ai/glm-4.7-flash             reasoning: { enabled: false }
 *   openai/gpt-oss-20b             reasoning: { effort: 'low' }
 *   nvidia/nemotron-3-nano-30b-a3b (none — non-reasoning model)
 *   deepseek/deepseek-chat-v3.1    reasoning: { enabled: false }
 *   deepseek/deepseek-v3.1-terminus reasoning: { enabled: false }
 *   deepseek/deepseek-v4-flash     reasoning: { enabled: false }
 *   meta-llama/llama-4-maverick    (none — non-reasoning model)
 *   meta-llama/llama-3.3-70b-instruct (none — non-reasoning model)
 *
 * Metrics per model:
 *   avg/p50/p95 TTFT, avg/p50/p95 TTLT, avg cost/suggestion, cost/1k suggestions
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun apps/agent/scripts/bench-suggester-13way.ts
 */

import { resolve } from 'node:path';

const TOKEN = process.env.OPENROUTER_API_KEY;
if (!TOKEN) { console.log('skipped — no OPENROUTER_API_KEY'); process.exit(0); }
process.on('unhandledRejection', (r) => console.error('[unhandled]', r));
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const ROOT = resolve(import.meta.dir, '..', '..', '..');

function extractStringLiteral(source: string, exportName: string): string {
  const re = new RegExp(`(?:export )?const ${exportName}\\s*=\\s*\`([\\s\\S]*?)\`;`, 'm');
  const m = source.match(re);
  if (!m) throw new Error(`couldn't extract ${exportName}`);
  return m[1];
}
const PROSPECT_SYS = extractStringLiteral(
  await Bun.file(resolve(ROOT, 'apps/agent/src/agents/prospectSuggester.ts')).text(),
  'SYSTEM',
);
const REP_SYS = extractStringLiteral(
  await Bun.file(resolve(ROOT, 'apps/agent/src/agents/repWatcher.ts')).text(),
  'SYSTEM',
);
console.log(`Prospect prompt: ${PROSPECT_SYS.length} chars`);
console.log(`Rep prompt:      ${REP_SYS.length} chars\n`);

// ── Brief ────────────────────────────────────────────────────────────────────
const BRIEF = {
  lead: { name: 'Sam Lin', title: 'Director of Sales Ops', company: 'GearStack' },
  callGoal: 'Discovery — qualify fit for AI sales coaching, identify champion + decision process',
  productSnippets: [
    'Atlas surfaces top 2-3 coachable moments per rep per week',
    'Manager dashboards show coaching coverage gaps before 1:1s',
    'Live in-call nudges based on BANT/MEDDIC anchors',
    'Integrates with HubSpot, Salesloft, Outreach, Gong recordings',
    'Typical ramp-time reduction: 15-25 days at 6 months',
    'Pricing scales with seat count; pilot programs available',
  ],
};

// ── 40-turn transcript ───────────────────────────────────────────────────────
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string };
const TRANSCRIPT: Utt[] = [
  { id: 'u1',  speaker: 'rep',      text: "Hey Sam, thanks for making time today. Quick one before we dive in — how's your week been?" },
  { id: 'u2',  speaker: 'customer', text: "Pretty hectic actually, we're closing the Q1 forecast this week so half my team is heads-down." },
  { id: 'u3',  speaker: 'rep',      text: "Got it. Won't take more than twenty minutes. Mind if I share what I learned from Diana then we can dig into what you're trying to solve?" },
  { id: 'u4',  speaker: 'customer', text: "Yeah go ahead, that works for me." },
  { id: 'u5',  speaker: 'rep',      text: "So Diana mentioned you've been looking at sales coaching tools. What's prompting that?" },
  { id: 'u6',  speaker: 'customer', text: "Honestly it's gotten kind of urgent. Our SDR ramp time has crept from like sixty days to over a hundred days in the last year, and our VP of Sales is asking why." },
  { id: 'u7',  speaker: 'rep',      text: "That's a big jump. How are you measuring ramp today — is it time to first closed-won, time to quota, something else?" },
  { id: 'u8',  speaker: 'customer', text: "Time to eighty percent of quota, basically." },
  { id: 'u9',  speaker: 'rep',      text: "Got it. And what's the team size we're talking about — how many SDRs, how many AEs?" },
  { id: 'u10', speaker: 'customer', text: "We've got twenty-four SDRs, eighteen AEs, and managers split across three regions." },
  { id: 'u11', speaker: 'rep',      text: "Three regions — are they on the same playbook or different?" },
  { id: 'u12', speaker: 'customer', text: "EMEA and APAC have totally different scripts and call patterns from NA. We've tried to standardize but the regional VPs push back." },
  { id: 'u13', speaker: 'rep',      text: "What does that push-back look like — is it a coaching alignment thing or a process thing?" },
  { id: 'u14', speaker: 'customer', text: "Both. EMEA has a longer sales cycle — more committee-driven. So the same coaching framework lands flat there." },
  { id: 'u15', speaker: 'rep',      text: "Right. Have you tried a coaching tool before, or is this the first time you're considering one?" },
  { id: 'u16', speaker: 'customer', text: "We had Gong for eighteen months but ripped it out last quarter. Cost was hard to justify and the AI summaries weren't actionable enough for our managers." },
  { id: 'u17', speaker: 'rep',      text: "Interesting — so what'd be different about evaluating Atlas specifically?" },
  { id: 'u18', speaker: 'customer', text: "Honestly I'm not sure yet. We need something that actually changes manager behavior, not just produces transcripts. Gong was great at recording, terrible at coaching." },
  { id: 'u19', speaker: 'rep',      text: "What does 'changes manager behavior' look like for you concretely?" },
  { id: 'u20', speaker: 'customer', text: "Like, my managers should walk into 1:1s knowing the top two coachable moments per rep without me prompting them. Right now they wing it." },
  { id: 'u21', speaker: 'rep',      text: "That's a great success metric. Who else is involved in this evaluation?" },
  { id: 'u22', speaker: 'customer', text: "Me primarily, then my VP Sales, Aisha Patel. And probably our CFO if it's over a hundred K because we've got a tighter approval process this year." },
  { id: 'u23', speaker: 'rep',      text: "Got it. What's the timeline you're working with — is there a trigger that's pushing this?" },
  { id: 'u24', speaker: 'customer', text: "We want to have something rolled out before our sales kickoff in late June." },
  { id: 'u25', speaker: 'rep',      text: "And what's your budget range for this?" },
  { id: 'u26', speaker: 'customer', text: "We've earmarked roughly one fifty to two hundred K annual for the whole sales tech stack refresh, but coaching specifically would be a slice of that." },
  { id: 'u27', speaker: 'rep',      text: "Great range. Let me show you our pricing then so we can see if there's fit." },
  { id: 'u28', speaker: 'customer', text: "Sure but quickly — can you do an annual contract or is it monthly only?" },
  { id: 'u29', speaker: 'rep',      text: "Annual is what we recommend, but we're flexible. Quick question though — when Gong didn't deliver, who at your end was the loudest voice that wanted to keep it?" },
  { id: 'u30', speaker: 'customer', text: "Honestly that was Aisha. She loved the call recording for QA. So if we move off Gong replacement she's going to want to know we keep that capability." },
  { id: 'u31', speaker: 'rep',      text: "Got it — call recording for QA. We do that. What else does Aisha care about?" },
  { id: 'u32', speaker: 'customer', text: "She'd probably want to see this work for her top two reps before rolling out to the full team." },
  { id: 'u33', speaker: 'rep',      text: "That's actually how most of our customers start. Sounds like we're aligned." },
  { id: 'u34', speaker: 'customer', text: "How long does implementation take? We can't have something disruptive while we're closing Q1." },
  { id: 'u35', speaker: 'rep',      text: "Implementation is usually two to three weeks, but we can be flexible. Should I send you references from teams your size?" },
  { id: 'u36', speaker: 'customer', text: "Yeah send those. And what does the success metric tracking look like once we're live? My CFO is going to ask me what ROI looks like in month six." },
  { id: 'u37', speaker: 'rep',      text: "Great question. We typically baseline against three KPIs you pick — let's hammer those out next week. What's good for you Tuesday?" },
  { id: 'u38', speaker: 'customer', text: "Tuesday afternoon could work. Send a few options." },
  { id: 'u39', speaker: 'rep',      text: "Will do. One last thing — anyone else from your end who should be on Tuesday's call?" },
  { id: 'u40', speaker: 'customer', text: "Probably Aisha, and our SalesOps lead Devon — he runs our tooling stack so any deployment touches his team." },
];

// ── Gold standards ───────────────────────────────────────────────────────────
type Gold =
  | { fire: false; rationale: string }
  | { fire: true; play: string; markdown: string; rationale: string };

const GOLD: Record<string, Gold> = {
  u1:  { fire: false, rationale: 'Greeting / rapport. No axis signal yet.' },
  u2:  { fire: false, rationale: 'Small talk about workload. No axis signal.' },
  u3:  { fire: false, rationale: 'Rep agenda-setting. Reasonable open.' },
  u4:  { fire: false, rationale: 'Acknowledgment, no new ground.' },
  u5:  { fire: false, rationale: 'Open discovery question — exactly what rep should be doing.' },
  u6:  { fire: true,  play: 'quantify_pain', markdown: 'Pin the cost of forty extra ramp days — quota miss × twenty-four SDRs.', rationale: 'Concrete metric (60→100 days) just dropped. The rep should make that real in dollars.' },
  u7:  { fire: false, rationale: 'Rep is drilling correctly — exact metric definition.' },
  u8:  { fire: false, rationale: 'Clear specific answer. No drill needed.' },
  u9:  { fire: false, rationale: 'Good breadth question.' },
  u10: { fire: false, rationale: 'Clean factual answer.' },
  u11: { fire: false, rationale: 'Reasonable clarifier.' },
  u12: { fire: true,  play: 'drill_vague', markdown: 'Drill what "push back" means — process disagreement or political turf.', rationale: '"Push back" is vague but sits at the cause of the standardization gap.' },
  u13: { fire: false, rationale: 'Rep is drilling exactly the right thing.' },
  u14: { fire: true,  play: 'drill_vague', markdown: 'Quantify EMEA cycle length vs NA — and which region missed quota last quarter.', rationale: 'EMEA-specific cycle length defines whether one product solves both.' },
  u15: { fire: false, rationale: 'Good history probe.' },
  u16: { fire: true,  play: 'reframe_objection', markdown: 'Anchor on "AI summaries weren\'t actionable" — what would actionable have looked like.', rationale: 'Past failure with named tool. The "actionable" criterion is the buying yardstick.' },
  u17: { fire: true,  play: 'rep_leading_question', markdown: 'Don\'t pivot to Atlas yet — drill why Gong\'s coaching failed before differentiating.', rationale: 'Rep is leading prospect to validate Atlas instead of probing Gong failure mode.' },
  u18: { fire: true,  play: 'drill_vague', markdown: 'Make "changes manager behavior" measurable — what\'s the leading indicator.', rationale: 'Vague success criterion. Without measurable definition there\'s no way to know if Atlas wins.' },
  u19: { fire: false, rationale: 'Rep is drilling well — pushing for concrete success criterion.' },
  u20: { fire: true,  play: 'capture_every_specific', markdown: 'Lock "top-two moments per rep per 1:1" as the success metric — confirm cadence.', rationale: 'Prospect just defined success in their own words. Anchor it before it drifts.' },
  u21: { fire: false, rationale: 'Multi-thread probe — exactly the right move.' },
  u22: { fire: true,  play: 'capture_every_specific', markdown: 'Probe Aisha\'s eval role — and what "tighter process" means at the hundred-K threshold.', rationale: 'Three specifics dropped (Aisha + CFO + $100K trigger).' },
  u23: { fire: false, rationale: 'Good timeline probe.' },
  u24: { fire: true,  play: 'capture_every_specific', markdown: 'Lock the late-June SKO as the deadline — work back to a deployment-ready date.', rationale: 'Hard deadline named. Anchor it before pricing or scope discussion.' },
  u25: { fire: true,  play: 'rep_skipped_drill', markdown: 'Pause on budget — pain hasn\'t been quantified yet. Drill ramp-time cost first.', rationale: 'Rep jumped to budget before the value side was anchored.' },
  u26: { fire: true,  play: 'capture_every_specific', markdown: 'Anchor the slice — what % of one-fifty to two hundred K is realistically for coaching.', rationale: 'Prospect signaled this is a slice of a larger budget. The carve-out matters more.' },
  u27: { fire: true,  play: 'rep_premature_discount', markdown: 'Don\'t show pricing yet — anchor pain in dollars before introducing cost.', rationale: 'Rep is jumping to pricing before champion is locked or pain is monetized.' },
  u28: { fire: true,  play: 'trial_close', markdown: 'Treat the contract question as a buying signal — confirm decision-maker for terms.', rationale: '"Annual or monthly" is a buying-signal question. Sharpen to who makes the call.' },
  u29: { fire: false, rationale: 'Excellent champion-of-the-old probe.' },
  u30: { fire: true,  play: 'develop_champion', markdown: 'Aisha\'s loyalty was the recording — confirm we cover that before pivoting to coaching.', rationale: 'Aisha is the champion-of-the-old. Her hard requirement must be covered or the deal dies.' },
  u31: { fire: false, rationale: 'Right next probe — uncover Aisha\'s broader criteria.' },
  u32: { fire: true,  play: 'capture_every_specific', markdown: 'Pilot scope: top-two reps. Pin which reps and the success criteria.', rationale: 'Pilot strategy revealed. Scope determines whether pilot is winnable.' },
  u33: { fire: true,  play: 'rep_defended_objection', markdown: 'Don\'t validate the two-rep pilot — explore if those reps are representative.', rationale: 'Rep closing on pilot scope without checking if reps are representative.' },
  u34: { fire: true,  play: 'capture_every_specific', markdown: 'Confirm implementation can start post-Q1 close — late March / early April window.', rationale: 'Two timing constraints stacked: Q1 freeze + late-June SKO. Window is narrow.' },
  u35: { fire: false, rationale: 'Solid next-step offer (references).' },
  u36: { fire: true,  play: 'develop_champion', markdown: 'Equip Sam with the month-six ROI story — ramp-time delta × loaded SDR cost.', rationale: 'CFO question = champion-coaching opportunity. Sam needs the answer pre-loaded.' },
  u37: { fire: false, rationale: 'Good close — proposes specific time.' },
  u38: { fire: true,  play: 'anchor_next_step', markdown: 'Propose Tuesday 2 PM and 4 PM — invite Aisha and ask if Devon should join.', rationale: 'Specific time + sweep the named stakeholders into the same invite.' },
  u39: { fire: false, rationale: 'Good multi-thread question.' },
  u40: { fire: true,  play: 'capture_every_specific', markdown: 'Devon owns the stack — invite him to surface deployment dependencies before Tuesday.', rationale: 'New stakeholder named, with role context. Should be in the next call.' },
};

const SUG_JSON_INSTR = `Output ONLY a compact JSON object matching:
{"shouldFire":<bool>,"priority":"<critical|nudge|fyi>","play":"<one of taxonomy>","axis":"<need|budget|authority|timeline|metric|champion|consequence|competitor|stakeholder> OR null","markdown":"<≤15 words>","reasoning":"<one paragraph>","groundedInUtteranceIds":[],"groundedInAnchorTurnIds":[]}
Output ONE JSON object only. No <think> blocks, no preamble, no markdown fences. Begin with { and end with }.`;

function buildUserMsg(utt: Utt, hotTail: Utt[], speaker: 'rep' | 'customer'): string {
  const tailStr = hotTail.map(h => `[${h.id}] ${h.speaker.toUpperCase()}: ${h.text}`).join('\n');
  if (speaker === 'customer') {
    const priorRep = [...hotTail].reverse().find(h => h.speaker === 'rep');
    return `# CALL CONTEXT
${tailStr || '(start of call)'}

# PRE-CALL BRIEF
Lead: ${BRIEF.lead.name}, ${BRIEF.lead.title} @ ${BRIEF.lead.company}
Call goal: ${BRIEF.callGoal}
Product snippets: ${BRIEF.productSnippets.slice(0, 4).join(' | ')}

# IMMEDIATE PRIOR REP UTTERANCE
${priorRep ? `[${priorRep.id}] REP: ${priorRep.text}` : '(none)'}

# NEW PROSPECT UTTERANCE
[${utt.id}] PROSPECT: ${utt.text}

# CONTRADICTIONS DETECTED
(none)

Decide whether to fire a suggestion.

${SUG_JSON_INSTR}`;
  } else {
    const priorProspect = [...hotTail].reverse().find(h => h.speaker === 'customer');
    return `# CALL CONTEXT
${tailStr || '(start of call)'}

# PRE-CALL BRIEF
Lead: ${BRIEF.lead.name}, ${BRIEF.lead.title} @ ${BRIEF.lead.company}
Call goal: ${BRIEF.callGoal}

# IMMEDIATE PRIOR PROSPECT UTTERANCE
${priorProspect ? `[${priorProspect.id}] PROSPECT: ${priorProspect.text}` : '(none)'}

# NEW REP UTTERANCE
[${utt.id}] REP: ${utt.text}

# CONTRADICTIONS DETECTED
(none)

Decide whether the rep made a mistake or missed a cue. Default to shouldFire=false.

${SUG_JSON_INSTR}`;
  }
}

// ── Models ───────────────────────────────────────────────────────────────────
type Reasoning =
  | { enabled: false }
  | { effort: 'low' };

type Variant = {
  label: string;
  orId: string;
  reasoning?: Reasoning;
};

const VARIANTS: Variant[] = [
  { label: 'qwen3.6-35b-a3b',          orId: 'qwen/qwen3.6-35b-a3b',                reasoning: { enabled: false } },
  { label: 'qwen3.6-27b',              orId: 'qwen/qwen3.6-27b',                    reasoning: { enabled: false } },
  { label: 'qwen3.5-9b',               orId: 'qwen/qwen3.5-9b',                     reasoning: { enabled: false } },
  { label: 'gemma-4-31b-it',           orId: 'google/gemma-4-31b-it',               reasoning: { enabled: false } },
  { label: 'gemma-4-26b-a4b-it',       orId: 'google/gemma-4-26b-a4b-it',           reasoning: { enabled: false } },
  { label: 'glm-4.7-flash',            orId: 'z-ai/glm-4.7-flash',                  reasoning: { enabled: false } },
  { label: 'gpt-oss-20b (effort:low)', orId: 'openai/gpt-oss-20b',                  reasoning: { effort: 'low' } },
  { label: 'nemotron-3-nano-30b',      orId: 'nvidia/nemotron-3-nano-30b-a3b' },
  { label: 'deepseek-chat-v3.1',       orId: 'deepseek/deepseek-chat-v3.1',         reasoning: { enabled: false } },
  { label: 'deepseek-v3.1-terminus',   orId: 'deepseek/deepseek-v3.1-terminus',     reasoning: { enabled: false } },
  { label: 'deepseek-v4-flash',        orId: 'deepseek/deepseek-v4-flash',          reasoning: { enabled: false } },
  { label: 'llama-4-maverick',         orId: 'meta-llama/llama-4-maverick' },
  { label: 'llama-3.3-70b-instruct',   orId: 'meta-llama/llama-3.3-70b-instruct' },
];

// ── Call function (streaming, captures TTFT + TTLT) ──────────────────────────
type CallResult = {
  text: string;
  ttftMs: number;   // time to first content token
  ttltMs: number;   // time to last token (full response)
  promptTokens: number;
  completionTokens: number;
  providerName?: string;
  error?: string;
};

async function callOR(v: Variant, system: string, userMsg: string): Promise<CallResult> {
  const start = Date.now();
  let text = '';
  let ttftMs = -1;
  let promptTokens = 0;
  let completionTokens = 0;
  let providerName: string | undefined;

  try {
    const body: any = {
      model: v.orId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      max_tokens: 4000,
      stream: true,
      stream_options: { include_usage: true },
      provider: { sort: 'throughput' },
    };
    if (v.reasoning) body.reasoning = v.reasoning;

    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });

    if (!r.ok) {
      const errText = (await r.text()).slice(0, 300);
      return { text: '', ttftMs: -1, ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: `HTTP ${r.status}: ${errText}` };
    }
    if (!r.body) {
      return { text: '', ttftMs: -1, ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: 'no body' };
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const p = line.slice(6).trim();
          if (p === '[DONE]') continue;
          try {
            const j = JSON.parse(p);
            const d = j?.choices?.[0]?.delta?.content;
            if (typeof d === 'string' && d.length > 0) {
              if (ttftMs < 0) ttftMs = Date.now() - start;  // first content token
              text += d;
            }
            if (j?.usage) {
              promptTokens = j.usage.prompt_tokens ?? 0;
              completionTokens = j.usage.completion_tokens ?? 0;
            }
            if (j?.provider) providerName = j.provider;
          } catch {}
        }
      }
    }

    const ttltMs = Date.now() - start;
    // fallback token estimates if usage not returned
    if (promptTokens === 0 && (system.length + userMsg.length) > 0) {
      promptTokens = Math.ceil((system.length + userMsg.length) / 4);
    }
    if (completionTokens === 0 && text.length > 0) {
      completionTokens = Math.ceil(text.length / 4);
    }
    if (ttftMs < 0) ttftMs = ttltMs; // no content tokens (parse-only output)

    return { text, ttftMs, ttltMs, promptTokens, completionTokens, providerName };
  } catch (err) {
    return {
      text,
      ttftMs: ttftMs >= 0 ? ttftMs : Date.now() - start,
      ttltMs: Date.now() - start,
      promptTokens: 0,
      completionTokens: 0,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

// ── JSON parsing ─────────────────────────────────────────────────────────────
function tryParseFirstJson(text: string): any | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── Scoring ──────────────────────────────────────────────────────────────────
function scoreCell(gold: Gold, result: any | null, error?: string): { score: number; note: string } {
  if (!result) return { score: 0, note: error ? `parse_fail (${error.slice(0, 40)})` : 'parse_fail' };
  const fired = !!result.shouldFire;
  if (gold.fire === false) {
    if (!fired) return { score: 5, note: 'correctly silent' };
    return { score: 1, note: `over-fired: [${result.play ?? '?'}] "${result.markdown ?? ''}"`.slice(0, 130) };
  }
  if (!fired) return { score: 1, note: 'wrongly silent — should have fired' };
  const playMatch = (result.play ?? '').toLowerCase() === gold.play.toLowerCase();
  const md = (result.markdown ?? '').toLowerCase();
  const goldTokens = new Set(
    gold.markdown.toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(t => t.length > 4 && !['confirm','before','their','about','asking','should'].includes(t))
  );
  const mdTokens = new Set(md.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/));
  const overlap = [...goldTokens].filter(t => mdTokens.has(t)).length;
  if (playMatch && overlap >= 2) return { score: 5, note: 'fired correct play + sharp anchor' };
  if (playMatch && overlap >= 1) return { score: 4, note: 'fired correct play, anchor partial' };
  if (playMatch)                  return { score: 3, note: 'fired correct play, generic markdown' };
  if (overlap >= 2)               return { score: 3, note: 'wrong play but markdown sharp' };
  return { score: 2, note: 'fired but off-target' };
}

// ── Percentile helper ─────────────────────────────────────────────────────────
function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// ── Concurrency limiter ───────────────────────────────────────────────────────
// Cap total in-flight calls to avoid overwhelming connections.
// 40 concurrent = ~3 per model, which OpenRouter handles comfortably.
function makeSemaphore(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = () => new Promise<void>(resolve => {
    if (active < limit) { active++; resolve(); }
    else queue.push(resolve);
  });
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) { active++; next(); }
  };
  return { acquire, release };
}

// ── Main ─────────────────────────────────────────────────────────────────────
type CellResult = {
  variantLabel: string; orId: string; turnId: string; speaker: 'rep' | 'customer';
  ttftMs: number; ttltMs: number; promptTokens: number; completionTokens: number;
  providerName?: string; error?: string; result: any | null;
  score: number; scoreNote: string;
};

async function main() {
  const t0 = Date.now();
  const total = VARIANTS.length * TRANSCRIPT.length;
  const CONCURRENCY = 40;
  console.log(`Bench: ${VARIANTS.length} models × ${TRANSCRIPT.length} turns = ${total} calls (concurrency=${CONCURRENCY})\n`);

  const sem = makeSemaphore(CONCURRENCY);

  const tasks: Promise<CellResult>[] = [];
  for (const v of VARIANTS) {
    for (let i = 0; i < TRANSCRIPT.length; i++) {
      const utt = TRANSCRIPT[i];
      const hotTail = TRANSCRIPT.slice(Math.max(0, i - 6), i);
      const sys = utt.speaker === 'customer' ? PROSPECT_SYS : REP_SYS;
      const userMsg = buildUserMsg(utt, hotTail, utt.speaker);
      tasks.push((async (): Promise<CellResult> => {
        await sem.acquire();
        let r = await callOR(v, sys, userMsg);
        // one retry on transient connection errors
        if (r.error && (r.error.includes('socket') || r.error.includes('connect') || r.error.includes('timeout'))) {
          await new Promise(res => setTimeout(res, 500 + Math.random() * 1000));
          r = await callOR(v, sys, userMsg);
        }
        sem.release();
        const parsed = tryParseFirstJson(r.text);
        const { score, note } = scoreCell(GOLD[utt.id], parsed, r.error);
        return {
          variantLabel: v.label, orId: v.orId, turnId: utt.id, speaker: utt.speaker,
          ttftMs: r.ttftMs, ttltMs: r.ttltMs,
          promptTokens: r.promptTokens, completionTokens: r.completionTokens,
          providerName: r.providerName, error: r.error, result: parsed,
          score, scoreNote: note,
        };
      })());
    }
  }

  const results = await Promise.all(tasks);
  console.log(`All calls done in ${((Date.now() - t0) / 1000).toFixed(1)}s wall\n`);

  // ── Fetch pricing ────────────────────────────────────────────────────────
  console.log('Fetching OpenRouter pricing...');
  const pricingRes = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const pricingJson = await pricingRes.json();
  const pricing = new Map<string, { promptPer1M: number; completionPer1M: number }>();
  for (const m of pricingJson.data ?? []) {
    const pp = parseFloat(m.pricing?.prompt ?? '0');
    const cp = parseFloat(m.pricing?.completion ?? '0');
    // OpenRouter returns cost per token; multiply by 1M for human-readable per-1M
    pricing.set(m.id, { promptPer1M: pp * 1_000_000, completionPer1M: cp * 1_000_000 });
  }

  // ── Per-turn comparison ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(200));
  console.log('PER-TURN COMPARISON (★ = gold standard)');
  console.log('═'.repeat(200));

  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const utt = TRANSCRIPT[i];
    const gold = GOLD[utt.id];
    const tag = utt.speaker === 'rep' ? 'REP' : 'PROSPECT';
    console.log(`\n• ${utt.id}  ${tag}: ${utt.text.slice(0, 180)}${utt.text.length > 180 ? '…' : ''}`);
    if (gold.fire) {
      console.log(`  ★ GOLD  fire=true  [${gold.play}] "${gold.markdown}"`);
    } else {
      console.log(`  ★ GOLD  fire=false  (${gold.rationale.slice(0, 90)})`);
    }
    for (const v of VARIANTS) {
      const r = results.find(x => x.variantLabel === v.label && x.turnId === utt.id)!;
      const fired = r.result?.shouldFire;
      const sBits = r.result
        ? (fired
            ? `🔥 [${(r.result.play ?? '?').padEnd(24)}] "${(r.result.markdown ?? '').slice(0, 100)}"`
            : `🤐 silent`)
        : `ERR: ${r.error?.slice(0, 60) ?? 'parse_fail'}`;
      const ttft = r.ttftMs >= 0 ? `ttft=${(r.ttftMs/1000).toFixed(1)}s` : 'ttft=n/a';
      const ttlt = `ttlt=${(r.ttltMs/1000).toFixed(1)}s`;
      console.log(`  ${v.label.padEnd(28)} score=${r.score}  ${ttft}  ${ttlt}  ${sBits}`);
    }
  }

  // ── Aggregate ────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(200));
  console.log('AGGREGATE — sorted by avg quality score desc');
  console.log('═'.repeat(200));

  const fireTurnIds  = TRANSCRIPT.filter(u => (GOLD[u.id] as any).fire === true).map(u => u.id);
  const silentTurnIds = TRANSCRIPT.filter(u => (GOLD[u.id] as any).fire === false).map(u => u.id);

  const rows = VARIANTS.map(v => {
    const cells = results.filter(r => r.variantLabel === v.label);
    const ok = cells.filter(r => r.result !== null).length;
    const avgScore    = cells.reduce((s, r) => s + r.score, 0) / cells.length;
    const fireCells   = cells.filter(c => fireTurnIds.includes(c.turnId));
    const silentCells = cells.filter(c => silentTurnIds.includes(c.turnId));
    const fireScore   = fireCells.reduce((s, r) => s + r.score, 0) / fireCells.length;
    const silentScore = silentCells.reduce((s, r) => s + r.score, 0) / silentCells.length;

    // TTFT stats (exclude error calls where ttftMs might equal ttltMs artificially)
    const ttftArr = cells.filter(r => !r.error).map(r => r.ttftMs);
    const ttltArr = cells.filter(r => !r.error).map(r => r.ttltMs);
    const avgTtft = ttftArr.length ? ttftArr.reduce((a, b) => a + b, 0) / ttftArr.length : 0;
    const avgTtlt = ttltArr.length ? ttltArr.reduce((a, b) => a + b, 0) / ttltArr.length : 0;
    const p50Ttft = ttftArr.length ? pct(ttftArr, 0.5) : 0;
    const p95Ttft = ttftArr.length ? pct(ttftArr, 0.95) : 0;
    const p50Ttlt = ttltArr.length ? pct(ttltArr, 0.5) : 0;
    const p95Ttlt = ttltArr.length ? pct(ttltArr, 0.95) : 0;

    // Cost
    const totalPromptTok      = cells.reduce((s, r) => s + r.promptTokens, 0);
    const totalCompletionTok  = cells.reduce((s, r) => s + r.completionTokens, 0);
    const price = pricing.get(v.orId);
    let totalCostUsd = 0;
    if (price) {
      totalCostUsd = (totalPromptTok * price.promptPer1M + totalCompletionTok * price.completionPer1M) / 1_000_000;
    }
    const avgCostPerSuggestion = totalCostUsd / cells.length;
    const costPer1k = avgCostPerSuggestion * 1000;

    const providers = [...new Set(cells.map(c => c.providerName).filter(Boolean))];

    return {
      v, cells, ok, avgScore, fireScore, silentScore,
      avgTtft, p50Ttft, p95Ttft,
      avgTtlt, p50Ttlt, p95Ttlt,
      totalPromptTok, totalCompletionTok,
      totalCostUsd, avgCostPerSuggestion, costPer1k,
      providers,
    };
  }).sort((a, b) => b.avgScore - a.avgScore);

  // Print aggregate table
  const cols    = ['model', 'avg', 'fire', 'silent', 'ok', 'TTFT avg', 'TTFT p50', 'TTFT p95', 'TTLT avg', 'TTLT p50', 'TTLT p95', '$/sug', '$/1k sug', 'providers'];
  const widths  = [30,       6,     6,      7,        6,    9,          9,           9,           9,          9,          9,          10,      10,         30];
  console.log('\n' + cols.map((c, i) => c.padEnd(widths[i])).join('  '));
  console.log(widths.map(w => '─'.repeat(w)).join('  '));

  for (const r of rows) {
    const ms = (n: number) => `${(n / 1000).toFixed(2)}s`;
    const row = [
      r.v.label,
      r.avgScore.toFixed(2),
      r.fireScore.toFixed(2),
      r.silentScore.toFixed(2),
      `${r.ok}/${r.cells.length}`,
      ms(r.avgTtft),
      ms(r.p50Ttft),
      ms(r.p95Ttft),
      ms(r.avgTtlt),
      ms(r.p50Ttlt),
      ms(r.p95Ttlt),
      `$${r.avgCostPerSuggestion.toFixed(5)}`,
      `$${r.costPer1k.toFixed(3)}`,
      r.providers.join(',').slice(0, 30),
    ];
    console.log(row.map((c, i) => String(c).padEnd(widths[i])).join('  '));
  }

  const grandTotal = rows.reduce((s, r) => s + r.totalCostUsd, 0);
  console.log(`\nTotal bench cost (${total} calls across all models):  $${grandTotal.toFixed(4)}`);
  console.log(`fire turns: ${fireTurnIds.length}  |  silent turns: ${silentTurnIds.length}`);
  if (!pricing.size) console.log('\n⚠  Pricing data unavailable — cost columns will be $0.00000');
}

main().catch(console.error);
