'use client';

import posthog from 'posthog-js';
import { PostHogProvider as PHProvider, usePostHog } from 'posthog-js/react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, Suspense } from 'react';

// Analytics are optional: without a token the app runs with PostHog disabled.
const POSTHOG_TOKEN = process.env.NEXT_PUBLIC_POSTHOG_TOKEN;

if (typeof window !== 'undefined' && POSTHOG_TOKEN) {
  posthog.init(POSTHOG_TOKEN, {
    api_host: '/ingest',
    ui_host: 'https://us.posthog.com',
    defaults: '2026-01-30',
    capture_pageview: false,
    capture_pageleave: true,
  });
  posthog.register({ app: 'atlas' });
}

function PageViewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ph = usePostHog();

  useEffect(() => {
    if (pathname && ph) {
      const url = searchParams?.size
        ? `${pathname}?${searchParams.toString()}`
        : pathname;
      ph.capture('$pageview', { $current_url: url });
    }
  }, [pathname, searchParams, ph]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PageViewTracker />
      </Suspense>
      {children}
    </PHProvider>
  );
}
