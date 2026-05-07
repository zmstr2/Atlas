'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  endCall,
  getCall,
  isTauri,
  streamCall,
  type CallDetail,
  type SSEEventLike,
} from '@/lib/agent';
import type { Utterance, MeetingMemory, CallFactsUI } from '@atlas/types';
import { TranscriptView } from '@/components/TranscriptView';
import { MemoryPanel } from '@/components/MemoryPanel';
import { SuggestionBar } from '@/components/SuggestionBar';
import { PreCallBriefHeader } from '@/components/PreCallBrief';
import { AuthGate } from '@/components/AuthGate';

// Recording state machine — independent of `ended` (call-ended-in-DB).
// 'idle'      : not yet wired up (web/dev or pre-effect)
// 'starting'  : invoke('start_recording') in flight
// 'recording' : Meetily is capturing audio + Whisper running
// 'failed'    : start_recording rejected; show error + Retry
// 'stopped'   : we stopped recording locally (user ended call or unmounted)
type RecordingStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'failed'
  | 'stopped';

export default function LiveCallPageRoute({
  params,
}: {
  params: { id: string };
}) {
  return (
    <AuthGate>
      <LiveCallPage params={params} />
    </AuthGate>
  );
}

function LiveCallPage({ params }: { params: { id: string } }) {
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

  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle');
  const [recordingError, setRecordingError] = useState<string | null>(null);
  // Bumped to retry start_recording without remounting the page.
  const [recordingAttempt, setRecordingAttempt] = useState(0);
  // Track the live recording status in a ref so the unmount cleanup can
  // decide whether to defensively stop_recording without depending on
  // (and re-running for) every status change.
  const recordingStatusRef = useRef<RecordingStatus>('idle');
  useEffect(() => {
    recordingStatusRef.current = recordingStatus;
  }, [recordingStatus]);

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

  // Wire up Meetily recording on mount (Tauri only).
  //
  // 1. set_active_atlas_call — atlas_bridge will start forwarding
  //    transcript-update events to the agent under this callId.
  // 2. start_recording — kicks off mic + system audio capture and Whisper.
  //    Uses OS default devices; the user can change devices via Meetily's
  //    existing settings UI.
  //
  // On unmount we defensively stop_recording (Tauri windows can close
  // abruptly). We do NOT call endCall here — that would falsely mark the
  // call as ended in the DB; only handleEndCall does that.
  useEffect(() => {
    if (!isTauri()) return;
    if (ended) return;
    // Wait until we have detail so we can pass a meaningful meeting name.
    if (!detail) return;

    let cancelled = false;

    const meetingName =
      detail.call.brief_json?.prospect?.name?.trim() ||
      detail.call.prospect_name ||
      callId;

    setRecordingStatus('starting');
    setRecordingError(null);

    (async () => {
      // Lazy import — these modules only resolve inside the Tauri webview.
      const { invoke } = await import('@tauri-apps/api/core');

      try {
        await invoke<void>('set_active_atlas_call', { callId });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[call] set_active_atlas_call failed', err);
        setRecordingStatus('failed');
        setRecordingError(`Couldn't register active call: ${msg}`);
        return;
      }

      try {
        await invoke<void>('start_recording', {
          micDeviceName: undefined,
          systemDeviceName: undefined,
          meetingName,
        });
        if (cancelled) return;
        setRecordingStatus('recording');
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[call] start_recording failed', err);
        setRecordingStatus('failed');
        setRecordingError(msg);
      }
    })();

    return () => {
      cancelled = true;
      // Defensive cleanup: if the user closes the window mid-call without
      // clicking "End call", stop the recording so audio doesn't keep
      // capturing in the background. Don't touch endCall.
      const wasRecording =
        recordingStatusRef.current === 'recording' ||
        recordingStatusRef.current === 'starting';
      if (!wasRecording) return;

      void (async () => {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const { appDataDir, join } = await import('@tauri-apps/api/path');
          let savePath: string;
          try {
            const base = await appDataDir();
            savePath = await join(base, 'recordings', `${callId}.wav`);
          } catch {
            savePath = `recordings/${callId}.wav`;
          }
          await invoke<void>('stop_recording', { args: { save_path: savePath } });
          await invoke<void>('clear_active_atlas_call');
        } catch (err) {
          console.warn('[call] cleanup stop_recording failed', err);
        }
      })();
    };
  }, [callId, detail, ended, recordingAttempt]);

  useEffect(() => {
    if (ended) return;
    let es: EventSource | null = null;
    let cancelled = false;
    streamCall(callId, (ev: SSEEventLike) => {
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
    })
      .then((source) => {
        if (cancelled) {
          source.close();
        } else {
          es = source;
        }
      })
      .catch((err) => {
        console.warn('[call] streamCall failed', err);
      });
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [callId, ended]);

  async function handleEndCall() {
    try {
      // Stop Meetily first so audio capture halts even if the agent's
      // /end endpoint is slow or fails. Save the wav under app_data_dir
      // for later playback / debugging.
      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const { appDataDir, join } = await import('@tauri-apps/api/path');
          let savePath: string;
          try {
            const base = await appDataDir();
            savePath = await join(base, 'recordings', `${callId}.wav`);
          } catch {
            savePath = `recordings/${callId}.wav`;
          }
          await invoke<void>('stop_recording', { args: { save_path: savePath } });
          await invoke<void>('clear_active_atlas_call');
          setRecordingStatus('stopped');
        } catch (err) {
          // Non-fatal — surface in console but still try to end the call
          // server-side. Otherwise the user is stuck on this page.
          console.warn('[call] stop_recording on end failed', err);
        }
      }
      await endCall(callId);
      setEnded(true);
      router.push(`/call/${callId}/coaching`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function retryRecording() {
    setRecordingAttempt((n) => n + 1);
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
      <RecordingStatusBar
        status={recordingStatus}
        ended={ended}
        error={recordingError}
        onRetry={retryRecording}
        onEndCall={handleEndCall}
      />

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

// ── Recording status bar ────────────────────────────────────────────────────
//
// Top-of-page indicator showing whether Meetily is actually capturing audio.
// Without this, the user sees an empty transcript and has no idea whether
// audio is flowing or the page is broken.
function RecordingStatusBar({
  status,
  ended,
  error,
  onRetry,
  onEndCall,
}: {
  status: RecordingStatus;
  ended: boolean;
  error: string | null;
  onRetry: () => void;
  onEndCall: () => void;
}) {
  if (ended) {
    return (
      <div className="bg-bg-elevated border-b border-border px-4 py-2 text-xs text-fg-muted">
        Call ended
      </div>
    );
  }

  if (status === 'idle' || status === 'stopped') {
    // Either pre-Tauri-effect or web/dev — render nothing rather than
    // a misleading "not recording" banner.
    return null;
  }

  if (status === 'starting') {
    return (
      <div className="bg-bg-elevated border-b border-border px-4 py-2 flex items-center gap-2 text-xs text-fg-secondary">
        <span className="inline-block w-2 h-2 rounded-full bg-fg-muted animate-pulse" />
        Starting recording…
      </div>
    );
  }

  if (status === 'recording') {
    return (
      <div className="bg-bg-elevated border-b border-border px-4 py-2 flex items-center gap-2 text-xs text-fg-secondary">
        <span className="inline-block w-2 h-2 rounded-full bg-signal-positive animate-pulse" />
        Listening — Atlas is processing audio
      </div>
    );
  }

  // status === 'failed'
  return (
    <div className="bg-signal-negative/10 border-b border-signal-negative/30 px-4 py-3 flex items-center gap-3 text-xs">
      <span className="inline-block w-2 h-2 rounded-full bg-signal-negative" />
      <span className="text-signal-negative flex-1">
        Couldn't start audio{error ? `: ${error}` : '.'}
      </span>
      <button
        onClick={onRetry}
        className="px-2.5 py-1 bg-bg-elevated border border-border rounded text-fg-primary hover:bg-bg-base transition-colors text-xs font-medium"
      >
        Retry
      </button>
      <button
        onClick={onEndCall}
        className="px-2.5 py-1 bg-signal-negative text-white rounded hover:bg-signal-negative/90 transition-colors text-xs font-medium"
      >
        End call
      </button>
    </div>
  );
}
