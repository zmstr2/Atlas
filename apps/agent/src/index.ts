import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { demoRoutes } from './routes/demo';
import { realtimeRoutes } from './realtime/session';
import { chatRoutes } from './routes/chat';
import { ingestRoutes } from './routes/ingest';
import { coachWebSocketHandler, type CoachWebSocketData } from './coach/ws';

const app = new Hono();

// CORS:
//   - Web demo origin (apps/web on Vercel) is allowed via WEB_ORIGIN.
//   - Tauri's webview uses tauri://localhost on macOS and https://tauri.localhost
//     on Windows — both are file/internal origins that bypass typical CORS,
//     but we whitelist explicitly in case the desktop frontend ever proxies
//     through fetch with credentials.
const allowedOrigins = [
  process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  'tauri://localhost',
  'https://tauri.localhost',
];

app.use('*', cors({
  origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Call-Id'],
}));

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
