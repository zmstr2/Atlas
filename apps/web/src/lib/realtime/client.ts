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

const REALTIME_URL = 'https://api.openai.com/v1/realtime';

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

  dataChannel.onmessage = (msg) => {
    let payload: { type?: string } & Record<string, unknown>;
    try {
      payload = JSON.parse(msg.data);
    } catch {
      return;
    }
    routeEvent(payload, events, pendingPersonaFinal, remoteStream);
  };

  // Offer/answer with OpenAI as the remote peer.
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  const sdpResponse = await fetch(`${REALTIME_URL}?model=${encodeURIComponent(session.model)}`, {
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
      try { dataChannel.close(); } catch {}
      try { peer.close(); } catch {}
      micStream.getTracks().forEach(t => t.stop());
      events.close?.('user_hangup');
    },
  };
}

// Wait until the remote audio stream has been silent for `holdMs`.
// `output_audio_buffer.stopped` fires when OpenAI's server stops sending audio,
// but the browser jitter buffer still has 100-400ms of audio queued. Watching
// the actual playback level lets us flush the transcript when the user has
// truly heard the persona finish — and naturally handles barge-in (silence is
// immediate on cancel). `timeoutMs` is a safety net so the pipeline never stalls.
function waitForRemoteSilence(
  stream: MediaStream,
  { thresholdRms = 0.02, holdMs = 150, timeoutMs = 2000 } = {},
): Promise<void> {
  return new Promise((resolve) => {
    if (stream.getAudioTracks().length === 0) {
      resolve();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      resolve();
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let silentSince: number | null = null;
    let raf = 0;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      try { analyser.disconnect(); } catch {}
      try { source.disconnect(); } catch {}
      try { void ctx.close(); } catch {}
      resolve();
    };
    const deadline = setTimeout(cleanup, timeoutMs);
    const tick = () => {
      if (done) return;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length) / 255;
      const now = performance.now();
      if (rms < thresholdRms) {
        if (silentSince === null) silentSince = now;
        if (now - silentSince >= holdMs) {
          clearTimeout(deadline);
          cleanup();
          return;
        }
      } else {
        silentSince = null;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}

// Translate OpenAI Realtime data-channel events into our wire types.
function routeEvent(
  payload: { type?: string } & Record<string, unknown>,
  events: Partial<RealtimeEvents>,
  pendingPersonaFinal: Map<string, { text: string; itemId: string }>,
  remoteStream: MediaStream,
): void {
  const type = payload.type;
  if (typeof type !== 'string') return;

  // Persona text generation finished. Stash it — do NOT mark final yet, because
  // the audio for this turn is still streaming/playing. The suggester pipeline
  // gates on isFinal, so flushing here would fire suggestions before the rep
  // has heard the prospect finish.
  if (type === 'response.audio_transcript.done') {
    const responseId = String(payload.response_id ?? payload.item_id ?? `p-${Date.now()}`);
    const itemId = String(payload.item_id ?? payload.response_id ?? `p-${Date.now()}`);
    pendingPersonaFinal.set(responseId, { text: String(payload.transcript ?? ''), itemId });
    return;
  }

  // Audio for this assistant turn has finished streaming from the server.
  // This also fires on cancellation (barge-in), so the buffered transcript
  // still flushes — possibly truncated, which is the correct behavior.
  if (type === 'output_audio_buffer.stopped' || type === 'response.done') {
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
      void waitForRemoteSilence(remoteStream).then(() => {
        events.transcript?.({
          type: 'transcript',
          speaker: 'persona',
          text: entry.text,
          itemId: entry.itemId,
          isFinal: true,
          timestampMs: Date.now(),
        });
      });
    }
    return;
  }

  // Inbound persona transcript (delta) — we ignore for the coach pipeline (final only),
  // but a future version could stream partial UI hints.
  if (type === 'response.audio_transcript.delta') {
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

  // Outbound founder transcript (Whisper-1 transcribes mic).
  if (type === 'conversation.item.input_audio_transcription.completed') {
    events.transcript?.({
      type: 'transcript',
      speaker: 'founder',
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
