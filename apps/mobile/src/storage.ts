import * as SecureStore from 'expo-secure-store';
import type { KeyPinStore } from '@sigilo/core';

// Só vai para o armazenamento seguro do sistema (Keychain/Keystore): token de sessão e configurações.
// NUNCA texto de mensagem, senha ou chave privada em claro.

export interface StoredAuth {
  baseUrl: string;
  handle: string;
  token: string;
}

export interface Settings {
  /** 0 = bloqueia assim que o app vai para segundo plano. */
  autoLockSeconds: number;
  /** 0 = desligado. */
  idleLockMinutes: number;
  lastServer: string;
  lastHandle: string;
}

export const DEFAULT_SETTINGS: Settings = {
  autoLockSeconds: 0,
  idleLockMinutes: 5,
  lastServer: process.env.EXPO_PUBLIC_SERVER_URL ?? '',
  lastHandle: '',
};

const AUTH_KEY = 'sigilo.auth';
const SETTINGS_KEY = 'sigilo.settings';

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export const loadAuth = () => readJson<StoredAuth>(AUTH_KEY);
export const saveAuth = (auth: StoredAuth) => SecureStore.setItemAsync(AUTH_KEY, JSON.stringify(auth));
export const clearAuth = () => SecureStore.deleteItemAsync(AUTH_KEY).catch(() => {});

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await readJson<Partial<Settings>>(SETTINGS_KEY)) };
}
export const saveSettings = (s: Settings) => SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(s));

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Chaves públicas já vistas dos contatos (confiança no primeiro uso), separadas por conta neste aparelho. */
export function pinStoreFor(handle: string): KeyPinStore {
  const key = (userId: string) => `sigilo.pin.${safe(handle)}.${safe(userId)}`;
  return {
    get: async (userId) => (await SecureStore.getItemAsync(key(userId))) ?? undefined,
    set: (userId, publicKey) => SecureStore.setItemAsync(key(userId), publicKey),
  };
}
