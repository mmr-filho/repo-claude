import type { OperacaoCampo, ResultadoSync } from '@omnisaude/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abrirOutraAba as conectar, type Evento, FakeIndexedDB, type Transacao } from './fake-indexeddb';

// Fila do app do ACS sobre o IndexedDB simulado (o de verdade é testado em offline.test.ts) e a API simulada. Cada teste
// carrega os módulos de novo: a conexão com o banco fica guardada no módulo.
const sim = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('../src/lib/api', async (original) => ({ ...(await original<typeof import('../src/lib/api')>()), api: { post: sim.post, get: sim.get } }));

type Store = typeof import('../src/lib/acs-store');
type Offline = typeof import('../src/lib/offline');
type ResumoEnvioAcs = import('../src/lib/acs-store').ResumoEnvioAcs;
let fake: FakeIndexedDB;
let loja: Store;
let offline: Offline;

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const visita = (clientId: string): OperacaoCampo =>
  ({ tipo: 'VISITA', clientId, registradoEm: '2026-11-07T12:00:00Z', householdId: '11111111-1111-4111-8111-111111111111', turno: 1, motivos: ['01'], desfecho: '1' }) as unknown as OperacaoCampo;
const pessoa = (clientId: string): OperacaoCampo => ({ tipo: 'PESSOA', clientId, registradoEm: '2026-11-07T12:00:00Z', dados: { name: 'Maria das Dores', birthDate: '1980-05-10', sex: 'F' } });
const domicilio = (clientId: string, responsavelClientId: string): OperacaoCampo => ({
  tipo: 'DOMICILIO',
  clientId,
  registradoEm: '2026-11-07T12:00:00Z',
  dados: { street: 'Rua das Flores', number: '10' },
  familia: { responsavelClientId, incomeBracket: null },
});
/** Domicílio novo com o responsável novo, como o formulário monta (household-form.tsx): a PESSOA e o DOMICILIO que a cita. */
const RESPONSAVEL = UUID(1);
const DOMICILIO = UUID(2);
const registroNovo = () => [pessoa(RESPONSAVEL), domicilio(DOMICILIO, RESPONSAVEL)];
const resposta = (status: ResultadoSync['status']) => async (_path: string, body: { operacoes: OperacaoCampo[] }) => ({
  resultados: body.operacoes.map((op) => ({ clientId: op.clientId, tipo: op.tipo, status, id: status === 'ERRO' ? null : `id-${op.clientId}`, erro: status === 'ERRO' ? 'Recusado' : null })),
});
const naFila = () => fake.linhas('omnisaude-campo', 'fila') as { clientId: string; status: string }[];
const idsNaFila = () => naFila().map((i) => i.clientId);
const enviadosNoPost = (chamada: number) => (sim.post.mock.calls[chamada]![1] as { operacoes: OperacaoCampo[] }).operacoes.map((o) => o.clientId);
const resumo = (r: Partial<ResumoEnvioAcs> = {}) => ({ enviados: 0, duplicados: 0, erros: 0, offline: false, falha: null, ...r });
const falhou = () => new DOMException('falhou', 'UnknownError');
const FALHA_GRAVAR = 'Não foi possível guardar no aparelho: feche as outras abas do OmniSaúde e tente de novo';

/** A outra aba: cópia nova dos módulos (a ordem por aba é do módulo), com a sua conexão ao mesmo IndexedDB simulado. */
const abrirOutraAba = async () => {
  vi.resetModules();
  return { loja: await import('../src/lib/acs-store'), offline: await import('../src/lib/offline') };
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
const conexoesDoAcs = () => fake.conexoes.filter((c) => c.name === 'omnisaude-campo');

/**
 * Começa um envio no meio da transação do registro novo, na gravação do responsável (antes da do domicílio), e faz a
 * gravação do domicílio falhar quando `segundaGrava` é falso. Conta as tentativas de gravar o domicílio.
 */
const envioNoMeioDoRegistro = (enviar: () => Promise<ResumoEnvioAcs>, segundaGrava: boolean) => {
  const meio = { envio: null as Promise<ResumoEnvioAcs> | null, tentativas: 0 };
  fake.aoGravar = ({ banco, store, chave, tipo }) => {
    if (banco !== 'omnisaude-campo' || store !== 'fila' || tipo !== 'put') return undefined;
    if (chave === RESPONSAVEL && !meio.envio) meio.envio = enviar();
    if (chave !== DOMICILIO) return undefined;
    meio.tentativas++;
    return segundaGrava ? undefined : falhou();
  };
  return meio;
};

beforeEach(async () => {
  fake = new FakeIndexedDB();
  vi.stubGlobal('indexedDB', fake);
  vi.stubGlobal('navigator', { onLine: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  sim.post.mockReset();
  sim.get.mockReset();
  vi.resetModules();
  // Em sequência: o mesmo módulo do banco para a loja e para o teste.
  loja = await import('../src/lib/acs-store');
  offline = await import('../src/lib/offline');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('registro do ACS: o envio vai em segundo plano (a falha dele não volta ao formulário)', () => {
  it('a falha do envio depois de guardar não volta ao formulário: o registro fica na fila e o formulário fecha', async () => {
    let naFilaQuandoEnviou: string[] = [];
    const enviar = vi.fn(async () => {
      naFilaQuandoEnviou = naFila().map((i) => i.clientId);
      throw new offline.ErroAparelho();
    });
    await expect(loja.registrarNaFila([visita(UUID(1))], 'Visita', enviar)).resolves.toBeUndefined();
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(naFilaQuandoEnviou).toEqual([UUID(1)]);
    await new Promise((r) => setTimeout(r, 10));
    expect(naFila().map((i) => i.clientId)).toEqual([UUID(1)]);
  });

  it('o formulário não espera o envio (rede lenta ou servidor pendurado)', async () => {
    const enviar = vi.fn(() => new Promise<never>(() => {}));
    await expect(loja.registrarNaFila([visita(UUID(1))], 'Visita', enviar)).resolves.toBeUndefined();
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it('a falha ao guardar volta ao formulário, sem metade do registro na fila e sem envio', async () => {
    const enviar = vi.fn(async () => undefined);
    // Domicílio novo com o responsável: a gravação do domicílio falha (banco do aparelho) e a transação inteira é desfeita.
    fake.aoGravar = ({ chave, tipo }) => (chave === DOMICILIO && tipo === 'put' ? falhou() : undefined);
    const registro = loja.registrarNaFila(registroNovo(), 'Novo domicílio', enviar);
    await expect(registro).rejects.toBeInstanceOf(offline.ErroAparelho);
    await expect(registro).rejects.toThrow(FALHA_GRAVAR);
    expect(naFila()).toEqual([]);
    expect(enviar).not.toHaveBeenCalled();
    fake.aoGravar = null;
    // As duas gravações passam, mas a confirmação falha (cota estourada no commit): nada fica.
    fake.cancelarNaConfirmacao = true;
    await expect(loja.registrarNaFila(registroNovo(), 'Novo domicílio', enviar)).rejects.toThrow(/espaço de armazenamento acabou/);
    fake.cancelarNaConfirmacao = false;
    expect(naFila()).toEqual([]);
    // Banco sem gravar nada: o mesmo erro, nada na fila.
    fake.erroNaGravacao = new DOMException('cota', 'QuotaExceededError');
    await expect(loja.registrarNaFila([visita(UUID(3))], 'Visita', enviar)).rejects.toThrow(/espaço de armazenamento acabou/);
    fake.erroNaGravacao = null;
    expect(naFila()).toEqual([]);
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe('registro de domicílio novo com o responsável novo: no banco do aparelho, inteiro ou nada', () => {
  // A aba pode morrer a qualquer momento (o Android fecha a aba em segundo plano, o agente fecha a aba), e o que fica é o
  // último estado confirmado do banco. Com o registro em duas gravações, o estado depois da primeira tinha só o
  // responsável: o formulário não confirmava, o agente cadastrava de novo, e o responsável órfão ia no próximo envio.
  it.each([
    ['gravado', true],
    ['com falha na gravação do domicílio', false],
  ])('%s: nenhum estado guardado no banco tem o responsável sem o domicílio', async (_caso, segundaGrava) => {
    const retratos: string[][] = [];
    fake.aoConfirmar = (banco) => {
      if (banco === 'omnisaude-campo') retratos.push(idsNaFila().sort());
    };
    if (!segundaGrava) fake.aoGravar = ({ chave, tipo }) => (chave === DOMICILIO && tipo === 'put' ? falhou() : undefined);
    const registro = loja.registrarNaFila(registroNovo(), 'Novo domicílio', async () => undefined);
    if (segundaGrava) await registro;
    else await expect(registro).rejects.toBeInstanceOf(offline.ErroAparelho);
    expect(retratos.filter((r) => r.includes(RESPONSAVEL) !== r.includes(DOMICILIO))).toEqual([]);
    // Uma transação só: o banco passa de nada ao registro inteiro, ou não muda.
    expect(retratos).toEqual(segundaGrava ? [[RESPONSAVEL, DOMICILIO]] : []);
    expect(idsNaFila().sort()).toEqual(segundaGrava ? [RESPONSAVEL, DOMICILIO] : []);
  });

  it.each([
    ['com valor que o aparelho não copia (DataCloneError)', (op: OperacaoCampo) => ({ ...op, anexo: () => undefined }) as unknown as OperacaoCampo],
    ['sem chave válida (DataError)', (op: OperacaoCampo) => ({ ...op, clientId: undefined }) as unknown as OperacaoCampo],
  ])('o put do domicílio que lança na hora (%s) cancela a transação: o responsável não fica sozinho na fila', async (_caso, estragar) => {
    const enviar = vi.fn(async () => undefined);
    const [responsavel, novoDomicilio] = registroNovo();
    const registro = loja.registrarNaFila([responsavel!, estragar(novoDomicilio!)], 'Novo domicílio', enviar);
    await expect(registro).rejects.toBeInstanceOf(offline.ErroAparelho);
    // A leitura seguinte espera a transação do registro terminar (confirmada ou cancelada).
    expect(await loja.filaCampo.listar()).toEqual([]);
    expect(naFila()).toEqual([]);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('a lista da fila é avisada quando o registro entra, e já o lê inteiro', async () => {
    const lidos: string[][] = [];
    const parar = loja.ouvirFila(() => lidos.push(idsNaFila().sort()));
    await loja.registrarNaFila(registroNovo(), 'Novo domicílio', async () => undefined);
    parar();
    await loja.registrarNaFila([visita(UUID(3))], 'Visita', async () => undefined);
    expect(lidos).toEqual([[RESPONSAVEL, DOMICILIO]]);
  });

  it('a lista mostra o registro na ordem das operações e depois do anterior, mesmo com o relógio parado', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T12:00:00.000Z'));
    try {
      // Os clientIds fora da ordem das operações: o banco devolve a fila pela chave.
      await loja.registrarNaFila([pessoa(UUID(9)), domicilio(UUID(5), UUID(9))], 'Novo domicílio', async () => undefined);
      await loja.registrarNaFila([visita(UUID(1))], 'Visita', async () => undefined);
      const itens = await loja.filaCampo.listar();
      expect(itens.map((i) => i.clientId)).toEqual([UUID(9), UUID(5), UUID(1)]);
      expect(new Set(itens.map((i) => i.criadoEm)).size).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('relógio do aparelho que volta mais de 1 s (hora da rede depois de um tempo sem sinal): o item novo fica com a hora do relógio', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T12:00:00.000Z'));
    try {
      await loja.registrarNaFila([visita(UUID(1))], 'Visita', async () => undefined);
      // Até 1 s para trás: continua depois do último item.
      vi.setSystemTime(new Date('2026-11-07T11:59:59.500Z'));
      await loja.registrarNaFila([visita(UUID(2))], 'Visita', async () => undefined);
      // Uma hora para trás: a hora do relógio, e não a do último item mais 1 ms (a lista mostraria hora adiantada).
      vi.setSystemTime(new Date('2026-11-07T11:00:00.000Z'));
      await loja.registrarNaFila([visita(UUID(3))], 'Visita', async () => undefined);
      await loja.registrarNaFila([visita(UUID(4))], 'Visita', async () => undefined);
      const criadoEm = Object.fromEntries((await loja.filaCampo.listar()).map((i) => [i.clientId, i.criadoEm]));
      expect(criadoEm).toEqual({
        [UUID(1)]: '2026-11-07T12:00:00.000Z',
        [UUID(2)]: '2026-11-07T12:00:00.001Z',
        [UUID(3)]: '2026-11-07T11:00:00.000Z',
        [UUID(4)]: '2026-11-07T11:00:00.001Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('envio que começa no meio do registro de domicílio novo com o responsável novo', () => {
  // O envio começa (a volta da rede ou o botão Sincronizar, nesta aba ou noutra) com a transação do registro em curso,
  // depois da gravação do responsável e antes da do domicílio. A leitura do envio vê o registro inteiro ou nada dele, com
  // ou sem a trava do navegador: o responsável nunca vai sozinho ao servidor (salvar de novo criaria outro).
  const casos = [
    ['nesta aba, sem a trava do navegador', false, false],
    ['nesta aba, com a trava do navegador', false, true],
    ['noutra aba, sem a trava do navegador', true, false],
    ['noutra aba, com a trava do navegador', true, true],
  ] as const;
  /** Quem envia, com a conexão ao banco já aberta: a leitura do envio é pedida com a transação do registro em curso. */
  const preparar = async (outraAba: boolean, comTravas: boolean) => {
    const travas = travasDoNavegador();
    vi.stubGlobal('navigator', comTravas ? { onLine: true, locks: travas } : { onLine: true });
    const quem = outraAba ? (await abrirOutraAba()).loja : loja;
    await quem.filaCampo.listar();
    sim.post.mockImplementation(resposta('OK'));
    return { travas, quem };
  };

  it.each(casos)('%s: com a falha na gravação do domicílio, nada vai ao servidor', async (_caso, outraAba, comTravas) => {
    const { travas, quem } = await preparar(outraAba, comTravas);
    const meio = envioNoMeioDoRegistro(() => quem.filaCampo.sincronizar(), false);
    const enviar = vi.fn(async () => undefined);
    const registro = loja.registrarNaFila(registroNovo(), 'Novo domicílio', enviar);
    await expect(registro).rejects.toBeInstanceOf(offline.ErroAparelho);
    await expect(registro).rejects.toThrow(FALHA_GRAVAR);
    expect(enviar).not.toHaveBeenCalled();
    expect(meio.envio).not.toBeNull();
    expect(await meio.envio).toEqual(resumo());
    expect(sim.post).not.toHaveBeenCalled();
    expect(naFila()).toEqual([]);
    expect(await quem.historicoEnvios.listar()).toEqual([]);
    // A falha sobe uma vez, sem gravar o registro de novo; só o envio pede a trava (o registro não espera trava nenhuma).
    expect(meio.tentativas).toBe(1);
    expect(travas.pedidos).toEqual(comTravas ? ['omnisaude-campo-acs:envio'] : []);
    expect(conexoesDoAcs()).toHaveLength(outraAba ? 2 : 1);
  });

  it.each(casos)('%s: com sucesso, o envio leva o registro inteiro', async (_caso, outraAba, comTravas) => {
    const { quem } = await preparar(outraAba, comTravas);
    const meio = envioNoMeioDoRegistro(() => quem.filaCampo.sincronizar(), true);
    await loja.registrarNaFila(registroNovo(), 'Novo domicílio', async () => undefined);
    expect(meio.envio).not.toBeNull();
    expect(await meio.envio).toEqual(resumo({ enviados: 2 }));
    expect(sim.post).toHaveBeenCalledTimes(1);
    expect(enviadosNoPost(0).sort()).toEqual([RESPONSAVEL, DOMICILIO]);
    expect(naFila()).toEqual([]);
    expect((await quem.historicoEnvios.listar()).map((e) => e.clientId).sort()).toEqual([RESPONSAVEL, DOMICILIO]);
    expect(conexoesDoAcs()).toHaveLength(outraAba ? 2 : 1);
  });
});

describe('duas abas do app do ACS com o mesmo banco do aparelho', () => {
  const segurarServidor = () => {
    let soltar!: () => void;
    const segura = new Promise<void>((r) => (soltar = r));
    sim.post.mockImplementation(async (path: string, body: { operacoes: OperacaoCampo[] }) => {
      await segura;
      return resposta('OK')(path, body);
    });
    return soltar;
  };

  it('o registro não espera o envio da outra aba pendurado no servidor (o registro não pede trava nenhuma)', async () => {
    const travas = travasDoNavegador();
    vi.stubGlobal('navigator', { onLine: true, locks: travas });
    const outra = await abrirOutraAba();
    await outra.loja.filaCampo.adicionar(visita(UUID(9)), 'Visita');
    const soltar = segurarServidor();
    const envioDaOutra = outra.loja.filaCampo.sincronizar();
    await new Promise((r) => setTimeout(r, 20));
    expect(sim.post).toHaveBeenCalledTimes(1);
    const registro = loja.registrarNaFila(registroNovo(), 'Novo domicílio', async () => undefined).then(() => 'guardado');
    const espera = new Promise((r) => setTimeout(() => r('esperando o envio da outra aba'), 1000));
    expect(await Promise.race([registro, espera])).toBe('guardado');
    expect(idsNaFila().sort()).toEqual([RESPONSAVEL, DOMICILIO, UUID(9)]);
    expect(travas.pedidos).toEqual(['omnisaude-campo-acs:envio']);
    soltar();
    // A outra aba leu a fila antes do registro: leva só o que tinha, e o registro vai no envio seguinte.
    expect(await envioDaOutra).toEqual(resumo({ enviados: 1 }));
    expect(enviadosNoPost(0)).toEqual([UUID(9)]);
    expect(idsNaFila().sort()).toEqual([RESPONSAVEL, DOMICILIO]);
  });

  it('duas abas enviando ao mesmo tempo: a segunda espera a primeira e não manda de novo o que ela levou', async () => {
    const travas = travasDoNavegador();
    vi.stubGlobal('navigator', { onLine: true, locks: travas });
    const outra = await abrirOutraAba();
    await loja.filaCampo.adicionar(visita(UUID(1)), 'Visita');
    const soltar = segurarServidor();
    const envioDesta = loja.filaCampo.sincronizar();
    const envioDaOutra = outra.loja.filaCampo.sincronizar();
    await new Promise((r) => setTimeout(r, 30));
    expect(sim.post).toHaveBeenCalledTimes(1);
    soltar();
    expect(await envioDesta).toEqual(resumo({ enviados: 1 }));
    expect(await envioDaOutra).toEqual(resumo());
    expect(sim.post).toHaveBeenCalledTimes(1);
    expect(naFila()).toEqual([]);
    expect((await outra.loja.historicoEnvios.listar()).map((e) => e.clientId)).toEqual([UUID(1)]);
    // Uma trava por envio, com o nome do ACS (a do envio do ACE, que segura a rede, é outra).
    expect(travas.pedidos).toEqual(['omnisaude-campo-acs:envio', 'omnisaude-campo-acs:envio']);
    expect(conexoesDoAcs()).toHaveLength(2);
  });

  it('pedido de trava recusado pelo navegador: registro e envio seguem com a ordem desta aba', async () => {
    const request = vi.fn(async () => {
      throw new DOMException('Documento sem permissão', 'SecurityError');
    });
    vi.stubGlobal('navigator', { onLine: true, locks: { request } });
    sim.post.mockImplementation(resposta('OK'));
    await loja.registrarNaFila(registroNovo(), 'Novo domicílio', async () => undefined);
    expect(await loja.filaCampo.sincronizar()).toEqual(resumo({ enviados: 2 }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('omnisaude-campo-acs:envio', expect.any(Function));
    expect(console.warn).toHaveBeenCalledWith('Trava entre abas indisponível', expect.any(DOMException));
    expect(naFila()).toEqual([]);
  });
});

describe('envio da fila do ACS com o banco do aparelho falhando', () => {
  it('servidor aceitou e o aparelho não tirou da fila: o envio não lança, devolve a falha, e o próximo envio não duplica', async () => {
    await loja.filaCampo.adicionar(visita(UUID(1)), 'Visita');
    sim.post.mockImplementationOnce(async (path: string, body: { operacoes: OperacaoCampo[] }) => {
      fake.erroNaGravacao = new DOMException('falhou', 'UnknownError');
      return resposta('OK')(path, body);
    });
    const r = await loja.filaCampo.sincronizar();
    expect(r).toEqual(resumo({ falha: FALHA_GRAVAR }));
    expect(naFila()).toMatchObject([{ clientId: UUID(1), status: 'PENDENTE' }]);
    // Banco de volta: o reenvio é reconhecido pelo servidor (DUPLICADA) e sai da fila.
    fake.erroNaGravacao = null;
    sim.post.mockImplementationOnce(resposta('DUPLICADA'));
    expect(await loja.filaCampo.sincronizar()).toEqual(resumo({ duplicados: 1 }));
    expect(naFila()).toEqual([]);
    expect((await loja.historicoEnvios.listar()).map((e) => e.clientId)).toEqual([UUID(1)]);
  });

  it('o que saiu da fila antes da falha entra no histórico de envios', async () => {
    await loja.filaCampo.adicionar(visita(UUID(1)), 'Visita 1');
    await loja.filaCampo.adicionar(visita(UUID(2)), 'Visita 2');
    let removidos = 0;
    const deletar = offline.local.delete;
    vi.spyOn(offline.local, 'delete').mockImplementation(async (store, key) => {
      if (++removidos > 1) throw new offline.ErroAparelho();
      return deletar(store, key);
    });
    sim.post.mockImplementationOnce(resposta('OK'));
    const r = await loja.filaCampo.sincronizar();
    expect(r).toMatchObject({ enviados: 1, falha: expect.stringContaining('Não foi possível guardar no aparelho') });
    expect(naFila()).toHaveLength(1);
    expect(await loja.historicoEnvios.listar()).toHaveLength(1);
  });
});

describe('registro descartado durante o envio (nesta aba ou noutra)', () => {
  // Antes, o erro do servidor gravava de novo o registro que o agente tinha descartado: ele voltava para a fila, com o erro.
  it.each([
    ['o resultado ERRO do servidor', async (_path: string, body: { operacoes: OperacaoCampo[] }) => resposta('ERRO')(_path, body)],
    [
      'o lote recusado inteiro',
      async () => {
        throw new Error('Dados inválidos');
      },
    ],
  ])('não volta para a fila com %s; o outro do lote fica com o erro', async (_caso, responder) => {
    await loja.filaCampo.adicionar(visita(UUID(1)), 'Visita 1');
    await loja.filaCampo.adicionar(visita(UUID(2)), 'Visita 2');
    let liberar!: () => void;
    const segura = new Promise<void>((r) => (liberar = r));
    sim.post.mockImplementation(async (path: string, body: { operacoes: OperacaoCampo[] }) => {
      await segura;
      return responder(path, body);
    });
    const envio = loja.filaCampo.sincronizar();
    await new Promise((r) => setTimeout(r, 10));
    expect(sim.post).toHaveBeenCalledTimes(1);
    await loja.filaCampo.remover(UUID(1));
    liberar();
    // O descartado não conta como erro: o aviso não manda procurar na fila o que não está mais lá.
    expect(await envio).toEqual(resumo({ erros: 1 }));
    expect(naFila()).toMatchObject([{ clientId: UUID(2), status: 'ERRO' }]);
    expect(naFila()).toHaveLength(1);
  });

  /**
   * A outra aba, com a conexão já aberta, descarta o item assim que esta lê o item para regravá-lo: o descarte chega
   * entre a leitura e a gravação. Antes, as duas eram transações separadas, e a gravação desfazia o descarte.
   */
  const descarteNoMeio = async (clientId: string) => {
    const outra = await abrirOutraAba();
    await outra.loja.filaCampo.listar();
    const meio = { descarte: null as Promise<void> | null };
    const armar = () => {
      fake.aoLer = ({ banco, store, chave }) => {
        if (banco === 'omnisaude-campo' && store === 'fila' && chave === clientId) meio.descarte ??= outra.loja.filaCampo.remover(clientId);
      };
    };
    return { meio, armar };
  };

  it.each([
    ['o resultado ERRO do servidor', async (_path: string, body: { operacoes: OperacaoCampo[] }) => resposta('ERRO')(_path, body)],
    [
      'o lote recusado inteiro',
      async () => {
        throw new Error('Dados inválidos');
      },
    ],
  ])('descarte noutra aba entre a leitura e a gravação do erro (%s): não é desfeito', async (_caso, responder) => {
    await loja.filaCampo.adicionar(visita(UUID(1)), 'Visita 1');
    await loja.filaCampo.adicionar(visita(UUID(2)), 'Visita 2');
    const { meio, armar } = await descarteNoMeio(UUID(1));
    sim.post.mockImplementation(async (path: string, body: { operacoes: OperacaoCampo[] }) => {
      // A resposta chegou: a leitura do item para marcar o erro dispara o descarte da outra aba.
      armar();
      return responder(path, body);
    });
    expect(await loja.filaCampo.sincronizar()).toMatchObject({ falha: null, offline: false });
    expect(meio.descarte).not.toBeNull();
    await meio.descarte;
    expect(naFila()).toMatchObject([{ clientId: UUID(2), status: 'ERRO', erro: expect.any(String) }]);
    expect(naFila()).toHaveLength(1);
  });

  it('tentar de novo com o descarte noutra aba entre a leitura e a gravação: o descartado não volta como pendente', async () => {
    await loja.filaCampo.adicionar(visita(UUID(1)), 'Visita 1');
    sim.post.mockImplementation(resposta('ERRO'));
    expect(await loja.filaCampo.sincronizar()).toEqual(resumo({ erros: 1 }));
    const { meio, armar } = await descarteNoMeio(UUID(1));
    armar();
    await loja.filaCampo.tentarDeNovo(UUID(1));
    expect(meio.descarte).not.toBeNull();
    await meio.descarte;
    expect(naFila()).toEqual([]);
  });
});

describe('aviso do envio (toast)', () => {
  it('falha do aparelho: diz o que houve e que nada se perde', () => {
    expect(loja.avisoDoEnvio(resumo({ falha: FALHA_GRAVAR }), { silencioso: true, registrado: true })).toEqual({
      tipo: 'error',
      texto: 'O envio parou. Não foi possível guardar no aparelho: feche as outras abas do OmniSaúde e tente de novo. Nada se perde: o que ficou na fila vai no próximo envio, sem duplicar.',
    });
    expect(loja.avisoDoEnvio(resumo({ enviados: 2, falha: 'Erro inesperado.' }))!.texto).toBe(
      '2 registro(s) enviado(s), mas o envio parou. Erro inesperado. Nada se perde: o que ficou na fila vai no próximo envio, sem duplicar.',
    );
  });

  it('sem conexão: depois de registrar confirma que ficou no aparelho; o envio automático fica quieto', () => {
    expect(loja.avisoDoEnvio(resumo({ offline: true }), { silencioso: true, registrado: true })).toEqual({ tipo: 'success', texto: 'Registrado no aparelho. Será enviado quando houver conexão.' });
    expect(loja.avisoDoEnvio(resumo({ offline: true }), { silencioso: true })).toBeNull();
    expect(loja.avisoDoEnvio(resumo({ offline: true }))).toMatchObject({ tipo: 'error', texto: expect.stringContaining('Sem conexão') });
  });

  it('enviados, duplicados, erros e nada pendente', () => {
    expect(loja.avisoDoEnvio(resumo({ enviados: 1 }), { silencioso: true, registrado: true })).toEqual({ tipo: 'success', texto: '1 registro(s) enviado(s).' });
    expect(loja.avisoDoEnvio(resumo({ enviados: 1, duplicados: 2 }))!.texto).toBe('1 registro(s) enviado(s), 2 já estavam no servidor.');
    expect(loja.avisoDoEnvio(resumo({ duplicados: 2 }), { silencioso: true })).toBeNull();
    expect(loja.avisoDoEnvio(resumo({ enviados: 1, erros: 1 }), { silencioso: true })).toEqual({ tipo: 'error', texto: '1 registro(s) enviado(s); 1 com erro (veja a aba Visitas).' });
    expect(loja.avisoDoEnvio(resumo())).toEqual({ tipo: 'success', texto: 'Nada pendente: tudo já está no servidor.' });
    expect(loja.avisoDoEnvio(resumo(), { silencioso: true })).toBeNull();
  });
});

describe('descartar e tentar de novo propagam a falha do aparelho (a tela mostra em toast)', () => {
  it('rejeitam com a mensagem do aparelho em vez de fingir que funcionou', async () => {
    await loja.filaCampo.adicionar(visita(UUID(1)), 'Visita');
    fake.erroNaGravacao = new DOMException('falhou', 'UnknownError');
    await expect(loja.filaCampo.remover(UUID(1))).rejects.toBeInstanceOf(offline.ErroAparelho);
    fake.erroNaGravacao = null;
    expect(naFila()).toHaveLength(1);
  });
});

describe('IndexedDB simulado (test/fake-indexeddb.ts): transações sobrepostas como no navegador', () => {
  // Os testes acima dependem disto. O navegador põe em fila as transações de gravação com algum store em comum (a segunda
  // só começa quando a primeira termina), e a leitura criada depois de uma gravação espera por ela. Antes, cada transação
  // trabalhava numa cópia tirada ao ser criada, e a que confirmava por último desfazia o que a outra tinha confirmado.
  const BANCO = 'teste-do-simulador';
  const fim = (t: Transacao) =>
    new Promise<'complete' | 'abort'>((resolve) => {
      t.oncomplete = () => resolve('complete');
      t.onabort = () => resolve('abort');
    });
  const ids = (linhas: unknown) => (linhas as { clientId: string }[]).map((l) => l.clientId).sort();
  const abas = async () => {
    fake.criar(BANCO, 1, { fila: { keyPath: 'clientId', linhas: [{ clientId: 'x' }] }, cache: { keyPath: 'key' } });
    return [await conectar(fake, BANCO), await conectar(fake, BANCO)] as const;
  };

  it.each([
    ['o envio criado antes', true],
    ['o registro criado antes', false],
  ])('duas gravações sobrepostas, %s (o envio de uma aba tira X da fila e a outra grava um registro): as duas ficam', async (_caso, envioAntes) => {
    const [abaA, abaB] = await abas();
    const enviar = () => {
      const t = abaA.transaction(['fila', 'cache'], 'readwrite');
      t.objectStore('fila').delete('x');
      t.objectStore('cache').put({ key: 'historico', data: ['x'] });
      return t;
    };
    const registrar = () => {
      const t = abaB.transaction(['fila'], 'readwrite');
      t.objectStore('fila').put({ clientId: 'responsavel' });
      t.objectStore('fila').put({ clientId: 'domicilio' });
      return t;
    };
    const transacoes = envioAntes ? [enviar(), registrar()] : [registrar(), enviar()];
    expect(await Promise.all(transacoes.map(fim))).toEqual(['complete', 'complete']);
    expect(ids(fake.linhas(BANCO, 'fila'))).toEqual(['domicilio', 'responsavel']);
    expect(fake.linhas(BANCO, 'cache')).toEqual([{ key: 'historico', data: ['x'] }]);
  });

  it('a gravação criada depois começa quando a anterior termina e vê o que ela gravou', async () => {
    const [abaA, abaB] = await abas();
    const primeira = abaA.transaction(['fila'], 'readwrite');
    primeira.objectStore('fila').put({ clientId: 'a', n: 1 });
    const segunda = abaB.transaction(['fila'], 'readwrite');
    const lido = segunda.objectStore('fila').get('a');
    const ordem: string[] = [];
    primeira.addEventListener('complete', () => ordem.push('primeira confirmada'));
    lido.addEventListener('success', () => ordem.push('segunda leu'));
    await Promise.all([fim(primeira), fim(segunda)]);
    expect(ordem).toEqual(['primeira confirmada', 'segunda leu']);
    expect(lido.result).toEqual({ clientId: 'a', n: 1 });
  });

  it('a leitura vê só estado confirmado: a criada antes de uma gravação não vê o que ela grava, a criada depois espera por ela', async () => {
    const [abaA, abaB] = await abas();
    const antes = abaB.transaction(['fila'], 'readonly');
    const lidoAntes = antes.objectStore('fila').getAll();
    const registro = abaA.transaction(['fila'], 'readwrite');
    registro.objectStore('fila').put({ clientId: 'responsavel' });
    registro.objectStore('fila').put({ clientId: 'domicilio' });
    const depois = abaB.transaction(['fila'], 'readonly');
    const lidoDepois = depois.objectStore('fila').getAll();
    expect(await Promise.all([fim(antes), fim(registro), fim(depois)])).toEqual(['complete', 'complete', 'complete']);
    expect(ids(lidoAntes.result)).toEqual(['x']);
    expect(ids(lidoDepois.result)).toEqual(['domicilio', 'responsavel', 'x']);
  });

  it('a leitura criada no meio de uma gravação que é cancelada não vê nada dela', async () => {
    const [abaA, abaB] = await abas();
    const registro = abaA.transaction(['fila'], 'readwrite');
    const meio: { leitura?: Transacao; lido?: { result: unknown } } = {};
    registro.objectStore('fila').put({ clientId: 'responsavel' }).onsuccess = () => {
      meio.leitura = abaB.transaction(['fila'], 'readonly');
      meio.lido = meio.leitura.objectStore('fila').getAll();
    };
    registro.objectStore('fila').put({ clientId: 'domicilio' });
    fake.aoGravar = ({ chave }) => (chave === 'domicilio' ? falhou() : undefined);
    expect(await fim(registro)).toBe('abort');
    expect(meio.leitura).toBeDefined();
    expect(await fim(meio.leitura!)).toBe('complete');
    expect(ids(meio.lido!.result)).toEqual(['x']);
    expect(ids(fake.linhas(BANCO, 'fila'))).toEqual(['x']);
  });

  // Antes, o simulador preenchia o erro da transação antes de o evento do pedido chegar a ela, e escondia que a tela
  // mostrava a mensagem geral para a cota estourada num put; e abort() avisava na hora, sem AbortError nos pedidos.
  it('erro de pedido: o mesmo evento sobe do pedido para a transação antes de ela ter erro, preenchido só ao cancelar', async () => {
    const [aba] = await abas();
    const t = aba.transaction(['fila'], 'readwrite');
    const fimT = fim(t);
    const vistos: unknown[] = [];
    const pedido = t.objectStore('fila').put({ clientId: 'falha' });
    pedido.onerror = () => vistos.push(['pedido', t.error]);
    t.onerror = (e: Evento) => vistos.push(['transação', t.error, e.target === pedido]);
    t.addEventListener('abort', () => vistos.push(['abort', t.error?.name]));
    fake.aoGravar = ({ chave }) => (chave === 'falha' ? new DOMException('cota', 'QuotaExceededError') : undefined);
    expect(await fimT).toBe('abort');
    expect(vistos).toEqual([
      ['pedido', null],
      ['transação', null, true],
      ['abort', 'QuotaExceededError'],
    ]);
    expect(ids(fake.linhas(BANCO, 'fila'))).toEqual(['x']);
  });

  it('abort(): o aviso chega numa tarefa seguinte, e antes dele cada pedido pendente recebe error com AbortError', async () => {
    const [abaA, abaB] = await abas();
    const emCurso = abaA.transaction(['fila'], 'readwrite');
    const fimEmCurso = fim(emCurso);
    // A de B fica atrás da de A (mesmo store): os pedidos dela ainda nem começaram quando ela é cancelada.
    const esperando = abaB.transaction(['fila'], 'readwrite');
    const fimEsperando = fim(esperando);
    const ordem: string[] = [];
    const acompanhar = (nome: string, t: Transacao, pedidos: ReturnType<Transacao['pedir']>[]) => {
      pedidos.forEach((p, i) => {
        p.onsuccess = () => ordem.push(`${nome} pedido ${i + 1} gravou`);
        p.onerror = () => ordem.push(`${nome} pedido ${i + 1}: ${p.error?.name}`);
      });
      t.onerror = (e: Evento) => ordem.push(`${nome} transação: erro do pedido ${pedidos.indexOf(e.target as ReturnType<Transacao['pedir']>) + 1}`);
      t.addEventListener('abort', () => ordem.push(`${nome} abort (erro ${t.error})`));
    };
    acompanhar('B', esperando, [esperando.objectStore('fila').put({ clientId: 'b' })]);
    acompanhar('A', emCurso, [emCurso.objectStore('fila').put({ clientId: 'a' }), emCurso.objectStore('fila').delete('x')]);
    esperando.abort();
    emCurso.abort();
    ordem.push('depois de abort()');
    expect(await Promise.all([fimEsperando, fimEmCurso])).toEqual(['abort', 'abort']);
    expect(ordem).toEqual([
      'depois de abort()',
      'B pedido 1: AbortError',
      'B transação: erro do pedido 1',
      'B abort (erro null)',
      'A pedido 1: AbortError',
      'A transação: erro do pedido 1',
      'A pedido 2: AbortError',
      'A transação: erro do pedido 2',
      'A abort (erro null)',
    ]);
    expect(() => emCurso.abort()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    expect(ids(fake.linhas(BANCO, 'fila'))).toEqual(['x']);
    // As transações seguintes andam: a gravação criada depois confirma.
    const seguinte = abaB.transaction(['fila'], 'readwrite');
    seguinte.objectStore('fila').put({ clientId: 'c' });
    expect(await fim(seguinte)).toBe('complete');
    expect(ids(fake.linhas(BANCO, 'fila'))).toEqual(['c', 'x']);
  });

  it('put que não copia o valor (DataCloneError) ou sem chave válida (DataError) lança na hora e, sem abort(), a transação confirma o resto', async () => {
    const [aba] = await abas();
    const t = aba.transaction(['fila'], 'readwrite');
    const fimT = fim(t);
    t.objectStore('fila').put({ clientId: 'responsavel' });
    expect(() => t.objectStore('fila').put({ clientId: 'domicilio', anexo: () => undefined })).toThrow(expect.objectContaining({ name: 'DataCloneError' }));
    expect(() => t.objectStore('fila').put({ semChave: true })).toThrow(expect.objectContaining({ name: 'DataError' }));
    // Como no navegador: a exceção não cancela a transação (por isso o banco do aparelho cancela quando ela acontece).
    expect(await fimT).toBe('complete');
    expect(ids(fake.linhas(BANCO, 'fila'))).toEqual(['responsavel', 'x']);
  });
});
