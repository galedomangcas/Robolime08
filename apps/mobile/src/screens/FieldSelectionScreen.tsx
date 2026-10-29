import type { FieldResponse } from '@robolime/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { FieldDataSource } from '../data/dataSource';
import { isSessionInvalid } from '../data/gatewayClient';
import type { KeyValueStorage } from '../data/sessionStore';
import { colors, radius } from '../theme';
import { Icon } from '../ui/Icon';
import { InfoBox, PrimaryButton, SecondaryButton, StripedHero, SyntheticBadge, textStyles } from '../ui/primitives';

/**
 * Screen 2, field selection and confirmation (mockup page 2, D54). One field
 * is supported; the other cards are the required "Other fields not yet
 * available." placeholders. Confirming records the user's choice for the
 * next run as a RECORD OF INTENT only: the robot never reads it and its field
 * profile is preloaded before deployment. On the field laptop the choice is
 * stored by the gateway; online it is kept in this browser only.
 */
export const FIELD_SELECTION_KEY = (robotId: string) => `robolime.fieldSelection.v1:${robotId}`;

export function hasConfirmedField(storage: KeyValueStorage | null, robotId: string): boolean {
  try {
    return (storage?.getItem(FIELD_SELECTION_KEY(robotId)) ?? null) !== null;
  } catch {
    return false;
  }
}

function rememberField(storage: KeyValueStorage | null, robotId: string, value: string): void {
  try {
    storage?.setItem(FIELD_SELECTION_KEY(robotId), value);
  } catch {
    // Storage blocked: the step shows again next time.
  }
}

/** Shows the selection step once per robot on this device, then the app. */
export function FieldSelectionGate({
  dataSource,
  token,
  robotId,
  storage,
  onSessionInvalid,
  children,
}: {
  dataSource: FieldDataSource;
  token: string;
  robotId: string;
  storage: KeyValueStorage | null;
  onSessionInvalid: () => void;
  children: ReactNode;
}) {
  // Without storage (native app, blocked site data) the choice could not be kept, so the step is skipped.
  const [done, setDone] = useState(() => storage === null || hasConfirmedField(storage, robotId));
  if (done) return <>{children}</>;
  return (
    <FieldSelectionScreen
      dataSource={dataSource}
      token={token}
      onSessionInvalid={onSessionInvalid}
      onDone={(value) => {
        rememberField(storage, robotId, value);
        setDone(true);
      }}
    />
  );
}

type Load = { kind: 'loading' } | { kind: 'loaded'; data: FieldResponse | null } | { kind: 'failed' };

export function FieldSelectionScreen({
  dataSource,
  token,
  onSessionInvalid,
  onDone,
}: {
  dataSource: FieldDataSource;
  token: string;
  onSessionInvalid: () => void;
  /** Called with the field id, or "none" when no field is provisioned yet. */
  onDone: (value: string) => void;
}) {
  const [field, setField] = useState<Load>({ kind: 'loading' });
  const [confirming, setConfirming] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void dataSource.field(token).then((r) => {
      if (!active) return;
      if (!r.ok && isSessionInvalid(r.failure)) return onSessionInvalid();
      if (r.ok) setField({ kind: 'loaded', data: r.data });
      else if (r.failure.kind === 'api' && (r.failure.code === 'NO_ACTIVE_FIELD' || r.failure.code === 'NOT_FOUND')) setField({ kind: 'loaded', data: null });
      else setField({ kind: 'failed' });
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, token]);

  const data = field.kind === 'loaded' ? field.data : null;
  const confirm = async () => {
    if (data === null || busy) return;
    setBusy(true);
    setError(null);
    const r = await dataSource.selectField(token, data.field.id);
    setBusy(false);
    if (r.ok) onDone(data.field.id);
    else if (isSessionInvalid(r.failure)) onSessionInvalid();
    else setError('The choice could not be saved. Try again.');
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.step}>STEP 2 OF 2</Text>
        <Text accessibilityRole="header" style={textStyles.pageTitle}>
          Choose your field
        </Text>
        <Text style={textStyles.muted}>Pick the field for the robot’s next run.</Text>

        {field.kind === 'loading' && <Text style={textStyles.body}>Loading the field…</Text>}
        {field.kind === 'failed' && (
          <InfoBox tone="warning" icon="alert">
            <Text style={styles.noticeText}>The field could not be loaded. You can continue and choose it later.</Text>
          </InfoBox>
        )}

        {field.kind === 'loaded' && data !== null && (
          <View style={[styles.card, styles.cardSelected]} accessibilityRole="radio" accessibilityState={{ selected: true }}>
            <StripedHero style={styles.cardHero}>
              <View style={styles.selectedPill}>
                <Icon name="check" size={16} color={colors.brand} />
                <Text style={styles.selectedText}>Selected</Text>
              </View>
              <MiniGrid />
            </StripedHero>
            <View style={styles.cardBody}>
              <View style={styles.nameRow}>
                <Text style={styles.fieldName}>{data.field.name}</Text>
                {data.field.isSynthetic && <SyntheticBadge />}
              </View>
              <Text style={textStyles.muted}>{data.field.locationLabel}</Text>
              <View style={styles.facts}>
                <Fact label="Area" value={data.field.areaSquareMeters === null ? 'Not surveyed' : `${data.field.areaSquareMeters} m²`} />
                <Fact label="Cells" value={String(data.field.totalCells ?? data.cells.length)} />
                <Fact label="Cell size" value={`${data.field.cellSizeMeters} × ${data.field.cellSizeMeters} m`} />
              </View>
            </View>
          </View>
        )}

        {field.kind === 'loaded' && data === null && (
          <View style={styles.card}>
            <View style={styles.cardBody}>
              <Text style={styles.fieldName}>No field provisioned yet</Text>
              <Text style={textStyles.muted}>
                The operator registers the surveyed field on the field gateway. Until then the app shows a placeholder layout.
              </Text>
            </View>
          </View>
        )}

        <Text style={styles.otherTitle}>Other fields</Text>
        <ScrollView horizontal contentContainerStyle={styles.others} showsHorizontalScrollIndicator>
          {[0, 1].map((i) => (
            <View key={i} style={styles.otherCard} accessibilityRole="text">
              <Icon name="grid" size={24} color={colors.mutedText} />
              <Text style={styles.otherText}>Other fields not yet available.</Text>
            </View>
          ))}
        </ScrollView>
      </ScrollView>

      <View style={styles.sheet}>
        <View style={styles.handle} />
        {data !== null && confirming ? (
          <>
            <Text style={styles.sheetTitle}>Use {data.field.name}?</Text>
            <Text style={textStyles.muted}>
              This saves your choice for the next run{dataSource.kind === 'cloud' ? ' on this browser' : ''}. The robot already
              carries this field’s profile; the app does not change any robot setting.
            </Text>
            {error !== null && <Text style={styles.error}>{error}</Text>}
            <PrimaryButton label="Confirm field" busy={busy} onPress={() => void confirm()} />
            <SecondaryButton label="Go back" onPress={() => setConfirming(false)} />
          </>
        ) : data !== null ? (
          <PrimaryButton label={`Use ${data.field.name}`} onPress={() => setConfirming(true)} />
        ) : (
          <PrimaryButton label="Continue without a field" disabled={field.kind === 'loading'} onPress={() => onDone('none')} />
        )}
      </View>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={textStyles.muted}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

/** Decorative outline grid (no data meaning). */
function MiniGrid() {
  return (
    <View style={styles.miniGrid} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: 20 }, (_, i) => (
        <View key={i} style={styles.miniCell} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 22, paddingTop: 32, gap: 14, paddingBottom: 300, width: '100%', maxWidth: 640, alignSelf: 'center' },
  step: { color: colors.brand, fontWeight: '800', letterSpacing: 1, fontSize: 15 },
  noticeText: { fontSize: 16, lineHeight: 22, color: colors.warningText },
  card: { backgroundColor: colors.surface, borderRadius: radius.card + 4, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  cardSelected: { borderWidth: 2.5, borderColor: colors.brand },
  cardHero: { height: 170, alignItems: 'center', justifyContent: 'center' },
  selectedPill: { position: 'absolute', top: 14, left: 14, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  selectedText: { fontWeight: '800', color: colors.brand, fontSize: 15 },
  miniGrid: { width: 230, flexDirection: 'row', flexWrap: 'wrap', gap: 4, padding: 6, borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)', borderRadius: 12 },
  miniCell: { width: 40, height: 30, borderRadius: 4, borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)' },
  cardBody: { padding: 18, gap: 8 },
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  fieldName: { fontSize: 24, fontWeight: '800', color: colors.text },
  facts: { flexDirection: 'row', gap: 10, marginTop: 4 },
  fact: { flex: 1, backgroundColor: colors.surfaceMuted, borderRadius: radius.tile, padding: 12, gap: 2 },
  factValue: { fontSize: 18, fontWeight: '800', color: colors.text },
  otherTitle: { fontSize: 18, fontWeight: '800', color: colors.text, marginTop: 6 },
  others: { gap: 12 },
  otherCard: { width: 240, minHeight: 110, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#B9C0B4', borderRadius: radius.card, padding: 16, gap: 10 },
  otherText: { fontSize: 17, fontWeight: '700', color: colors.mutedText },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.surface, borderTopLeftRadius: 32, borderTopRightRadius: 32,
    padding: 22, gap: 12, maxWidth: 640, width: '100%', alignSelf: 'center',
  },
  handle: { alignSelf: 'center', width: 56, height: 5, borderRadius: 3, backgroundColor: colors.border },
  sheetTitle: { fontSize: 24, fontWeight: '800', color: colors.text },
  error: { fontSize: 16, fontWeight: '700', color: colors.danger },
});
