#!/usr/bin/env bun
/**
 * 40-turn realistic suggester eval.
 *
 * Scenario: Atlas (AI sales coaching) selling to Sam Lin, Director of Sales Ops
 * at GearStack (B2B fintech, 200 employees), evaluating coaching tooling.
 *
 * Mix:
 *   - 16 prospect FIRE moments     (gold standard play + markdown)
 *   - 4 prospect silent moments    (greetings/transitions/clear answers)
 *   - 4 rep FIRE moments           (rep_watcher catches: leading_question,
 *                                   skipped_drill, premature_pricing,
 *                                   defended_objection)
 *   - 16 rep silent moments        (good discovery questions)
 *
 * Models tested:
 *   - gpt-5.4-mini (low)
 *   - qwen/qwen3-vl-32b-instruct
 *   - inception/mercury-2
 *   - openai/gpt-oss-20b (low)
 *   - openai/gpt-oss-120b (low)   restricted to: groq, google-vertex/global,
 *                                  baseten/fp4
 *
 * 5-point scoring:
 *   5 = correct fire/silent decision + sharp markdown matching gold play
 *   4 = correct decision + markdown directionally right but less sharp
 *   3 = correct decision + generic markdown OR right intent / wrong play label
 *   2 = wrong decision but soft (borderline)
 *   1 = clearly wrong (silent when fire was needed, or fired wrong on silent)
 *   0 = parse fail
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun apps/agent/scripts/bench-suggester-40turn.ts
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

// ── Brief inline ────────────────────────────────────────────────────────────
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

// ── 40-turn synthetic transcript ────────────────────────────────────────────
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string };
const TRANSCRIPT: Utt[] = [
  // Phase 1: open
  { id: 'u1',  speaker: 'rep',      text: "Hey Sam, thanks for making time today. Quick one before we dive in — how's your week been?" },
  { id: 'u2',  speaker: 'customer', text: "Pretty hectic actually, we're closing the Q1 forecast this week so half my team is heads-down." },
  { id: 'u3',  speaker: 'rep',      text: "Got it. Won't take more than twenty minutes. Mind if I share what I learned from Diana then we can dig into what you're trying to solve?" },
  { id: 'u4',  speaker: 'customer', text: "Yeah go ahead, that works for me." },
  // Phase 2: discovery open
  { id: 'u5',  speaker: 'rep',      text: "So Diana mentioned you've been looking at sales coaching tools. What's prompting that?" },
  { id: 'u6',  speaker: 'customer', text: "Honestly it's gotten kind of urgent. Our SDR ramp time has crept from like sixty days to over a hundred days in the last year, and our VP of Sales is asking why." },
  { id: 'u7',  speaker: 'rep',      text: "That's a big jump. How are you measuring ramp today — is it time to first closed-won, time to quota, something else?" },
  { id: 'u8',  speaker: 'customer', text: "Time to eighty percent of quota, basically." },
  { id: 'u9',  speaker: 'rep',      text: "Got it. And what's the team size we're talking about — how many SDRs, how many AEs?" },
  { id: 'u10', speaker: 'customer', text: "We've got twenty-four SDRs, eighteen AEs, and managers split across three regions." },
  { id: 'u11', speaker: 'rep',      text: "Three regions — are they on the same playbook or different?" },
  { id: 'u12', speaker: 'customer', text: "EMEA and APAC have totally different scripts and call patterns from NA. We've tried to standardize but the regional VPs push back." },
  // Phase 3: pain depth
  { id: 'u13', speaker: 'rep',      text: "What does that push-back look like — is it a coaching alignment thing or a process thing?" },
  { id: 'u14', speaker: 'customer', text: "Both. EMEA has a longer sales cycle — more committee-driven. So the same coaching framework lands flat there." },
  { id: 'u15', speaker: 'rep',      text: "Right. Have you tried a coaching tool before, or is this the first time you're considering one?" },
  { id: 'u16', speaker: 'customer', text: "We had Gong for eighteen months but ripped it out last quarter. Cost was hard to justify and the AI summaries weren't actionable enough for our managers." },
  { id: 'u17', speaker: 'rep',      text: "Interesting — so what'd be different about evaluating Atlas specifically?" },
  { id: 'u18', speaker: 'customer', text: "Honestly I'm not sure yet. We need something that actually changes manager behavior, not just produces transcripts. Gong was great at recording, terrible at coaching." },
  { id: 'u19', speaker: 'rep',      text: "What does 'changes manager behavior' look like for you concretely?" },
  { id: 'u20', speaker: 'customer', text: "Like, my managers should walk into 1:1s knowing the top two coachable moments per rep without me prompting them. Right now they wing it." },
  // Phase 4: stakeholder & budget
  { id: 'u21', speaker: 'rep',      text: "That's a great success metric. Who else is involved in this evaluation?" },
  { id: 'u22', speaker: 'customer', text: "Me primarily, then my VP Sales, Aisha Patel. And probably our CFO if it's over a hundred K because we've got a tighter approval process this year." },
  { id: 'u23', speaker: 'rep',      text: "Got it. What's the timeline you're working with — is there a trigger that's pushing this?" },
  { id: 'u24', speaker: 'customer', text: "We want to have something rolled out before our sales kickoff in late June." },
  { id: 'u25', speaker: 'rep',      text: "And what's your budget range for this?" },
  { id: 'u26', speaker: 'customer', text: "We've earmarked roughly one fifty to two hundred K annual for the whole sales tech stack refresh, but coaching specifically would be a slice of that." },
  { id: 'u27', speaker: 'rep',      text: "Great range. Let me show you our pricing then so we can see if there's fit." },
  { id: 'u28', speaker: 'customer', text: "Sure but quickly — can you do an annual contract or is it monthly only?" },
  // Phase 5: champion / pilot dynamics
  { id: 'u29', speaker: 'rep',      text: "Annual is what we recommend, but we're flexible. Quick question though — when Gong didn't deliver, who at your end was the loudest voice that wanted to keep it?" },
  { id: 'u30', speaker: 'customer', text: "Honestly that was Aisha. She loved the call recording for QA. So if we move off Gong replacement she's going to want to know we keep that capability." },
  { id: 'u31', speaker: 'rep',      text: "Got it — call recording for QA. We do that. What else does Aisha care about?" },
  { id: 'u32', speaker: 'customer', text: "She'd probably want to see this work for her top two reps before rolling out to the full team." },
  { id: 'u33', speaker: 'rep',      text: "That's actually how most of our customers start. Sounds like we're aligned." },
  { id: 'u34', speaker: 'customer', text: "How long does implementation take? We can't have something disruptive while we're closing Q1." },
  // Phase 6: close
  { id: 'u35', speaker: 'rep',      text: "Implementation is usually two to three weeks, but we can be flexible. Should I send you references from teams your size?" },
  { id: 'u36', speaker: 'customer', text: "Yeah send those. And what does the success metric tracking look like once we're live? My CFO is going to ask me what ROI looks like in month six." },
  { id: 'u37', speaker: 'rep',      text: "Great question. We typically baseline against three KPIs you pick — let's hammer those out next week. What's good for you Tuesday?" },
  { id: 'u38', speaker: 'customer', text: "Tuesday afternoon could work. Send a few options." },
  { id: 'u39', speaker: 'rep',      text: "Will do. One last thing — anyone else from your end who should be on Tuesday's call?" },
  { id: 'u40', speaker: 'customer', text: "Probably Aisha, and our SalesOps lead Devon — he runs our tooling stack so any deployment touches his team." },
];

// ── Gold standards ──────────────────────────────────────────────────────────
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
  u12: { fire: true,  play: 'drill_vague', markdown: 'Drill what "push back" means — process disagreement or political turf.', rationale: '"Push back" is vague but sits at the cause of the standardization gap. Specific cause changes the playbook.' },
  u13: { fire: false, rationale: 'Rep is drilling exactly the right thing.' },
  u14: { fire: true,  play: 'drill_vague', markdown: 'Quantify EMEA cycle length vs NA — and which region missed quota last quarter.', rationale: 'EMEA-specific cycle length is the unspoken specific that defines whether one product solves both.' },
  u15: { fire: false, rationale: 'Good history probe.' },
  u16: { fire: true,  play: 'reframe_objection', markdown: 'Anchor on "AI summaries weren\'t actionable" — what would actionable have looked like.', rationale: 'Past failure with named tool. The "actionable" criterion is the buying yardstick — get it concrete now.' },
  u17: { fire: true,  play: 'rep_leading_question', markdown: 'Don\'t pivot to Atlas yet — drill why Gong\'s coaching failed before differentiating.', rationale: 'Rep is leading the prospect to validate Atlas instead of probing the Gong failure mode. Classic mistake.' },
  u18: { fire: true,  play: 'drill_vague', markdown: 'Make "changes manager behavior" measurable — what\'s the leading indicator.', rationale: 'Vague success criterion. Without a measurable definition, there\'s no way to know if Atlas wins.' },
  u19: { fire: false, rationale: 'Rep is drilling well — pushing for concrete success criterion.' },
  u20: { fire: true,  play: 'capture_every_specific', markdown: 'Lock "top-two moments per rep per 1:1" as the success metric — confirm cadence.', rationale: 'Prospect just defined success in their own words. Anchor it before it drifts.' },
  u21: { fire: false, rationale: 'Multi-thread probe — exactly the right move.' },
  u22: { fire: true,  play: 'capture_every_specific', markdown: 'Probe Aisha\'s eval role — and what "tighter process" means at the hundred-K threshold.', rationale: 'Three specifics dropped (Aisha + CFO + $100K trigger). The process question is the highest-leverage one.' },
  u23: { fire: false, rationale: 'Good timeline probe.' },
  u24: { fire: true,  play: 'capture_every_specific', markdown: 'Lock the late-June SKO as the deadline — work back to a deployment-ready date.', rationale: 'Hard deadline named. Anchor it before pricing or scope discussion.' },
  u25: { fire: true,  play: 'rep_skipped_drill', markdown: 'Pause on budget — pain hasn\'t been quantified yet. Drill ramp-time cost first.', rationale: 'Rep jumped to budget before the value side was anchored. Budget without value-anchor leads to discount pressure.' },
  u26: { fire: true,  play: 'capture_every_specific', markdown: 'Anchor the slice — what % of one-fifty to two hundred K is realistically for coaching.', rationale: 'Prospect signaled this is a slice of a larger budget. The carve-out matters more than the headline range.' },
  u27: { fire: true,  play: 'rep_premature_discount', markdown: 'Don\'t show pricing yet — anchor pain in dollars before introducing cost.', rationale: 'Rep is jumping to pricing before champion is locked or pain is monetized. Risks anchoring on a low number.' },
  u28: { fire: true,  play: 'trial_close', markdown: 'Treat the contract question as a buying signal — confirm decision-maker for terms.', rationale: '"Annual or monthly" is a buying-signal question. Sharpen to who makes the call before answering.' },
  u29: { fire: false, rationale: 'Excellent champion-of-the-old probe. Surfaces hidden requirement.' },
  u30: { fire: true,  play: 'develop_champion', markdown: 'Aisha\'s loyalty was the recording — confirm we cover that before pivoting to coaching.', rationale: 'Aisha is the champion-of-the-old. Her hard requirement (call recording for QA) must be covered or the deal dies.' },
  u31: { fire: false, rationale: 'Right next probe — uncover Aisha\'s broader criteria.' },
  u32: { fire: true,  play: 'capture_every_specific', markdown: 'Pilot scope: top-two reps. Pin which reps and the success criteria.', rationale: 'Pilot strategy revealed. Scope (which reps, what success looks like) determines whether pilot is winnable.' },
  u33: { fire: true,  play: 'rep_defended_objection', markdown: 'Don\'t validate the two-rep pilot — explore if those reps are representative.', rationale: 'Rep is implicitly closing on the pilot scope without checking if those reps are actually representative. Pilot can backfire.' },
  u34: { fire: true,  play: 'capture_every_specific', markdown: 'Confirm implementation can start post-Q1 close — late March / early April window.', rationale: 'Two timing constraints just stacked: Q1 freeze + late-June SKO. Implementation window is narrow.' },
  u35: { fire: false, rationale: 'Solid next-step offer (references).' },
  u36: { fire: true,  play: 'develop_champion', markdown: 'Equip Sam with the month-six ROI story — ramp-time delta × loaded SDR cost.', rationale: 'CFO question = champion-coaching opportunity. Sam needs the answer pre-loaded for the upward conversation.' },
  u37: { fire: false, rationale: 'Good close — proposes specific time.' },
  u38: { fire: true,  play: 'anchor_next_step', markdown: 'Propose Tuesday 2 PM and 4 PM — invite Aisha and ask if Devon should join.', rationale: 'Specific time + sweep the named stakeholders into the same invite.' },
  u39: { fire: false, rationale: 'Good multi-thread question.' },
  u40: { fire: true,  play: 'capture_every_specific', markdown: 'Devon owns the stack — invite him to surface deployment dependencies before Tuesday.', rationale: 'New stakeholder named, with role context. Should be in the next call.' },
};

// ── Models ──────────────────────────────────────────────────────────────────
// Reasoning controls (per OpenRouter unified API):
//   - reasoning: { effort: 'low' }    — gpt-oss-20b (no enabled-flag support)
//   - reasoning: { enabled: false }   — kills reasoning entirely. Works on
//     gpt-5.4-mini (faster than effort='minimal'), gemma-4, gemini-3-flash.
//     Verified via /tmp/probe-reasoning.ts run.
type Variant = {
  label: string; orId: string;
  reasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' } | { enabled: false };
  providerOnly?: string[];
};
const VARIANTS: Variant[] = [
  { label: 'gpt-oss-20b (low)',      orId: 'openai/gpt-oss-20b',            reasoning: { effort: 'low' } },
  { label: 'gemma-4-26b-a4b',        orId: 'google/gemma-4-26b-a4b-it',     reasoning: { enabled: false } },
  { label: 'gemini-3-flash-preview', orId: 'google/gemini-3-flash-preview', reasoning: { enabled: false } },
  { label: 'gpt-5.4-mini (none)',    orId: 'openai/gpt-5.4-mini',           reasoning: { enabled: false } },
];

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

async function callOR(v: Variant, system: string, userMsg: string): Promise<{
  text: string; ttltMs: number; promptTokens: number; completionTokens: number;
  providerName?: string; error?: string;
}> {
  const start = Date.now();
  let text = ''; let promptTokens = 0; let completionTokens = 0; let providerName: string | undefined;
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
    if (v.providerOnly) {
      body.provider.only = v.providerOnly;
      body.provider.allow_fallbacks = false;
    }
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(70_000),
    });
    if (!r.ok) {
      return { text: '', ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
    }
    if (!r.body) return { text: '', ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: 'no body' };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
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
            if (typeof d === 'string') text += d;
            if (j?.usage) { promptTokens = j.usage.prompt_tokens ?? 0; completionTokens = j.usage.completion_tokens ?? 0; }
            if (j?.provider) providerName = j.provider;
          } catch {}
        }
      }
    }
    if (promptTokens === 0 && (system.length + userMsg.length) > 0) promptTokens = Math.ceil((system.length + userMsg.length) / 4);
    if (completionTokens === 0 && text.length > 0) completionTokens = Math.ceil(text.length / 4);
    return { text, ttltMs: Date.now() - start, promptTokens, completionTokens, providerName };
  } catch (err) {
    return { text, ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

function tryParseFirstJson(text: string): any | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── Auto-scoring ────────────────────────────────────────────────────────────
function scoreCell(gold: Gold, result: any | null, error?: string): { score: number; note: string } {
  if (!result) return { score: 0, note: error ? `parse_fail (${error.slice(0, 40)})` : 'parse_fail' };
  const fired = !!result.shouldFire;
  if (gold.fire === false) {
    if (!fired) return { score: 5, note: 'correctly silent' };
    return { score: 1, note: `over-fired: [${result.play ?? '?'}] "${result.markdown ?? ''}"`.slice(0, 130) };
  }
  // gold.fire === true
  if (!fired) return { score: 1, note: 'wrongly silent — should have fired' };
  const playMatch = (result.play ?? '').toLowerCase() === gold.play.toLowerCase();
  const md = (result.markdown ?? '').toLowerCase();
  // crude "directionally close" heuristic: shares ≥1 distinctive token from gold markdown
  const goldTokens = new Set(gold.markdown.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(t => t.length > 4 && !['confirm','before','their','about','asking','should'].includes(t)));
  const mdTokens = new Set(md.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/));
  const overlap = [...goldTokens].filter(t => mdTokens.has(t)).length;
  if (playMatch && overlap >= 2) return { score: 5, note: 'fired correct play + sharp anchor' };
  if (playMatch && overlap >= 1) return { score: 4, note: 'fired correct play, anchor partial' };
  if (playMatch) return { score: 3, note: 'fired correct play, generic markdown' };
  if (overlap >= 2) return { score: 3, note: 'wrong play but markdown sharp' };
  return { score: 2, note: 'fired but off-target' };
}

// ── Main ────────────────────────────────────────────────────────────────────
type CellResult = {
  variantLabel: string; orId: string; turnId: string; speaker: 'rep' | 'customer';
  ttltMs: number; promptTokens: number; completionTokens: number;
  providerName?: string; error?: string; result: any | null;
  score: number; scoreNote: string;
};

async function main() {
  const t0 = Date.now();
  const total = VARIANTS.length * TRANSCRIPT.length;
  console.log(`Bench: ${VARIANTS.length} variants × ${TRANSCRIPT.length} turns = ${total} parallel calls\n`);

  const tasks: Promise<CellResult>[] = [];
  for (const v of VARIANTS) {
    for (let i = 0; i < TRANSCRIPT.length; i++) {
      const utt = TRANSCRIPT[i];
      const hotTail = TRANSCRIPT.slice(Math.max(0, i - 6), i);
      const sys = utt.speaker === 'customer' ? PROSPECT_SYS : REP_SYS;
      tasks.push((async () => {
        const r = await callOR(v, sys, buildUserMsg(utt, hotTail, utt.speaker));
        const parsed = tryParseFirstJson(r.text);
        const { score, note } = scoreCell(GOLD[utt.id], parsed, r.error);
        return {
          variantLabel: v.label, orId: v.orId, turnId: utt.id, speaker: utt.speaker,
          ttltMs: r.ttltMs, promptTokens: r.promptTokens, completionTokens: r.completionTokens,
          providerName: r.providerName, error: r.error, result: parsed,
          score, scoreNote: note,
        };
      })());
    }
  }
  const results = await Promise.all(tasks);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s wall\n`);

  // pricing
  const pricingRes = await fetch('https://openrouter.ai/api/v1/models');
  const pricingJson = await pricingRes.json();
  const pricing = new Map<string, { prompt: number; completion: number }>();
  for (const m of pricingJson.data) pricing.set(m.id, { prompt: parseFloat(m.pricing?.prompt ?? '0'), completion: parseFloat(m.pricing?.completion ?? '0') });

  // ── Per-turn comparison (verbose, with my gold first) ─────────────────────
  console.log('═'.repeat(180));
  console.log('PER-TURN COMPARISON (★ = my gold standard)');
  console.log('═'.repeat(180));
  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const utt = TRANSCRIPT[i];
    const gold = GOLD[utt.id];
    const tag = utt.speaker === 'rep' ? 'REP' : 'PROSPECT';
    console.log(`\n• ${utt.id}  ${tag}: ${utt.text.slice(0, 175)}${utt.text.length > 175 ? '…' : ''}`);
    if (gold.fire) {
      console.log(`  ★ GOLD                     fire=true  [${gold.play}] "${gold.markdown}"`);
    } else {
      console.log(`  ★ GOLD                     fire=false  (${gold.rationale.slice(0, 80)})`);
    }
    for (const v of VARIANTS) {
      const r = results.find(x => x.variantLabel === v.label && x.turnId === utt.id)!;
      const sBits = r.result
        ? (r.result.shouldFire
            ? `🔥 [${(r.result.play ?? '?').padEnd(22)}] "${(r.result.markdown ?? '').slice(0, 110)}"`
            : `🤐 silent`)
        : `ERR: ${r.error?.slice(0, 60) ?? 'parse_fail'}`;
      console.log(`  ${v.label.padEnd(26)} ${(r.ttltMs/1000).toFixed(1)}s  score=${r.score}  ${sBits}`);
    }
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(180));
  console.log('AGGREGATE (sorted by avg quality score desc)');
  console.log('═'.repeat(180));

  const fireTurns = TRANSCRIPT.filter(u => GOLD[u.id].fire).map(u => u.id);
  const silentTurns = TRANSCRIPT.filter(u => !GOLD[u.id].fire).map(u => u.id);

  const rows = VARIANTS.map(v => {
    const cells = results.filter(r => r.variantLabel === v.label);
    const ok = cells.filter(r => r.result).length;
    const avgScore = cells.reduce((s, r) => s + r.score, 0) / cells.length;
    const fireCells = cells.filter(c => fireTurns.includes(c.turnId));
    const silentCells = cells.filter(c => silentTurns.includes(c.turnId));
    const fireScore = fireCells.reduce((s, r) => s + r.score, 0) / fireCells.length;
    const silentScore = silentCells.reduce((s, r) => s + r.score, 0) / silentCells.length;
    const ttlt = cells.map(r => r.ttltMs).sort((a,b) => a-b);
    const avgTtlt = ttlt.reduce((a,b)=>a+b,0)/ttlt.length;
    const p95Ttlt = ttlt[Math.min(ttlt.length-1, Math.floor(ttlt.length*0.95))];
    const pIn = cells.reduce((s,r) => s+r.promptTokens, 0);
    const pOut = cells.reduce((s,r) => s+r.completionTokens, 0);
    const price = pricing.get(v.orId);
    const totalCost = price ? pIn*price.prompt + pOut*price.completion : 0;
    const avgCostPerCall = totalCost / cells.length;
    const costPer1k = avgCostPerCall * 1000;
    const providers = [...new Set(cells.map(c => c.providerName).filter(Boolean))];
    return { v, cells, ok, avgScore, fireScore, silentScore, avgTtlt, p95Ttlt, pIn, pOut, totalCost, avgCostPerCall, costPer1k, providers };
  }).sort((a,b) => b.avgScore - a.avgScore);

  const cols = ['variant', 'avg', 'fire', 'silent', 'ok', 'TTLT avg', 'TTLT p95', 'tok in', 'tok out', 'test cost', '$/1k calls', 'providers'];
  const widths = [27, 7, 7, 8, 7, 10, 10, 9, 9, 12, 12, 30];
  console.log('\n' + cols.map((c,i) => c.padEnd(widths[i])).join(''));
  console.log(widths.map(w => '─'.repeat(w)).join(''));
  for (const r of rows) {
    const row = [
      r.v.label,
      r.avgScore.toFixed(2),
      r.fireScore.toFixed(2),
      r.silentScore.toFixed(2),
      `${r.ok}/${r.cells.length}`,
      `${(r.avgTtlt/1000).toFixed(2)}s`,
      `${(r.p95Ttlt/1000).toFixed(2)}s`,
      r.pIn.toLocaleString(),
      r.pOut.toLocaleString(),
      `$${r.totalCost.toFixed(4)}`,
      `$${r.costPer1k.toFixed(3)}`,
      r.providers.join(',').slice(0, 30),
    ];
    console.log(row.map((c,i) => c.padEnd(widths[i])).join(''));
  }

  const grandTotalCost = rows.reduce((s,r) => s + r.totalCost, 0);
  console.log(`\nGrand total cost of this entire bench (${total} calls):  $${grandTotalCost.toFixed(4)}`);
  console.log(`avg = mean score across all 40 turns. fire = mean over ${fireTurns.length} fire-expected turns. silent = mean over ${silentTurns.length} stay-silent turns.`);
}

await main();
