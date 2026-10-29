import type { CellReading, FieldResponse } from '@robolime/shared';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { FieldDataSource } from '../data/dataSource';
import { buildFieldMap, buildRunTiles, type MapCell, type MapMode } from '../data/fieldView';
import { colors, radius } from '../theme';
import { FieldMap, FieldMapLegend } from '../ui/FieldMap';
import { Icon, type IconName } from '../ui/Icon';
import { Card, textStyles } from '../ui/primitives';

/**
 * Run summary tiles and the run's field map (mockup page 5, D54). All values
 * come from the run's stored records (latest record per cell). "Expected after
 * lime" shows the robot's expected post-correction pH for limed cells and the
 * measured pH for the rest — the same rule the recommendation medians use.
 */
export function RunFieldSummary({
  dataSource,
  token,
  readings,
  onOpenCell,
}: {
  dataSource: FieldDataSource;
  token: string;
  readings: readonly CellReading[];
  onOpenCell: (reading: CellReading) => void;
}) {
  const [field, setField] = useState<FieldResponse | null>(null);
  const [mode, setMode] = useState<MapMode>('measured');

  useEffect(() => {
    let active = true;
    void dataSource.field(token).then((r) => {
      if (active && r.ok) setField(r.data);
    });
    return () => {
      active = false;
    };
  }, [dataSource, token]);

  const map = useMemo(
    () => buildFieldMap({ field: field?.field ?? null, cells: field?.cells ?? [], readings, mode, nextCellIndex: null }),
    [field, readings, mode],
  );
  const tiles = buildRunTiles(readings, field?.field.totalCells ?? map.totalCells);
  const open = (cell: MapCell) => {
    if (cell.reading !== null) onOpenCell(cell.reading);
  };

  return (
    <>
      <View style={styles.tiles}>
        <Tile label="Cells limed" value={tiles.cellsLimed} suffix={tiles.cellsLimedOf} icon="drop" tint={colors.thermo} />
        <Tile label="Lime commanded" value={tiles.limeCommanded} icon="table" tint={colors.info} />
        <Tile label="Median pH, measured" value={tiles.medianMeasured} icon="alert" tint={colors.danger} />
        <Tile label="Median expected pH" value={tiles.medianExpected} icon="check" tint={colors.brand} />
      </View>
      <Text style={textStyles.note}>
        Median expected pH uses expected post-correction pH for limed cells and measured pH for the rest. Lime is the
        commanded volume, not a measurement of liquid delivered.
      </Text>

      <Card style={styles.mapCard}>
        <View style={styles.toggle} accessibilityRole="tablist">
          {(['measured', 'expected'] as const).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === m }}
              onPress={() => setMode(m)}
              style={[styles.toggleItem, mode === m && styles.toggleOn]}
            >
              <Text style={[styles.toggleText, mode === m && styles.toggleTextOn]}>{m === 'measured' ? 'Measured pH' : 'Expected after lime'}</Text>
            </Pressable>
          ))}
        </View>
        <FieldMap view={map} onOpenCell={open} />
        <FieldMapLegend placeholderLayout={map.placeholderLayout} />
        <Text style={textStyles.note}>
          {mode === 'measured' ? 'Soil pH measured by the robot before liming.' : 'Expected post-correction pH reported by the robot (not a remeasurement).'}
        </Text>
      </Card>
    </>
  );
}

function Tile({ label, value, suffix, icon, tint }: { label: string; value: string; suffix?: string; icon: IconName; tint: string }) {
  return (
    <View style={styles.tile}>
      <View style={styles.tileTop}>
        <Text style={styles.tileLabel}>{label}</Text>
        <Icon name={icon} size={20} color={tint} />
      </View>
      <Text style={styles.tileValue}>
        {value}
        {suffix !== undefined && <Text style={styles.tileSuffix}> {suffix}</Text>}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { flexGrow: 1, flexBasis: 150, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, padding: 14, gap: 8 },
  tileTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  tileLabel: { fontSize: 15, color: colors.mutedText, flexShrink: 1 },
  tileValue: { fontSize: 30, fontWeight: '800', color: colors.text },
  tileSuffix: { fontSize: 17, fontWeight: '600', color: colors.mutedText },
  mapCard: { gap: 12 },
  toggle: { flexDirection: 'row', backgroundColor: colors.surfaceMuted, borderRadius: radius.button, padding: 4 },
  toggleItem: { flex: 1, borderRadius: radius.button - 4, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  toggleOn: { backgroundColor: colors.surface },
  toggleText: { fontSize: 16, fontWeight: '700', color: colors.mutedText },
  toggleTextOn: { color: colors.text },
});
