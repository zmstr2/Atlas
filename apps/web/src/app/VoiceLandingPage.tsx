'use client';
import { useState } from 'react';
import Image from 'next/image';
import { nanoid } from 'nanoid';
import posthog from 'posthog-js';
import type { PersonaId } from '@atlas/types';
import { CallStage } from '@/components/voice/CallStage';

type ActiveCall = { callId: string; personaId: PersonaId };

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri';
const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const DAY_NAMES: Record<DayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
};
const DAY_SHORT: Record<DayKey, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
};

type CalendarEvent = {
  time: string;
  title: string;
  isDemoCall?: boolean;
};

const EVENTS: Record<DayKey, CalendarEvent[]> = {
  mon: [
    { time: '9:00', title: 'Standup' },
    { time: '11:30', title: '1:1 — Marcus' },
    { time: '3:00', title: 'Pipeline review' },
  ],
  tue: [
    { time: '10:00', title: 'Forecast call' },
    { time: '1:00', title: 'Demo: Acme Corp' },
    { time: '4:30', title: 'Focus block' },
  ],
  wed: [
    { time: '9:30', title: 'Q2 planning' },
    { time: '12:00', title: 'Lunch — Priya' },
    { time: '2:00', title: 'Customer sync' },
  ],
  thu: [
    { time: '9:00', title: 'Standup' },
    { time: '2:00', title: 'YC W26 — Mia Chen (Drift Labs)', isDemoCall: true },
    { time: '4:00', title: 'Forecast prep' },
  ],
  fri: [
    { time: '10:00', title: '1:1 — Sarah' },
    { time: '1:00', title: 'All-hands' },
    { time: '3:30', title: 'Weekly review' },
  ],
};

function getTodayKey(): DayKey {
  const dow = new Date().getDay(); // 0 Sun ... 6 Sat
  if (dow >= 1 && dow <= 5) return DAY_ORDER[dow - 1];
  return 'thu'; // weekend fallback
}

// Convert event time strings (e.g. "9:00", "1:00", "2:30") to minutes-from-midnight
// using the convention that hours < 8 are PM (afternoon), >= 8 are AM.
function timeToMinutes(t: string): number {
  const [hStr, mStr] = t.split(':');
  const h = Number(hStr);
  const m = Number(mStr ?? 0);
  const hour24 = h < 8 ? h + 12 : h;
  return hour24 * 60 + m;
}

export default function VoiceLandingPage() {
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [todayKey] = useState<DayKey>(getTodayKey);

  if (active) {
    return (
      <CallStage
        callId={active.callId}
        personaId={active.personaId}
        onEnd={() => setActive(null)}
      />
    );
  }

  const startCall = () => {
    const callId = `call_${nanoid(10)}`;
    posthog.capture('call_started', { call_id: callId, persona_id: 'mia' });
    setActive({ callId, personaId: 'mia' });
  };

  // The demo call lives on whatever day is "today" so the demo always feels current.
  const eventsByDay: Record<DayKey, CalendarEvent[]> = { ...EVENTS };
  if (todayKey !== 'thu') {
    eventsByDay.thu = EVENTS.thu.map(e => (e.isDemoCall ? { ...e, isDemoCall: false } : e));
    eventsByDay[todayKey] = [
      ...EVENTS[todayKey],
      { time: '2:00', title: 'YC W26 — Mia Chen (Drift Labs)', isDemoCall: true },
    ].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
  }

  return (
    <main className="min-h-screen bg-bg-base flex flex-col items-center px-6 pt-8">
      <div className="max-w-5xl w-full flex flex-col flex-1 space-y-8">
        <header>
          <Image
            src="/atlas-banner.png"
            alt="Win more calls with Atlas"
            width={1200}
            height={340}
            className="w-full rounded-2xl object-cover max-h-40"
            priority
          />
          <div className="pt-10 pb-2">
            <h1 className="text-4xl font-semibold text-fg-primary leading-tight">
              Hey Jaspar, here&apos;s your {DAY_NAMES[todayKey]}.
            </h1>
            <p className="text-fg-secondary text-lg mt-2">
              You&apos;ve got a W26 conversation with Mia Chen (Drift Labs) at 2:00 — Atlas will be on the line.
            </p>
          </div>
        </header>

        <section>
          <div className="rounded-2xl border border-border bg-bg-elevated overflow-hidden">
            <div className="grid grid-cols-5">
              {DAY_ORDER.map((key, idx) => {
                const isToday = key === todayKey;
                const isPast = DAY_ORDER.indexOf(key) < DAY_ORDER.indexOf(todayKey);
                return (
                  <div
                    key={key}
                    className={`p-3 min-h-[200px] ${idx > 0 ? 'border-l border-border' : ''} ${isToday ? 'bg-accent/[0.04]' : ''}`}
                  >
                    <div className="flex items-baseline justify-between mb-3">
                      <div
                        className={`text-xs uppercase tracking-wider font-semibold ${
                          isToday ? 'text-accent' : isPast ? 'text-fg-muted/60' : 'text-fg-muted'
                        }`}
                      >
                        {DAY_SHORT[key]}
                      </div>
                      {isToday && (
                        <div className="text-[9px] uppercase tracking-wider text-accent font-bold">
                          Today
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {eventsByDay[key].map((ev, i) => (
                        <EventTile
                          key={i}
                          event={ev}
                          isPast={isPast}
                          onClick={ev.isDemoCall ? startCall : undefined}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <div className="flex-1" />
      </div>
    </main>
  );
}

function EventTile({
  event,
  isPast,
  onClick,
}: {
  event: CalendarEvent;
  isPast: boolean;
  onClick?: () => void;
}) {
  if (event.isDemoCall) {
    return (
      <div className="rounded-md px-2 py-2 bg-accent text-white shadow-lg shadow-accent/25 ring-1 ring-accent/40">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-white animate-atlas-pulse" />
          <span className="text-[10px] font-semibold opacity-90">{event.time}</span>
        </div>
        <div className="text-xs font-semibold leading-tight mt-1">{event.title}</div>
        <div className="text-[10px] opacity-80 mt-0.5">MidCo · 30 min</div>
        <button
          onClick={onClick}
          className="mt-2 w-full text-center rounded px-2 py-1 bg-white/20 hover:bg-white/30 text-white text-[10px] font-semibold transition"
        >
          Join Zoom
        </button>
      </div>
    );
  }

  return (
    <div
      className={`rounded-md px-2 py-1.5 ${
        isPast
          ? 'bg-bg-subtle/30 text-fg-muted/60 line-through'
          : 'bg-bg-subtle text-fg-secondary'
      }`}
    >
      <div className="text-[10px] font-medium opacity-70">{event.time}</div>
      <div className="text-xs leading-tight mt-0.5">{event.title}</div>
    </div>
  );
}

