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

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
    </svg>
  );
}

function MicMutedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function MoreIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
    </svg>
  );
}

export default function VoicePersonaPage({ params }: { params: { personaId: string } }) {
  const { personaId: rawId } = params;
  const personaId = rawId as PersonaId;
  const isValid = VALID_PERSONA_IDS.includes(personaId);
  const meta = isValid ? PERSONA_META[personaId] : null;

  const [callId, setCallId] = useState<string | null>(null);
  const [micAllowed, setMicAllowed] = useState<boolean | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micLabel, setMicLabel] = useState('Default microphone');
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
          if (mic?.label) setMicLabel(mic.label.replace(/\s*\(.*\)/, '').slice(0, 28));
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
      <div className="h-screen bg-white flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-[#202124] font-medium">Unknown persona: {rawId}</p>
          <p className="text-[#5f6368] text-sm">Check the URL and try again.</p>
        </div>
      </div>
    );
  }

  if (callId) {
    return <CallStage callId={callId} personaId={personaId} onEnd={() => setCallId(null)} />;
  }

  const effectivelyMuted = micMuted || micAllowed === false;
  const showActivity = micAllowed === true && !micMuted && micLevel > 0.06;

  return (
    <div className="min-h-screen bg-white flex flex-col">

      {/* Top bar — Atlas wordmark left, mode indicator right */}
      <header className="flex items-center justify-between px-6 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: meta.color }}>
            <span className="text-white text-xs font-bold">A</span>
          </div>
          <span className="text-[#202124] text-[20px] font-medium tracking-tight">Atlas</span>
        </div>
        <div className="flex items-center gap-2.5 text-[#5f6368] text-[13px]">
          <span className="hidden sm:inline">Practice mode</span>
          <div className="w-8 h-8 rounded-full bg-[#e8eaed] flex items-center justify-center text-[#5f6368]">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
            </svg>
          </div>
        </div>
      </header>

      {/* Main — centered content */}
      <main className="flex-1 flex items-center justify-center px-6 py-4 min-h-0">
        <div className="w-full max-w-[1100px] flex flex-col lg:flex-row gap-8 lg:gap-12 items-center justify-center">

          {/* Camera tile + device pills */}
          <div className="w-full max-w-[640px] flex flex-col items-center">

            {/* The dark camera tile — 16:9 */}
            <div className="w-full aspect-video relative rounded-2xl bg-[#202124] overflow-hidden">

              {/* Name chip top-left (Meet convention) */}
              <div className="absolute top-4 left-4 z-10">
                <span className="text-white text-[14px] font-normal">You</span>
              </div>

              {/* More menu top-right */}
              <button
                className="absolute top-3 right-3 z-10 w-9 h-9 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors"
                aria-label="More options"
              >
                <MoreIcon className="w-5 h-5 text-white" />
              </button>

              {/* Center — avatar circle (camera placeholder since audio-only) */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative">
                  <div
                    className="absolute inset-[-8px] rounded-full transition-all duration-100 pointer-events-none"
                    style={{
                      boxShadow: showActivity
                        ? `0 0 0 ${Math.round(micLevel * 18 + 4)}px rgba(255,255,255,0.10)`
                        : 'none',
                    }}
                  />
                  <div className="w-[88px] h-[88px] rounded-full bg-[#3c4043] flex items-center justify-center">
                    <span className="text-white/90 text-[36px] font-medium tracking-tight">Z</span>
                  </div>
                </div>
              </div>

              {/* Bottom centered controls — circular outlined Meet-style */}
              <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-3">
                <button
                  onClick={() => setMicMuted(m => !m)}
                  disabled={micAllowed === false}
                  className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
                    effectivelyMuted
                      ? 'bg-[#ea4335] hover:bg-[#d33b2c]'
                      : 'bg-transparent border border-white/30 hover:bg-white/10'
                  } ${micAllowed === false ? 'cursor-not-allowed opacity-90' : ''}`}
                  aria-label={effectivelyMuted ? 'Unmute' : 'Mute'}
                >
                  {effectivelyMuted
                    ? <MicMutedIcon className="w-5 h-5 text-white" />
                    : <MicIcon className="w-5 h-5 text-white" />
                  }
                </button>
              </div>

              {/* Mic blocked overlay */}
              {micAllowed === false && (
                <div className="absolute bottom-5 right-5 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/60 backdrop-blur-sm">
                  <MicMutedIcon className="w-3.5 h-3.5 text-[#f28b82]" />
                  <span className="text-[#f28b82] text-[12px]">Mic blocked</span>
                </div>
              )}
            </div>

            {/* Device selector pills — below the tile, Meet style */}
            <div className="mt-5 flex items-center gap-2 flex-wrap justify-center">
              <DevicePill
                icon={<MicIcon className="w-4 h-4" />}
                label={micAllowed === false ? 'Microphone blocked' : micLabel}
                blocked={micAllowed === false}
              />
            </div>

            {/* Check link */}
            {micAllowed === true && (
              <button className="mt-3 text-[#0b57d0] text-[13px] font-medium hover:underline">
                Check your audio
              </button>
            )}
          </div>

          {/* Right column — meeting info, no sidebar panel */}
          <div className="w-full max-w-[360px] flex flex-col items-center text-center">

            <p className="text-[#5f6368] text-[13px] font-medium uppercase tracking-wider mb-2">
              Demo Call
            </p>
            <h1 className="text-[#202124] text-[28px] font-normal leading-[1.2] tracking-tight mb-1">
              with {meta.name}
            </h1>
            <p className="text-[#5f6368] text-[14px] mb-8">
              {meta.role} · {meta.org}
            </p>

            {/* Atlas suggestion pill — Meet uses this style for Gemini */}
            <div className="w-full bg-[#e8f0fe] rounded-full px-4 py-3 flex items-center gap-3 mb-6">
              <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: meta.color }}>
                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8 5.8 21.3l2.4-7.4L2 9.4h7.6z"/>
                </svg>
              </div>
              <p className="text-[#202124] text-[13px] font-medium leading-tight">Atlas is on the line to coach you</p>
            </div>

            {/* Join button — Meet-style pill */}
            <button
              onClick={startCall}
              className="w-full py-3 rounded-full text-white font-medium text-[14px] tracking-wide transition-all hover:shadow-md active:scale-[0.98]"
              style={{ backgroundColor: meta.color }}
            >
              Join now
            </button>

            <p className="mt-6 text-[#5f6368] text-[12px]">
              Microphone required · audio only
            </p>
          </div>
        </div>
      </main>

      {/* Footer disclaimer */}
      <footer className="px-6 py-4 shrink-0 text-center">
        <p className="text-[#5f6368] text-[12px]">
          Atlas coaches the rep only · The persona is an AI · No recordings stored
        </p>
      </footer>
    </div>
  );
}

function DevicePill({ icon, label, blocked }: { icon: React.ReactNode; label: string; blocked?: boolean }) {
  return (
    <button
      className={`flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full border transition-colors ${
        blocked
          ? 'border-[#fce8e6] bg-[#fce8e6] text-[#c5221f]'
          : 'border-[#dadce0] bg-white hover:bg-[#f8f9fa] text-[#3c4043]'
      }`}
    >
      <span className={blocked ? 'text-[#c5221f]' : 'text-[#5f6368]'}>{icon}</span>
      <span className="text-[13px] font-medium max-w-[180px] truncate">{label}</span>
      <ChevronDown className="w-3 h-3 opacity-60" />
    </button>
  );
}
