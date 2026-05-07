'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

// GitHub Releases hosts the installers. The release.yml workflow attaches
// platform-specific assets to each tagged release. The /latest URL always
// resolves to the most recent published (non-draft, non-prerelease) release.
const RELEASES_BASE =
  process.env.NEXT_PUBLIC_ATLAS_RELEASES_URL ?? 'https://github.com/zmstr2/Atlas/releases';
const LATEST_DOWNLOAD = `${RELEASES_BASE}/latest`;

type DetectedOS = 'mac-arm' | 'mac-intel' | 'windows' | 'linux' | 'unknown';

function detectOS(): DetectedOS {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const platform = navigator.platform ?? '';

  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(platform) && !/Android/i.test(ua)) return 'linux';
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    // Apple Silicon detection is best-effort. Modern Safari on M-series Macs
    // reports "MacIntel" in navigator.platform (Intel-compat layer), so we
    // probe via WebGL renderer hint when possible. If unsure, default to
    // Apple Silicon since that's the majority of new-Mac sales since 2021.
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = debugInfo
        ? gl?.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : '';
      if (typeof renderer === 'string' && /Apple/i.test(renderer)) return 'mac-arm';
      if (typeof renderer === 'string' && /Intel/i.test(renderer)) return 'mac-intel';
    } catch {
      // WebGL access blocked — fall through.
    }
    return 'mac-arm';
  }
  return 'unknown';
}

const DOWNLOADS: Record<Exclude<DetectedOS, 'unknown'>, { label: string; href: string; arch: string }> = {
  // Tauri release assets — exact names depend on the bundle config but
  // these are the standard outputs of `cargo tauri build`. The /latest
  // redirect to the most recent published release surfaces these names
  // with the version baked in.
  'mac-arm': {
    label: 'Mac (Apple Silicon)',
    arch: 'aarch64',
    href: `${LATEST_DOWNLOAD}`,
  },
  'mac-intel': {
    label: 'Mac (Intel)',
    arch: 'x64',
    href: `${LATEST_DOWNLOAD}`,
  },
  windows: {
    label: 'Windows',
    arch: 'x64',
    href: `${LATEST_DOWNLOAD}`,
  },
  linux: {
    label: 'Linux',
    arch: 'AppImage',
    href: `${LATEST_DOWNLOAD}`,
  },
};

export default function MarketingLandingPage() {
  const [detected, setDetected] = useState<DetectedOS>('unknown');

  useEffect(() => {
    setDetected(detectOS());
  }, []);

  const primary = detected !== 'unknown' ? DOWNLOADS[detected] : null;

  return (
    <main className="min-h-screen bg-bg-base text-fg-primary">
      <div className="max-w-4xl mx-auto px-6 py-16">
        {/* Hero */}
        <header className="mb-16">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-accent mb-4">
            Atlas
          </div>
          <h1 className="font-display text-5xl md:text-6xl leading-[1.05] mb-6 max-w-3xl">
            Live coaching for founder-led sales calls.
          </h1>
          <p className="text-fg-secondary text-lg max-w-xl mb-8 leading-relaxed">
            Atlas listens to your sales calls in real time, surfaces the moves
            you're missing, and gives you a coaching artifact afterward.
            Audio stays on your machine.
          </p>

          {/* Primary download CTA */}
          <div className="flex flex-col sm:flex-row gap-3 items-start">
            {primary ? (
              <a
                href={primary.href}
                className="inline-flex items-center gap-2 px-5 py-3 bg-accent text-white rounded-md hover:bg-accent-hover transition-colors text-sm font-medium"
              >
                Download for {primary.label}
                <span className="text-white/70 text-xs">({primary.arch})</span>
              </a>
            ) : (
              <a
                href={LATEST_DOWNLOAD}
                className="inline-flex items-center gap-2 px-5 py-3 bg-accent text-white rounded-md hover:bg-accent-hover transition-colors text-sm font-medium"
              >
                Download Atlas
              </a>
            )}
            <Link
              href="/practice"
              className="inline-flex items-center gap-2 px-5 py-3 bg-bg-elevated border border-border rounded-md hover:border-accent/50 transition-colors text-sm font-medium text-fg-primary"
            >
              Try the practice mode →
            </Link>
          </div>

          {/* Other-platform downloads */}
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-muted">
            {Object.entries(DOWNLOADS)
              .filter(([k]) => k !== detected)
              .map(([k, d]) => (
                <a
                  key={k}
                  href={d.href}
                  className="hover:text-fg-secondary underline-offset-2 hover:underline"
                >
                  {d.label}
                </a>
              ))}
          </div>
        </header>

        {/* What it does */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
          <Feature
            title="Live whisper"
            body="Atlas streams suggestions during the call — the exact question to ask next, the objection you didn't address, the buying signal you're about to miss."
          />
          <Feature
            title="Multiparty diarization"
            body="Tracks every speaker on the call independently. Label them as Founder, Customer, Colleague, or Other — Atlas treats each side accordingly."
          />
          <Feature
            title="Coaching artifact"
            body="After the call, get a structured breakdown: what worked, what to improve, verbatim moments to study, and a draft follow-up email."
          />
        </section>

        {/* Privacy story */}
        <section className="border border-border rounded-md bg-bg-elevated p-8 mb-16">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted mb-3">
            Audio stays on your device
          </h2>
          <p className="text-fg-secondary text-sm leading-relaxed max-w-2xl">
            Atlas captures system audio + microphone locally and runs Whisper
            on-device for transcription. Only utterance text reaches the cloud,
            where the coaching agents process it and send suggestions back. No
            audio recordings leave your machine.
          </p>
        </section>

        {/* Practice mode CTA */}
        <section className="text-center py-12 border-t border-border">
          <h2 className="font-display text-2xl mb-2">Want to try without installing?</h2>
          <p className="text-fg-secondary text-sm mb-6 max-w-md mx-auto">
            Practice mode pairs you with an AI customer so you can rehearse a
            sales call right in the browser.
          </p>
          <Link
            href="/practice"
            className="inline-flex items-center gap-2 px-5 py-3 bg-accent text-white rounded-md hover:bg-accent-hover transition-colors text-sm font-medium"
          >
            Open practice mode →
          </Link>
        </section>

        {/* Footer */}
        <footer className="mt-16 pt-8 border-t border-border flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-muted">
          <a
            href={RELEASES_BASE}
            className="hover:text-fg-secondary"
            target="_blank"
            rel="noreferrer"
          >
            All releases
          </a>
          <a
            href="https://github.com/zmstr2/Atlas"
            className="hover:text-fg-secondary"
            target="_blank"
            rel="noreferrer"
          >
            Source
          </a>
        </footer>
      </div>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="font-display text-xl mb-2">{title}</h3>
      <p className="text-fg-secondary text-sm leading-relaxed">{body}</p>
    </div>
  );
}
