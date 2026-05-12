'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import type {
  CoachWSClientEvent,
  CoachWSServerEvent,
  PersonaId,
  TranscriptEvent,
  PersonaToolCallEvent,
} from '@atlas/types';

const WS_URL = (process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://localhost:3001').replace(/^http/, 'ws') + '/coach/ws';

export type CoachSuggestion = {
  id: string;
  content: string;
  reason?: string;
  ts: number;
};

export type CoachConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type UseCoachWSReturn = {
  state: CoachConnectionState;
  suggestions: CoachSuggestion[];
  memoryPatches: unknown[];
  errors: string[];
  sendTranscript: (event: TranscriptEvent) => void;
  sendPersonaToolCall: (event: PersonaToolCallEvent) => void;
  endCall: () => void;
  reset: () => void;
};

export function useCoachWS(opts: { callId: string | null; personaId: PersonaId | null }): UseCoachWSReturn {
  const { callId, personaId } = opts;
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<CoachConnectionState>('idle');
  const [suggestions, setSuggestions] = useState<CoachSuggestion[]>([]);
  const [memoryPatches, setMemoryPatches] = useState<unknown[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!callId || !personaId) return;
    setState('connecting');
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setState('open');
      const hello: CoachWSClientEvent = { type: 'hello', callId, personaId };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (msg) => {
      let event: CoachWSServerEvent;
      try {
        event = JSON.parse(msg.data) as CoachWSServerEvent;
      } catch (e) {
        console.error('[CoachWS] Failed to parse server message', { data: msg.data, error: e });
        setErrors(prev => [...prev, 'Coach sent an unreadable message — connection may be degraded.']);
        return;
      }
      switch (event.type) {
        case 'suggestion':
          // Single-shot suggestion (used for tool-call inline cards + intro line).
          setSuggestions(prev => [...prev, { id: event.id, content: event.content, reason: event.reason, ts: Date.now() }]);
          break;
        case 'suggestion.delta':
          setSuggestions(prev => {
            const existing = prev.findIndex(s => s.id === event.id);
            if (existing === -1) {
              return [...prev, { id: event.id, content: event.token, reason: undefined, ts: Date.now() }];
            }
            const next = prev.slice();
            next[existing] = { ...next[existing], content: next[existing].content + event.token };
            return next;
          });
          break;
        case 'suggestion.complete':
          setSuggestions(prev => {
            const existing = prev.findIndex(s => s.id === event.id);
            if (existing === -1) {
              return [...prev, { id: event.id, content: event.content, reason: event.reason, ts: Date.now() }];
            }
            const next = prev.slice();
            next[existing] = { id: event.id, content: event.content, reason: event.reason, ts: next[existing].ts };
            return next;
          });
          break;
        case 'suggestion.abort':
          setSuggestions(prev => prev.filter(s => s.id !== event.id));
          break;
        case 'memory.patch':
          setMemoryPatches(prev => [...prev, event.patch]);
          break;
        case 'error':
          setErrors(prev => [...prev, event.message]);
          break;
        case 'tool':
          // Tool events from server-driven coach — currently emitted by chat agent.
          break;
      }
    };
    ws.onerror = (evt) => {
      console.error('[CoachWS] WebSocket error', evt);
      setErrors(prev => [...prev, 'Connection to Atlas coach failed.']);
      setState('error');
    };
    ws.onclose = () => setState('closed');

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [callId, personaId]);

  const sendTranscript = useCallback((event: TranscriptEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    } else {
      console.warn('[CoachWS] sendTranscript dropped — socket not open', { readyState: ws?.readyState });
    }
  }, []);

  const sendPersonaToolCall = useCallback((event: PersonaToolCallEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    } else {
      console.warn('[CoachWS] sendPersonaToolCall dropped — socket not open', { readyState: ws?.readyState });
    }
  }, []);

  const endCall = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'call.end', reason: 'user_hangup' } satisfies CoachWSClientEvent));
    }
  }, []);

  const reset = useCallback(() => {
    setSuggestions([]);
    setMemoryPatches([]);
    setErrors([]);
  }, []);

  return { state, suggestions, memoryPatches, errors, sendTranscript, sendPersonaToolCall, endCall, reset };
}
