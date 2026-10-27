import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { Platform } from 'react-native';

import { deploymentTarget } from './src/config/deploymentTarget';
import { defaultGatewayUrl } from './src/config/env';
import { createGatewayClient } from './src/data/gatewayClient';
import { createDefaultSessionStore } from './src/data/sessionStore';
import { AppRoot } from './src/screens/AppRoot';
import { LandingScreen } from './src/screens/LandingScreen';
import { OnlineUnavailableScreen } from './src/screens/OnlineUnavailableScreen';

/**
 * The web build is served by the gateway itself, so it calls the API on its
 * own origin (the CSP allows nothing else). Native builds need the configured
 * gateway URL; without one the old landing screen explains that.
 */
const gatewayBaseUrl = Platform.OS === 'web' ? '' : defaultGatewayUrl;

export default function App() {
  const client = useMemo(() => (gatewayBaseUrl === null ? null : createGatewayClient({ baseUrl: gatewayBaseUrl })), []);
  const store = useMemo(() => createDefaultSessionStore(), []);

  // Only the field build talks to a gateway; the online (Vercel) build has no data source yet (D48).
  if (deploymentTarget !== 'field') {
    return (
      <>
        <OnlineUnavailableScreen reason={deploymentTarget} />
        <StatusBar style="dark" />
      </>
    );
  }

  return (
    <>
      {client === null ? <LandingScreen gatewayUrl={null} /> : <AppRoot client={client} store={store} />}
      <StatusBar style="dark" />
    </>
  );
}
