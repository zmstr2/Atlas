import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#F7F4ED',
          elevated: '#FFFFFF',
          subtle: '#F1EBDF',
          muted: '#E8DFCC',
        },
        fg: {
          primary: '#1C1917',
          secondary: '#57534E',
          muted: '#78716C', // 4.8:1 on white (was #A8A29E, 2.5:1)
        },
        accent: {
          DEFAULT: '#5B3FBE',
          hover: '#4A32A0',
          soft: '#EFEAFA',
          glow: '#E8E0FA',
        },
        qual: {
          budget: '#047857',
          authority: '#1D4ED8',
          need: '#B45309',
          timeline: '#6D28D9',
        },
        signal: {
          positive: '#047857',
          negative: '#B91C1C',
        },
        border: {
          DEFAULT: '#E5DDCC',
          strong: '#D6CCB6',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        'slide-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'atlas-flash': {
          from: { backgroundColor: '#EFEAFA' },
          to: { backgroundColor: 'transparent' },
        },
        pulse: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'slide-in': 'slide-in 240ms ease-out forwards',
        'atlas-pulse': 'pulse 1.6s ease-in-out infinite',
        // Marks a memory item that just changed; fades out on its own.
        'atlas-flash': 'atlas-flash 1.6s cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
