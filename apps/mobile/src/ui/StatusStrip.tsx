import { StyleSheet, Text, View } from 'react-native';

import { formatLocalTimestamp, type StatusView } from '../data/statusView';
import { colors, radius } from '../theme';
import { SelfCheckDots } from './primitives';

/**
 * The dark robot monitoring strip from the mockups (D50, D54). It shows what
 * the robot reports: state with cell progress ("Working: 7 of 20 cells
 * (35%)") and a progress bar, faults, battery voltage, commanded lime, robot
 * time and age. Placeholders, labelled as such: battery health ("TBC", #10)
 * and the component self-check (bit meanings unspecified, #9: the dots are
 * outlined and never shown as passed). Status is never labelled live.
 */
export function StatusStrip({ view, wide }: { view: StatusView; wide: boolean }) {
  const hasStatus = view.emptyMessage === null;
  return (
    <View style={[styles.strip, wide && styles.stripWide]} accessibilityRole="summary">
      <View style={[styles.main, wide && styles.mainWide]}>
        <View style={styles.topRow}>
          {view.heading !== null && (
            <View style={[styles.headingPill, view.isStale && styles.headingPillStale]}>
              <Text style={[styles.headingText, view.isStale && styles.headingTextStale]}>{view.heading}</Text>
            </View>
          )}
          {view.freshnessLabel !== null && (
            <Text style={[styles.freshness, view.isStale && styles.freshnessStale]}>{view.freshnessLabel}</Text>
          )}
        </View>
        <Text style={styles.state}>{hasStatus ? view.stateLabel : view.emptyMessage}</Text>
        {view.progress !== null && (
          <View
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityLabel={`${view.progress.completed} of ${view.progress.total} cells`}
            accessibilityValue={{ min: 0, max: view.progress.total, now: view.progress.completed }}
          >
            <View style={[styles.bar, { width: `${view.progress.percent}%` }]} />
          </View>
        )}
        {view.faults.length > 0 && <Text style={styles.faults}>Reported faults: {view.faults.join(', ')}</Text>}
        {view.robotAt !== null && <Text style={styles.small}>Robot time: {formatLocalTimestamp(view.robotAt)}</Text>}
      </View>
      <View style={[styles.stats, wide && styles.statsWide]}>
        <Stat value={view.batteryVoltage ?? '—'} label="Battery · health TBC" />
        <Stat value={view.limeCommanded ?? '—'} label="Lime commanded (not measured flow)" />
        <View style={styles.stat}>
          <SelfCheckDots count={8} onDark />
          <Text style={styles.statLabel}>Self-check: not reported yet (placeholder)</Text>
        </View>
      </View>
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { backgroundColor: colors.ink, borderRadius: radius.card + 4, padding: 20, gap: 16 },
  stripWide: { flexDirection: 'row', alignItems: 'center', gap: 28 },
  main: { gap: 8 },
  mainWide: { flex: 1.3 },
  topRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  headingPill: { backgroundColor: '#1F4A2C', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 4 },
  headingPillStale: { backgroundColor: '#4A3A12' },
  headingText: { color: colors.onDarkPositive, fontSize: 14, fontWeight: '700' },
  headingTextStale: { color: '#FFD98A' },
  freshness: { color: colors.onDarkMuted, fontSize: 15 },
  freshnessStale: { color: '#FFD98A', fontWeight: '700' },
  state: { color: colors.onDark, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
  track: { height: 10, borderRadius: 5, backgroundColor: '#3A4238', overflow: 'hidden' },
  bar: { height: '100%', borderRadius: 5, backgroundColor: colors.brandBright },
  faults: { color: '#FFB4A3', fontSize: 16, fontWeight: '700' },
  small: { color: colors.onDarkMuted, fontSize: 13 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  statsWide: { flex: 2, justifyContent: 'space-between' },
  stat: { gap: 6, minWidth: 120 },
  statValue: { color: colors.onDark, fontSize: 22, fontWeight: '800' },
  statLabel: { color: colors.onDarkMuted, fontSize: 13 },
});
