import type { PersonaId, PreCallBrief } from '@atlas/types';
import { lookupLead, lookupCompany } from '@atlas/types';
import { renderMemoryMarkdown } from '@/lib/memory/render';
import type { ChatContext } from '@/lib/coach/protocol';
import { getPersona } from '../realtime/personas';
import jordanBrief from '../briefs/jordan-brief.json';
import miaBrief from '../briefs/mia-brief.json';
import pastorBrief from '../briefs/pastor-brief.json';
import vpSalesBrief from '../briefs/vp-sales-brief.json';

export const BRIEFS: Record<PersonaId, PreCallBrief> = {
  jordan: jordanBrief as unknown as PreCallBrief,
  mia: miaBrief as unknown as PreCallBrief,
  pastor: pastorBrief as unknown as PreCallBrief,
  'vp-sales': vpSalesBrief as unknown as PreCallBrief,
};

// Build a context block the chat agent uses to ground its replies.
// Reuses the shared markdown renderer so the chat coach sees the same shape
// as the prospect-suggester and rep-watcher.
export function buildChatContext(ctx: ChatContext): string {
  const persona = getPersona(ctx.personaId);
  const brief = BRIEFS[ctx.personaId];
  const lead = lookupLead(persona.leadId);
  const company = lead ? lookupCompany(lead.companyId) : null;

  const memoryMarkdown = renderMemoryMarkdown({
    memory: ctx.memory,
    hotTail: ctx.hotTail,
    leadName: lead?.name ?? persona.displayName,
    callGoal: brief.callGoal,
  });

  const recentSuggestions = ctx.suggestions.slice(-5).map((s) => `- ${s}`).join('\n');

  return `LEAD: ${lead?.name ?? persona.displayName} (${lead?.title ?? '?'} @ ${company?.name ?? '?'})
COMPANY: ${company?.name ?? '?'} — ${company?.industry ?? ''}, ${company?.employees ?? ''}

${memoryMarkdown}

## Your recent suggestions to rep
${recentSuggestions || '(none)'}`;
}
