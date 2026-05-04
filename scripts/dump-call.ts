#!/usr/bin/env bun
/**
 * Dump a call's interleaved transcript + suggestions as Markdown.
 *
 * Usage:
 *   bun scripts/dump-call.ts <callId>
 *
 * Output goes to stdout. Pipe to a file for sharing:
 *   bun scripts/dump-call.ts abc123 > /tmp/call.md
 */

import { loadCallLog } from '../apps/agent/src/db/sqlite';

const callId = process.argv[2];
if (!callId) {
  console.error('usage: bun scripts/dump-call.ts <callId>');
  process.exit(1);
}

const { utterances, suggestions } = loadCallLog(callId);

if (utterances.length === 0) {
  console.error(`No utterances found for call_id="${callId}".`);
  process.exit(2);
}

const suggestionsByUtt = new Map<string, typeof suggestions>();
for (const s of suggestions) {
  const arr = suggestionsByUtt.get(s.utterance_id) ?? [];
  arr.push(s);
  suggestionsByUtt.set(s.utterance_id, arr);
}

const fired = suggestions.filter(s => s.suppressed === 0).length;
const suppressed = suggestions.filter(s => s.suppressed === 1).length;

console.log(`# Call \`${callId}\``);
console.log('');
console.log(`Utterances: **${utterances.length}** · Suggestions fired: **${fired}** · Suppressed: **${suppressed}**`);
console.log('');
console.log('---');
console.log('');

for (const u of utterances) {
  const speaker = u.speaker.toUpperCase();
  console.log(`**[${u.id}] ${speaker}:** ${u.text}`);
  for (const s of suggestionsByUtt.get(u.id) ?? []) {
    const tag = s.suppressed === 1 ? '~~SUPPRESSED~~' : '**FIRED**';
    const md = s.markdown.replace(/\n/g, ' ').trim();
    console.log(`  - ${tag} \`${s.agent}\` [${s.priority}/${s.play}] — ${md}`);
    if (s.reasoning) {
      const r = s.reasoning.replace(/\n/g, ' ').trim();
      console.log(`    _reasoning:_ ${r}`);
    }
  }
  console.log('');
}
