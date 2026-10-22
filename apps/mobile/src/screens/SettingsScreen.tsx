import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { WrongPasswordError } from '@sigilo/core';
import { useApp } from '../app-context';
import { space, useTheme } from '../theme';
import { Banner, Body, Button, Card, Field, H1, H2, Muted, Row, Sheet, errorMessage } from '../ui';

const AUTO_LOCK: Array<{ label: string; seconds: number }> = [
  { label: 'Imediatamente', seconds: 0 },
  { label: 'Após 30 segundos', seconds: 30 },
  { label: 'Após 1 minuto', seconds: 60 },
  { label: 'Após 5 minutos', seconds: 300 },
];
const IDLE: Array<{ label: string; minutes: number }> = [
  { label: '2 min', minutes: 2 },
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: 'Nunca', minutes: 0 },
];

export function SettingsScreen() {
  const { session, settings, updateSettings, lockNow, logout } = useApp();
  const t = useTheme();
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function changePassword() {
    setError(undefined);
    if (next.length < 10) return setError('A nova senha precisa ter pelo menos 10 caracteres');
    if (next !== confirm) return setError('As senhas não conferem');
    setBusy(true);
    try {
      await session.changePassword(current, next);
      setChanging(false);
      setCurrent('');
      setNext('');
      setConfirm('');
      Alert.alert('Senha alterada', 'Os outros aparelhos desta conta foram desconectados.');
    } catch (err) {
      setError(err instanceof WrongPasswordError ? 'A senha atual está incorreta' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const Choice = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => (
    <Pressable onPress={onPress} style={{ paddingVertical: 10 }}>
      <Row>
        <Text style={{ color: active ? t.primary : t.muted, fontSize: 18 }}>{active ? '◉' : '○'}</Text>
        <Body>{label}</Body>
      </Row>
    </Pressable>
  );

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <H1>Ajustes</H1>
      <Card>
        <H2>{session.user.displayName}</H2>
        <Muted>{session.user.handle}</Muted>
        <Muted>Rede: {session.user.networkName}</Muted>
      </Card>

      <Button title="🔒 Trancar agora" onPress={lockNow} />

      <Card>
        <H2>Trancar ao sair do app</H2>
        {AUTO_LOCK.map((o) => (
          <Choice key={o.seconds} label={o.label} active={settings.autoLockSeconds === o.seconds} onPress={() => updateSettings({ autoLockSeconds: o.seconds })} />
        ))}
      </Card>

      <Card>
        <H2>Trancar por inatividade</H2>
        <Row style={{ flexWrap: 'wrap' }}>
          {IDLE.map((o) => (
            <Button key={o.minutes} title={o.label} small variant={settings.idleLockMinutes === o.minutes ? 'primary' : 'secondary'} onPress={() => updateSettings({ idleLockMinutes: o.minutes })} />
          ))}
        </Row>
      </Card>

      <Card>
        <H2>Segurança</H2>
        <Muted>
          Sua senha gera a chave que abre as mensagens e nunca sai deste aparelho. Mensagens lidas são apagadas do servidor; o texto só existe na memória enquanto a conversa está aberta.
        </Muted>
        <Button title="Alterar senha" variant="secondary" onPress={() => setChanging(true)} />
      </Card>

      <Button
        title="Sair da conta"
        variant="danger"
        onPress={() =>
          Alert.alert('Sair da conta?', 'Você precisará da senha para entrar de novo.', [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Sair', style: 'destructive', onPress: () => void logout() },
          ])
        }
      />

      <Sheet visible={changing} onClose={() => setChanging(false)} title="Alterar senha">
        <Field label="Senha atual" value={current} onChangeText={setCurrent} secureTextEntry />
        <Field label="Nova senha" value={next} onChangeText={setNext} secureTextEntry />
        <Field label="Repita a nova senha" value={confirm} onChangeText={setConfirm} secureTextEntry />
        {error ? <Banner kind="error">{error}</Banner> : null}
        <Button title="Alterar" onPress={changePassword} busy={busy} disabled={!current || !next} />
      </Sheet>
      <View style={{ height: space.xl }} />
    </ScrollView>
  );
}
