// Single source of truth for the agent URL. next.config.mjs guarantees this is
// set for production builds, so the localhost fallback only applies to `next dev`.
export const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://localhost:3001';

// Hard cap on a live voice call. The server can't cut a WebRTC call that goes
// straight to OpenAI, so the client hangs up for it.
export const MAX_CALL_MS = 5 * 60 * 1000;
