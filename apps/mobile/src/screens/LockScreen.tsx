import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, View } from 'react-native';
import { WrongPasswordError, type SigiloSession } from '@sigilo/core';
import { Banner, Body, Button, Field, H1, Muted, Screen, errorMessage } from '../ui';

/**
 * Cofre trancado: o app só sabe QUANTAS mensagens esperam (metadado do servidor).
 * O conteúdo continua cifrado até a senha ser digitada aqui.
 */
export function LockScreen({
  session,
  onUnlocked,
  onLogout,
}: {
  session: SigiloSession;
  onUnlocked: () => void;
  onLogout: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [waiting, setWaiting] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    session
      .summary()
      .then((list) => alive && setWaiting(list.reduce((n, c) => n + c.incoming, 0)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session]);

  async function unlock() {
    if (!password) return;
    setBusy(true);
    setError(undefined);
    try {
      await session.unlock(password);
      setPassword('');
      onUnlocked();
    } catch (err) {
      setError(err instanceof WrongPasswordError ? 'Senha incorreta' : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <H1>🔒 Cofre trancado</H1>
          <Body>{session.user.displayName}</Body>
          <Muted>
            {session.user.handle} · {session.user.networkName}
          </Muted>
        </View>
        {waiting ? <Banner>{waiting === 1 ? '1 mensagem aguarda' : `${waiting} mensagens aguardam`} sua senha para ser aberta.</Banner> : null}
        <Field
          label="Senha"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoFocus
          returnKeyType="go"
          onSubmitEditing={unlock}
          error={error}
        />
        <Button title="Destrancar" onPress={unlock} busy={busy} disabled={!password} />
        {busy ? <Muted style={{ textAlign: 'center' }}>Derivando a chave de leitura…</Muted> : null}
        <Button title="Sair desta conta" variant="ghost" onPress={onLogout} />
      </KeyboardAvoidingView>
    </Screen>
  );
}
