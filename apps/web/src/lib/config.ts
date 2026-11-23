// Hard cap on a live voice call. The browser talks to OpenAI directly over
// WebRTC, so the server can't cut a call off; the client hangs up instead.
export const MAX_CALL_MS = 5 * 60 * 1000;
