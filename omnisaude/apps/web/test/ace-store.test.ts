import type { OperacaoAce, ResultadoSyncAce } from '@omnisaude/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PacoteCampo } from '@/components/endemias/types';
import type { ImovelOp, VisitaOp } from '@/lib/ace-campo';
import type { ItemFilaAce, ResumoSyncAce } from '@/lib/ace-store';
import { FakeIndexedDB, type LeituraVista } from './fake-indexeddb';

// Banco do aparelho em memória (o IndexedDB de verdade é testado em offline.test.ts) e API simulada.
const sim = vi.hoisted(() => {
  type Store = 'fila' | 'cache';
  const stores: Record<Store, Map<string, unknown>> = { fila: new Map(), cache: new Map() };
  const chave = (store: Store, v: unknown) => String((v as Record<string, unknown>)[store === 'fila' ? 'clientId' : 'key']);
  const copia = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
  const estado = { falhaGravacao: null as Error | null, online: true };
  type Gravacao = { store: Store; put?: unknown; delete?: string };
  const gravar = async (gs: Gravacao[]) => {
    if (estado.falhaGravacao) throw estado.falhaGravacao;
    for (const g of gs) {
      if (g.delete !== undefined) stores[g.store].delete(g.delete);
      else stores[g.store].set(chave(g.store, g.put), copia(g.put));
    }
  };
  // Ler e gravar numa transação só: aqui nada roda entre a leitura e a gravação.
  const atualizar = async (store: Store, key: string, fn: (atual: unknown) => unknown) => {
    if (estado.falhaGravacao) throw estado.falhaGravacao;
    const novo = fn(copia(stores[store].get(key)));
    if (novo !== undefined) await gravar([{ store, put: novo }]);
    return copia(novo);
  };
  const atualizarVarios = async (leituras: Partial<Record<Store, string[] | 'todas'>>, fn: (lidos: Record<Store, Map<string, unknown>>) => Gravacao[]) => {
    if (estado.falhaGravacao) throw estado.falhaGravacao;
    const lidos: Record<Store, Map<string, unknown>> = { fila: new Map(), cache: new Map() };
    for (const [store, chaves] of Object.entries(leituras) as [Store, string[] | 'todas'][])
      for (const k of chaves === 'todas' ? [...stores[store].keys()] : chaves) if (stores[store].has(k)) lidos[store].set(k, copia(stores[store].get(k)));
    const gs = fn(lidos);
    await gravar(gs);
    return gs;
  };
  const localAce = {
    get: async (store: Store, key: string) => copia(stores[store].get(key)),
    all: async (store: Store) => [...stores[store].values()].map(copia),
    put: (store: Store, value: unknown) => gravar([{ store, put: value }]),
    delete: (store: Store, key: string) => gravar([{ store, delete: key }]),
    gravar,
    atualizar,
    atualizarVarios,
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
    // O descartado não conta como erro nem como adiado: o aviso não manda procurar na fila o que não está mais lá.
    expect(await envio).toMatchObject({ erros: 0, adiados: 0, falha: null });
    expect(item(UUID(1))).toBeUndefined();
  });
});

describe('corrigir registro recusado (web-offline#11, sync-estoque#10)', () => {
  it('imóvel corrigido com outro quarteirão vai com o mesmo clientId; a visita dele volta a pendente e vai junto', async () => {
    await filaAce.adicionar(imovel(UUID(10)), ctxA, 'Imóvel novo · Q 19');
    await filaAce.adicionar(visita(UUID(11), { householdId: null, householdClientId: UUID(10) }), ctxA, 'Visita no imóvel novo');
    // O imóvel vai no mesmo envio que a visita e é recusado: para a visita, o servidor responde com o texto do imóvel que
    // deu erro neste envio (campo.service.ts, aplicarVisita). O do imóvel fora do envio, ainda não aceito, é outro.
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
    await expect(filaAce.corrigir(UUID(99), visita(UUID(99)), 'x', { ultimoTubito: 3 })).rejects.toBeInstanceOf(ErroAparelho);
    // Nada foi gravado: nem o registro, nem a posição dos tubitos.
    expect(sim.stores.fila.size).toBe(0);
    expect(await contadorTubito.ler('u1')).toBe(0);
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

/** Pacote baixado: um imóvel sem visita no ciclo e um lote de Bti com 50 g. */
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

describe('pacote do aparelho depois do envio (web-offline#2, web-offline#10)', () => {
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

  it('a visita entra no pacote guardado na ordem em que o servidor a gravou (OK e DUPLICADA), não na mais recente do quarteirão', async () => {
    const ordem = (id: string, numero: string, abertaEm: string): PacoteCampo['ordens'][number] => ({
      id,
      numero,
      status: 'EM_CAMPO',
      abertaEm,
      raioM: 150,
      conferirImovel: false,
      quarteiroes: [{ id: 'q1', ocorrencia: true }],
      visitados: {},
    });
    const base = pacote();
    const comOrdens: PacoteCampo = {
      ...base,
      ordens: [ordem('o-antiga', '1/2026', '2026-11-01T10:00:00Z'), ordem('o-nova', '2/2026', '2026-11-05T10:00:00Z')],
      imoveis: [...base.imoveis, { ...base.imoveis[0]!, id: 'h2', sequencia: '2', endereco: 'Rua Exemplo, 102' }],
    };
    sim.stores.cache.set('pacote:ace:un-a:u1', { key: 'pacote:ace:un-a:u1', data: comOrdens, savedAt: '2026-11-07T08:00:00Z' });
    // Sem rede, o ACE fez em 3/11 visitas de bloqueio sem ordem; o pacote, baixado depois, já traz a o-nova (aberta em 5/11).
    const bloqueio = (n: number, householdId: string) => visita(UUID(n), { householdId, registradoEm: '2026-11-03T12:00:00Z', visita: { atividade: 'BLOQUEIO', situacao: 'TRABALHADO' } });
    await filaAce.adicionar(bloqueio(1, 'h1'), ctxA, 'Visita 1');
    await filaAce.adicionar(bloqueio(2, 'h2'), ctxA, 'Visita 2');
    // O servidor gravou a primeira na o-antiga; a segunda já estava gravada (resposta perdida), sem ordem.
    sim.post.mockImplementation(resposta((op) => (op.clientId === UUID(1) ? { ordemId: 'o-antiga' } : { status: 'DUPLICADA', ordemId: null })));
    const r = await filaAce.sincronizar(ctxA);
    expect(r).toMatchObject({ enviados: 1, duplicados: 1 });
    expect(r.aceitos.map((a) => [a.op.clientId, a.ordemId])).toEqual([
      [UUID(1), 'o-antiga'],
      [UUID(2), null],
    ]);
    const ordens = (await pacoteAce.guardado(ctxA))!.data.ordens;
    expect(ordens.find((o) => o.id === 'o-antiga')!.visitados).toEqual({ h1: { situacao: 'TRABALHADO', em: '2026-11-03T12:00:00Z' } });
    expect(ordens.find((o) => o.id === 'o-nova')!.visitados).toEqual({});
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

describe('outra aba no meio de ler e regravar a fila ou o pacote: tudo numa transação só', () => {
  // Cada aba é uma cópia nova dos módulos com a sua conexão ao mesmo IndexedDB simulado, sem a trava entre abas. A outra
  // aba age assim que esta lê o que vai regravar. Antes, ler e gravar eram transações separadas: a gravação desfazia o
  // descarte feito no meio, e o pacote antigo sobrescrevia o baixado no meio.
  const BANCO = 'omnisaude-campo-ace';
  const CHAVE = 'pacote:ace:un-a:u1';
  let fake: FakeIndexedDB;
  const abrirAba = async () => {
    vi.resetModules();
    vi.doMock('../src/lib/offline', async (original) => ({ ...(await original<typeof import('../src/lib/offline')>()), estaOnline: () => true }));
    const ace = await import('@/lib/ace-store');
    // O ApiError desta aba (cada cópia dos módulos tem a sua classe).
    const { ApiError: ApiErrorDaAba } = await import('@/lib/api');
    return { ...ace, ApiErrorDaAba };
  };
  type Aba = Awaited<ReturnType<typeof abrirAba>>;
  /** A outra aba, com a conexão já aberta: na primeira leitura desta que `quando` aceitar, faz `agir` (uma vez). */
  const outraAbaNoMeio = async (quando: (l: LeituraVista) => boolean, agir: (outra: Aba) => Promise<unknown>) => {
    const outra = await abrirAba();
    await outra.filaAce.listar('u1');
    const meio = { acao: null as Promise<unknown> | null };
    const armar = () => {
      fake.aoLer = (l) => {
        if (l.banco === BANCO && !meio.acao && quando(l)) meio.acao = agir(outra);
      };
    };
    return { meio, armar };
  };
  const naFila = () => fake.linhas(BANCO, 'fila') as unknown as ItemFilaAce[];
  const naFilaDoApp = (n: number, extra: Partial<ItemFilaAce> = {}): ItemFilaAce => ({
    clientId: UUID(n),
    op: { ...visita(UUID(n)), unitId: 'un-a' },
    userId: 'u1',
    unitId: 'un-a',
    status: 'PENDENTE',
    erro: null,
    criadoEm: `2026-11-07T12:00:0${n}Z`,
    rotulo: `Visita ${n}`,
    ...extra,
  });
  const criarBanco = (fila: ItemFilaAce[]) =>
    fake.criar(BANCO, 1, { fila: { keyPath: 'clientId', linhas: fila as never[] }, cache: { keyPath: 'key', linhas: [{ key: CHAVE, data: pacote(), savedAt: '2026-11-07T08:00:00Z' }] } });

  beforeEach(() => {
    fake = new FakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => {
    vi.doUnmock('../src/lib/offline');
    vi.unstubAllGlobals();
  });

  it.each<[string, (aba: Aba) => Promise<unknown>, number]>([
    ['tentar de novo', (aba) => aba.filaAce.tentarDeNovo(UUID(1)), 0],
    // A correção foi gravada antes do descarte, e a posição dos tubitos foi junto com ela.
    ['corrigir', (aba) => aba.filaAce.corrigir(UUID(1), visita(UUID(1), { registradoEm: '2026-11-07T12:30:00Z' }), 'Visita corrigida', { ultimoTubito: 7 }), 7],
  ])('%s com o descarte noutra aba entre a leitura e a gravação: o descartado não volta para a fila', async (_caso, regravar, tubito) => {
    criarBanco([naFilaDoApp(1, { status: 'ERRO', erro: 'Recusado' })]);
    const aba = await abrirAba();
    const { meio, armar } = await outraAbaNoMeio(
      (l) => l.store === 'fila' && l.chave === UUID(1),
      (outra) => outra.filaAce.remover(UUID(1)),
    );
    armar();
    await regravar(aba);
    expect(meio.acao).not.toBeNull();
    await meio.acao;
    expect(naFila()).toEqual([]);
    expect(await aba.contadorTubito.ler('u1')).toBe(tubito);
  });

  it.each<[string, (aba: Aba, body: { operacoes: OperacaoAce[] }) => unknown, Partial<ItemFilaAce>]>([
    ['o resultado ERRO', (_aba, body) => resposta(() => ({ status: 'ERRO', id: null, erro: 'Recusado' }))('', body), { status: 'ERRO', erro: 'Recusado' }],
    ['o resultado TENTAR_DE_NOVO', (_aba, body) => resposta(() => ({ status: 'TENTAR_DE_NOVO', id: null, erro: 'Falha passageira' }))('', body), { status: 'PENDENTE', adiado: 'Falha passageira' }],
    [
      'o lote recusado inteiro',
      (aba) => {
        throw new aba.ApiErrorDaAba(400, 'Envie no máximo 100 operações por vez', 'LOTE_GRANDE');
      },
      { status: 'ERRO', erro: 'Envie no máximo 100 operações por vez' },
    ],
  ])('descarte noutra aba entre a leitura da fila e a gravação de %s: não é desfeito, e o outro item fica com o resultado', async (_caso, responder, comoFica) => {
    criarBanco([naFilaDoApp(1), naFilaDoApp(2)]);
    const aba = await abrirAba();
    const { meio, armar } = await outraAbaNoMeio(
      (l) => l.store === 'fila' && (l.chave === null || l.chave === UUID(1)),
      (outra) => outra.filaAce.remover(UUID(1)),
    );
    sim.post.mockImplementation(async (_path: string, body: { operacoes: OperacaoAce[] }) => {
      // A resposta chegou: a primeira leitura da fila para gravar o resultado dispara o descarte da outra aba.
      armar();
      return responder(aba, body);
    });
    expect(await aba.filaAce.sincronizar(ctxA)).toMatchObject({ falha: null, pendentes: 2, enviados: 0 });
    expect(sim.post).toHaveBeenCalledTimes(1);
    expect(meio.acao).not.toBeNull();
    await meio.acao;
    expect(naFila()).toEqual([{ ...naFilaDoApp(2), adiado: null, ...comoFica }]);
  });

  it('pacote baixado noutra aba entre a leitura e a gravação do pacote guardado: o mais novo fica', async () => {
    criarBanco([naFilaDoApp(1)]);
    const aba = await abrirAba();
    // A outra aba baixa o pacote depois que o servidor gravou a visita: ele já traz o efeito dela.
    const novo: PacoteCampo = { ...pacote(), servidorEm: '2026-11-07T12:10:00Z', estoque: pacote().estoque.map((l) => ({ ...l, saldo: 48 })) };
    sim.get.mockResolvedValue(novo);
    sim.post.mockImplementation(resposta());
    const { meio, armar } = await outraAbaNoMeio(
      (l) => l.store === 'cache' && l.chave === CHAVE,
      (outra) => outra.pacoteAce.baixar(ctxA),
    );
    armar();
    expect(await aba.filaAce.sincronizar(ctxA)).toMatchObject({ enviados: 1, falha: null, aceitos: [{ id: `id-${UUID(1)}` }] });
    expect(meio.acao).not.toBeNull();
    await meio.acao;
    const guardado = fake.linhas(BANCO, 'cache').find((l) => l.key === CHAVE) as { data: PacoteCampo; savedAt: string };
    expect(guardado.data.servidorEm).toBe('2026-11-07T12:10:00Z');
    expect(guardado.savedAt).not.toBe('2026-11-07T08:00:00Z');
    expect(guardado.data.estoque[0]!.saldo).toBe(48);
    expect(naFila()).toEqual([]);
  });

  it('visita que citava o imóvel novo, descartada noutra aba entre a leitura e a gravação do resultado: não volta a pendente nem é enviada', async () => {
    const imovelNovo: ItemFilaAce = { ...naFilaDoApp(5), op: { ...imovel(UUID(5), 'q1'), unitId: 'un-a' }, rotulo: 'Imóvel novo' };
    // Recusada antes por falta do imóvel: com ele aceito, voltaria a pendente com o id do servidor e iria na rodada seguinte.
    const visitaDele = naFilaDoApp(6, { op: { ...visita(UUID(6), { householdId: null, householdClientId: UUID(5) }), unitId: 'un-a' }, status: 'ERRO', erro: 'O imóvel desta visita não foi cadastrado' });
    criarBanco([imovelNovo, visitaDele]);
    const aba = await abrirAba();
    const { meio, armar } = await outraAbaNoMeio(
      (l) => l.store === 'fila' && l.chave === null,
      (outra) => outra.filaAce.remover(UUID(6)),
    );
    const responder = resposta();
    sim.post.mockImplementation(async (path: string, body: { operacoes: OperacaoAce[] }) => {
      armar();
      return responder(path, body);
    });
    expect(await aba.filaAce.sincronizar(ctxA)).toMatchObject({ enviados: 1, falha: null });
    expect(meio.acao).not.toBeNull();
    await meio.acao;
    expect(enviados()).toEqual([UUID(5)]);
    expect(naFila()).toEqual([]);
  });

  it('sem trava, a resposta da outra aba (DUPLICADA) chega enquanto esta grava a sua (OK): o pacote guardado recebe o larvicida uma vez', async () => {
    criarBanco([naFilaDoApp(1)]);
    const abaA = await abrirAba();
    const abaB = await abrirAba();
    const recebidos = new Set<string>();
    const servidor = (body: { operacoes: OperacaoAce[] }) => ({
      resultados: body.operacoes.map((op) => {
        const status = recebidos.has(op.clientId) ? 'DUPLICADA' : 'OK';
        recebidos.add(op.clientId);
        return { clientId: op.clientId, tipo: op.tipo, status, id: `id-${op.clientId}`, erro: null };
      }),
    });
    // As duas abas chegam ao envio; sai a primeira resposta, e a leitura da fila para gravá-la solta a segunda.
    let soltarPrimeira!: () => void;
    const primeira = new Promise<void>((r) => (soltarPrimeira = r));
    let soltarSegunda!: () => void;
    const segunda = new Promise<void>((r) => (soltarSegunda = r));
    sim.post.mockImplementation(async (_path: string, body: { operacoes: OperacaoAce[] }) => {
      if (sim.post.mock.calls.length === 1) {
        await primeira;
        fake.aoLer = (l) => {
          if (l.banco !== BANCO || l.store !== 'fila' || l.chave !== null) return;
          fake.aoLer = null;
          soltarSegunda();
        };
        return servidor(body);
      }
      soltarPrimeira();
      await segunda;
      return servidor(body);
    });
    // Antes, as duas liam a fila com o item e as duas aplicavam (a segunda gravação, sobre o pacote lido antes da primeira).
    const gravacoesDoPacote: string[] = [];
    fake.aoGravar = (g) => {
      if (g.store === 'cache' && g.chave === CHAVE) gravacoesDoPacote.push(g.tipo);
      return undefined;
    };
    const resumos = await Promise.all([abaA.filaAce.sincronizar(ctxA), abaB.filaAce.sincronizar(ctxA)]);
    expect(resumos.map((r) => [r.enviados, r.duplicados, r.falha]).sort()).toEqual([
      [0, 1, null],
      [1, 0, null],
    ]);
    expect(gravacoesDoPacote).toEqual(['put']);
    expect((fake.linhas(BANCO, 'cache').find((l) => l.key === CHAVE) as { data: PacoteCampo }).data.estoque[0]!.saldo).toBe(48);
    expect(naFila()).toEqual([]);
    expect((await abaA.historicoAce.listar('u1')).map((h) => h.clientId)).toEqual([UUID(1)]);
  });
});

describe('correção salva durante o envio da versão anterior do mesmo registro', () => {
  // O agente corrige um registro recusado enquanto o envio da versão anterior dele está em curso, nesta aba ou noutra.
  // Antes, o resultado da versão anterior valia para a correção: com OK (ou DUPLICADA) ela saía da fila sem ir ao
  // servidor, sem aviso; com ERRO (ou TENTAR_DE_NOVO, ou o lote recusado) ficava com o erro da versão anterior.
  const VERSAO_ANTERIOR = 'O servidor gravou a versão anterior deste registro enquanto você corrigia: a correção não foi enviada. Confira e descarte o registro.';
  const CHAVE = 'pacote:ace:un-a:u1';
  type Corpo = { operacoes: OperacaoAce[] };
  /** A correção muda a hora e o larvicida (3 g em vez de 2 g): o pacote mostra de qual versão é o efeito. */
  const corrigida = (clientId: string, registradoEm = '2026-11-07T12:30:00Z'): VisitaOp =>
    visita(clientId, { registradoEm, visita: { atividade: 'LI_T', situacao: 'TRABALHADO', tratamentos: [{ produtoId: 'bti', loteId: 'l-bti', quantidade: 3, depositos: 1 }] } });
  /** Começa o envio com o POST de número `n` preso até `soltar` (os outros respondem na hora) e espera esse POST sair. */
  const enviarPreso = async (enviar: () => Promise<ResumoSyncAce>, responder: (body: Corpo) => unknown, n = 1) => {
    let soltar!: () => void;
    const segura = new Promise<void>((r) => (soltar = r));
    sim.post.mockImplementation(async (_path: string, body: Corpo) => {
      if (sim.post.mock.calls.length === n) await segura;
      return responder(body);
    });
    const envio = enviar();
    await vi.waitFor(() => expect(sim.post).toHaveBeenCalledTimes(n), { timeout: 5000 });
    return { envio, soltar };
  };
  const comStatus =
    (status: ResultadoSyncAce['status'], erro = 'Recusado (versão anterior)') =>
    (body: Corpo) =>
      resposta(() => (status === 'OK' || status === 'DUPLICADA' ? { status } : { status, id: null, erro }))('', body);
  const guardarPacote = () => sim.stores.cache.set(CHAVE, { key: CHAVE, data: pacote(), savedAt: '2026-11-07T08:00:00Z' });
  const saldoGuardado = async () => (await pacoteAce.guardado(ctxA))!.data.estoque[0]!.saldo;
  const rotulosNoHistorico = async () => (await historicoAce.listar('u1')).map((h) => h.rotulo);

  it.each(['OK', 'DUPLICADA'] as const)('nesta aba, %s da versão enviada: ela fica no histórico e no pacote; a correção fica na fila com o erro, e reenviá-la não grava nada', async (status) => {
    guardarPacote();
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita');
    const { envio, soltar } = await enviarPreso(() => filaAce.sincronizar(ctxA), comStatus(status));
    await filaAce.corrigir(UUID(1), corrigida(UUID(1)), 'Visita corrigida');
    soltar();
    const r = await envio;
    // Conta em erros (o aviso manda à aba Fila); enviados e duplicados contam a versão enviada.
    expect(r).toMatchObject({ enviados: status === 'OK' ? 1 : 0, duplicados: status === 'DUPLICADA' ? 1 : 0, erros: 1, adiados: 0, pendentes: 1, restantes: 0, falha: null });
    expect(r.aceitos.map((a) => a.op.registradoEm)).toEqual(['2026-11-07T12:00:00Z']);
    expect(item(UUID(1))).toMatchObject({ status: 'ERRO', erro: VERSAO_ANTERIOR, rotulo: 'Visita corrigida', versao: 1, versaoGravada: 0, op: { registradoEm: '2026-11-07T12:30:00Z' } });
    expect(await rotulosNoHistorico()).toEqual(['Visita']);
    expect(await saldoGuardado()).toBe(48);

    // O servidor ficou com a versão anterior e responde DUPLICADA a este clientId: o reenvio (tentar de novo, ou outra
    // correção) não tira o registro da fila nem repete o efeito no histórico e no pacote.
    sim.post.mockReset();
    sim.post.mockImplementation(resposta(() => ({ status: 'DUPLICADA' })));
    await filaAce.tentarDeNovo(UUID(1));
    expect(await filaAce.sincronizar(ctxA)).toMatchObject({ enviados: 0, duplicados: 0, erros: 1, aceitos: [] });
    expect(item(UUID(1))).toMatchObject({ status: 'ERRO', erro: VERSAO_ANTERIOR, versao: 1, versaoGravada: 0 });
    await filaAce.corrigir(UUID(1), corrigida(UUID(1), '2026-11-07T12:45:00Z'), 'Visita corrigida de novo');
    expect(await filaAce.sincronizar(ctxA)).toMatchObject({ enviados: 0, duplicados: 0, erros: 1, aceitos: [] });
    expect(item(UUID(1))).toMatchObject({ status: 'ERRO', erro: VERSAO_ANTERIOR, rotulo: 'Visita corrigida de novo', versao: 2, versaoGravada: 0 });
    expect(enviados()).toEqual([UUID(1), UUID(1)]);
    expect(await rotulosNoHistorico()).toEqual(['Visita']);
    expect(await saldoGuardado()).toBe(48);
  });

  it.each<[string, (body: Corpo) => unknown]>([
    ['ERRO', comStatus('ERRO')],
    ['TENTAR_DE_NOVO', comStatus('TENTAR_DE_NOVO', 'Falha passageira')],
    [
      'o lote recusado inteiro',
      () => {
        throw new ApiError(400, 'Dados inválidos', 'VALIDACAO', [{ path: 'operacoes.0.visita.observacao', message: 'No máximo 1000 caracteres' }]);
      },
    ],
  ])('nesta aba, %s da versão enviada: a correção não leva o erro nem o adiamento dela e vai no próximo envio', async (_caso, responder) => {
    guardarPacote();
    await filaAce.adicionar(visita(UUID(1)), ctxA, 'Visita');
    const { envio, soltar } = await enviarPreso(() => filaAce.sincronizar(ctxA), responder);
    await filaAce.corrigir(UUID(1), corrigida(UUID(1)), 'Visita corrigida');
    soltar();
    expect(await envio).toMatchObject({ enviados: 0, erros: 0, adiados: 0, pendentes: 1, restantes: 1, falha: null });
    expect(item(UUID(1))).toMatchObject({ status: 'PENDENTE', erro: null, adiado: null, rotulo: 'Visita corrigida', versao: 1 });
    sim.post.mockReset();
    sim.post.mockImplementation(resposta());
    expect(await filaAce.sincronizar(ctxA)).toMatchObject({ enviados: 1, erros: 0, restantes: 0 });
    expect((sim.post.mock.calls[0]![1] as { operacoes: VisitaOp[] }).operacoes.map((o) => o.registradoEm)).toEqual(['2026-11-07T12:30:00Z']);
    expect(item(UUID(1))).toBeUndefined();
    // Só a correção foi gravada: o pacote recebe os 3 g dela.
    expect(await rotulosNoHistorico()).toEqual(['Visita corrigida']);
    expect(await saldoGuardado()).toBe(47);
  });

  it.each<['OK' | 'ERRO', Partial<ResumoSyncAce>, Partial<ItemFilaAce>]>([
    ['OK', { enviados: 2, erros: 1, restantes: 0 }, { status: 'ERRO', erro: VERSAO_ANTERIOR, versaoGravada: 0 }],
    ['ERRO', { enviados: 1, erros: 0, restantes: 1 }, { status: 'PENDENTE', erro: null }],
  ])('o caso relatado: a visita recusada por falta do imóvel novo vai na 2ª rodada e é corrigida durante o POST dela (%s)', async (status, resumo, comoFica) => {
    await filaAce.adicionar(imovel(UUID(10)), ctxA, 'Imóvel novo · Q 19');
    await filaAce.adicionar(visita(UUID(11), { householdId: null, householdClientId: UUID(10) }), ctxA, 'Visita no imóvel novo');
    sim.post.mockImplementation(
      resposta((op) => ({
        status: 'ERRO',
        id: null,
        erro: op.tipo === 'IMOVEL' ? 'O quarteirão do imóvel não existe na malha: escolha outro' : 'O imóvel desta visita não foi cadastrado (a operação do imóvel deu erro)',
      })),
    );
    await filaAce.sincronizar(ctxA);
    // O agente abre a correção da visita (o formulário guarda a operação de agora) e corrige o imóvel; o envio automático
    // aceita o imóvel na 1ª rodada e leva a visita, regravada com o id do servidor, na 2ª.
    const formulario = item(UUID(11))!.op as VisitaOp;
    await filaAce.corrigir(UUID(10), imovel(UUID(10), 'q-novo'), 'Imóvel novo · Q 20');
    sim.post.mockReset();
    const { envio, soltar } = await enviarPreso(
      () => filaAce.sincronizar(ctxA),
      (body) => resposta((op) => (op.tipo === 'IMOVEL' || status === 'OK' ? {} : { status: 'ERRO', id: null, erro: 'Recusado (versão anterior)' }))('', body),
      2,
    );
    expect((sim.post.mock.calls[1]![1] as { operacoes: VisitaOp[] }).operacoes).toMatchObject([{ clientId: UUID(11), householdId: `id-${UUID(10)}` }]);
    // Durante o POST da visita, o agente salva a correção dela.
    await filaAce.corrigir(UUID(11), { ...formulario, registradoEm: '2026-11-07T12:30:00Z' }, 'Visita corrigida');
    soltar();
    expect(await envio).toMatchObject({ duplicados: 0, adiados: 0, falha: null, ...resumo });
    expect(item(UUID(10))).toBeUndefined();
    expect(item(UUID(11))).toMatchObject({ rotulo: 'Visita corrigida', versao: 1, op: { registradoEm: '2026-11-07T12:30:00Z' }, ...comoFica });
  });

  it('imóvel novo corrigido durante o envio, OK da versão anterior: o servidor ficou com ela (e com a visita dele); a correção fica com o erro', async () => {
    await filaAce.adicionar(imovel(UUID(10)), ctxA, 'Imóvel novo · Q 19');
    await filaAce.adicionar(visita(UUID(11), { householdId: null, householdClientId: UUID(10) }), ctxA, 'Visita no imóvel novo');
    const { envio, soltar } = await enviarPreso(() => filaAce.sincronizar(ctxA), comStatus('OK'));
    await filaAce.corrigir(UUID(10), imovel(UUID(10), 'q-novo'), 'Imóvel novo · Q 20');
    soltar();
    const r = await envio;
    expect(r).toMatchObject({ enviados: 2, erros: 1, restantes: 0, falha: null });
    expect(r.aceitos.map((a) => (a.op.tipo === 'IMOVEL' ? a.op.dados.blockId : a.op.clientId))).toEqual(['q-velho', UUID(11)]);
    expect(item(UUID(10))).toMatchObject({ status: 'ERRO', erro: VERSAO_ANTERIOR, rotulo: 'Imóvel novo · Q 20', versao: 1, versaoGravada: 0, op: { dados: { blockId: 'q-novo' } } });
    expect(item(UUID(11))).toBeUndefined();
    expect((await historicoAce.listar('u1')).map((h) => h.rotulo)).toEqual(['Visita no imóvel novo', 'Imóvel novo · Q 19']);
  });

  it('imóvel novo corrigido durante o envio, ERRO da versão anterior: a correção continua pendente e, aceita, leva junto a visita recusada por falta dele', async () => {
    await filaAce.adicionar(imovel(UUID(10)), ctxA, 'Imóvel novo · Q 19');
    await filaAce.adicionar(visita(UUID(11), { householdId: null, householdClientId: UUID(10) }), ctxA, 'Visita no imóvel novo');
    const faltaDoImovel = 'O imóvel desta visita não foi cadastrado (a operação do imóvel deu erro)';
    const { envio, soltar } = await enviarPreso(
      () => filaAce.sincronizar(ctxA),
      (body) => resposta((op) => ({ status: 'ERRO', id: null, erro: op.tipo === 'IMOVEL' ? 'O quarteirão do imóvel não existe na malha: escolha outro' : faltaDoImovel }))('', body),
    );
    await filaAce.corrigir(UUID(10), imovel(UUID(10), 'q-novo'), 'Imóvel novo · Q 20');
    soltar();
    expect(await envio).toMatchObject({ enviados: 0, erros: 1, restantes: 1, falha: null });
    expect(item(UUID(10))).toMatchObject({ status: 'PENDENTE', erro: null, versao: 1, op: { dados: { blockId: 'q-novo' } } });
    expect(item(UUID(11))).toMatchObject({ status: 'ERRO', erro: faltaDoImovel });
    sim.post.mockReset();
    sim.post.mockImplementation(resposta());
    expect(await filaAce.sincronizar(ctxA)).toMatchObject({ enviados: 2, erros: 0, restantes: 0 });
    expect(enviados()).toEqual([UUID(10), UUID(11)]);
    expect((sim.post.mock.calls[0]![1] as { operacoes: ImovelOp[] }).operacoes[0]!.dados.blockId).toBe('q-novo');
    expect(sim.stores.fila.size).toBe(0);
  });

  it('a regravação do householdId pelo imóvel novo aceito no lote anterior não é correção: o resultado da visita em envio vale para ela', async () => {
    await filaAce.adicionar(imovel(UUID(500)), ctxA, 'Imóvel novo');
    for (let n = 1; n <= 99; n++) await filaAce.adicionar(visita(UUID(n)), ctxA, `Visita ${n}`);
    // A visita do imóvel novo é a mais recente: vai no 2º lote da rodada, lida antes de o 1º lote aceitar o imóvel.
    await filaAce.adicionar(visita(UUID(600), { householdId: null, householdClientId: UUID(500), registradoEm: '2026-11-07T13:00:00Z' }), ctxA, 'Visita no imóvel novo');
    const responder = resposta();
    let naFilaDuranteOEnvio: OperacaoAce | undefined;
    sim.post.mockImplementation(async (path: string, body: Corpo) => {
      if (sim.post.mock.calls.length === 2) naFilaDuranteOEnvio = item(UUID(600))?.op;
      return responder(path, body);
    });
    const r = await filaAce.sincronizar(ctxA);
    // O 2º lote levou a visita como foi lida; na fila, o 1º já a tinha regravado com o id do servidor.
    expect((sim.post.mock.calls[1]![1] as { operacoes: VisitaOp[] }).operacoes.map((o) => [o.clientId, o.householdClientId])).toEqual([[UUID(600), UUID(500)]]);
    expect(naFilaDuranteOEnvio).toMatchObject({ householdId: `id-${UUID(500)}`, householdClientId: null });
    expect(r).toMatchObject({ enviados: 101, erros: 0, restantes: 0, falha: null });
    expect(sim.stores.fila.size).toBe(0);
  });

  describe('noutra aba', () => {
    // Cada aba é uma cópia nova dos módulos com a sua conexão ao mesmo IndexedDB simulado. Corrigir e tentar de novo não
    // esperam a trava do envio (só o envio e o download do pacote a usam): a outra aba age durante o POST desta.
    const BANCO = 'omnisaude-campo-ace';
    let fake: FakeIndexedDB;
    const abrirAba = async () => {
      vi.resetModules();
      vi.doMock('../src/lib/offline', async (original) => ({ ...(await original<typeof import('../src/lib/offline')>()), estaOnline: () => true }));
      return import('@/lib/ace-store');
    };
    const naFila = () => fake.linhas(BANCO, 'fila') as unknown as ItemFilaAce[];
    const naFilaDoApp = (extra: Partial<ItemFilaAce> = {}): ItemFilaAce => ({
      clientId: UUID(1),
      op: { ...visita(UUID(1)), unitId: 'un-a' },
      userId: 'u1',
      unitId: 'un-a',
      status: 'PENDENTE',
      erro: null,
      criadoEm: '2026-11-07T12:00:00Z',
      rotulo: 'Visita',
      ...extra,
    });
    const criarBanco = (fila: ItemFilaAce) =>
      fake.criar(BANCO, 1, { fila: { keyPath: 'clientId', linhas: [fila as never] }, cache: { keyPath: 'key', linhas: [{ key: CHAVE, data: pacote(), savedAt: '2026-11-07T08:00:00Z' }] } });
    const saldoNoBanco = () => (fake.linhas(BANCO, 'cache').find((l) => l.key === CHAVE) as { data: PacoteCampo }).data.estoque[0]!.saldo;

    beforeEach(() => {
      fake = new FakeIndexedDB();
      vi.stubGlobal('indexedDB', fake);
      vi.stubGlobal('navigator', { onLine: true });
    });
    afterEach(() => {
      vi.doUnmock('../src/lib/offline');
      vi.unstubAllGlobals();
    });

    it.each<['OK' | 'ERRO', Partial<ResumoSyncAce>, Partial<ItemFilaAce>, string[], number]>([
      ['OK', { enviados: 1, erros: 1, restantes: 0 }, { status: 'ERRO', erro: VERSAO_ANTERIOR, versaoGravada: 0 }, ['Visita'], 48],
      ['ERRO', { enviados: 0, erros: 0, restantes: 1 }, { status: 'PENDENTE', erro: null }, [], 50],
    ])('%s da versão enviada com a correção salva noutra aba durante o POST', async (status, resumo, comoFica, historico, saldo) => {
      criarBanco(naFilaDoApp());
      const aba = await abrirAba();
      const outra = await abrirAba();
      const { envio, soltar } = await enviarPreso(() => aba.filaAce.sincronizar(ctxA), comStatus(status));
      await outra.filaAce.corrigir(UUID(1), corrigida(UUID(1)), 'Visita corrigida');
      soltar();
      expect(await envio).toMatchObject({ duplicados: 0, adiados: 0, falha: null, ...resumo });
      expect(naFila()).toEqual([{ ...naFilaDoApp(), op: { ...corrigida(UUID(1)), unitId: 'un-a' }, rotulo: 'Visita corrigida', adiado: null, versao: 1, ...comoFica }]);
      expect((await aba.historicoAce.listar('u1')).map((h) => h.rotulo)).toEqual(historico);
      expect(saldoNoBanco()).toBe(saldo);
    });

    it.each<['OK' | 'ERRO', Partial<ResumoSyncAce>, ItemFilaAce[]]>([
      ['OK', { enviados: 1, erros: 0 }, []],
      ['ERRO', { enviados: 0, erros: 1 }, [naFilaDoApp({ status: 'ERRO', erro: 'Recusado de novo', adiado: null })]],
    ])('tentar de novo noutra aba (lista desatualizada) durante o envio não é correção: o resultado %s vale para o registro', async (status, resumo, fila) => {
      criarBanco(naFilaDoApp({ status: 'ERRO', erro: 'Recusado' }));
      const aba = await abrirAba();
      const outra = await abrirAba();
      // Nesta aba o agente tocou em "Tentar de novo" e o envio saiu; a outra ainda mostra o registro com o erro.
      await aba.filaAce.tentarDeNovo(UUID(1));
      const { envio, soltar } = await enviarPreso(() => aba.filaAce.sincronizar(ctxA), comStatus(status, 'Recusado de novo'));
      await outra.filaAce.tentarDeNovo(UUID(1));
      soltar();
      expect(await envio).toMatchObject({ falha: null, ...resumo });
      expect(naFila()).toEqual(fila);
    });

    // Sem a trava entre abas, as duas abas podem enviar ao mesmo tempo. O servidor grava a primeira requisição (OK) e
    // responde DUPLICADA às outras; cada resposta fica presa até `soltar[n]` (n: ordem da requisição).
    const servidorPreso = () => {
      const recebidos = new Set<string>();
      const soltar: (() => void)[] = [];
      const presas = [0, 1].map(() => new Promise<void>((r) => soltar.push(r)));
      sim.post.mockImplementation(async (_path: string, body: Corpo) => {
        const n = sim.post.mock.calls.length - 1;
        const resultados = body.operacoes.map((op) => {
          const status = recebidos.has(op.clientId) ? 'DUPLICADA' : 'OK';
          recebidos.add(op.clientId);
          return { clientId: op.clientId, tipo: op.tipo, status, id: `id-${op.clientId}`, erro: null };
        });
        await presas[n];
        return { resultados };
      });
      return soltar;
    };
    const corrigidaComErro = () => ({ ...naFilaDoApp(), op: { ...corrigida(UUID(1)), unitId: 'un-a' }, rotulo: 'Visita corrigida', status: 'ERRO', erro: VERSAO_ANTERIOR, adiado: null, versao: 1, versaoGravada: 0 });

    it.each(['DUPLICADA', 'OK'] as const)('sem a trava, as duas abas levam a versão anterior e a correção é salva no meio; a resposta %s chega antes: o larvicida entra uma vez no pacote guardado', async (primeira) => {
      criarBanco(naFilaDoApp());
      const abaA = await abrirAba();
      const abaB = await abrirAba();
      const outra = await abrirAba();
      const soltar = servidorPreso();
      const envioA = abaA.filaAce.sincronizar(ctxA);
      await vi.waitFor(() => expect(sim.post).toHaveBeenCalledTimes(1), { timeout: 5000 });
      const envioB = abaB.filaAce.sincronizar(ctxA);
      await vi.waitFor(() => expect(sim.post).toHaveBeenCalledTimes(2), { timeout: 5000 });
      await outra.filaAce.corrigir(UUID(1), corrigida(UUID(1)), 'Visita corrigida');
      // A requisição de A foi gravada (OK); a de B volta DUPLICADA. Antes, o OK que chegava depois da DUPLICADA aplicava o
      // larvicida de novo no pacote guardado.
      const envios = [envioA, envioB];
      const resumos: ResumoSyncAce[] = [];
      for (const n of primeira === 'OK' ? [0, 1] : [1, 0]) {
        soltar[n]!();
        resumos[n] = await envios[n]!;
      }
      expect(saldoNoBanco()).toBe(48);
      expect(naFila()).toEqual([corrigidaComErro()]);
      expect((await abaA.historicoAce.listar('u1')).map((h) => h.rotulo)).toEqual(['Visita']);
      // Cada aba manda à aba Fila; a versão anterior conta uma vez como aceita.
      expect(resumos.map((r) => r.erros)).toEqual([1, 1]);
      expect(resumos.reduce((s, r) => s + r.enviados + r.duplicados, 0)).toBe(1);
    });

    it('sem a trava, a outra aba envia a correção logo depois de salvá-la e recebe DUPLICADA depois do OK da versão anterior: a correção continua com o erro', async () => {
      criarBanco(naFilaDoApp());
      const aba = await abrirAba();
      const outra = await abrirAba();
      const soltar = servidorPreso();
      const envio = aba.filaAce.sincronizar(ctxA);
      await vi.waitFor(() => expect(sim.post).toHaveBeenCalledTimes(1), { timeout: 5000 });
      await outra.filaAce.corrigir(UUID(1), corrigida(UUID(1)), 'Visita corrigida');
      const envioDaOutra = outra.filaAce.sincronizar(ctxA);
      await vi.waitFor(() => expect(sim.post).toHaveBeenCalledTimes(2), { timeout: 5000 });
      expect((sim.post.mock.calls[1]![1] as { operacoes: VisitaOp[] }).operacoes.map((o) => o.registradoEm)).toEqual(['2026-11-07T12:30:00Z']);
      soltar[0]!();
      expect(await envio).toMatchObject({ enviados: 1, erros: 1 });
      // O servidor tem a versão anterior: a DUPLICADA da correção não a tira da fila nem troca o rótulo no histórico.
      soltar[1]!();
      expect(await envioDaOutra).toMatchObject({ enviados: 0, duplicados: 0, erros: 1, aceitos: [] });
      expect(naFila()).toEqual([corrigidaComErro()]);
      expect((await aba.historicoAce.listar('u1')).map((h) => h.rotulo)).toEqual(['Visita']);
      expect(saldoNoBanco()).toBe(48);
    });
  });
});
