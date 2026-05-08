/**
 * One-command dev orchestrator: starts the agent, desktop shell, and web
 * demo in parallel with prefixed output. Ctrl-C kills all children cleanly.
 *
 * Usage:
 *   bun run dev          (alias from package.json)
 *   bun run scripts/dev-all.ts --no-web      # skip web demo
 *   bun run scripts/dev-all.ts --no-desktop  # agent + web only
 */

const args = new Set(process.argv.slice(2));
const skip = {
  agent: args.has('--no-agent'),
  desktop: args.has('--no-desktop'),
  web: args.has('--no-web'),
};

type Child = {
  label: string;
  color: string;
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
};

// ANSI 256-color foreground codes — distinguishable on light + dark terminals.
const children: Child[] = [
  {
    label: 'agent  ',
    color: '\x1b[38;5;39m', // cyan-blue
    cmd: ['bun', 'run', '--filter=@atlas/agent', 'dev'],
    enabled: !skip.agent,
  },
  {
    label: 'desktop',
    color: '\x1b[38;5;213m', // pink
    cmd: ['bun', 'run', '--filter=@atlas/desktop', 'tauri:dev'],
    // The Tauri Rust core reads ATLAS_AGENT_URL at runtime; default it to the
    // local agent so the desktop app talks to localhost in dev.
    env: { ATLAS_AGENT_URL: process.env.ATLAS_AGENT_URL ?? 'http://127.0.0.1:3001' },
    enabled: !skip.desktop,
  },
  {
    label: 'web    ',
    color: '\x1b[38;5;156m', // green
    cmd: ['bun', 'run', '--filter=@atlas/web', 'dev'],
    enabled: !skip.web,
  },
];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function prefix(c: Child): string {
  return `${c.color}[${c.label}]${RESET} `;
}

async function pipeStream(stream: ReadableStream<Uint8Array>, c: Child, isErr = false) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length === 0) continue;
      const tag = isErr ? `${DIM}stderr${RESET} ` : '';
      process.stdout.write(`${prefix(c)}${tag}${line}\n`);
    }
  }
  if (buffer.length > 0) {
    process.stdout.write(`${prefix(c)}${buffer}\n`);
  }
}

const controller = new AbortController();
const procs: Bun.Subprocess[] = [];

let shuttingDown = false;
function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${DIM}[dev-all] ${reason} — shutting down children${RESET}\n`);
  controller.abort();
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      // already dead
    }
  }
  // Give children a moment to flush, then exit.
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const enabled = children.filter((c) => c.enabled);
if (enabled.length === 0) {
  console.error('[dev-all] every component disabled — nothing to run');
  process.exit(1);
}

process.stdout.write(
  `${DIM}[dev-all] starting ${enabled.map((c) => c.label.trim()).join(', ')}${RESET}\n`,
);

for (const c of enabled) {
  const proc = Bun.spawn(c.cmd, {
    cwd: c.cwd,
    env: { ...process.env, ...c.env, FORCE_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    signal: controller.signal,
  });
  procs.push(proc);
  void pipeStream(proc.stdout, c, false);
  void pipeStream(proc.stderr, c, true);
  void proc.exited.then((code) => {
    if (shuttingDown) return;
    process.stdout.write(
      `${prefix(c)}${DIM}exited with code ${code} — tearing down siblings${RESET}\n`,
    );
    shutdown(`${c.label.trim()} exited`);
  });
}
