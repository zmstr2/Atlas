'use client';

import type { SSEEvent } from '@atlas/types';
import { AGENT_URL } from './config';

export type SSEHandlers = {
  onUtterance?: (e: Extract<SSEEvent, { type: 'utterance' }>) => void;
  onMemoryDiff?: (e: Extract<SSEEvent, { type: 'memory_diff' }>) => void;
  onPulse?: (e: Extract<SSEEvent, { type: 'pulse' }>) => void;
  onVerdict?: (e: Extract<SSEEvent, { type: 'verdict' }>) => void;
  onCallEnd?: (e: Extract<SSEEvent, { type: 'call_end' }>) => void;
  onError?: (e: Extract<SSEEvent, { type: 'error' }>) => void;
  onSuggestion?: (e: Extract<SSEEvent, { type: 'suggestion' }>) => void;
  onMemoryPatchApplied?: (e: Extract<SSEEvent, { type: 'memory_patch_applied' }>) => void;
  onFactsUiDelta?: (e: Extract<SSEEvent, { type: 'facts_ui_delta' }>) => void;
};

export function connectSSE(callId: string, handlers: SSEHandlers): () => void {
  const agentUrl = AGENT_URL;
  let es: EventSource | null = null;
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (cancelled) return;
    es = new EventSource(`${agentUrl}/demo/stream/${callId}`);

    es.onmessage = (evt) => {
      let event: SSEEvent;
      try {
        event = JSON.parse(evt.data) as SSEEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'utterance': handlers.onUtterance?.(event); break;
        case 'memory_diff': handlers.onMemoryDiff?.(event); break;
        case 'pulse': handlers.onPulse?.(event); break;
        case 'verdict': handlers.onVerdict?.(event); break;
        case 'call_end':
          handlers.onCallEnd?.(event);
          cancelled = true;
          es?.close();
          break;
        case 'error': handlers.onError?.(event); break;
        case 'suggestion': handlers.onSuggestion?.(event); break;
        case 'memory_patch_applied': handlers.onMemoryPatchApplied?.(event); break;
        case 'facts_ui_delta': handlers.onFactsUiDelta?.(event); break;
      }
    };

    es.onerror = () => {
      es?.close();
      es = null;
      if (!cancelled) {
        retryTimer = setTimeout(connect, 1500);
      }
    };
  }

  connect();

  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
    es?.close();
  };
}
