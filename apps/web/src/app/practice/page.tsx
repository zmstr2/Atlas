import dynamic from 'next/dynamic';

// Practice mode = the OpenAI Realtime persona experience for evaluators
// who haven't installed the desktop app. Not the real product.
const VoiceLandingPage = dynamic(() => import('../VoiceLandingPage'), { ssr: false });

export default function PracticePage() {
  return <VoiceLandingPage />;
}
