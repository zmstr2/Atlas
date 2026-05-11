'use client';

import { useState, useEffect, useRef } from 'react';
import { nanoid } from 'nanoid';
import posthog from 'posthog-js';
import type { PersonaId } from '@atlas/types';
import { CallStage } from '@/components/voice/CallStage';

const VALID_PERSONA_IDS: PersonaId[] = ['jordan', 'mia', 'pastor', 'vp-sales'];

const PERSONA_META: Record<PersonaId, { name: string; role: string; org: string; color: string }> = {
  jordan: { name: 'Jordan Hayes', role: 'VP Marketing', org: 'MidCo', color: '#0ea5e9' },
  mia: { name: 'Mia Chen', role: 'Cofounder & CTO', org: 'Drift Labs', color: '#f97316' },
  pastor: { name: 'Pastor Marcus Webb', role: 'Lead Pastor', org: 'Cornerstone Church', color: '#8b5cf6' },
  'vp-sales': { name: 'Cass Rivera', role: 'VP of Sales', org: 'Forge Analytics', color: '#ef4444' },
};

function AudioPreview({ micAllowed, micLevel }: { micAllowed: boolean | null; micLevel: number }) {
  const barCount = 32;
  return (
    <div className="flex-1 flex flex-col relative min-h-0">
      {/* Avatar — bottom-left positioning like Meet */}
      <div className="flex-1 flex items-center justify-center">
        <div className="relative">
          {/* Mic activity ring */}
          <div
            className="absolute inset-[-6px] rounded-full transition-all duration-100"
            style={{
              boxShadow: micAllowed && micLevel > 0.08
                ? `0 0 0 ${Math.round(micLevel * 16 + 2)}px rgba(255,255,255,0.10)`
                : 'none',
            }}
          />
          <div className="w-28 h-28 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center">
            <svg className="w-12 h-12 text-white/25" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
        </div>
      </div>

      {/* Name chip — bottom-left like Meet */}
      <div className="absolute bottom-[72px] left-4">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-black/50 backdrop-blur-sm">
          {micAllowed === false && (
            <svg className="w-3 h-3 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
            </svg>
          )}
          <span className="text-white text-xs font-medium tracking-wide">You</span>
        </div>
      </div>

      {/* Toolbar — full width, pinned to bottom */}
      <div className="h-16 flex items-center px-5 gap-4 border-t border-white/[0.06]">
        {/* Mic button */}
        <button
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors shrink-0 ${
            micAllowed === false ? 'bg-red-500/80' : 'bg-white/10 hover:bg-white/15'
          }`}
          title={micAllowed === false ? 'Microphone blocked' : 'Microphone on'}
        >
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        </button>

        {/* Level bars */}
        <div className="flex items-center gap-[2px] h-4 flex-1">
          {Array.from({ length: barCount }).map((_, i) => {
            const threshold = i / barCount;
            const lit = micAllowed === true && micLevel > threshold;
            return (
              <div
                key={i}
                className="w-[2px] rounded-full flex-1 transition-colors duration-75"
                style={{
                  maxWidth: 3,
                  height: `${Math.round(4 + Math.sin((i / barCount) * Math.PI) * 9)}px`,
                  backgroundColor: lit ? '#4ade80' : 'rgba(255,255,255,0.12)',
                }}
              />
            );
          })}
        </div>

        {/* Mic label */}
        <div className="flex items-center gap-1.5 text-white/35 text-[11px] shrink-0">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
          <span>{micAllowed === false ? 'Blocked' : 'Built-in Mic'}</span>
        </div>
      </div>
    </div>
  );
}

export default function VoicePersonaPage({ params }: { params: { personaId: string } }) {
  const { personaId: rawId } = params;
  const personaId = rawId as PersonaId;
  const isValid = VALID_PERSONA_IDS.includes(personaId);
  const meta = isValid ? PERSONA_META[personaId] : null;

  const [callId, setCallId] = useState<string | null>(null);
  const [micAllowed, setMicAllowed] = useState<boolean | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [micLabel, setMicLabel] = useState('Built-in Mic');
  const animFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!isValid) return;
    let ctx: AudioContext | null = null;

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        streamRef.current = stream;
        setMicAllowed(true);
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          const avg = data.slice(0, 32).reduce((a, b) => a + b, 0) / 32;
          setMicLevel(avg / 128);
          animFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
        navigator.mediaDevices.enumerateDevices().then(devices => {
          const mic = devices.find(d => d.kind === 'audioinput');
          if (mic?.label) setMicLabel(mic.label.replace(/\s*\(.*\)/, '').slice(0, 24));
        });
      })
      .catch(() => setMicAllowed(false));

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      ctx?.close().catch(() => {});
    };
  }, [isValid]);

  const startCall = () => {
    const id = `call_${nanoid(10)}`;
    posthog.capture('call_started', { call_id: id, persona_id: personaId });
    setCallId(id);
  };

  if (!isValid || !meta) {
    return (
      <div className="h-screen bg-[#202124] flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-white font-medium">Unknown persona: {rawId}</p>
          <p className="text-white/40 text-sm">Check the URL and try again.</p>
        </div>
      </div>
    );
  }

  if (callId) {
    return <CallStage callId={callId} personaId={personaId} onEnd={() => setCallId(null)} />;
  }

  const initials = meta.name.split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2);

  return (
    /* Full-screen dark layout — no floating card on beige */
    <div className="h-screen bg-[#202124] flex overflow-hidden">

      {/* Left — camera preview, fills all remaining space */}
      <div className="flex-1 min-w-0 flex flex-col">
        <AudioPreview micAllowed={micAllowed} micLevel={micLevel} />
      </div>

      {/* Right — white sidebar, fixed width, full height */}
      <div className="w-[340px] shrink-0 bg-white flex flex-col overflow-y-auto">

        {/* Atlas wordmark */}
        <div className="px-8 pt-8 pb-2">
          <span className="text-[11px] font-bold tracking-[0.12em] uppercase text-fg-muted/60">Atlas</span>
        </div>

        {/* Persona identity */}
        <div className="px-8 pt-6 pb-8 flex-1 flex flex-col">
          <div className="mb-8">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted mb-2">
              Practice call
            </p>
            <h1 className="text-[28px] font-semibold text-fg-primary leading-tight tracking-tight">
              {meta.name}
            </h1>
            <p className="text-fg-secondary text-[14px] mt-1">{meta.role} · {meta.org}</p>
          </div>

          {/* Participant card */}
          <div className="rounded-xl border border-[#E7E5E4] bg-[#FAFAF9] overflow-hidden mb-4">
            {/* Persona row */}
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0"
                style={{ backgroundColor: meta.color }}
              >
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-fg-primary truncate">{meta.name}</p>
                <p className="text-[12px] text-fg-muted truncate">{meta.org}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-[11px] text-fg-muted font-medium">Ready</span>
              </div>
            </div>

            <div className="mx-4 h-px bg-[#E7E5E4]" />

            {/* Atlas badge */}
            <div className="flex items-center gap-2.5 px-4 py-3">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-atlas-pulse shrink-0" />
              <span className="text-[12px] text-fg-secondary leading-snug">
                Atlas is live — coaching you in real time
              </span>
            </div>
          </div>

          {/* Mic warning — only when blocked */}
          {micAllowed === false && (
            <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg bg-amber-50 border border-amber-200/80 mb-4">
              <svg className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="text-[12px] text-amber-700 leading-snug">
                Microphone access needed. Allow it in your browser settings, then refresh.
              </p>
            </div>
          )}

          <div className="flex-1" />

          {/* Join button */}
          <button
            onClick={startCall}
            className="w-full py-3.5 rounded-xl font-semibold text-[14px] text-white transition-opacity hover:opacity-90 active:opacity-80"
            style={{
              backgroundColor: meta.color,
              boxShadow: `0 2px 16px ${meta.color}50`,
            }}
          >
            Join now
          </button>

          <p className="text-center text-[11px] text-fg-muted mt-3">
            Microphone required · audio only
          </p>
        </div>
      </div>
    </div>
  );
}
