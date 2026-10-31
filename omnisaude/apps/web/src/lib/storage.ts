/**
 * Guarda o token da sessão. No navegador usa sessionStorage (fecha a aba, encerra a sessão);
 * no app Android o WebView é isolado e usa localStorage para sobreviver à troca de telas.
 */
const KEY = 'omni.token';

function store(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    const native = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
    return native ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export const tokenStore = {
  get(): string | null {
    try {
      return store()?.getItem(KEY) ?? null;
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      store()?.setItem(KEY, token);
    } catch {
      // Navegação privada sem armazenamento: a sessão dura até recarregar a página.
    }
  },
  clear() {
    try {
      store()?.removeItem(KEY);
    } catch {
      // idem
    }
  },
};

/** Cópia da sessão (/auth/me) para abrir as telas de campo sem rede; some no logout. */
const ME_KEY = 'omni.me';
export const meStore = {
  get<T>(): T | null {
    try {
      const raw = store()?.getItem(ME_KEY);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(me: unknown) {
    try {
      store()?.setItem(ME_KEY, JSON.stringify(me));
    } catch {
      // sem armazenamento: só online
    }
  },
  clear() {
    try {
      store()?.removeItem(ME_KEY);
    } catch {
      // idem
    }
  },
};
