/**
 * IndexedDB simulado em memória, só com o que o armazenamento do app de campo usa: abertura com e sem versão (upgrade,
 * VersionError, versionchange nas outras conexões e blocked enquanto elas não fecham), transações e databases(). As
 * transações seguem a ordem do navegador, entre todas as conexões do banco: a de gravação só começa quando terminaram as
 * criadas antes dela com algum store em comum, e a de leitura, quando terminaram as de gravação nessas condições (leituras
 * correm juntas). Cada uma trabalha numa cópia tirada quando começa, confirmada só no complete (erro de requisição e
 * cancelamento desfazem tudo): nenhuma gravação se perde entre transações sobrepostas, e a leitura só vê o que foi
 * confirmado. Permite injetar as falhas que o navegador produz (erro na abertura, erro numa gravação, cancelamento na
 * confirmação) e acompanhar cada leitura, cada gravação e cada confirmação.
 *
 * Erros e cancelamento seguem a ordem do navegador: o put copia o valor e tira a chave na hora (lança DataCloneError ou
 * DataError); o erro de um pedido sobe do pedido para a transação antes de ela ter erro (transaction.error só é
 * preenchido ao cancelar); no cancelamento, cada pedido ainda não atendido recebe error com AbortError e só depois a
 * transação recebe abort, em tarefas seguintes; abort() de transação já terminada lança InvalidStateError.
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
  /** Transações deste banco ainda não terminadas, de todas as conexões, na ordem em que foram criadas. */
  transacoes: Transacao[];
}

/** Uma gravação, como `aoGravar` a recebe. */
export interface GravacaoVista {
  banco: string;
  store: string;
  chave: string;
  tipo: 'put' | 'delete';
}

/** Uma leitura, como `aoLer` a recebe (chave null: getAll). */
export interface LeituraVista {
  banco: string;
  store: string;
  chave: string | null;
}

/** O que um pedido faz no store. */
type Pedido = { tipo: 'get'; chave: string } | { tipo: 'getAll'; chave: null } | { tipo: 'put' | 'delete'; chave: string };

const copia = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
const depois = (fn: () => void) => setTimeout(fn, 0);

/** Chave do pedido; como no navegador, a inválida lança DataError (o app só usa texto e número). */
function chaveValida(v: unknown): string {
  if (typeof v === 'string' || (typeof v === 'number' && !Number.isNaN(v))) return String(v);
  throw new DOMException('A chave informada não é válida', 'DataError');
}

class Loja {
  constructor(
    private readonly tx: Transacao,
    private readonly nome: string,
    private readonly keyPath: string,
  ) {}
  get(chave: string) {
    this.tx.conferir(false);
    const k = chaveValida(chave);
    return this.tx.pedir(this.nome, { tipo: 'get', chave: k }, (l) => copia(l.get(k)));
  }
  getAll() {
    this.tx.conferir(false);
    return this.tx.pedir(this.nome, { tipo: 'getAll', chave: null }, (l) => [...l.values()].map(copia));
  }
  put(valor: Linha) {
    this.tx.conferir(true);
    // Como no navegador, o valor é copiado na hora do put (DataCloneError) e a chave sai da cópia (DataError).
    const v = copia(valor);
    const chave = chaveValida((v as Linha | null | undefined)?.[this.keyPath]);
    return this.tx.pedir(this.nome, { tipo: 'put', chave }, (l) => {
      l.set(chave, v);
      return chave;
    });
  }
  delete(chave: string) {
    this.tx.conferir(true);
    const k = chaveValida(chave);
    return this.tx.pedir(this.nome, { tipo: 'delete', chave: k }, (l) => {
      l.delete(k);
      return undefined;
    });
  }
}

export class Transacao extends Alvo {
  error: DOMException | null = null;
  private comecou = false;
  private terminou = false;
  /** Requisições ainda não atendidas, na ordem em que vieram: no cancelamento, cada uma recebe error com AbortError. */
  private readonly abertas = new Set<Requisicao>();
  /** Requisições feitas antes de a transação começar: rodam quando ela começa, na ordem em que vieram. */
  private emEspera: (() => void)[] = [];
  /** Cópia de trabalho dos stores, tirada quando a transação começa (antes disso, outra ainda podia mudar o banco). */
  private readonly trabalho = new Map<string, Map<string, Linha>>();
  constructor(
    private readonly fake: FakeIndexedDB,
    private readonly banco: string,
    private readonly dados: Dados,
    private readonly nomes: string[],
    private readonly modo: IDBTransactionMode,
  ) {
    super();
    dados.transacoes.push(this);
    Transacao.agendar(dados);
  }

  /**
   * Começa as transações que já podem, como o navegador: a de gravação, quando terminaram todas as criadas antes dela com
   * algum store em comum; a de leitura, quando terminaram as de gravação nessas condições.
   */
  private static agendar(dados: Dados) {
    dados.transacoes.forEach((tx, i) => {
      if (tx.comecou) return;
      const antes = dados.transacoes.slice(0, i).filter((o) => o.nomes.some((n) => tx.nomes.includes(n)));
      if (tx.modo === 'readwrite' ? !antes.length : antes.every((o) => o.modo !== 'readwrite')) tx.comecar();
    });
  }

  private comecar() {
    this.comecou = true;
    for (const n of this.nomes) this.trabalho.set(n, new Map(this.dados.stores.get(n)!.linhas));
    for (const rodar of this.emEspera.splice(0)) depois(rodar);
    depois(() => this.talvezConfirmar());
  }

  objectStore(nome: string) {
    if (this.terminou) throw new DOMException('Transação encerrada', 'InvalidStateError');
    if (!this.nomes.includes(nome)) throw new DOMException(`Store ${nome} fora da transação`, 'NotFoundError');
    return new Loja(this, nome, this.dados.stores.get(nome)!.keyPath);
  }
  /** Recusa o pedido como o navegador: transação encerrada, ou gravação em transação só de leitura. */
  conferir(gravacao: boolean) {
    if (this.terminou) throw new DOMException('Transação encerrada', 'TransactionInactiveError');
    if (gravacao && this.modo !== 'readwrite') throw new DOMException('Transação só de leitura', 'ReadOnlyError');
  }
  pedir(store: string, pedido: Pedido, fn: (linhas: Map<string, Linha>) => unknown): Requisicao {
    this.conferir(pedido.tipo === 'put' || pedido.tipo === 'delete');
    const req = new Requisicao();
    this.abertas.add(req);
    const rodar = () => {
      if (this.terminou) return;
      this.abertas.delete(req);
      req.readyState = 'done';
      let falha: DOMException | null = null;
      if (pedido.tipo === 'put' || pedido.tipo === 'delete') falha = this.fake.aoGravar?.({ banco: this.banco, store, chave: pedido.chave, tipo: pedido.tipo }) ?? this.fake.erroNaGravacao;
      else this.fake.aoLer?.({ banco: this.banco, store, chave: pedido.chave });
      if (falha) {
        req.error = falha;
        // O mesmo evento sobe do pedido para a transação, que ainda não tem erro: o dela é preenchido ao cancelar.
        const e = req.despachar('error');
        this.despachar('error', e);
        if (!e.defaultPrevented) {
          this.cancelar(falha);
          return;
        }
      } else {
        req.result = fn(this.trabalho.get(store)!);
        req.despachar('success');
      }
      depois(() => this.talvezConfirmar());
    };
    if (this.comecou) depois(rodar);
    else this.emEspera.push(rodar);
    return req;
  }
  abort() {
    if (this.terminou) throw new DOMException('A transação já terminou', 'InvalidStateError');
    this.cancelar(null);
  }
  /**
   * Cancela como o navegador: desfaz na hora (a cópia de trabalho é descartada) e libera as transações seguintes, e avisa
   * em tarefas seguintes: primeiro cada pedido ainda não atendido recebe error com AbortError (que sobe para a
   * transação), depois a transação recebe abort.
   */
  private cancelar(erro: DOMException | null) {
    if (this.terminou) return;
    this.encerrar();
    this.error = erro;
    this.emEspera = [];
    for (const req of this.abertas)
      depois(() => {
        req.readyState = 'done';
        req.result = undefined;
        req.error = new DOMException('A transação foi cancelada', 'AbortError');
        this.despachar('error', req.despachar('error'));
      });
    this.abertas.clear();
    depois(() => this.despachar('abort'));
    Transacao.agendar(this.dados);
  }
  private talvezConfirmar() {
    if (this.terminou || !this.comecou || this.abertas.size) return;
    if (this.modo === 'readwrite' && this.fake.cancelarNaConfirmacao) {
      this.cancelar(new DOMException('Cota de armazenamento excedida', 'QuotaExceededError'));
      return;
    }
    this.encerrar();
    if (this.modo === 'readwrite') {
      // Nenhuma outra transação mexeu nestes stores desde que esta começou (agendar): a cópia vira o estado confirmado.
      for (const [n, linhas] of this.trabalho) this.dados.stores.get(n)!.linhas = linhas;
      this.fake.aoConfirmar?.(this.banco);
    }
    this.despachar('complete');
    Transacao.agendar(this.dados);
  }
  private encerrar() {
    this.terminou = true;
    const i = this.dados.transacoes.indexOf(this);
    if (i >= 0) this.dados.transacoes.splice(i, 1);
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
    return new Transacao(this.fake, this.name, this.dados, nomes, modo);
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
  /**
   * Chamada a cada gravação, dentro da transação e antes de aplicá-la (o teste age no meio dela). O erro que ela devolver
   * faz essa gravação falhar, e a transação é cancelada.
   */
  aoGravar: ((g: GravacaoVista) => DOMException | undefined) | null = null;
  /** Chamada a cada leitura, dentro da transação e antes de fazê-la (o teste age entre a leitura e o que vem depois). */
  aoLer: ((l: LeituraVista) => void) | null = null;
  /** Chamada a cada transação de gravação confirmada, com o nome do banco (o teste vê cada estado que o banco guardou). */
  aoConfirmar: ((banco: string) => void) | null = null;

  /** Cria um banco já existente (ex.: o do ACS que o código desta semana subiu para a versão 2). */
  criar(nome: string, versao: number, stores: Record<string, { keyPath: string; linhas?: Linha[] }>) {
    this.bancos.set(nome, {
      versao,
      stores: new Map(Object.entries(stores).map(([n, s]) => [n, { keyPath: s.keyPath, linhas: new Map((s.linhas ?? []).map((l) => [String(l[s.keyPath]), copia(l)])) }])),
      transacoes: [],
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
      const dados: Dados = existente ?? { versao: 0, stores: new Map(), transacoes: [] };
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
