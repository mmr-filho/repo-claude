import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useApp } from '../app-context';
import { errorText } from '../errors';
import { space, useTheme } from '../theme';
import { Banner, Body, Button, Card, Field, H1, H2, Muted, Row, Sheet } from '../ui';

const AUTO_LOCK = [
  { label: 'Imediatamente', seconds: 0 },
  { label: 'Após 30 segundos', seconds: 30 },
  { label: 'Após 1 minuto', seconds: 60 },
  { label: 'Após 5 minutos', seconds: 300 },
];
const IDLE = [
  { label: '2 min', minutes: 2 },
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: 'Nunca', minutes: 0 },
];
const POLL = [
  { label: '5 s', seconds: 5 },
  { label: '10 s', seconds: 10 },
  { label: '30 s', seconds: 30 },
  { label: '1 min', seconds: 60 },
];

export function SettingsScreen() {
  const { node, settings, updateSettings, lockNow, forgetDevice } = useApp();
  const t = useTheme();
  const [changing, setChanging] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const me = node.me;

  async function changePassword() {
    setError(undefined);
    if (next.length < 10) return setError('A nova senha precisa ter pelo menos 10 caracteres');
    if (next !== confirm) return setError('As senhas não conferem');
    setBusy(true);
    try {
      await node.changePassword(current, next);
      setChanging(false);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(errorText(err));
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
        <H2>{me?.name ?? node.profile.name}</H2>
        <Muted>Rede: {node.network?.name}</Muted>
        <Muted>{node.isAdmin ? 'Administrador da rede' : 'Membro'}</Muted>
        {me ? <Muted>Certificado válido até {new Date(me.exp).toLocaleDateString('pt-BR')} (renova sozinho)</Muted> : null}
        <Muted>Relé: {node.profile.relay.replace(/^https?:\/\//, '')}</Muted>
      </Card>
      {done ? <Banner>Senha alterada.</Banner> : null}

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
        <H2>Buscar mensagens a cada</H2>
        <Muted>Com a conversa aberta o app busca a cada poucos segundos. Mais espaçado economiza bateria, dados e pedidos ao relé, e as mensagens demoram mais para chegar. Não há notificação com o app fechado.</Muted>
        <Row style={{ flexWrap: 'wrap' }}>
          {POLL.map((o) => (
            <Button key={o.seconds} title={o.label} small variant={settings.pollSeconds === o.seconds ? 'primary' : 'secondary'} onPress={() => updateSettings({ pollSeconds: o.seconds })} />
          ))}
        </Row>
      </Card>

      <Card>
        <H2>Segurança</H2>
        <Muted>
          Sua senha protege as chaves guardadas neste aparelho e não existe em nenhum outro lugar. Mensagens lidas são apagadas do relé; o texto só existe na memória enquanto a conversa está aberta.
        </Muted>
        <Button title="Alterar senha" variant="secondary" onPress={() => { setDone(false); setChanging(true); }} />
        <Button title="Apagar identidade deste aparelho" variant="ghost" onPress={() => setForgetting(true)} />
      </Card>

      <Sheet visible={changing} onClose={() => setChanging(false)} title="Alterar senha">
        <Field label="Senha atual" value={current} onChangeText={setCurrent} secureTextEntry />
        <Field label="Nova senha" value={next} onChangeText={setNext} secureTextEntry />
        <Field label="Repita a nova senha" value={confirm} onChangeText={setConfirm} secureTextEntry />
        {error ? <Banner kind="error">{error}</Banner> : null}
        <Button title="Alterar" onPress={changePassword} busy={busy} disabled={!current || !next} />
      </Sheet>

      <Sheet visible={forgetting} onClose={() => setForgetting(false)} title="Apagar identidade">
        <Body>Isto apaga as suas chaves, os contatos e a caixa postal deste aparelho. Não tem volta.</Body>
        <Banner kind="warn">
          {node.isAdmin
            ? 'Você é o administrador: a chave da rede está só aqui. Apagar significa perder a rede, e ninguém mais poderá convidar pessoas nem aprovar conexões.'
            : 'Para voltar à rede, o administrador precisa emitir um convite novo. Mensagens ainda não lidas se perdem.'}
        </Banner>
        <Button title="Apagar para sempre" variant="danger" onPress={() => void forgetDevice()} />
        <Button title="Cancelar" variant="secondary" onPress={() => setForgetting(false)} />
      </Sheet>
      <View style={{ height: space.xl }} />
    </ScrollView>
  );
}
