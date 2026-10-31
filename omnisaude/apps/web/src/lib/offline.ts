'use client';

import { useEffect, useState } from 'react';

/**
 * Armazenamento local para trabalho sem internet (app do ACS): IndexedDB com duas coleções, a fila de
 * operações a sincronizar e o cache do que foi baixado (território, visitas). Sem IndexedDB (SSR, navegação
 * privada antiga), tudo vira operação vazia e a tela segue só com a rede.
 */
const DB_NAME = 'omnisaude-campo';
const DB_VERSION = 1;
export type Store = 'fila' | 'cache';

function abrir(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('fila')) db.createObjectStore('fila', { keyPath: 'clientId' });
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function tx<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | IDBRequest<T[]>): Promise<T | T[] | undefined> {
  const db = await abrir();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(undefined);
      t.oncomplete = () => db.close();
    } catch {
      resolve(undefined);
    }
  });
}

export const local = {
  get: <T>(store: Store, key: string) => tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>) as Promise<T | undefined>,
  all: async <T>(store: Store) => ((await tx<T>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)) as T[] | undefined) ?? [],
  put: (store: Store, value: unknown) => tx(store, 'readwrite', (s) => s.put(value)),
  delete: (store: Store, key: string) => tx(store, 'readwrite', (s) => s.delete(key)),
};

/** UUID do aparelho para identificar cada operação (idempotência na sincronização). */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function estaOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

/** Estado da conexão, atualizado pelos eventos do navegador. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(estaOnline());
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export interface Posicao {
  latitude: number;
  longitude: number;
  precisao: number | null;
}

/** Posição atual pelo GPS do aparelho (ou do navegador), com até 15 s de espera. */
export function obterPosicao(): Promise<Posicao> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Este aparelho não informa a localização'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: Number(p.coords.latitude.toFixed(6)), longitude: Number(p.coords.longitude.toFixed(6)), precisao: p.coords.accuracy ? Math.round(p.coords.accuracy) : null }),
      (e) => reject(new Error(e.code === 1 ? 'Permissão de localização negada' : 'Não foi possível obter a localização')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}

/** Registra o service worker que guarda as telas para abrir sem internet (só fora do app nativo, que já é local). */
export function registrarServiceWorker(basePath: string) {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  const native = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  if (native || (window.location.protocol === 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1')) return;
  navigator.serviceWorker.register(`${basePath}/sw.js`, { scope: `${basePath}/` }).catch(() => {
    // Sem service worker a tela continua funcionando online; o cache de dados é o IndexedDB.
  });
}
