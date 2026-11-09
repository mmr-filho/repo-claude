import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abrirOutraAba, FakeIndexedDB } from './fake-indexeddb';

// Cada teste carrega o módulo de novo: as conexões ficam guardadas no módulo, uma por banco.
type Offline = typeof import('../src/lib/offline');
let fake: FakeIndexedDB;
const carregar = async (): Promise<Offline> => {
  vi.resetModules();
  return import('../src/lib/offline');
};
const espera = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const item = (clientId: string, extra: Record<string, unknown> = {}) => ({ clientId, userId: 'u1', status: 'PENDENTE', erro: null, criadoEm: '2026-11-07T10:00:00Z', rotulo: 'Visita', ...extra });

beforeEach(() => {
  fake = new FakeIndexedDB();
  vi.stubGlobal('indexedDB', fake);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gravação no aparelho (web-offline#1)', () => {
  it('só resolve quando a transação é confirmada: cancelada na confirmação, rejeita e não grava', async () => {
    const { localAce, ErroAparelho } = await carregar();
    fake.cancelarNaConfirmacao = true;
    await expect(localAce.put('fila', item('a'))).rejects.toBeInstanceOf(ErroAparelho);
    await expect(localAce.put('fila', item('a'))).rejects.toThrow(/espaço de armazenamento acabou/);
    fake.cancelarNaConfirmacao = false;
    expect(await localAce.all('fila')).toEqual([]);
  });

  it('erro numa gravação cancela a transação inteira (gravar: todas ou nenhuma)', async () => {
    const { localAce, ErroAparelho } = await carregar();
    await localAce.put('cache', { key: 'tubito:u1', data: 3 });
    fake.erroNaGravacao = new DOMException('cota', 'QuotaExceededError');
    await expect(
      localAce.gravar([
        { store: 'fila', put: item('a') },
        { store: 'cache', put: { key: 'tubito:u1', data: 4 } },
      ]),
    ).rejects.toBeInstanceOf(ErroAparelho);
    fake.erroNaGravacao = null;
    expect(await localAce.all('fila')).toEqual([]);
    expect(await localAce.get('cache', 'tubito:u1')).toEqual({ key: 'tubito:u1', data: 3 });
  });

  it('gravação que lança na hora no meio de gravar (valor que não se copia, chave inválida): a transação é cancelada e nada fica', async () => {
    const { localAce, ErroAparelho } = await carregar();
    await localAce.put('cache', { key: 'tubito:u1', data: 3 });
    for (const ruim of [item('b', { anexo: () => undefined }), item('b', { clientId: undefined })]) {
      await expect(
        localAce.gravar([
          { store: 'fila', put: item('a') },
          { store: 'cache', put: { key: 'tubito:u1', data: 4 } },
          { store: 'fila', put: ruim },
        ]),
      ).rejects.toBeInstanceOf(ErroAparelho);
      // A leitura espera a transação da gravação terminar (confirmada ou cancelada).
      expect(await localAce.all('fila')).toEqual([]);
      expect(await localAce.get('cache', 'tubito:u1')).toEqual({ key: 'tubito:u1', data: 3 });
    }
  });

  it('cota estourada num pedido (e não na confirmação) volta com a mensagem de espaço, e nada fica', async () => {
    // No navegador, o erro do pedido chega à transação antes de ela ter erro: a mensagem vem do erro do pedido.
    const { localAce } = await carregar();
    fake.erroNaGravacao = new DOMException('cota', 'QuotaExceededError');
    await expect(localAce.put('fila', item('a'))).rejects.toThrow(/espaço de armazenamento acabou/);
    await expect(
      localAce.gravar([
        { store: 'cache', put: { key: 'tubito:u1', data: 4 } },
        { store: 'fila', put: item('a') },
      ]),
    ).rejects.toThrow(/espaço de armazenamento acabou/);
    fake.erroNaGravacao = null;
    expect(await localAce.all('fila')).toEqual([]);
    expect(await localAce.all('cache')).toEqual([]);
  });

  it('falha ao abrir o banco rejeita a gravação (não vira "registrado" sem gravar)', async () => {
    const { localAce, ErroAparelho } = await carregar();
    fake.falharAbertura = new DOMException('sem IndexedDB', 'UnknownError');
    await expect(localAce.put('fila', item('a'))).rejects.toBeInstanceOf(ErroAparelho);
    await expect(localAce.put('fila', item('a'))).rejects.toThrow('Não foi possível guardar no aparelho: feche as outras abas do OmniSaúde e tente de novo');
  });

  it('sem IndexedDB no navegador, a gravação rejeita com a explicação', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { localAce } = await carregar();
    await expect(localAce.put('fila', item('a'))).rejects.toThrow(/não guarda dados no aparelho/);
  });
});

describe('versões do banco (web-offline#1)', () => {
  it('o banco do ACS fica na versão 1 e o do ACE é outro banco', async () => {
    const { local, localAce, BANCO_ACS, BANCO_ACE } = await carregar();
    await local.put('fila', { clientId: 'acs-1' });
    await localAce.put('fila', item('ace-1'));
    expect(fake.bancos.get(BANCO_ACS)!.versao).toBe(1);
    expect([...fake.bancos.get(BANCO_ACS)!.stores.keys()].sort()).toEqual(['cache', 'fila']);
    expect(fake.bancos.get(BANCO_ACE)!.versao).toBe(1);
    expect(fake.linhas(BANCO_ACE, 'fila').map((l) => l.clientId)).toEqual(['ace-1']);
    // A aba com o código anterior (que abre pela versão 1) continua abrindo o banco do ACS.
    await expect(abrirOutraAba(fake, BANCO_ACS, 1)).resolves.toBeDefined();
  });

  it('navegador que já subiu o banco do ACS para a versão 2: abre sem versão e traz a fila do ACE sem perder nada', async () => {
    fake.criar('omnisaude-campo', 2, {
      fila: { keyPath: 'clientId', linhas: [{ clientId: 'acs-1' }] },
      cache: {
        keyPath: 'key',
        linhas: [
          { key: 'historico', data: ['do ACS'] },
          { key: 'tubito:u1', data: 41 },
          { key: 'pacote:ace:un-a:u1', data: { ciclo: 'x' }, savedAt: '2026-11-07T08:00:00Z' },
        ],
      },
      filaAce: { keyPath: 'clientId', linhas: [item('ace-1'), item('ace-2', { status: 'ERRO', erro: 'recusado' })] },
    });
    const { local, localAce } = await carregar();
    // O ACS continua lendo e gravando no banco na versão 2 (sem VersionError).
    expect((await local.all<{ clientId: string }>('fila')).map((i) => i.clientId)).toEqual(['acs-1']);
    await local.put('fila', { clientId: 'acs-2' });
    expect(fake.bancos.get('omnisaude-campo')!.versao).toBe(2);
    // A fila e o cache do ACE foram para o banco do ACE e saíram do antigo; o cache do ACS ficou.
    expect((await localAce.all<{ clientId: string }>('fila')).map((i) => i.clientId).sort()).toEqual(['ace-1', 'ace-2']);
    expect(await localAce.get('cache', 'tubito:u1')).toEqual({ key: 'tubito:u1', data: 41 });
    expect(await localAce.get('cache', 'pacote:ace:un-a:u1')).toMatchObject({ savedAt: '2026-11-07T08:00:00Z' });
    expect(fake.linhas('omnisaude-campo', 'filaAce')).toEqual([]);
    expect(fake.linhas('omnisaude-campo', 'cache').map((l) => l.key)).toEqual(['historico']);
  });

  it('a migração não sobrescreve o que o banco novo já tem', async () => {
    fake.criar('omnisaude-campo-ace', 1, { fila: { keyPath: 'clientId', linhas: [item('ace-1', { rotulo: 'versão nova' })] }, cache: { keyPath: 'key' } });
    fake.criar('omnisaude-campo', 2, { fila: { keyPath: 'clientId' }, cache: { keyPath: 'key' }, filaAce: { keyPath: 'clientId', linhas: [item('ace-1', { rotulo: 'versão velha' })] } });
    const { localAce } = await carregar();
    expect(await localAce.get('fila', 'ace-1')).toMatchObject({ rotulo: 'versão nova' });
  });

  it('a conexão aberta sai do caminho quando outra aba sobe a versão, e a página continua gravando', async () => {
    const { localAce, BANCO_ACE } = await carregar();
    await localAce.put('fila', item('a'));
    const outra = await abrirOutraAba(fake, BANCO_ACE, 2);
    expect(outra.version).toBe(2);
    outra.close();
    await localAce.put('fila', item('b'));
    expect((await localAce.all<{ clientId: string }>('fila')).map((i) => i.clientId).sort()).toEqual(['a', 'b']);
  });

  it('aba antiga segurando o banco quando falta um store: rejeita na hora em vez de pendurar', async () => {
    fake.criar('omnisaude-campo-ace', 1, { fila: { keyPath: 'clientId' } });
    const antiga = await abrirOutraAba(fake, 'omnisaude-campo-ace');
    const { localAce } = await carregar();
    await expect(localAce.put('cache', { key: 'x' })).rejects.toThrow(/outra aba do OmniSaúde/);
    antiga.close();
    await espera();
    // Com a aba antiga fechada, o store que faltava é criado e a gravação passa.
    await localAce.put('cache', { key: 'x' });
    expect(fake.linhas('omnisaude-campo-ace', 'cache')).toEqual([{ key: 'x' }]);
  });

  it('enquanto a aba antiga segura o banco, as operações seguintes também rejeitam na hora (o navegador as põe atrás do pedido de versão)', async () => {
    fake.criar('omnisaude-campo-ace', 1, { fila: { keyPath: 'clientId' } });
    const antiga = await abrirOutraAba(fake, 'omnisaude-campo-ace');
    const { localAce } = await carregar();
    // Primeira operação (no app: a leitura do contador de tubitos ao abrir o diálogo).
    await expect(localAce.get('cache', 'tubito:u1')).rejects.toThrow(/outra aba do OmniSaúde/);
    // Segunda (o Salvar): sem resposta, o botão ficaria girando até a outra aba fechar.
    const salvar = localAce.put('fila', item('a')).then(
      () => 'gravou',
      (e: Error) => e.message,
    );
    expect(await Promise.race([salvar, espera(300).then(() => 'pendurou')])).toMatch(/outra aba do OmniSaúde/);
    antiga.close();
    await espera();
    await localAce.put('fila', item('a'));
    expect(fake.linhas('omnisaude-campo-ace', 'fila').map((l) => l.clientId)).toEqual(['a']);
  });
});

describe('banco do ACS', () => {
  it('leitura com falha devolve vazio e o cache é melhor esforço; a fila do ACS propaga a falha', async () => {
    const { local, ErroAparelho } = await carregar();
    fake.falharAbertura = new DOMException('falhou', 'UnknownError');
    await expect(local.all('fila')).resolves.toEqual([]);
    await expect(local.get('cache', 'historico')).resolves.toBeUndefined();
    await expect(local.put('cache', { key: 'territorio' })).resolves.toBeUndefined();
    await expect(local.put('fila', { clientId: 'c' })).rejects.toBeInstanceOf(ErroAparelho);
    await expect(local.atualizar('fila', 'c', () => ({ clientId: 'c' }))).rejects.toBeInstanceOf(ErroAparelho);
  });
});

describe('atualizar: ler e regravar um registro numa transação só', () => {
  interface Item {
    clientId: string;
    status: string;
    erro: string | null;
    [campo: string]: unknown;
  }

  it('grava o que fn devolve e resolve com isso; com undefined não grava', async () => {
    const { localAce } = await carregar();
    await localAce.put('fila', item('a'));
    await expect(localAce.atualizar<Item>('fila', 'a', (i) => i && { ...i, status: 'ERRO', erro: 'Recusado' })).resolves.toMatchObject({ clientId: 'a', status: 'ERRO' });
    const vistos: unknown[] = [];
    await expect(
      localAce.atualizar<Item>('fila', 'b', (i) => {
        vistos.push(i);
        return undefined;
      }),
    ).resolves.toBeUndefined();
    expect(vistos).toEqual([undefined]);
    expect(fake.linhas('omnisaude-campo-ace', 'fila')).toEqual([item('a', { status: 'ERRO', erro: 'Recusado' })]);
  });

  it('a gravação de outra aba pedida entre a leitura e a gravação fica depois dela (não é desfeita)', async () => {
    const { localAce, BANCO_ACE } = await carregar();
    await localAce.put('fila', item('a'));
    const outra = await abrirOutraAba(fake, BANCO_ACE);
    let descarte: Promise<'complete' | 'abort'> | null = null;
    fake.aoLer = ({ chave }) => {
      if (chave !== 'a' || descarte) return;
      const t = outra.transaction(['fila'], 'readwrite');
      t.objectStore('fila').delete('a');
      descarte = new Promise((resolve) => {
        t.oncomplete = () => resolve('complete');
        t.onabort = () => resolve('abort');
      });
    };
    await localAce.atualizar<Item>('fila', 'a', (i) => i && { ...i, status: 'ERRO' });
    expect(await descarte).toBe('complete');
    expect(fake.linhas(BANCO_ACE, 'fila')).toEqual([]);
  });

  it('fn que lança ou valor novo que não se copia: a transação é cancelada, rejeita com a causa e nada muda', async () => {
    const { localAce, ErroAparelho } = await carregar();
    await localAce.put('fila', item('a'));
    const falha = new Error('fn falhou');
    await expect(
      localAce.atualizar<Item>('fila', 'a', () => {
        throw falha;
      }),
    ).rejects.toMatchObject({ name: 'ErroAparelho', causa: falha });
    await expect(localAce.atualizar<Item>('fila', 'a', (i) => i && { ...i, status: 'ERRO', anexo: () => undefined })).rejects.toBeInstanceOf(ErroAparelho);
    expect(await localAce.get('fila', 'a')).toEqual(item('a'));
  });
});

describe('atualizarVarios: ler vários registros e gravar numa transação só', () => {
  interface Item {
    clientId: string;
    status: string;
    erro: string | null;
    [campo: string]: unknown;
  }

  it('lê as chaves pedidas (ou o store inteiro) e grava o que fn devolve nos dois stores; resolve com as gravações', async () => {
    const { localAce, BANCO_ACE } = await carregar();
    await localAce.gravar([
      { store: 'fila', put: item('a') },
      { store: 'fila', put: item('b') },
      { store: 'cache', put: { key: 'historico-ace:u1', data: ['x'] } },
    ]);
    const vistos: Record<string, unknown> = {};
    const gravacoes = [
      { store: 'fila' as const, delete: 'a' },
      { store: 'fila' as const, put: item('b', { status: 'ERRO', erro: 'Recusado' }) },
      { store: 'cache' as const, put: { key: 'historico-ace:u1', data: ['a', 'x'] } },
    ];
    await expect(
      localAce.atualizarVarios({ fila: 'todas', cache: ['historico-ace:u1', 'tubito:u1'] }, (lidos) => {
        vistos.fila = [...lidos.fila.keys()].sort();
        vistos.cache = [...lidos.cache.keys()];
        vistos.b = lidos.fila.get('b');
        return gravacoes;
      }),
    ).resolves.toEqual(gravacoes);
    // A chave que não está guardada não aparece.
    expect(vistos).toEqual({ fila: ['a', 'b'], cache: ['historico-ace:u1'], b: item('b') });
    expect(fake.linhas(BANCO_ACE, 'fila')).toEqual([item('b', { status: 'ERRO', erro: 'Recusado' })]);
    expect(fake.linhas(BANCO_ACE, 'cache')).toEqual([{ key: 'historico-ace:u1', data: ['a', 'x'] }]);
    // O store inteiro do cache vem pela chave 'key'; sem nada a ler, fn roda do mesmo jeito.
    await localAce.atualizarVarios({ cache: 'todas' }, (lidos) => {
      vistos.todoCache = [...lidos.cache.keys()];
      return [];
    });
    expect(vistos.todoCache).toEqual(['historico-ace:u1']);
    await expect(localAce.atualizarVarios({}, () => [{ store: 'cache', put: { key: 'tubito:u1', data: 3 } }])).resolves.toHaveLength(1);
    expect(await localAce.get('cache', 'tubito:u1')).toEqual({ key: 'tubito:u1', data: 3 });
  });

  it('a gravação de outra aba pedida entre a leitura e a gravação fica depois dela (não é desfeita)', async () => {
    const { localAce, BANCO_ACE } = await carregar();
    await localAce.put('fila', item('a'));
    const outra = await abrirOutraAba(fake, BANCO_ACE);
    let descarte: Promise<'complete' | 'abort'> | null = null;
    fake.aoLer = ({ store }) => {
      if (store !== 'fila' || descarte) return;
      const t = outra.transaction(['fila'], 'readwrite');
      t.objectStore('fila').delete('a');
      descarte = new Promise((resolve) => {
        t.oncomplete = () => resolve('complete');
        t.onabort = () => resolve('abort');
      });
    };
    await localAce.atualizarVarios({ fila: ['a'] }, (lidos) => {
      const a = lidos.fila.get('a') as Item | undefined;
      return a ? [{ store: 'fila', put: { ...a, status: 'ERRO', erro: 'Recusado' } }] : [];
    });
    expect(await descarte).toBe('complete');
    expect(fake.linhas(BANCO_ACE, 'fila')).toEqual([]);
  });

  it('fn que lança, gravação que não se copia ou cota estourada: rejeita com a causa e nada muda', async () => {
    const { localAce, ErroAparelho, BANCO_ACE } = await carregar();
    await localAce.put('fila', item('a'));
    const falha = new Error('fn falhou');
    await expect(
      localAce.atualizarVarios({ fila: ['a'] }, () => {
        throw falha;
      }),
    ).rejects.toMatchObject({ name: 'ErroAparelho', causa: falha });
    await expect(
      localAce.atualizarVarios({ fila: 'todas' }, () => [
        { store: 'fila', delete: 'a' },
        { store: 'cache', put: { key: 'tubito:u1', data: 4 } },
        { store: 'fila', put: item('b', { anexo: () => undefined }) },
      ]),
    ).rejects.toBeInstanceOf(ErroAparelho);
    fake.cancelarNaConfirmacao = true;
    await expect(localAce.atualizarVarios({ fila: ['a'] }, () => [{ store: 'fila', delete: 'a' }])).rejects.toThrow(/espaço de armazenamento acabou/);
    fake.cancelarNaConfirmacao = false;
    expect(fake.linhas(BANCO_ACE, 'fila')).toEqual([item('a')]);
    expect(fake.linhas(BANCO_ACE, 'cache')).toEqual([]);
  });
});
