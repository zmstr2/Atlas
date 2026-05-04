import type { Metadata } from 'next';
import { DM_Sans, Instrument_Serif } from 'next/font/google';
import '../styles/globals.css';
import 'streamdown/styles.css';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Atlas — Live Sales Call Agent',
  description: 'Real-time AI coaching that generates training data for Ava.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${instrumentSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
