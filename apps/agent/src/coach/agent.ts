import { streamText, stepCountIs, convertToModelMessages, type UIMessage, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { lookupLead, lookupCompany, lookupCompanyByName, listLeads } from '@atlas/types';
import type { CoachState } from './state';
import { buildChatContext } from './state';

const gateway = createOpenAI({
  baseURL: process.env.VERCEL_AI_GATEWAY_URL ?? 'https://ai-gateway.vercel.sh/v1',
  apiKey: process.env.VERCEL_AI_GATEWAY_TOKEN ?? '',
});

const COACH_MODEL = process.env.COACH_MODEL ?? 'openai/gpt-oss-120b';

const COACH_SYSTEM = `You are Atlas, a real-time sales coaching agent assisting an Artisan AI sales rep during a live discovery call.

You are watching the call as it happens. The rep can ask you questions on the side — about the lead, the company, decision-makers, objection patterns, talk tracks, anything.

# Qualification framework
Track six diagnostic axes from the call: pain, metric, economic buyer, champion, decision process, cost of inaction. Plus BANT: need, budget, authority, timeline.

Push priority (highest-leverage first): need > budget > authority > timeline > champion > metrics > economicBuyer > decisionProcess > decisionCriteria.

When the rep asks tactical questions ("should I push on price?", "are they ready for demo?", "how do I handle the X question?"), reason from the GAP STATE in CURRENT CALL CONTEXT. If an axis is 'confirmed_negative', do not push it. Suggest the cheapest drill that fills the highest-priority gap. Reframe objections via LAER (Listen-Acknowledge-Explore-Respond) — do not defend. When a competitor is named, focus on the gap they leave, not feature shootouts. Bias toward consequence questions ("what's it costing you?") over feature pitch.

# Job in chat
- Answer the rep's questions concisely. 1-3 short paragraphs maximum, with bullets where useful.
- When asked about people or companies, USE the lookup tools — do not make up data.
- Ground your advice in the call's actual exchanges (you have the rendered call context) — never give generic sales coaching.
- If asked "should I push on price?" or similar, weigh the conversation evidence from the BANT/MEDDIC scorecard.
- Be direct. The rep is mid-call — they need a sentence, not a lecture.

When you call a tool, the lookup data renders as an inline card to the rep.

Tone: confident, terse, factual. No filler. No "great question!". You're a peer, not a coach with a clipboard.`;

const tools = {
  lookupLead: {
    description: 'Look up a lead by ID to get their title, company, lead score, scoring signals, and past interactions. Use when rep asks about the prospect or someone mentioned by name.',
    inputSchema: z.object({
      leadId: z.string().describe('Lead ID, e.g. "jordan-hayes", "sarah-park", "tom-reyes".'),
    }),
    execute: async ({ leadId }: { leadId: string }) => {
      const lead = lookupLead(leadId);
      if (!lead) return { error: 'lead_not_found', leadId, available: listLeads().map(l => l.id) };
      return lead;
    },
  },
  lookupCompany: {
    description: 'Look up a company by ID or name to get firmographics, tech stack, recent activity, fit signals, and the full org chart of contacts (including decision-makers).',
    inputSchema: z.object({
      idOrName: z.string().describe('Company ID (e.g. "midco") or display name (e.g. "MidCo").'),
    }),
    execute: async ({ idOrName }: { idOrName: string }) => {
      const company = lookupCompany(idOrName) ?? lookupCompanyByName(idOrName);
      if (!company) return { error: 'company_not_found', idOrName };
      return company;
    },
  },
  findContact: {
    description: 'Find a specific contact at a company by name. Useful when the persona mentions someone (e.g. "Marcus from RevOps") and rep wants context.',
    inputSchema: z.object({
      companyId: z.string(),
      contactName: z.string().describe('Approximate name. Match is fuzzy on first name.'),
    }),
    execute: async ({ companyId, contactName }: { companyId: string; contactName: string }) => {
      const company = lookupCompany(companyId);
      if (!company) return { error: 'company_not_found', companyId };
      const needle = contactName.trim().toLowerCase();
      const match = company.contacts.find(c =>
        c.name.toLowerCase().includes(needle) ||
        c.id.toLowerCase().includes(needle.replace(/\s+/g, '-'))
      );
      if (!match) return { error: 'contact_not_found', contactName, available: company.contacts.map(c => c.name) };
      return match;
    },
  },
};

export type CoachTools = typeof tools;

export async function streamCoachReply(opts: { state: CoachState; messages: UIMessage[] }) {
  const { state, messages } = opts;
  const callContext = buildChatContext(state);

  const system = `${COACH_SYSTEM}

CURRENT CALL CONTEXT:
${callContext}`;

  const modelMessages = await convertToModelMessages(messages);

  return streamText({
    model: gateway(COACH_MODEL) as LanguageModel,
    system,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(8),
  });
}
