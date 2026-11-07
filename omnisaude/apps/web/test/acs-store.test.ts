import type { OperacaoCampo, ResultadoSync } from '@omnisaude/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDB } from './fake-indexeddb';

// Fila do app do ACS sobre o IndexedDB simulado (o de verdade é testado em offline.test.ts) e a API simulada. Cada teste
// carrega os módulos de novo: a conexão com o banco fica guardada no módulo.
const sim = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('../src/lib/api', async (original) => ({ ...(await original<typeof import('../src/lib/api')>()), api: { post: sim.post, get: sim.get } }));

type Store = typeof import('../src/lib/acs-store');
type Offline = typeof import('../src/lib/offline');
let fake: FakeIndexedDB;
let loja: Store;
let offline: Offline;

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const visita = (clientId: string): OperacaoCampo =>
  ({ tipo: 'VISITA', clientId, registradoEm: '2026-11-07T12:00:00Z', householdId: '11111111-1111-4111-8111-111111111111', turno: 1, motivos: ['01'], desfecho: '1' }) as unknown as OperacaoCampo;
const resposta = (status: ResultadoSync['status']) => async (_path: string, body: { operacoes: OperacaoCampo[] }) => ({
  resultados: body.operacoes.map((op) => ({ clientId: op.clientId, tipo: op.tipo, status, id: status === 'ERRO' ? null : `id-${op.clientId}`, erro: status === 'ERRO' ? 'Recusado' : null })),
});
const naFila = () => fake.linhas('omnisaude-campo', 'fila') as { clientId: string; status: string }[];
const resumo = (r: Partial<import('../src/lib/acs-store').ResumoEnvioAcs> = {}) => ({ enviados: 0, duplicados: 0, erros: 0, offline: false, falha: null, ...r });

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
    const real = loja.filaCampo.adicionar.bind(loja.filaCampo);
    // Domicílio novo com o responsável: o segundo registro não grava (banco do aparelho), o primeiro sai da fila.
    vi.spyOn(loja.filaCampo, 'adicionar').mockImplementation(async (op, rotulo) => {
      if (op.clientId === UUID(2)) throw new offline.ErroAparelho();
      return real(op, rotulo);
    });
    await expect(loja.registrarNaFila([visita(UUID(1)), visita(UUID(2))], 'Novo domicílio', enviar)).rejects.toBeInstanceOf(offline.ErroAparelho);
    expect(naFila()).toEqual([]);
    expect(enviar).not.toHaveBeenCalled();
    // Banco sem gravar nada: o mesmo erro, nada na fila.
    fake.erroNaGravacao = new DOMException('cota', 'QuotaExceededError');
    vi.mocked(loja.filaCampo.adicionar).mockImplementation(real);
    await expect(loja.registrarNaFila([visita(UUID(3))], 'Visita', enviar)).rejects.toThrow(/espaço de armazenamento acabou/);
    fake.erroNaGravacao = null;
    expect(naFila()).toEqual([]);
    expect(enviar).not.toHaveBeenCalled();
  });

  // Um envio que começa entre as gravações (a volta da rede ou o botão Sincronizar) lia a fila com só a primeira operação:
  // o responsável ia sozinho ao servidor, a segunda falhava, o formulário mostrava o erro e salvar de novo o repetia.
  const envioNoMeioDaGravacao = (segundaGrava: boolean) => {
    const real = loja.filaCampo.adicionar.bind(loja.filaCampo);
    const envio: { promessa: Promise<unknown> | null } = { promessa: null };
    vi.spyOn(loja.filaCampo, 'adicionar').mockImplementation(async (op, rotulo) => {
      if (op.clientId !== UUID(2)) return real(op, rotulo);
      envio.promessa = loja.filaCampo.sincronizar();
      await new Promise((r) => setTimeout(r, 30));
      if (!segundaGrava) throw new offline.ErroAparelho();
      return real(op, rotulo);
    });
    return envio;
  };

  it('envio que começa durante a gravação de um registro de duas operações espera por ela: com a falha, nada vai ao servidor', async () => {
    sim.post.mockImplementation(resposta('OK'));
    const envio = envioNoMeioDaGravacao(false);
    const enviar = vi.fn(async () => undefined);
    await expect(loja.registrarNaFila([visita(UUID(1)), visita(UUID(2))], 'Novo domicílio', enviar)).rejects.toBeInstanceOf(offline.ErroAparelho);
    expect(enviar).not.toHaveBeenCalled();
    expect(await envio.promessa).toEqual(resumo());
    expect(sim.post).not.toHaveBeenCalled();
    expect(naFila()).toEqual([]);
  });

  it('envio que começa durante a gravação de um registro de duas operações espera por ela: com sucesso, leva o registro inteiro', async () => {
    sim.post.mockImplementation(resposta('OK'));
    const envio = envioNoMeioDaGravacao(true);
    await loja.registrarNaFila([visita(UUID(1)), visita(UUID(2))], 'Novo domicílio', async () => undefined);
    expect(await envio.promessa).toEqual(resumo({ enviados: 2 }));
    expect(sim.post).toHaveBeenCalledTimes(1);
    expect((sim.post.mock.calls[0]![1] as { operacoes: OperacaoCampo[] }).operacoes.map((o) => o.clientId).sort()).toEqual([UUID(1), UUID(2)]);
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
    expect(r).toEqual(resumo({ falha: 'Não foi possível guardar no aparelho: feche as outras abas do OmniSaúde e tente de novo' }));
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

describe('aviso do envio (toast)', () => {
  it('falha do aparelho: diz o que houve e que nada se perde', () => {
    expect(loja.avisoDoEnvio(resumo({ falha: 'Não foi possível guardar no aparelho: feche as outras abas do OmniSaúde e tente de novo' }), { silencioso: true, registrado: true })).toEqual({
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
