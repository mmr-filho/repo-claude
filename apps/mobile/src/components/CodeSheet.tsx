import { useState } from 'react';
import { Share, Text, View, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { space, useTheme } from '../theme';
import { Body, Button, Muted, Row, Sheet } from '../ui';
import { QrCode } from './QrCode';

export interface CodeInfo {
  title: string;
  code: string;
  note: string;
  /** Texto de validade, se houver. */
  expires?: string;
}

/** Mostra um código (convite, código da rede) como texto e QR code, para copiar, compartilhar ou ler de outro aparelho. */
export function CodeSheet({ info, onClose }: { info: CodeInfo | null; onClose: () => void }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const qrSize = Math.min(300, width - 64);
  const [copied, setCopied] = useState(false);
  const close = () => {
    setCopied(false);
    onClose();
  };
  return (
    <Sheet visible={!!info} onClose={close} title={info?.title ?? ''}>
      <Body>{info?.note}</Body>
      {info ? (
        <View style={{ alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 12, padding: space.sm }}>
          <QrCode value={info.code} size={qrSize} />
        </View>
      ) : null}
      <View style={{ backgroundColor: t.surfaceAlt, borderRadius: 12, padding: space.md }}>
        <Text selectable numberOfLines={3} style={{ color: t.muted, fontSize: 12 }} accessibilityLabel="Código em texto">
          {info?.code}
        </Text>
      </View>
      {info?.expires ? <Muted>Válido até {info.expires}. Aparece só agora: leia o QR code ou copie.</Muted> : null}
      <Row>
        <View style={{ flex: 1 }}>
          <Button
            title={copied ? 'Copiado ✓' : 'Copiar'}
            variant="secondary"
            onPress={() => void Clipboard.setStringAsync(info?.code ?? '').then(() => setCopied(true))}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Compartilhar" variant="secondary" onPress={() => void Share.share({ message: info?.code ?? '' }).catch(() => undefined)} />
        </View>
      </Row>
      <Button title="Pronto" onPress={close} />
    </Sheet>
  );
}
