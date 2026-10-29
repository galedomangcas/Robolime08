import type { CellReading, FieldResponse, RobotStatus } from '@robolime/shared';
import { formatMoisturePercent, formatPh, formatTemperatureC, formatVolumeMl } from '@robolime/shared';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { phBand, PH_BAND_LABEL } from '../config/phBands';
import type { FieldDataSource } from '../data/dataSource';
import { buildFieldMap, buildLimeSummary, cellLabel, latestPerCell, type MapCell } from '../data/fieldView';
import { isSessionInvalid } from '../data/gatewayClient';
import { buildReadingRows, type ReadingRow } from '../data/resultsView';
import { colors, radius } from '../theme';
import { BAND_COLOR, FieldMap, FieldMapLegend } from '../ui/FieldMap';
import { Icon } from '../ui/Icon';
import { Card, IconTile, SyntheticBadge, textStyles } from '../ui/primitives';
import { ReadingSheet } from './ReadingSheet';

type Load<T> = { kind: 'loading' } | { kind: 'loaded'; data: T } | { kind: 'failed'; message: string };

/**
 * The Field section (mockup page 3 and the laptop page; D54): field header,
 * the "needed lime" summary computed from the records, and the field map of
 * the latest dosing run, coloured by measured pH. Tapping a measured cell
 * opens its readings. Values come only from stored records; nothing is
 * invented. The map follows cell numbers, never GPS.
 */
export function FieldOverview({
  dataSource,
  token,
  status,
  wide,
  onSessionInvalid,
}: {
  dataSource: FieldDataSource;
  token: string;
  status: RobotStatus | null;
  wide: boolean;
  onSessionInvalid: () => void;
}) {
  const [field, setField] = useState<Load<FieldResponse | null>>({ kind: 'loading' });
  const [readings, setReadings] = useState<Load<{ readings: CellReading[]; synthetic: boolean; runTitle: string } | null>>({ kind: 'loading' });
  const [open, setOpen] = useState<ReadingRow | null>(null);

  useEffect(() => {
    let active = true;
    void dataSource.field(token).then((r) => {
      if (!active) return;
      if (!r.ok && isSessionInvalid(r.failure)) return onSessionInvalid();
      if (r.ok) setField({ kind: 'loaded', data: r.data });
      else if (r.failure.kind === 'api' && (r.failure.code === 'NO_ACTIVE_FIELD' || r.failure.code === 'NOT_FOUND')) setField({ kind: 'loaded', data: null });
      else setField({ kind: 'failed', message: 'The field could not be loaded.' });
    });
    void dataSource.runs(token).then(async (r) => {
      if (!active) return;
      if (!r.ok) {
        if (isSessionInvalid(r.failure)) return onSessionInvalid();
        setReadings({ kind: 'failed', message: 'Readings could not be loaded.' });
        return;
      }
      const latest = r.data.runs[0];
      if (latest === undefined) return setReadings({ kind: 'loaded', data: null });
      const rr = await dataSource.runReadings(token, latest.id);
      if (!active) return;
      if (rr.ok) setReadings({ kind: 'loaded', data: { readings: rr.data.readings, synthetic: rr.data.run.isSynthetic, runTitle: latest.sourceRunId } });
      else setReadings({ kind: 'failed', message: 'Readings could not be loaded.' });
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, token]);

  const fieldData = field.kind === 'loaded' ? field.data : null;
  const records = useMemo(() => (readings.kind === 'loaded' && readings.data !== null ? readings.data.readings : []), [readings]);
  const nextCellIndex =
    status !== null && status.state === 'WORKING' && status.cellsCompleted < status.totalCells ? status.cellsCompleted : null;
  const map = useMemo(
    () => buildFieldMap({ field: fieldData?.field ?? null, cells: fieldData?.cells ?? [], readings: records, mode: 'measured', nextCellIndex }),
    [fieldData, records, nextCellIndex],
  );
  const summary = buildLimeSummary(records, fieldData?.field.totalCells ?? map.totalCells);
  const synthetic = (readings.kind === 'loaded' && readings.data?.synthetic === true) || fieldData?.field.isSynthetic === true;
  const openCell = (cell: MapCell) => {
    if (cell.reading !== null) setOpen(buildReadingRows([cell.reading])[0] ?? null);
  };

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={textStyles.pageTitle}>
          {fieldData?.field.name ?? 'Field not provisioned'}
        </Text>
        {synthetic && <SyntheticBadge />}
      </View>
      <Text style={textStyles.muted}>
        {fieldData === null
          ? field.kind === 'loading'
            ? 'Loading field…'
            : 'Placeholder layout until the operator provisions the surveyed field on the gateway.'
          : [
              fieldData.field.locationLabel,
              fieldData.field.areaSquareMeters === null ? null : `${fieldData.field.areaSquareMeters} m²`,
              `${fieldData.field.totalCells ?? fieldData.cells.length} cells`,
              `${fieldData.field.cellSizeMeters} m × ${fieldData.field.cellSizeMeters} m`,
            ]
              .filter((x) => x !== null)
              .join(' · ')}
      </Text>
    </View>
  );

  const summaryCard = (
    <Card style={styles.summaryCard}>
      <IconTile name="drop" color={colors.thermo} background={colors.dangerSoft} />
      <View style={styles.summaryText}>
        <Text style={styles.summaryHeadline}>{readings.kind === 'loading' ? 'Loading readings…' : summary.headline}</Text>
        <Text style={textStyles.muted}>{readings.kind === 'failed' ? readings.message : summary.detail}</Text>
      </View>
    </Card>
  );

  const mapCard = (
    <Card style={styles.mapCard}>
      <View style={styles.mapHeader}>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Field map · soil pH
        </Text>
        <Text style={textStyles.muted}>{records.length > 0 ? 'Tap a cell for readings' : 'No readings yet'}</Text>
      </View>
      <FieldMap view={map} onOpenCell={openCell} />
      <FieldMapLegend placeholderLayout={map.placeholderLayout} />
      <Text style={textStyles.note}>
        {readings.kind === 'loaded' && readings.data !== null ? `Latest dosing run ${readings.data.runTitle}. ` : ''}
        Robot reports after each cell, so status can be one cell behind. Cells are placed by cell number, not GPS.
        {nextCellIndex !== null ? ' "Next" assumes the robot visits cells in number order (placeholder).' : ''}
      </Text>
    </Card>
  );

  return (
    <View style={styles.body}>
      {header}
      {summaryCard}
      {wide ? (
        <View style={styles.wideRow}>
          <Card style={styles.tableCard}>
            <CellTable readings={records} onOpen={(r) => setOpen(buildReadingRows([r])[0] ?? null)} total={map.totalCells} />
          </Card>
          <View style={styles.wideMap}>{mapCard}</View>
        </View>
      ) : (
        mapCard
      )}
      {open !== null && <ReadingSheet row={open} synthetic={synthetic} onClose={() => setOpen(null)} />}
    </View>
  );
}

/** Laptop page: one row per measured cell (latest record), with a band swatch and label. */
function CellTable({ readings, onOpen, total }: { readings: readonly CellReading[]; onOpen: (r: CellReading) => void; total: number }) {
  const latest = [...latestPerCell(readings).values()].sort((a, b) => a.cellIndex - b.cellIndex);
  const limed = latest.filter((r) => r.doseVolumeMl > 0).length;
  return (
    <View style={styles.table}>
      <View style={styles.tableTitleRow}>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Cell readings
        </Text>
        {latest.length > 0 && (
          <View style={styles.limePill}>
            <Text style={styles.limePillText}>
              {limed} of {latest.length} needed lime
            </Text>
          </View>
        )}
      </View>
      <View style={[styles.tr, styles.th]}>
        {['Cell', 'pH', 'Moisture', 'Temp.', 'Lime'].map((h) => (
          <Text key={h} style={[styles.td, styles.thText]}>
            {h}
          </Text>
        ))}
      </View>
      {latest.length === 0 && <Text style={textStyles.body}>No readings yet.</Text>}
      {latest.map((r) => {
        const band = phBand(r.ph);
        return (
          <Pressable key={r.cellIndex} accessibilityRole="button" accessibilityLabel={`${cellLabel(r.cellIndex)} details`} onPress={() => onOpen(r)} style={styles.tr}>
            <Text style={[styles.td, styles.bold]}>{cellLabel(r.cellIndex)}</Text>
            <View style={[styles.td, styles.phCell]}>
              <View style={[styles.dot, { backgroundColor: BAND_COLOR[band] }]} />
              <Text style={styles.bold} accessibilityLabel={`${formatPh(r.ph)}, ${PH_BAND_LABEL[band]}`}>
                {formatPh(r.ph)}
              </Text>
            </View>
            <Text style={styles.td}>{formatMoisturePercent(r.moisturePercent)}</Text>
            <Text style={styles.td}>{formatTemperatureC(r.temperatureC)}</Text>
            <Text style={[styles.td, styles.bold]}>{r.doseVolumeMl > 0 ? formatVolumeMl(r.doseVolumeMl) : 'none'}</Text>
          </Pressable>
        );
      })}
      {latest.length > 0 && latest.length < total && (
        <Text style={textStyles.note}>
          <Icon name="alert" size={14} color={colors.mutedText} /> {total - latest.length} cells not measured yet. Times are the robot clock.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16 },
  header: { gap: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  summaryCard: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  summaryText: { flex: 1, gap: 2 },
  summaryHeadline: { fontSize: 20, fontWeight: '800', color: colors.text },
  mapCard: { gap: 12 },
  mapHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 6 },
  wideRow: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  tableCard: { flex: 1 },
  wideMap: { flex: 1.3 },
  table: { gap: 2 },
  tableTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  limePill: { backgroundColor: colors.dangerSoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 4 },
  limePillText: { color: colors.danger, fontWeight: '800', fontSize: 14 },
  tr: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, minHeight: 44 },
  th: { paddingVertical: 6 },
  thText: { color: colors.mutedText, fontWeight: '700' },
  td: { flex: 1, fontSize: 16, color: colors.text },
  phCell: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 12, height: 12, borderRadius: 3 },
  bold: { fontWeight: '800', fontSize: 16, color: colors.text },
});
