import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { demoRoutes } from './routes/demo';
import { realtimeRoutes } from './realtime/session';
import { chatRoutes } from './routes/chat';
import { ingestRoutes } from './routes/ingest';
import { coachWebSocketHandler, type CoachWebSocketData } from './coach/ws';
import { requireAuth } from './auth/middleware';

const app = new Hono();

// CORS:
//   - Web demo origin (apps/web on Vercel) is allowed via WEB_ORIGIN.
//   - Tauri's webview origins:
//     - macOS:        tauri://localhost
//     - Windows/Linux: http://tauri.localhost
//     - Dev (`tauri:dev`): http://localhost:3118
//   We whitelist explicitly because Tauri webviews issue real CORS preflights
//   for cross-origin fetches to the agent.
const allowedOrigins = [
  process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:3118',
];

app.use('*', cors({
  origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Call-Id', 'content-type', 'authorization', 'x-call-id'],
}));

// Authenticated, multi-tenant routes. Lane B will register `/calls/*` routes;
// this middleware applies whenever those routes are mounted.
app.use('/calls/*', requireAuth());

// Public, unauthenticated routes (web demo + realtime + chat + health).
app.route('/demo', demoRoutes);
app.route('/realtime', realtimeRoutes);
app.route('/chat', chatRoutes);
app.route('/calls', ingestRoutes);

app.get('/health', (c) => c.json({ ok: true }));

const PORT = Number(process.env.PORT ?? 3001);
console.log(`Atlas agent listening on :${PORT}`);

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/coach/ws') {
      const upgraded = server.upgrade(req, { data: { callId: null } as CoachWebSocketData });
      if (upgraded) return undefined;
      return new Response('expected websocket upgrade', { status: 426 });
    }
    return app.fetch(req, { server });
  },
  websocket: coachWebSocketHandler,
});
