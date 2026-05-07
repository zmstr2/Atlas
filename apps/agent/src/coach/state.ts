import path from 'node:path';
import type { PersonaConfig, PersonaId, Utterance, PreCallBrief } from '@atlas/types';
import { lookupLead, lookupCompany } from '@atlas/types';
import { MemoryStore } from '../memory/store';
import { HotTail } from '../memory/hotTail';
import { renderMemoryMarkdown } from '../memory/render';
import { getPersona } from '../realtime/personas';
import { clearPipelineChain } from './pipelineChain';
import { createCall, recordUtterance, recordSuggestion, finalizeCall, loadCall, loadCallLog, DEMO_USER_ID } from '../db/sqlite';
import jordanBrief from '../../../../fixtures/jordan-brief.json' with { type: 'json' };

const BRIEFS: Record<PersonaId, PreCallBrief> = {
  jordan: jordanBrief as PreCallBrief,
};

export type SuggestionRecord = {
  id: string;
  ts: number;
  content: string;
  reason?: string;
  groundedInUtteranceIds: string[];
};

export type CoachState = {
  callId: string;
  // Coach realtime flow is intentionally unauthenticated (mounted on the
  // public /realtime route), so userId is DEMO_USER_ID here for spend
  // attribution. Real desktop calls go through /calls/* with a JWT-derived
  // userId — this state struct is never used on that path.
  userId: string;
  personaId: PersonaId;
  persona: PersonaConfig;
  brief: PreCallBrief;
  memoryStore: MemoryStore;
  hotTail: HotTail;
  utterances: Utterance[];
  suggestions: SuggestionRecord[];
  turnCounter: number;
  createdAt: number;
  lastActivity: number;
  ended: boolean;
  transcriptDumped: boolean;
};

const states = new Map<string, CoachState>();
const TTL_MS = 5 * 60 * 1000;

export function createCoachState(opts: { callId: string; personaId: PersonaId; userId?: string }): CoachState {
  const persona = getPersona(opts.personaId);
  const brief = BRIEFS[opts.personaId];
  const userId = opts.userId ?? DEMO_USER_ID;
  const state: CoachState = {
    callId: opts.callId,
    userId,
    personaId: opts.personaId,
    persona,
    brief,
    memoryStore: new MemoryStore(),
    hotTail: new HotTail(5),
    utterances: [],
    suggestions: [],
    turnCounter: 0,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    ended: false,
    transcriptDumped: false,
  };
  states.set(opts.callId, state);
  createCall(opts.callId, userId, { script: opts.personaId, brief: state.brief });
  return state;
}

export function getCoachState(callId: string): CoachState | null {
  const state = states.get(callId);
  if (!state) return null;
  state.lastActivity = Date.now();
  return state;
}

export function endCall(callId: string): void {
  const state = states.get(callId);
  if (!state) return;
  state.ended = true;
  state.transcriptDumped = true;
  finalizeCall(callId, state.userId);
  dumpTranscriptToFile(callId);
}

export function appendUtterance(callId: string, utterance: Utterance): void {
  const state = states.get(callId);
  if (!state) return;
  state.utterances.push(utterance);
  state.hotTail.push(utterance);
  state.memoryStore.recordUtteranceStats(utterance.speaker, utterance.text);
  state.turnCounter += 1;
  state.lastActivity = Date.now();
  recordUtterance(callId, state.userId, utterance);
}

export function nextTurnId(state: CoachState): string {
  return `t${String(state.turnCounter).padStart(3, '0')}`;
}

export function appendSuggestion(callId: string, suggestion: SuggestionRecord): void {
  const state = states.get(callId);
  if (!state) return;
  state.suggestions.push(suggestion);
  state.lastActivity = Date.now();
  // Record as a fired suggestion (voice calls don't suppress)
  recordSuggestion(
    callId,
    state.userId,
    suggestion.groundedInUtteranceIds[0] ?? state.utterances[state.utterances.length - 1]?.id ?? '',
    state.turnCounter,
    {
      agent: 'prospect_suggester',
      shouldFire: true,
      priority: 'nudge',
      play: 'none',
      axis: null,
      markdown: suggestion.content,
      reasoning: suggestion.reason ?? '',
      groundedInUtteranceIds: suggestion.groundedInUtteranceIds,
      groundedInAnchorTurnIds: [],
    },
    false,
  );
}

function fmtOffset(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `T+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtIso(ts: number): string {
  return new Date(ts).toISOString();
}

export function dumpTranscriptToFile(callId: string): string | null {
  try {
    const state = states.get(callId);
    const userId = state?.userId ?? DEMO_USER_ID;
    const call = loadCall(callId, userId);
    if (!call) {
      console.error('[coach] dumpTranscriptToFile: call not found', callId);
      return null;
    }
    const { utterances, suggestions } = loadCallLog(callId, userId);

    const dbPath = process.env.SQLITE_PATH ?? 'atlas.db';
    const dir = path.join(path.dirname(path.resolve(dbPath)), 'transcripts');
    Bun.spawnSync(['mkdir', '-p', dir]);

    const date = new Date(call.started_at).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${date}_${callId}.md`;
    const filePath = path.join(dir, filename);

    const startedAt = call.started_at;
    const endedAt = call.ended_at ?? Date.now();
    const durationMs = endedAt - startedAt;

    // Index suggestions by their grounding utterance id
    const suggestionsByUtt = new Map<string, typeof suggestions>();
    for (const s of suggestions) {
      const ids = JSON.parse(s.grounded_utterance_ids || '[]') as string[];
      const targets = ids.length > 0 ? ids : [s.utterance_id];
      for (const uid of targets) {
        const arr = suggestionsByUtt.get(uid) ?? [];
        arr.push(s);
        suggestionsByUtt.set(uid, arr);
      }
    }

    // Index utterances by id for suggestion-latency lookup
    const utteranceById = new Map(utterances.map(u => [u.id, u]));

    const fired = suggestions.filter(s => s.suppressed === 0).length;
    const suppressed = suggestions.filter(s => s.suppressed === 1).length;

    const lines: string[] = [];
    lines.push(`# Call \`${callId}\``);
    lines.push('');
    lines.push(`Script/persona: **${call.script}**`);
    lines.push(`Started: ${fmtIso(startedAt)}`);
    lines.push(`Ended:   ${call.ended_at ? fmtIso(call.ended_at) : '(unfinished)'}`);
    lines.push(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
    lines.push(`Utterances: **${utterances.length}** · Suggestions fired: **${fired}** · Suppressed: **${suppressed}**`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const u of utterances) {
      const offset = fmtOffset(u.created_at - startedAt);
      const speaker = u.speaker.toUpperCase();
      lines.push(`**[${u.id}] ${offset} · ${speaker}:** ${u.text}`);
      for (const s of suggestionsByUtt.get(u.id) ?? []) {
        const sOffset = fmtOffset(s.created_at - startedAt);
        const tag = s.suppressed === 1 ? '~~SUPPRESSED~~' : '**FIRED**';
        // Latency from utterance arrival → suggestion ready
        const anchorUtt = utteranceById.get(u.id);
        const latencyMs = anchorUtt ? s.created_at - anchorUtt.created_at : null;
        const latencyStr = latencyMs != null ? ` · +${latencyMs}ms` : '';
        const md = s.markdown.replace(/\n/g, ' ').trim();
        lines.push(`  - ${tag} ${sOffset}${latencyStr} \`${s.agent}\` [${s.priority}/${s.play}] — ${md}`);
        if (s.reasoning) {
          lines.push(`    _reasoning:_ ${s.reasoning.replace(/\n/g, ' ').trim()}`);
        }
      }
      lines.push('');
    }

    Bun.write(filePath, lines.join('\n'));
    console.log(`[coach] transcript saved → ${filePath}`);
    return filePath;
  } catch (err) {
    console.error('[coach] failed to save transcript file', err);
    return null;
  }
}

// Build a context object the chat agent uses to ground its replies.
// Reuses the shared markdown renderer so the chat coach sees the same shape
// as the prospect-suggester and rep-watcher.
export function buildChatContext(state: CoachState): string {
  const lead = lookupLead(state.persona.leadId);
  const company = lead ? lookupCompany(lead.companyId) : null;

  const memoryMarkdown = renderMemoryMarkdown({
    memory: state.memoryStore.snapshot,
    hotTail: state.hotTail.snapshot(),
    leadName: lead?.name ?? state.persona.displayName,
    callGoal: state.brief.callGoal,
  });

  const recentSuggestions = state.suggestions.slice(-5).map(s => `- ${s.content}`).join('\n');

  return `LEAD: ${lead?.name ?? state.persona.displayName} (${lead?.title ?? '?'} @ ${company?.name ?? '?'})
COMPANY: ${company?.name ?? '?'} — ${company?.industry ?? ''}, ${company?.employees ?? ''}

${memoryMarkdown}

## Your recent suggestions to rep
${recentSuggestions || '(none)'}`;
}

// Periodic eviction.
// We hold state in-memory for a short window after the call ends to allow
// chat reconnects. Before evicting, make sure the .md transcript was written
// — including for calls that idled out without an explicit call.end.
const IDLE_FORCE_END_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  const cutoff = now - TTL_MS;
  for (const [callId, state] of states) {
    // Force-finalize calls that have been idle too long without a call.end
    if (!state.ended && now - state.lastActivity > IDLE_FORCE_END_MS) {
      console.log(`[coach] force-ending idle call ${callId}`);
      state.ended = true;
      finalizeCall(callId, state.userId);
    }
    if (state.ended && state.lastActivity < cutoff) {
      if (!state.transcriptDumped) {
        dumpTranscriptToFile(callId);
        state.transcriptDumped = true;
      }
      states.delete(callId);
      clearPipelineChain(callId);
    }
  }
}, 60 * 1000);

export function _resetForTests(): void {
  states.clear();
}

export function _allStates(): CoachState[] {
  return Array.from(states.values());
}
