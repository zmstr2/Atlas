'use client';
import { useMemo } from 'react';
import { nanoid } from 'nanoid';
import posthog from 'posthog-js';
import { CallStage } from '@/components/voice/CallStage';

export default function Page() {
  const callId = useMemo(() => {
    const id = `call_${nanoid(10)}`;
    posthog.capture('call_started', { call_id: id, persona_id: 'mia' });
    return id;
  }, []);

  return <CallStage callId={callId} personaId="mia" onEnd={() => {}} />;
}
