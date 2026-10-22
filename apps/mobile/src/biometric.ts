import * as SecureStore from 'expo-secure-store';
import { b64, type Bytes } from '@sigilo/core';

/*
 * Destravar com a digital (ou rosto, no iPhone).
 *
 * A chave que abre o cofre fica no Keychain (iOS) / Keystore (Android) com `requireAuthentication`: o SISTEMA só a
 * entrega depois da biometria, e ela deixa de existir se as digitais cadastradas no aparelho mudarem. A senha continua
 * valendo como alternativa. Um bônus: destravar assim não refaz o cálculo lento da senha.
 */

const KEY = 'sigilo2.biokey';

/** O usuário cancelou, errou demais ou a biometria falhou: pode tentar de novo ou usar a senha. */
export class BiometricCancelled extends Error {
  constructor(message = 'Biometria não confirmada') {
    super(message);
    this.name = 'BiometricCancelled';
  }
}

/** Não há mais chave guardada (digitais do aparelho mudaram ou ela foi apagada): a biometria precisa ser reativada. */
export class BiometricGone extends Error {
  constructor() {
    super('A biometria foi desativada');
    this.name = 'BiometricGone';
  }
}

export function biometricAvailable(): boolean {
  try {
    return SecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
}

export async function saveBiometricKey(key: Bytes): Promise<void> {
  await SecureStore.setItemAsync(KEY, b64.encode(key), {
    requireAuthentication: true,
    authenticationPrompt: 'Confirme para ativar o desbloqueio com biometria',
  });
}

export async function readBiometricKey(): Promise<Bytes> {
  let value: string | null;
  try {
    value = await SecureStore.getItemAsync(KEY, { requireAuthentication: true, authenticationPrompt: 'Destrancar o Sigilo' });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    // A chave é invalidada pelo sistema quando as digitais cadastradas mudam.
    if (/invalidat|not found|no longer/i.test(message)) throw new BiometricGone();
    throw new BiometricCancelled(message || undefined);
  }
  if (!value) throw new BiometricGone();
  return b64.decode(value);
}

export async function clearBiometricKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY).catch(() => undefined);
}
