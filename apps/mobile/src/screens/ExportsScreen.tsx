import type { ExportCsvResponse, ExportKind, ExportRunSummary } from '@robolime/shared';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { FieldDataSource } from '../data/dataSource';
import { downloadCsv } from '../data/download';
import { isSessionInvalid } from '../data/gatewayClient';
import { formatLocalTimestamp } from '../data/statusView';
import { colors, radius } from '../theme';
import { Icon, type IconName } from '../ui/Icon';
import { Card, IconTile, InfoBox, textStyles } from '../ui/primitives';

/**
 * Research exports, laid out after mockup page 6 (D50, D54). On the field
 * laptop the three CSVs are built by the gateway from its own records (the
 * same files as `npm run export:csv`) and downloaded here. Verification runs
 * appear only in this research area. Figures shown are copied from the
 * export itself; the first-attempt delivery ratio is not computed until the
 * attempt-count base is confirmed (OPEN_ITEMS #15). The online build has no
 * export path: exports stay on the field laptop.
 */
const EXPORTS: readonly { kind: ExportKind; title: string; detail: string; icon: IconName; tint: string; background: string }[] = [
  { kind: 'readings', title: 'Readings per run', detail: 'Values, dose, expected pH, GPS, flags, attempt count.', icon: 'table', tint: colors.brand, background: colors.brandSoft },
  { kind: 'paired', title: 'Dosing + verification pairs', detail: 'For paired tests and Bland–Altman. Missing pairs are reported.', icon: 'swap', tint: colors.violet, background: '#ECE6FB' },
  { kind: 'delivery', title: 'Radio delivery', detail: 'Two separate measures, never merged.', icon: 'signal', tint: colors.info, background: '#E3EDFB' },
];

type Results = Partial<Record<ExportKind, { ok: true; data: ExportCsvResponse; saved: boolean } | { ok: false; message: string }>>;

const runLabel = (r: ExportRunSummary) =>
  `${r.firstRobotRecordedAt === null ? 'No readings' : formatLocalTimestamp(r.firstRobotRecordedAt).slice(0, 10)} · ${r.sourceRunId}`;

export function ExportsScreen({ dataSource, token, onSessionInvalid }: { dataSource: FieldDataSource; token: string; onSessionInvalid: () => void }) {
  const exportsApi = dataSource.exports;
  const [runs, setRuns] = useState<ExportRunSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dosingId, setDosingId] = useState<string | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [results, setResults] = useState<Results>({});
  const [busy, setBusy] = useState<ExportKind | null>(null);

  useEffect(() => {
    if (exportsApi === null) return;
    let active = true;
    void exportsApi.runs(token).then((r) => {
      if (!active) return;
      if (!r.ok) {
        if (isSessionInvalid(r.failure)) return onSessionInvalid();
        setLoadError('Runs could not be loaded from the field gateway.');
        return;
      }
      setRuns(r.data.runs);
      setDosingId(r.data.runs.find((x) => x.runType === 'dosing')?.id ?? null);
      setVerificationId(r.data.runs.find((x) => x.runType === 'verification')?.id ?? null);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportsApi, token]);

  if (exportsApi === null) {
    return (
      <View style={styles.body}>
        <Intro text="CSV files are built on the field laptop from its own records, not from this online view." />
        <InfoBox tone="warning" icon="download">
          <Text style={styles.boxTitle}>Exports are available on the field laptop</Text>
          <Text style={styles.boxText}>Open the field app on the laptop (Exports), or run “npm run export:csv” in the gateway folder.</Text>
        </InfoBox>
        {EXPORTS.map((e) => (
          <ExportCard key={e.kind} spec={e} disabled onPress={() => undefined} />
        ))}
      </View>
    );
  }

  const dosing = runs?.filter((r) => r.runType === 'dosing') ?? [];
  const verification = runs?.filter((r) => r.runType === 'verification') ?? [];

  const run = async (kind: ExportKind) => {
    if (dosingId === null || busy !== null) return;
    if (kind === 'paired' && verificationId === null) return;
    setBusy(kind);
    const r = await exportsApi.csv(token, kind === 'paired' ? { kind, runId: dosingId, verificationRunId: verificationId ?? '' } : { kind, runId: dosingId });
    setBusy(null);
    if (!r.ok) {
      if (isSessionInvalid(r.failure)) return onSessionInvalid();
      setResults((p) => ({ ...p, [kind]: { ok: false, message: 'The export could not be built. Check the selected runs and try again.' } }));
      return;
    }
    const saved = downloadCsv(r.data.filename, r.data.csv);
    setResults((p) => ({ ...p, [kind]: { ok: true, data: r.data, saved } }));
  };

  return (
    <View style={styles.body}>
      <Intro text="CSV files built from the field laptop’s records. Works without internet." />
      {loadError !== null && (
        <InfoBox tone="warning" icon="alert">
          <Text style={styles.boxText}>{loadError}</Text>
        </InfoBox>
      )}
      {runs !== null && dosing.length === 0 && <Text style={textStyles.body}>No dosing runs are stored on this gateway yet.</Text>}

      <RunPicker label="Dosing run" runs={dosing} selected={dosingId} onSelect={setDosingId} />

      {EXPORTS.map((e) => {
        const res = results[e.kind];
        return (
          <ExportCard key={e.kind} spec={e} disabled={dosingId === null || (e.kind === 'paired' && verificationId === null)} busy={busy === e.kind} onPress={() => void run(e.kind)}>
            {e.kind === 'paired' && <RunPicker label="Verification run" runs={verification} selected={verificationId} onSelect={setVerificationId} />}
            {res !== undefined && !res.ok && <Text style={styles.error}>{res.message}</Text>}
            {res !== undefined && res.ok && <ExportResult result={res.data} saved={res.saved} />}
          </ExportCard>
        );
      })}

      <Text style={textStyles.note}>Research-only: verification pH appears in exports, never on farmer screens.</Text>
    </View>
  );
}

function Intro({ text }: { text: string }) {
  return (
    <View style={styles.intro}>
      <Text accessibilityRole="header" style={textStyles.pageTitle}>
        Research exports
      </Text>
      <Text style={textStyles.muted}>{text}</Text>
    </View>
  );
}

function RunPicker({ label, runs, selected, onSelect }: { label: string; runs: readonly ExportRunSummary[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <View style={styles.picker}>
      <Text style={styles.pickerLabel}>{label}</Text>
      {runs.length === 0 ? (
        <Text style={textStyles.muted}>None stored yet.</Text>
      ) : (
        <View style={styles.chips}>
          {runs.map((r) => (
            <Pressable
              key={r.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: r.id === selected }}
              onPress={() => onSelect(r.id)}
              style={[styles.chip, r.id === selected && styles.chipOn]}
            >
              <Text style={[styles.chipText, r.id === selected && styles.chipTextOn]}>{runLabel(r)}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function ExportCard({
  spec,
  disabled,
  busy = false,
  onPress,
  children,
}: {
  spec: (typeof EXPORTS)[number];
  disabled: boolean;
  busy?: boolean;
  onPress: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <View style={styles.row}>
        <IconTile name={spec.icon} color={spec.tint} background={spec.background} />
        <View style={styles.rowText}>
          <Text style={styles.title}>{spec.title}</Text>
          <Text style={textStyles.muted}>{spec.detail}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Download ${spec.title}`}
          accessibilityState={{ disabled: disabled || busy, busy }}
          disabled={disabled || busy}
          onPress={onPress}
          style={[styles.download, !(disabled || busy) && styles.downloadOn]}
        >
          <Icon name="download" size={24} color={disabled || busy ? '#7D867B' : colors.onDark} />
        </Pressable>
      </View>
      {children}
    </Card>
  );
}

function ExportResult({ result, saved }: { result: ExportCsvResponse; saved: boolean }) {
  const pc = result.pairCounts;
  const d = result.delivery;
  return (
    <View style={styles.result}>
      <Text style={styles.resultText}>
        {saved ? `Saved ${result.filename}` : `Built ${result.filename}; this device cannot save files`} · {result.rows} row{result.rows === 1 ? '' : 's'}
      </Text>
      {pc !== null && (
        <View style={[styles.notice, pc.missing_verification + pc.missing_dosing + pc.ambiguous_multiple_readings > 0 && styles.noticeWarn]}>
          <Text style={styles.noticeText}>
            {pc.paired} cell{pc.paired === 1 ? '' : 's'} paired
            {pc.missing_verification > 0 ? ` · ${pc.missing_verification} without a verification reading` : ''}
            {pc.missing_dosing > 0 ? ` · ${pc.missing_dosing} without a dosing reading` : ''}
            {pc.ambiguous_multiple_readings > 0 ? ` · ${pc.ambiguous_multiple_readings} ambiguous` : ''}
          </Text>
        </View>
      )}
      {d !== null && (
        <View style={styles.tiles}>
          <View style={styles.tile}>
            <Text style={textStyles.muted}>First-attempt delivery</Text>
            <Text style={styles.tileValue}>Not computed</Text>
            <Text style={styles.tileNote}>{d.firstAttemptNote}</Text>
          </View>
          <View style={styles.tile}>
            <Text style={textStyles.muted}>Post-retry completeness</Text>
            <Text style={styles.tileValue}>
              {d.completenessNumerator === null || d.completenessDenominator === null || d.completenessDenominator === 0
                ? '—'
                : `${Math.round((d.completenessNumerator / d.completenessDenominator) * 100)}%`}
            </Text>
            <Text style={styles.tileNote}>
              {d.completenessNumerator === null || d.completenessDenominator === null
                ? d.completenessNote
                : `${d.completenessNumerator} of ${d.completenessDenominator} cells`}
            </Text>
          </View>
        </View>
      )}
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
  downloadOn: { backgroundColor: colors.brand },
  picker: { gap: 8 },
  pickerLabel: { fontSize: 17, fontWeight: '800', color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.button, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: colors.surface, minHeight: 48 },
  chipOn: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  chipText: { fontSize: 15, color: colors.text },
  chipTextOn: { fontWeight: '800', color: colors.brand },
  result: { gap: 10, marginTop: 12 },
  resultText: { fontSize: 15, color: colors.mutedText },
  error: { fontSize: 15, fontWeight: '700', color: colors.danger, marginTop: 10 },
  notice: { backgroundColor: colors.brandSoft, borderRadius: radius.tile, padding: 12 },
  noticeWarn: { backgroundColor: colors.warningSurface },
  noticeText: { fontSize: 15, color: colors.text },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, backgroundColor: colors.surfaceMuted, borderRadius: radius.tile, padding: 12, gap: 4 },
  tileValue: { fontSize: 24, fontWeight: '800', color: colors.text },
  tileNote: { fontSize: 13, color: colors.mutedText },
});
