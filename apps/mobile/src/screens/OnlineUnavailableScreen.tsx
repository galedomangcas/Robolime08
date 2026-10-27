import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';
import { Card, IconTile, LogoTile, StripedHero, textStyles } from '../ui/primitives';

interface OnlineUnavailableScreenProps {
  /** `online`: the Vercel build before the cloud adapter exists. `invalid`: bad EXPO_PUBLIC_ROBOLIME_TARGET. */
  reason: 'online' | 'invalid';
}

/**
 * Shown instead of the field pairing flow when the build is not the laptop
 * field build (D48), in the mockup's visual style (D50). It makes no network
 * request and shows no data, so an online visitor is never told a field
 * gateway is reachable, and never shown fabricated or cached values.
 */
export function OnlineUnavailableScreen({ reason }: OnlineUnavailableScreenProps) {
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <StripedHero style={styles.hero}>
        <View style={styles.brandRow}>
          <LogoTile size={60} />
          <View>
            <Text accessibilityRole="header" style={styles.brandName}>
              RoboLime
            </Text>
            <Text style={styles.brandTag}>Soil pH monitoring and lime dosing</Text>
          </View>
        </View>
      </StripedHero>
      <View style={styles.body}>
        <Card>
          <IconTile name="cloudOff" color={colors.warningText} background={colors.warningSurface} />
          {reason === 'online' ? (
            <>
              <Text accessibilityRole="header" style={styles.heading}>
                Online access is not available yet
              </Text>
              <Text style={textStyles.body}>
                Field data is recorded on the team’s laptop at the field and does not need internet. Viewing it online
                requires the cloud connection, which has not been set up yet.
              </Text>
              <Text style={textStyles.body}>No robot or field data is shown here.</Text>
            </>
          ) : (
            <>
              <Text accessibilityRole="header" style={styles.heading}>
                This build is misconfigured
              </Text>
              <Text style={textStyles.body}>
                {'EXPO_PUBLIC_ROBOLIME_TARGET must be "field" or "online". Rebuild the app with a valid value.'}
              </Text>
            </>
          )}
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
  heading: { fontSize: 24, fontWeight: '800', color: colors.text },
});
