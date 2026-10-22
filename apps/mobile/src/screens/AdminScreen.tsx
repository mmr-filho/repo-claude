import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Share, Switch, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { InviteDTO, LinkDTO, LinksOverview, MemberDTO, MemberWithCode } from '@sigilo/core';
import { useApp, useServerEvents } from '../app-context';
import { space, useTheme } from '../theme';
import { Avatar, Badge, Banner, Body, Button, Card, Field, H1, H2, Muted, Row, Sheet, errorMessage } from '../ui';

export function AdminScreen() {
  const t = useTheme();
  const [section, setSection] = useState<'members' | 'links'>('members');
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: space.lg, gap: space.sm }}>
        <H1>Administração</H1>
        <Row>
          <View style={{ flex: 1 }}>
            <Button title="Membros" small variant={section === 'members' ? 'primary' : 'secondary'} onPress={() => setSection('members')} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Redes conectadas" small variant={section === 'links' ? 'primary' : 'secondary'} onPress={() => setSection('links')} />
          </View>
        </Row>
      </View>
      <View style={{ flex: 1, borderTopWidth: 1, borderTopColor: t.border }}>{section === 'members' ? <Members /> : <Links />}</View>
    </View>
  );
}

const STATUS: Record<MemberDTO['status'], { text: string; tone: 'good' | 'warn' | 'bad' }> = {
  active: { text: 'ativo', tone: 'good' },
  pending: { text: 'aguardando ativação', tone: 'warn' },
  disabled: { text: 'desativado', tone: 'bad' },
};

function CodeSheet({ result, title, onClose }: { result: { code: string; expiresAt: number; note: string } | null; title: string; onClose: () => void }) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  return (
    <Sheet visible={!!result} onClose={onClose} title={title}>
      <Body>{result?.note}</Body>
      <View style={{ backgroundColor: t.surfaceAlt, borderRadius: 12, padding: space.lg, alignItems: 'center' }}>
        <Text selectable style={{ color: t.text, fontSize: 24, fontWeight: '700', letterSpacing: 2 }}>
          {result?.code}
        </Text>
      </View>
      <Muted>Válido até {result ? new Date(result.expiresAt).toLocaleString('pt-BR') : ''}. Aparece só agora: anote ou envie por um canal seguro.</Muted>
      <Row>
        <View style={{ flex: 1 }}>
          <Button
            title={copied ? 'Copiado ✓' : 'Copiar'}
            variant="secondary"
            onPress={() => {
              void Clipboard.setStringAsync(result?.code ?? '').then(() => setCopied(true));
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Compartilhar" variant="secondary" onPress={() => void Share.share({ message: result?.code ?? '' })} />
        </View>
      </Row>
      <Button
        title="Pronto"
        onPress={() => {
          setCopied(false);
          onClose();
        }}
      />
    </Sheet>
  );
}

function Members() {
  const { session } = useApp();
  const t = useTheme();
  const [members, setMembers] = useState<MemberDTO[]>([]);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [asAdmin, setAsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: number; note: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMembers(await session.api.members());
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [session]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useServerEvents((e) => e.type === 'contacts.changed' && void refresh());

  const showCode = (r: MemberWithCode, note: string) => setCode({ code: r.activationCode, expiresAt: r.activationExpiresAt, note });

  async function create() {
    setBusy(true);
    try {
      const result = await session.api.createMember({ username: username.trim().toLowerCase(), displayName: displayName.trim(), role: asAdmin ? 'admin' : 'member' });
      setCreating(false);
      setUsername('');
      setDisplayName('');
      setAsAdmin(false);
      showCode(result, `Entregue este código a ${result.member.displayName}. No app: "Ativar conta" com o usuário ${result.member.handle}.`);
      await refresh();
    } catch (err) {
      Alert.alert('Não foi possível criar', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function actions(m: MemberDTO) {
    const run = (fn: () => Promise<unknown>) => fn().then(refresh).catch((err) => Alert.alert('Erro', errorMessage(err)));
    const buttons = [
      {
        text: 'Gerar novo código (esqueceu a senha)',
        onPress: () =>
          Alert.alert('Zerar a conta?', 'A pessoa precisará ativar de novo e escolher outra senha. Mensagens pendentes dela serão perdidas e os contatos verão um aviso de troca de chave.', [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Gerar código', style: 'destructive', onPress: () => void run(async () => showCode(await session.api.resetActivation(m.id), `Novo código para ${m.displayName}.`)) },
          ]),
      },
      m.status === 'disabled'
        ? { text: 'Reativar conta', onPress: () => void run(() => session.api.enableMember(m.id)) }
        : { text: 'Desativar conta', style: 'destructive' as const, onPress: () => void run(() => session.api.disableMember(m.id)) },
      { text: 'Cancelar', style: 'cancel' as const },
    ];
    Alert.alert(m.displayName, m.handle, m.id === session.user.id ? [{ text: 'Esta é a sua conta', style: 'cancel' }] : buttons);
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.sm }}>
        {error ? <Banner kind="error">{error}</Banner> : null}
        <Button title="+ Novo membro" onPress={() => setCreating(true)} />
        {members.map((m) => (
          <Card key={m.id}>
            <Row>
              <Avatar name={m.displayName} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '600', fontSize: 16 }}>{m.displayName}</Text>
                <Muted>{m.handle}</Muted>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Badge text={STATUS[m.status].text} tone={STATUS[m.status].tone} />
                {m.role === 'admin' ? <Badge text="admin" /> : null}
              </View>
            </Row>
            <Button title="Opções" variant="ghost" small onPress={() => actions(m)} />
          </Card>
        ))}
      </ScrollView>

      <Sheet visible={creating} onClose={() => setCreating(false)} title="Novo membro">
        <Field label="Usuário (sem espaços)" value={username} onChangeText={setUsername} placeholder="maria" />
        <Field label="Nome" value={displayName} onChangeText={setDisplayName} placeholder="Maria Silva" autoCapitalize="words" />
        <Row>
          <Switch value={asAdmin} onValueChange={setAsAdmin} />
          <Body>Também será administradora da rede</Body>
        </Row>
        <Muted>A pessoa escolhe a própria senha ao ativar. O administrador nunca vê a senha nem as mensagens.</Muted>
        <Button title="Criar e gerar código" onPress={create} busy={busy} disabled={!username.trim() || !displayName.trim()} />
      </Sheet>
      <CodeSheet result={code} title="Código de ativação" onClose={() => setCode(null)} />
    </View>
  );
}

function Links() {
  const { session } = useApp();
  const [overview, setOverview] = useState<LinksOverview>({ active: [], incoming: [], outgoing: [] });
  const [error, setError] = useState<string>();
  const [slug, setSlug] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState<string>();
  const [invite, setInvite] = useState<{ code: string; expiresAt: number; note: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await session.api.links());
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [session]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useServerEvents((e) => e.type === 'contacts.changed' && void refresh());

  async function act(key: string, fn: () => Promise<unknown>, done?: () => void) {
    setBusy(key);
    try {
      await fn();
      done?.();
      await refresh();
    } catch (err) {
      Alert.alert('Não foi possível', errorMessage(err));
    } finally {
      setBusy(undefined);
    }
  }

  const confirmRevoke = (l: LinkDTO) =>
    Alert.alert(`Desconectar ${l.peerName}?`, 'As duas redes deixam de se ver e as mensagens ainda não lidas entre elas são apagadas.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Desconectar', style: 'destructive', onPress: () => void act(`rv${l.id}`, () => session.api.revokeLink(l.id)) },
    ]);

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Banner>
        Código da sua rede: <Text style={{ fontWeight: '700' }}>{session.user.networkSlug}</Text>. Outra rede usa este código para pedir conexão. Cada conexão vale só entre as duas redes
        e precisa ser aceita pelo administrador dos dois lados.
      </Banner>

      {overview.incoming.length ? (
        <Card>
          <H2>Pedidos recebidos</H2>
          {overview.incoming.map((l) => (
            <Row key={l.id} style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Body>{l.peerName}</Body>
                <Muted>{l.peerSlug}</Muted>
              </View>
              <Button title="Aceitar" small busy={busy === `a${l.id}`} onPress={() => void act(`a${l.id}`, () => session.api.acceptLink(l.id))} />
              <Button title="Recusar" small variant="secondary" onPress={() => void act(`r${l.id}`, () => session.api.rejectLink(l.id))} />
            </Row>
          ))}
        </Card>
      ) : null}

      <Card>
        <H2>Redes conectadas</H2>
        {overview.active.length === 0 ? <Muted>Nenhuma. Sua rede está isolada.</Muted> : null}
        {overview.active.map((l) => (
          <Row key={l.id} style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Body>{l.peerName}</Body>
              <Muted>{l.peerSlug}</Muted>
            </View>
            <Button title="Desconectar" small variant="secondary" onPress={() => confirmRevoke(l)} />
          </Row>
        ))}
      </Card>

      {overview.outgoing.length ? (
        <Card>
          <H2>Pedidos enviados</H2>
          {overview.outgoing.map((l) => (
            <Row key={l.id} style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Body>{l.peerName}</Body>
                <Muted>aguardando o administrador de {l.peerSlug}</Muted>
              </View>
              <Button title="Cancelar" small variant="secondary" onPress={() => void act(`c${l.id}`, () => session.api.cancelLink(l.id))} />
            </Row>
          ))}
        </Card>
      ) : null}

      <Card>
        <H2>Pedir conexão a outra rede</H2>
        <Field label="Código da outra rede" value={slug} onChangeText={setSlug} placeholder="ex.: faculdade-x" />
        <Button
          title="Enviar pedido"
          busy={busy === 'req'}
          disabled={!slug.trim()}
          onPress={() => void act('req', () => session.api.requestLink(slug.trim().toLowerCase()), () => {
            setSlug('');
            Alert.alert('Pedido enviado', 'O administrador da outra rede precisa aceitar.');
          })}
        />
      </Card>

      <Card>
        <H2>Convites</H2>
        <Muted>Gere um código e entregue ao administrador da outra rede. Ele só passa a valer quando ele aceitar.</Muted>
        <Button
          title="Gerar convite"
          variant="secondary"
          busy={busy === 'inv'}
          onPress={() =>
            void act('inv', async () => {
              const i: InviteDTO = await session.api.createInvite();
              setInvite({ code: i.code, expiresAt: i.expiresAt, note: 'Entregue este código ao administrador da rede que você quer conectar. Vale para um único uso.' });
            })
          }
        />
        <Field label="Recebeu um convite? Digite o código" value={inviteCode} onChangeText={setInviteCode} placeholder="XXXX-XXXX-XXXX-XXXX" autoCapitalize="characters" />
        <Button
          title="Aceitar convite"
          busy={busy === 'acc'}
          disabled={inviteCode.trim().length < 8}
          onPress={() => void act('acc', () => session.api.acceptInvite(inviteCode.trim()), () => {
            setInviteCode('');
            Alert.alert('Redes conectadas', 'O convite foi aceito.');
          })}
        />
      </Card>
      <CodeSheet result={invite} title="Convite gerado" onClose={() => setInvite(null)} />
    </ScrollView>
  );
}
