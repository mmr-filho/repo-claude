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
