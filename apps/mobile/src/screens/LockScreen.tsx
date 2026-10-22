import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, View } from 'react-native';
import type { LocalNode } from '@sigilo/core/v2';
import { errorText } from '../errors';
import { Banner, Body, Button, Field, H1, Muted, Screen, Sheet, Strong } from '../ui';

/**
 * Cofre trancado. Sem a senha o app só sabe QUANTAS mensagens esperam (chave da caixa postal, que não lê conteúdo).
 */
export function LockScreen({ node, onUnlocked, onForget }: { node: LocalNode; onUnlocked: () => void; onForget: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [waiting, setWaiting] = useState<number | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const profile = node.profile;

  useEffect(() => {
    let alive = true;
    node
      .pendingCount()
      .then((n) => alive && setWaiting(n))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [node]);

  async function unlock() {
    if (!password) return;
    setBusy(true);
    setError(undefined);
    try {
      await node.unlock(password);
      setPassword('');
      onUnlocked();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <H1>🔒 Cofre trancado</H1>
          {profile.name ? <Body>{profile.name}</Body> : null}
          {profile.networkName ? <Muted>{profile.networkName}</Muted> : null}
        </View>
        {waiting ? <Banner>{waiting === 1 ? '1 item aguarda' : `${waiting} itens aguardam`} a sua senha para ser aberto.</Banner> : null}
        <Field label="Senha" value={password} onChangeText={setPassword} secureTextEntry autoFocus returnKeyType="go" onSubmitEditing={unlock} error={error} />
        <Button title="Destrancar" onPress={unlock} busy={busy} disabled={!password} />
        {busy ? <Muted style={{ textAlign: 'center' }}>Derivando a chave… pode levar alguns segundos.</Muted> : null}
        <Button title="Esqueci a senha" variant="ghost" onPress={() => setForgetting(true)} />
      </KeyboardAvoidingView>

      <Sheet visible={forgetting} onClose={() => setForgetting(false)} title="Esqueci a senha">
        <Body>
          A senha não está guardada em lugar nenhum, então não há como recuperá-la. O que dá para fazer é <Strong>apagar a identidade deste aparelho</Strong> e pedir um convite novo
          ao administrador da rede.
        </Body>
        <Banner kind="warn">As mensagens que ainda não foram lidas se perdem. Seus contatos verão um aviso de troca de chave.</Banner>
        <Button title="Apagar identidade deste aparelho" variant="danger" onPress={() => void onForget()} />
        <Button title="Voltar" variant="secondary" onPress={() => setForgetting(false)} />
      </Sheet>
    </Screen>
  );
}
