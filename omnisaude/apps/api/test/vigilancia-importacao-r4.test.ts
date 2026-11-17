import http from 'node:http';
import { semanaDaData, type DetalheImportacao, type ListaImportacoes, type ResultadoAplicacao } from '@omnisaude/shared';
import { zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '../src/core/context';
import { TenantsService } from '../src/core/database';
import { LeituraDoCorpo } from '../src/core/raw-body';
import { ConsolidadoService } from '../src/modules/vigilancia/consolidado.service';
import { ImportacaoService } from '../src/modules/vigilancia/importacao.service';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Importação (VIG-1c), quarta rodada, com o banco:
 * - N0: o zip com os CSV do e-SUS Notifica de algumas unidades (um CNES por arquivo) só marca ausentes nessas unidades;
 * - aviso-periodo-lido: o envio aplicado mais recente do mesmo arquivo substitui os anteriores (SUBSTITUIDA): os
 *   ausentes que a substituída marcou fora da cobertura nova voltam, a cobertura dela some da base consolidada e da
 *   conciliação, e a cobertura dos ausentes termina na data do primeiro envio do arquivo;
 * - N1 e N2: o corpo parado solta a carga (408), um envio por tenant, o 413 antes do corpo, o envio incompleto e os
 *   códigos dos 409 (IMPORTACAO_SERVIDOR_OCUPADO para o processo, IMPORTACAO_OCUPADA para a importação do tenant).
 * Dados sintéticos.
 */

const enabled = await pgAvailable();
const MUN = '355030';
const UBS = '9000011';
const X = '9000011';
const Y = '9000028';
const Z = '9000036';
const ESPERA = ImportacaoService.esperaMs;
const OCIOSO = LeituraDoCorpo.ociosoMs;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DIA = 86_400_000;
/** Data local (AAAA-MM-DD) de `ms` atrás, em São Paulo (o fuso do município da demonstração). */
const diaLocal = (ms: number) => new Date(Date.now() - ms).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

describe.runIf(enabled)('importação, quarta rodada: CNES por arquivo, substituição do mesmo arquivo, prazo do corpo e códigos dos 409', () => {
  let t: TestApp;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let sys: { tenant: Awaited<ReturnType<TenantsService['resolve']>>; db: Awaited<ReturnType<TenantsService['client']>> };
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  const enviar = (bytes: Uint8Array, nome: string, q: Record<string, string> = {}) =>
    t
      .http()
      .post('/api/vigilancia/importacoes')
      .query({ nome, ...q })
      .set(auth(vig))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(bytes));
  const aplicar = async (id: string) => (await t.http().post(`/api/vigilancia/importacoes/${id}/aplicar`).set(auth(vig)).expect(200)).body as ResultadoAplicacao;
  const previa = async (bytes: Uint8Array, nome: string, q: Record<string, string> = {}) => (await enviar(bytes, nome, q).expect(201)).body as DetalheImportacao;
  const detalhe = async (id: string) => (await t.http().get(`/api/vigilancia/importacoes/${id}`).set(auth(vig)).expect(200)).body as DetalheImportacao;

  const base = (v: Record<string, ValorEscrita>) => ({
    TP_NOT: '2',
    SG_UF_NOT: '35',
    ID_MUNICIP: MUN,
    ID_UNIDADE: UBS,
    SG_UF: '35',
    ID_MN_RESI: MUN,
    NM_BAIRRO: 'CENTRO',
    ...(typeof v.DT_NOTIFIC === 'string' ? { SEM_NOT: semanaDaData(v.DT_NOTIFIC).codigo, NU_ANO: v.DT_NOTIFIC.slice(0, 4), DT_SIN_PRI: v.DT_NOTIFIC } : {}),
    ...v,
  });
  const NIND: CampoEscrita[] = [
    ...CAMPOS_NINDINET,
    { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 2 },
    { nome: 'CRITERIO', tipo: 'C', tamanho: 1 },
    { nome: 'EVOLUCAO', tipo: 'C', tamanho: 1 },
    { nome: 'DT_ENCERRA', tipo: 'D', tamanho: 8 },
  ];
  const DENGON: CampoEscrita[] = [...NIND, { nome: 'FEBRE', tipo: 'C', tamanho: 1 }, { nome: 'MIALGIA', tipo: 'C', tamanho: 1 }];
  const den = (n: string, dt: string) => base({ NU_NOTIFIC: n, ID_AGRAVO: 'A90', DT_NOTIFIC: dt, NM_PACIENT: `DENGUE ${n}`, CS_SEXO: 'F', DT_NASC: '2000-01-01', FEBRE: '1', CLASSI_FIN: '10', CRITERIO: '1' });
  const coq = (n: string, dt: string) => base({ NU_NOTIFIC: n, ID_AGRAVO: 'A379', DT_NOTIFIC: dt, NM_PACIENT: `COQUELUCHE ${n}`, CS_SEXO: 'M', DT_NASC: '2025-01-01' });
  const hepatite = (n: string, dt: string) => base({ NU_NOTIFIC: n, ID_AGRAVO: 'B19', DT_NOTIFIC: dt, NM_PACIENT: `HEPATITE ${n}`, CS_SEXO: 'F', DT_NASC: '1980-01-01' });

  /** Casos oficiais do grupo nos anos e a cobertura de cada ano na base consolidada. */
  const casos = async (grupo: string, anos: number[]) => {
    const b = await t.app.get(ConsolidadoService).carregar(sys as never, grupo, anos, false);
    return { oficiais: b.linhas.filter((l) => l.origem === 'OFICIAL').reduce((a, l) => a + l.n, 0), cobertura: b.cobertura.map((c) => `${c.ano}:${c.coberto ? (c.parcial ? 'parcial' : 'todo') : 'não'}`) };
  };
  const registro = (numero: string) => db.officialRecord.findFirstOrThrow({ where: { number: numero }, select: { id: true, absentSince: true, absentImportId: true, firstImportId: true, lastImportId: true } });
  const importacao = (id: string) => db.officialImport.findUniqueOrThrow({ where: { id }, select: { status: true, supersededBy: true, applyResult: true } });

  beforeAll(async () => {
    t = await startTestApp('vigimpr4');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    sys = { tenant, db };
  }, 120_000);

  afterEach(async () => {
    ImportacaoService.esperaMs = ESPERA;
    LeituraDoCorpo.ociosoMs = OCIOSO;
    await ImportacaoService.aguardarTrabalhos();
  });

  afterAll(async () => {
    await ImportacaoService.aguardarTrabalhos();
    await t?.close();
  });

  // ───────────── N0 ─────────────

  it('N0: o zip com os CSV das unidades X e Y (três unidades na base) não marca o registro de Z como ausente', async () => {
    const cab = ['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Sintoma- Febre', 'Classificação Final'];
    const csv = (linhas: [string, string][]) =>
      new TextEncoder().encode(`${cab.join(';')}\r\n${linhas.map(([n, cnes]) => [n, '10/06/2024', '3550308', cnes, `Pessoa ${n}`, 'Sim', 'Confirmado Laboratorial'].join(';')).join('\r\n')}\r\n`);
    const ausentes = async () => (await db.officialRecord.findMany({ where: { system: 'ESUS_NOTIFICA', absentSince: { not: null } }, select: { number: true } })).map((r) => r.number).sort();
    const municipio = await previa(
      csv([
        ['352400000901', X],
        ['352400000902', Y],
        ['352400000903', Z],
      ]),
      'municipio.csv',
    );
    await aplicar(municipio.id);

    const duas = await previa(zipSync({ 'ubs-x.csv': csv([['352400000901', X]]), 'ubs-y.csv': csv([['352400000902', Y]]) }), 'duas-ubs.zip');
    expect(Object.fromEntries(duas.arquivos.map((a) => [a.nome, a.cnes]))).toEqual({ 'ubs-x.csv': X, 'ubs-y.csv': Y });
    expect(duas.contagens?.ausentesPrevistos).toBe(0);
    expect(duas.previa!.ausentes).toEqual([]);
    expect(duas.avisos).toContain(`e-SUS Notifica: o envio traz só os estabelecimentos ${X}, ${Y}: os ausentes valem só para eles.`);
    expect((await aplicar(duas.id)).ausentesMarcados).toBe(0);
    expect(await ausentes()).toEqual([]);
    // O mesmo critério gravado em official_imports.files (a conciliação e a base consolidada leem daí).
    const files = (await db.officialImport.findUniqueOrThrow({ where: { id: duas.id }, select: { files: true } })).files as { nome: string; cnes: string | null }[];
    expect(Object.fromEntries(files.map((f) => [f.nome, f.cnes]))).toEqual({ 'ubs-x.csv': X, 'ubs-y.csv': Y });

    // Com um arquivo de mais de um CNES no zip, a cobertura vale para o município inteiro (e nenhum arquivo fica com CNES).
    const misto = await previa(
      zipSync({
        'ubs-x.csv': csv([['352400000901', X]]),
        'distrito.csv': csv([
          ['352400000901', X],
          ['352400000902', Y],
        ]),
      }),
      'misto.zip',
    );
    expect(Object.fromEntries(misto.arquivos.map((a) => [a.nome, a.cnes]))).toEqual({ 'ubs-x.csv': null, 'distrito.csv': null });
    expect(misto.previa!.ausentes.map((a) => `${a.numero}@${a.cnes}`)).toEqual([`352400000903@${Z}`]);
    await t.http().post(`/api/vigilancia/importacoes/${misto.id}/descartar`).set(auth(vig)).expect(200);
  });

  // ───────────── aviso-periodo-lido ─────────────

  it('aviso-periodo-lido (a): o DENGON de 2026 declarado como 2025 e reenviado com 2026 substitui a aplicação errada: os 2 registros de 2025 voltam', async () => {
    const ano = (a: number) => ({ de: `${a}-01-01`, ate: `${a}-12-31` });
    const d2025 = escreverDbf(DENGON, [den('0000501', '2025-03-10'), den('0000502', '2025-05-12')]);
    await aplicar((await previa(d2025, 'DENGON2025.DBF', ano(2025))).id);
    expect((await casos('dengue', [2025])).oficiais).toBe(2);

    const d2026 = escreverDbf(DENGON, [den('0000601', '2026-02-02'), den('0000602', '2026-02-09')]);
    const errado = await previa(d2026, 'DENGON2026.DBF', ano(2025));
    expect(errado.contagens?.ausentesPrevistos).toBe(2);
    expect((await aplicar(errado.id)).ausentesMarcados).toBe(2);
    for (const n of ['0000501', '0000502']) expect(await registro(n)).toMatchObject({ absentSince: expect.any(Date), absentImportId: errado.id });
    expect((await casos('dengue', [2025])).oficiais).toBe(0);
    // Com os dois registros ausentes, a UBS atestou a negativa da semana do primeiro: quando ele voltar, o atesto cai (RQ003).
    const ubs = await db.unit.findFirstOrThrow({ where: { cnes: UBS }, select: { id: true } });
    const atesto = await db.negativeReport.create({
      data: { unitId: ubs.id, epiWeek: semanaDaData('2025-03-10').codigo, attestedBy: ubs.id, attestedAt: new Date(), attesterName: 'Atesto sintético', declaration: 'Atesto de teste.', deadlineAt: new Date() },
      select: { id: true },
    });

    // O mesmo arquivo com o período certo: a prévia avisa a substituição e quantos voltam.
    const certo = await previa(d2026, 'DENGON2026.DBF', ano(2026));
    const enviadaEm = br(new Date(errado.criadoEm).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }));
    expect(certo.avisos[0]).toBe(
      `Este envio substitui a importação de ${enviadaEm} do mesmo arquivo (período 01/01/2025 a 31/12/2025, declarado). A cobertura passa a ser a deste envio, e 2 registro(s) que ela deu como ausentes voltam.`,
    );
    expect(certo.contagens).toMatchObject({ novos: 0, alterados: 0, iguais: 2, ausentesPrevistos: 0 });
    const r = await aplicar(certo.id);
    expect(r.substituidas).toEqual([{ id: errado.id, enviadaEm: errado.criadoEm, aplicadaEm: expect.any(String), periodo: ano(2025), periodoDeclarado: true, voltaram: 2 }]);
    expect(r.ausentesMarcados).toBe(0);
    expect(await importacao(errado.id)).toMatchObject({ status: 'SUBSTITUIDA', supersededBy: certo.id });
    expect(await importacao(certo.id)).toMatchObject({ status: 'APLICADA', supersededBy: null });
    for (const n of ['0000501', '0000502']) expect(await registro(n)).toMatchObject({ absentSince: null, absentImportId: null });
    // A negativa das unidades e semanas dos que voltaram é reconciliada junto com a dos registros do arquivo.
    expect(r.negativasCanceladas).toBe(1);
    expect(await db.negativeReport.findUniqueOrThrow({ where: { id: atesto.id }, select: { status: true, causeRecordId: true } })).toEqual({ status: 'CANCELADA', causeRecordId: (await registro('0000501')).id });
    expect(await casos('dengue', [2025])).toEqual({ oficiais: 2, cobertura: ['2025:todo'] });
    expect((await casos('dengue', [2026])).oficiais).toBe(2);
    expect(await db.officialRecord.count({ where: { number: { in: ['0000601', '0000602'] } } })).toBe(2);

    // Reenviar o DENGON2025 (o mesmo período ou sem período) continua dando jaImportado: ele nunca deixou de valer.
    expect((await enviar(d2025, 'DENGON2025.DBF', ano(2025)).expect(200)).body.jaImportado).toBeTruthy();
    expect((await enviar(d2025, 'DENGON2025.DBF').expect(200)).body.jaImportado).toBeTruthy();
  });

  it('aviso-periodo-lido (b): declarado como 2024 e corrigido para 2026, a cobertura de 2024 some da base consolidada e da conciliação', async () => {
    const d = escreverDbf(DENGON, [den('0000701', '2026-03-02')]);
    const errado = await previa(d, 'DENGON2026b.DBF', { de: '2024-01-01', ate: '2024-12-31' });
    await aplicar(errado.id);
    expect((await casos('dengue', [2024])).cobertura).toEqual(['2024:todo']);
    const certo = await previa(d, 'DENGON2026b.DBF', { de: '2026-01-01', ate: '2026-12-31' });
    expect(certo.avisos[0]).toMatch(/^Este envio substitui a importação de \d{2}\/\d{2}\/\d{4} do mesmo arquivo \(período 01\/01\/2024 a 31\/12\/2024, declarado\)\. A cobertura passa a ser a deste envio\.$/);
    expect((await aplicar(certo.id)).substituidas).toEqual([expect.objectContaining({ id: errado.id, voltaram: 0 })]);
    expect((await casos('dengue', [2024])).cobertura).toEqual(['2024:não']);
    const conciliacao = (await t.http().get('/api/vigilancia/conciliacao/resumo').set(auth(vig)).expect(200)).body as { cobertura: { sistema: string; de: string }[] };
    expect(conciliacao.cobertura.filter((c) => c.sistema === 'SINAN_ONLINE' && c.de === '2024-01-01')).toEqual([]);
  });

  it('aviso-periodo-lido: ampliar o período substitui a aplicação pelo período lido sem duplicar; sem período, jaImportado; declarar o período lido volta a ele', async () => {
    const nind = escreverDbf(NIND, [coq('0000801', '2026-10-05'), coq('0000802', '2026-10-06'), coq('0000803', '2026-10-07'), coq('0000804', '2026-10-08')]);
    const lido = await previa(nind, 'NINDINET-out.DBF');
    expect(lido).toMatchObject({ periodo: { de: '2026-10-05', ate: '2026-10-08' }, periodoDeclarado: false });
    await aplicar(lido.id);
    const outubro = { de: '2026-10-01', ate: '2026-10-31' };
    const amplo = await previa(nind, 'NINDINET-out.DBF', outubro);
    expect(amplo.contagens).toMatchObject({ novos: 0, alterados: 0, iguais: 4 });
    expect(amplo.avisos[0]).toContain('do mesmo arquivo (período 05/10/2026 a 08/10/2026, lido das notificações). A cobertura passa a ser a deste envio.');
    expect((await aplicar(amplo.id)).substituidas).toEqual([expect.objectContaining({ id: lido.id, periodo: { de: '2026-10-05', ate: '2026-10-08' }, periodoDeclarado: false, voltaram: 0 })]);
    const numeros = ['0000801', '0000802', '0000803', '0000804'];
    expect(await db.officialRecord.findMany({ where: { number: { in: numeros } }, select: { firstImportId: true, lastImportId: true } })).toEqual(numeros.map(() => ({ firstImportId: lido.id, lastImportId: amplo.id })));
    expect(await db.officialImport.groupBy({ by: ['status'], where: { sha256: lido.sha256 }, _count: { _all: true }, orderBy: { status: 'asc' } })).toEqual([
      { status: 'APLICADA', _count: { _all: 1 } },
      { status: 'SUBSTITUIDA', _count: { _all: 1 } },
    ]);

    // Sem período, ou com o período que vale: jaImportado (a aplicação que vale).
    expect((await enviar(nind, 'x.DBF').expect(200)).body).toEqual({ jaImportado: { id: amplo.id, aplicadoEm: expect.any(String) } });
    expect((await enviar(nind, 'x.DBF', outubro).expect(200)).body).toEqual({ jaImportado: { id: amplo.id, aplicadoEm: expect.any(String) } });
    // Para voltar ao período lido, declara-se o período lido: prévia nova, que substitui a ampliada.
    const devolta = await previa(nind, 'x.DBF', { de: '2026-10-05', ate: '2026-10-08' });
    expect((await aplicar(devolta.id)).substituidas).toEqual([expect.objectContaining({ id: amplo.id })]);
    expect(await db.officialRecord.count({ where: { number: { in: numeros } } })).toBe(4);
    expect(await importacao(amplo.id)).toMatchObject({ status: 'SUBSTITUIDA', supersededBy: devolta.id });

    // A SUBSTITUIDA: no histórico com a situação própria e por quem foi substituída; não pode ser descartada nem aplicada.
    const lista = (await t.http().get('/api/vigilancia/importacoes').set(auth(vig)).expect(200)).body as ListaImportacoes;
    expect(lista.find((r) => r.id === lido.id)).toMatchObject({ status: 'SUBSTITUIDA', substituidaPor: { id: amplo.id, enviadaEm: amplo.criadoEm, periodo: outubro, periodoDeclarado: true } });
    expect(lista.find((r) => r.id === devolta.id)).toMatchObject({ status: 'APLICADA', substituidaPor: null });
    const det = await detalhe(amplo.id);
    expect(det).toMatchObject({ status: 'SUBSTITUIDA', substituidaPor: { id: devolta.id, aplicadaEm: expect.any(String) }, resultadoAplicacao: { substituidas: [expect.objectContaining({ id: lido.id })] } });
    const descarte = await t.http().post(`/api/vigilancia/importacoes/${amplo.id}/descartar`).set(auth(vig)).expect(409);
    expect(descarte.body.message).toBe('A importação foi aplicada e depois substituída por uma aplicação do mesmo arquivo com outro período. Não dá para descartar.');
    expect((await t.http().post(`/api/vigilancia/importacoes/${amplo.id}/aplicar`).set(auth(vig)).expect(409)).body.message).toBe(
      'A importação foi aplicada e depois substituída por uma aplicação do mesmo arquivo com outro período.',
    );
  });

  it('aviso-periodo-lido: o arquivo antigo reenviado hoje com o período declarado não marca ausentes depois do primeiro envio dele', async () => {
    // O arquivo saiu há 10 dias (o primeiro envio, sem período); depois chegou outra notificação, de 5 dias atrás.
    const dezDias = diaLocal(10 * DIA);
    const cincoDias = diaLocal(5 * DIA);
    const antigo = escreverDbf(NIND, [hepatite('0000901', diaLocal(20 * DIA)), hepatite('0000902', diaLocal(15 * DIA))]);
    const primeiro = await previa(antigo, 'NINDINET-antigo.DBF');
    await aplicar(primeiro.id);
    await db.officialImport.update({ where: { id: primeiro.id }, data: { createdAt: new Date(Date.now() - 10 * DIA) } });
    await aplicar((await previa(escreverDbf(NIND, [hepatite('0000903', cincoDias)]), 'NINDINET-depois.DBF')).id);

    // Hoje, o mesmo arquivo declarando o ano: a cobertura dos ausentes vai até o primeiro envio, não até o fim do ano.
    const ano = { de: `${dezDias.slice(0, 4)}-01-01`, ate: `${dezDias.slice(0, 4)}-12-31` };
    const reenvio = await previa(antigo, 'NINDINET-antigo.DBF', ano);
    expect(reenvio.contagens?.ausentesPrevistos).toBe(0);
    expect(reenvio.previa!.ausentes.map((a) => a.numero)).not.toContain('0000903');
    expect((await aplicar(reenvio.id)).ausentesMarcados).toBe(0);
    expect(await registro('0000903')).toMatchObject({ absentSince: null, absentImportId: null });
    // A data do primeiro envio vale também com a aplicação de agora: a cobertura gravada no payload terminou nela.
    expect(dezDias < cincoDias).toBe(true);
  });

  // ───────────── N1 e N2 ─────────────

  /** POST cru com Content-Length `declarado`, mandando só `primeiros` bytes; `fechar()` derruba a conexão. */
  const envioLento = (declarado: number, primeiros: number, nome = 'lento.dbf') => {
    const url = new URL(t.baseUrl.replace('[::1]', '127.0.0.1'));
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `/api/vigilancia/importacoes?nome=${encodeURIComponent(nome)}`,
      method: 'POST',
      headers: { authorization: `Bearer ${vig}`, 'content-type': 'application/octet-stream', 'content-length': String(declarado) },
    });
    const inicio = Date.now();
    const resposta = new Promise<{ status: number; corpo: { code?: string; message?: string } | null; ms: number }>((ok, falha) => {
      req.on('response', (res) => {
        let s = '';
        res.on('data', (c: Buffer) => (s += c.toString()));
        res.on('end', () => ok({ status: res.statusCode!, corpo: s ? JSON.parse(s) : null, ms: Date.now() - inicio }));
      });
      req.on('error', falha);
    });
    resposta.catch(() => undefined);
    const fechou = new Promise<void>((ok) => req.on('close', () => ok()));
    req.on('error', () => undefined);
    req.write(Buffer.alloc(primeiros, 0x20));
    return { resposta, fechou, fechar: () => req.destroy() };
  };
  const esperarCargas = async (n: number, ms = 10_000) => {
    const fim = Date.now() + ms;
    while (ImportacaoService.cargas !== n) {
      if (Date.now() > fim) throw new Error(`cargas: ${ImportacaoService.cargas}, esperado ${n}`);
      await pausa(20);
    }
  };
  const nindinet = (n: string) => escreverDbf(CAMPOS_NINDINET, [{ NU_NOTIFIC: n, TP_NOT: '2', ID_AGRAVO: 'A279', DT_NOTIFIC: '2024-07-01', ID_MUNICIP: MUN, ID_UNIDADE: UBS }]);
  const SERVIDOR = { code: 'IMPORTACAO_SERVIDOR_OCUPADO', message: 'O servidor está recebendo ou processando outros envios agora. Tente de novo em instantes.' };

  it('N1: o cliente lento solta a carga no prazo de ociosidade (408) e a conexão fecha; o envio seguinte passa', async () => {
    LeituraDoCorpo.ociosoMs = 500;
    const lento = envioLento(1024 * 1024, 100);
    await esperarCargas(1);
    const r = await lento.resposta;
    expect(r).toMatchObject({ status: 408, corpo: { code: 'ENVIO_PARADO', message: 'O envio parou de chegar. Envie o arquivo de novo.' } });
    expect(r.ms).toBeLessThan(5000);
    await lento.fechou;
    expect(ImportacaoService.cargas).toBe(0);
    expect(await db.officialImport.count({ where: { fileName: 'lento.dbf' } })).toBe(0);
    await previa(nindinet('8100001'), 'depois-do-lento.dbf');
  });

  it('N1: um envio por tenant: o segundo, com o primeiro ainda chegando, recebe 409 IMPORTACAO_SERVIDOR_OCUPADO antes de o corpo ser lido', async () => {
    const primeiro = envioLento(2 * 1024 * 1024, 100, 'primeiro.dbf');
    try {
      await esperarCargas(1);
      const segundo = envioLento(8 * 1024 * 1024, 100, 'segundo.dbf');
      try {
        expect(await segundo.resposta).toMatchObject({
          status: 409,
          corpo: { code: 'IMPORTACAO_SERVIDOR_OCUPADO', message: 'Outro envio da sua instituição está sendo recebido agora. Tente de novo quando ele terminar.' },
        });
        expect(ImportacaoService.cargas).toBe(1);
      } finally {
        segundo.fechar();
      }
    } finally {
      primeiro.fechar();
    }
    await esperarCargas(0);
  });

  it('N1 e N2: o processo com as cargas de dois outros tenants recusa o envio com IMPORTACAO_SERVIDOR_OCUPADO; a vez com outro tenant também', async () => {
    const svc = t.app.get(ImportacaoService);
    const ctx = (tenant: string) => ({ db, tenant: { ...sys.tenant, id: tenant }, session: { userId: '00000000-0000-0000-0000-000000000000' }, ip: '127.0.0.1', cbo: '' }) as unknown as RequestContext;
    const soltar: ((e: Error) => void)[] = [];
    const corpos = ['tenant-b', 'tenant-c'].map((id) => svc.enviar(ctx(id), () => new Promise<Buffer>((_, falha) => soltar.push(falha)), { nome: `${id}.dbf` }).catch((e: Error) => e));
    try {
      await esperarCargas(2);
      expect((await enviar(nindinet('8200001'), 'cheio.dbf').expect(409)).body).toMatchObject(SERVIDOR);
    } finally {
      for (const s of soltar) s(new Error('o cliente caiu'));
    }
    await Promise.all(corpos);
    expect(ImportacaoService.cargas).toBe(0);

    // A vez com a importação de outro tenant (ou sem tenant): o envio e o aplicar recebem IMPORTACAO_SERVIDOR_OCUPADO.
    const d = await previa(nindinet('8200002'), 'vez.dbf');
    let liberar = () => {};
    const servico = svc as unknown as { exclusivo<T>(fn: () => Promise<T>): Promise<T> };
    const ocupado = servico.exclusivo(() => new Promise<void>((r) => (liberar = r)));
    try {
      expect((await enviar(nindinet('8200003'), 'vez-2.dbf').expect(409)).body).toMatchObject(SERVIDOR);
      expect((await t.http().post(`/api/vigilancia/importacoes/${d.id}/aplicar`).set(auth(vig)).expect(409)).body).toMatchObject(SERVIDOR);
    } finally {
      liberar();
      await ocupado;
    }
    expect((await aplicar(d.id)).contagens).toMatchObject({ novos: 1 });
  });

  it('N1: Content-Length acima de 95 MB dá 413 antes de o corpo ser lido, sem carga nem linha', async () => {
    const grande = envioLento(96 * 1024 * 1024, 100, 'grande.dbf');
    const r = await grande.resposta;
    expect(r).toMatchObject({ status: 413, corpo: { code: 'ARQUIVO_GRANDE', message: 'Arquivo maior que o permitido' } });
    expect(r.ms).toBeLessThan(5000);
    await grande.fechou;
    expect(ImportacaoService.cargas).toBe(0);
    expect(await db.officialImport.count({ where: { fileName: 'grande.dbf' } })).toBe(0);
  });

  it('N1: o envio que chega incompleto (o cliente cai no meio) termina com erro e solta a carga', async () => {
    LeituraDoCorpo.ociosoMs = 60_000;
    const caiu = envioLento(1024 * 1024, 4096, 'incompleto.dbf');
    await esperarCargas(1);
    caiu.fechar();
    await esperarCargas(0);
    expect(await db.officialImport.count({ where: { fileName: 'incompleto.dbf' } })).toBe(0);
  });
});
