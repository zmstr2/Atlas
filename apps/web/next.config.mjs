/** @type {import('next').NextConfig} */
const config = {
  env: {
    NEXT_PUBLIC_AGENT_URL: process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://localhost:3001',
  },
};

export default config;
