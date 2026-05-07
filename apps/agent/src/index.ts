import { app } from './app';
import { coachWebSocketHandler, type CoachWebSocketData } from './coach/ws';

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
