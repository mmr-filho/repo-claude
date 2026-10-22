import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { LocalStore, Slot } from '@sigilo/core/v2';

/*
 * Onde cada coisa fica no aparelho:
 *   vault, queue, meta  → Keychain (iOS) / Keystore (Android): chaves cifradas pela senha, chave da caixa postal e o perfil
 *   state               → armazenamento comum, mas JÁ CIFRADO pelo cofre (contatos e certificados): só legível com a senha
 * Nunca texto de mensagem, nem a senha.
 */

const SECURE: Slot[] = ['vault', 'queue', 'meta'];
const key = (slot: Slot) => `sigilo2.${slot}`;

export const mobileStore: LocalStore = {
  async get(slot) {
    try {
      return SECURE.includes(slot) ? await SecureStore.getItemAsync(key(slot)) : await AsyncStorage.getItem(key(slot));
    } catch {
      return null;
    }
  },
  async set(slot, value) {
    if (SECURE.includes(slot)) await SecureStore.setItemAsync(key(slot), value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    else await AsyncStorage.setItem(key(slot), value);
  },
  async remove(slot) {
    if (SECURE.includes(slot)) await SecureStore.deleteItemAsync(key(slot)).catch(() => undefined);
    else await AsyncStorage.removeItem(key(slot));
  },
};

export interface Settings {
  /** 0 = tranca assim que o app vai para segundo plano. */
  autoLockSeconds: number;
  /** 0 = desligado. */
  idleLockMinutes: number;
  /** De quanto em quanto tempo consulta o relé com o app aberto. Mais espaçado = menos pedidos (e menos custo no relé). */
  pollSeconds: number;
  /** Destravar com a digital está ativado (a chave fica no armazenamento protegido pelo hardware). */
  biometric: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoLockSeconds: 0,
  idleLockMinutes: 5,
  pollSeconds: 10,
  biometric: false,
};

/** Só para os testes de interface: acelera a consulta. Em produção fica indefinido. */
export const POLL_OVERRIDE_MS = process.env.EXPO_PUBLIC_POLL_MS ? Number(process.env.EXPO_PUBLIC_POLL_MS) : undefined;
/** Consulta mais rápida enquanto uma conversa está aberta. */
export const CHAT_POLL_MS = POLL_OVERRIDE_MS ?? 3000;

const SETTINGS_KEY = 'sigilo2.settings';

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await SecureStore.getItemAsync(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const saveSettings = (s: Settings) => SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(s));
