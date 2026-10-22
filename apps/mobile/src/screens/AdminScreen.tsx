import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useApp } from '../app-context';
import { CodeSheet, type CodeInfo } from '../components/CodeSheet';
import { ScanSheet } from '../components/ScanSheet';
import { errorText } from '../errors';
import { space, useTheme } from '../theme';
import { Avatar, Badge, Banner, Body, Button, Card, Field, H1, H2, Muted, Row, Strong, confirmAction } from '../ui';

const date = (ms: number) => new Date(ms).toLocaleDateString('pt-BR');
const dateTime = (ms: number) => new Date(ms).toLocaleString('pt-BR');

export function AdminScreen() {
  const [section, setSection] = useState<'invites' | 'members' | 'links'>('invites');
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: space.lg, gap: space.sm }}>
        <H1>Administração</H1>
        <Row>
          {(
            [
              ['invites', 'Convites'],
              ['members', 'Membros'],
              ['links', 'Conexões'],
            ] as const
          ).map(([id, label]) => (
            <View key={id} style={{ flex: 1 }}>
              <Button title={label} small variant={section === id ? 'primary' : 'secondary'} onPress={() => setSection(id)} />
            </View>
          ))}
        </Row>
      </View>
      {section === 'invites' ? <Invites /> : section === 'members' ? <Members /> : <Links />}
    </View>
  );
}

function useAction() {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  async function run(key: string, fn: () => Promise<unknown>, done?: () => void) {
    setBusy(key);
    setError(undefined);
    try {
      await fn();
      done?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
    }
  }
  return { busy, error, run, setError };
}

function Invites() {
  const { node, version, pollNow } = useApp();
  const [name, setName] = useState('');
  const [tick, setTick] = useState(0);
  const [code, setCode] = useState<CodeInfo | null>(null);
  const { busy, error, run } = useAction();
  const pending = useMemo(() => node.pendingInvites(), [node, version, tick]);

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
      <Banner>
        Você aprova entradas só emitindo convites: quem entra com o convite recebe o certificado da rede <Strong>assim que você abrir o app</Strong>. O nome da pessoa é o que você digitar aqui.
      </Banner>
      <Card>
        <H2>Novo convite</H2>
        <Field label="Nome da pessoa" value={name} onChangeText={setName} autoCapitalize="words" placeholder="Ana Souza" />
        <Button
          title="Gerar convite"
          busy={busy === 'invite'}
          disabled={name.trim().length < 2}
          onPress={() =>
            void run(
              'invite',
              async () => {
                const inv = await node.createInvite(name.trim());
                setCode({
                  title: `Convite para ${name.trim()}`,
                  code: inv.code,
                  note: 'Entregue este código (ou mostre o QR code) à pessoa. Vale para um único uso.',
                  expires: dateTime(inv.expiresAt),
                });
              },
              () => {
                setName('');
                setTick((n) => n + 1);
              },
            )
          }
        />
        {error ? <Banner kind="error">{error}</Banner> : null}
      </Card>
      <Card>
        <H2>Convites aguardando uso</H2>
        {pending.length === 0 ? <Muted>Nenhum.</Muted> : null}
        {pending.map((p, i) => (
          <Row key={i} style={{ justifyContent: 'space-between' }}>
            <Body>{p.name}</Body>
            <Muted>vale até {date(p.exp)}</Muted>
          </Row>
        ))}
        <Button title="Atualizar" variant="ghost" small onPress={() => void pollNow().then(() => setTick((n) => n + 1))} />
      </Card>
      <CodeSheet info={code} onClose={() => setCode(null)} />
    </ScrollView>
  );
}

function Members() {
  const t = useTheme();
  const { node, version } = useApp();
  const [tick, setTick] = useState(0);
  const { busy, error, run } = useAction();
  const members = useMemo(() => node.members(), [node, version, tick]);

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.sm }}>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Muted>
        Os certificados valem 30 dias e se renovam sozinhos. Quem fica mais de 30 dias sem abrir o app perde a confiança dos outros e precisa de um convite novo.
      </Muted>
      {members.map((m) => (
        <Card key={m.box}>
          <Row>
            <Avatar name={m.name} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '600', fontSize: 16 }}>{m.name}</Text>
              <Muted>certificado até {date(m.exp)}</Muted>
            </View>
            {m.role === 'admin' ? <Badge text="admin" /> : null}
          </Row>
          {m.box !== node.myBox ? (
            <Button
              title="Retirar acesso"
              variant="ghost"
              small
              busy={busy === m.box}
              onPress={() =>
                confirmAction(`Retirar o acesso de ${m.name}?`, 'Ela deixa de receber mensagens da rede e os outros membros deixam de confiar nela. Para voltar, precisará de um convite novo.', 'Retirar', () =>
                  void run(m.box, () => node.revokeMember(m.box), () => setTick((n) => n + 1)),
                )
              }
            />
          ) : (
            <Muted>Esta é a sua conta.</Muted>
          )}
        </Card>
      ))}
    </ScrollView>
  );
}

function Links() {
  const { node, version, pollNow } = useApp();
  const [tick, setTick] = useState(0);
  const [peerCode, setPeerCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState<CodeInfo | null>(null);
  const { busy, error, run } = useAction();
  const proposals = useMemo(() => node.proposals(), [node, version, tick]);
  const linked = useMemo(() => node.linkedNetworks(), [node, version, tick]);
  const refresh = () => setTick((n) => n + 1);

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Banner>
        Duas redes só conversam se os <Strong>dois administradores</Strong> concordarem. A conexão vale só entre elas (não passa para as redes de terceiros) e se renova sozinha enquanto os dois mantêm o app aberto de vez em quando.
      </Banner>

      {proposals.length ? (
        <Card>
          <H2>Pedidos recebidos</H2>
          {proposals.map((p) => (
            <Row key={p.id} style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Body>{p.networkName}</Body>
                <Muted>pediu para conectar às {dateTime(p.at)}</Muted>
              </View>
              <Button title="Aceitar" small busy={busy === `a${p.id}`} onPress={() => void run(`a${p.id}`, () => node.acceptLink(p.id), refresh)} />
              <Button title="Recusar" small variant="secondary" onPress={() => void run(`r${p.id}`, () => node.rejectLink(p.id), refresh)} />
            </Row>
          ))}
        </Card>
      ) : null}

      <Card>
        <H2>Redes conectadas</H2>
        {linked.length === 0 ? <Muted>Nenhuma. Sua rede está isolada.</Muted> : null}
        {linked.map((l) => (
          <Row key={l.net} style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Body>{l.name}</Body>
              <Muted>conexão válida até {date(l.expiresAt)}</Muted>
            </View>
            <Button
              title="Desconectar"
              small
              variant="secondary"
              onPress={() =>
                confirmAction(`Desconectar ${l.name}?`, 'As duas redes deixam de se ver. Para reconectar, um novo pedido precisa ser aceito.', 'Desconectar', () =>
                  void run(`u${l.net}`, () => node.unlink(l.net), refresh),
                )
              }
            />
          </Row>
        ))}
      </Card>

      <Card>
        <H2>O código da sua rede</H2>
        <Muted>Entregue ao administrador da outra rede para ele pedir a conexão. É público: não dá acesso a nada sozinho.</Muted>
        <Button
          title="Mostrar código da rede"
          variant="secondary"
          onPress={() =>
            setCode({
              title: `Código da rede ${node.network?.name ?? ''}`,
              code: node.networkCode(),
              note: 'O outro administrador cola este código (ou lê o QR code) em "Pedir conexão".',
            })
          }
        />
      </Card>

      <Card>
        <H2>Pedir conexão a outra rede</H2>
        <Field label="Código da outra rede" value={peerCode} onChangeText={setPeerCode} multiline numberOfLines={3} placeholder="sigilo2-rede:…" style={{ minHeight: 80, textAlignVertical: 'top' }} />
        <Row>
          <View style={{ flex: 1 }}>
            <Button title="Ler QR code" variant="secondary" onPress={() => setScanning(true)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Enviar pedido"
              busy={busy === 'req'}
              disabled={peerCode.trim().length < 20}
              onPress={() =>
                void run('req', () => node.requestLink(peerCode.trim()), () => {
                  setPeerCode('');
                  refresh();
                })
              }
            />
          </View>
        </Row>
      </Card>

      <Button title="Reenviar a lista de contatos aos membros" variant="ghost" busy={busy === 'resync'} onPress={() => void run('resync', async () => { await node.resyncRoster(); await pollNow(); })} />
      <CodeSheet info={code} onClose={() => setCode(null)} />
      <ScanSheet visible={scanning} onClose={() => setScanning(false)} onCode={(c) => { setPeerCode(c); setScanning(false); }} />
    </ScrollView>
  );
}
