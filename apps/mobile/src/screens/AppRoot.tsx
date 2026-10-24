import { useState } from 'react';

import type { GatewayClient } from '../data/gatewayClient';
import type { SessionStore, StoredSession } from '../data/sessionStore';
import type { Timers } from '../data/statusPoller';
import { PairingScreen } from './PairingScreen';
import { StatusScreen } from './StatusScreen';

interface AppRootProps {
  client: GatewayClient;
  store: SessionStore;
  now?: () => Date;
  timers?: Timers;
}

const SESSION_ENDED_NOTICE = 'The gateway no longer accepts this device’s pairing (it expired or was replaced). Pair again.';

/**
 * Pairing ⇄ status. A stored session opens the status screen straight away,
 * even if the gateway is unreachable (field use must not lock the user out);
 * it is cleared only when the gateway itself rejects it.
 */
export function AppRoot({ client, store, now, timers }: AppRootProps) {
  const [session, setSession] = useState<StoredSession | null>(() => store.load());
  const [notice, setNotice] = useState<string | null>(null);

  if (session === null) {
    return (
      <PairingScreen
        client={client}
        notice={notice}
        onPaired={(next) => {
          store.save(next);
          setNotice(null);
          setSession(next);
        }}
      />
    );
  }

  return (
    <StatusScreen
      client={client}
      session={session}
      now={now}
      timers={timers}
      onSessionInvalid={() => {
        store.clear();
        setNotice(SESSION_ENDED_NOTICE);
        setSession(null);
      }}
      onForget={() => {
        store.clear();
        setNotice('This browser no longer stores the pairing. The gateway session itself was not revoked.');
        setSession(null);
      }}
    />
  );
}
