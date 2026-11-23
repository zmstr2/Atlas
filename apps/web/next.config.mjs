import { PHASE_PRODUCTION_BUILD } from 'next/constants.js';

/** @type {(phase: string) => import('next').NextConfig} */
const config = (phase) => {
  // Fail the build instead of shipping a site that tries to reach each
  // visitor's own localhost:3001.
  if (phase === PHASE_PRODUCTION_BUILD && !process.env.NEXT_PUBLIC_AGENT_URL) {
    throw new Error(
      'NEXT_PUBLIC_AGENT_URL is not set. Set it to your deployed agent URL (e.g. https://atlas-agent.up.railway.app).',
    );
  }

  return {
    env: {
      NEXT_PUBLIC_AGENT_URL: process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://localhost:3001',
    },
    async rewrites() {
      return [
        {
          source: '/ingest/static/:path*',
          destination: 'https://us-assets.i.posthog.com/static/:path*',
        },
        {
          source: '/ingest/:path*',
          destination: 'https://us.i.posthog.com/:path*',
        },
      ];
    },
    skipTrailingSlashRedirect: true,
  };
};

export default config;
