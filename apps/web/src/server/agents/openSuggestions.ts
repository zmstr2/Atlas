/** An earlier suggestion that is still parked in the rep's "Still open" tray. */
export type OpenSuggestion = { id: string; say: string; topic: string };

export function formatOpen(open: OpenSuggestion[]): string {
  if (open.length === 0) return '(none)';
  return open.map((o) => `[${o.id}] (${o.topic || 'general'}) ${o.say}`).join('\n');
}
