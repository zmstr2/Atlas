import dynamic from 'next/dynamic';

const VoiceLandingPage = dynamic(() => import('./VoiceLandingPage'), { ssr: false });

export default function Page() {
  return <VoiceLandingPage />;
}
