'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import posthog from 'posthog-js';
import type { PersonaId } from '@atlas/types';
import { lookupLead, lookupCompany } from '@atlas/types';
import { connectRealtime, type RealtimeClient, type RealtimeSessionInfo } from '@/lib/realtime/client';
import { useCoach } from '@/lib/coach/useCoach';
import { MAX_CALL_MS } from '@/lib/config';
import { CoachChat } from './CoachChat';
import { CallSidebar } from './CallSidebar';
import { PostCallRating } from './PostCallRating';
import { MemoryPanel } from '@/components/MemoryPanel';


export type CallStageProps = {
  personaId: PersonaId;
  callId: string;
  onEnd: () => void;
};

type CallPhase = 'connecting' | 'live' | 'ended' | 'error';

const SIDEBAR_MIN_WIDTH = 360;
const SIDEBAR_MAX_WIDTH = 720;
// Fixed default so server and client render the same; the saved or
// window-relative width is applied after mount.
const SIDEBAR_DEFAULT_WIDTH = 440;
const SIDEBAR_WIDTH_KEY = 'atlas.sidebarWidth';
const clampWidth = (w: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));

export function CallStage({ personaId, callId, onEnd }: CallStageProps) {
  const [phase, setPhase] = useState<CallPhase>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<RealtimeSessionInfo | null>(null);
  const [muted, setMuted] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const audioElRef = useRef<HTMLAudioElement>(null);
  const realtimeRef = useRef<RealtimeClient | null>(null);
  const callStartRef = useRef<number>(Date.now());

  // Restore the rep's preferred panel width, else ~36% of the window.
  useEffect(() => {
    let saved: number | null = null;
    try { saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || null; } catch { /* storage blocked */ }
    setSidebarWidth(clampWidth(saved ?? window.innerWidth * 0.36));
  }, []);
  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch { /* storage blocked */ }
  }, [sidebarWidth, resizing]);

  const onResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSidebarWidth((w) => clampWidth(w + step)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSidebarWidth((w) => clampWidth(w - step)); }
  };

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      const next = clampWidth(startWidth + delta);
      setSidebarWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const { suggestions, memory, factsUI, errors, sendTranscript, sendPersonaToolCall, endCall: coachEndCall, getChatContext } = useCoach({ callId, personaId });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const sessionResp = await fetch('/api/realtime/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ personaId }),
        });
        if (!sessionResp.ok) {
          const detail = await sessionResp.text();
          let friendly: string | null = null;
          try {
            const j = JSON.parse(detail) as { error?: string; code?: string };
            if (sessionResp.status === 429 || sessionResp.status === 403) friendly = j.error ?? null;
          } catch { /* not JSON */ }
          throw new Error(friendly ?? `Session failed (${sessionResp.status}): ${detail.slice(0, 200)}`);
        }
        const info = (await sessionResp.json()) as RealtimeSessionInfo;
        if (cancelled) return;
        setSession(info);

        const client = await connectRealtime({
          session: info,
          events: {
            audioStreamReady: setRemoteStream,
            inputAudioStreamReady: () => {},
            transcript: (e) => sendTranscript(e),
            personaToolCall: (e) => sendPersonaToolCall(e),
            error: (err) => {
              setError(err.message);
              setPhase('error');
            },
            close: () => setPhase((prev) => (prev === 'ended' ? prev : 'ended')),
          },
        });
        if (cancelled) {
          client.hangup();
          return;
        }
        realtimeRef.current = client;
        setPhase('live');
      } catch (err) {
        if (cancelled) return;
        // fetch() rejects with a TypeError when the agent is down or unreachable.
        setError(
          err instanceof TypeError
            ? 'The Atlas demo server is unreachable right now. Please try again in a bit.'
            : err instanceof Error ? err.message : 'connect_failed',
        );
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      realtimeRef.current?.hangup();
      realtimeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId, callId]);

  // Auto hang up at the cap so a forgotten tab can't keep billing a live session.
  useEffect(() => {
    if (phase !== 'live') return;
    const t = setTimeout(() => hangupRef.current(), MAX_CALL_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Pipe remote audio to <audio> element so it actually plays.
  useEffect(() => {
    if (audioElRef.current && remoteStream) {
      audioElRef.current.srcObject = remoteStream;
      audioElRef.current.play().catch(() => { /* user-gesture needed; ignore */ });
    }
  }, [remoteStream]);

  const hangup = () => {
    posthog.capture('call_ended', {
      call_id: callId,
      persona_id: personaId,
      duration_seconds: Math.round((Date.now() - callStartRef.current) / 1000),
    });
    coachEndCall();
    realtimeRef.current?.hangup();
    realtimeRef.current = null;
    setPhase('ended');
  };

  const hangupRef = useRef(hangup);
  hangupRef.current = hangup;

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    realtimeRef.current?.setMuted(next);
  };
  // M toggles mute, except while typing in the chat box.
  const toggleMuteRef = useRef(toggleMute);
  toggleMuteRef.current = toggleMute;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      toggleMuteRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);


  const subtitle = useMemo(() => {
    if (!session?.persona.leadId) return undefined;
    const lead = lookupLead(session.persona.leadId);
    if (!lead) return undefined;
    const company = lookupCompany(lead.companyId);
    return company ? `${lead.title}, ${company.name}` : lead.title;
  }, [session?.persona.leadId]);

  if (phase === 'ended') {
    return (
      <PostCallRating
        personaName={session?.persona.displayName ?? 'Jordan Hayes'}
        onDone={onEnd}
      />
    );
  }

  return (
    // Uniform 12px padding on all edges; sidebar ml-3 provides the same 12px gap between chat and sidebar
    <div
      className="h-screen p-3 flex flex-row bg-[#FAFAF9] overflow-hidden"
      style={{ cursor: resizing ? 'col-resize' : undefined, userSelect: resizing ? 'none' : undefined }}
    >
      <audio ref={audioElRef} autoPlay playsInline />

      {/* Chat: fills remaining space, no card frame */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <CoachChat
          getChatContext={getChatContext}
          suggestions={suggestions}
          title={session ? `Atlas / Discovery call with ${session.persona.displayName}` : 'Atlas'}
        />
      </div>

      {/* Sidebar wrapper: ml-3 = 12px gap (matches outer p-3 on all other edges) */}
      <div className="relative shrink-0 ml-3" style={{ width: sidebarWidth }}>
        {/* Drag handle: negative left offset places it inside the 12px ml gap */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize memory panel"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
          className="absolute left-[-12px] top-0 bottom-0 w-3 cursor-col-resize group z-10 flex items-center justify-center rounded focus-visible:outline-none"
        >
          <div className="w-[3px] h-8 rounded-full bg-transparent group-hover:bg-[#C8C6C3] group-focus-visible:bg-accent transition-colors duration-150" />
        </div>

        {/* Sidebar card: stacked — CallSidebar on top, live MemoryPanel below */}
        <div className="h-full rounded-2xl border border-[#E7E5E4] bg-white shadow-sm overflow-hidden flex flex-col">
          <div className="shrink-0 border-b border-[#E7E5E4]">
            <CallSidebar
              displayName={session?.persona.displayName ?? '...'}
              subtitle={subtitle}
              muted={muted}
              onToggleMute={toggleMute}
              onHangup={hangup}
              phase={phase}
              error={error}
              onErrorBack={onEnd}
              errors={errors}
            />
          </div>
          <div className="flex-1 min-h-0">
            <MemoryPanel
              memory={memory}
              factsUI={factsUI}
              className="w-full bg-white"
              redundantPhrases={[
                session?.persona.displayName ?? '',
                subtitle ?? '',
              ].filter(Boolean)}
              prospectName={session?.persona.displayName.split(' ')[0] ?? 'Prospect'}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

