import type { RunReadingsResponse } from '@robolime/shared';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type { FieldDataSource } from '../data/dataSource';
import { isSessionInvalid, type GatewayFailure } from '../data/gatewayClient';
import {
  OPEN_METEO_CREDIT,
  RUN_LIST_NOTE,
  buildReadingRows,
  buildRecommendationView,
  buildRunListItem,
  isRecommendationMissing,
  recommendationFailureMessage,
  runLoadFailureMessage,
  totalCommandedMl,
  type ReadingRow,
  type RecommendationView,
  type RunListItem,
} from '../data/resultsView';
import { connectionLabel } from '../data/statusView';
import { WIDE_BREAKPOINT, colors, radius } from '../theme';
import { Icon } from '../ui/Icon';
import { Card, IconTile, InfoBox, SecondaryButton, SyntheticBadge, textStyles } from '../ui/primitives';
import { ReadingSheet } from './ReadingSheet';
import { RunFieldSummary } from './RunFieldSummary';

interface ResultsScreenProps {
  dataSource: FieldDataSource;
  token: string;
  /** The gateway rejected the session (expired, revoked, unknown). */
  onSessionInvalid: () => void;
}

type Load<T> = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; data: T };

const failureMessage = (failure: GatewayFailure, source: string) => `${connectionLabel({ kind: 'unavailable', failure }, source)}.`;

/**
 * Results (CLAUDE.md §4 Screen 4, without the cell map, D29), laid out after
 * mockup page 5 (D50): the dosing runs stored on the gateway, then one run's
 * reading records, commanded lime and expected post-correction pH, and its
 * stored crop recommendation. Read-only; loaded on demand (no polling). Every
 * dosing run is listed, including incomplete ones, with an honest "status not
 * reported" label (D46). Verification runs are never listed. The mockup's
 * map, "cells limed x of y" and "cells done" counts are omitted (D29).
 */
export function ResultsScreen({ dataSource, token, onSessionInvalid }: ResultsScreenProps) {
  const [runs, setRuns] = useState<Load<RunListItem[]>>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  /** Bumped by "Try again" to request the list again. */
  const [attempt, setAttempt] = useState(0);

  // State changes only when the answer arrives (and not after unmount); "loading" comes from the
  // initial state or a retry. Returning from a run reloads the list.
  useEffect(() => {
    if (selected !== null) return undefined;
    let active = true;
    void dataSource.runs(token).then((result) => {
      if (!active) return;
      if (result.ok) {
        setRuns({ kind: 'loaded', data: result.data.runs.map(buildRunListItem) });
      } else if (isSessionInvalid(result.failure)) {
        onSessionInvalid();
      } else {
        setRuns({ kind: 'failed', message: failureMessage(result.failure, dataSource.sourceName) });
      }
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, token, selected, attempt]);

  if (selected !== null) {
    return (
      <RunDetail key={selected} dataSource={dataSource} token={token} runId={selected} onSessionInvalid={onSessionInvalid} onBack={() => setSelected(null)} />
    );
  }

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={textStyles.pageTitle}>
        Dosing runs
      </Text>
      <Card>
        {runs.kind === 'loading' && <Text style={textStyles.body}>Loading runs…</Text>}
        {runs.kind === 'failed' && (
          <Failed
            message={runs.message}
            onRetry={() => {
              setRuns({ kind: 'loading' });
              setAttempt((n) => n + 1);
            }}
          />
        )}
        {runs.kind === 'loaded' && runs.data.length === 0 && (
          <Text style={textStyles.body}>{dataSource.kind === 'cloud' ? 'No dosing runs have been synchronised to the cloud yet.' : 'No dosing runs have been recorded on this gateway yet.'}</Text>
        )}
        {runs.kind === 'loaded' &&
          runs.data.map((run) => (
            <Pressable
              key={run.id}
              accessibilityRole="button"
              accessibilityLabel={run.title}
              accessibilityHint={`${run.detail}. ${run.statusLabel}.`}
              onPress={() => setSelected(run.id)}
              style={({ pressed }) => [styles.runRow, pressed && styles.pressed]}
            >
              <IconTile name="leaf" color={colors.brand} background={colors.brandSoft} />
              <View style={styles.runText}>
                <Text style={styles.runTitle}>{run.title}</Text>
                <Text style={textStyles.muted}>{run.detail}</Text>
                <Text style={textStyles.note}>{run.statusLabel}</Text>
              </View>
              <Icon name="arrowRight" size={22} color={colors.mutedText} />
            </Pressable>
          ))}
        {runs.kind === 'loaded' && runs.data.length > 0 && <Text style={textStyles.note}>{RUN_LIST_NOTE}</Text>}
        <Text style={textStyles.note}>Source: {dataSource.description}.</Text>
      </Card>
    </View>
  );
}

function RunDetail({
  dataSource,
  token,
  runId,
  onSessionInvalid,
  onBack,
}: {
  dataSource: FieldDataSource;
  token: string;
  runId: string;
  onSessionInvalid: () => void;
  onBack: () => void;
}) {
  const [readings, setReadings] = useState<Load<RunReadingsResponse>>({ kind: 'loading' });
  const [recommendation, setRecommendation] = useState<Load<RecommendationView>>({ kind: 'loading' });
  /** Bumped by the matching "Try again"; each part reloads independently. */
  const [readingsAttempt, setReadingsAttempt] = useState(0);
  const [recommendationAttempt, setRecommendationAttempt] = useState(0);
  const [openReading, setOpenReading] = useState<ReadingRow | null>(null);
  const wide = useWindowDimensions().width >= WIDE_BREAKPOINT;

  // Each effect ignores its answer once it is superseded: after unmount (leaving
  // the run or the Results section), after a retry, or if the screen is left
  // because the session was rejected. RunDetail is keyed by run id, so another
  // run never shares these effects; the client also rejects an answer for a
  // different run (invalid-response).
  useEffect(() => {
    let active = true;
    void dataSource.runReadings(token, runId).then((result) => {
      if (!active) return;
      if (!result.ok && isSessionInvalid(result.failure)) {
        onSessionInvalid();
        return;
      }
      setReadings(result.ok ? { kind: 'loaded', data: result.data } : { kind: 'failed', message: runLoadFailureMessage(result.failure, dataSource.sourceName) });
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, token, runId, readingsAttempt]);

  useEffect(() => {
    let active = true;
    void dataSource.runRecommendation(token, runId).then((result) => {
      if (!active) return;
      if (result.ok) {
        setRecommendation({ kind: 'loaded', data: buildRecommendationView(result.data) });
      } else if (isSessionInvalid(result.failure)) {
        onSessionInvalid();
      } else if (isRecommendationMissing(result.failure)) {
        setRecommendation({ kind: 'loaded', data: { kind: 'none', message: recommendationFailureMessage(result.failure, dataSource.sourceName) } });
      } else {
        setRecommendation({ kind: 'failed', message: recommendationFailureMessage(result.failure, dataSource.sourceName) });
      }
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, token, runId, recommendationAttempt]);

  const run = readings.kind === 'loaded' ? buildRunListItem(readings.data.run) : null;
  const rows = readings.kind === 'loaded' ? buildReadingRows(readings.data.readings) : [];

  return (
    <View style={styles.section}>
      <SecondaryButton label="Back to dosing runs" onPress={onBack} />

      <View style={styles.titleBlock}>
        <View style={styles.titleRow}>
          <Text accessibilityRole="header" style={textStyles.pageTitle}>
            Run results
          </Text>
          {run?.isSynthetic === true && <SyntheticBadge />}
        </View>
        {run !== null && (
          <>
            <Text style={styles.runTitle}>{run.title}</Text>
            <Text style={textStyles.muted}>{run.detail}</Text>
            <Text style={textStyles.note}>{run.statusLabel}</Text>
          </>
        )}
      </View>

      {readings.kind === 'loaded' && readings.data.readings.length > 0 && (
        <RunFieldSummary
          dataSource={dataSource}
          token={token}
          readings={readings.data.readings}
          onOpenCell={(reading) => setOpenReading(buildReadingRows([reading])[0] ?? null)}
        />
      )}

      <Card>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Run readings
        </Text>
        {readings.kind === 'loading' && <Text style={textStyles.body}>Loading readings…</Text>}
        {readings.kind === 'failed' && (
          <Failed
            message={readings.message}
            onRetry={() => {
              setReadings({ kind: 'loading' });
              setReadingsAttempt((n) => n + 1);
            }}
          />
        )}
        {readings.kind === 'loaded' &&
          (readings.data.readings.length === 0 ? (
            <Text style={textStyles.body}>No reading records have been stored for this run.</Text>
          ) : (
            <>
              <View style={styles.statRow}>
                <View style={styles.statTile}>
                  <Text style={textStyles.label}>Total lime commanded in these records</Text>
                  <Text style={styles.statValue}>{totalCommandedMl(readings.data.readings)}</Text>
                </View>
                <View style={styles.statTile}>
                  <Text style={textStyles.label}>Reading records</Text>
                  <Text style={styles.statValue}>{readings.data.readings.length}</Text>
                </View>
              </View>
              <Text style={textStyles.note}>Commanded volumes reported by the robot, not measurements of liquid actually delivered.</Text>
              {wide ? <ReadingTable rows={rows} onOpen={setOpenReading} /> : rows.map((row) => <ReadingCard key={row.key} row={row} onOpen={setOpenReading} />)}
              <Text style={textStyles.note}>Tap a reading for details. Times are the robot’s clock.</Text>
            </>
          ))}
      </Card>

      {recommendation.kind === 'loading' && (
        <Card>
          <Text accessibilityRole="header" style={textStyles.sectionTitle}>
            Crop recommendation
          </Text>
          <Text style={textStyles.body}>Loading recommendation…</Text>
        </Card>
      )}
      {recommendation.kind === 'failed' && (
        <Card>
          <Text accessibilityRole="header" style={textStyles.sectionTitle}>
            Crop recommendation
          </Text>
          <Failed
            message={recommendation.message}
            onRetry={() => {
              setRecommendation({ kind: 'loading' });
              setRecommendationAttempt((n) => n + 1);
            }}
          />
        </Card>
      )}
      {recommendation.kind === 'loaded' && <Recommendation view={recommendation.data} />}

      {openReading !== null && (
        <ReadingSheet row={openReading} synthetic={run?.isSynthetic === true} onClose={() => setOpenReading(null)} />
      )}
    </View>
  );
}

/** Phone layout: one card per reading (all values labelled). */
function ReadingCard({ row, onOpen }: { row: ReadingRow; onOpen: (row: ReadingRow) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.title}
      accessibilityHint={`pH ${row.ph}. Opens this reading in detail.`}
      onPress={() => onOpen(row)}
      style={({ pressed }) => [styles.readingCard, pressed && styles.pressed]}
    >
      <Text style={styles.readingTitle}>{row.title}</Text>
      <View style={styles.phLine}>
        <Text style={textStyles.label}>pH</Text>
        <Text style={styles.phValue}>{row.ph}</Text>
      </View>
      <Row label="EC" value={row.ec} />
      <Row label="Moisture" value={row.moisture} />
      <Row label="Temperature" value={row.temperature} />
      <Row label="Lime commanded" value={row.doseCommanded} />
      <Row label="Expected post-correction pH" value={row.expectedPostCorrectionPh} />
      <Text style={textStyles.note}>Measured {row.robotTime} (robot time)</Text>
    </Pressable>
  );
}

/** Laptop layout: the web mockup's readings table, without the "needed lime" count (D29). */
function ReadingTable({ rows, onOpen }: { rows: readonly ReadingRow[]; onOpen: (row: ReadingRow) => void }) {
  const headers = ['Reading', 'pH', 'EC', 'Moisture', 'Temp.', 'Lime commanded', 'Expected post-correction pH'];
  return (
    <View>
      <View style={[styles.tr, styles.thRow]}>
        {headers.map((h, i) => (
          <Text key={h} style={[styles.th, i === 0 && styles.firstCol]}>
            {h}
          </Text>
        ))}
      </View>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          accessibilityRole="button"
          accessibilityLabel={`${row.title}, pH ${row.ph}`}
          onPress={() => onOpen(row)}
          style={({ pressed }) => [styles.tr, pressed && styles.pressed]}
        >
          <Text style={[styles.td, styles.firstCol, styles.tdStrong]}>{row.title}</Text>
          <Text style={[styles.td, styles.tdStrong]}>{row.ph}</Text>
          <Text style={styles.td}>{row.ec}</Text>
          <Text style={styles.td}>{row.moisture}</Text>
          <Text style={styles.td}>{row.temperature}</Text>
          <Text style={[styles.td, styles.tdStrong]}>{row.doseCommanded}</Text>
          <Text style={styles.td}>{row.expectedPostCorrectionPh}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Recommendation({ view }: { view: RecommendationView }) {
  if (view.kind === 'none') {
    return (
      <Card>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Crop recommendation
        </Text>
        <Text style={textStyles.body}>{view.message}</Text>
      </Card>
    );
  }
  const [medianPh, ...conditions] = view.inputs;
  const topScore = Math.max(...view.shortlist.map((c) => c.scoreValue), 0);
  return (
    <>
      <Card>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Field conditions (medians)
        </Text>
        {medianPh !== undefined && (
          <View style={styles.statTile}>
            <Text style={textStyles.label}>{medianPh.label}</Text>
            <Text style={styles.statValue}>{medianPh.value}</Text>
          </View>
        )}
        <View style={styles.conditions}>
          {conditions.map((input) => (
            <View key={input.label} style={styles.condition}>
              <Text style={textStyles.label}>{input.label}</Text>
              <Text style={styles.conditionValue}>{input.value}</Text>
            </View>
          ))}
        </View>
        <InfoBox tone="warning" icon="cloudOff">
          <Text style={styles.weather}>{view.weatherNote}</Text>
          {view.showOpenMeteoCredit && <Text style={styles.weather}>{OPEN_METEO_CREDIT}</Text>}
        </InfoBox>
      </Card>

      <View style={styles.cropsHeader}>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Top 5 crops for this field
        </Text>
        <Text style={textStyles.muted}>
          Best crop in each category, ranked by rule score. {view.ruleSetLabel}, computed {view.computedAt}.
        </Text>
      </View>
      {view.warning !== null && (
        <InfoBox tone="danger" icon="alert">
          <Text style={styles.warning}>{view.warning}</Text>
        </InfoBox>
      )}
      {view.shortlist.length === 0 ? (
        <Card>
          <Text style={textStyles.body}>No crop was shortlisted.</Text>
        </Card>
      ) : (
        view.shortlist.map((crop) => (
          <Card key={`${crop.rank}`}>
            <View style={styles.cropRow}>
              <View style={[styles.rank, crop.rank === 1 && styles.rankFirst]}>
                <Text style={[styles.rankText, crop.rank === 1 && { color: colors.onDark }]}>{crop.rank}</Text>
              </View>
              <View style={styles.cropText}>
                <Text style={styles.cropName}>{crop.cropName}</Text>
                <Text style={textStyles.muted}>{crop.category}</Text>
              </View>
              <Text style={styles.cropScore} accessibilityLabel={`Score ${crop.score}`}>
                {crop.score}
              </Text>
            </View>
            <View style={styles.scoreTrack} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <View style={[styles.scoreFill, { width: `${topScore > 0 ? Math.max(0, (crop.scoreValue / topScore) * 100) : 0}%` }]} />
            </View>
            {crop.reasons.map((reason, i) => (
              <Text key={i} style={textStyles.muted}>
                {reason}
              </Text>
            ))}
          </Card>
        ))
      )}
      <Text style={textStyles.note}>Score bars are relative to the top-ranked crop.</Text>
    </>
  );
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <>
      <Text style={styles.fault}>{message}</Text>
      <SecondaryButton label="Try again" onPress={onRetry} />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 16 },
  titleBlock: { gap: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  pressed: { opacity: 0.7 },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 },
  runText: { flex: 1, gap: 3 },
  runTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  statTile: { flexGrow: 1, flexBasis: 200, backgroundColor: colors.surfaceMuted, borderRadius: radius.tile, padding: 14, gap: 6 },
  statValue: { fontSize: 28, fontWeight: '800', color: colors.text },
  readingCard: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, gap: 6 },
  readingTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  phLine: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  phValue: { fontSize: 30, fontWeight: '800', color: colors.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  rowLabel: { fontSize: 16, color: colors.mutedText, flexShrink: 1 },
  rowValue: { fontSize: 18, fontWeight: '700', color: colors.text },
  tr: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderTopWidth: 1, borderTopColor: colors.border },
  thRow: { borderTopWidth: 0 },
  th: { flex: 1, fontSize: 14, color: colors.mutedText, paddingVertical: 8, paddingRight: 8 },
  td: { flex: 1, fontSize: 16, color: colors.text, paddingVertical: 10, paddingRight: 8 },
  tdStrong: { fontWeight: '800' },
  firstCol: { flex: 1.4 },
  conditions: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  condition: { flexBasis: 180, flexGrow: 1, gap: 4 },
  conditionValue: { fontSize: 22, fontWeight: '800', color: colors.text },
  weather: { fontSize: 15, lineHeight: 21, color: colors.warningText, fontWeight: '600' },
  cropsHeader: { gap: 4, marginTop: 4 },
  warning: { fontSize: 16, lineHeight: 22, color: colors.danger, fontWeight: '700' },
  cropRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  rank: { width: 48, height: 48, borderRadius: 12, backgroundColor: colors.brandSoft, alignItems: 'center', justifyContent: 'center' },
  rankFirst: { backgroundColor: colors.brand },
  rankText: { fontSize: 20, fontWeight: '800', color: colors.brand },
  cropText: { flex: 1, gap: 2 },
  cropName: { fontSize: 18, fontWeight: '800', color: colors.text },
  cropScore: { fontSize: 26, fontWeight: '800', color: colors.text },
  scoreTrack: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceMuted, overflow: 'hidden' },
  scoreFill: { height: 8, borderRadius: 4, backgroundColor: colors.brandBright },
  fault: { fontSize: 18, fontWeight: '700', color: colors.danger },
});
