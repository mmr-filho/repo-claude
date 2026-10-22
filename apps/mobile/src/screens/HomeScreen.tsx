import { useEffect, useMemo, useState } from 'react';
import { BackHandler, FlatList, Platform, Pressable, RefreshControl, SectionList, Text, TextInput, View } from 'react-native';
import type { ContactView } from '@sigilo/core/v2';
import { useApp } from '../app-context';
import { space, useTheme } from '../theme';
import { Avatar, Badge, Banner, Empty, H1, Muted, Row, Screen } from '../ui';
import { AdminScreen } from './AdminScreen';
import { ChatScreen } from './ChatScreen';
import { SettingsScreen } from './SettingsScreen';

type Tab = 'chats' | 'contacts' | 'admin' | 'settings';

export function HomeScreen() {
  const { node, online } = useApp();
  const t = useTheme();
  const [tab, setTab] = useState<Tab>('chats');
  const [chatWith, setChatWith] = useState<ContactView | null>(null);

  // Botão "voltar" do Android fecha a conversa em vez de sair do app.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!chatWith) return false;
      setChatWith(null);
      return true;
    });
    return () => sub.remove();
  }, [chatWith]);

  if (chatWith) return <ChatScreen peer={chatWith} onBack={() => setChatWith(null)} />;

  const tabs: Array<{ id: Tab; label: string; icon: string }> = [
    { id: 'chats', label: 'Conversas', icon: '💬' },
    { id: 'contacts', label: 'Contatos', icon: '👥' },
    ...(node.isAdmin ? [{ id: 'admin' as const, label: 'Rede', icon: '🛠️' }] : []),
    { id: 'settings', label: 'Ajustes', icon: '⚙️' },
  ];

  return (
    <Screen padded={false}>
      {node.isRevoked ? (
        <View style={{ padding: space.md }}>
          <Banner kind="error">O administrador retirou o seu acesso a esta rede. Você não consegue mais enviar nem receber mensagens.</Banner>
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        {tab === 'chats' ? <ChatsTab onOpen={setChatWith} /> : null}
        {tab === 'contacts' ? <ContactsTab onOpen={setChatWith} /> : null}
        {tab === 'admin' ? <AdminScreen /> : null}
        {tab === 'settings' ? <SettingsScreen /> : null}
      </View>
      {!online ? (
        <View style={{ backgroundColor: t.warn, paddingVertical: 2 }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontSize: 12 }}>Sem conexão com o relé… novas mensagens podem demorar</Text>
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

function useContacts(): ContactView[] {
  const { node, version } = useApp();
  return useMemo(() => node.contacts(), [node, version]);
}

function ChatsTab({ onOpen }: { onOpen: (c: ContactView) => void }) {
  const t = useTheme();
  const { node, unread, version, pollNow } = useApp();
  const contacts = useContacts();
  const [refreshing, setRefreshing] = useState(false);
  const waiting = useMemo(() => node.awaitingRead(), [node, version, unread]);
  const rows = contacts.filter((c) => (unread[c.box] ?? 0) > 0 || (waiting[c.box] ?? 0) > 0);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: space.lg, gap: 4 }}>
        <H1>Conversas</H1>
        <Muted>Mensagens lidas são apagadas. Aqui aparecem só as que ainda aguardam leitura.</Muted>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(c) => c.box}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void pollNow().finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={<Empty title="Nada aguardando" hint="Abra a aba Contatos para começar uma conversa." />}
        renderItem={({ item }) => (
          <Pressable onPress={() => onOpen(item)} style={{ paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: t.border }}>
            <Row>
              <Avatar name={item.name} />
              <View style={{ flex: 1, gap: 2 }}>
                <Row style={{ gap: 8 }}>
                  <Text style={{ color: t.text, fontWeight: '600', fontSize: 16 }}>{item.name}</Text>
                  {!item.sameNetwork ? <Badge text={item.networkName} /> : null}
                </Row>
                {(unread[item.box] ?? 0) > 0 ? (
                  <Text style={{ color: t.primary, fontWeight: '600' }}>
                    🔒 {unread[item.box]} {unread[item.box] === 1 ? 'mensagem nova' : 'mensagens novas'}
                  </Text>
                ) : (
                  <Muted>Enviada · aguardando leitura ({waiting[item.box]})</Muted>
                )}
              </View>
            </Row>
          </Pressable>
        )}
      />
    </View>
  );
}

function ContactsTab({ onOpen }: { onOpen: (c: ContactView) => void }) {
  const t = useTheme();
  const contacts = useContacts();
  const { node } = useApp();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = contacts.filter((c) => !q || c.name.toLowerCase().includes(q));
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
          placeholder="Buscar por nome"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          style={{ backgroundColor: t.surface, color: t.text, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: t.border }}
        />
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(c) => c.box}
        ListEmptyComponent={<Empty title="Nenhum contato ainda" hint={node.isAdmin ? 'Gere um convite na aba Rede.' : 'Peça ao administrador para convidar pessoas ou conectar outra rede.'} />}
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
              <Avatar name={item.name} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '600', fontSize: 16 }}>{item.name}</Text>
              </View>
              {item.role === 'admin' ? <Badge text="admin" /> : null}
            </Row>
          </Pressable>
        )}
      />
    </View>
  );
}
