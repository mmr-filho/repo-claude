import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Body, Button, Sheet } from '../ui';

/** Lê um QR code com a câmera. O texto lido é entregue a `onCode`; se não houver câmera, dá para colar o código. */
export function ScanSheet({ visible, onCode, onClose }: { visible: boolean; onCode: (code: string) => void; onClose: () => void }) {
  const [permission, request] = useCameraPermissions();
  const done = useRef(false);

  useEffect(() => {
    if (visible) done.current = false;
  }, [visible]);

  return (
    <Sheet visible={visible} onClose={onClose} title="Ler QR code">
      {!permission ? (
        <Body>Verificando a câmera…</Body>
      ) : !permission.granted ? (
        <>
          <Body>O app precisa de acesso à câmera só para ler o QR code. Nada é gravado.</Body>
          <Button title="Permitir câmera" onPress={() => void request()} />
        </>
      ) : (
        <View style={{ height: 300, borderRadius: 12, overflow: 'hidden' }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (done.current || !data) return;
              done.current = true;
              onCode(data);
            }}
          />
        </View>
      )}
      <Button title="Cancelar" variant="secondary" onPress={onClose} />
    </Sheet>
  );
}
