import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';
import { Icon, type IconName } from './Icon';
import { LogoTile } from './primitives';

/** The three sections of the paired view, as in the mockups (D50). */
export type Section = 'field' | 'results' | 'exports';

export const SECTIONS: readonly { key: Section; label: string; icon: IconName }[] = [
  { key: 'field', label: 'Field', icon: 'grid' },
  { key: 'results', label: 'Results', icon: 'leaf' },
  { key: 'exports', label: 'Exports', icon: 'download' },
];

interface NavProps {
  current: Section;
  onSelect: (section: Section) => void;
}

/** Phone and narrow web: tab bar at the bottom of the screen. */
export function BottomTabs({ current, onSelect }: NavProps) {
  return (
    <View style={styles.bottom} accessibilityRole="tablist">
      {SECTIONS.map((s) => {
        const selected = s.key === current;
        const color = selected ? colors.brand : colors.mutedText;
        return (
          <Pressable
            key={s.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={s.label}
            onPress={() => onSelect(s.key)}
            style={styles.bottomTab}
          >
            <Icon name={s.icon} size={26} color={color} />
            <Text style={[styles.bottomLabel, { color }, selected && styles.bottomLabelSelected]}>{s.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Laptop width: dark side rail with the logo and section icons (web mockup). */
export function SideNav({ current, onSelect }: NavProps) {
  return (
    <View style={styles.side} accessibilityRole="tablist">
      <LogoTile size={46} />
      <View style={styles.sideItems}>
        {SECTIONS.map((s) => {
          const selected = s.key === current;
          return (
            <Pressable
              key={s.key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={s.label}
              onPress={() => onSelect(s.key)}
              style={[styles.sideItem, selected && styles.sideItemSelected]}
            >
              <Icon name={s.icon} size={24} color={selected ? colors.brandBright : colors.onDarkMuted} />
              <Text style={[styles.sideLabel, selected && { color: colors.onDark }]}>{s.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bottom: { flexDirection: 'row', backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, paddingBottom: 6 },
  bottomTab: { flex: 1, minHeight: 64, alignItems: 'center', justifyContent: 'center', gap: 4 },
  bottomLabel: { fontSize: 15, fontWeight: '600' },
  bottomLabelSelected: { fontWeight: '800' },
  side: { width: 96, backgroundColor: colors.ink, borderRadius: 24, margin: 14, paddingVertical: 18, alignItems: 'center', gap: 26 },
  sideItems: { gap: 10, alignItems: 'center' },
  sideItem: { width: 72, minHeight: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 4 },
  sideItemSelected: { backgroundColor: colors.inkRaised },
  sideLabel: { fontSize: 12, fontWeight: '600', color: colors.onDarkMuted },
});
