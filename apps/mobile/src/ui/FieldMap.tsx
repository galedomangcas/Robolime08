import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PH_BAND_LABEL, PH_BAND_PLACEHOLDER_NOTE, PH_BAND_RANGE, type PhBand } from '../config/phBands';
import type { FieldMapView, MapCell } from '../data/fieldView';
import { colors, radius } from '../theme';

/**
 * Field map, laid out after mockup pages 3–5 and the laptop page (D54).
 * Cells are placed by cell index (never GPS). Every band has a text label as
 * well as a colour, and "too acidic" also carries stripes, so colour is never
 * the only signal. The near-target cut-off is a labelled placeholder (#4).
 */
export const BAND_COLOR: Record<PhBand, string> = {
  'too-acidic': '#C8412A',
  'near-target': '#E9B21F',
  'at-target': '#2E9E52',
};
const BAND_TEXT: Record<PhBand, string> = { 'too-acidic': '#FFFFFF', 'near-target': '#2B2105', 'at-target': '#FFFFFF' };

const ZOOM_STEPS = [0.8, 1, 1.25, 1.5] as const;
const BASE_CELL = 64;
const GAP = 6;

export function FieldMap({
  view,
  onOpenCell,
  compact = false,
}: {
  view: FieldMapView;
  onOpenCell?: (cell: MapCell) => void;
  /** Smaller cells and no zoom buttons (thumbnails). */
  compact?: boolean;
}) {
  const [zoomIndex, setZoomIndex] = useState(1);
  const [width, setWidth] = useState(0);
  // At zoom 1 the whole grid fits the card width; zooming in scrolls sideways.
  const fit = width > 0 && view.columns > 0 ? (width - 32 - 12 - GAP * (view.columns - 1)) / view.columns : BASE_CELL;
  const size = Math.max(32, Math.round(Math.min(BASE_CELL, fit) * (compact ? 0.8 : (ZOOM_STEPS[zoomIndex] ?? 1))));
  const grid: (MapCell | null)[][] = Array.from({ length: view.rows }, () => Array.from({ length: view.columns }, () => null));
  for (const c of view.cells) {
    const row = grid[c.row];
    if (row !== undefined) row[c.column] = c;
  }

  return (
    <View>
      {!compact && (
        <View style={styles.zoom}>
          <ZoomButton label="−" a11y="Zoom out" disabled={zoomIndex <= 0} onPress={() => setZoomIndex((i) => Math.max(0, i - 1))} />
          <ZoomButton label="+" a11y="Zoom in" disabled={zoomIndex >= ZOOM_STEPS.length - 1} onPress={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))} />
        </View>
      )}
    <View style={styles.field} accessibilityLabel="Field map" onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Stripes />
      <ScrollView horizontal contentContainerStyle={styles.scroll} showsHorizontalScrollIndicator={false}>
        <View style={styles.frame}>
          {grid.map((row, r) => (
            <View key={r} style={styles.row}>
              {row.map((cell, c) =>
                cell === null ? (
                  <View key={c} style={{ width: size, height: size }} />
                ) : (
                  <CellTile key={c} cell={cell} size={size} onOpen={onOpenCell} />
                ),
              )}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
    </View>
  );
}

function CellTile({ cell, size, onOpen }: { cell: MapCell; size: number; onOpen?: (cell: MapCell) => void }) {
  const measured = cell.band !== null;
  const a11y = measured
    ? `${cell.label}, pH ${cell.valueText}, ${PH_BAND_LABEL[cell.band as PhBand]}${cell.limed ? ', limed' : ''}`
    : `${cell.label}, ${cell.isNext ? 'next cell (assumed order)' : 'not measured yet'}`;
  const content = (
    <View
      style={[
        styles.cell,
        { width: size, height: size },
        measured ? { backgroundColor: BAND_COLOR[cell.band as PhBand] } : styles.cellEmpty,
        cell.isNext && styles.cellNext,
      ]}
    >
      {cell.band === 'too-acidic' && <Stripes light />}
      {measured ? (
        <>
          <Text style={[styles.value, { color: BAND_TEXT[cell.band as PhBand], fontSize: Math.max(13, size * 0.3) }]}>{cell.valueText}</Text>
          <Text style={[styles.label, { color: BAND_TEXT[cell.band as PhBand] }]}>{cell.label}</Text>
        </>
      ) : (
        <>
          {cell.isNext && <Text style={styles.nextText}>Next</Text>}
          <Text style={styles.labelEmpty}>{cell.label}</Text>
        </>
      )}
    </View>
  );
  if (onOpen === undefined || !measured) {
    return (
      <View accessible accessibilityLabel={a11y}>
        {content}
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${a11y}. Open readings`} onPress={() => onOpen(cell)}>
      {content}
    </Pressable>
  );
}

function ZoomButton({ label, a11y, disabled, onPress }: { label: string; a11y: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.zoomButton, disabled && styles.zoomDisabled]}
    >
      <Text style={styles.zoomText}>{label}</Text>
    </Pressable>
  );
}

/** Decorative diagonal stripes (no data meaning on the field; "too acidic" marker on cells). */
function Stripes({ light = false }: { light?: boolean }) {
  return (
    <View pointerEvents="none" style={styles.stripes} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: light ? 6 : 14 }, (_, i) => (
        <View
          key={i}
          style={[
            styles.stripe,
            { left: `${(i - 2) * (light ? 22 : 9)}%` },
            light ? styles.stripeLight : styles.stripeField,
          ]}
        />
      ))}
    </View>
  );
}

export function FieldMapLegend({ placeholderLayout }: { placeholderLayout: boolean }) {
  const bands: PhBand[] = ['too-acidic', 'near-target', 'at-target'];
  return (
    <View style={styles.legend}>
      {bands.map((b) => (
        <View key={b} style={styles.legendRow}>
          <View style={[styles.swatch, { backgroundColor: BAND_COLOR[b] }]}>{b === 'too-acidic' && <Stripes light />}</View>
          <Text style={styles.legendText}>
            {PH_BAND_LABEL[b]} · {PH_BAND_RANGE[b]}
          </Text>
        </View>
      ))}
      <Text style={styles.legendNote}>{PH_BAND_PLACEHOLDER_NOTE}</Text>
      {placeholderLayout && <Text style={styles.legendNote}>Placeholder layout: no surveyed field grid is provisioned yet.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { backgroundColor: '#3F6A2E', borderRadius: radius.card, overflow: 'hidden', paddingVertical: 18, minHeight: 160 },
  scroll: { paddingHorizontal: 16, flexGrow: 1, justifyContent: 'center' },
  frame: { borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 14, padding: 6, gap: GAP },
  row: { flexDirection: 'row', gap: GAP },
  cell: { borderRadius: 9, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  cellEmpty: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.55)', backgroundColor: 'rgba(0,0,0,0.12)' },
  cellNext: { borderWidth: 3, borderStyle: 'solid', borderColor: '#FFFFFF' },
  value: { fontWeight: '800' },
  label: { fontSize: 11, fontWeight: '700' },
  labelEmpty: { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.9)' },
  nextText: { fontSize: 11, fontWeight: '800', color: '#FFFFFF' },
  zoom: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginBottom: 8 },
  zoomButton: { width: 48, height: 48, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  zoomDisabled: { opacity: 0.45 },
  zoomText: { fontSize: 26, fontWeight: '700', color: colors.text },
  stripes: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
  stripe: { position: 'absolute', top: '-50%', width: 8, height: '200%', transform: [{ rotate: '35deg' }] },
  stripeField: { backgroundColor: 'rgba(255,255,255,0.05)', width: 14 },
  stripeLight: { backgroundColor: 'rgba(255,255,255,0.18)' },
  legend: { gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  swatch: { width: 22, height: 22, borderRadius: 6, overflow: 'hidden' },
  legendText: { fontSize: 15, fontWeight: '700', color: colors.text },
  legendNote: { fontSize: 13, color: colors.mutedText },
});
