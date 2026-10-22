import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, KeyboardAvoidingView, Platform, View } from 'react-native';
import { StaleVaultKeyError, type LocalNode } from '@sigilo/core/v2';
import { BiometricGone, readBiometricKey } from '../biometric';
import { errorText } from '../errors';
import { Banner, Body, Button, Field, H1, Muted, Screen, Sheet, Strong } from '../ui';

const BIO_LABEL = Platform.OS === 'ios' ? 'Destrancar com Face ID / Touch ID' : 'Destrancar com a digital';

/**
 * Cofre trancado. Sem a senha o app só sabe QUANTAS mensagens esperam (chave da caixa postal, que não lê conteúdo).
 * Com a digital ativada, o toque no sensor libera a chave guardada no hardware e destranca sem digitar a senha.
 */
export function LockScreen({
  node,
  biometric,
  onBiometricInvalid,
  onUnlocked,
  onForget,
}: {
  node: LocalNode;
  /** Digital ativada e disponível neste aparelho. */
  biometric: boolean;
  /** A chave da digital não serve mais: o app a apaga e desativa a opção. */
  onBiometricInvalid: () => void;
  onUnlocked: () => void;
  onForget: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [waiting, setWaiting] = useState<number | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const bioBusy = useRef(false);
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

  const tryBiometric = useCallback(async () => {
    if (!biometric || bioBusy.current) return;
    bioBusy.current = true;
    setError(undefined);
    try {
      const key = await readBiometricKey();
      await node.unlockWithKey(key);
      onUnlocked();
    } catch (err) {
      if (err instanceof BiometricGone || err instanceof StaleVaultKeyError) {
        onBiometricInvalid();
        setNotice('A digital foi desativada (a senha foi trocada ou as digitais do aparelho mudaram). Digite a senha para entrar.');
      }
      // Cancelou ou errou o dedo: fica na tela, com o botão e a senha.
    } finally {
      bioBusy.current = false;
    }
  }, [biometric, node, onUnlocked, onBiometricInvalid]);

  // Pede a digital ao abrir a tela e quando o app volta ao primeiro plano (nunca em segundo plano).
  useEffect(() => {
    if (!biometric) return;
    if (AppState.currentState === 'active') void tryBiometric();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void tryBiometric());
    return () => sub.remove();
  }, [biometric, tryBiometric]);

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
        {waiting ? <Banner>{waiting === 1 ? '1 item aguarda' : `${waiting} itens aguardam`} para ser aberto.</Banner> : null}
        {notice ? <Banner kind="warn">{notice}</Banner> : null}
        {biometric ? <Button title={`🖐 ${BIO_LABEL}`} onPress={() => void tryBiometric()} /> : null}
        <Field label="Senha" value={password} onChangeText={setPassword} secureTextEntry autoFocus={!biometric} returnKeyType="go" onSubmitEditing={unlock} error={error} />
        <Button title="Destrancar com a senha" variant={biometric ? 'secondary' : 'primary'} onPress={unlock} busy={busy} disabled={!password} />
        {busy ? <Muted style={{ textAlign: 'center' }}>Derivando a chave… pode levar alguns segundos.</Muted> : null}
        <Button title="Esqueci a senha" variant="ghost" onPress={() => setForgetting(true)} />
      </KeyboardAvoidingView>

      <Sheet visible={forgetting} onClose={() => setForgetting(false)} title="Esqueci a senha">
        <Body>
          A senha não está guardada em lugar nenhum, então não há como recuperá-la. O que dá para fazer é <Strong>apagar a identidade deste aparelho</Strong> e pedir um convite novo ao administrador da rede.
        </Body>
        <Banner kind="warn">As mensagens que ainda não foram lidas se perdem. Seus contatos verão um aviso de troca de chave.</Banner>
        <Button title="Apagar identidade deste aparelho" variant="danger" onPress={() => void onForget()} />
        <Button title="Voltar" variant="secondary" onPress={() => setForgetting(false)} />
      </Sheet>
    </Screen>
  );
}
