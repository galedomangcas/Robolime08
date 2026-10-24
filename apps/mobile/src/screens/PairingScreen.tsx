import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { GatewayClient } from '../data/gatewayClient';
import type { StoredSession } from '../data/sessionStore';
import { pairingFailureMessage } from '../data/statusView';
import { colors } from '../theme';

interface PairingScreenProps {
  client: GatewayClient;
  onPaired: (session: StoredSession) => void;
  /** Shown when the previous session was rejected by the gateway. */
  notice?: string | null;
}

/**
 * Screen 1 (local field mode). Pairs against the laptop gateway only; no
 * cloud call, no email or phone number. The code is sent once and then
 * discarded from component state; it is never logged or stored.
 */
export function PairingScreen({ client, onPaired, notice = null }: PairingScreenProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>
        RoboLime
      </Text>
      <Text style={styles.subtitle}>Pair this device with the field gateway</Text>

      {notice !== null && (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}

      <View style={styles.card}>
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
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={() => void submit()}
          style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
        >
          {busy ? <ActivityIndicator color={colors.background} /> : <Text style={styles.buttonText}>Pair</Text>}
        </Pressable>
        {message !== null && (
          <Text accessibilityRole="alert" style={styles.error}>
            {message}
          </Text>
        )}
      </View>

      <Text style={styles.help}>
        The code is shown once on the laptop when the operator runs “npm run pairing:provision”. Pairing
        works over the local network without internet.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, paddingTop: 56, gap: 16, backgroundColor: colors.background },
  title: { fontSize: 36, fontWeight: '800', color: colors.brand },
  subtitle: { fontSize: 18, color: colors.text },
  card: { borderWidth: 2, borderColor: colors.border, borderRadius: 12, padding: 16, gap: 12, backgroundColor: colors.surface },
  label: { fontSize: 16, fontWeight: '700', color: colors.text },
  input: {
    minHeight: 52,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 22,
    color: colors.text,
    backgroundColor: colors.background,
  },
  button: { minHeight: 52, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand },
  buttonPressed: { opacity: 0.8 },
  buttonText: { fontSize: 20, fontWeight: '700', color: colors.background },
  error: { fontSize: 17, lineHeight: 24, fontWeight: '700', color: colors.danger },
  notice: { borderWidth: 2, borderColor: colors.danger, borderRadius: 12, padding: 12 },
  noticeText: { fontSize: 17, lineHeight: 24, color: colors.text },
  help: { fontSize: 15, lineHeight: 22, color: colors.mutedText },
});
