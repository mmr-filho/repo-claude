import { useState } from 'react';
import { View } from 'react-native';
import type { LocalNode } from '@sigilo/core/v2';
import { useApp } from '../app-context';
import { errorText } from '../errors';
import { Banner, Body, Button, H1, Muted, Screen, Strong } from '../ui';

/** O pedido de entrada foi enviado; o administrador aprova ao abrir o app dele. A consulta periódica traz a resposta. */
export function PendingScreen() {
  const { node, forgetDevice, online } = useApp();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function retry(n: LocalNode) {
    setBusy(true);
    try {
      await n.retryEnrollment();
      setMsg('Pedido reenviado.');
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
        <H1>⏳ Aguardando aprovação</H1>
        <Body>
          Seu pedido para entrar em <Strong>{node.profile.networkName}</Strong> foi enviado. Assim que o administrador abrir o app dele, você entra
          automaticamente. Pode deixar este app aberto.
        </Body>
        {!online ? <Banner kind="warn">Sem conexão com o relé. Vamos tentar de novo.</Banner> : null}
        {msg ? <Banner>{msg}</Banner> : null}
        <Button title="Reenviar pedido" variant="secondary" onPress={() => void retry(node)} busy={busy} />
        <Button title="Cancelar e apagar" variant="ghost" onPress={() => void forgetDevice()} />
        <Muted>O convite vale uma vez. Se ele já foi usado ou venceu, peça outro ao administrador.</Muted>
      </View>
    </Screen>
  );
}
