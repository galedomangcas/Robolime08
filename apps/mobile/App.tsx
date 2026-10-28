import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { Platform } from 'react-native';

import { cloudConfig } from './src/config/cloudConfig';
import { deploymentTarget } from './src/config/deploymentTarget';
import { defaultGatewayUrl } from './src/config/env';
import { createCloudAuth } from './src/data/cloudAuth';
import { createCloudReader } from './src/data/cloudReader';
import { createGatewayClient } from './src/data/gatewayClient';
import { createDefaultSessionStore, type KeyValueStorage } from './src/data/sessionStore';
import { AppRoot } from './src/screens/AppRoot';
import { LandingScreen } from './src/screens/LandingScreen';
import { OnlineRoot } from './src/screens/OnlineRoot';
import { OnlineUnavailableScreen } from './src/screens/OnlineUnavailableScreen';

/**
 * The web build is served by the gateway itself, so it calls the API on its
 * own origin (the CSP allows nothing else). Native builds need the configured
 * gateway URL; without one the old landing screen explains that.
 */
const gatewayBaseUrl = Platform.OS === 'web' ? '' : defaultGatewayUrl;

function browserStorage(): KeyValueStorage | null {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null;
  } catch {
    return null; // site data blocked
  }
}

export default function App() {
  const client = useMemo(() => (gatewayBaseUrl === null ? null : createGatewayClient({ baseUrl: gatewayBaseUrl })), []);
  const store = useMemo(() => createDefaultSessionStore(), []);
  // Online (Vercel) build only (D52): anonymous Supabase sign-in + server-verified claim code.
  const online = useMemo(() => {
    if (deploymentTarget !== 'online' || !cloudConfig.ok) return null;
    const auth = createCloudAuth({ config: cloudConfig, storage: browserStorage() });
    return { auth, reader: createCloudReader({ config: cloudConfig, session: auth }) };
  }, []);

  if (deploymentTarget !== 'field') {
    return (
      <>
        {online !== null ? (
          <OnlineRoot auth={online.auth} reader={online.reader} projectRef={cloudConfig.ok ? cloudConfig.projectRef : undefined} />
        ) : (
          <OnlineUnavailableScreen reason={deploymentTarget === 'online' ? 'online' : 'invalid'} />
        )}
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
