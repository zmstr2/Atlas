import { z } from 'zod';

export const ContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  role: z.enum(['economic_buyer', 'champion', 'influencer', 'user', 'blocker', 'unknown']),
  notes: z.string().optional(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().optional(),
  industry: z.string(),
  employees: z.string(),
  fundingStage: z.string().optional(),
  techStack: z.array(z.string()),
  recentActivity: z.array(z.object({
    date: z.string(),
    summary: z.string(),
  })),
  fitSignals: z.array(z.string()),
  contacts: z.array(ContactSchema),
});
export type Company = z.infer<typeof CompanySchema>;

export const LeadSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  email: z.string(),
  companyId: z.string(),
  leadScore: z.number().min(0).max(1),
  scoringSignals: z.array(z.object({
    signal: z.string(),
    weight: z.number(),
  })),
  pastInteractions: z.array(z.object({
    type: z.enum(['email', 'meeting', 'call', 'event']),
    date: z.string(),
    summary: z.string(),
  })),
  notes: z.string().optional(),
});
export type Lead = z.infer<typeof LeadSchema>;

const COMPANIES: readonly Company[] = [
  {
    id: 'midco',
    name: 'MidCo',
    domain: 'midco.example',
    industry: 'B2B SaaS — workflow automation',
    employees: '50-200',
    fundingStage: 'Series B ($24M, Jan 2026)',
    techStack: ['HubSpot', 'Salesloft', 'Outreach', 'Gong', 'Snowflake'],
    recentActivity: [
      { date: '2026-04-02', summary: 'Posted on LinkedIn about scaling outbound without headcount.' },
      { date: '2026-03-18', summary: 'Closed Series B led by Index Ventures.' },
      { date: '2026-02-10', summary: 'Hired new VP RevOps (Marcus Liu, ex-Gong).' },
    ],
    fitSignals: [
      'Uses HubSpot (native integration target)',
      'Recent funding — budget cycle open',
      'VP RevOps recently hired — known org-design buyer',
      '50-200 person band — Atlas sweet spot',
    ],
    contacts: [
      { id: 'jordan-hayes', name: 'Jordan Hayes', title: 'VP Marketing', role: 'champion', notes: 'Owns demand gen. 8 years B2B marketing, VP for 18 months. Frustrated with manual SDR workflow and burned by the 9-month Marketo eval. Genuinely open but scar-tissue skeptical.' },
      { id: 'marcus-liu', name: 'Marcus Liu', title: 'VP RevOps', role: 'economic_buyer', notes: 'Ex-Gong, knows the AI-for-sales space cold. Final approver on tooling >$50k ARR.' },
      { id: 'priya-shah', name: 'Priya Shah', title: 'Director of Sales', role: 'influencer', notes: 'Pushed back on prior AI tooling pilot in 2025 — concerned about rep adoption.' },
      { id: 'tom-reyes', name: 'Tom Reyes', title: 'Director of Sales Operations', role: 'user', notes: 'Day-to-day operator, owns Salesforce hygiene.' },
    ],
  },
  {
    id: 'earlyco',
    name: 'EarlyCo',
    domain: 'earlyco.example',
    industry: 'B2B SaaS — developer tools',
    employees: '15-50',
    fundingStage: 'Series A ($8M, Feb 2026)',
    techStack: ['HubSpot', 'Apollo', 'Lemlist'],
    recentActivity: [
      { date: '2026-04-15', summary: 'Hired first dedicated SDR.' },
      { date: '2026-02-22', summary: 'Closed Series A led by Bain Capital Ventures.' },
    ],
    fitSignals: [
      'Series A — early in budget formation',
      'Small team (only 1-2 SDRs) — Atlas value harder to justify until scale',
      'Founder-led sales still dominant',
    ],
    contacts: [
      { id: 'sarah-park', name: 'Sarah Park', title: 'Head of Growth', role: 'champion', notes: 'Reports to CEO. Owns pipeline number but no formal sales infra budget yet.' },
      { id: 'james-okafor', name: 'James Okafor', title: 'CEO & Co-Founder', role: 'economic_buyer', notes: 'Final say on any spend >$25k. Generally bearish on tooling pre-PMF.' },
    ],
  },
  {
    id: 'midco-corp',
    name: 'MidCo Corp',
    domain: 'midcocorp.example',
    industry: 'Logistics SaaS',
    employees: '100-250',
    fundingStage: 'Series C ($65M, 2024)',
    techStack: ['Salesforce', 'Outreach', 'Gong', 'LinkedIn Sales Navigator'],
    recentActivity: [
      { date: '2026-04-08', summary: 'Tom Reyes posted on LinkedIn about SDR ramp time being too long.' },
      { date: '2026-03-30', summary: 'Q1 board update mentioned outbound efficiency as a focus area.' },
    ],
    fitSignals: [
      'Salesforce-native shop — Atlas integrates cleanly',
      'Public statements about SDR efficiency = stated pain',
      '100-250 employees — Atlas sweet spot',
      'Sales Ops (Tom) is on the call but VP Sales is the real decider',
    ],
    contacts: [
      { id: 'tom-reyes-corp', name: 'Tom Reyes', title: 'Director of Sales Operations', role: 'champion', notes: 'On the call. Owns tooling evaluation but not budget.' },
      { id: 'rachel-kim', name: 'Rachel Kim', title: 'VP Sales', role: 'economic_buyer', notes: 'Not on the call. Final approver. Tom needs to bring her in for any deal to close.' },
      { id: 'derek-walsh', name: 'Derek Walsh', title: 'CRO', role: 'economic_buyer', notes: 'Above Rachel. Only involved on >$200k ARR commitments.' },
    ],
  },
  {
    id: 'drift-labs',
    name: 'Drift Labs',
    domain: 'driftlabs.dev',
    industry: 'AI dev tools — eval infrastructure for agents',
    employees: '2 (cofounders)',
    fundingStage: 'Pre-seed ($400K F&F + angels, 6 months ago)',
    techStack: ['TypeScript', 'Postgres', 'OpenAI', 'Anthropic', 'Vercel'],
    recentActivity: [
      { date: '2026-04-28', summary: 'Mia posted a thread on agent eval frameworks that picked up traction with YC alums.' },
      { date: '2026-04-10', summary: 'Hit $40K MRR with 50 paying users, growing ~30% MoM (mostly inbound).' },
      { date: '2026-03-22', summary: 'Bedrock floated a $1.5M @ $10M post pre-seed term sheet (active, not signed).' },
    ],
    fitSignals: [
      'Strong vertical fit (AI dev tools is a YC sweet spot)',
      'Cofounder pair, both ex-Stripe — execution credibility',
      'Real revenue ($40K MRR) but still pre-seed by valuation',
      '8 months runway — decision-forcing window',
    ],
    contacts: [
      { id: 'mia-chen', name: 'Mia Chen', title: 'Cofounder & CTO', role: 'champion', notes: 'Technical cofounder, ex-Stripe payments infra (3 years). Decisive, low-bullshit, respects specifics. The one taking this call.' },
      { id: 'sam-park', name: 'Sam Park', title: 'Cofounder & Head of Design', role: 'economic_buyer', notes: 'Design-led cofounder, ex-Stripe dashboard team. Skeptical of accelerators — thinks Drift is past the right stage. Mia will not move without him.' },
    ],
  },
] as const;

const LEADS: readonly Lead[] = [
  {
    id: 'jordan-hayes',
    name: 'Jordan Hayes',
    title: 'VP Marketing',
    email: 'jordan@midco.example',
    companyId: 'midco',
    leadScore: 0.62,
    scoringSignals: [
      { signal: 'VP Marketing title', weight: 0.35 },
      { signal: 'Uses HubSpot + Salesloft', weight: 0.25 },
      { signal: '130-person company (Atlas sweet spot)', weight: 0.15 },
      { signal: 'Recent Series B ($24M, Index Ventures)', weight: 0.15 },
      { signal: 'Posted about scaling outbound without headcount on LinkedIn', weight: 0.10 },
    ],
    pastInteractions: [
      { type: 'email', date: '2026-04-14', summary: 'Cold outbound re: AI outbound sequences. Opened twice, no reply.' },
      { type: 'email', date: '2026-04-22', summary: 'Follow-up referencing LinkedIn post about outbound scale. Jordan clicked the workflow automation case study link.' },
    ],
    notes: 'Owns demand gen. Champion, not economic buyer — Marcus Liu (VP RevOps, ex-Gong) is final approver above ~$120k. Board update in July creates real timeline pressure. Burned by 9-month Marketo eval. Salesloft workflows owned by Priya Shah (demand gen manager) — she has veto on tooling changes there.',
  },
  {
    id: 'sarah-park',
    name: 'Sarah Park',
    title: 'Head of Growth',
    email: 'sarah@earlyco.example',
    companyId: 'earlyco',
    leadScore: 0.58,
    scoringSignals: [
      { signal: 'Head of Growth title', weight: 0.30 },
      { signal: 'Recent Series A ($8M)', weight: 0.35 },
      { signal: 'B2B SaaS', weight: 0.20 },
      { signal: 'Follows AI thought leaders on LinkedIn', weight: 0.15 },
    ],
    pastInteractions: [
      { type: 'email', date: '2026-04-18', summary: 'Cold outbound re: AI-powered sequences. Opened once.' },
    ],
    notes: 'Likely qualify-out: company too small for Atlas pricing, no formal sales infra budget yet.',
  },
  {
    id: 'tom-reyes',
    name: 'Tom Reyes',
    title: 'Director of Sales Operations',
    email: 'tom@midcocorp.example',
    companyId: 'midco-corp',
    leadScore: 0.55,
    scoringSignals: [
      { signal: 'Sales Operations title', weight: 0.25 },
      { signal: '150-person company', weight: 0.20 },
      { signal: 'Uses Salesforce', weight: 0.30 },
      { signal: 'Recent LinkedIn post about SDR efficiency', weight: 0.25 },
    ],
    pastInteractions: [
      { type: 'email', date: '2026-04-20', summary: 'Cold outbound re: SDR productivity. Opened and clicked.' },
    ],
    notes: 'Authority gap: real decision-maker is Rachel Kim (VP Sales), not on the call.',
  },
  {
    id: 'mia-chen',
    name: 'Mia Chen',
    title: 'Cofounder & CTO',
    email: 'mia@driftlabs.dev',
    companyId: 'drift-labs',
    leadScore: 0.78,
    scoringSignals: [
      { signal: 'Ex-Stripe (Payments Infra, 3 years)', weight: 0.30 },
      { signal: 'Working product with $40K MRR + 50 paying users', weight: 0.25 },
      { signal: 'AI dev tools — strong YC vertical fit', weight: 0.20 },
      { signal: 'Cofounder pair (technical + design)', weight: 0.15 },
      { signal: 'Posted thoughtful thread on agent eval frameworks', weight: 0.10 },
    ],
    pastInteractions: [
      { type: 'email', date: '2026-04-30', summary: 'Cold outreach referencing eval framework thread. Mia replied within an hour.' },
    ],
    notes: 'Pre-seed founder weighing YC ($500K @ ~7%) vs an active Bedrock term sheet ($1.5M @ $10M post). Real decision constraint is cofounder Sam, who is design-led and accelerator-skeptical. Mia will not apply without Sam being convinced — multi-thread early via an alum intro at a comparable stage.',
  },
] as const;

export function lookupLead(id: string): Lead | null {
  return LEADS.find(l => l.id === id) ?? null;
}

export function lookupCompany(id: string): Company | null {
  return COMPANIES.find(c => c.id === id) ?? null;
}

export function lookupCompanyByName(name: string): Company | null {
  const needle = name.trim().toLowerCase();
  return COMPANIES.find(c => c.name.toLowerCase() === needle || c.id === needle) ?? null;
}

export function lookupContact(companyId: string, contactId: string): Contact | null {
  const company = lookupCompany(companyId);
  return company?.contacts.find(c => c.id === contactId) ?? null;
}

export function listLeads(): readonly Lead[] {
  return LEADS;
}

export function listCompanies(): readonly Company[] {
  return COMPANIES;
}
