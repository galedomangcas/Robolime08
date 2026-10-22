import { StatusBar } from 'expo-status-bar';

import { defaultGatewayUrl } from './src/config/env';
import { LandingScreen } from './src/screens/LandingScreen';

export default function App() {
  return (
    <>
      <LandingScreen gatewayUrl={defaultGatewayUrl} />
      <StatusBar style="dark" />
    </>
  );
}
