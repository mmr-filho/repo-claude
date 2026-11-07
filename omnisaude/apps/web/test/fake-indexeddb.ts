/**
 * IndexedDB simulado em memória, só com o que o armazenamento do app de campo usa: abertura com e sem versão (upgrade,
 * VersionError, versionchange nas outras conexões e blocked enquanto elas não fecham), transações com cópia de trabalho
 * confirmada só no complete (erro de requisição e cancelamento desfazem tudo) e databases(). Permite injetar as falhas
 * que o navegador produz: erro na abertura, erro numa gravação (cota) e cancelamento na confirmação.
 */
type Linha = Record<string, unknown>;
type Ouvinte = (e: Evento) => void;

export class Evento {
  defaultPrevented = false;
  oldVersion = 0;
  newVersion: number | null = null;
  constructor(
    public readonly type: string,
    public readonly target: unknown,
  ) {}
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class Alvo {
  private ouvintes = new Map<string, Set<Ouvinte>>();
  [prop: `on${string}`]: unknown;
  addEventListener(tipo: string, fn: Ouvinte) {
    const s = this.ouvintes.get(tipo) ?? new Set();
    s.add(fn);
    this.ouvintes.set(tipo, s);
  }
  removeEventListener(tipo: string, fn: Ouvinte) {
    this.ouvintes.get(tipo)?.delete(fn);
  }
  despachar(tipo: string, e: Evento = new Evento(tipo, this)): Evento {
    const prop = this[`on${tipo}`];
    if (typeof prop === 'function') (prop as Ouvinte).call(this, e);
    for (const fn of [...(this.ouvintes.get(tipo) ?? [])]) fn.call(this, e);
    return e;
  }
}

class Requisicao extends Alvo {
  result: unknown = undefined;
  error: DOMException | null = null;
  readyState: 'pending' | 'done' = 'pending';
}

interface Store {
  keyPath: string;
  linhas: Map<string, Linha>;
}
interface Dados {
  versao: number;
  stores: Map<string, Store>;
}

const copia = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
const depois = (fn: () => void) => setTimeout(fn, 0);

class Loja {
  constructor(
    private readonly tx: Transacao,
    private readonly nome: string,
    private readonly keyPath: string,
  ) {}
  get(chave: string) {
    return this.tx.pedir(this.nome, false, (l) => copia(l.get(chave)));
  }
  getAll() {
    return this.tx.pedir(this.nome, false, (l) => [...l.values()].map(copia));
  }
  put(valor: Linha) {
    return this.tx.pedir(this.nome, true, (l) => {
      const chave = String(valor[this.keyPath]);
      l.set(chave, copia(valor));
      return chave;
    });
  }
  delete(chave: string) {
    return this.tx.pedir(this.nome, true, (l) => {
      l.delete(chave);
      return undefined;
    });
  }
}

export class Transacao extends Alvo {
  error: DOMException | null = null;
  private pendentes = 0;
  private terminou = false;
  private readonly trabalho: Map<string, Map<string, Linha>>;
  constructor(
    private readonly fake: FakeIndexedDB,
    private readonly dados: Dados,
    private readonly nomes: string[],
    private readonly modo: IDBTransactionMode,
  ) {
    super();
    this.trabalho = new Map(nomes.map((n) => [n, new Map(dados.stores.get(n)!.linhas)]));
    depois(() => this.talvezConfirmar());
  }
  objectStore(nome: string) {
    if (!this.nomes.includes(nome)) throw new DOMException(`Store ${nome} fora da transação`, 'NotFoundError');
    return new Loja(this, nome, this.dados.stores.get(nome)!.keyPath);
  }
  pedir(store: string, gravacao: boolean, fn: (linhas: Map<string, Linha>) => unknown): Requisicao {
    if (this.terminou) throw new DOMException('Transação encerrada', 'TransactionInactiveError');
    if (gravacao && this.modo !== 'readwrite') throw new DOMException('Transação só de leitura', 'ReadOnlyError');
    const req = new Requisicao();
    this.pendentes += 1;
    depois(() => {
      if (this.terminou) return;
      this.pendentes -= 1;
      req.readyState = 'done';
      const falha = gravacao ? this.fake.erroNaGravacao : null;
      if (falha) {
        req.error = falha;
        if (!req.despachar('error').defaultPrevented) {
          this.error = falha;
          this.despachar('error');
          this.cancelar();
          return;
        }
      } else {
        req.result = fn(this.trabalho.get(store)!);
        req.despachar('success');
      }
      depois(() => this.talvezConfirmar());
    });
    return req;
  }
  abort() {
    this.cancelar();
  }
  private cancelar() {
    if (this.terminou) return;
    this.terminou = true;
    this.despachar('abort');
  }
  private talvezConfirmar() {
    if (this.terminou || this.pendentes) return;
    if (this.modo === 'readwrite' && this.fake.cancelarNaConfirmacao) {
      this.error = new DOMException('Cota de armazenamento excedida', 'QuotaExceededError');
      this.cancelar();
      return;
    }
    this.terminou = true;
    if (this.modo === 'readwrite') for (const [n, linhas] of this.trabalho) this.dados.stores.get(n)!.linhas = linhas;
    this.despachar('complete');
  }
}

export class Conexao extends Alvo {
  fechada = false;
  emUpgrade = false;
  constructor(
    private readonly fake: FakeIndexedDB,
    readonly name: string,
    private readonly dados: Dados,
  ) {
    super();
  }
  get version() {
    return this.dados.versao;
  }
  get objectStoreNames() {
    const nomes = [...this.dados.stores.keys()];
    return { contains: (n: string) => nomes.includes(n), length: nomes.length };
  }
  createObjectStore(nome: string, opcoes: { keyPath: string }) {
    if (!this.emUpgrade) throw new DOMException('Fora do upgrade', 'InvalidStateError');
    this.dados.stores.set(nome, { keyPath: opcoes.keyPath, linhas: new Map() });
  }
  transaction(stores: string | string[], modo: IDBTransactionMode = 'readonly') {
    if (this.fechada) throw new DOMException('The database connection is closing.', 'InvalidStateError');
    const nomes = Array.isArray(stores) ? stores : [stores];
    for (const n of nomes) if (!this.dados.stores.has(n)) throw new DOMException(`Store ${n} não existe`, 'NotFoundError');
    return new Transacao(this.fake, this.dados, nomes, modo);
  }
  close() {
    this.fechada = true;
  }
}

export class FakeIndexedDB {
  readonly bancos = new Map<string, Dados>();
  readonly conexoes: Conexao[] = [];
  /** A próxima abertura falha com este erro. */
  falharAbertura: DOMException | null = null;
  /** Toda gravação falha com este erro (a transação é cancelada). */
  erroNaGravacao: DOMException | null = null;
  /** As gravações passam, mas a transação é cancelada na confirmação (cota estourada no commit). */
  cancelarNaConfirmacao = false;

  /** Cria um banco já existente (ex.: o do ACS que o código desta semana subiu para a versão 2). */
  criar(nome: string, versao: number, stores: Record<string, { keyPath: string; linhas?: Linha[] }>) {
    this.bancos.set(nome, {
      versao,
      stores: new Map(Object.entries(stores).map(([n, s]) => [n, { keyPath: s.keyPath, linhas: new Map((s.linhas ?? []).map((l) => [String(l[s.keyPath]), copia(l)])) }])),
    });
  }
  linhas(nome: string, store: string): Linha[] {
    return [...(this.bancos.get(nome)?.stores.get(store)?.linhas.values() ?? [])];
  }

  async databases() {
    return [...this.bancos].map(([name, d]) => ({ name, version: d.versao }));
  }

  /** Pedidos ao banco que esperam o pedido de versão em curso (bloqueado por outra conexão), como no navegador. */
  private readonly naFila = new Map<string, (() => void)[]>();

  open(nome: string, versao?: number) {
    const req = new Requisicao();
    depois(() => this.abrir(req, nome, versao));
    return req;
  }

  private abrir(req: Requisicao, nome: string, versao?: number) {
    const fila = this.naFila.get(nome);
    if (fila) {
      fila.push(() => this.abrir(req, nome, versao));
      return;
    }
    if (this.falharAbertura) {
      req.error = this.falharAbertura;
      req.readyState = 'done';
      req.despachar('error');
      return;
    }
    const existente = this.bancos.get(nome);
    const atual = existente?.versao ?? 0;
    const alvo = versao ?? (atual || 1);
    if (alvo < atual) {
      req.error = new DOMException(`A versão pedida (${alvo}) é menor que a existente (${atual})`, 'VersionError');
      req.readyState = 'done';
      req.despachar('error');
      return;
    }
    if (alvo === atual && existente) {
      req.result = this.conectar(nome, existente);
      req.readyState = 'done';
      req.despachar('success');
      return;
    }
    const outras = this.conexoes.filter((c) => c.name === nome && !c.fechada);
    for (const c of outras) c.despachar('versionchange');
    const seguir = () => {
      const dados = existente ?? { versao: 0, stores: new Map() };
      this.bancos.set(nome, dados);
      const db = this.conectar(nome, dados);
      req.result = db;
      db.emUpgrade = true;
      const e = new Evento('upgradeneeded', req);
      e.oldVersion = atual;
      e.newVersion = alvo;
      req.despachar('upgradeneeded', e);
      db.emUpgrade = false;
      dados.versao = alvo;
      req.readyState = 'done';
      req.despachar('success');
    };
    const abertas = () => outras.filter((c) => !c.fechada);
    if (!abertas().length) {
      seguir();
      return;
    }
    req.despachar('blocked');
    this.naFila.set(nome, []);
    const esperar = () => {
      if (abertas().length) {
        setTimeout(esperar, 2);
        return;
      }
      seguir();
      const atras = this.naFila.get(nome) ?? [];
      this.naFila.delete(nome);
      for (const fn of atras) depois(fn);
    };
    setTimeout(esperar, 2);
  }

  private conectar(nome: string, dados: Dados) {
    const c = new Conexao(this, nome, dados);
    this.conexoes.push(c);
    return c;
  }
}

/** Abre uma conexão "de outra aba" (sem tratar versionchange, como o código antigo). */
export function abrirOutraAba(fake: FakeIndexedDB, nome: string, versao?: number): Promise<Conexao> {
  return new Promise((resolve, reject) => {
    const req = fake.open(nome, versao) as unknown as Requisicao;
    req.onsuccess = () => resolve(req.result as Conexao);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result as Conexao;
      for (const [s, keyPath] of [
        ['fila', 'clientId'],
        ['cache', 'key'],
      ] as const)
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath });
    };
  });
}
