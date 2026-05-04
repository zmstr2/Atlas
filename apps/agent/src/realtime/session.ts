import { Hono } from 'hono';
import { PersonaIdSchema } from '@atlas/types';
import { getPersona, PERSONA_TOOLS } from './personas';

export const realtimeRoutes = new Hono();

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-1.5';

realtimeRoutes.post('/session', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = PersonaIdSchema.safeParse(body.personaId);
  if (!parsed.success) {
    return c.json({ error: 'invalid personaId' }, 400);
  }
  const persona = getPersona(parsed.data);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'server_misconfigured', detail: 'OPENAI_API_KEY missing' }, 500);
  }

  const upstream = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'realtime=v1',
    },
    body: JSON.stringify({
      model: REALTIME_MODEL,
      voice: persona.voice,
      instructions: persona.systemPrompt,
      modalities: ['audio', 'text'],
      tools: PERSONA_TOOLS,
      tool_choice: 'auto',
      turn_detection: {
        type: 'server_vad',
        threshold: 0.6,
        prefix_padding_ms: 300,
        silence_duration_ms: 700,
        create_response: true,
        interrupt_response: true,
      },
      input_audio_noise_reduction: { type: 'near_field' },
      input_audio_transcription: { model: 'gpt-4o-transcribe' },
    }),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    console.error('OpenAI Realtime session creation failed', upstream.status, text);
    return c.json(
      { error: 'upstream_error', status: upstream.status, detail: text.slice(0, 500) },
      upstream.status === 401 ? 500 : 502,
    );
  }

  const session = (await upstream.json()) as {
    id: string;
    client_secret: { value: string; expires_at: number };
  };

  return c.json({
    sessionId: session.id,
    clientSecret: session.client_secret.value,
    expiresAt: session.client_secret.expires_at,
    persona: {
      id: persona.id,
      displayName: persona.displayName,
      voice: persona.voice,
      leadId: persona.leadId,
      openingLine: persona.openingLine,
      orbColor: persona.orbColor,
    },
    model: REALTIME_MODEL,
  });
});
