'use client';

// TODO: wire to backend signal — these values should come from a real-time
// scoring stream that watches the transcript and updates as the call
// progresses. For now this card is a static placeholder so the rep
// understands where call-quality feedback will live.
const PLACEHOLDER = {
  coveredAreas: 3,
  totalAreas: 5,
  status: 'On track',
  focusNext: ['Budget', 'Timeline'] as const,
};

export function CallProgressCard() {
  const { coveredAreas, totalAreas, status, focusNext } = PLACEHOLDER;

  return (
    <div className="rounded-xl border border-border bg-bg-elevated p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold">
          Discovery progress
        </div>
        <div className="text-xs text-fg-secondary tabular-nums">
          {coveredAreas}/{totalAreas}
        </div>
      </div>

      <div className="flex gap-1" aria-hidden="true">
        {Array.from({ length: totalAreas }).map((_, i) => (
          <div
            key={i}
            className={`flex-1 h-1.5 rounded-full ${
              i < coveredAreas ? 'bg-accent' : 'bg-bg-muted'
            }`}
          />
        ))}
      </div>

      <div className="text-xs text-fg-secondary">{status}</div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-fg-muted font-medium">
          Focus next
        </span>
        {focusNext.map(label => (
          <span
            key={label}
            className="rounded-full px-2 py-0.5 bg-bg-subtle text-xs text-fg-secondary border border-border"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
