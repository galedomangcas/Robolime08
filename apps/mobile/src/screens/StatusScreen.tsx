import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AGE_REFRESH_MS, STATUS_POLL_INTERVAL_MS } from '../config/timing';
import { isSessionInvalid, type GatewayClient } from '../data/gatewayClient';
import type { StoredSession } from '../data/sessionStore';
import { startPolling, type Timers } from '../data/statusPoller';
import { buildStatusView, formatLocalTimestamp, type Connection, type StatusSnapshot } from '../data/statusView';
import { colors } from '../theme';

interface StatusScreenProps {
  client: GatewayClient;
  session: StoredSession;
  /** The gateway rejected the session (expired, revoked, unknown). */
  onSessionInvalid: () => void;
  /** Clears the local token only. */
  onForget: () => void;
  now?: () => Date;
  timers?: Timers;
}

/**
 * Robot status (M5a): state, faults, battery voltage, commanded lime, robot
 * time and age. Deliberately shows NO cell progress (no counts, percentages
 * or map) this semester (D33). Status arrives once per cell, so it is labelled
 * as the latest report, never as live.
 */
export function StatusScreen({ client, session, onSessionInvalid, onForget, now = () => new Date(), timers }: StatusScreenProps) {
  const [connection, setConnection] = useState<Connection>({ kind: 'connecting' });
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [currentTime, setCurrentTime] = useState(now);
  const [confirmForget, setConfirmForget] = useState(false);

  useEffect(
    () =>
      startPolling({
        request: () => client.robotStatus(session.token),
        intervalMs: STATUS_POLL_INTERVAL_MS,
        timers,
        onResult: (result) => {
          setCurrentTime(now());
          if (result.ok) {
            setConnection({ kind: 'connected' });
            setSnapshot({ status: result.data.status, staleThresholdSeconds: result.data.staleThresholdSeconds });
            return true;
          }
          if (isSessionInvalid(result.failure)) {
            onSessionInvalid();
            return false;
          }
          // Keep the last snapshot: it is relabelled "Last received", never shown as current.
          setConnection({ kind: 'unavailable', failure: result.failure });
          return true;
        },
      }),
    // Restart polling only when the session or client changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, session.token],
  );

  useEffect(() => {
    const id = setInterval(() => setCurrentTime(now()), AGE_REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = buildStatusView({ connection, snapshot, now: currentTime });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        RoboLime
      </Text>
      <Text style={styles.subtitle}>
        Robot: {session.robot.displayName}
        {session.robot.isSynthetic ? ' (synthetic demo data)' : ''}
      </Text>

      <View style={[styles.banner, view.connectionOk ? styles.bannerOk : styles.bannerBad]} accessibilityRole="summary">
        <Text style={styles.bannerText}>{view.connectionLabel}</Text>
      </View>

      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.cardTitle}>
          Robot status
        </Text>
        {view.emptyMessage !== null ? (
          <Text style={styles.value}>{view.emptyMessage}</Text>
        ) : (
          <>
            <Text style={styles.heading}>{view.heading}</Text>
            <Text style={styles.value}>{view.stateLabel}</Text>
            {view.faults.length > 0 && <Text style={styles.fault}>Reported faults: {view.faults.join(', ')}</Text>}
            <View style={[styles.ageBox, view.isStale && styles.ageBoxStale]}>
              <Text style={styles.ageText}>{view.freshnessLabel}</Text>
              {view.robotAt !== null && <Text style={styles.body}>Robot time: {formatLocalTimestamp(view.robotAt)}</Text>}
            </View>
            <Row label="Battery voltage" value={view.batteryVoltage} />
            <Row label="Total lime commanded" value={view.limeCommanded} />
            <Text style={styles.note}>
              Commanded volume reported by the robot, not a measurement of liquid actually delivered.
            </Text>
          </>
        )}
        <View style={styles.checkRow}>
          <View style={styles.unknownDot} accessibilityElementsHidden importantForAccessibility="no" />
          <Text style={styles.body}>Component self-check: Unknown</Text>
        </View>
        <Text style={styles.note}>
          Self-check results are not reported yet (pending the packet specification). Unknown does not
          mean passed.
        </Text>
      </View>

      <Text style={styles.note}>
        The robot sends status only after each cell, with no heartbeat, so a change or fault during a
        cell appears only when the next report arrives.
      </Text>

      <View style={styles.card}>
        {confirmForget ? (
          <>
            <Text style={styles.body}>
              This removes the pairing from this browser only. It does not end the session on the gateway:
              that session stays valid until it expires or the operator creates a new pairing code.
            </Text>
            <Pressable accessibilityRole="button" onPress={onForget} style={[styles.button, styles.buttonDanger]}>
              <Text style={styles.buttonText}>Forget this device</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setConfirmForget(false)} style={[styles.button, styles.buttonPlain]}>
              <Text style={styles.buttonPlainText}>Cancel</Text>
            </Pressable>
          </>
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setConfirmForget(true)} style={[styles.button, styles.buttonPlain]}>
            <Text style={styles.buttonPlainText}>Forget this device…</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value ?? '—'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, paddingTop: 56, gap: 16, backgroundColor: colors.background },
  title: { fontSize: 36, fontWeight: '800', color: colors.brand },
  subtitle: { fontSize: 18, color: colors.text },
  banner: { borderWidth: 2, borderRadius: 12, padding: 12 },
  bannerOk: { borderColor: colors.brand, backgroundColor: colors.surface },
  bannerBad: { borderColor: colors.danger, backgroundColor: colors.warningSurface },
  bannerText: { fontSize: 18, fontWeight: '700', color: colors.text },
  card: { borderWidth: 2, borderColor: colors.border, borderRadius: 12, padding: 16, gap: 10, backgroundColor: colors.surface },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.mutedText, textTransform: 'uppercase' },
  heading: { fontSize: 16, fontWeight: '700', color: colors.text },
  value: { fontSize: 28, fontWeight: '800', color: colors.text },
  fault: { fontSize: 18, fontWeight: '700', color: colors.danger },
  ageBox: { borderLeftWidth: 4, borderLeftColor: colors.brand, paddingLeft: 10, gap: 2 },
  ageBoxStale: { borderLeftColor: colors.danger, backgroundColor: colors.warningSurface },
  ageText: { fontSize: 18, fontWeight: '700', color: colors.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { fontSize: 17, color: colors.text },
  rowValue: { fontSize: 20, fontWeight: '700', color: colors.text },
  body: { fontSize: 16, lineHeight: 22, color: colors.text },
  note: { fontSize: 14, lineHeight: 20, color: colors.mutedText },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  unknownDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: colors.mutedText, backgroundColor: colors.background },
  button: { minHeight: 52, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonDanger: { backgroundColor: colors.danger },
  buttonPlain: { borderWidth: 2, borderColor: colors.border, backgroundColor: colors.background },
  buttonText: { fontSize: 18, fontWeight: '700', color: colors.background },
  buttonPlainText: { fontSize: 18, fontWeight: '700', color: colors.text },
});
