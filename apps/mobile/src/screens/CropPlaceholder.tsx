import { StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '../theme';
import { Card, InfoBox, textStyles } from '../ui/primitives';

/**
 * DEMO PLACEHOLDER for "Top 5 crops for this field" (mockup page 5, D55),
 * shown only where no stored recommendation exists. It contains NO crop
 * names, scores or ranges: the sourced Batangas candidates and suitability
 * ranges have not been supplied (OPEN_ITEMS #5), and none are invented. It
 * is never presented as a recommendation.
 */
export const CROP_PLACEHOLDER_COUNT = 5;

export function CropPlaceholder() {
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Top 5 crops for this field
        </Text>
        <Text style={textStyles.muted}>Best crop in each category, ranked by rule score.</Text>
      </View>
      <InfoBox tone="danger" icon="alert">
        <Text style={styles.warning}>
          Placeholder: no crop recommendation yet. Crop names, scores and reasons will appear here once the research team
          supplies the sourced Batangas crop list and suitability ranges, and a dosing run is scored.
        </Text>
      </InfoBox>
      {Array.from({ length: CROP_PLACEHOLDER_COUNT }, (_, i) => (
        <Card key={i}>
          <View style={styles.row} accessible accessibilityLabel={`Placeholder crop slot ${i + 1}, no recommendation yet`}>
            <View style={[styles.rank, i === 0 && styles.rankFirst]}>
              <Text style={[styles.rankText, i === 0 && { color: colors.onDark }]}>{i + 1}</Text>
            </View>
            <View style={styles.text}>
              <Text style={styles.name}>Crop placeholder {i + 1}</Text>
              <Text style={textStyles.muted}>Category to be sourced</Text>
            </View>
            <Text style={styles.score}>—</Text>
          </View>
          <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
          <Text style={textStyles.muted}>Reason will be traced to the scoring rules and the field’s input values.</Text>
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  header: { gap: 4 },
  warning: { fontSize: 15, lineHeight: 21, color: colors.danger },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  rank: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  rankFirst: { backgroundColor: '#9AA597' },
  rankText: { fontSize: 18, fontWeight: '800', color: colors.mutedText },
  text: { flex: 1, gap: 2 },
  name: { fontSize: 18, fontWeight: '800', color: colors.mutedText },
  score: { fontSize: 24, fontWeight: '800', color: colors.mutedText },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, marginVertical: 10 },
});
