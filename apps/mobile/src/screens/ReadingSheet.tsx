import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ReadingRow } from '../data/resultsView';
import { colors, radius } from '../theme';
import { Icon, type IconName } from '../ui/Icon';
import { PH_BAND_LABEL, PH_BAND_PLACEHOLDER_NOTE, phBand } from '../config/phBands';
import { BAND_COLOR } from '../ui/FieldMap';
import { PhGauge, textStyles } from '../ui/primitives';

/**
 * One reading in detail, laid out after mockup page 4 (D50, D54). It opens from
 * a field-map cell or a reading in a run's list. The band label (Too acidic /
 * Near target / At target) uses the central configuration; its near-target
 * cut-off is a labelled placeholder (OPEN_ITEMS #4).
 */
export function ReadingSheet({ row, synthetic, onClose }: { row: ReadingRow; synthetic: boolean; onClose: () => void }) {
  const band = phBand(row.phValue);
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.headerRow}>
              <View style={styles.headerText}>
                <Text accessibilityRole="header" style={styles.title}>
                  {row.title}
                </Text>
                <Text style={textStyles.muted}>Measured {row.robotTime} (robot time)</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Close reading" onPress={onClose} style={styles.close}>
                <Icon name="close" size={22} color={colors.text} />
              </Pressable>
            </View>

            <View style={styles.phCard}>
              <View style={styles.phHeader}>
                <Text style={styles.phLabel}>Soil pH</Text>
                <View style={[styles.targetPill, { backgroundColor: band === 'at-target' ? colors.brandSoft : band === 'near-target' ? colors.warningSurface : colors.dangerSoft }]}>
                  <View style={[styles.bandDot, { backgroundColor: BAND_COLOR[band] }]} />
                  <Text style={[styles.targetText, { color: band === 'at-target' ? colors.brand : band === 'near-target' ? colors.warningText : colors.danger }]}>
                    {PH_BAND_LABEL[band]}
                  </Text>
                </View>
              </View>
              <Text style={styles.phValue}>{row.ph}</Text>
              <PhGauge value={row.phValue} />
              <Text style={textStyles.note}>{PH_BAND_PLACEHOLDER_NOTE}</Text>
            </View>

            <View style={styles.tiles}>
              <Tile icon="bolt" tint={colors.violet} value={row.ec} label="EC" />
              <Tile icon="drop" tint={colors.info} value={row.moisture} label="Moisture" />
              <Tile icon="thermometer" tint={colors.thermo} value={row.temperature} label="Soil temp." />
            </View>

            <View style={styles.doseBox}>
              <View>
                <Text style={styles.doseLabel}>Lime commanded</Text>
                <Text style={styles.doseValue}>{row.doseCommanded}</Text>
              </View>
              <View style={styles.doseRight}>
                <Text style={styles.doseLabel}>Expected post-correction pH</Text>
                <Text style={styles.doseValue}>{row.expectedPostCorrectionPh}</Text>
              </View>
            </View>

            <Text style={textStyles.note}>
              {synthetic ? 'Synthetic demo values. ' : ''}Commanded volume is not a measurement of liquid delivered.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Tile({ icon, tint, value, label }: { icon: IconName; tint: string; value: string; label: string }) {
  return (
    <View style={styles.tile}>
      <Icon name={icon} size={24} color={tint} />
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={textStyles.muted}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,24,18,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 32, borderTopRightRadius: 32, maxHeight: '90%', width: '100%', maxWidth: 640, alignSelf: 'center' },
  handle: { alignSelf: 'center', width: 64, height: 6, borderRadius: 3, backgroundColor: colors.border, marginTop: 12 },
  content: { padding: 22, gap: 16 },
  headerRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  headerText: { flex: 1, gap: 4 },
  title: { fontSize: 28, fontWeight: '800', color: colors.text },
  close: { width: 52, height: 52, borderRadius: 14, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  phCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, padding: 18, gap: 10 },
  phHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  phLabel: { fontSize: 18, fontWeight: '700', color: colors.text },
  targetPill: { borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 6 },
  bandDot: { width: 10, height: 10, borderRadius: 2 },
  targetText: { fontSize: 14, fontWeight: '800' },
  phValue: { fontSize: 64, fontWeight: '800', color: colors.text, letterSpacing: -1 },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, backgroundColor: colors.surfaceMuted, borderRadius: radius.tile, padding: 14, gap: 6 },
  tileValue: { fontSize: 22, fontWeight: '800', color: colors.text },
  doseBox: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.brandSoft, borderRadius: radius.tile, padding: 16, gap: 12 },
  doseRight: { alignItems: 'flex-end', flexShrink: 1 },
  doseLabel: { fontSize: 14, fontWeight: '700', color: colors.brand },
  doseValue: { fontSize: 26, fontWeight: '800', color: colors.text },
});
