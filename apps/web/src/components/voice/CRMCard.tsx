'use client';
import type { Lead, Company, Contact } from '@atlas/types';

export function LeadResultCard({ lead }: { lead: Lead }) {
  return (
    <div className="rounded-lg border border-accent/30 bg-accent-soft/40 p-3 my-2 space-y-2">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="font-semibold text-fg-primary text-sm">{lead.name}</div>
          <div className="text-xs text-fg-secondary">{lead.title}</div>
        </div>
        <div className="text-xs font-mono text-accent">{(lead.leadScore * 100).toFixed(0)}%</div>
      </div>
      {lead.notes && (
        <div className="text-xs text-fg-secondary italic">{lead.notes}</div>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-fg-muted hover:text-fg-secondary">Scoring signals</summary>
        <ul className="mt-1 space-y-0.5">
          {lead.scoringSignals.map(s => (
            <li key={s.signal} className="flex justify-between">
              <span className="text-fg-secondary">{s.signal}</span>
              <span className="text-fg-muted font-mono">{s.weight.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

const ROLE_LABEL: Record<Contact['role'], string> = {
  economic_buyer: 'Economic Buyer',
  champion: 'Champion',
  influencer: 'Influencer',
  user: 'User',
  blocker: 'Blocker',
  unknown: 'Unknown',
};

const ROLE_COLOR: Record<Contact['role'], string> = {
  economic_buyer: 'bg-qual-authority/15 text-qual-authority border-qual-authority/30',
  champion: 'bg-signal-positive/15 text-signal-positive border-signal-positive/30',
  influencer: 'bg-qual-need/15 text-qual-need border-qual-need/30',
  user: 'bg-fg-muted/15 text-fg-secondary border-border',
  blocker: 'bg-signal-negative/15 text-signal-negative border-signal-negative/30',
  unknown: 'bg-bg-muted text-fg-muted border-border',
};

export function CompanyResultCard({ company }: { company: Company }) {
  return (
    <div className="rounded-lg border border-accent/30 bg-accent-soft/40 p-3 my-2 space-y-2">
      <div>
        <div className="font-semibold text-fg-primary text-sm">{company.name}</div>
        <div className="text-xs text-fg-secondary">
          {company.industry} · {company.employees} {company.fundingStage ? `· ${company.fundingStage}` : ''}
        </div>
      </div>

      {company.fitSignals.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-fg-muted font-medium mb-1">Fit signals</div>
          <ul className="text-xs space-y-0.5 text-fg-secondary">
            {company.fitSignals.map(s => <li key={s}>· {s}</li>)}
          </ul>
        </div>
      )}

      {company.contacts.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-fg-muted font-medium mb-1">Org chart</div>
          <div className="space-y-1.5">
            {company.contacts.map(c => (
              <div key={c.id} className="flex items-baseline gap-2 text-xs">
                <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${ROLE_COLOR[c.role]}`}>
                  {ROLE_LABEL[c.role]}
                </span>
                <span className="text-fg-primary font-medium">{c.name}</span>
                <span className="text-fg-muted">·</span>
                <span className="text-fg-secondary">{c.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-fg-muted hover:text-fg-secondary">Recent activity & tech stack</summary>
        <div className="mt-1 space-y-1 text-fg-secondary">
          <div className="text-fg-muted text-[10px] uppercase tracking-wide font-medium">Tech</div>
          <div>{company.techStack.join(' · ')}</div>
          <div className="text-fg-muted text-[10px] uppercase tracking-wide font-medium pt-1">Activity</div>
          <ul className="space-y-0.5">
            {company.recentActivity.map(a => (
              <li key={a.date}><span className="font-mono text-[10px] text-fg-muted">{a.date}</span> · {a.summary}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

export function ContactResultCard({ contact }: { contact: Contact }) {
  return (
    <div className="rounded-lg border border-accent/30 bg-accent-soft/40 p-3 my-2">
      <div className="flex items-baseline gap-2 mb-1">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${ROLE_COLOR[contact.role]}`}>
          {ROLE_LABEL[contact.role]}
        </span>
        <span className="text-fg-primary font-semibold text-sm">{contact.name}</span>
      </div>
      <div className="text-xs text-fg-secondary">{contact.title}</div>
      {contact.notes && <div className="text-xs text-fg-secondary italic mt-1">{contact.notes}</div>}
    </div>
  );
}

export function ToolErrorCard({ error, detail }: { error: string; detail?: unknown }) {
  return (
    <div className="rounded-lg border border-signal-negative/30 bg-signal-negative/5 p-2 my-2 text-xs text-signal-negative">
      <div className="font-medium">{error}</div>
      {detail !== undefined && (
        <pre className="text-fg-muted mt-1 text-[10px] overflow-x-auto">
          {JSON.stringify(detail, null, 2)}
        </pre>
      )}
    </div>
  );
}
