import { describeFreshness } from '@robolime/shared';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

interface LandingScreenProps {
  gatewayUrl: string | null;
}

/**
 * Phase 1 landing screen. No data source is connected yet, so it shows honest
 * "no data" states and never displays sample or fabricated readings.
 */
export function LandingScreen({ gatewayUrl }: LandingScreenProps) {
  // No status record has been received; this stays 'no-data' until the gateway adapter exists.
  const freshness = describeFreshness(null, new Date());

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        RoboLime
      </Text>
      <Text style={styles.subtitle}>
        Soil pH monitoring and variable-rate lime dosing
      </Text>

      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.cardTitle}>
          Robot status
        </Text>
        <Text style={styles.cardValue}>
          {freshness.kind === 'no-data' ? 'No robot data yet' : 'Status unavailable'}
        </Text>
        <Text style={styles.cardBody}>
          Readings will appear here after the laptop field gateway is running and the robot
          has reported at least one cell.
        </Text>
      </View>

      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.cardTitle}>
          Field gateway
        </Text>
        <Text style={styles.cardValue}>{gatewayUrl ?? 'Not configured'}</Text>
        <Text style={styles.cardBody}>
          Connection not attempted in this build. Field use works over the local Wi-Fi without
          internet.
        </Text>
      </View>

      <Text style={styles.notice}>
        Development build (Phase 1). Robot hardware and gateway integration are not
        implemented yet.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    padding: 20,
    paddingTop: 56,
    gap: 16,
    backgroundColor: colors.background,
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    color: colors.brand,
  },
  subtitle: {
    fontSize: 18,
    color: colors.text,
  },
  card: {
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 16,
    gap: 6,
    backgroundColor: colors.surface,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.mutedText,
    textTransform: 'uppercase',
  },
  cardValue: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
  },
  cardBody: {
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
  },
  notice: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.mutedText,
  },
});
