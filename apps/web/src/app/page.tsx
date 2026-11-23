import VoicePersonaPage from './voice/[personaId]/page';

// The homepage is the Google Meet-style pre-join screen for the demo prospect (Mia Chen).
export default function Page() {
  return <VoicePersonaPage params={{ personaId: 'mia' }} />;
}
