import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { space, useTheme } from './theme';

export function Screen({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.bg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingHorizontal: padded ? space.lg : 0,
      }}
    >
      {children}
    </View>
  );
}

export function H1({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={{ fontSize: 26, fontWeight: '700', color: t.text }}>{children}</Text>;
}

export function H2({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={{ fontSize: 17, fontWeight: '600', color: t.text }}>{children}</Text>;
}

export function Body({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <Text style={[{ fontSize: 15, lineHeight: 21, color: t.text }, style as object]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  const t = useTheme();
  return <Text style={[{ fontSize: 13, lineHeight: 18, color: t.muted }, style]}>{children}</Text>;
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  variant = 'primary',
  busy,
  disabled,
  small,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  busy?: boolean;
  disabled?: boolean;
  small?: boolean;
}) {
  const t = useTheme();
  const bg = { primary: t.primary, secondary: t.surfaceAlt, danger: t.danger, ghost: 'transparent' }[variant];
  const fg = { primary: t.onPrimary, secondary: t.text, danger: '#FFFFFF', ghost: t.primary }[variant];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={off ? undefined : onPress}
      style={({ pressed }) => ({
        backgroundColor: bg,
        opacity: off ? 0.5 : pressed ? 0.85 : 1,
        paddingVertical: small ? 8 : 13,
        paddingHorizontal: small ? 12 : 16,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
      })}
    >
      {busy ? <ActivityIndicator color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: '600', fontSize: small ? 14 : 16 }}>{title}</Text>
    </Pressable>
  );
}

export function Field({ label, error, ...input }: { label: string; error?: string } & TextInputProps) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: t.muted }}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        autoCapitalize="none"
        autoCorrect={false}
        {...input}
        style={[
          {
            backgroundColor: t.surface,
            color: t.text,
            borderColor: error ? t.danger : t.border,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 16,
          },
          input.style,
        ]}
      />
      {error ? <Text style={{ color: t.danger, fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[{ backgroundColor: t.surface, borderRadius: 14, borderColor: t.border, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.sm }, style]}>
      {children}
    </View>
  );
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const t = useTheme();
  const color = kind === 'error' ? t.danger : kind === 'warn' ? t.warn : t.primary;
  return (
    <View style={{ borderLeftWidth: 4, borderLeftColor: color, backgroundColor: t.surfaceAlt, borderRadius: 8, padding: space.md }}>
      <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

export function Badge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const t = useTheme();
  const color = { neutral: t.muted, good: t.primary, warn: t.warn, bad: t.danger }[tone];
  return (
    <Text style={{ color, borderColor: color, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1, fontSize: 11, fontWeight: '600', overflow: 'hidden' }}>
      {text}
    </Text>
  );
}

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const t = useTheme();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: t.primary, fontWeight: '700', fontSize: size * 0.36 }}>{initials || '?'}</Text>
    </View>
  );
}

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: t.overlay }} onPress={onClose} />
      <View style={{ backgroundColor: t.bg, padding: space.lg, paddingBottom: space.lg + insets.bottom, borderTopLeftRadius: 20, borderTopRightRadius: 20, gap: space.md }}>
        <H2>{title}</H2>
        {children}
      </View>
    </Modal>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={{ alignItems: 'center', padding: space.xl, gap: space.sm }}>
      <Text style={{ fontSize: 34 }}>🔒</Text>
      <H2>{title}</H2>
      {hint ? <Muted style={{ textAlign: 'center' }}>{hint}</Muted> : null}
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md }, style]}>{children}</View>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Algo deu errado';
}
