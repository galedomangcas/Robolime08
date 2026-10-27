import { describeFreshness } from '@robolime/shared';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';
import { Card, LogoTile, StripedHero, textStyles } from '../ui/primitives';

interface LandingScreenProps {
  gatewayUrl: string | null;
}

/**
 * Shown by native builds that have no gateway URL configured. No data source
 * is connected, so it shows honest "no data" states and never displays sample
 * or fabricated readings. Styled with the mockup's hero and cards (D50).
 */
export function LandingScreen({ gatewayUrl }: LandingScreenProps) {
  // No status record has been received; this stays 'no-data' until a gateway is configured.
  const freshness = describeFreshness(null, new Date());

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <StripedHero style={styles.hero}>
        <View style={styles.brandRow}>
          <LogoTile size={60} />
          <View>
            <Text accessibilityRole="header" style={styles.brandName}>
              RoboLime
            </Text>
            <Text style={styles.brandTag}>Soil pH monitoring and variable-rate lime dosing</Text>
          </View>
        </View>
      </StripedHero>

      <View style={styles.body}>
        <Card>
          <Text accessibilityRole="header" style={textStyles.label}>
            ROBOT STATUS
          </Text>
          <Text style={textStyles.value}>{freshness.kind === 'no-data' ? 'No robot data yet' : 'Status unavailable'}</Text>
          <Text style={textStyles.muted}>
            Readings appear after the field gateway is running and the robot has reported at least one cell.
          </Text>
        </Card>

        <Card>
          <Text accessibilityRole="header" style={textStyles.label}>
            FIELD GATEWAY
          </Text>
          <Text style={textStyles.value}>{gatewayUrl ?? 'Not configured'}</Text>
          <Text style={textStyles.muted}>
            Connection not attempted in this build. Field use runs on the team’s laptop without internet.
          </Text>
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.background },
  content: { flexGrow: 1 },
  hero: { minHeight: 200, borderBottomLeftRadius: 36, borderBottomRightRadius: 36, justifyContent: 'flex-end', padding: 24 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  brandName: { color: colors.onDark, fontSize: 32, fontWeight: '800' },
  brandTag: { color: '#DCE6D6', fontSize: 16 },
  body: { padding: 20, gap: 16, width: '100%', maxWidth: 640, alignSelf: 'center' },
});
