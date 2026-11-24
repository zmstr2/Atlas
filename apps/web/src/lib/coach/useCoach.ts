'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallFactsUI, MeetingMemory, PersonaId, PersonaToolCallEvent, TranscriptEvent, Utterance } from '@atlas/types';
import { MemoryStore } from '@/lib/memory/store';
import { HotTail } from '@/lib/memory/hotTail';
import { buildCallFactsUI } from '@/lib/memory/factsUI';
import { INTRO_BY_PERSONA } from './intros';
import type { CallSnapshot, ChatContext, TurnEvent, TurnRequest } from './protocol';
import {
  addSuggestion as addToList,
  COVERED_FLASH_MS,
  deriveView,
  markCovered,
  openForModel,
  promote as promoteInList,
  restore as restoreInList,
  settle,
  UNDO_MS,
  type CoachSuggestion,
  type SuggestionView,
} from './suggestions';

export type { CoachSuggestion, SuggestionView } from './suggestions';

/** The briefing and call events shown in the chat (not live coaching). */
export type CoachNote = {
  id: string;
  content: string;
  reason?: string;
  ts: number;
};

export type UseCoachReturn = {
  /** Live coaching for the side panel: current suggestion, "still open" tray, history. */
  view: SuggestionView;
  /** Clock used for ages; ticks so "40s" becomes "1m". */
  now: number;
  markAsked: (id: string) => void;
  dropSuggestion: (id: string) => void;
  promoteSuggestion: (id: string) => void;
  /** Undo a Drop/Asked, or bring an item back from history. */
  restoreSuggestion: (id: string) => void;
  /** Briefing and call events. Shown in the chat. */
  notes: CoachNote[];
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
  const viewRef = useRef<SuggestionView | null>(null);

  const [all, setAll] = useState<CoachSuggestion[]>([]);
  const [notes, setNotes] = useState<CoachNote[]>([]);
  const [turn, setTurn] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [memory, setMemory] = useState<MeetingMemory | null>(null);
  const [factsUI, setFactsUI] = useState<CallFactsUI | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // Ages ("40s" -> "1m") and the 5-minute backstop need a clock.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  /** Re-render shortly after something settles so "Covered" can fade away. */
  const bumpClockSoon = useCallback(() => {
    setNow(Date.now());
    setTimeout(() => setNow(Date.now()), COVERED_FLASH_MS + 60);
    setTimeout(() => setNow(Date.now()), UNDO_MS + 60);
  }, []);

  const view = useMemo(
    () =>
      deriveView(all, {
        now,
        turn,
        axisConfirmed: (topic) => {
          const card = (factsUI?.bant as Record<string, { state?: string; headline?: string | null }> | undefined)?.[topic];
          return !!card && card.state === 'firm' && !!card.headline;
        },
      }),
    [all, now, turn, factsUI],
  );
  viewRef.current = view;

  const addNote = useCallback((n: CoachNote) => {
    setNotes((prev) => (prev.some((p) => p.id === n.id) ? prev : [...prev, n]));
  }, []);

  const publishMemory = useCallback(() => {
    const snap = storeRef.current.snapshot;
    setMemory(snap);
    setFactsUI(buildCallFactsUI(snap));
  }, []);

  // Fresh state per call, plus the coach's opening briefing in the chat.
  useEffect(() => {
    if (!callId || !personaId) return;
    storeRef.current = new MemoryStore();
    tailRef.current = new HotTail(5);
    turnRef.current = 0;
    startedRef.current = Date.now();
    recentRef.current = [];
    setAll([]);
    setNotes([]);
    setTurn(0);
    setMemory(null);
    setFactsUI(null);
    setErrors([]);
    const intro = INTRO_BY_PERSONA[personaId];
    if (intro) addNote({ id: `intro-${callId}`, content: intro, reason: 'call_intro', ts: Date.now() });
    return () => abortRef.current?.abort();
  }, [callId, personaId, addNote]);

  const applyEvent = useCallback((e: TurnEvent) => {
    switch (e.type) {
      case 'suggestion': {
        const at = Date.now();
        recentRef.current = [...recentRef.current, e.content].slice(-5);
        setAll((prev) =>
          addToList(
            prev,
            { id: e.id, content: e.content, why: e.why, kind: e.kind, topic: e.topic, reason: e.reason, ts: at, turn: turnRef.current },
            at,
          ),
        );
        setNow(at);
        break;
      }
      case 'covered':
        setAll((prev) => markCovered(prev, e.ids, Date.now()));
        bumpClockSoon();
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
  }, [bumpClockSoon, publishMemory]);

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
    setTurn(turnRef.current);

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
      openSuggestions: viewRef.current ? openForModel(viewRef.current) : [],
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

  const markAsked = useCallback((id: string) => {
    setAll((prev) => settle(prev, id, 'asked', Date.now()));
    bumpClockSoon();
  }, [bumpClockSoon]);
  const dropSuggestion = useCallback((id: string) => {
    setAll((prev) => settle(prev, id, 'dropped', Date.now()));
    bumpClockSoon();
  }, [bumpClockSoon]);
  const promoteSuggestion = useCallback((id: string) => {
    setAll((prev) => promoteInList(prev, id, Date.now()));
  }, []);

  const restoreSuggestion = useCallback((id: string) => {
    setAll((prev) => restoreInList(prev, id, Date.now()));
    setNow(Date.now());
  }, []);

  const getChatContext = useCallback((): ChatContext => ({
    personaId: (personaId ?? 'mia') as PersonaId,
    memory: storeRef.current.snapshot,
    hotTail: tailRef.current.snapshot(),
    suggestions: recentRef.current,
  }), [personaId]);

  return {
    view, now, markAsked, dropSuggestion, promoteSuggestion, restoreSuggestion,
    notes, memory, factsUI, errors,
    sendTranscript, sendPersonaToolCall, endCall, getChatContext,
  };
}
