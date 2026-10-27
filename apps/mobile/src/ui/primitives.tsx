import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius } from '../theme';
import { Icon, type IconName } from './Icon';

/** Reusable building blocks for the Canva-based layout (D50). Presentation only: no data access. */

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SyntheticBadge() {
  return (
    <View style={styles.syntheticBadge}>
      <Text style={styles.syntheticText}>SYNTHETIC</Text>
    </View>
  );
}

type PillTone = 'positive' | 'negative' | 'neutral';

/** A rounded status pill with a coloured dot; the text always carries the meaning. */
export function StatusPill({ label, tone }: { label: string; tone: PillTone }) {
  return (
    <View style={[styles.pill, tone === 'positive' ? styles.pillPositive : tone === 'negative' ? styles.pillNegative : styles.pillNeutral]}>
      <View style={[styles.pillDot, { backgroundColor: tone === 'positive' ? colors.brandBright : tone === 'negative' ? colors.danger : colors.mutedText }]} />
      <Text style={[styles.pillText, tone === 'negative' && { color: colors.danger }]}>{label}</Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  icon,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.primary, (pressed || busy) && styles.primaryPressed, disabled && styles.disabled]}
    >
      <Text style={styles.primaryText}>{label}</Text>
      {icon !== undefined && <Icon name={icon} size={22} color={colors.onDark} />}
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, danger = false }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.secondary, danger && styles.secondaryDanger, pressed && styles.secondaryPressed]}
    >
      <Text style={[styles.secondaryText, danger && { color: colors.onDark }]}>{label}</Text>
    </Pressable>
  );
}

type BoxTone = 'warning' | 'danger' | 'success' | 'neutral';

export function InfoBox({ tone, icon, children }: { tone: BoxTone; icon?: IconName; children: ReactNode }) {
  const toneStyle =
    tone === 'warning' ? styles.boxWarning : tone === 'danger' ? styles.boxDanger : tone === 'success' ? styles.boxSuccess : styles.boxNeutral;
  const iconColor = tone === 'warning' ? colors.warningText : tone === 'danger' ? colors.danger : tone === 'success' ? colors.brand : colors.mutedText;
  return (
    <View style={[styles.box, toneStyle]}>
      {icon !== undefined && <Icon name={icon} size={20} color={iconColor} />}
      <View style={styles.boxBody}>{children}</View>
    </View>
  );
}

export function IconTile({ name, color, background }: { name: IconName; color: string; background: string }) {
  return (
    <View style={[styles.iconTile, { backgroundColor: background }]}>
      <Icon name={name} size={24} color={color} />
    </View>
  );
}

export function LogoTile({ size = 52 }: { size?: number }) {
  return (
    <View style={[styles.logo, { width: size, height: size, borderRadius: size * 0.26 }]}>
      <Icon name="leaf" size={size * 0.5} color={colors.ink} />
    </View>
  );
}

/** Decorative striped green background used by the mockup's hero areas. Carries no data. */
export function StripedHero({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.hero, style]}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {Array.from({ length: 28 }, (_, i) => (
          <View key={i} style={[styles.stripe, { left: -200 + i * 34 }]} />
        ))}
      </View>
      {children}
    </View>
  );
}

/**
 * Self-check dots. Component bit positions are not specified (OPEN_ITEMS #9),
 * so every dot is an outlined "unknown" dot; the text says so.
 */
export function SelfCheckDots({ count, onDark = false }: { count: number; onDark?: boolean }) {
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.dot, { borderColor: onDark ? colors.onDarkMuted : colors.mutedText }]} />
      ))}
    </View>
  );
}

/**
 * Horizontal pH scale 4.0–7.0 with a marker for the value and a line at the
 * confirmed target 6.00. The scale ends are display limits only: no band
 * boundary is implied (the near-target cut-off is unconfirmed, OPEN_ITEMS #4).
 */
export const GAUGE_MIN = 4;
export const GAUGE_MAX = 7;
export const PH_TARGET = 6;

const GAUGE_SLICES = 36;

function mix(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t)).join(',')})`;
}

/** Continuous colour from the scale start to the target, then the target colour: no intermediate band edge. */
export function gaugeColorAt(ph: number): string {
  if (ph >= PH_TARGET) return colors.gaugeHigh;
  const t = Math.max(0, (ph - GAUGE_MIN) / (PH_TARGET - GAUGE_MIN));
  return t < 0.5 ? mix(colors.gaugeLow, colors.gaugeMid, t * 2) : mix(colors.gaugeMid, colors.gaugeHigh, (t - 0.5) * 2);
}

export function PhGauge({ value }: { value: number }) {
  const position = (v: number) => `${(Math.min(Math.max(v, GAUGE_MIN), GAUGE_MAX) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN) * 100}%` as const;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.gaugeTrack}>
        {Array.from({ length: GAUGE_SLICES }, (_, i) => (
          <View
            key={i}
            style={[styles.gaugeSegment, { backgroundColor: gaugeColorAt(GAUGE_MIN + ((i + 0.5) / GAUGE_SLICES) * (GAUGE_MAX - GAUGE_MIN)) }]}
          />
        ))}
        <View style={[styles.gaugeTarget, { left: position(PH_TARGET) }]} />
        <View style={[styles.gaugeMarker, { left: position(value) }]} />
      </View>
      <View style={styles.gaugeScale}>
        <Text style={styles.gaugeLabel}>{GAUGE_MIN.toFixed(1)}</Text>
        <Text style={[styles.gaugeLabel, styles.gaugeTargetLabel]}>Target {PH_TARGET.toFixed(2)}</Text>
        <Text style={styles.gaugeLabel}>{GAUGE_MAX.toFixed(1)}</Text>
      </View>
    </View>
  );
}

export const textStyles = StyleSheet.create({
  pageTitle: { fontSize: 30, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  sectionTitle: { fontSize: 19, fontWeight: '800', color: colors.text },
  body: { fontSize: 16, lineHeight: 22, color: colors.text },
  muted: { fontSize: 15, lineHeight: 21, color: colors.mutedText },
  note: { fontSize: 13, lineHeight: 19, color: colors.mutedText },
  label: { fontSize: 13, color: colors.mutedText },
  value: { fontSize: 22, fontWeight: '800', color: colors.text },
});

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: 18, gap: 12 },
  syntheticBadge: { backgroundColor: colors.syntheticSurface, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  syntheticText: { color: colors.syntheticText, fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'flex-start' },
  pillPositive: { backgroundColor: colors.brandSoft, borderColor: '#BFE2C9' },
  pillNegative: { backgroundColor: colors.dangerSoft, borderColor: '#F2BBAE' },
  pillNeutral: { backgroundColor: colors.surface, borderColor: colors.border },
  pillDot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontSize: 14, fontWeight: '700', color: colors.brand, flexShrink: 1 },
  primary: { minHeight: 56, borderRadius: radius.button, backgroundColor: colors.brand, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 20 },
  primaryPressed: { opacity: 0.8 },
  primaryText: { color: colors.onDark, fontSize: 19, fontWeight: '800' },
  disabled: { backgroundColor: '#9DB5A4' },
  secondary: { minHeight: 52, borderRadius: radius.button, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  secondaryDanger: { backgroundColor: colors.danger },
  secondaryPressed: { opacity: 0.75 },
  secondaryText: { fontSize: 17, fontWeight: '700', color: colors.text },
  box: { flexDirection: 'row', gap: 10, borderRadius: radius.tile, padding: 14, alignItems: 'flex-start' },
  boxBody: { flex: 1, gap: 4 },
  boxWarning: { backgroundColor: colors.warningSurface },
  boxDanger: { backgroundColor: colors.dangerSoft },
  boxSuccess: { backgroundColor: colors.brandSoft },
  boxNeutral: { backgroundColor: colors.surfaceMuted },
  iconTile: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  logo: { backgroundColor: colors.brandBright, alignItems: 'center', justifyContent: 'center' },
  hero: { backgroundColor: colors.heroDark, overflow: 'hidden' },
  stripe: { position: 'absolute', top: -60, width: 10, height: 900, backgroundColor: colors.heroStripe, opacity: 0.55, transform: [{ rotate: '18deg' }] },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
  gaugeTrack: { height: 12, borderRadius: 6, overflow: 'hidden', flexDirection: 'row' },
  gaugeSegment: { flex: 1 },
  gaugeTarget: { position: 'absolute', top: 0, bottom: 0, width: 3, marginLeft: -1.5, backgroundColor: colors.surface },
  gaugeMarker: { position: 'absolute', top: -5, width: 5, height: 22, marginLeft: -2.5, borderRadius: 3, backgroundColor: colors.text },
  gaugeScale: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  gaugeLabel: { fontSize: 13, color: colors.mutedText },
  gaugeTargetLabel: { color: colors.brand, fontWeight: '800' },
});
