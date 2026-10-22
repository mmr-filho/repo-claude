import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, SectionList, Text, TextInput, View } from 'react-native';
import type { Contact, ConversationSummary } from '@sigilo/core';
import { useApp, useServerEvents } from '../app-context';
import { space, useTheme } from '../theme';
import { Avatar, Badge, Empty, H1, Muted, Row, Screen, errorMessage, Banner } from '../ui';
import { AdminScreen } from './AdminScreen';
import { ChatScreen } from './ChatScreen';
import { SettingsScreen } from './SettingsScreen';

type Tab = 'chats' | 'contacts' | 'admin' | 'settings';

export function HomeScreen() {
  const { session, online } = useApp();
  const t = useTheme();
  const [tab, setTab] = useState<Tab>('chats');
  const [chatWith, setChatWith] = useState<Contact | null>(null);

  if (chatWith) return <ChatScreen peer={chatWith} onBack={() => setChatWith(null)} />;

  const tabs: Array<{ id: Tab; label: string; icon: string }> = [
    { id: 'chats', label: 'Conversas', icon: '💬' },
    { id: 'contacts', label: 'Contatos', icon: '👥' },
    ...(session.isAdmin ? [{ id: 'admin' as const, label: 'Rede', icon: '🛠️' }] : []),
    { id: 'settings', label: 'Ajustes', icon: '⚙️' },
  ];

  return (
    <Screen padded={false}>
      <View style={{ flex: 1 }}>
        {tab === 'chats' ? <ChatsTab onOpen={setChatWith} /> : null}
        {tab === 'contacts' ? <ContactsTab onOpen={setChatWith} /> : null}
        {tab === 'admin' ? <AdminScreen /> : null}
        {tab === 'settings' ? <SettingsScreen /> : null}
      </View>
      {!online ? (
        <View style={{ backgroundColor: t.warn, paddingVertical: 2 }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontSize: 12 }}>Reconectando… novas mensagens podem demorar</Text>
        </View>
      ) : null}
      <Row style={{ borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface, gap: 0 }}>
        {tabs.map((item) => (
          <Pressable key={item.id} onPress={() => setTab(item.id)} style={{ flex: 1, alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ fontSize: 20 }}>{item.icon}</Text>
            <Text style={{ fontSize: 11, color: tab === item.id ? t.primary : t.muted, fontWeight: tab === item.id ? '700' : '500' }}>{item.label}</Text>
          </Pressable>
        ))}
      </Row>
    </Screen>
  );
}

function useDirectory() {
  const { session } = useApp();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [summary, setSummary] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([session.loadContacts(), session.summary()]);
      setContacts(c);
      setSummary(s);
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useServerEvents((e) => {
    if (e.type === 'message.new' || e.type === 'message.read' || e.type === 'message.recalled' || e.type === 'contacts.changed') void refresh();
  });
  return { contacts, summary, loading, error, refresh };
}

function ChatsTab({ onOpen }: { onOpen: (c: Contact) => void }) {
  const t = useTheme();
  const { contacts, summary, loading, error, refresh } = useDirectory();
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const rows = summary.filter((s) => byId.has(s.peerId));

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: space.lg, gap: 4 }}>
        <H1>Conversas</H1>
        <Muted>Mensagens lidas são apagadas. Aqui aparecem só as que ainda aguardam leitura.</Muted>
      </View>
      {error ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.peerId}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
        ListEmptyComponent={loading ? undefined : <Empty title="Nada aguardando" hint="Abra a aba Contatos para começar uma conversa." />}
        renderItem={({ item }) => {
          const c = byId.get(item.peerId)!;
          return (
            <Pressable onPress={() => onOpen(c)} style={{ paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: t.border }}>
              <Row>
                <Avatar name={c.displayName} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Row style={{ gap: 8 }}>
                    <Text style={{ color: t.text, fontWeight: '600', fontSize: 16 }}>{c.displayName}</Text>
                    {!c.sameNetwork ? <Badge text={c.networkName} /> : null}
                  </Row>
                  {item.incoming > 0 ? (
                    <Text style={{ color: t.primary, fontWeight: '600' }}>
                      🔒 {item.incoming} {item.incoming === 1 ? 'mensagem nova' : 'mensagens novas'}
                    </Text>
                  ) : (
                    <Muted>Enviada · aguardando leitura ({item.outgoing})</Muted>
                  )}
                </View>
              </Row>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

function ContactsTab({ onOpen }: { onOpen: (c: Contact) => void }) {
  const t = useTheme();
  const { contacts, loading, error, refresh } = useDirectory();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = contacts.filter((c) => !q || c.displayName.toLowerCase().includes(q) || c.handle.includes(q));
  const sections = [...new Set(filtered.map((c) => c.networkName))].map((name) => ({
    title: name,
    own: filtered.find((c) => c.networkName === name)!.sameNetwork,
    data: filtered.filter((c) => c.networkName === name),
  }));

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: space.lg, gap: space.sm }}>
        <H1>Contatos</H1>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar por nome ou usuário"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          style={{ backgroundColor: t.surface, color: t.text, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: t.border }}
        />
        {error ? <Banner kind="error">{error}</Banner> : null}
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
        ListEmptyComponent={loading ? undefined : <Empty title="Nenhum contato" hint="Peça ao administrador para cadastrar pessoas ou conectar outra rede." />}
        renderSectionHeader={({ section }) => (
          <View style={{ backgroundColor: t.bg, paddingHorizontal: space.lg, paddingVertical: 6 }}>
            <Muted>
              {section.title.toUpperCase()}
              {section.own ? ' · SUA REDE' : ' · REDE CONECTADA'}
            </Muted>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable onPress={() => onOpen(item)} style={{ paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: t.border }}>
            <Row>
              <Avatar name={item.displayName} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '600', fontSize: 16 }}>{item.displayName}</Text>
                <Muted>{item.handle}</Muted>
              </View>
              {item.role === 'admin' ? <Badge text="admin" /> : null}
            </Row>
          </Pressable>
        )}
      />
    </View>
  );
}
