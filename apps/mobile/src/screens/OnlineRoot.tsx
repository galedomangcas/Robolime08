import type { RobotSummary } from '@robolime/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';

import type { CloudAuth, CloudAuthFailure } from '../data/cloudAuth';
import type { CloudFailure, CloudReader, CloudResult } from '../data/cloudReader';
import { createCloudDataSource } from '../data/dataSource';
import type { StoredSession } from '../data/sessionStore';
import type { Timers } from '../data/statusPoller';
import { WIDE_BREAKPOINT, colors, radius } from '../theme';
import { Icon } from '../ui/Icon';
import { IconTile, InfoBox, LogoTile, PrimaryButton, SecondaryButton, StripedHero, textStyles } from '../ui/primitives';
import { StatusScreen } from './StatusScreen';

interface OnlineRootProps {
  auth: CloudAuth;
  reader: CloudReader;
  /** Public Supabase project ref, shown for diagnosis (not a secret). */
  projectRef?: string;
  now?: () => Date;
  timers?: Timers;
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'offline'; message: string }
  | { kind: 'claim' }
  | { kind: 'viewing'; robot: RobotSummary };

export function cloudFailureMessage(failure: CloudFailure): string {
  switch (failure.kind) {
    case 'timeout':
    case 'unreachable':
      return 'Cannot reach RoboLime cloud. Check this device’s internet connection, then try again.';
    case 'auth-required':
      return 'Your online sign-in has ended. Enter a claim code again.';
    case 'forbidden':
      return 'RoboLime cloud refused the request (not allowed).';
    case 'http':
      return `RoboLime cloud error ${failure.status}. Try again later.`;
    case 'invalid-response':
      return 'RoboLime cloud sent an unreadable answer. Try again later.';
    case 'not-configured':
      return 'Online access is not configured in this build.';
  }
}

function phaseForClaimedRobots(robots: CloudResult<RobotSummary[]>): Phase {
  if (robots.ok) {
    const first = robots.data[0];
    return first === undefined ? { kind: 'claim' } : { kind: 'viewing', robot: first };
  }
  if (robots.failure.kind === 'auth-required') return { kind: 'claim' };
  return { kind: 'offline', message: cloudFailureMessage(robots.failure) };
}

export function signInFailureMessage(failure: CloudAuthFailure): string {
  switch (failure.kind) {
    case 'anonymous-disabled':
      return 'Online sign-in is not enabled on the RoboLime cloud project yet. The project owner must allow anonymous sign-ins in Supabase Auth.';
    case 'rate-limited':
      return 'Too many sign-in attempts from this network. Wait a few minutes and try again.';
    case 'timeout':
    case 'unreachable':
      return 'Cannot reach RoboLime cloud. Check this device’s internet connection, then try again.';
    case 'http':
      return `Online sign-in failed (error ${failure.status}). Try again later.`;
    case 'invalid-response':
      return 'Online sign-in sent an unreadable answer. Try again later.';
    case 'not-configured':
      return 'Online access is not configured in this build.';
  }
}

/**
 * The online (Vercel) build's root (D52). Online only: it needs internet and
 * never contacts a field gateway. Flow: anonymous Supabase sign-in, then a
 * cloud claim code verified by the server (`claim_robot`), then the same
 * status / results screens as the field build, fed by the cloud data source.
 * The robot is never named by the client: RLS shows only claimed robots.
 */
export function OnlineRoot({ auth, reader, projectRef, now, timers }: OnlineRootProps) {
  // No stored sign-in: straight to the claim step, without a request.
  const [phase, setPhase] = useState<Phase>(() => (auth.current() === null ? { kind: 'claim' } : { kind: 'checking' }));
  const [notice, setNotice] = useState<string | null>(null);

  /** Looks up this browser's existing claim; the phase is set only when the answer arrives. */
  const check = useCallback(() => {
    let cancelled = false;
    if (auth.current() !== null) {
      void reader.claimedRobots().then((robots) => {
        if (!cancelled) setPhase(phaseForClaimedRobots(robots));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [auth, reader]);

  useEffect(() => check(), [check]);

  if (phase.kind === 'viewing') {
    return (
      <OnlineViewer
        robot={phase.robot}
        reader={reader}
        now={now}
        timers={timers}
        onSessionInvalid={() => {
          setNotice('Your online access to this robot has ended. Enter a claim code again.');
          setPhase({ kind: 'claim' });
        }}
        onSignOut={() => {
          void auth.signOut();
          setNotice('Signed out of RoboLime online on this browser.');
          setPhase({ kind: 'claim' });
        }}
      />
    );
  }
  return (
    <ClaimScreen
      auth={auth}
      reader={reader}
      phase={phase}
      notice={notice}
      projectRef={projectRef}
      onRetry={() => {
        setPhase({ kind: 'checking' });
        check();
      }}
      onStartOver={() => {
        void auth.signOut();
        setNotice(null);
        setPhase({ kind: 'claim' });
      }}
      onClaimed={(robot) => {
        setNotice(null);
        setPhase({ kind: 'viewing', robot });
      }}
    />
  );
}

function OnlineViewer({
  robot,
  reader,
  onSessionInvalid,
  onSignOut,
  now,
  timers,
}: {
  robot: RobotSummary;
  reader: CloudReader;
  onSessionInvalid: () => void;
  onSignOut: () => void;
  now?: () => Date;
  timers?: Timers;
}) {
  const dataSource = useMemo(() => createCloudDataSource(reader, robot.id), [reader, robot.id]);
  // The status screen's session shape; the cloud source ignores the token (the reader holds the sign-in).
  const session = useMemo<StoredSession>(
    () => ({ token: `cloud:${robot.id}`, robot, expiresAt: new Date(0).toISOString() }),
    [robot],
  );
  return (
    <StatusScreen dataSource={dataSource} session={session} onSessionInvalid={onSessionInvalid} onForget={onSignOut} now={now} timers={timers} />
  );
}

function ClaimScreen({
  auth,
  reader,
  phase,
  notice,
  projectRef,
  onRetry,
  onStartOver,
  onClaimed,
}: {
  auth: CloudAuth;
  reader: CloudReader;
  phase: Exclude<Phase, { kind: 'viewing' }>;
  notice: string | null;
  projectRef?: string;
  /** Forgets this browser's online sign-in and shows the claim-code entry. */
  onStartOver: () => void;
  onRetry: () => void;
  onClaimed: (robot: RobotSummary) => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const wide = useWindowDimensions().width >= WIDE_BREAKPOINT;

  const submit = async () => {
    if (busy) return;
    const trimmed = code.trim();
    if (trimmed === '') {
      setMessage('Enter the claim code.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (auth.current() === null) {
        const signIn = await auth.signInAnonymously();
        if (!signIn.ok) {
          setMessage(signInFailureMessage(signIn.failure));
          return;
        }
      }
      const result = await reader.claimRobot(trimmed);
      if (!result.ok) {
        setMessage(cloudFailureMessage(result.failure));
      } else if (result.data.kind === 'invalid-code') {
        setMessage('That claim code is not correct or is no longer active. Check it with the operator.');
      } else if (result.data.kind === 'rate-limited') {
        setMessage('Too many wrong codes. Wait 15 minutes, then try again.');
      } else {
        setCode('');
        onClaimed(result.data.robot);
        return;
      }
    } finally {
      setBusy(false);
    }
    setCode('');
  };

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">
      <StripedHero style={styles.hero}>
        <View style={[styles.brandRow, wide && styles.column]}>
          <LogoTile size={64} />
          <View>
            <Text accessibilityRole="header" style={styles.brandName}>
              RoboLime
            </Text>
            <Text style={styles.brandTag}>Soil pH monitoring and lime dosing</Text>
          </View>
        </View>
      </StripedHero>

      <View style={[styles.body, wide && styles.column]}>
        <Text accessibilityRole="header" style={textStyles.pageTitle}>
          View your robot online
        </Text>
        <Text style={styles.lead}>Enter the online claim code from the operator of the field laptop.</Text>

        <View style={styles.sourceCard}>
          <IconTile name="signal"color={colors.info} background="#E3EDFB" />
          <View style={styles.sourceText}>
            <Text style={styles.sourceTitle}>RoboLime cloud</Text>
            <Text style={textStyles.muted}>Needs internet · shows records the field laptop has synchronised</Text>
          </View>
        </View>

        {notice !== null && (
          <View accessibilityRole="alert">
            <InfoBox tone="warning" icon="alert">
              <Text style={styles.noticeText}>{notice}</Text>
            </InfoBox>
          </View>
        )}

        {phase.kind === 'checking' && (
          <View style={styles.busyRow}>
            <ActivityIndicator color={colors.brand} />
            <Text style={textStyles.body}>Checking your online access…</Text>
          </View>
        )}

        {phase.kind === 'offline' && (
          <View accessibilityRole="alert" style={styles.offline}>
            <InfoBox tone="warning" icon="cloudOff">
              <Text style={styles.noticeText}>{phase.message}</Text>
            </InfoBox>
            <SecondaryButton label="Try again" onPress={onRetry} />
            <SecondaryButton label="Enter a claim code instead" onPress={onStartOver} />
          </View>
        )}

        {projectRef !== undefined && <Text style={textStyles.muted}>Cloud project: {projectRef}</Text>}

        {phase.kind === 'claim' && (
          <>
            <View style={styles.field}>
              <Text nativeID="claim-code-label" style={styles.label}>
                Online claim code
              </Text>
              <TextInput
                accessibilityLabel="Online claim code"
                aria-labelledby="claim-code-label"
                value={code}
                onChangeText={setCode}
                onSubmitEditing={() => void submit()}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                secureTextEntry
                editable={!busy}
                placeholder="XXXX-XXXX-XXXX"
                placeholderTextColor="#8A9087"
                style={styles.input}
              />
            </View>

            {message !== null && (
              <Text accessibilityRole="alert" style={styles.error}>
                {message}
              </Text>
            )}

            <View style={styles.actions}>
              <PrimaryButton label="View robot" icon="arrowRight" busy={busy} onPress={() => void submit()} />
              <View style={styles.privacy}>
                <Icon name="lock" size={20} color={colors.mutedText} />
                <Text style={[textStyles.muted, styles.privacyText]}>
                  No account, email or phone number. This browser gets an anonymous sign-in; the claim code decides
                  which robot it may view. Anyone with the code can view this robot’s data, so keep it private. View
                  only: nothing here controls the robot.
                </Text>
              </View>
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.background },
  pageContent: { flexGrow: 1 },
  hero: { minHeight: 220, borderBottomLeftRadius: 36, borderBottomRightRadius: 36, justifyContent: 'flex-end', padding: 24 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  brandName: { color: colors.onDark, fontSize: 34, fontWeight: '800', letterSpacing: -0.6 },
  brandTag: { color: '#DCE6D6', fontSize: 17 },
  column: { width: '100%', maxWidth: 560, alignSelf: 'center' },
  body: { padding: 24, gap: 18, flexGrow: 1 },
  lead: { fontSize: 19, lineHeight: 26, color: colors.mutedText },
  sourceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: 16,
  },
  sourceText: { flex: 1, gap: 2 },
  sourceTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  noticeText: { fontSize: 16, lineHeight: 22, color: colors.warningText },
  offline: { gap: 12 },
  field: { gap: 8 },
  label: { fontSize: 17, fontWeight: '700', color: colors.text },
  input: {
    minHeight: 64,
    borderWidth: 2,
    borderColor: colors.brand,
    borderRadius: radius.button,
    paddingHorizontal: 18,
    fontSize: 24,
    letterSpacing: 2,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  error: { fontSize: 17, fontWeight: '700', color: colors.danger },
  actions: { gap: 14, marginTop: 'auto' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  privacy: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  privacyText: { flex: 1 },
});
