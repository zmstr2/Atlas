'use client';

import { useState, useEffect, useRef } from 'react';
import { nanoid } from 'nanoid';
import posthog from 'posthog-js';
import type { PersonaId } from '@atlas/types';
import { CallStage } from '@/components/voice/CallStage';

const VALID_PERSONA_IDS: PersonaId[] = ['jordan', 'mia', 'pastor', 'vp-sales'];

const PERSONA_META: Record<PersonaId, { name: string; role: string; org: string; color: string }> = {
  jordan: {
    name: 'Jordan Hayes',
    role: 'VP Marketing',
    org: 'MidCo',
    color: '#0ea5e9',
  },
  mia: {
    name: 'Mia Chen',
    role: 'Cofounder & CTO',
    org: 'Drift Labs',
    color: '#f97316',
  },
  pastor: {
    name: 'Pastor Marcus Webb',
    role: 'Lead Pastor',
    org: 'Cornerstone Church',
    color: '#8b5cf6',
  },
  'vp-sales': {
    name: 'Cass Rivera',
    role: 'VP of Sales',
    org: 'Forge Analytics',
    color: '#ef4444',
  },
};

function MicWaveform({ active }: { active: boolean }) {
  const bars = 5;
  return (
    <div className="flex items-center gap-[3px] h-5">
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          className="w-[3px] rounded-full bg-white/70 transition-all duration-150"
          style={{
            height: active ? `${Math.floor(Math.random() * 14) + 4}px` : '4px',
            animationDelay: `${i * 80}ms`,
          }}
        />
      ))}
    </div>
  );
}

function AudioPreview() {
  const [micLevel, setMicLevel] = useState(0);
  const [micAllowed, setMicAllowed] = useState<boolean | null>(null);
  const [selectedMic, setSelectedMic] = useState('Default');
  const animFrameRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
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
        analyserRef.current = analyser;

        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          const avg = data.slice(0, 32).reduce((a, b) => a + b, 0) / 32;
          setMicLevel(avg / 128);
          animFrameRef.current = requestAnimationFrame(tick);
        };
        tick();

        // Get mic label
        navigator.mediaDevices.enumerateDevices().then(devices => {
          const mic = devices.find(d => d.kind === 'audioinput' && d.deviceId === 'default');
          if (mic?.label) setSelectedMic(mic.label.replace(/\s*\(.*\)/, ''));
        });
      })
      .catch(() => setMicAllowed(false));

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      ctx?.close();
    };
  }, []);

  const barCount = 28;
  return (
    <div className="flex flex-col h-full bg-[#1a1a1a] rounded-2xl overflow-hidden relative select-none">
      {/* Dark gradient bg */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#1e1e1e] to-[#111]" />

      {/* Center content */}
      <div className="relative flex-1 flex flex-col items-center justify-center gap-6">
        {/* Avatar circle with mic level ring */}
        <div className="relative">
          <div
            className="absolute inset-0 rounded-full transition-all duration-100"
            style={{
              boxShadow: micAllowed && micLevel > 0.05
                ? `0 0 0 ${Math.round(micLevel * 20)}px rgba(255,255,255,0.08)`
                : 'none',
            }}
          />
          <div className="w-24 h-24 rounded-full bg-[#2a2a2a] border border-white/10 flex items-center justify-center">
            <svg className="w-10 h-10 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
        </div>

        {/* Name tag */}
        <div className="px-3 py-1.5 rounded-lg bg-black/40 backdrop-blur-sm border border-white/10">
          <span className="text-white text-sm font-medium">You</span>
        </div>

        {/* Mic status */}
        {micAllowed === false && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/20 border border-red-500/30">
            <svg className="w-3.5 h-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-red-300 text-xs">Microphone blocked</span>
          </div>
        )}
      </div>

      {/* Bottom toolbar */}
      <div className="relative px-6 py-4 flex items-center gap-3">
        {/* Mic button */}
        <button
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            micAllowed === false
              ? 'bg-red-500/80 hover:bg-red-500'
              : 'bg-white/10 hover:bg-white/20'
          }`}
        >
          {micAllowed === false ? (
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          )}
        </button>

        {/* Mic level bars */}
        <div className="flex items-center gap-[2px] h-4">
          {Array.from({ length: barCount }).map((_, i) => {
            const threshold = i / barCount;
            const lit = micAllowed && micLevel > threshold;
            return (
              <div
                key={i}
                className="w-[2px] rounded-full transition-colors duration-75"
                style={{
                  height: `${4 + Math.sin((i / barCount) * Math.PI) * 10}px`,
                  backgroundColor: lit ? '#4ade80' : 'rgba(255,255,255,0.15)',
                }}
              />
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1.5 text-white/40 text-xs">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
          <span className="truncate max-w-[160px]">{selectedMic}</span>
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

  const startCall = () => {
    const id = `call_${nanoid(10)}`;
    posthog.capture('call_started', { call_id: id, persona_id: personaId });
    setCallId(id);
  };

  if (!isValid || !meta) {
    return (
      <div className="min-h-screen bg-[#111] flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-white font-medium">Unknown persona: {rawId}</p>
          <p className="text-white/40 text-sm">Check the URL and try again.</p>
        </div>
      </div>
    );
  }

  if (callId) {
    return (
      <CallStage
        callId={callId}
        personaId={personaId}
        onEnd={() => setCallId(null)}
      />
    );
  }

  const initials = meta.name.split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2);

  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center px-8">
      <div className="w-full max-w-4xl flex gap-6 items-stretch" style={{ minHeight: 460 }}>

        {/* Left — mic preview */}
        <div className="flex-1 min-w-0">
          <AudioPreview />
        </div>

        {/* Right — persona info + join */}
        <div className="w-80 shrink-0 flex flex-col justify-center gap-6 py-2">

          {/* Header */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted mb-1">Practice call</p>
            <h1 className="text-2xl font-semibold text-fg-primary leading-tight">
              {meta.name}
            </h1>
            <p className="text-fg-secondary text-sm mt-0.5">{meta.role} · {meta.org}</p>
          </div>

          {/* Status card */}
          <div className="rounded-xl border border-border bg-bg-elevated p-4 space-y-3">
            {/* Persona avatar row */}
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                style={{ backgroundColor: meta.color }}
              >
                {initials}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg-primary truncate">{meta.name}</p>
                <p className="text-xs text-fg-muted truncate">{meta.org}</p>
              </div>
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-xs text-fg-muted">Ready</span>
              </div>
            </div>

            <div className="border-t border-border" />

            {/* Atlas badge */}
            <div className="flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-atlas-pulse shrink-0" />
              <span className="text-xs text-fg-secondary">Atlas is on the line — coaching you in real time</span>
            </div>
          </div>

          {/* Join button */}
          <button
            onClick={startCall}
            className="w-full py-3 rounded-xl font-semibold text-sm text-white transition-all shadow-lg"
            style={{
              backgroundColor: meta.color,
              boxShadow: `0 4px 20px ${meta.color}40`,
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            Join now
          </button>

          <p className="text-xs text-fg-muted text-center -mt-3">
            Microphone required · audio only
          </p>
        </div>
      </div>
    </div>
  );
}
