import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { KeyChangedError, LockedError, type ChatMessage, type Contact } from '@sigilo/core';
import { useApp, useServerEvents } from '../app-context';
import { space, useTheme } from '../theme';
import { Avatar, Banner, Body, Button, H2, Muted, Row, Screen, Sheet, errorMessage } from '../ui';

/** Linha na tela. Existe só na memória deste componente: sair da conversa a destrói. */
interface Line extends ChatMessage {
  localAt: number;
  /** Mensagem minha que o destinatário já leu: o texto é apagado da tela. */
  burned?: boolean;
}

export function ChatScreen({ peer, onBack }: { peer: Contact; onBack: () => void }) {
  const { session, touch } = useApp();
  const t = useTheme();
  usePreventScreenCapture(); // bloqueia captura de tela (Android) enquanto o texto está visível

  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [keyChanged, setKeyChanged] = useState<KeyChangedError | null>(null);
  const [showVerify, setShowVerify] = useState(false);
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);
  const list = useRef<FlatList<Line>>(null);

  const load = useCallback(async () => {
    const startedAt = Date.now();
    try {
      const convo = await session.openConversation(peer.id);
      if (!mounted.current) return;
      setUnreadable(convo.unreadable);
      setError(undefined);
      setLines((prev) => {
        const known = new Set(prev.map((l) => l.id));
        const stillPending = new Set(convo.messages.filter((m) => m.direction === 'out').map((m) => m.id));
        const added = convo.messages.filter((m) => !known.has(m.id)).map((m) => ({ ...m, localAt: Date.now() }));
        // Mensagem minha que já estava na tela e sumiu do servidor foi lida (ou recolhida) enquanto eu estava offline.
        const aged = prev.map((l) =>
          l.direction === 'out' && !l.burned && l.localAt < startedAt && !stillPending.has(l.id) ? { ...l, text: '', burned: true } : l,
        );
        return [...aged, ...added].sort((a, b) => a.createdAt - b.createdAt);
      });
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof KeyChangedError) setKeyChanged(err);
      else if (!(err instanceof LockedError)) setError(errorMessage(err));
    }
  }, [session, peer.id]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false; // ao sair, o estado (e o texto) é descartado
    };
  }, [load]);

  useServerEvents((e) => {
    if (e.type === 'message.new' && e.senderId === peer.id) void load();
    else if (e.type === 'message.read') setLines((p) => p.map((l) => (e.ids.includes(l.id) ? { ...l, text: '', burned: true } : l)));
    else if (e.type === 'message.recalled') setLines((p) => p.filter((l) => l.id !== e.id));
    else if (e.type === 'contacts.changed') void load();
  });

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const msg = await session.send(peer.id, text);
      setLines((p) => [...p, { ...msg, localAt: Date.now() }]);
      setDraft('');
      setError(undefined);
    } catch (err) {
      if (err instanceof KeyChangedError) setKeyChanged(err);
      else setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  function recall(line: Line) {
    if (line.direction !== 'out' || line.burned) return;
    Alert.alert('Apagar para todos?', 'Só funciona enquanto o destinatário ainda não leu.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Apagar',
        style: 'destructive',
        onPress: () =>
          session
            .recall(line.id)
            .then(() => setLines((p) => p.filter((l) => l.id !== line.id)))
            .catch(() => Alert.alert('Não foi possível apagar', 'A mensagem já foi lida ou não existe mais.')),
      },
    ]);
  }

  async function trustNewKey() {
    await session.trustKey(peer.id);
    setKeyChanged(null);
    void load();
  }

  const safety = session.safetyNumberWith(keyChanged?.contact ?? peer);

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Row style={{ padding: space.md, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface }}>
          <Pressable onPress={onBack} hitSlop={12}>
            <Text style={{ color: t.primary, fontSize: 28 }}>‹</Text>
          </Pressable>
          <Avatar name={peer.displayName} size={38} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{peer.displayName}</Text>
            <Muted>
              {peer.handle}
              {peer.sameNetwork ? '' : ` · ${peer.networkName}`}
            </Muted>
          </View>
          <Button title="🔑 Verificar" variant="secondary" small onPress={() => setShowVerify(true)} />
        </Row>

        <View style={{ padding: space.md, gap: space.sm }}>
          <Muted style={{ textAlign: 'center' }}>
            🔒 Ponta a ponta. Mensagens recebidas já foram apagadas do servidor e somem desta tela quando você sai da conversa.
          </Muted>
          {error ? <Banner kind="error">{error}</Banner> : null}
          {unreadable.length ? (
            <Banner kind="warn">
              {unreadable.length} mensagem(ns) não puderam ser abertas (adulteradas ou de origem não confiável).{' '}
              <Text style={{ fontWeight: '700' }} onPress={() => session.discard(unreadable).then(() => setUnreadable([]))}>
                Descartar
              </Text>
            </Banner>
          ) : null}
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
            style={{ flex: 1, maxHeight: 120, color: t.text, backgroundColor: t.bg, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 }}
          />
          <Button title="Enviar" onPress={send} busy={sending} disabled={!draft.trim()} small />
        </Row>
      </KeyboardAvoidingView>

      <Sheet visible={showVerify} onClose={() => setShowVerify(false)} title="Verificar segurança">
        <Body>Compare estes números com os que aparecem no aparelho de {peer.displayName}, pessoalmente ou por telefone. Se forem iguais, ninguém (nem o servidor) está interceptando a conversa.</Body>
        <NumberBox value={safety} />
        <Button title="Fechar" variant="secondary" onPress={() => setShowVerify(false)} />
      </Sheet>

      <Sheet visible={!!keyChanged} onClose={onBack} title="⚠️ A chave de segurança mudou">
        <Body>
          A chave de {peer.displayName} é diferente da que este aparelho conhecia. Isso acontece quando a pessoa refaz a conta — ou quando alguém tenta se passar por ela.
          Confirme o novo número de segurança com ela antes de continuar.
        </Body>
        <NumberBox value={safety} />
        <Button title="Confirmei, confiar na nova chave" onPress={trustNewKey} />
        <Button title="Voltar" variant="secondary" onPress={onBack} />
      </Sheet>
    </Screen>
  );
}

function NumberBox({ value }: { value: string }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.surfaceAlt, borderRadius: 12, padding: space.md }}>
      <Text selectable style={{ color: t.text, fontSize: 18, letterSpacing: 1, lineHeight: 30, textAlign: 'center', fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
    </View>
  );
}

function Bubble({ line, onLongPress }: { line: Line; onLongPress: () => void }) {
  const t = useTheme();
  const mine = line.direction === 'out';
  const time = new Date(line.sentAt || line.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return (
    <Pressable
      onLongPress={onLongPress}
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '82%',
        backgroundColor: mine ? t.bubbleOut : t.bubbleIn,
        borderRadius: 16,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 2,
      }}
    >
      {line.burned ? (
        <Text style={{ color: t.muted, fontStyle: 'italic' }}>🔥 Lida e apagada</Text>
      ) : (
        <Text style={{ color: t.text, fontSize: 16 }}>{line.text}</Text>
      )}
      <Text style={{ color: t.muted, fontSize: 11, alignSelf: 'flex-end' }}>
        {time}
        {mine && !line.burned ? ' · enviada, aguardando leitura' : ''}
      </Text>
    </Pressable>
  );
}
