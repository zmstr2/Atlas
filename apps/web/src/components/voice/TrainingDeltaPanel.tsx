'use client';
import type { Verdict, TrainingDelta } from '@atlas/types';

export function TrainingDeltaPanel({ verdict, trainingDelta }: { verdict: unknown; trainingDelta: unknown }) {
  const v = verdict as Partial<Verdict> | null;
  const td = trainingDelta as Partial<TrainingDelta> | null;
  if (!v || !td) return null;

  const outcomeColor =
    v.outcome === 'qualified' ? 'bg-signal-positive/15 text-signal-positive border-signal-positive/30' :
    v.outcome === 'not_qualified' ? 'bg-signal-negative/15 text-signal-negative border-signal-negative/30' :
    'bg-qual-timeline/15 text-qual-timeline border-qual-timeline/30';

  return (
    <div className="rounded-xl border border-border bg-bg-elevated p-4 space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-fg-muted font-medium mb-2">Verdict</div>
        <div className={`inline-block px-2 py-1 rounded border text-xs font-medium ${outcomeColor}`}>
          {(v.outcome ?? 'unknown').replace('_', ' ')}
        </div>
        {v.reasoning && (
          <p className="text-xs text-fg-secondary mt-2 leading-relaxed">{v.reasoning}</p>
        )}
      </div>

      {td.objectionLanguage && td.objectionLanguage.length > 0 && (
        <Section title="Objection language">
          {td.objectionLanguage.map((o, i) => (
            <div key={i} className="text-xs space-y-0.5 border-l-2 border-signal-negative/40 pl-2">
              <div className="text-fg-primary italic">"{o.verbatim}"</div>
              <div className="text-fg-muted">→ {o.avaRecommendation}</div>
            </div>
          ))}
        </Section>
      )}

      {td.valuePropResonance && td.valuePropResonance.length > 0 && (
        <Section title="Value-prop resonance">
          {td.valuePropResonance.map((vp, i) => (
            <div key={i} className="text-xs flex items-baseline gap-2">
              <span className={`text-[10px] font-medium uppercase tracking-wide ${vp.direction === 'engaged' ? 'text-signal-positive' : 'text-fg-muted'}`}>
                {vp.direction}
              </span>
              <span className="text-fg-primary">{vp.prop}</span>
            </div>
          ))}
        </Section>
      )}

      {td.decisionGeography && td.decisionGeography.length > 0 && (
        <Section title="Decision geography">
          {td.decisionGeography.map((d, i) => (
            <div key={i} className="text-xs">
              <span className="font-medium text-fg-primary">{d.name}</span>
              <span className="text-fg-muted"> · {d.role}</span>
              <span className="text-fg-secondary"> · {d.sentiment}</span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-fg-muted font-medium mb-1.5">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
