import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { CloudAuth, CloudSession } from '../data/cloudAuth';
import type { CloudReader } from '../data/cloudReader';
import type { Timers } from '../data/statusPoller';
import { OnlineRoot } from './OnlineRoot';

/** D52: the online root signs in anonymously, claims with a server-verified code, then shows cloud data. */
const ROBOT = { id: '7f9c2ba4-e88f-4f3b-9c1d-111111111111', displayName: 'Synthetic demo robot', isSynthetic: true };
const SESSION: CloudSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: 9e9, userId: 'u' };

function fakeAuth(signIn: Awaited<ReturnType<CloudAuth['signInAnonymously']>> = { ok: true, data: SESSION }, initial: CloudSession | null = null) {
  let current = initial;
  const auth: CloudAuth = {
    current: () => current,
    accessToken: async () => current?.accessToken ?? null,
    signInAnonymously: jest.fn(async () => {
      if (signIn.ok) current = signIn.data;
      return signIn;
    }),
    signOut: jest.fn(async () => {
      current = null;
    }),
  };
  return auth;
}

function fakeReader(overrides: Partial<CloudReader> = {}): CloudReader {
  return {
    claimedRobotIds: async () => ({ ok: true, data: [] }),
    claimedRobots: async () => ({ ok: true, data: [] }),
    claimRobot: jest.fn(async () => ({ ok: true as const, data: { kind: 'claimed' as const, robot: ROBOT } })),
    robotStatus: async () => ({ ok: true, data: { status: null, staleThresholdSeconds: 240 } }),
    runs: async () => ({ ok: true, data: [] }),
    runReadings: async () => ({ ok: true, data: null }),
    runRecommendation: async () => ({ ok: true, data: null }),
    field: async () => ({ ok: true, data: null }),
    manualStatus: async () => ({ ok: false, failure: { kind: 'unreachable' } }),
    manualCommand: async () => ({ ok: false, failure: { kind: 'unreachable' } }),
    ...overrides,
  };
}

/** Polling never fires on its own in these tests. */
const timers: Timers = { setTimeout: () => 0, clearTimeout: () => undefined };
const NOW = () => new Date('2026-03-01T12:00:00.000Z');

const enterCode = async (code: string) => {
  await act(async () => fireEvent.changeText(await screen.findByLabelText('Online claim code'), code));
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'View robot' })));
};

describe('OnlineRoot (D52)', () => {
  it('signs in anonymously, claims with the code, and shows the robot from the cloud', async () => {
    const auth = fakeAuth();
    const reader = fakeReader();
    await render(<OnlineRoot timers={timers} now={NOW} auth={auth} reader={reader} />);
    expect(await screen.findByText('View your robot online')).toBeTruthy();
    // Only the claim code is asked for: no email, phone or identity field.
    expect(screen.queryByLabelText(/email|phone/i)).toBeNull();
    await enterCode('ABCD-2345-EFGH');
    expect(await screen.findByText('RoboLime cloud connected')).toBeTruthy();
    expect(auth.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(reader.claimRobot).toHaveBeenCalledWith('ABCD-2345-EFGH');
    expect(await screen.findByText('RoboLime cloud connected')).toBeTruthy();
    expect(screen.getByText('Online · synchronised records')).toBeTruthy();
    // The header names the app, not the robot.
    expect(screen.queryByText('Synthetic demo robot')).toBeNull();
  });

  it('opens straight to the robot when this browser already holds a claim', async () => {
    const auth = fakeAuth(undefined, SESSION);
    await render(<OnlineRoot timers={timers} now={NOW} auth={auth} reader={fakeReader({ claimedRobots: async () => ({ ok: true, data: [ROBOT] }) })} />);
    expect(await screen.findByText('RoboLime cloud connected')).toBeTruthy();
    expect(auth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('refuses a wrong code and shows nothing of the robot', async () => {
    const reader = fakeReader({ claimRobot: jest.fn(async () => ({ ok: true as const, data: { kind: 'invalid-code' as const } })) });
    await render(<OnlineRoot timers={timers} now={NOW} auth={fakeAuth()} reader={reader} />);
    await enterCode('WRONG');
    expect(await screen.findByText(/That claim code is not correct/)).toBeTruthy();
    expect(screen.queryByText('RoboLime cloud connected')).toBeNull();
  });

  it('explains rate limiting', async () => {
    const reader = fakeReader({ claimRobot: jest.fn(async () => ({ ok: true as const, data: { kind: 'rate-limited' as const } })) });
    await render(<OnlineRoot timers={timers} now={NOW} auth={fakeAuth()} reader={reader} />);
    await enterCode('X');
    expect(await screen.findByText(/Too many wrong codes/)).toBeTruthy();
  });

  it('says exactly what is missing when anonymous sign-ins are disabled', async () => {
    const reader = fakeReader();
    await render(<OnlineRoot timers={timers} now={NOW} auth={fakeAuth({ ok: false, failure: { kind: 'anonymous-disabled' } })} reader={reader} />);
    await enterCode('ABCD-2345-EFGH');
    expect(await screen.findByText(/allow anonymous sign-ins in Supabase Auth/)).toBeTruthy();
    expect(reader.claimRobot).not.toHaveBeenCalled();
  });

  it('shows an offline state with retry instead of a spinner when the cloud is unreachable', async () => {
    const auth = fakeAuth(undefined, SESSION);
    await render(<OnlineRoot timers={timers} now={NOW} auth={auth} reader={fakeReader({ claimedRobots: async () => ({ ok: false, failure: { kind: 'unreachable' } }) })} />);
    expect(await screen.findByText(/Cannot reach RoboLime cloud/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('lets the user leave a broken stored sign-in and enter a claim code, and shows the cloud project', async () => {
    const auth = fakeAuth(undefined, SESSION);
    await render(
      <OnlineRoot timers={timers} now={NOW} projectRef="abcdefghijklmnopqrst" auth={auth} reader={fakeReader({ claimedRobots: async () => ({ ok: false, failure: { kind: 'unreachable' } }) })} />,
    );
    expect(await screen.findByText('Cloud project: abcdefghijklmnopqrst')).toBeTruthy();
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Enter a claim code instead' })));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText('Online claim code')).toBeTruthy();
  });
});
