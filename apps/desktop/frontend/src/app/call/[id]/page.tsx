'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  endCall,
  getCall,
  streamCall,
  type CallDetail,
  type SSEEventLike,
} from '@/lib/agent';
import type { Utterance, MeetingMemory, CallFactsUI } from '@atlas/types';
import { TranscriptView } from '@/components/TranscriptView';
import { MemoryPanel } from '@/components/MemoryPanel';
import { SuggestionBar } from '@/components/SuggestionBar';
import { PreCallBriefHeader } from '@/components/PreCallBrief';

export default function LiveCallPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const callId = params.id;

  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [memory, setMemory] = useState<MeetingMemory | null>(null);
  const [factsUI, setFactsUI] = useState<CallFactsUI | null>(null);
  type SuggestionState =
    | { mode: 'idle' }
    | { mode: 'pulse'; utteranceId: string }
    | { mode: 'complete'; text: string; utteranceId: string };
  const [suggestion, setSuggestion] = useState<SuggestionState>({ mode: 'idle' });
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getCall(callId)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setUtterances(
          d.utterances.map((u) => ({
            id: u.id,
            speaker: u.speaker,
            participantId: u.participant_id ?? undefined,
            text: u.text,
            startMs: u.start_ms,
            endMs: u.end_ms,
            confidence: 1,
            derivedFromLowConfidence: false,
          })),
        );
        if (d.call.status !== 'active') {
          setEnded(true);
        }
      })
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [callId]);

  useEffect(() => {
    if (ended) return;
    const es = streamCall(callId, (ev: SSEEventLike) => {
      switch (ev.type) {
        case 'utterance': {
          const u = ev.utterance;
          setUtterances((prev) =>
            prev.some((x) => x.id === u.id)
              ? prev
              : [
                  ...prev,
                  {
                    id: u.id,
                    speaker: u.speaker,
                    text: u.text,
                    startMs: u.startMs,
                    endMs: u.endMs,
                    confidence: 1,
                    derivedFromLowConfidence: false,
                  },
                ],
          );
          break;
        }
        case 'memory_diff':
          setMemory(ev.snapshot);
          break;
        case 'facts_ui_delta':
          setFactsUI(ev.ui);
          break;
        case 'suggestion':
          if (ev.suggestion.shouldFire) {
            setSuggestion({
              mode: 'complete',
              text: ev.suggestion.markdown,
              utteranceId: ev.utteranceId,
            });
          }
          break;
        case 'pulse':
          setSuggestion((prev) =>
            prev.mode === 'idle'
              ? { mode: 'pulse', utteranceId: ev.utteranceId }
              : prev,
          );
          break;
        case 'call_end':
          setEnded(true);
          break;
        case 'error':
          setError(ev.message);
          break;
      }
    });
    return () => es.close();
  }, [callId, ended]);

  async function handleEndCall() {
    try {
      await endCall(callId);
      setEnded(true);
      router.push(`/call/${callId}/coaching`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!detail) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-bg-base">
        {error ? (
          <div className="text-signal-negative text-sm">{error}</div>
        ) : (
          <div className="text-fg-muted text-sm">Loading call…</div>
        )}
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col bg-bg-base text-fg-primary">
      {detail.call.brief_json && (
        <PreCallBriefHeader
          brief={detail.call.brief_json}
          callActive={!ended}
          rightSlot={
            !ended && (
              <button
                onClick={handleEndCall}
                className="px-3 py-1.5 bg-signal-negative text-white text-xs font-medium rounded-md hover:bg-signal-negative/90 transition-colors"
              >
                End call
              </button>
            )
          }
        />
      )}

      <div className="flex flex-1 overflow-hidden">
        <TranscriptView
          utterances={utterances}
          customerName={detail.call.prospect_name ?? 'Prospect'}
        />
        <MemoryPanel memory={memory} factsUI={factsUI} />
      </div>

      <SuggestionBar state={suggestion} />
    </main>
  );
}
