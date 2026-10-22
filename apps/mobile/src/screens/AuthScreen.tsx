import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SigiloSession } from '@sigilo/core';
import { Banner, Body, Button, Card, Field, H1, Muted, Row, Screen, errorMessage } from '../ui';
import { normalizeHandle, normalizeServerUrl } from '../server-url';
import { localVaultStoreFor, pinStoreFor, type Settings, type StoredAuth } from '../storage';

const MIN_PASSWORD = 10;
const DEVICE = Platform.OS === 'ios' ? 'iPhone' : 'Android';

export function AuthScreen({
  settings,
  notice,
  onAuthenticated,
}: {
  settings: Settings;
  notice?: string;
  onAuthenticated: (session: SigiloSession, auth: StoredAuth) => Promise<void>;
}) {
  const [mode, setMode] = useState<'login' | 'activate'>('login');
  const [server, setServer] = useState(settings.lastServer);
  const [handle, setHandle] = useState(settings.lastHandle);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    setError(undefined);
    try {
      const baseUrl = normalizeServerUrl(server);
      const user = normalizeHandle(handle);
      if (!/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9-]*$/.test(user)) throw new Error('Usuário no formato nome@rede (ex.: maria@unirg)');
      if (mode === 'activate') {
        if (code.trim().length < 8) throw new Error('Digite o código de ativação entregue pelo administrador');
        if (password.length < MIN_PASSWORD) throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres`);
        if (password !== confirm) throw new Error('As senhas não conferem');
      } else if (!password) {
        throw new Error('Digite a senha');
      }
      setBusy(true);
      const common = { baseUrl, handle: user, password, pinStore: pinStoreFor(user), localVault: localVaultStoreFor(user), deviceName: DEVICE };
      const session =
        mode === 'activate'
          ? await SigiloSession.activate({ ...common, activationCode: code })
          : await SigiloSession.login(common);
      await onAuthenticated(session, { baseUrl, handle: user, token: session.token });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingVertical: 24, gap: 16 }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: 4 }}>
            <H1>🔒 Sigilo</H1>
            <Muted>Mensagens que só você lê e que se apagam depois de lidas.</Muted>
          </View>

          {notice ? <Banner kind="warn">{notice}</Banner> : null}

          <Row>
            <View style={{ flex: 1 }}>
              <Button title="Entrar" variant={mode === 'login' ? 'primary' : 'secondary'} onPress={() => setMode('login')} small />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Ativar conta" variant={mode === 'activate' ? 'primary' : 'secondary'} onPress={() => setMode('activate')} small />
            </View>
          </Row>

          <Card>
            <Field
              label="Servidor"
              value={server}
              onChangeText={setServer}
              placeholder="https://sigilo.suaorganizacao.com"
              keyboardType="url"
            />
            <Field label="Usuário" value={handle} onChangeText={setHandle} placeholder="maria@unirg" keyboardType="email-address" />
            {mode === 'activate' ? (
              <Field label="Código de ativação" value={code} onChangeText={setCode} placeholder="XXXX-XXXX-XXXX-XXXX" autoCapitalize="characters" />
            ) : null}
            <Field
              label={mode === 'activate' ? 'Escolha sua senha' : 'Senha'}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="password"
              returnKeyType={mode === 'login' ? 'go' : 'next'}
              onSubmitEditing={mode === 'login' ? submit : undefined}
            />
            {mode === 'activate' ? <Field label="Repita a senha" value={confirm} onChangeText={setConfirm} secureTextEntry onSubmitEditing={submit} /> : null}
          </Card>

          {mode === 'activate' ? (
            <Banner kind="warn">
              Esta senha gera a chave que abre suas mensagens e não é guardada em lugar nenhum. Se você a esquecer, o administrador da rede só consegue
              liberar uma conta nova — o que estava pendente se perde.
            </Banner>
          ) : (
            <Muted>Contas são criadas pelo administrador da sua rede. Peça seu código de ativação a ele.</Muted>
          )}

          {error ? <Banner kind="error">{error}</Banner> : null}
          <Button title={mode === 'activate' ? 'Ativar e entrar' : 'Entrar'} onPress={submit} busy={busy} />
          {busy ? <Body>Gerando chaves de segurança… isso pode levar alguns segundos.</Body> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
