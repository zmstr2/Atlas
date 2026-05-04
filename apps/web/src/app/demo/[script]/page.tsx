'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MeetingMemory, Utterance, PreCallBrief, CallFactsUI } from '@atlas/types';
import { MemoryPanel } from '@/components/MemoryPanel';
import { SuggestionBar, type SuggestionState } from '@/components/SuggestionBar';
import { TranscriptView } from '@/components/TranscriptView';
import { PreCallBriefHeader } from '@/components/PreCallBrief';
import { connectSSE } from '@/lib/sse';

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://localhost:3001';

const SCRIPT_LABELS: Record<string, string> = {
  jordan: 'Jordan Hayes',
  sarah: 'Sarah Park',
  tom: 'Tom Reyes',
};

export default function DemoPage({ params }: { params: { script: string } }) {
  const { script } = params;
  const [callId, setCallId] = useState<string | null>(null);
  const [brief, setBrief] = useState<PreCallBrief | null>(null);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [memory, setMemory] = useState<MeetingMemory | null>(null);
  const [factsUI, setFactsUI] = useState<CallFactsUI | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionState>({ mode: 'idle' });
  const [started, setStarted] = useState(false);
  const [callEnded, setCallEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const cleanupSSE = useRef<(() => void) | null>(null);

  // Load brief from agent for display before call starts
  useEffect(() => {
    fetch(`${AGENT_URL}/demo/brief/${script}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setBrief(data); })
      .catch(() => {});
  }, [script]);

  const startCall = useCallback(async () => {
    if (started) return;
    setStarted(true);

    try {
      const res = await fetch(`${AGENT_URL}/demo/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Failed to start call');
        setStarted(false);
        return;
      }

      const { callId: id } = data;
      setCallId(id);

      // Connect SSE
      cleanupSSE.current = connectSSE(id, {
        onUtterance: (e) => {
          setUtterances(prev => [...prev, e.utterance]);
        },
        onMemoryDiff: (e) => {
          setMemory(e.snapshot);
        },
        onFactsUiDelta: (e) => {
          setFactsUI(e.ui);
        },
        onPulse: () => {
          setSuggestion(s => s.mode === 'idle' || s.mode === 'complete'
            ? { mode: 'pulse', utteranceId: '' }
            : s
          );
        },
        onSuggestion: (e) => {
          setSuggestion({
            mode: 'complete',
            text: e.suggestion.markdown,
            utteranceId: e.utteranceId,
          });
        },
        onVerdict: () => {},
        onCallEnd: () => {
          setCallEnded(true);
        },
        onError: (e) => {
          setError(e.message);
        },
      });

      // Play audio
      if (audioRef.current) {
        audioRef.current.play().catch(() => {});
      }
    } catch (err) {
      setError('Network error — is the agent running?');
      setStarted(false);
    }
  }, [script, started]);

  useEffect(() => {
    return () => { cleanupSSE.current?.(); };
  }, []);

  const label = SCRIPT_LABELS[script] ?? script;

  const playButton = !started ? (
    <button
      onClick={startCall}
      className="px-3.5 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors"
    >
      ▶ Play
    </button>
  ) : callEnded ? (
    <span className="text-xs text-fg-muted">Call ended · redirecting…</span>
  ) : null;

  return (
    <div className="flex flex-col h-screen bg-bg-base overflow-hidden">
      {brief ? (
        <PreCallBriefHeader
          brief={brief}
          callActive={started && !callEnded}
          rightSlot={playButton}
        />
      ) : (
        <div className="flex items-center justify-between px-6 py-3 bg-bg-elevated border-b border-border shrink-0">
          <span className="text-sm font-medium text-fg-primary">{label}</span>
          {playButton}
        </div>
      )}

      {error && (
        <div className="px-6 py-3 bg-signal-negative/10 border-b border-signal-negative/20 text-sm text-signal-negative">
          {error}
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <TranscriptView
          utterances={utterances}
          customerName={brief?.lead.name ?? label}
        />
        <MemoryPanel memory={memory} factsUI={factsUI} />
      </div>

      <SuggestionBar state={suggestion} />

      {/* Hidden audio */}
      <audio
        ref={audioRef}
        src={`/fixtures/${script}-audio.mp3`}
        className="hidden"
        preload="auto"
      />
    </div>
  );
}
