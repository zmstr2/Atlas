'use client';
import { useState } from 'react';
import posthog from 'posthog-js';

export function PostCallRating({
  personaName,
  leftUnasked = [],
  onDone,
}: {
  personaName: string;
  /** Questions Atlas suggested that were never asked or answered on the call. */
  leftUnasked?: string[];
  onDone: () => void;
}) {
  const [hovered, setHovered] = useState(0);
  const [selected, setSelected] = useState(0);
  const [submitted, setSubmitted] = useState(false);

  const active = hovered || selected;

  const handleSubmit = () => {
    posthog.capture('call_rated', { rating: selected, persona_name: personaName });
    setSubmitted(true);
    setTimeout(onDone, 1200);
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-bg-base flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="text-4xl">✓</div>
          <p className="text-fg-secondary text-sm">Thanks for the feedback</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center px-6">
      <div className="max-w-sm w-full text-center space-y-8">
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-widest text-fg-muted font-semibold">
            Session complete
          </div>
          <h1 className="text-2xl font-semibold text-fg-primary leading-snug">
            How did your call with {personaName} go?
          </h1>
          <p className="text-fg-secondary text-sm">
            Ratings help Atlas improve.
          </p>
        </div>

        {leftUnasked.length > 0 && (
          <section aria-label="Left unasked" className="rounded-xl bg-accent-soft px-4 py-3 text-left">
            <h2 className="text-xs font-semibold text-accent">Left unasked</h2>
            <ul className="mt-1.5 space-y-1.5">
              {leftUnasked.map((q) => (
                <li key={q} className="text-sm leading-snug text-fg-primary text-pretty">{q}</li>
              ))}
            </ul>
          </section>
        )}

        <div
          className="flex justify-center gap-3"
          onMouseLeave={() => setHovered(0)}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onMouseEnter={() => setHovered(n)}
              onClick={() => setSelected(n)}
              className="transition-transform hover:scale-110 focus:outline-none"
              aria-label={`${n} star`}
            >
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill={n <= active ? '#8B6FE8' : 'none'}
                stroke={n <= active ? '#8B6FE8' : '#C4B5FD'}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </button>
          ))}
        </div>

        <button
          onClick={handleSubmit}
          disabled={selected === 0}
          className="w-full py-3 rounded-xl bg-accent text-white font-semibold text-sm disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition"
        >
          Submit
        </button>

        <button
          onClick={() => { posthog.capture('call_rating_skipped', { persona_name: personaName }); onDone(); }}
          className="text-fg-muted text-xs hover:text-fg-secondary transition"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
