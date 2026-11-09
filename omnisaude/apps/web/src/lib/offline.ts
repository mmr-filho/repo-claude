'use client';

import { useEffect, useState } from 'react';

/**
 * Armazenamento no aparelho para o trabalho sem internet: IndexedDB, um banco por app de campo, cada um com a fila de
 * operações a sincronizar ('fila') e o cache do que foi baixado ('cache'). O do ACS é 'omnisaude-campo' (versão 1) e o do
 * ACE é 'omnisaude-campo-ace'. Bancos separados porque subir a versão de um banco compartilhado quebra as abas (ou as
 * cópias guardadas pelo service worker) que ainda rodam o código anterior: elas abrem pela versão que conhecem e passam a
 * receber VersionError. Por isso o banco é aberto sem versão fixa e a versão só sobe quando falta um store.
 *
 * Gravação só termina quando a transação é confirmada (oncomplete); erro, cancelamento e banco preso por outra aba viram
 * ErroAparelho, para a tela nunca dizer "registrado" sem ter gravado.
 */
export const BANCO_ACS = 'omnisaude-campo';
export const BANCO_ACE = 'omnisaude-campo-ace';
const STORES = { fila: 'clientId', cache: 'key' } as const;
export type Store = keyof typeof STORES;

const FALHA_GRAVAR = 'Não foi possível guardar no aparelho: feche as outras abas do OmniSaúde e tente de novo';

/** Falha do armazenamento do aparelho (IndexedDB), com mensagem para mostrar ao agente. */
export class ErroAparelho extends Error {
  constructor(
    message = FALHA_GRAVAR,
    public readonly causa?: unknown,
  ) {
    super(message);
    this.name = 'ErroAparelho';
  }
}

function erroAparelho(causa: unknown): ErroAparelho {
  if (causa instanceof ErroAparelho) return causa;
  const nome = causa instanceof DOMException || causa instanceof Error ? causa.name : '';
  if (nome === 'QuotaExceededError') return new ErroAparelho('Não foi possível guardar no aparelho: o espaço de armazenamento acabou. Libere espaço e tente de novo', causa);
  return new ErroAparelho(FALHA_GRAVAR, causa);
}

function criarStores(db: IDBDatabase) {
  for (const [nome, keyPath] of Object.entries(STORES)) if (!db.objectStoreNames.contains(nome)) db.createObjectStore(nome, { keyPath });
}

const EM_USO = 'O banco do aparelho está em uso por outra aba do OmniSaúde: feche as outras abas e tente de novo';
/**
 * Bancos com um pedido de versão parado por outra aba. O navegador põe todo pedido seguinte ao mesmo banco atrás dele:
 * sem recusar na hora, a operação ficaria esperando até a outra aba fechar (o "Salvar" girando sem resposta).
 */
const presos = new Set<string>();

/** Abre o banco; sem `versao`, na versão em que ele estiver (ou cria na 1). */
function abrirNaVersao(nome: string, versao?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new ErroAparelho('Este navegador não guarda dados no aparelho: use o navegador atualizado ou o app do OmniSaúde'));
      return;
    }
    if (presos.has(nome)) {
      reject(new ErroAparelho(EM_USO));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = versao ? indexedDB.open(nome, versao) : indexedDB.open(nome);
    } catch (e) {
      reject(erroAparelho(e));
      return;
    }
    // Recusado (erro ou bloqueio): se o banco abrir depois, a conexão é fechada em seguida.
    let desistiu = false;
    req.onupgradeneeded = () => criarStores(req.result);
    req.onsuccess = () => {
      presos.delete(nome);
      const db = req.result;
      if (desistiu) {
        db.close();
        return;
      }
      // Outra aba precisa subir a versão: esta conexão sai do caminho em vez de bloquear.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => {
      presos.delete(nome);
      desistiu = true;
      reject(erroAparelho(req.error));
    };
    req.onblocked = () => {
      desistiu = true;
      presos.add(nome);
      reject(new ErroAparelho(EM_USO));
    };
  });
}

async function abrir(nome: string): Promise<IDBDatabase> {
  const db = await abrirNaVersao(nome);
  if (Object.keys(STORES).every((s) => db.objectStoreNames.contains(s))) return db;
  const versao = db.version + 1;
  db.close();
  return abrirNaVersao(nome, versao);
}

/**
 * Roda `fn` numa transação; resolve com o valor devolvido só quando a transação é confirmada. Se `fn` lança na hora (um
 * put com valor que não se copia, DataCloneError, ou sem chave válida, DataError), a transação é cancelada antes de
 * rejeitar: o que já foi pedido nela não fica (o responsável sem o domicílio). `falhar` faz o mesmo de dentro do
 * onsuccess de um pedido.
 */
function transacao<T>(db: IDBDatabase, stores: string[], modo: IDBTransactionMode, fn: (t: IDBTransaction, falhar: (e: unknown) => void) => () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    let t: IDBTransaction | undefined;
    let resultado: () => T;
    const falhar = (e: unknown) => {
      try {
        t?.abort();
      } catch {
        // A transação já terminou: não há o que desfazer.
      }
      reject(erroAparelho(e));
    };
    try {
      t = db.transaction(stores, modo);
      resultado = fn(t, falhar);
    } catch (e) {
      falhar(e);
      return;
    }
    const tx = t;
    tx.oncomplete = () => resolve(resultado());
    // O erro de um pedido chega à transação antes de ela ter erro (o navegador só o preenche ao cancelar): vale o do pedido.
    tx.onerror = (evento) => reject(erroAparelho(tx.error ?? (evento.target as IDBRequest | null)?.error ?? null));
    tx.onabort = () => reject(erroAparelho(tx.error));
  });
}

/** Uma gravação de `gravar`: põe `put` ou apaga a chave `delete` no store. */
export interface Gravacao {
  store: Store;
  put?: unknown;
  delete?: string;
}

/** O que `atualizarVarios` lê de cada store: as chaves pedidas, ou 'todas' (o store inteiro). */
export type Leituras = Partial<Record<Store, string[] | 'todas'>>;
/** O que `atualizarVarios` leu, por store: chave → registro guardado (a chave que não está guardada não aparece). */
export type Lidos = Record<Store, Map<string, unknown>>;

export interface BancoLocal {
  get<T>(store: Store, key: string): Promise<T | undefined>;
  all<T>(store: Store): Promise<T[]>;
  put(store: Store, value: unknown): Promise<void>;
  delete(store: Store, key: string): Promise<void>;
  /** Várias gravações numa transação só: todas ou nenhuma. */
  gravar(gravacoes: Gravacao[]): Promise<void>;
  /**
   * Lê e regrava um registro numa transação só (nada de outra aba entra entre a leitura e a gravação): `fn` recebe o que
   * está guardado (undefined se não está) e devolve o que gravar, ou undefined para não gravar. Resolve com o que gravou.
   */
  atualizar<T>(store: Store, key: string, fn: (atual: T | undefined) => T | undefined): Promise<T | undefined>;
  /**
   * Lê vários registros e grava numa transação só, sobre os dois stores (nada de outra aba entra entre a leitura e a
   * gravação): `fn` recebe o que está guardado nas chaves pedidas e devolve as gravações, em qualquer store, feitas todas
   * ou nenhuma. Resolve com as gravações feitas.
   */
  atualizarVarios(leituras: Leituras, fn: (lidos: Lidos) => Gravacao[]): Promise<Gravacao[]>;
}

/**
 * Banco do aparelho com uma conexão por página (reaberta se outra aba a fechar). `preparar` roda uma vez a cada conexão
 * nova, antes da primeira operação (ex.: trazer dados do banco antigo); falha nela fica só no console.
 */
function criarBanco(nome: string, preparar?: (db: IDBDatabase) => Promise<void>): BancoLocal {
  let conexao: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (!conexao) {
      const abrindo = abrir(nome).then(async (d) => {
        const esquecer = () => {
          if (conexao === abrindo) conexao = null;
        };
        d.addEventListener('versionchange', esquecer);
        d.addEventListener('close', esquecer);
        if (preparar) await preparar(d).catch((e) => console.warn(`Banco ${nome}: preparação não concluída`, e));
        return d;
      });
      conexao = abrindo;
      abrindo.catch(() => {
        if (conexao === abrindo) conexao = null;
      });
    }
    return conexao;
  };
  // Conexão fechada por outra aba entre abrir e usar: uma nova tentativa com conexão nova.
  const usar = async <T>(fn: (d: IDBDatabase) => Promise<T>): Promise<T> => {
    try {
      return await fn(await db());
    } catch (e) {
      if (!(e instanceof ErroAparelho) || !(e.causa instanceof DOMException) || e.causa.name !== 'InvalidStateError') throw e;
      conexao = null;
      return fn(await db());
    }
  };
  return {
    get: <T>(store: Store, key: string) =>
      usar((d) =>
        transacao(d, [store], 'readonly', (t) => {
          const r = t.objectStore(store).get(key);
          return () => r.result as T | undefined;
        }),
      ),
    all: <T>(store: Store) =>
      usar((d) =>
        transacao(d, [store], 'readonly', (t) => {
          const r = t.objectStore(store).getAll();
          return () => (r.result ?? []) as T[];
        }),
      ),
    put: (store: Store, value: unknown) =>
      usar((d) =>
        transacao(d, [store], 'readwrite', (t) => {
          t.objectStore(store).put(value);
          return () => undefined;
        }),
      ),
    delete: (store: Store, key: string) =>
      usar((d) =>
        transacao(d, [store], 'readwrite', (t) => {
          t.objectStore(store).delete(key);
          return () => undefined;
        }),
      ),
    gravar: (gravacoes: Gravacao[]) =>
      gravacoes.length
        ? usar((d) =>
            transacao(d, [...new Set(gravacoes.map((g) => g.store))], 'readwrite', (t) => {
              for (const g of gravacoes) {
                if (g.delete !== undefined) t.objectStore(g.store).delete(g.delete);
                else t.objectStore(g.store).put(g.put);
              }
              return () => undefined;
            }),
          )
        : Promise.resolve(),
    atualizar: <T>(store: Store, key: string, fn: (atual: T | undefined) => T | undefined) =>
      usar((d) =>
        transacao(d, [store], 'readwrite', (t, falhar) => {
          const s = t.objectStore(store);
          const lido = s.get(key);
          let novo: T | undefined;
          lido.onsuccess = () => {
            try {
              novo = fn(lido.result as T | undefined);
              if (novo !== undefined) s.put(novo);
            } catch (e) {
              // fn lançou, ou o valor novo não se copia: nada é gravado e a causa sobe.
              falhar(e);
            }
          };
          return () => novo;
        }),
      ),
    atualizarVarios: (leituras: Leituras, fn: (lidos: Lidos) => Gravacao[]) =>
      usar((d) =>
        transacao(d, Object.keys(STORES), 'readwrite', (t, falhar) => {
          const lidos: Lidos = { fila: new Map(), cache: new Map() };
          let feitas: Gravacao[] = [];
          // Leituras que faltam, mais esta chamada: com tudo lido (ou nada a ler), fn e as gravações, ainda na transação.
          let faltam = 1;
          const lido = () => {
            if (--faltam) return;
            try {
              feitas = fn(lidos);
              for (const g of feitas) {
                if (g.delete !== undefined) t.objectStore(g.store).delete(g.delete);
                else t.objectStore(g.store).put(g.put);
              }
            } catch (e) {
              // fn lançou, ou um valor novo não se copia: nada é gravado e a causa sobe.
              falhar(e);
            }
          };
          for (const [store, chaves] of Object.entries(leituras) as [Store, Leituras[Store]][]) {
            const s = t.objectStore(store);
            if (chaves === 'todas') {
              faltam++;
              const r = s.getAll();
              r.onsuccess = () => {
                for (const v of (r.result ?? []) as Record<string, unknown>[]) lidos[store].set(String(v[STORES[store]]), v);
                lido();
              };
              continue;
            }
            for (const chave of new Set(chaves)) {
              faltam++;
              const r = s.get(chave);
              r.onsuccess = () => {
                if (r.result !== undefined) lidos[store].set(chave, r.result);
                lido();
              };
            }
          }
          lido();
          return () => feitas;
        }),
      ),
  };
}

/** Registros do ACE que o código anterior (banco 'omnisaude-campo' na versão 2) guardou no banco do ACS. */
const CHAVES_ACE_NO_CACHE = /^(pacote:ace:|historico-ace:|tubito:)/;

/**
 * Traz para o banco do ACE a fila ('filaAce') e o cache do ACE que ficaram no banco do ACS na versão 2 (só existiu
 * durante a semana 26). Copia sem sobrescrever o que o banco novo já tem e só então apaga do antigo. Roda a cada
 * conexão: uma aba antiga ainda aberta pode ter gravado de novo lá.
 */
async function migrarDoBancoDoAcs(destino: IDBDatabase): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  if (typeof indexedDB.databases === 'function') {
    const bancos = await indexedDB.databases().catch(() => null);
    if (bancos && !bancos.some((b) => b.name === BANCO_ACS)) return;
  }
  const antigo = await abrirNaVersao(BANCO_ACS);
  try {
    if (!antigo.objectStoreNames.contains('filaAce')) return;
    const [itens, cache] = await transacao(antigo, ['filaAce', 'cache'], 'readonly', (t) => {
      const a = t.objectStore('filaAce').getAll();
      const c = t.objectStore('cache').getAll();
      return () => [(a.result ?? []) as { clientId: string }[], ((c.result ?? []) as { key: string }[]).filter((e) => CHAVES_ACE_NO_CACHE.test(e.key))] as const;
    });
    if (!itens.length && !cache.length) return;
    await transacao(destino, ['fila', 'cache'], 'readwrite', (t) => {
      const copiar = (store: IDBObjectStore, valor: unknown, chave: string) => {
        const r = store.get(chave);
        r.onsuccess = () => {
          if (r.result === undefined) store.put(valor);
        };
      };
      for (const i of itens) copiar(t.objectStore('fila'), i, i.clientId);
      for (const e of cache) copiar(t.objectStore('cache'), e, e.key);
      return () => undefined;
    });
    await transacao(antigo, ['filaAce', 'cache'], 'readwrite', (t) => {
      for (const i of itens) t.objectStore('filaAce').delete(i.clientId);
      for (const e of cache) t.objectStore('cache').delete(e.key);
      return () => undefined;
    });
  } finally {
    antigo.close();
  }
}

const bancoAcs = criarBanco(BANCO_ACS);

/**
 * Banco do ACS (app do agente comunitário). Leitura com falha devolve vazio e gravação no cache é melhor esforço (o
 * cache se baixa de novo), como antes; gravação e remoção na fila propagam a falha, e `gravar` (várias gravações numa
 * transação só, como o registro inteiro na fila) e `atualizar` (ler e regravar numa transação só) também.
 */
export const local = {
  get: <T>(store: Store, key: string) =>
    bancoAcs.get<T>(store, key).catch((e) => {
      console.warn('Leitura do aparelho falhou', e);
      return undefined;
    }),
  all: <T>(store: Store) =>
    bancoAcs.all<T>(store).catch((e) => {
      console.warn('Leitura do aparelho falhou', e);
      return [] as T[];
    }),
  put: (store: Store, value: unknown) => (store === 'cache' ? bancoAcs.put(store, value).catch((e) => console.warn('Cache do aparelho não gravado', e)) : bancoAcs.put(store, value)),
  delete: (store: Store, key: string) => bancoAcs.delete(store, key),
  gravar: (gravacoes: Gravacao[]) => bancoAcs.gravar(gravacoes),
  atualizar: <T>(store: Store, key: string, fn: (atual: T | undefined) => T | undefined) => bancoAcs.atualizar<T>(store, key, fn),
};

/** Banco do ACE (app do agente de combate às endemias): tudo propaga a falha, e a tela mostra o que houve. */
export const localAce: BancoLocal = criarBanco(BANCO_ACE, migrarDoBancoDoAcs);

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

/**
 * Sinal que cancela a requisição depois de `ms`: com sinal fraco (rede que conecta e não trafega), o fetch ficaria
 * pendurado por minutos. O cancelamento chega como falha de rede (ApiError 0).
 */
export function comPrazo(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException('Tempo de espera esgotado', 'TimeoutError')), ms);
  return c.signal;
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
      // Leitura nova: posição em cache seria a da casa anterior e viraria a posição deste imóvel.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

// ─── Service worker (telas sem internet) ──────────────────────────────────────

let ouvindoServiceWorker = false;

function podeTerServiceWorker(): boolean {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;
  // O app nativo já tem as telas no aparelho; fora de HTTPS (exceto localhost) o navegador não aceita service worker.
  const nativo = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  if (nativo) return false;
  return window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

/**
 * Registra o service worker que guarda as telas de campo para abrir sem internet (chamado pelo layout autenticado) e
 * manda a ele o que esta página já carregou antes de ele assumir. Em desenvolvimento os arquivos mudam a cada edição, e
 * um service worker serviria cópias velhas: ele fica desligado (e o de antes é removido), salvo NEXT_PUBLIC_SW_DEV=1.
 */
export function registrarServiceWorker(basePath: string) {
  if (!podeTerServiceWorker()) return;
  if (process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_SW_DEV !== '1') {
    void navigator.serviceWorker
      .getRegistrations()
      .then((rs) => rs.filter((r) => (r.active ?? r.waiting ?? r.installing)?.scriptURL.endsWith('/sw.js')).forEach((r) => void r.unregister()))
      .catch(() => {});
    return;
  }
  navigator.serviceWorker.register(`${basePath}/sw.js`, { scope: `${basePath}/`, updateViaCache: 'none' }).catch(() => {
    // Sem service worker a tela continua funcionando online; os dados de campo ficam no IndexedDB.
  });
  if (ouvindoServiceWorker) return;
  ouvindoServiceWorker = true;
  // Service worker novo assumiu (primeira instalação ou versão nova): ele ainda não tem o que esta página carregou.
  navigator.serviceWorker.addEventListener('controllerchange', () => avisarServiceWorker());
  avisarServiceWorker();
}

/**
 * Manda ao service worker o endereço desta tela e os arquivos que ela já carregou (inclusive os carregados antes de ele
 * assumir a página e os de navegação pelo menu, que não pedem o documento), para ele guardar o que faltar.
 */
export function avisarServiceWorker() {
  if (!podeTerServiceWorker() || (process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_SW_DEV !== '1')) return;
  void navigator.serviceWorker.ready
    .then((reg) => {
      const origem = window.location.origin;
      const recursos = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => {
          if (!u.startsWith(`${origem}/`) || u.includes('_rsc=')) return false;
          return !/\/(api|socket\.io)(\/|$)/.test(new URL(u).pathname);
        });
      reg.active?.postMessage({ tipo: 'guardar', documento: window.location.pathname, recursos: [...new Set(recursos)].slice(0, 500) });
    })
    .catch(() => {});
}
