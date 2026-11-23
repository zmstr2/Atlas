'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallFactsUI, MeetingMemory, PersonaId, PersonaToolCallEvent, TranscriptEvent, Utterance } from '@atlas/types';
import { MemoryStore } from '@/lib/memory/store';
import { HotTail } from '@/lib/memory/hotTail';
import { buildCallFactsUI } from '@/lib/memory/factsUI';
import { INTRO_BY_PERSONA } from './intros';
import type { CallSnapshot, ChatContext, TurnEvent, TurnRequest } from './protocol';

export type CoachSuggestion = {
  id: string;
  content: string;
  reason?: string;
  ts: number;
};

export type UseCoachReturn = {
  /** Live coaching, one per turn. Shown in the side panel's "Next move" card. */
  suggestions: CoachSuggestion[];
  /** Briefing and call events (e.g. the persona booking a next step). Shown in the chat. */
  notes: CoachSuggestion[];
  memory: MeetingMemory | null;
  factsUI: CallFactsUI | null;
  errors: string[];
  sendTranscript: (event: TranscriptEvent) => void;
  sendPersonaToolCall: (event: PersonaToolCallEvent) => void;
  endCall: () => void;
  getChatContext: () => ChatContext;
};

/**
 * Client-side coach. The server is stateless: this hook owns the call's memory
 * (same MemoryStore the server uses), sends a snapshot with each finalized
 * utterance, and applies the patches that stream back.
 */
export function useCoach(opts: { callId: string | null; personaId: PersonaId | null }): UseCoachReturn {
  const { callId, personaId } = opts;
  const storeRef = useRef(new MemoryStore());
  const tailRef = useRef(new HotTail(5));
  const turnRef = useRef(0);
  const startedRef = useRef(Date.now());
  const recentRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const [suggestions, setSuggestions] = useState<CoachSuggestion[]>([]);
  const [notes, setNotes] = useState<CoachSuggestion[]>([]);
  const [memory, setMemory] = useState<MeetingMemory | null>(null);
  const [factsUI, setFactsUI] = useState<CallFactsUI | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const addSuggestion = useCallback((s: CoachSuggestion) => {
    recentRef.current = [...recentRef.current, s.content].slice(-5);
    setSuggestions((prev) => (prev.some((p) => p.id === s.id) ? prev : [...prev, s]));
  }, []);

  const addNote = useCallback((s: CoachSuggestion) => {
    setNotes((prev) => (prev.some((p) => p.id === s.id) ? prev : [...prev, s]));
  }, []);

  const publishMemory = useCallback(() => {
    const snap = storeRef.current.snapshot;
    setMemory(snap);
    setFactsUI(buildCallFactsUI(snap));
  }, []);

  // Fresh state per call, plus the coach's opening message.
  useEffect(() => {
    if (!callId || !personaId) return;
    storeRef.current = new MemoryStore();
    tailRef.current = new HotTail(5);
    turnRef.current = 0;
    startedRef.current = Date.now();
    recentRef.current = [];
    setSuggestions([]);
    setNotes([]);
    setMemory(null);
    setFactsUI(null);
    setErrors([]);
    const intro = INTRO_BY_PERSONA[personaId];
    if (intro) addNote({ id: `intro-${callId}`, content: intro, reason: 'call_intro', ts: Date.now() });
    return () => abortRef.current?.abort();
  }, [callId, personaId, addNote]);

  const applyEvent = useCallback((e: TurnEvent) => {
    switch (e.type) {
      case 'suggestion':
        addSuggestion({ id: e.id, content: e.content, reason: e.reason, ts: Date.now() });
        break;
      case 'memory.patch':
        storeRef.current.applyMemoryPatch(e.patch);
        publishMemory();
        break;
      case 'panel.patch':
        if (storeRef.current.applyPanelPatch(e.patch, e.turnId)) publishMemory();
        break;
      case 'error':
        setErrors((prev) => [...prev, e.message]);
        break;
    }
  }, [addSuggestion, publishMemory]);

  const sendTranscript = useCallback((event: TranscriptEvent) => {
    // Only finalized, non-empty utterances drive the pipeline.
    if (!callId || !personaId || !event.isFinal || !event.text.trim()) return;

    const speaker = event.speaker === 'persona' ? 'customer' : 'rep';
    const elapsedMs = Date.now() - startedRef.current;
    const utterance: Utterance = {
      id: event.itemId,
      speaker,
      text: event.text,
      startMs: elapsedMs,
      endMs: elapsedMs,
      confidence: 1,
      derivedFromLowConfidence: false,
    };

    // Synchronous bookkeeping so the next turn's hot tail is current even while
    // this turn's memory is still being extracted.
    tailRef.current.push(utterance);
    storeRef.current.recordUtteranceStats(speaker, event.text);
    turnRef.current += 1;

    const snapshot: CallSnapshot = {
      memory: storeRef.current.snapshot,
      stats: storeRef.current.getStats(),
      hotTail: tailRef.current.snapshot(),
    };
    const body: TurnRequest = {
      callId,
      personaId,
      turnId: `t${String(turnRef.current).padStart(3, '0')}`,
      utterance: { id: utterance.id, speaker, text: event.text },
      elapsedMs,
      snapshot,
    };

    const ctrl = (abortRef.current ??= new AbortController());
    void (async () => {
      try {
        const res = await fetch('/api/coach/turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => null) as { error?: string } | null;
          setErrors((prev) => [...prev, detail?.error ?? `Coach request failed (${res.status})`]);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { applyEvent(JSON.parse(line) as TurnEvent); } catch { /* skip malformed line */ }
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        console.error('[coach] turn failed', err);
        setErrors((prev) => [...prev, 'Lost connection to the Atlas coach.']);
      }
    })();
  }, [callId, personaId, applyEvent]);

  const sendPersonaToolCall = useCallback((event: PersonaToolCallEvent) => {
    addNote({
      id: `tool-${event.callId}`,
      content: `Persona invoked \`${event.name}\` with ${JSON.stringify(event.args)}`,
      reason: 'persona_tool_call',
      ts: Date.now(),
    });
  }, [addNote]);

  const endCall = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const getChatContext = useCallback((): ChatContext => ({
    personaId: (personaId ?? 'mia') as PersonaId,
    memory: storeRef.current.snapshot,
    hotTail: tailRef.current.snapshot(),
    suggestions: recentRef.current,
  }), [personaId]);

  return { suggestions, notes, memory, factsUI, errors, sendTranscript, sendPersonaToolCall, endCall, getChatContext };
}
