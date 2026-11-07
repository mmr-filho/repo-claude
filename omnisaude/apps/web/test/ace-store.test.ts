import type { OperacaoAce, ResultadoSyncAce } from '@omnisaude/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PacoteCampo } from '@/components/endemias/types';
import type { ImovelOp, VisitaOp } from '@/lib/ace-campo';
import type { ItemFilaAce } from '@/lib/ace-store';
import { FakeIndexedDB } from './fake-indexeddb';

// Banco do aparelho em memória (o IndexedDB de verdade é testado em offline.test.ts) e API simulada.
const sim = vi.hoisted(() => {
  type Store = 'fila' | 'cache';
  const stores: Record<Store, Map<string, unknown>> = { fila: new Map(), cache: new Map() };
  const chave = (store: Store, v: unknown) => String((v as Record<string, unknown>)[store === 'fila' ? 'clientId' : 'key']);
  const copia = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
  const estado = { falhaGravacao: null as Error | null, online: true };
  const gravar = async (gs: { store: Store; put?: unknown; delete?: string }[]) => {
    if (estado.falhaGravacao) throw estado.falhaGravacao;
    for (const g of gs) {
      if (g.delete !== undefined) stores[g.store].delete(g.delete);
      else stores[g.store].set(chave(g.store, g.put), copia(g.put));
    }
  };
  const localAce = {
    get: async (store: Store, key: string) => copia(stores[store].get(key)),
    all: async (store: Store) => [...stores[store].values()].map(copia),
    put: (store: Store, value: unknown) => gravar([{ store, put: value }]),
    delete: (store: Store, key: string) => gravar([{ store, delete: key }]),
    gravar,
  };
  return { stores, estado, localAce, post: vi.fn(), get: vi.fn() };
});

vi.mock('../src/lib/offline', async (original) => ({
  ...(await original<typeof import('../src/lib/offline')>()),
  localAce: sim.localAce,
  estaOnline: () => sim.estado.online,
}));
vi.mock('../src/lib/api', async (original) => ({ ...(await original<typeof import('../src/lib/api')>()), api: { post: sim.post, get: sim.get } }));

const { filaAce, historicoAce, contadorTubito, pacoteAce } = await import('@/lib/ace-store');
const { ApiError } = await import('@/lib/api');
const { ErroAparelho } = await import('@/lib/offline');

const ctxA = { userId: 'u1', unitId: 'un-a' };
const ctxB = { userId: 'u1', unitId: 'un-b' };
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const visita = (clientId: string, extra: Partial<VisitaOp> = {}): VisitaOp => ({
  tipo: 'VISITA_VETORIAL',
  clientId,
  registradoEm: '2026-11-07T12:00:00Z',
  householdId: 'h1',
  visita: { atividade: 'LI_T', situacao: 'TRABALHADO', tratamentos: [{ produtoId: 'bti', loteId: 'l-bti', quantidade: 2, depositos: 1 }], depositos: { A2: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 } } },
  ...extra,
});
const imovel = (clientId: string, blockId = 'q-velho'): ImovelOp => ({
  tipo: 'IMOVEL',
  clientId,
  registradoEm: '2026-11-07T11:00:00Z',
  dados: { blockId, propertyType: '01', street: 'Travessa Nova', number: '7' },
});
const item = (clientId: string) => sim.stores.fila.get(clientId) as ItemFilaAce | undefined;
const resposta = (statusDe: (op: OperacaoAce) => Partial<ResultadoSyncAce> = () => ({})) =>
  vi.fn(async (_path: string, body: { operacoes: OperacaoAce[] }) => ({
    resultados: body.operacoes.map((op) => ({ clientId: op.clientId, tipo: op.tipo, status: 'OK', id: `id-${op.clientId}`, erro: null, ...statusDe(op) })),
  }));
const enviados = () => sim.post.mock.calls.flatMap((c) => (c[1] as { operacoes: OperacaoAce[] }).operacoes.map((o) => o.clientId));

beforeEach(() => {
  sim.stores.fila.clear();
  sim.stores.cache.clear();
  sim.estado.falhaGravacao = null;
  sim.estado.online = true;
  sim.post.mockReset();
  sim.get.mockReset();
});

describe('fila do ACE presa à lotação (seguranca#5, contrato 3)', () => {
  it('grava a unidade da lotação no item e na operação; só envia os desta lotação e os antigos sem unidade', async () => {
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita em A');
    await filaAce.adicionar(visita(UUID(2)), ctxB, 'Visita em B');
    sim.stores.fila.set(UUID(3), { clientId: UUID(3), op: visita(UUID(3)), userId: 'u1', status: 'PENDENTE', erro: null, criadoEm: '2026-11-07T10:00:00Z', rotulo: 'antigo' });
    expect(item(UUID(1))).toMatchObject({ unitId: 'un-a', op: { unitId: 'un-a' } });
    sim.post.mockImplementation(resposta());
    const r = await filaAce.sincronizar(ctxB);
    expect(enviados().sort()).toEqual([UUID(2), UUID(3)]);
    expect((sim.post.mock.calls[0]![1] as { operacoes: OperacaoAce[] }).operacoes.find((o) => o.clientId === UUID(2))!.unitId).toBe('un-b');
    expect(r).toMatchObject({ enviados: 2, pendentes: 2, restantes: 0, falha: null });
    // O de A espera a troca de lotação, sem erro.
    expect(item(UUID(1))).toMatchObject({ status: 'PENDENTE', erro: null });
  });
});

describe('interrupção do envio (web-offline#6) e falha passageira (contrato 3)', () => {
  it.each([
    [new ApiError(503, 'Service Unavailable'), 'servidor'],
    [new ApiError(502, 'Bad Gateway'), 'servidor'],
    [new ApiError(429, 'Muitas requisições'), 'limite'],
    [new ApiError(401, 'Sessão expirada'), 'sessao'],
    [new ApiError(0, 'Sem conexão com o servidor.'), 'rede'],
  ])('%s: devolve o motivo e o item continua pendente', async (erro, motivo) => {
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita');
    sim.post.mockRejectedValue(erro);
    const r = await filaAce.sincronizar(ctxA);
    expect(r).toMatchObject({ falha: motivo, pendentes: 1, restantes: 1, enviados: 0, erros: 0 });
    expect(item(UUID(1))).toMatchObject({ status: 'PENDENTE', erro: null });
  });

  it('sem rede no aparelho: nem tenta, e diz quantos ficaram', async () => {
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita');
    sim.estado.online = false;
    expect(await filaAce.sincronizar(ctxA)).toMatchObject({ falha: 'rede', pendentes: 1, restantes: 1 });
    expect(sim.post).not.toHaveBeenCalled();
  });

  it('fila vazia: nada pendente e sem falha', async () => {
    expect(await filaAce.sincronizar(ctxA)).toMatchObject({ falha: null, pendentes: 0, restantes: 0 });
  });

  it('TENTAR_DE_NOVO mantém pendente com o motivo; ERRO de uma operação não derruba as outras', async () => {
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita 1');
    await filaAce.adicionar(visita(UUID(2)), ctxA, 'Visita 2');
    await filaAce.adicionar(visita(UUID(3)), ctxA, 'Visita 3');
    sim.post.mockImplementation(
      resposta((op) =>
        op.clientId === UUID(1)
          ? { status: 'TENTAR_DE_NOVO', id: null, erro: 'Falha passageira no servidor: o registro continua no aparelho e vai no próximo envio' }
          : op.clientId === UUID(2)
            ? { status: 'ERRO', id: null, erro: 'Dados inválidos: observação — no máximo 1000 caracteres' }
            : {},
      ),
    );
    const r = await filaAce.sincronizar(ctxA);
    expect(r).toMatchObject({ enviados: 1, erros: 1, adiados: 1, restantes: 1, falha: null });
    expect(item(UUID(1))).toMatchObject({ status: 'PENDENTE', adiado: expect.stringContaining('próximo envio') });
    expect(item(UUID(2))).toMatchObject({ status: 'ERRO', erro: 'Dados inválidos: observação — no máximo 1000 caracteres' });
    expect(item(UUID(3))).toBeUndefined();
  });

  it('400 do lote inteiro (web-offline#5): marca só a operação apontada, com a mensagem real, e reenvia as outras', async () => {
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita 1');
    await filaAce.adicionar(visita(UUID(2), { registradoEm: '2026-11-07T12:05:00Z' }), ctxA, 'Visita 2');
    sim.post
      .mockRejectedValueOnce(new ApiError(400, 'Dados inválidos', 'VALIDACAO', [{ path: 'operacoes.1.visita.amostras.0.larvas', message: 'Number must be less than or equal to 999' }]))
      .mockImplementation(resposta());
    const r = await filaAce.sincronizar(ctxA);
    expect(item(UUID(2))).toMatchObject({ status: 'ERRO', erro: 'Dados inválidos: visita.amostras.0.larvas: Number must be less than or equal to 999' });
    expect(item(UUID(1))).toBeUndefined();
    expect(r).toMatchObject({ enviados: 1, erros: 1, falha: null });
    // Sem apontar a operação, todas levam a mensagem real (e não só "Dados inválidos").
    await filaAce.adicionar(visita(UUID(3)), ctxA, 'Visita 3');
    sim.post.mockRejectedValueOnce(new ApiError(400, 'Envie no máximo 100 operações por vez', 'LOTE_GRANDE'));
    await filaAce.sincronizar(ctxA);
    expect(item(UUID(3))).toMatchObject({ status: 'ERRO', erro: 'Envie no máximo 100 operações por vez' });
  });
});

describe('duas sincronizações ao mesmo tempo (corrida do histórico)', () => {
  it('uma espera a outra: nenhuma operação vai duas vezes e o histórico não repete entradas', async () => {
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita 1');
    let liberar!: () => void;
    const segura = new Promise<void>((r) => (liberar = r));
    const responder = resposta();
    sim.post.mockImplementation(async (path: string, body: { operacoes: OperacaoAce[] }) => {
      await segura;
      return responder(path, body);
    });
    const primeira = filaAce.sincronizar(ctxA);
    await new Promise((r) => setTimeout(r, 5));
    // Registrada durante o envio; duas chamadas no meio viram uma rodada só.
    await filaAce.adicionar(visita(UUID(2)), ctxA, 'Visita 2');
    const segunda = filaAce.sincronizar(ctxA);
    const terceira = filaAce.sincronizar(ctxA);
    expect(sim.post).toHaveBeenCalledTimes(1);
    liberar();
    await Promise.all([primeira, segunda, terceira]);
    expect(enviados()).toEqual([UUID(1), UUID(2)]);
    const historico = await historicoAce.listar('u1');
    expect(historico.map((h) => h.clientId)).toEqual([UUID(2), UUID(1)]);
  });

  it('histórico antigo com entradas repetidas é lido sem repetição (keys do React)', async () => {
    sim.stores.cache.set('historico-ace:u1', {
      key: 'historico-ace:u1',
      data: [
        { clientId: 'x', tipo: 'VISITA_VETORIAL', rotulo: 'a', id: '1', em: '2026-11-07T10:00:00Z' },
        { clientId: 'x', tipo: 'VISITA_VETORIAL', rotulo: 'a', id: '1', em: '2026-11-07T10:00:00Z' },
      ],
    });
    expect(await historicoAce.listar('u1')).toHaveLength(1);
  });

  it.each(['ERRO', 'TENTAR_DE_NOVO'] as const)('registro descartado durante o envio não volta para a fila com o resultado %s', async (status) => {
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita');
    let liberar!: () => void;
    const segura = new Promise<void>((r) => (liberar = r));
    const responder = resposta(() => ({ status, id: null, erro: 'recusado' }));
    sim.post.mockImplementation(async (path: string, body: { operacoes: OperacaoAce[] }) => {
      await segura;
      return responder(path, body);
    });
    const envio = filaAce.sincronizar(ctxA);
    await new Promise((r) => setTimeout(r, 5));
    await filaAce.remover(UUID(1));
    liberar();
    await envio;
    expect(item(UUID(1))).toBeUndefined();
  });
});

describe('corrigir registro recusado (web-offline#11, sync-estoque#10)', () => {
  it('imóvel corrigido com outro quarteirão vai com o mesmo clientId; a visita dele volta a pendente e vai junto', async () => {
    await filaAce.adicionar(imovel(UUID(10)), ctxA, 'Imóvel novo · Q 19');
    await filaAce.adicionar(visita(UUID(11), { householdId: null, householdClientId: UUID(10) }), ctxA, 'Visita no imóvel novo');
    sim.post.mockImplementation(
      resposta((op) =>
        op.tipo === 'IMOVEL'
          ? { status: 'ERRO', id: null, erro: 'O quarteirão do imóvel não existe na malha: escolha outro' }
          : { status: 'ERRO', id: null, erro: 'O imóvel desta visita não foi cadastrado (a operação do imóvel deu erro)' },
      ),
    );
    await filaAce.sincronizar(ctxA);
    expect(item(UUID(10))!.status).toBe('ERRO');
    expect(item(UUID(11))!.status).toBe('ERRO');

    await filaAce.corrigir(UUID(10), imovel(UUID(10), 'q-novo'), 'Imóvel novo · Q 20');
    expect(item(UUID(10))).toMatchObject({ status: 'PENDENTE', erro: null, unitId: 'un-a', op: { clientId: UUID(10), unitId: 'un-a', dados: { blockId: 'q-novo' } } });
    sim.post.mockReset();
    sim.post.mockImplementation(resposta());
    const r = await filaAce.sincronizar(ctxA);
    // O imóvel foi aceito; a visita passou a citar o id do servidor e foi enviada na mesma chamada.
    expect(enviados()).toEqual([UUID(10), UUID(11)]);
    const visitaEnviada = (sim.post.mock.calls[1]![1] as { operacoes: VisitaOp[] }).operacoes[0]!;
    expect(visitaEnviada).toMatchObject({ householdId: `id-${UUID(10)}`, householdClientId: null });
    expect(r).toMatchObject({ enviados: 2, restantes: 0 });
    expect(sim.stores.fila.size).toBe(0);
  });

  it('visita recusada no mesmo envio em que o imóvel novo dela foi aceito continua com o erro (o motivo não é a falta do imóvel)', async () => {
    await filaAce.adicionar(imovel(UUID(30)), ctxA, 'Imóvel novo');
    await filaAce.adicionar(visita(UUID(31), { householdId: null, householdClientId: UUID(30) }), ctxA, 'Visita no imóvel novo');
    sim.post.mockImplementation(resposta((op) => (op.tipo === 'VISITA_VETORIAL' ? { status: 'ERRO', id: null, erro: 'Registro com mais de um ano: confira a data do aparelho' } : {})));
    const r = await filaAce.sincronizar(ctxA);
    expect(r).toMatchObject({ enviados: 1, erros: 1 });
    expect(item(UUID(31))).toMatchObject({ status: 'ERRO', erro: 'Registro com mais de um ano: confira a data do aparelho', op: { householdId: `id-${UUID(30)}`, householdClientId: null } });
    expect(enviados()).toEqual([UUID(30), UUID(31)]);
  });

  it('corrigir um registro que já saiu da fila avisa em vez de criar outro', async () => {
    await expect(filaAce.corrigir(UUID(99), visita(UUID(99)), 'x')).rejects.toBeInstanceOf(ErroAparelho);
  });

  it('descartar o imóvel novo leva junto as visitas dele (remoção numa transação)', async () => {
    await filaAce.adicionar(imovel(UUID(20)), ctxA, 'Imóvel');
    await filaAce.adicionar(visita(UUID(21), { householdId: null, householdClientId: UUID(20) }), ctxA, 'Visita');
    await filaAce.remover([UUID(20), UUID(21)]);
    expect(sim.stores.fila.size).toBe(0);
  });
});

describe('gravação no aparelho (web-offline#1, web-offline#12)', () => {
  it('falha ao gravar sobe para a tela; o contador de tubitos só avança junto com a visita', async () => {
    sim.estado.falhaGravacao = new ErroAparelho();
    await expect(filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita', { ultimoTubito: 5 })).rejects.toBeInstanceOf(ErroAparelho);
    sim.estado.falhaGravacao = null;
    expect(sim.stores.fila.size).toBe(0);
    expect(await contadorTubito.ler('u1')).toBe(0);
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita', { ultimoTubito: 1 });
    expect(await contadorTubito.ler('u1')).toBe(1);
    // Visita sem tubito do botão não mexe na posição da sequência.
    await filaAce.adicionar(visita(UUID(2)), ctxA, 'Visita');
    expect(await contadorTubito.ler('u1')).toBe(1);
  });
});

describe('pacote do aparelho depois do envio (web-offline#2, web-offline#10)', () => {
  const pacote = (): PacoteCampo => ({
    ciclo: { ano: 2026, ciclo: 6, chave: '2026-6', inicio: '2026-11-01', fim: '2026-12-31' },
    zonas: [],
    ordens: [],
    quarteiroes: [],
    imoveis: [
      {
        id: 'h1',
        quarteiraoId: 'q1',
        sequencia: '1',
        endereco: 'Rua Exemplo, 100',
        tipo: '01',
        tipoLabel: 'Residência',
        lat: null,
        lng: null,
        posicaoAproximada: true,
        precisaoLabel: 'Sem posição',
        observacao: null,
        noCiclo: null,
      },
    ],
    estoque: [{ produtoId: 'bti', produto: 'Bti', unidade: 'g', tipo: 'LARVICIDA', loteId: 'l-bti', lote: 'BTI2601', validade: '2027-01-31', vencido: false, saldo: 50, deposito: 'Depósito' }],
    servidorEm: '2026-11-07T08:00:00Z',
  });

  it('o aceito é aplicado no pacote guardado: a casa não volta a "sem visita" nem o saldo ignora o uso', async () => {
    sim.stores.cache.set('pacote:ace:un-a:u1', { key: 'pacote:ace:un-a:u1', data: pacote(), savedAt: '2026-11-07T08:00:00Z' });
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita');
    sim.post.mockImplementation(resposta());
    const r = await filaAce.sincronizar(ctxA);
    expect(r.aceitos.map((a) => a.op.clientId)).toEqual([UUID(1)]);
    const guardado = await pacoteAce.guardado(ctxA);
    expect(guardado!.savedAt).toBe('2026-11-07T08:00:00Z');
    expect(guardado!.data.imoveis[0]!.noCiclo).toEqual({ situacao: 'TRABALHADO', em: '2026-11-07T12:00:00Z' });
    expect(guardado!.data.estoque[0]!.saldo).toBe(48);
  });

  it('descartado durante o envio e aceito pelo servidor: o pacote guardado recebe o efeito uma vez (ninguém mais aplicou)', async () => {
    sim.stores.cache.set('pacote:ace:un-a:u1', { key: 'pacote:ace:un-a:u1', data: pacote(), savedAt: '2026-11-07T08:00:00Z' });
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita');
    let liberar!: () => void;
    const segura = new Promise<void>((r) => (liberar = r));
    const responder = resposta();
    sim.post.mockImplementation(async (path: string, body: { operacoes: OperacaoAce[] }) => {
      await segura;
      return responder(path, body);
    });
    const envio = filaAce.sincronizar(ctxA);
    await new Promise((r) => setTimeout(r, 5));
    await filaAce.remover(UUID(1));
    liberar();
    expect(await envio).toMatchObject({ enviados: 1, aceitos: [{ id: `id-${UUID(1)}` }] });
    expect((await pacoteAce.guardado(ctxA))!.data.estoque[0]!.saldo).toBe(48);
    expect(item(UUID(1))).toBeUndefined();
  });

  it('o download do pacote espera o envio em andamento e tem prazo', async () => {
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita');
    let liberar!: () => void;
    const segura = new Promise<void>((r) => (liberar = r));
    const responder = resposta();
    sim.post.mockImplementation(async (path: string, body: { operacoes: OperacaoAce[] }) => {
      await segura;
      return responder(path, body);
    });
    sim.get.mockResolvedValue(pacote());
    const envio = filaAce.sincronizar(ctxA);
    const download = pacoteAce.baixar(ctxA);
    await new Promise((r) => setTimeout(r, 5));
    expect(sim.get).not.toHaveBeenCalled();
    liberar();
    await envio;
    const novo = await download;
    expect(sim.get).toHaveBeenCalledTimes(1);
    expect((sim.get.mock.calls[0]![1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    expect((sim.post.mock.calls[0]![2] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    expect(novo.data.estoque[0]!.saldo).toBe(50);
    expect((await pacoteAce.guardado(ctxA))!.data.servidorEm).toBe('2026-11-07T08:00:00Z');
  });

  describe('duas abas enviando a mesma fila: o larvicida entra uma vez no pacote guardado', () => {
    // Cada aba é uma cópia nova dos módulos (a ordem de envio é por aba) com a sua conexão ao mesmo IndexedDB simulado; o
    // servidor responde OK na primeira vez e DUPLICADA nas seguintes, como a sincronização idempotente.
    const BANCO = 'omnisaude-campo-ace';
    const CHAVE = 'pacote:ace:un-a:u1';
    let fake: FakeIndexedDB;
    const abrirAba = async () => {
      vi.resetModules();
      vi.doMock('../src/lib/offline', async (original) => ({ ...(await original<typeof import('../src/lib/offline')>()), estaOnline: () => true }));
      return import('@/lib/ace-store');
    };
    /** Web Locks do navegador: um pedido por vez para o mesmo nome, em ordem de chegada, valendo para todas as abas. */
    const travasDoNavegador = () => {
      const filas = new Map<string, Promise<unknown>>();
      return {
        pedidos: [] as string[],
        async request<T>(nome: string, fn: () => Promise<T>): Promise<T> {
          this.pedidos.push(nome);
          const antes = filas.get(nome) ?? Promise.resolve();
          let soltar!: () => void;
          filas.set(
            nome,
            antes.then(() => new Promise<void>((r) => (soltar = r))),
          );
          await antes;
          try {
            return await fn();
          } finally {
            soltar();
          }
        },
      };
    };
    const servidor = () => {
      const recebidos = new Set<string>();
      return (body: { operacoes: OperacaoAce[] }) => ({
        resultados: body.operacoes.map((op) => {
          const status = recebidos.has(op.clientId) ? 'DUPLICADA' : 'OK';
          recebidos.add(op.clientId);
          return { clientId: op.clientId, tipo: op.tipo, status, id: `id-${op.clientId}`, erro: null };
        }),
      });
    };
    const saldoGuardado = () => (fake.linhas(BANCO, 'cache').find((l) => l.key === CHAVE) as { data: PacoteCampo } | undefined)?.data.estoque[0]!.saldo;

    beforeEach(() => {
      fake = new FakeIndexedDB();
      vi.stubGlobal('indexedDB', fake);
      const fila: ItemFilaAce = { clientId: UUID(1), op: { ...visita(UUID(1)), unitId: 'un-a' }, userId: 'u1', unitId: 'un-a', status: 'PENDENTE', erro: null, criadoEm: '2026-11-07T12:00:00Z', rotulo: 'Visita' };
      fake.criar(BANCO, 1, { fila: { keyPath: 'clientId', linhas: [fila as never] }, cache: { keyPath: 'key', linhas: [{ key: CHAVE, data: pacote(), savedAt: '2026-11-07T08:00:00Z' }] } });
    });
    afterEach(() => {
      vi.doUnmock('../src/lib/offline');
      vi.unstubAllGlobals();
    });

    it('com a trava entre abas (Web Locks): a segunda aba espera, não reenvia e não aplica de novo', async () => {
      const travas = travasDoNavegador();
      vi.stubGlobal('navigator', { onLine: true, locks: travas });
      const abaA = await abrirAba();
      const abaB = await abrirAba();
      const responder = servidor();
      let liberar!: () => void;
      const segura = new Promise<void>((r) => (liberar = r));
      sim.post.mockImplementation(async (_path: string, body: { operacoes: OperacaoAce[] }) => {
        await segura;
        return responder(body);
      });
      const envioA = abaA.filaAce.sincronizar(ctxA);
      const envioB = abaB.filaAce.sincronizar(ctxA);
      await new Promise((r) => setTimeout(r, 30));
      expect(sim.post).toHaveBeenCalledTimes(1);
      liberar();
      const [rA, rB] = await Promise.all([envioA, envioB]);
      expect(travas.pedidos).toEqual(['omnisaude-campo-ace:envio', 'omnisaude-campo-ace:envio']);
      expect(sim.post).toHaveBeenCalledTimes(1);
      expect(rA).toMatchObject({ enviados: 1, duplicados: 0, restantes: 0 });
      expect(rB).toMatchObject({ enviados: 0, duplicados: 0, pendentes: 0, aceitos: [] });
      expect(saldoGuardado()).toBe(48);
      expect(fake.linhas(BANCO, 'fila')).toEqual([]);
      expect(fake.conexoes).toHaveLength(2);
    });

    it('sem a API de travas: OK numa aba e DUPLICADA na outra aplicam o larvicida uma vez só', async () => {
      vi.stubGlobal('navigator', { onLine: true });
      const abaA = await abrirAba();
      const abaB = await abrirAba();
      const responder = servidor();
      let primeiraTerminou: Promise<unknown> = Promise.resolve();
      sim.post.mockImplementation(async (_path: string, body: { operacoes: OperacaoAce[] }) => {
        // A resposta da segunda aba chega depois que a primeira gravou tudo (tirou o item da fila e aplicou no pacote).
        if (sim.post.mock.calls.length > 1) await primeiraTerminou;
        return responder(body);
      });
      const envioA = abaA.filaAce.sincronizar(ctxA);
      const envioB = abaB.filaAce.sincronizar(ctxA);
      primeiraTerminou = Promise.race([envioA, envioB]);
      const resumos = await Promise.all([envioA, envioB]);
      expect(sim.post).toHaveBeenCalledTimes(2);
      expect(resumos.map((r) => [r.enviados, r.duplicados]).sort()).toEqual([
        [0, 1],
        [1, 0],
      ]);
      // A tela de cada aba aplica o aceito no pacote que tem em memória; o guardado recebe uma vez.
      expect(resumos.every((r) => r.aceitos.length === 1)).toBe(true);
      expect(saldoGuardado()).toBe(48);
      expect(fake.linhas(BANCO, 'fila')).toEqual([]);
      expect((await abaA.historicoAce.listar('u1')).map((h) => h.clientId)).toEqual([UUID(1)]);
      // Uma conexão por aba com o mesmo banco.
      expect(fake.conexoes).toHaveLength(2);
    });
  });
});
