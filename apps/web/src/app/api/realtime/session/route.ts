import { PersonaIdSchema } from '@atlas/types';
import { getPersona, PERSONA_TOOLS } from '@/server/realtime/personas';
import { guard } from '@/server/limits';

export const runtime = 'nodejs';

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-live-transcribe';

export async function POST(req: Request) {
  const blocked = await guard(req, 'session', { failClosed: true });
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const parsed = PersonaIdSchema.safeParse(body.personaId);
  if (!parsed.success) return Response.json({ error: 'invalid personaId' }, { status: 400 });
  const persona = getPersona(parsed.data);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'server_misconfigured', detail: 'OPENAI_API_KEY missing' }, { status: 500 });
  }

  const upstream = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: REALTIME_MODEL,
        instructions: persona.systemPrompt,
        output_modalities: ['audio'],
        audio: {
          input: {
            transcription: { model: TRANSCRIBE_MODEL },
            noise_reduction: { type: 'near_field' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.6,
              prefix_padding_ms: 300,
              silence_duration_ms: 700,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: persona.voice },
        },
        tools: PERSONA_TOOLS,
        tool_choice: 'auto',
      },
      expires_after: { anchor: 'created_at', seconds: 60 },
    }),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    console.error('OpenAI Realtime client_secret creation failed', upstream.status, text);
    return Response.json(
      { error: 'upstream_error', status: upstream.status, detail: text.slice(0, 500) },
      { status: upstream.status === 401 ? 500 : 502 },
    );
  }

  const secret = (await upstream.json()) as { value: string; expires_at: number; session?: { id?: string } };
  return Response.json({
    sessionId: secret.session?.id ?? '',
    clientSecret: secret.value,
    expiresAt: secret.expires_at,
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
}
