import http from 'node:http';
import { semanaDaData, type DetalheImportacao, type EtapaImportacao } from '@omnisaude/shared';
import { zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '../src/core/context';
import { TenantsService } from '../src/core/database';
import { ImportacaoService, type MomentoDoGancho } from '../src/modules/vigilancia/importacao.service';
import { lerEnvio } from '../src/modules/vigilancia/importacao/leitura';
import { aplicarParte, colunasDoEstado, estadoDoBanco, hashDoEstado, SELECT_ESTADO, type LinhaEstado } from '../src/modules/vigilancia/importacao/mescla';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Importação (VIG-1c), terceira rodada, com o banco: o sinal de vida da aplicação longa depois dos INSERTs (FOR NO KEY
 * UPDATE), outro processo que não a dá como interrompida e o reenvio do mesmo arquivo por outra instância
 * (importacao-em-fundo); a trava da conciliação presa pela aplicação (K5); o 409 antes de ler o corpo (imp-memoria); o
 * UPDATE em lote comparado com o caminho antigo (IMPORTACAO-3); o acompanhamento sem a prévia nominal e sem auditoria
 * (IMPORTACAO-4/TELAS-1); a correção do período depois de aplicado (aviso-periodo-lido); e o CNES do arquivo gravado em
 * official_imports.files (contrato com a conciliação). Os testes seguram o trabalho com o gancho do serviço. Sintéticos.
 */

const enabled = await pgAvailable();
const MUN = '355030';
const UBS = '9000011';
const ESPERA = ImportacaoService.esperaMs;
const SINAL = ImportacaoService.sinalMs;
const PARADO = ImportacaoService.sinalParadoMs;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Segura o trabalho na etapa e no momento até `soltar()`; `chegou` resolve quando ele para no gancho. */
function segurar(etapa: EtapaImportacao, momento: MomentoDoGancho) {
  let soltar = () => {};
  let marcar = () => {};
  const solto = new Promise<void>((r) => (soltar = r));
  const chegou = new Promise<void>((r) => (marcar = r));
  ImportacaoService.ganchoDeTeste = async (e, _id, m) => {
    if (e !== etapa || m !== momento) return;
    marcar();
    await solto;
  };
  return { chegou, soltar };
}

/** Um gancho que segura um trabalho até `soltar()`. */
function trava() {
  let soltar = () => {};
  let marcar = () => {};
  const solto = new Promise<void>((r) => (soltar = r));
  const chegou = new Promise<void>((r) => (marcar = r));
  return {
    chegou,
    soltar,
    async esperar() {
      marcar();
      await solto;
    },
  };
}

/** Espera `fn` devolver algo (consulta a cada 50 ms), com teto de tempo. */
async function esperar<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const fim = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fim) throw new Error('tempo esgotado esperando a condição');
    await pausa(50);
  }
}

describe.runIf(enabled)('importação, terceira rodada: segundo plano, travas, 409 antes do corpo, UPDATE em lote, acompanhamento e período', () => {
  let t: TestApp;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let tenant: Awaited<ReturnType<TenantsService['resolve']>>;
  let seq = 0;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  const nindinet = (n: string, dt: string, v: Record<string, ValorEscrita> = {}) => ({
    NU_NOTIFIC: n,
    TP_NOT: '2',
    ID_AGRAVO: 'A279',
    DT_NOTIFIC: dt,
    SEM_NOT: semanaDaData(dt).codigo,
    NU_ANO: dt.slice(0, 4),
    SG_UF_NOT: '35',
    ID_MUNICIP: MUN,
    ID_UNIDADE: UBS,
    SG_UF: '35',
    ID_MN_RESI: MUN,
    NM_PACIENT: `PACIENTE R3 ${n}`,
    CS_SEXO: 'F',
    NM_BAIRRO: 'CENTRO',
    ...v,
  });
  /** NINDINET com `n` registros novos (números a partir de `base`). */
  const arquivo = (n: number) => {
    seq++;
    const base = 6_100_000 + seq * 1000;
    return {
      bytes: escreverDbf(
        CAMPOS_NINDINET,
        Array.from({ length: n }, (_, i) => nindinet(String(base + i), `2024-07-${String(1 + (i % 28)).padStart(2, '0')}`)),
      ),
      base,
    };
  };
  const numeros = (base: number, n: number) => Array.from({ length: n }, (_, i) => String(base + i));

  const enviar = (bytes: Uint8Array, nome: string, q: Record<string, string> = {}) =>
    t
      .http()
      .post('/api/vigilancia/importacoes')
      .query({ nome, ...q })
      .set(auth(vig))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(bytes));
  const aplicar = (id: string) => t.http().post(`/api/vigilancia/importacoes/${id}/aplicar`).set(auth(vig));
  const detalhe = async (id: string, acompanhar = false) =>
    (
      await t
        .http()
        .get(`/api/vigilancia/importacoes/${id}`)
        .query(acompanhar ? { acompanhar: '1' } : {})
        .set(auth(vig))
        .expect(200)
    ).body as DetalheImportacao;
  const linha = (id: string) => db.officialImport.findUniqueOrThrow({ where: { id }, select: { status: true, workingStep: true, workingAt: true, error: true, appliedAt: true } });
  /** Consulta o detalhe (no modo de acompanhamento) até `pronto` e espera o trabalho soltar a vez. */
  const acompanhar = async (id: string, pronto: (d: DetalheImportacao) => boolean) => {
    const d = await esperar(async () => {
      const x = await detalhe(id, true);
      return pronto(x) ? x : null;
    });
    await ImportacaoService.aguardarTrabalhos();
    return d;
  };
  const previaPronta = async (n = 2) => {
    const a = arquivo(n);
    const r = await enviar(a.bytes, `r3-${seq}.dbf`).expect(201);
    return { d: r.body as DetalheImportacao, ...a };
  };
  const leiturasNominais = (id: string) => db.auditEntry.count({ where: { action: 'vigilancia.importacao_ver_previa', entityId: id } });

  /**
   * POST do envio com o corpo em duas vezes (cliente HTTP cru): manda os primeiros 100 bytes e fica esperando; `resto()`
   * manda o resto. A resposta chega antes do resto só quando o servidor responde sem ler o corpo.
   */
  const envioLento = (dados: Buffer, nome: string) => {
    const url = new URL(t.baseUrl.replace('[::1]', '127.0.0.1'));
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `/api/vigilancia/importacoes?nome=${encodeURIComponent(nome)}`,
      method: 'POST',
      headers: { authorization: `Bearer ${vig}`, 'content-type': 'application/octet-stream', 'content-length': String(dados.length) },
    });
    const resposta = new Promise<{ status: number; corpo: { code?: string; message?: string; status?: string } | null }>((ok, falha) => {
      req.on('response', (res) => {
        let s = '';
        res.on('data', (c: Buffer) => (s += c.toString()));
        res.on('end', () => ok({ status: res.statusCode!, corpo: s ? JSON.parse(s) : null }));
      });
      req.on('error', falha);
    });
    req.write(dados.subarray(0, 100));
    return { resposta, resto: () => req.end(dados.subarray(100)), fechar: () => req.destroy() };
  };
  /** A resposta, ou null se ela não chegar em `ms`. */
  const emAte = <T>(p: Promise<T>, ms: number) => Promise.race([p, pausa(ms).then(() => null)]);

  beforeAll(async () => {
    t = await startTestApp('vigimpr3');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
  }, 120_000);

  afterEach(async () => {
    ImportacaoService.ganchoDeTeste = null;
    await ImportacaoService.aguardarTrabalhos();
    ImportacaoService.esperaMs = ESPERA;
    ImportacaoService.sinalMs = SINAL;
    ImportacaoService.sinalParadoMs = PARADO;
  });

  afterAll(async () => {
    ImportacaoService.ganchoDeTeste = null;
    await ImportacaoService.aguardarTrabalhos();
    await t?.close();
  });

  it('importacao-em-fundo e K5: segura depois dos INSERTs, o sinal de vida avança, outro processo não a dá como interrompida e a trava da conciliação fica com ela', async () => {
    const { d, base } = await previaPronta(5);
    ImportacaoService.sinalMs = 40;
    ImportacaoService.sinalParadoMs = 600;
    ImportacaoService.esperaMs = 0;
    const s = segurar('APLICANDO', 'GRAVADO');
    expect((await aplicar(d.id).expect(202)).body).toEqual({ id: d.id, status: 'APLICANDO' });
    await s.chegou;
    try {
      // Os registros já estão gravados na transação: a linha da importação está presa pelas chaves estrangeiras.
      const s1 = (await linha(d.id)).workingAt!;
      await pausa(1500);
      const s2 = (await linha(d.id)).workingAt!;
      expect(s2.getTime()).toBeGreaterThan(s1.getTime());
      expect(Date.now() - s2.getTime()).toBeLessThan(600);

      // K5: as travas da importação e da conciliação estão com a aplicação (outra sessão não consegue).
      const [travas] = await db.$transaction(
        (tx) =>
          tx.$queryRaw<{ conciliacao: boolean; importacao: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext('vigilancia:conciliacao')) AS conciliacao, pg_try_advisory_xact_lock(hashtext('vigilancia:importacao')) AS importacao`,
      );
      expect(travas).toEqual({ conciliacao: false, importacao: false });

      // Outro processo (o worker do job 'vigilancia', a outra réplica), sem este trabalho no registro: o job das prévias
      // vencidas, a lista e o detalhe rodam a recuperação dos interrompidos e não tocam a aplicação viva.
      const volta = ImportacaoService.comoOutroProcesso();
      try {
        await t.app.get(ImportacaoService).expirarPrevias(db, new Date(), 24);
        await t.http().get('/api/vigilancia/importacoes').set(auth(vig)).expect(200);
        expect(await detalhe(d.id, true)).toMatchObject({ status: 'PREVIA', processamento: { etapa: 'APLICANDO' }, erro: null });
      } finally {
        volta();
      }
      expect(await linha(d.id)).toMatchObject({ status: 'PREVIA', workingStep: 'APLICANDO', error: null });
    } finally {
      s.soltar();
    }
    const fim = await acompanhar(d.id, (x) => !x.processamento);
    expect(fim).toMatchObject({ status: 'APLICADA', erro: null, resultadoAplicacao: { contagens: { novos: 5 } } });
    expect(await db.officialRecord.count({ where: { number: { in: numeros(base, 5) } } })).toBe(5);
  });

  it('importacao-em-fundo: o reenvio do mesmo arquivo por outra instância, durante a aplicação, não descarta a prévia que está sendo aplicada', async () => {
    const { d, bytes, base } = await previaPronta(3);
    ImportacaoService.sinalMs = 40;
    ImportacaoService.sinalParadoMs = 600;
    ImportacaoService.esperaMs = 0;
    const leitura = trava();
    const aplicacao = trava();
    ImportacaoService.ganchoDeTeste = async (etapa, _id, momento) => {
      if (etapa === 'LENDO') await leitura.esperar();
      else if (momento === 'GRAVADO') await aplicacao.esperar();
    };
    // A outra instância começou a ler o mesmo arquivo antes da aplicação (nada rodava: passou pela conferência da vez).
    const volta = ImportacaoService.comoOutroProcesso();
    let reenvio: string;
    try {
      reenvio = (await enviar(bytes, 'reenvio.dbf').expect(202)).body.id as string;
    } finally {
      volta();
    }
    try {
      await leitura.chegou;
      await aplicar(d.id).expect(202);
      await aplicacao.chegou;
      // Mais que o limite do sinal parado: sem o sinal de vida, a prévia em aplicação pareceria abandonada.
      await pausa(1500);
      leitura.soltar();
      const lida = await esperar(async () => {
        const x = await detalhe(reenvio, true);
        return x.status !== 'PROCESSANDO' ? x : null;
      });
      expect(lida.status).toBe('PREVIA');
      expect(await linha(d.id)).toMatchObject({ status: 'PREVIA', workingStep: 'APLICANDO', error: null });
    } finally {
      leitura.soltar();
      aplicacao.soltar();
    }
    expect(await acompanhar(d.id, (x) => !x.processamento)).toMatchObject({ status: 'APLICADA', erro: null });
    expect(await db.officialRecord.count({ where: { number: { in: numeros(base, 3) } } })).toBe(3);
    // A prévia do reenvio é do arquivo que acabou de ser aplicado: aplicar dá 409 (dentro da espera).
    ImportacaoService.ganchoDeTeste = null;
    ImportacaoService.esperaMs = ESPERA;
    expect((await aplicar(reenvio).expect(409)).body.message).toContain('já foi aplicado');
  });

  it('imp-memoria (b): com outra importação do tenant em andamento, o envio recebe 409 antes de o corpo ser lido', async () => {
    ImportacaoService.esperaMs = 0;
    const s = segurar('LENDO', 'INICIO');
    const r = await enviar(arquivo(1).bytes, 'segura.dbf').expect(202);
    await s.chegou;
    const lento = envioLento(Buffer.alloc(8 * 1024 * 1024, 0x20), 'grande.dbf');
    try {
      // O corpo declarado tem 8 MB e só 100 bytes foram mandados: a resposta chega sem o servidor esperar o resto.
      const resposta = await emAte(lento.resposta, 5000);
      expect(resposta).toEqual({ status: 409, corpo: expect.objectContaining({ code: 'IMPORTACAO_OCUPADA', message: 'Outra importação está sendo processada agora. Tente de novo em alguns minutos.' }) });
      expect(ImportacaoService.cargas).toBe(1);
    } finally {
      lento.fechar();
      s.soltar();
    }
    expect((await acompanhar(r.body.id as string, (x) => x.status !== 'PROCESSANDO')).status).toBe('PREVIA');
    expect(ImportacaoService.cargas).toBe(0);
  });

  it('imp-memoria (a): com dois arquivos na memória do processo (corpos sendo lidos), o terceiro envio recebe 409 antes de o corpo ser lido', async () => {
    // Quarta rodada: um envio por tenant (o segundo do mesmo tenant já recebe 409). Os dois corpos sendo lidos são de
    // outros dois tenants, pelo serviço (o corpo fica pendente até o teste soltar); o terceiro chega pela API.
    const svc = t.app.get(ImportacaoService);
    const ctx = (id: string) => ({ db, tenant: { ...tenant, id }, session: { userId: '00000000-0000-0000-0000-000000000000' }, ip: '127.0.0.1' }) as unknown as RequestContext;
    const soltar: ((corpo: Buffer) => void)[] = [];
    const outros = ['tenant-b', 'tenant-c'].map((id) =>
      svc
        .enviar(ctx(id), () => new Promise<Buffer>((ok) => soltar.push(ok)), { nome: `${id}.dbf` })
        .then(
          () => 'leu',
          (e: { code?: string }) => e.code ?? 'erro',
        ),
    );
    try {
      await esperar(async () => ImportacaoService.cargas === 2);
      const terceiro = envioLento(Buffer.alloc(8 * 1024 * 1024, 0x20), 'terceiro.dbf');
      try {
        expect(await emAte(terceiro.resposta, 5000)).toEqual({
          status: 409,
          corpo: expect.objectContaining({ code: 'IMPORTACAO_SERVIDOR_OCUPADO', message: 'O servidor está recebendo ou processando outros envios agora. Tente de novo em instantes.' }),
        });
      } finally {
        terceiro.fechar();
      }
    } finally {
      // Os corpos dos outros tenants chegam vazios: 400, e as cargas voltam.
      for (const s of soltar) s(Buffer.alloc(0));
    }
    expect(await Promise.all(outros)).toEqual(['ARQUIVO_VAZIO', 'ARQUIVO_VAZIO']);
    await ImportacaoService.aguardarTrabalhos();
    expect(ImportacaoService.cargas).toBe(0);
    await enviar(arquivo(1).bytes, 'depois.dbf').expect(201);
  });

  it('IMPORTACAO-3: alterados e iguais com fontes diferentes em UPDATE em lote, com os mesmos campos do caminho antigo, em tempo próximo do INSERT', async () => {
    const N = 4000;
    const base = 6_900_000;
    const registro = (i: number, v: Record<string, ValorEscrita> = {}) =>
      nindinet(String(base + i), `2022-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, { NM_PACIENT: `PACIENTE R3 ${i} DA SILVA`, CS_SEXO: i % 2 ? 'F' : 'M', ...v });
    const nomes = numeros(base, N);
    const ler = async () =>
      new Map(
        (
          await db.officialRecord.findMany({
            where: { number: { in: nomes } },
            select: { ...SELECT_ESTADO, system: true, situation: true, severity: true, sensitive: true, patientNameNorm: true, lastImportId: true, lastSeenAt: true, updatedAt: true },
          })
        ).map((r) => [r.number, r]),
      );
    /** Envia (caminho rápido), aplica e mede só o aplicar. */
    const importar = async (bytes: Uint8Array, nome: string) => {
      const d = (await enviar(bytes, nome).expect(201)).body as DetalheImportacao;
      const t0 = Date.now();
      const r = (await aplicar(d.id).expect(200)).body;
      return { d, ms: Date.now() - t0, contagens: r.contagens as DetalheImportacao['contagens'], aplicadoEm: new Date(r.aplicadoEm as string) };
    };
    /** O que o caminho antigo gravava em cada registro (colunasDoEstado do estado mesclado, hash, última importação). */
    const esperado = async (bytes: Uint8Array, nome: string, antes: Map<string, LinhaEstado & { system: string }>) => {
      const l = await lerEnvio(nome, bytes, { hoje: '2026-11-17', municipio: '3550308' });
      const out = new Map<string, { colunas: ReturnType<typeof colunasDoEstado>; hash: string }>();
      try {
        for await (const lote of l.registros(500))
          for (const r of lote) {
            const depois = r.partes.reduce(aplicarParte, estadoDoBanco(antes.get(r.partes[0]!.numero)!));
            out.set(r.partes[0]!.numero, { colunas: colunasDoEstado(r.sistema, depois, new Set()), hash: hashDoEstado(r.sistema, r.tipo, depois) });
          }
      } finally {
        l.fechar();
      }
      return out;
    };
    const conferir = (depois: Awaited<ReturnType<typeof ler>>, antes: Awaited<ReturnType<typeof ler>>, alvo: Awaited<ReturnType<typeof esperado>>, importacao: string, aplicadoEm: Date) => {
      const valor = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
      for (const n of nomes) {
        const r = depois.get(n)!;
        const e = alvo.get(n)!;
        const gravado = Object.fromEntries(Object.keys(e.colunas).map((k) => [k, valor(r[k as keyof typeof r])]));
        expect(gravado).toEqual(Object.fromEntries(Object.entries(e.colunas).map(([k, v]) => [k, valor(v)])));
        expect(r).toMatchObject({ contentHash: e.hash, lastImportId: importacao, absentSince: null, system: 'SINAN_NET' });
        expect(r.lastSeenAt.getTime()).toBe(aplicadoEm.getTime());
        expect(r.updatedAt.getTime()).toBeGreaterThanOrEqual(aplicadoEm.getTime());
        expect(r.updatedAt.getTime()).toBeGreaterThan(antes.get(n)!.updatedAt.getTime());
      }
    };

    const novos = await importar(
      zipSync({
        'NINDINET.DBF': escreverDbf(
          CAMPOS_NINDINET,
          Array.from({ length: N }, (_, i) => registro(i)),
        ),
      }),
      'r3-tempo-novos.zip',
    );
    expect(novos.contagens).toMatchObject({ novos: N, alterados: 0 });

    // Todos alterados (bairro; sexo e nome em parte deles).
    const bytesAlterados = zipSync({
      'NINDINET.DBF': escreverDbf(
        CAMPOS_NINDINET,
        Array.from({ length: N }, (_, i) => registro(i, { NM_BAIRRO: 'VILA NOVA', ...(i % 3 ? {} : { CS_SEXO: i % 2 ? 'M' : 'F' }), ...(i % 5 ? {} : { NM_PACIENT: `PACIENTE R3 ${i} DE SOUZA` }) })),
      ),
    });
    const antes1 = await ler();
    const alvo1 = await esperado(bytesAlterados, 'r3-tempo-alterados.zip', antes1);
    const alterados = await importar(bytesAlterados, 'r3-tempo-alterados.zip');
    expect(alterados.contagens).toMatchObject({ novos: 0, alterados: N, iguais: 0 });
    conferir(await ler(), antes1, alvo1, alterados.d.id, alterados.aplicadoEm);

    // Iguais no conteúdo, vindos do NINDINET e do DBF do agravo: só as fontes mudam.
    const investigacao: CampoEscrita[] = [...CAMPOS_NINDINET, { nome: 'RES_ELISA', tipo: 'C', tamanho: 1 }];
    const linhasIguais = Array.from({ length: N }, (_, i) => registro(i, { NM_BAIRRO: 'VILA NOVA', ...(i % 3 ? {} : { CS_SEXO: i % 2 ? 'M' : 'F' }), ...(i % 5 ? {} : { NM_PACIENT: `PACIENTE R3 ${i} DE SOUZA` }) }));
    const bytesFontes = zipSync({ 'NINDINET.DBF': escreverDbf(CAMPOS_NINDINET, linhasIguais), 'LEPTONET.DBF': escreverDbf(investigacao, linhasIguais) });
    const antes2 = await ler();
    const alvo2 = await esperado(bytesFontes, 'r3-tempo-fontes.zip', antes2);
    const fontes = await importar(bytesFontes, 'r3-tempo-fontes.zip');
    expect(fontes.contagens).toMatchObject({ novos: 0, alterados: 0, iguais: N });
    const depois2 = await ler();
    conferir(depois2, antes2, alvo2, fontes.d.id, fontes.aplicadoEm);
    expect((depois2.get(String(base)) as { data: { _fontes: Record<string, string> } }).data._fontes).toMatchObject({ nome: 'AGRAVO_NET', numero: 'AGRAVO_NET' });

    console.log(`[IMPORTACAO-3] aplicar ${N} registros: novos ${novos.ms} ms, alterados ${alterados.ms} ms, iguais com fontes diferentes ${fontes.ms} ms`);
    // Antes (um UPDATE por registro), o alterado custava umas 7 vezes o novo.
    expect(alterados.ms).toBeLessThan(novos.ms * 3);
    expect(fontes.ms).toBeLessThan(novos.ms * 3);
    expect(await db.officialRecord.count({ where: { number: { in: nomes } } })).toBe(N);
  }, 300_000);

  it('IMPORTACAO-4/TELAS-1: o acompanhamento (?acompanhar=1) e o detalhe durante a aplicação vêm sem a prévia nominal e não vão para a auditoria', async () => {
    const { d } = await previaPronta(3);
    expect(d.previa!.novos.map((n) => n.paciente)).toEqual(expect.arrayContaining([expect.stringContaining('PACIENTE R3')]));
    // Abrir a prévia pelo histórico fica na trilha; o acompanhamento, não.
    expect((await detalhe(d.id)).previa!.novos).toHaveLength(3);
    expect(await leiturasNominais(d.id)).toBe(1);
    const acompanhamento = await detalhe(d.id, true);
    expect(acompanhamento).toMatchObject({ id: d.id, status: 'PREVIA', previa: null, processamento: null, contagens: { novos: 3 } });
    expect(await leiturasNominais(d.id)).toBe(1);

    ImportacaoService.esperaMs = 0;
    const s = segurar('APLICANDO', 'INICIO');
    await aplicar(d.id).expect(202);
    await s.chegou;
    try {
      for (let k = 0; k < 4; k++) {
        expect(await detalhe(d.id, true)).toMatchObject({ status: 'PREVIA', processamento: { etapa: 'APLICANDO' }, previa: null });
        expect(await detalhe(d.id)).toMatchObject({ status: 'PREVIA', processamento: { etapa: 'APLICANDO' }, previa: null });
      }
      expect(await leiturasNominais(d.id)).toBe(1);
    } finally {
      s.soltar();
    }
    expect(await acompanhar(d.id, (x) => !x.processamento)).toMatchObject({ status: 'APLICADA', previa: null, resultadoAplicacao: { contagens: { novos: 3 } } });
    expect(await leiturasNominais(d.id)).toBe(1);
  });

  it('aviso-periodo-lido: o mesmo arquivo com outro período declarado gera prévia nova e corrige o período sem duplicar; sem período ou com o mesmo, jaImportado', async () => {
    const coqueluche = (n: string, dt: string) => nindinet(n, dt, { ID_AGRAVO: 'A379' });
    // Um registro de junho de 2023 já gravado; o arquivo A (março) não o traz.
    const junho = (await enviar(escreverDbf(CAMPOS_NINDINET, [coqueluche('6400001', '2023-06-10')]), 'r3-junho.dbf').expect(201)).body as DetalheImportacao;
    await aplicar(junho.id).expect(200);
    const a = escreverDbf(CAMPOS_NINDINET, [coqueluche('6400011', '2023-03-04'), coqueluche('6400012', '2023-03-11'), coqueluche('6400013', '2023-03-18')]);
    const lido = (await enviar(a, 'r3-coqueluche.dbf').expect(201)).body as DetalheImportacao;
    expect(lido).toMatchObject({ periodo: { de: '2023-03-04', ate: '2023-03-18' }, periodoDeclarado: false, contagens: { novos: 3, ausentesPrevistos: 0 } });
    await aplicar(lido.id).expect(200);
    const todos = () => db.officialRecord.count({ where: { number: { in: ['6400001', '6400011', '6400012', '6400013'] } } });
    expect(await todos()).toBe(4);

    // Sem período: já importado.
    expect((await enviar(a, 'r3-coqueluche.dbf').expect(200)).body).toEqual({ jaImportado: { id: lido.id, aplicadoEm: expect.any(String) } });
    // Com o ano declarado: prévia nova, nada novo nem alterado, e os ausentes calculados no período declarado.
    const ano = { de: '2023-01-01', ate: '2023-12-31' };
    const corrigido = (await enviar(a, 'r3-coqueluche.dbf', ano).expect(201)).body as DetalheImportacao;
    expect(corrigido).toMatchObject({ status: 'PREVIA', periodo: ano, periodoDeclarado: true, contagens: { novos: 0, alterados: 0, iguais: 3, ausentesPrevistos: 1 } });
    expect(corrigido.previa!.ausentes.map((x) => x.numero)).toEqual(['6400001']);
    const r = (await aplicar(corrigido.id).expect(200)).body;
    expect(r).toMatchObject({ contagens: { novos: 0, alterados: 0, iguais: 3 }, ausentesMarcados: 1 });
    expect(await todos()).toBe(4);
    expect((await db.officialRecord.findFirstOrThrow({ where: { number: '6400001' } })).absentSince).not.toBeNull();
    // A correção substitui a primeira aplicação (quarta rodada: vale só a aplicação mais recente do arquivo).
    const sha = lido.sha256;
    expect(await db.officialImport.count({ where: { sha256: sha, status: 'APLICADA' } })).toBe(1);
    expect(await db.officialImport.findUniqueOrThrow({ where: { id: lido.id }, select: { status: true, supersededBy: true } })).toEqual({ status: 'SUBSTITUIDA', supersededBy: corrigido.id });

    // O mesmo período declarado de novo, ou sem período: já importado (a aplicação com período, a mais recente).
    expect((await enviar(a, 'r3-coqueluche.dbf', ano).expect(200)).body).toEqual({ jaImportado: { id: corrigido.id, aplicadoEm: expect.any(String) } });
    expect((await enviar(a, 'r3-coqueluche.dbf').expect(200)).body).toEqual({ jaImportado: { id: corrigido.id, aplicadoEm: expect.any(String) } });
    expect(await todos()).toBe(4);
  });

  it('contrato com a conciliação: o CNES único do arquivo vai para official_imports.files (null no NINDINET)', async () => {
    const cab = ['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Sintoma- Febre', 'Classificação Final'];
    const csv = `${cab.join(';')}\r\n${['352400000901', '352400000902'].map((n) => [n, '10/06/2024', '3550308', UBS, `Pessoa ${n}`, 'Sim', 'Descartado'].join(';')).join('\r\n')}\r\n`;
    const d = (await enviar(new TextEncoder().encode(csv), 'r3-notifica.csv').expect(201)).body as DetalheImportacao;
    expect(d.arquivos).toEqual([expect.objectContaining({ tipo: 'ESUS_NOTIFICA_CSV', cnes: UBS })]);
    const gravado = await db.officialImport.findUniqueOrThrow({ where: { id: d.id }, select: { files: true } });
    expect(gravado.files).toEqual([expect.objectContaining({ nome: 'r3-notifica.csv', cnes: UBS })]);
    const n = await previaPronta(1);
    expect(n.d.arquivos).toEqual([expect.objectContaining({ tipo: 'NINDINET', cnes: null })]);
  });
});
