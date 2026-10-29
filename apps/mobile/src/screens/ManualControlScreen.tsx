import { MANUAL_AUTO_STOP_MS, describeManualControlCommand, type ManualControlCommand, type ManualStatusResponse } from '@robolime/shared';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { MANUAL_STATUS_POLL_MS } from '../config/timing';
import type { FieldDataSource } from '../data/dataSource';
import { isSessionInvalid } from '../data/gatewayClient';
import {
  DEFAULT_PWM,
  SPEED_PRESETS,
  bridgeLabel,
  clockTime,
  outcomeMessage,
  sendFailureMessage,
  type Tone,
} from '../data/manualControlView';
import { startPolling, type Timers } from '../data/statusPoller';
import { colors, radius } from '../theme';
import { Card, InfoBox, StatusPill, textStyles } from '../ui/primitives';

interface ManualControlScreenProps {
  control: NonNullable<FieldDataSource['manualControl']>;
  token: string;
  onSessionInvalid: () => void;
  timers?: Timers;
}

const LOG_LINES_SHOWN = 15;

/**
 * "Manual control of RoboLime": drive, pump and actuator commands sent through
 * the field gateway's LoRa bridge, either from the laptop itself (D57) or
 * online through the cloud relay (D58). One command is in flight at a time;
 * STOP is never disabled while the bridge is connected and always replaces the
 * pending command.
 */
export function ManualControlScreen({ control, token, onSessionInvalid, timers }: ManualControlScreenProps) {
  const [status, setStatus] = useState<ManualStatusResponse | null>(null);
  const [gatewayDown, setGatewayDown] = useState(false);
  const [pwm, setPwm] = useState(DEFAULT_PWM);
  const [inFlight, setInFlight] = useState<ManualControlCommand | null>(null);
  const [last, setLast] = useState<{ text: string; tone: Tone } | null>(null);

  useEffect(
    () =>
      startPolling({
        request: () => control.status(token),
        intervalMs: MANUAL_STATUS_POLL_MS,
        timers,
        onResult: (result) => {
          if (result.ok) {
            setGatewayDown(false);
            setStatus(result.data);
            return true;
          }
          if (isSessionInvalid(result.failure)) {
            onSessionInvalid();
            return false;
          }
          setGatewayDown(true);
          return true;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [control, token],
  );

  const online = control.via === 'online';
  const connected = !gatewayDown && status?.bridge.state === 'connected';
  const autoStopSeconds = Math.round((status?.autoStopMs ?? MANUAL_AUTO_STOP_MS) / 1000);
  const bridge = gatewayDown
    ? { label: online ? 'RoboLime online unreachable' : 'Field gateway not running', tone: 'negative' as const }
    : bridgeLabel(status?.bridge.state ?? null, status?.bridge.port ?? null);

  async function send(command: ManualControlCommand) {
    setInFlight(command);
    setLast({ text: `${describeManualControlCommand(command)}: sending over LoRa…`, tone: 'neutral' });
    const result = await control.send(token, command);
    setInFlight((current) => (current === command ? null : current));
    if (result.ok) {
      // A superseded result arrives after its replacement was sent; keep showing the newer one.
      if (result.data.outcome !== 'superseded') setLast(outcomeMessage(result.data));
      return;
    }
    if (isSessionInvalid(result.failure)) {
      onSessionInvalid();
      return;
    }
    setLast({ text: sendFailureMessage(command, result.failure, control.via), tone: 'negative' });
  }

  const busy = inFlight !== null && inFlight.type !== 'STOP_ALL';
  const canSend = connected && !busy;
  const drive = (direction: 'FORWARD' | 'REVERSE' | 'LEFT' | 'RIGHT') => () => void send({ type: 'DRIVE', direction, pwm });

  return (
    <View style={styles.body}>
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Manual control of RoboLime
        </Text>
        <StatusPill label={bridge.label} tone={bridge.tone} />
      </View>

      {!connected && (
        <InfoBox tone="danger" icon="cloudOff">
          <Text style={textStyles.body}>
            {gatewayDown
              ? online
                ? 'RoboLime online could not be reached. Check this device’s internet connection.'
                : 'The field gateway on this laptop is not answering. Start it, then come back to this tab.'
              : (status?.bridge.detail ?? 'Waiting for the LoRa bridge.')}
          </Text>
          <Text style={textStyles.note}>
            {online
              ? 'Commands are disabled until the field gateway is online with its LoRa bridge connected.'
              : 'Commands are disabled until the LoRa bridge is connected over USB.'}
          </Text>
        </InfoBox>
      )}

      <InfoBox tone="warning" icon="alert">
        <Text style={textStyles.body}>
          These buttons move the real robot over LoRa. Keep people and hands clear. Every drive, pump or actuator command
          stops by itself after {autoStopSeconds} s; press Stop everything to stop sooner.
        </Text>
        {online && (
          <Text style={textStyles.body}>
            You may not be able to see the robot. Online commands travel through the internet to the field laptop and
            take a few seconds; a command not picked up within 10 s is dropped, never sent late.
          </Text>
        )}
        <Text style={textStyles.note}>
          Manual pump use is not part of a dosing run and is not recorded as dispensed lime.
        </Text>
      </InfoBox>

      <ControlButton label="STOP EVERYTHING" tone="danger" large disabled={!connected} onPress={() => void send({ type: 'STOP_ALL' })} />

      {last !== null && (
        <InfoBox tone={last.tone === 'positive' ? 'success' : last.tone === 'negative' ? 'danger' : 'neutral'} icon={last.tone === 'positive' ? 'check' : 'signal'}>
          <Text accessibilityLiveRegion="polite" style={textStyles.body}>
            {last.text}
          </Text>
        </InfoBox>
      )}

      <Card>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Drive
        </Text>
        <Text style={textStyles.label}>Speed (motor PWM {pwm} of 255)</Text>
        <View style={styles.row} accessibilityRole="radiogroup">
          {SPEED_PRESETS.map((preset) => {
            const selected = preset.pwm === pwm;
            return (
              <Pressable
                key={preset.pwm}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={`${preset.label} speed, PWM ${preset.pwm}`}
                onPress={() => setPwm(preset.pwm)}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{preset.label}</Text>
                <Text style={[styles.chipSub, selected && styles.chipTextSelected]}>PWM {preset.pwm}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.pad}>
          <ControlButton label="Forward" disabled={!canSend} onPress={drive('FORWARD')} />
          <View style={styles.row}>
            <ControlButton label="Turn left" disabled={!canSend} onPress={drive('LEFT')} />
            <ControlButton label="Turn right" disabled={!canSend} onPress={drive('RIGHT')} />
          </View>
          <ControlButton label="Reverse" disabled={!canSend} onPress={drive('REVERSE')} />
        </View>
      </Card>

      <Card>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Probe actuator and lime pump
        </Text>
        <View style={styles.row}>
          <ControlButton label="Extend actuator" disabled={!canSend} onPress={() => void send({ type: 'ACTUATOR', action: 'EXTEND' })} />
          <ControlButton label="Retract actuator" disabled={!canSend} onPress={() => void send({ type: 'ACTUATOR', action: 'RETRACT' })} />
        </View>
        <View style={styles.row}>
          <ControlButton label="Pump on" disabled={!canSend} onPress={() => void send({ type: 'PUMP', action: 'ON' })} />
          <ControlButton label="Pump off" disabled={!canSend} onPress={() => void send({ type: 'PUMP', action: 'OFF' })} />
        </View>
      </Card>

      <Card>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Recent commands
        </Text>
        {status === null || status.recentCommands.length === 0 ? (
          <Text style={textStyles.muted}>{online ? 'No recent commands.' : 'No commands sent since the gateway started.'}</Text>
        ) : (
          status.recentCommands.map((result) => {
            const message = outcomeMessage(result);
            return (
              <View key={`${result.sentAt}-${result.line}`} style={styles.historyRow}>
                <Text style={styles.time}>{clockTime(result.sentAt)}</Text>
                <Text style={[textStyles.body, styles.flex, message.tone === 'negative' && { color: colors.danger }]}>{message.text}</Text>
              </View>
            );
          })
        )}
      </Card>

      {!online && <Card>
        <Text accessibilityRole="header" style={textStyles.sectionTitle}>
          Bridge messages
        </Text>
        <Text style={textStyles.note}>What the LoRa bridge printed over USB serial, newest last. Times are this laptop&apos;s clock.</Text>
        {status === null || status.bridgeLog.length === 0 ? (
          <Text style={textStyles.muted}>Nothing received from the bridge yet.</Text>
        ) : (
          <View style={styles.log}>
            {status.bridgeLog.slice(-LOG_LINES_SHOWN).map((entry, i) => (
              <Text key={`${entry.at}-${i}`} style={styles.logLine}>
                {clockTime(entry.at)} {entry.line}
              </Text>
            ))}
          </View>
        )}
      </Card>}
    </View>
  );
}

function ControlButton({
  label,
  onPress,
  disabled,
  tone = 'default',
  large = false,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  tone?: 'default' | 'danger';
  large?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === 'danger' && styles.buttonDanger,
        large && styles.buttonLarge,
        pressed && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={[styles.buttonText, tone === 'danger' && styles.buttonTextDanger, large && styles.buttonTextLarge]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { gap: 18 },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  row: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  pad: { gap: 12, maxWidth: 520, width: '100%', alignSelf: 'center' },
  flex: { flex: 1 },
  chip: { flexGrow: 1, minHeight: 56, minWidth: 96, borderRadius: radius.tile, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  chipSelected: { borderColor: colors.brand, backgroundColor: colors.brand },
  chipText: { fontSize: 17, fontWeight: '800', color: colors.text },
  chipSub: { fontSize: 13, color: colors.mutedText },
  chipTextSelected: { color: colors.onDark },
  button: { flexGrow: 1, flexBasis: 140, minHeight: 64, borderRadius: radius.button, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonDanger: { backgroundColor: colors.danger },
  buttonLarge: { minHeight: 84 },
  buttonPressed: { opacity: 0.75 },
  buttonDisabled: { backgroundColor: '#A7ADA4' },
  buttonText: { fontSize: 18, fontWeight: '800', color: colors.onDark },
  buttonTextDanger: { letterSpacing: 0.5 },
  buttonTextLarge: { fontSize: 24 },
  historyRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  time: { fontSize: 15, fontWeight: '700', color: colors.mutedText, minWidth: 70 },
  log: { backgroundColor: colors.ink, borderRadius: radius.tile, padding: 12, gap: 2 },
  logLine: { color: colors.onDarkMuted, fontSize: 13, lineHeight: 19, fontFamily: Platform.select({ web: 'Consolas, Menlo, monospace', default: 'monospace' }) },
});
