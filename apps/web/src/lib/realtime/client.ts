import type { TranscriptEvent, PersonaToolCallEvent } from '@atlas/types';

export type RealtimeSessionInfo = {
  sessionId: string;
  clientSecret: string;
  expiresAt: number;
  model: string;
  persona: {
    id: string;
    displayName: string;
    voice: string;
    leadId: string;
    openingLine: string;
    orbColor: string;
  };
};

export type RealtimeEvents = {
  open: () => void;
  transcript: (event: TranscriptEvent) => void;
  personaToolCall: (event: PersonaToolCallEvent) => void;
  audioStreamReady: (stream: MediaStream) => void;
  inputAudioStreamReady: (stream: MediaStream) => void;
  error: (err: Error) => void;
  close: (reason?: string) => void;
};

export type RealtimeClient = {
  peer: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  micTrack: MediaStreamTrack | null;
  setMuted: (muted: boolean) => void;
  sendDataChannel: (payload: unknown) => void;
  hangup: () => void;
};

const REALTIME_URL = 'https://api.openai.com/v1/realtime/calls';

/**
 * Connect the browser directly to OpenAI Realtime via WebRTC.
 *
 *   Browser ─[WebRTC audio]─► OpenAI ─[WebRTC audio]─► Browser
 *           └[data channel]──◄─┘ (transcripts, tool calls)
 *
 * The clientSecret comes from your /realtime/session endpoint (60s TTL).
 * Audio bytes never traverse your backend.
 */
export async function connectRealtime(opts: {
  session: RealtimeSessionInfo;
  events: Partial<RealtimeEvents>;
}): Promise<RealtimeClient> {
  const { session, events } = opts;
  const peer = new RTCPeerConnection();

  // Inbound audio: an <audio> element receives the remote track.
  const remoteStream = new MediaStream();
  peer.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    events.audioStreamReady?.(remoteStream);
  };

  // Mic in.
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const micTrack = micStream.getAudioTracks()[0] ?? null;
  if (micTrack) peer.addTrack(micTrack, micStream);
  events.inputAudioStreamReady?.(micStream);

  // Data channel for transcripts and tool calls.
  const dataChannel = peer.createDataChannel('oai-events');
  dataChannel.onopen = () => {
    events.open?.();
    // Trigger the persona to speak first (Zoom-style greeting).
    dataChannel.send(JSON.stringify({ type: 'response.create' }));
  };

  // Persona text finishes generating well before its audio finishes playing.
  // Buffer the final transcript and only flush it once OpenAI signals the
  // assistant audio buffer has stopped streaming — that's the moment the rep
  // is actually about to hear the end of the utterance.
  const pendingPersonaFinal = new Map<string, { text: string; itemId: string }>();
  // Tracks in-flight drain timers so hangup() can cancel them before they fire.
  const drainTimers = new Set<ReturnType<typeof setTimeout>>();

  dataChannel.onmessage = (msg) => {
    let payload: { type?: string } & Record<string, unknown>;
    try {
      payload = JSON.parse(msg.data);
    } catch {
      return;
    }
    routeEvent(payload, events, pendingPersonaFinal, drainTimers);
  };

  // Offer/answer with OpenAI as the remote peer.
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  const sdpResponse = await fetch(REALTIME_URL, {
    method: 'POST',
    body: offer.sdp,
    headers: {
      'Authorization': `Bearer ${session.clientSecret}`,
      'Content-Type': 'application/sdp',
    },
  });

  if (!sdpResponse.ok) {
    const text = await sdpResponse.text();
    const err = new Error(`Realtime SDP exchange failed: ${sdpResponse.status} ${text.slice(0, 200)}`);
    events.error?.(err);
    peer.close();
    throw err;
  }

  const answerSdp = await sdpResponse.text();
  await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
      drainTimers.forEach(clearTimeout);
      drainTimers.clear();
      events.close?.(peer.connectionState);
    }
  };

  return {
    peer,
    dataChannel,
    micTrack,
    setMuted(muted) {
      if (micTrack) micTrack.enabled = !muted;
    },
    sendDataChannel(payload) {
      if (dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify(payload));
      }
    },
    hangup() {
      drainTimers.forEach(clearTimeout);
      drainTimers.clear();
      try { dataChannel.close(); } catch {}
      try { peer.close(); } catch {}
      micStream.getTracks().forEach(t => t.stop());
      events.close?.('user_hangup');
    },
  };
}

// How long to wait after the server signals audio completion before flushing the
// persona transcript. Three events can trigger this (`response.output_audio.done`,
// `output_audio_buffer.stopped`, `response.done`) — all fire when the server stops
// streaming audio bytes, but the WebRTC jitter/playback buffer still holds
// ~100–400 ms of audio. This margin lets the rep hear the persona finish before
// the suggester pipeline fires.
// Note: this delay also runs on barge-in/cancellation — the transcript flushes
// after AUDIO_DRAIN_MS even when the persona was interrupted mid-sentence.
// hangup() cancels in-flight timers so the suggester never fires post-call.
const AUDIO_DRAIN_MS = 600;

// Translate OpenAI Realtime data-channel events into our wire types.
function routeEvent(
  payload: { type?: string } & Record<string, unknown>,
  events: Partial<RealtimeEvents>,
  pendingPersonaFinal: Map<string, { text: string; itemId: string }>,
  drainTimers: Set<ReturnType<typeof setTimeout>>,
): void {
  const type = payload.type;
  if (typeof type !== 'string') return;

  // Persona text generation finished. Stash it — do NOT mark final yet, because
  // the audio for this turn is still streaming/playing. The suggester pipeline
  // gates on isFinal, so flushing here would fire suggestions before the rep
  // has heard the persona finish.
  if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
    const responseId = String(payload.response_id ?? payload.item_id ?? `p-${Date.now()}`);
    const itemId = String(payload.item_id ?? payload.response_id ?? `p-${Date.now()}`);
    pendingPersonaFinal.set(responseId, { text: String(payload.transcript ?? ''), itemId });
    return;
  }

  // Audio for this assistant turn has finished streaming from the server.
  // This also fires on cancellation (barge-in), so the buffered transcript
  // still flushes — possibly truncated, which is the correct behavior.
  if (
    type === 'response.output_audio.done' ||
    type === 'output_audio_buffer.stopped' ||
    type === 'response.done'
  ) {
    const responseId = String(
      payload.response_id ??
      (payload.response as { id?: string } | undefined)?.id ??
      '',
    );
    const entry = responseId
      ? pendingPersonaFinal.get(responseId)
      : pendingPersonaFinal.values().next().value;
    if (entry) {
      const key = responseId || [...pendingPersonaFinal.keys()][0]!;
      pendingPersonaFinal.delete(key);
      const timer = setTimeout(() => {
        drainTimers.delete(timer);
        events.transcript?.({
          type: 'transcript',
          speaker: 'persona',
          text: entry.text,
          itemId: entry.itemId,
          isFinal: true,
          timestampMs: Date.now(),
        });
      }, AUDIO_DRAIN_MS);
      drainTimers.add(timer);
    }
    return;
  }

  // Inbound persona transcript (delta) — we ignore for the coach pipeline (final only),
  // but a future version could stream partial UI hints.
  if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
    events.transcript?.({
      type: 'transcript',
      speaker: 'persona',
      text: String(payload.delta ?? ''),
      itemId: String(payload.item_id ?? `p-${Date.now()}`),
      isFinal: false,
      timestampMs: Date.now(),
    });
    return;
  }

  // Outbound rep transcript (Whisper-1 transcribes mic).
  if (type === 'conversation.item.input_audio_transcription.completed') {
    events.transcript?.({
      type: 'transcript',
      speaker: 'rep',
      text: String(payload.transcript ?? ''),
      itemId: String(payload.item_id ?? `r-${Date.now()}`),
      isFinal: true,
      timestampMs: Date.now(),
    });
    return;
  }

  // Persona invoked a tool (end_call, book_demo).
  if (type === 'response.function_call_arguments.done') {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(payload.arguments ?? '{}'));
    } catch {
      args = {};
    }
    events.personaToolCall?.({
      type: 'persona.tool_call',
      name: String(payload.name ?? 'unknown'),
      args,
      callId: String(payload.call_id ?? payload.response_id ?? `c-${Date.now()}`),
    });
    return;
  }

  if (type === 'error') {
    events.error?.(new Error(String((payload as { message?: string }).message ?? 'realtime_error')));
    return;
  }
}
