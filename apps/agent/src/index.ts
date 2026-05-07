import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { demoRoutes } from './routes/demo';
import { realtimeRoutes } from './realtime/session';
import { chatRoutes } from './routes/chat';
import { coachWebSocketHandler, type CoachWebSocketData } from './coach/ws';
import { requireAuth } from './auth/middleware';

const app = new Hono();

app.use('*', cors({
  origin: [
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    'tauri://localhost',
    'http://tauri.localhost',
    'http://localhost:3118',
  ],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['content-type', 'authorization', 'x-call-id'],
}));

// Authenticated, multi-tenant routes. Lane B will register `/calls/*` routes;
// this middleware applies whenever those routes are mounted.
app.use('/calls/*', requireAuth());

// Public, unauthenticated routes (web demo + realtime + chat + health).
app.route('/demo', demoRoutes);
app.route('/realtime', realtimeRoutes);
app.route('/chat', chatRoutes);

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
