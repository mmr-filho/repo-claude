import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, Text, TextInput, View } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { b64, safetyNumber } from '@sigilo/core';
import { LockedError, type ContactView } from '@sigilo/core/v2';
import { useApp, useFastPolling, usePollEvents } from '../app-context';
import { errorText } from '../errors';
import { space, useTheme } from '../theme';
import { Avatar, Banner, Body, Button, Muted, Row, Screen, Sheet, confirmAction } from '../ui';

/** Linha na tela. Existe só na memória deste componente: sair da conversa a destrói. */
interface Line {
  id: string;
  direction: 'in' | 'out';
  text: string;
  sentAt: number;
  status?: 'sent' | 'queued' | 'read';
}

export function ChatScreen({ peer, onBack }: { peer: ContactView; onBack: () => void }) {
  const { node, touch, pollNow } = useApp();
  const t = useTheme();
  usePreventScreenCapture(); // bloqueia captura de tela (Android) enquanto o texto está visível
  useFastPolling();

  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [showVerify, setShowVerify] = useState(false);
  const mounted = useRef(true);
  const list = useRef<FlatList<Line>>(null);
  const available = node.contacts().some((c) => c.box === peer.box);

  /** Traz as mensagens recebidas (apagando-as do relé) e o estado das enviadas. */
  const load = useCallback(async () => {
    try {
      const c = await node.openConversation(peer.box);
      if (!mounted.current) return;
      setError(undefined);
      setLines((prev) => {
        const incoming = new Map(prev.filter((l) => l.direction === 'in').map((l) => [l.id, l]));
        for (const m of c.messages) incoming.set(m.id, { id: m.id, direction: 'in', text: m.text, sentAt: m.sentAt });
        const outgoing = c.sent.map((s): Line => ({ id: s.id, direction: 'out', text: s.status === 'read' ? '' : s.text, sentAt: s.sentAt, status: s.status }));
        return [...incoming.values(), ...outgoing].sort((a, b) => a.sentAt - b.sentAt);
      });
    } catch (err) {
      if (mounted.current && !(err instanceof LockedError)) setError(errorText(err));
    }
  }, [node, peer.box]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false; // ao sair, o estado (e o texto) é descartado
    };
  }, [load]);

  usePollEvents((r) => {
    if ((r.unread[peer.box] ?? 0) > 0 || r.receipts.length > 0) void load();
  });

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await node.send(peer.box, text);
      setDraft('');
      setError(r.status === 'queued' ? 'Sem conexão: a mensagem está na fila e sai quando houver internet.' : undefined);
      await load();
      void pollNow();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  }

  function recall(line: Line) {
    if (line.direction !== 'out' || line.status === 'read') return;
    confirmAction('Apagar para todos?', 'Só funciona enquanto o destinatário ainda não leu.', 'Apagar', () => {
      node
        .recall(line.id)
        .then(load)
        .catch(() => setError('A mensagem já foi lida ou não existe mais.'));
    });
  }

  const safety = safetyNumber(b64.decode(node.myBox), b64.decode(peer.box));

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Row style={{ padding: space.md, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface }}>
          <Pressable onPress={onBack} hitSlop={12} accessibilityLabel="Voltar">
            <Text style={{ color: t.primary, fontSize: 28 }}>‹</Text>
          </Pressable>
          <Avatar name={peer.name} size={38} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{peer.name}</Text>
            <Muted>{peer.sameNetwork ? 'Mesma rede' : peer.networkName}</Muted>
          </View>
          <Button title="🔑 Verificar" variant="secondary" small onPress={() => setShowVerify(true)} />
        </Row>

        <View style={{ padding: space.md, gap: space.sm }}>
          <Muted style={{ textAlign: 'center' }}>
            🔒 Ponta a ponta. Mensagens recebidas já foram apagadas do relé e somem desta tela quando você sai da conversa.
          </Muted>
          {!available ? <Banner kind="warn">Este contato não está mais disponível (acesso retirado, certificado vencido ou rede desconectada).</Banner> : null}
          {error ? <Banner kind={error.startsWith('Sem conexão: a mensagem') ? 'warn' : 'error'}>{error}</Banner> : null}
        </View>

        <FlatList
          ref={list}
          data={lines}
          keyExtractor={(l) => l.id}
          contentContainerStyle={{ padding: space.md, gap: 6, flexGrow: 1, justifyContent: 'flex-end' }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => <Bubble line={item} onLongPress={() => recall(item)} />}
        />

        <Row style={{ padding: space.sm, borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface, alignItems: 'flex-end' }}>
          <TextInput
            value={draft}
            onChangeText={(v) => {
              touch();
              setDraft(v);
            }}
            placeholder="Mensagem"
            placeholderTextColor={t.muted}
            multiline
            maxLength={4000}
            editable={available}
            style={{ flex: 1, maxHeight: 120, color: t.text, backgroundColor: t.bg, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 }}
          />
          <Button title="Enviar" onPress={send} busy={sending} disabled={!draft.trim() || !available} small />
        </Row>
      </KeyboardAvoidingView>

      <Sheet visible={showVerify} onClose={() => setShowVerify(false)} title="Verificar segurança">
        <Body>
          Compare estes números com os que aparecem no aparelho de {peer.name}, pessoalmente ou por telefone. Se forem iguais, ninguém (nem o administrador da rede) está se passando por ela.
        </Body>
        <View style={{ backgroundColor: t.surfaceAlt, borderRadius: 12, padding: space.md }}>
          <Text selectable style={{ color: t.text, fontSize: 18, letterSpacing: 1, lineHeight: 30, textAlign: 'center' }}>
            {safety}
          </Text>
        </View>
        <Button title="Fechar" variant="secondary" onPress={() => setShowVerify(false)} />
      </Sheet>
    </Screen>
  );
}

function Bubble({ line, onLongPress }: { line: Line; onLongPress: () => void }) {
  const t = useTheme();
  const mine = line.direction === 'out';
  const burned = mine && line.status === 'read';
  const time = new Date(line.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return (
    <Pressable
      onLongPress={onLongPress}
      style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', backgroundColor: mine ? t.bubbleOut : t.bubbleIn, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, gap: 2 }}
    >
      {burned ? <Text style={{ color: t.muted, fontStyle: 'italic' }}>🔥 Lida e apagada</Text> : <Text style={{ color: t.text, fontSize: 16 }}>{line.text}</Text>}
      <Text style={{ color: t.muted, fontSize: 11, alignSelf: 'flex-end' }}>
        {time}
        {mine && line.status === 'sent' ? ' · enviada, aguardando leitura' : ''}
        {mine && line.status === 'queued' ? ' · na fila (sem conexão)' : ''}
      </Text>
    </Pressable>
  );
}
