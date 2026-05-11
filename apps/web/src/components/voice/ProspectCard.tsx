'use client';
import { lookupLead, lookupCompany } from '@atlas/types';
import type { PersonaId, Contact } from '@atlas/types';

const PERSONA_TO_LEAD: Record<PersonaId, string> = {
  jordan: 'jordan-hayes',
  mia: 'mia-chen',
  pastor: 'pastor-marcus-webb',
  'vp-sales': 'cass-rivera',
};

const ROLE_LABEL: Record<Contact['role'], string> = {
  economic_buyer: 'Economic buyer',
  champion: 'Champion',
  influencer: 'Influencer',
  user: 'User',
  blocker: 'Blocker',
  unknown: '',
};

// Only the two roles that matter mid-call get a dot; the rest are plain muted text.
const ROLE_DOT: Partial<Record<Contact['role'], string>> = {
  economic_buyer: 'bg-accent',
  champion: 'bg-signal-positive',
};

const INTERACTION_ICON: Record<'email' | 'meeting' | 'call' | 'event', string> = {
  email: '✉',
  meeting: '◇',
  call: '☏',
  event: '◉',
};

export function ProspectCard({ personaId }: { personaId: PersonaId }) {
  const lead = lookupLead(PERSONA_TO_LEAD[personaId]);
  const company = lead ? lookupCompany(lead.companyId) : null;

  if (!lead || !company) {
    return (
      <div className="rounded-xl border border-border bg-bg-elevated p-4 text-fg-muted text-sm">
        Prospect data unavailable.
      </div>
    );
  }

  const interactions = lead.pastInteractions.slice(0, 3);
  const fitSignals = company.fitSignals.slice(0, 3);
  const contacts = [...company.contacts]
    .sort((a, b) => roleRank(b.role) - roleRank(a.role))
    .slice(0, 3);

  return (
    <div className="rounded-xl border border-border bg-bg-elevated p-4 space-y-4">
      <div>
        <div className="text-fg-primary font-semibold text-base">{lead.name}</div>
        <div className="text-fg-secondary text-sm">{lead.title}</div>
        <div className="text-fg-muted text-xs mt-0.5">
          {company.name} · {company.industry} · {company.employees} employees
        </div>
      </div>

      {interactions.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold mb-1.5">
            Past interactions
          </div>
          <ul className="space-y-1.5">
            {interactions.map((it, i) => (
              <li key={i} className="text-xs text-fg-secondary flex gap-2">
                <span className="text-fg-muted shrink-0 w-3 text-center" aria-hidden="true">
                  {INTERACTION_ICON[it.type]}
                </span>
                <span className="min-w-0">
                  <span className="text-fg-muted tabular-nums">{it.date}</span>
                  {' — '}
                  {it.summary}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {fitSignals.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold mb-1.5">
            Why this is a fit
          </div>
          <ul className="space-y-1">
            {fitSignals.map((s, i) => (
              <li key={i} className="text-xs text-fg-secondary flex gap-2">
                <span className="text-accent shrink-0" aria-hidden="true">·</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {contacts.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold mb-1.5">
            Key contacts
          </div>
          <ul className="space-y-1.5">
            {contacts.map(c => (
              <li key={c.id} className="text-xs flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="text-fg-primary font-medium">{c.name}</span>
                  <span className="text-fg-muted">{' · '}{c.title}</span>
                </span>
                {ROLE_LABEL[c.role] && (
                  <span className="shrink-0 flex items-center gap-1 text-[10px] text-fg-muted">
                    {ROLE_DOT[c.role] && (
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${ROLE_DOT[c.role]}`} />
                    )}
                    {ROLE_LABEL[c.role]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {company.fundingStage && (
        <div className="text-xs text-fg-muted border-t border-border pt-2">
          <span className="font-medium text-fg-secondary">Funding: </span>
          {company.fundingStage}
        </div>
      )}
    </div>
  );
}

function roleRank(role: Contact['role']): number {
  switch (role) {
    case 'economic_buyer':
      return 5;
    case 'champion':
      return 4;
    case 'influencer':
      return 3;
    case 'user':
      return 2;
    case 'blocker':
      return 1;
    default:
      return 0;
  }
}
