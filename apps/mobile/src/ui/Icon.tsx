import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

/**
 * Small line icons drawn with plain views, so no icon library, SVG package or
 * remote asset is needed (D50). Purely decorative: hidden from screen readers,
 * because every icon sits next to a text label.
 */
export type IconName =
  | 'leaf'
  | 'grid'
  | 'download'
  | 'laptop'
  | 'lock'
  | 'close'
  | 'arrowRight'
  | 'drop'
  | 'bolt'
  | 'thermometer'
  | 'alert'
  | 'table'
  | 'swap'
  | 'signal'
  | 'check'
  | 'cloudOff';

interface IconProps {
  name: IconName;
  size?: number;
  color: string;
}

export function Icon({ name, size = 22, color }: IconProps) {
  const s = size;
  const line = Math.max(1.5, Math.round(s / 11));
  const box: ViewStyle = { width: s, height: s, alignItems: 'center', justifyContent: 'center' };
  const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };

  switch (name) {
    case 'leaf':
      return (
        <View style={box} {...hidden}>
          <View
            style={{
              width: s * 0.62,
              height: s * 0.62,
              borderWidth: line,
              borderColor: color,
              borderTopLeftRadius: s * 0.62,
              borderBottomRightRadius: s * 0.62,
              transform: [{ rotate: '0deg' }],
            }}
          />
          <View style={{ position: 'absolute', width: line, height: s * 0.6, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
        </View>
      );
    case 'grid':
      return (
        <View style={[box, { flexDirection: 'row', flexWrap: 'wrap', gap: s * 0.12, width: s * 0.82 }]} {...hidden}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ width: s * 0.33, height: s * 0.33, borderWidth: line, borderColor: color, borderRadius: s * 0.08 }} />
          ))}
        </View>
      );
    case 'download':
      return (
        <View style={box} {...hidden}>
          <View style={{ position: 'absolute', top: s * 0.1, width: line, height: s * 0.55, backgroundColor: color }} />
          <View
            style={{
              position: 'absolute',
              top: s * 0.36,
              width: s * 0.32,
              height: s * 0.32,
              borderRightWidth: line,
              borderBottomWidth: line,
              borderColor: color,
              transform: [{ rotate: '45deg' }],
            }}
          />
          <View style={{ position: 'absolute', bottom: s * 0.12, width: s * 0.7, height: line, backgroundColor: color }} />
        </View>
      );
    case 'laptop':
      return (
        <View style={box} {...hidden}>
          <View style={{ width: s * 0.66, height: s * 0.44, borderWidth: line, borderColor: color, borderRadius: s * 0.06 }} />
          <View style={{ marginTop: s * 0.06, width: s * 0.86, height: line, backgroundColor: color, borderRadius: line }} />
        </View>
      );
    case 'lock':
      return (
        <View style={box} {...hidden}>
          <View
            style={{ width: s * 0.4, height: s * 0.3, borderWidth: line, borderBottomWidth: 0, borderColor: color, borderTopLeftRadius: s, borderTopRightRadius: s }}
          />
          <View style={{ width: s * 0.62, height: s * 0.42, borderWidth: line, borderColor: color, borderRadius: s * 0.08 }} />
        </View>
      );
    case 'close':
      return (
        <View style={box} {...hidden}>
          <View style={[styles.bar, { width: s * 0.7, height: line, backgroundColor: color, transform: [{ rotate: '45deg' }] }]} />
          <View style={[styles.bar, { width: s * 0.7, height: line, backgroundColor: color, transform: [{ rotate: '-45deg' }] }]} />
        </View>
      );
    case 'arrowRight':
      return (
        <View style={box} {...hidden}>
          <View style={{ position: 'absolute', width: s * 0.66, height: line, backgroundColor: color }} />
          <View
            style={{
              position: 'absolute',
              right: s * 0.18,
              width: s * 0.34,
              height: s * 0.34,
              borderTopWidth: line,
              borderRightWidth: line,
              borderColor: color,
              transform: [{ rotate: '45deg' }],
            }}
          />
        </View>
      );
    case 'drop':
      return (
        <View style={box} {...hidden}>
          <View
            style={{
              width: s * 0.5,
              height: s * 0.5,
              marginTop: s * 0.12,
              borderWidth: line,
              borderColor: color,
              borderTopLeftRadius: 0,
              borderTopRightRadius: s,
              borderBottomLeftRadius: s,
              borderBottomRightRadius: s,
              transform: [{ rotate: '-45deg' }],
            }}
          />
        </View>
      );
    case 'bolt':
      return (
        <View style={box} {...hidden}>
          <View style={{ position: 'absolute', width: line * 1.4, height: s * 0.46, backgroundColor: color, top: s * 0.08, left: s * 0.48, transform: [{ rotate: '25deg' }] }} />
          <View style={{ position: 'absolute', width: s * 0.36, height: line * 1.4, backgroundColor: color, top: s * 0.48, left: s * 0.32 }} />
          <View style={{ position: 'absolute', width: line * 1.4, height: s * 0.46, backgroundColor: color, top: s * 0.46, left: s * 0.42, transform: [{ rotate: '25deg' }] }} />
        </View>
      );
    case 'thermometer':
      return (
        <View style={box} {...hidden}>
          <View style={{ width: s * 0.26, height: s * 0.56, borderWidth: line, borderBottomWidth: 0, borderColor: color, borderTopLeftRadius: s, borderTopRightRadius: s }} />
          <View style={{ width: s * 0.4, height: s * 0.4, marginTop: -s * 0.06, borderWidth: line, borderColor: color, borderRadius: s }} />
        </View>
      );
    case 'alert':
      return (
        <View style={[box, { borderWidth: line, borderColor: color, borderRadius: s }]} {...hidden}>
          <Text style={{ color, fontSize: s * 0.6, lineHeight: s * 0.7, fontWeight: '800' }}>!</Text>
        </View>
      );
    case 'table':
      return (
        <View style={box} {...hidden}>
          <View style={{ width: s * 0.74, height: s * 0.66, borderWidth: line, borderColor: color, borderRadius: s * 0.08, justifyContent: 'space-evenly' }}>
            <View style={{ height: line, backgroundColor: color }} />
            <View style={{ height: line, backgroundColor: color }} />
          </View>
          <View style={{ position: 'absolute', width: line, height: s * 0.66, backgroundColor: color, left: s * 0.42 }} />
        </View>
      );
    case 'swap':
      return (
        <View style={box} {...hidden}>
          <Text style={{ color, fontSize: s * 0.8, lineHeight: s, fontWeight: '700' }}>⇄</Text>
        </View>
      );
    case 'signal':
      return (
        <View style={[box, { justifyContent: 'flex-end' }]} {...hidden}>
          {[0.9, 0.6, 0.3].map((f) => (
            <View
              key={f}
              style={{
                position: 'absolute',
                bottom: s * 0.16,
                width: s * f,
                height: s * f,
                borderWidth: line,
                borderColor: color,
                borderRadius: s,
                borderBottomColor: 'transparent',
                borderLeftColor: f === 0.3 ? color : 'transparent',
                borderRightColor: f === 0.3 ? color : 'transparent',
                transform: [{ translateY: (s * f) / 2 }],
              }}
            />
          ))}
        </View>
      );
    case 'check':
      return (
        <View style={box} {...hidden}>
          <View
            style={{
              width: s * 0.3,
              height: s * 0.56,
              borderRightWidth: line * 1.2,
              borderBottomWidth: line * 1.2,
              borderColor: color,
              marginTop: -s * 0.1,
              transform: [{ rotate: '45deg' }],
            }}
          />
        </View>
      );
    case 'cloudOff':
      return (
        <View style={box} {...hidden}>
          <View style={{ width: s * 0.74, height: s * 0.42, borderWidth: line, borderColor: color, borderRadius: s }} />
          <View style={{ position: 'absolute', width: s * 0.9, height: line, backgroundColor: color, transform: [{ rotate: '-35deg' }] }} />
        </View>
      );
  }
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', borderRadius: 2 },
});
