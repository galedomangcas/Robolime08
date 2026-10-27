import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { AGE_REFRESH_MS, STATUS_POLL_INTERVAL_MS } from '../config/timing';
import type { FieldDataSource } from '../data/dataSource';
import { isSessionInvalid } from '../data/gatewayClient';
import type { StoredSession } from '../data/sessionStore';
import { startPolling, type Timers } from '../data/statusPoller';
import { buildStatusView, type Connection, type StatusSnapshot } from '../data/statusView';
import { WIDE_BREAKPOINT, colors } from '../theme';
import { BottomTabs, SideNav, type Section } from '../ui/Navigation';
import { Card, InfoBox, SecondaryButton, StatusPill, SyntheticBadge, textStyles } from '../ui/primitives';
import { StatusStrip } from '../ui/StatusStrip';
import { ExportsScreen } from './ExportsScreen';
import { ResultsScreen } from './ResultsScreen';

interface StatusScreenProps {
  dataSource: FieldDataSource;
  session: StoredSession;
  /** The gateway rejected the session (expired, revoked, unknown). */
  onSessionInvalid: () => void;
  /** Clears the local token only. */
  onForget: () => void;
  now?: () => Date;
  timers?: Timers;
}

/**
 * The paired view, laid out after the Canva mockups (D50): header, the dark
 * robot monitoring strip, then the Field, Results or Exports section, with a
 * bottom tab bar on phones and a side rail at laptop width. The strip is
 * rendered above the section content in every section and scrolls normally
 * with the page; it is not fixed or sticky (D46). Polling continues while the
 * user moves between sections. Deliberately shows NO cell progress, cell
 * counts, field map or field selection this semester (D29, D33). Status
 * arrives once per cell, so it is labelled as the latest report, never live.
 */
export function StatusScreen({ dataSource, session, onSessionInvalid, onForget, now = () => new Date(), timers }: StatusScreenProps) {
  const [connection, setConnection] = useState<Connection>({ kind: 'connecting' });
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [currentTime, setCurrentTime] = useState(now);
  const [confirmForget, setConfirmForget] = useState(false);
  const [section, setSection] = useState<Section>('field');
  const wide = useWindowDimensions().width >= WIDE_BREAKPOINT;

  useEffect(
    () =>
      startPolling({
        request: () => dataSource.robotStatus(session.token),
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
    [dataSource, session.token],
  );

  useEffect(() => {
    const id = setInterval(() => setCurrentTime(now()), AGE_REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = buildStatusView({ connection, snapshot, now: currentTime, sourceName: dataSource.sourceName });
  const online = dataSource.kind === 'cloud';
  const pillTone = connection.kind === 'connected' ? 'positive' : connection.kind === 'unavailable' ? 'negative' : 'neutral';

  const content = (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, wide && styles.contentWide]}>
      <View style={[styles.header, wide && styles.headerWide]}>
        <View style={styles.titleBlock}>
          <View style={styles.titleRow}>
            <Text accessibilityRole="header" style={textStyles.pageTitle}>
              {session.robot.displayName}
            </Text>
            {session.robot.isSynthetic && <SyntheticBadge />}
          </View>
          <Text style={textStyles.muted}>{online ? 'RoboLime · online (synchronised records)' : 'RoboLime · field gateway on this computer'}</Text>
        </View>
        <StatusPill label={view.connectionLabel} tone={pillTone} />
      </View>

      <StatusStrip view={view} wide={wide} />

      {section === 'results' && <ResultsScreen dataSource={dataSource} token={session.token} onSessionInvalid={onSessionInvalid} />}
      {section === 'exports' && <ExportsScreen online={online} />}
      {section === 'field' && (
        <View style={styles.sectionBody}>
          <InfoBox tone="neutral" icon="alert">
            <Text style={textStyles.body}>
              The robot sends status only after each cell, with no heartbeat, so a change or fault during a cell
              appears only when the next report arrives.
            </Text>
          </InfoBox>

          <Card>
            <Text accessibilityRole="header" style={textStyles.sectionTitle}>
              About these values
            </Text>
            <Text style={textStyles.muted}>
              Commanded volume reported by the robot, not a measurement of liquid actually delivered.
            </Text>
            <Text style={textStyles.muted}>
              Self-check results are not reported yet (pending the packet specification). Unknown does not mean
              passed. Battery health is not defined yet; only the voltage is reported.
            </Text>
          </Card>

          <Card>
            <Text accessibilityRole="header" style={textStyles.sectionTitle}>
              Field map
            </Text>
            <Text style={textStyles.muted}>
              The field map, cell progress and field selection are not part of this version. Readings for each run
              are under Results.
            </Text>
          </Card>

          <Card>
            <Text accessibilityRole="header" style={textStyles.sectionTitle}>
              This device
            </Text>
            {confirmForget ? (
              <>
                <Text style={textStyles.body}>
                  {online
                    ? 'This signs this browser out of RoboLime online. To view the robot again you will need a new claim code from the operator.'
                    : 'This removes the pairing from this browser only. It does not end the session on the gateway: that session stays valid until it expires or the operator creates a new pairing code.'}
                </Text>
                <SecondaryButton label={online ? 'Sign out' : 'Forget this device'} danger onPress={onForget} />
                <SecondaryButton label="Cancel" onPress={() => setConfirmForget(false)} />
              </>
            ) : (
              <SecondaryButton label={online ? 'Sign out…' : 'Forget this device…'} onPress={() => setConfirmForget(true)} />
            )}
          </Card>
        </View>
      )}
    </ScrollView>
  );

  if (wide) {
    return (
      <View style={styles.wideRoot}>
        <SideNav current={section} onSelect={setSection} />
        {content}
      </View>
    );
  }
  return (
    <View style={styles.root}>
      {content}
      <BottomTabs current={section} onSelect={setSection} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  wideRoot: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  scroll: { flex: 1 },
  content: { padding: 18, paddingTop: 28, gap: 18 },
  contentWide: { paddingTop: 22, paddingRight: 24, maxWidth: 1280 },
  header: { gap: 12 },
  headerWide: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  titleBlock: { gap: 4, flexShrink: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  sectionBody: { gap: 18 },
});
