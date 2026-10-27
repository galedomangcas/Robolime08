import { StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '../theme';
import { Icon, type IconName } from '../ui/Icon';
import { Card, IconTile, InfoBox, textStyles } from '../ui/primitives';

/**
 * Research exports, laid out after mockup page 6 (D50). The CSV exports exist
 * only as a command on the field laptop (`npm run export:csv`, D32); the local
 * API has no export route, so the download buttons are shown as unavailable
 * rather than invented. No counts or delivery percentages are shown: the API
 * does not expose them, and the first-attempt ratio is not computed until the
 * attempt-count base is confirmed (OPEN_ITEMS #15).
 */
const EXPORTS: readonly { title: string; detail: string; icon: IconName; tint: string; background: string }[] = [
  {
    title: 'Readings per run',
    detail: 'Every reading record of one run: values, commanded dose, expected pH, GPS, flags, attempt count.',
    icon: 'table',
    tint: colors.brand,
    background: colors.brandSoft,
  },
  {
    title: 'Dosing + verification pairs',
    detail: 'Pairs a dosing run with its verification run by cell index, for paired tests and Bland–Altman. Missing pairs are reported.',
    icon: 'swap',
    tint: colors.violet,
    background: '#ECE6FB',
  },
  {
    title: 'Radio delivery',
    detail: 'First-attempt delivery and post-retry completeness, kept as two separate measures with their counts.',
    icon: 'signal',
    tint: colors.info,
    background: '#E3EDFB',
  },
];

export function ExportsScreen() {
  return (
    <View style={styles.body}>
      <View style={styles.intro}>
        <Text accessibilityRole="header" style={textStyles.pageTitle}>
          Research exports
        </Text>
        <Text style={textStyles.muted}>CSV files built from the field laptop’s records. Works without internet.</Text>
      </View>

      <InfoBox tone="warning" icon="download">
        <Text style={styles.boxTitle}>Downloads are not available in the app yet</Text>
        <Text style={styles.boxText}>
          On the field laptop, run “npm run export:csv” in the gateway folder to create these files.
        </Text>
      </InfoBox>

      {EXPORTS.map((e) => (
        <Card key={e.title}>
          <View style={styles.row}>
            <IconTile name={e.icon} color={e.tint} background={e.background} />
            <View style={styles.rowText}>
              <Text style={styles.title}>{e.title}</Text>
              <Text style={textStyles.muted}>{e.detail}</Text>
            </View>
            <View
              accessibilityRole="button"
              accessibilityLabel={`Download ${e.title}`}
              accessibilityState={{ disabled: true }}
              style={styles.download}
            >
              <Icon name="download" size={24} color="#7D867B" />
            </View>
          </View>
        </Card>
      ))}

      <Text style={textStyles.note}>Research-only: verification pH appears in exports, never on farmer screens.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16 },
  intro: { gap: 6 },
  boxTitle: { fontSize: 16, fontWeight: '800', color: colors.warningText },
  boxText: { fontSize: 15, lineHeight: 21, color: colors.warningText },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  rowText: { flex: 1, gap: 4 },
  title: { fontSize: 18, fontWeight: '800', color: colors.text },
  download: { width: 56, height: 56, borderRadius: radius.button, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
});
