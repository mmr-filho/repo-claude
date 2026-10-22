import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableAppSwitcherProtectionAsync } from 'expo-screen-capture';
import { LocalNode, LockedError, RelayClient, type NodeDeps, type PollResult } from '@sigilo/core/v2';
import { AppContext, type AppContextValue } from './src/app-context';
import { biometricAvailable, clearBiometricKey } from './src/biometric';
import { HomeScreen } from './src/screens/HomeScreen';
import { LockScreen } from './src/screens/LockScreen';
import { PendingScreen } from './src/screens/PendingScreen';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { CHAT_POLL_MS, DEFAULT_SETTINGS, POLL_OVERRIDE_MS, loadSettings, mobileStore, saveSettings, type Settings } from './src/storage';
import { Screen } from './src/ui';

type Phase = 'boot' | 'welcome' | 'locked' | 'pending' | 'in';
type Handler = (r: PollResult) => void;

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const deps = useMemo<NodeDeps>(() => ({ store: mobileStore, relay: new RelayClient() }), []);
  const [phase, setPhase] = useState<Phase>('boot');
  const [node, setNode] = useState<LocalNode | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [online, setOnline] = useState(true);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [version, setVersion] = useState(0);
  const [covered, setCovered] = useState(false);
  const [appActive, setAppActive] = useState(true);

  const phaseRef = useRef<Phase>('boot');
  const nodeRef = useRef<LocalNode | null>(null);
  const settingsRef = useRef(settings);
  const listeners = useRef(new Set<Handler>());
  const fast = useRef(0);
  const lastTouch = useRef(Date.now());
  const backgroundedAt = useRef<number | null>(null);

  const goto = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const adopt = useCallback((n: LocalNode | null) => {
    nodeRef.current = n;
    setNode(n);
  }, []);

  // Inicialização: há identidade neste aparelho? Então começa trancado.
  useEffect(() => {
    void (async () => {
      const s = await loadSettings();
      setSettings(s);
      settingsRef.current = s;
      const n = await LocalNode.load(deps);
      if (n) {
        adopt(n);
        goto('locked');
      } else goto('welcome');
    })();
    enableAppSwitcherProtectionAsync().catch(() => undefined);
  }, [deps, adopt, goto]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(next);
  }, []);

  const touch = useCallback(() => {
    lastTouch.current = Date.now();
  }, []);

  const enter = useCallback(
    (n: LocalNode) => {
      setUnread({});
      setVersion((v) => v + 1);
      goto(n.isEnrolled ? 'in' : 'pending');
    },
    [goto],
  );

  const lockNow = useCallback(() => {
    if (phaseRef.current !== 'in' && phaseRef.current !== 'pending') return;
    goto('locked'); // a tela de senha aparece já; o nó espera as operações em andamento terminarem de gravar
    setUnread({});
    void nodeRef.current?.lock();
  }, [goto]);

  const forgetDevice = useCallback(async () => {
    const n = nodeRef.current;
    goto('boot');
    await n?.lock();
    await LocalNode.forget(deps);
    await clearBiometricKey();
    updateSettings({ biometric: false });
    setUnread({});
    adopt(null);
    goto('welcome');
  }, [deps, adopt, goto, updateSettings]);

  // ───────── consulta ao relé ─────────
  const pollNow = useCallback(async () => {
    const n = nodeRef.current;
    if (!n || !n.isUnlocked) return;
    try {
      const r = await n.poll();
      setOnline(true);
      setUnread((prev) => (JSON.stringify(prev) === JSON.stringify(r.unread) ? prev : r.unread));
      if (r.events.length) setVersion((v) => v + 1);
      listeners.current.forEach((l) => l(r));
      if (phaseRef.current === 'pending' && n.isEnrolled) goto('in');
    } catch (err) {
      if (!(err instanceof LockedError)) setOnline(false);
    }
  }, [goto]);

  useEffect(() => {
    if ((phase !== 'in' && phase !== 'pending') || !appActive) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await pollNow();
      if (stop) return;
      const base = POLL_OVERRIDE_MS ?? settingsRef.current.pollSeconds * 1000;
      timer = setTimeout(() => void tick(), fast.current > 0 ? Math.min(CHAT_POLL_MS, base) : base);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [phase, appActive, pollNow, settings.pollSeconds]);

  // ───────── bloqueio automático ─────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      setCovered(next !== 'active');
      setAppActive(next === 'active');
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
      node
        ? {
            node,
            settings,
            updateSettings,
            lockNow,
            forgetDevice,
            online,
            unread,
            version,
            pollNow,
            touch,
            subscribe: (h) => {
              listeners.current.add(h);
              return () => void listeners.current.delete(h);
            },
            setFastPolling: (on) => {
              fast.current = Math.max(0, fast.current + (on ? 1 : -1));
            },
          }
        : null,
    [node, settings, updateSettings, lockNow, forgetDevice, online, unread, version, pollNow, touch],
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
  } else if (phase === 'welcome') {
    body = (
      <WelcomeScreen
        deps={deps}
        onNode={(n, opts) => {
          updateSettings({ biometric: opts.biometric });
          adopt(n);
          enter(n);
        }}
      />
    );
  } else if (phase === 'locked' && node) {
    body = (
      <LockScreen
        node={node}
        biometric={settings.biometric && biometricAvailable()}
        onBiometricInvalid={() => {
          void clearBiometricKey();
          updateSettings({ biometric: false });
        }}
        onUnlocked={() => enter(node)}
        onForget={forgetDevice}
      />
    );
  } else if (phase === 'pending' && ctx) {
    body = (
      <AppContext.Provider value={ctx}>
        <PendingScreen />
      </AppContext.Provider>
    );
  } else if (phase === 'in' && ctx) {
    body = (
      <AppContext.Provider value={ctx}>
        <HomeScreen />
      </AppContext.Provider>
    );
  }

  return (
    <View style={{ flex: 1 }} onTouchStart={touch}>
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
