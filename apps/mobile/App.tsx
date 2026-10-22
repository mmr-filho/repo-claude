import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableAppSwitcherProtectionAsync } from 'expo-screen-capture';
import { ApiError, SigiloSession, type ServerEvent } from '@sigilo/core';
import { AppContext, type AppContextValue } from './src/app-context';
import { AuthScreen } from './src/screens/AuthScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { LockScreen } from './src/screens/LockScreen';
import {
  DEFAULT_SETTINGS,
  clearAuth,
  loadAuth,
  loadSettings,
  localVaultStoreFor,
  pinStoreFor,
  saveAuth,
  saveSettings,
  type Settings,
  type StoredAuth,
} from './src/storage';
import { Body, Button, Screen } from './src/ui';

type Phase = 'boot' | 'offline' | 'out' | 'locked' | 'in';
type Handler = (e: ServerEvent) => void;

const DEVICE = Platform.OS === 'ios' ? 'iPhone' : 'Android';

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [session, setSession] = useState<SigiloSession | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [pending, setPending] = useState<StoredAuth | null>(null);
  const [notice, setNotice] = useState<string>();
  const [online, setOnline] = useState(false);
  const [covered, setCovered] = useState(false);
  const listeners = useRef(new Set<Handler>());
  const phaseRef = useRef<Phase>('boot');
  const sessionRef = useRef<SigiloSession | null>(null);
  const settingsRef = useRef(settings);
  const lastTouch = useRef(Date.now());
  const backgroundedAt = useRef<number | null>(null);

  const goto = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const adopt = useCallback(
    (s: SigiloSession | null) => {
      sessionRef.current = s;
      setSession(s);
    },
    [],
  );

  const signedOut = useCallback(
    async (message?: string) => {
      await sessionRef.current?.forgetLocal();
      sessionRef.current?.lock();
      sessionRef.current?.stopRealtime();
      adopt(null);
      await clearAuth();
      setNotice(message);
      goto('out');
    },
    [adopt, goto],
  );

  const resume = useCallback(
    async (auth: StoredAuth) => {
      try {
        const s = await SigiloSession.resume({
          baseUrl: auth.baseUrl,
          token: auth.token,
          pinStore: pinStoreFor(auth.handle),
          localVault: localVaultStoreFor(auth.handle),
          deviceName: DEVICE,
          onUnauthorized: () => void signedOut('Sua sessão terminou. Entre novamente.'),
        });
        adopt(s);
        goto('locked'); // sempre trancado ao abrir o app: a senha é exigida para ler
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) await signedOut('Sua sessão expirou. Entre novamente.');
        else {
          setPending(auth);
          goto('offline');
        }
      }
    },
    [adopt, goto, signedOut],
  );

  // Inicialização
  useEffect(() => {
    void (async () => {
      const s = await loadSettings();
      setSettings(s);
      settingsRef.current = s;
      const auth = await loadAuth();
      if (auth) await resume(auth);
      else goto('out');
    })();
    enableAppSwitcherProtectionAsync().catch(() => {});
  }, [goto, resume]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(next);
  }, []);

  const touch = useCallback(() => {
    lastTouch.current = Date.now();
  }, []);

  const lockNow = useCallback(() => {
    if (phaseRef.current !== 'in') return;
    sessionRef.current?.lock();
    sessionRef.current?.stopRealtime();
    setOnline(false);
    goto('locked');
  }, [goto]);

  const logout = useCallback(async () => {
    const s = sessionRef.current;
    await s?.logout();
    await signedOut();
  }, [signedOut]);

  const onAuthenticated = useCallback(
    async (s: SigiloSession, auth: StoredAuth) => {
      await saveAuth(auth);
      updateSettings({ lastServer: auth.baseUrl, lastHandle: auth.handle });
      setNotice(undefined);
      adopt(s);
      goto('in');
    },
    [adopt, goto, updateSettings],
  );

  // Tempo real só com o cofre aberto.
  useEffect(() => {
    if (phase !== 'in' || !session) return;
    session.startRealtime(
      (e) => {
        if (e.type === 'session.revoked') void signedOut('Esta sessão foi encerrada pelo administrador ou por troca de senha.');
        listeners.current.forEach((l) => l(e));
      },
      (st) => setOnline(st === 'up'),
    );
    return () => session.stopRealtime();
  }, [phase, session, signedOut]);

  // Bloqueio automático ao ir para segundo plano e por inatividade.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      setCovered(next !== 'active');
      const grace = settingsRef.current.autoLockSeconds * 1000;
      if (next === 'background') {
        backgroundedAt.current = Date.now();
        if (grace === 0) lockNow();
      } else if (next === 'active') {
        const left = backgroundedAt.current;
        backgroundedAt.current = null;
        if (left && Date.now() - left >= grace) lockNow();
        lastTouch.current = Date.now();
      }
    });
    const timer = setInterval(() => {
      const minutes = settingsRef.current.idleLockMinutes;
      if (minutes > 0 && Date.now() - lastTouch.current > minutes * 60_000) lockNow();
    }, 10_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [lockNow]);

  const ctx = useMemo<AppContextValue | null>(
    () =>
      session
        ? {
            session,
            settings,
            updateSettings,
            lockNow,
            touch,
            logout,
            online,
            subscribe: (h) => {
              listeners.current.add(h);
              return () => void listeners.current.delete(h);
            },
          }
        : null,
    [session, settings, updateSettings, lockNow, touch, logout, online],
  );

  let body;
  if (phase === 'boot') {
    body = (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator size="large" />
        </View>
      </Screen>
    );
  } else if (phase === 'offline' && pending) {
    body = (
      <Screen>
        <View style={[styles.center, { gap: 16 }]}>
          <Body>Sem conexão com o servidor. Suas mensagens continuam protegidas.</Body>
          <Button title="Tentar de novo" onPress={() => void resume(pending)} />
          <Button title="Sair da conta" variant="ghost" onPress={() => void signedOut()} />
        </View>
      </Screen>
    );
  } else if (phase === 'out') {
    body = <AuthScreen settings={settings} notice={notice} onAuthenticated={onAuthenticated} />;
  } else if (phase === 'locked' && session) {
    body = <LockScreen session={session} onUnlocked={() => goto('in')} onLogout={() => void logout()} />;
  } else if (phase === 'in' && ctx) {
    body = (
      <AppContext.Provider value={ctx}>
        <HomeScreen />
      </AppContext.Provider>
    );
  }

  return (
    <View style={{ flex: 1 }} onTouchStart={() => (lastTouch.current = Date.now())}>
      <StatusBar style="auto" />
      {body}
      {covered ? (
        <View style={[StyleSheet.absoluteFill, styles.cover]}>
          <Text style={styles.coverText}>🔒 Sigilo</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cover: { backgroundColor: '#0B6E4F', alignItems: 'center', justifyContent: 'center' },
  coverText: { color: '#FFFFFF', fontSize: 28, fontWeight: '700' },
});
