import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';

import type { GatewayClient } from '../data/gatewayClient';
import type { StoredSession } from '../data/sessionStore';
import { pairingFailureMessage } from '../data/statusView';
import { WIDE_BREAKPOINT, colors, radius } from '../theme';
import { Icon } from '../ui/Icon';
import { IconTile, InfoBox, LogoTile, PrimaryButton, StripedHero, textStyles } from '../ui/primitives';

interface PairingScreenProps {
  client: GatewayClient;
  onPaired: (session: StoredSession) => void;
  /** Shown when the previous session was rejected by the gateway. */
  notice?: string | null;
}

/**
 * Screen 1 (local field mode), styled after mockup page 1 (D50). Pairs
 * against the laptop gateway only; no cloud call, no email or phone number.
 * The code is sent once and then discarded from component state; it is never
 * logged or stored. Field use is laptop-only (D40, D41), so the mockup's
 * LAN address card reads "Field gateway on this computer".
 */
export function PairingScreen({ client, onPaired, notice = null }: PairingScreenProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const wide = useWindowDimensions().width >= WIDE_BREAKPOINT;

  const submit = async () => {
    if (busy) return;
    const trimmed = code.trim();
    if (trimmed === '') {
      setMessage('Enter the pairing code.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await client.pair(trimmed);
    setBusy(false);
    setCode('');
    if (result.ok) {
      onPaired({ token: result.data.sessionToken, robot: result.data.robot, expiresAt: result.data.expiresAt });
    } else {
      setMessage(pairingFailureMessage(result.failure));
    }
  };

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">
      <StripedHero style={styles.hero}>
        <DecorativeGrid />
        <View style={[styles.brandRow, wide && styles.column]}>
          <LogoTile size={64} />
          <View>
            <Text accessibilityRole="header" style={styles.brandName}>
              RoboLime
            </Text>
            <Text style={styles.brandTag}>Soil pH monitoring and lime dosing</Text>
          </View>
        </View>
      </StripedHero>

      <View style={[styles.body, wide && styles.column]}>
        <Text accessibilityRole="header" style={textStyles.pageTitle}>
          Pair with your robot
        </Text>
        <Text style={styles.lead}>Enter the pairing code created on the field laptop.</Text>

        <View style={styles.gatewayCard}>
          <IconTile name="laptop" color={colors.brand} background={colors.brandSoft} />
          <View style={styles.gatewayText}>
            <Text style={styles.gatewayTitle}>Field gateway on this computer</Text>
            <Text style={textStyles.muted}>Local connection · no internet needed</Text>
          </View>
        </View>

        {notice !== null && (
          <View accessibilityRole="alert">
            <InfoBox tone="warning" icon="alert">
              <Text style={styles.noticeText}>{notice}</Text>
            </InfoBox>
          </View>
        )}

        <View style={styles.field}>
          <Text nativeID="pairing-code-label" style={styles.label}>
            Pairing code
          </Text>
          <TextInput
            accessibilityLabel="Pairing code"
            aria-labelledby="pairing-code-label"
            value={code}
            onChangeText={setCode}
            onSubmitEditing={() => void submit()}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            secureTextEntry
            editable={!busy}
            placeholder="XXXX-XXXX-XXXX"
            placeholderTextColor="#8A9087"
            style={styles.input}
          />
        </View>

        {message !== null && (
          <Text accessibilityRole="alert" style={styles.error}>
            {message}
          </Text>
        )}

        <View style={styles.actions}>
          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator color={colors.brand} />
              <Text style={textStyles.body}>Pairing…</Text>
            </View>
          ) : null}
          <PrimaryButton label="Pair this device" icon="arrowRight" busy={busy} onPress={() => void submit()} />
          <View style={styles.privacy}>
            <Icon name="lock" size={20} color={colors.mutedText} />
            <Text style={[textStyles.muted, styles.privacyText]}>
              No account, email or phone number. Anyone with this code can view this robot’s data, so keep it private.
            </Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

/** Decorative tilted grid in neutral greens (no pH colours): it illustrates the idea of a field, not data. */
function DecorativeGrid() {
  const shades = ['#5E8F4A', '#4C7A3C', '#6FA057', '#557F45'];
  return (
    <View style={styles.gridWrap} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.grid}>
        {Array.from({ length: 20 }, (_, i) => (
          <View key={i} style={[styles.gridCell, { backgroundColor: shades[(i * 7) % shades.length] }]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.background },
  pageContent: { flexGrow: 1 },
  hero: { minHeight: 260, borderBottomLeftRadius: 36, borderBottomRightRadius: 36, justifyContent: 'flex-end', padding: 24 },
  gridWrap: { position: 'absolute', top: 36, right: 24, transform: [{ rotate: '-8deg' }] },
  grid: { width: 236, flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 8, borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 14 },
  gridCell: { width: 38, height: 34, borderRadius: 7 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  brandName: { color: colors.onDark, fontSize: 34, fontWeight: '800', letterSpacing: -0.6 },
  brandTag: { color: '#DCE6D6', fontSize: 17 },
  column: { width: '100%', maxWidth: 560, alignSelf: 'center' },
  body: { padding: 24, gap: 18, flexGrow: 1 },
  lead: { fontSize: 19, lineHeight: 26, color: colors.mutedText },
  gatewayCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: 16,
  },
  gatewayText: { flex: 1, gap: 2 },
  gatewayTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  noticeText: { fontSize: 16, lineHeight: 22, color: colors.warningText },
  field: { gap: 8 },
  label: { fontSize: 17, fontWeight: '700', color: colors.text },
  input: {
    minHeight: 64,
    borderWidth: 2,
    borderColor: colors.brand,
    borderRadius: radius.button,
    paddingHorizontal: 18,
    fontSize: 24,
    letterSpacing: 2,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  error: { fontSize: 17, fontWeight: '700', color: colors.danger },
  actions: { gap: 14, marginTop: 'auto' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  privacy: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  privacyText: { flex: 1 },
});
