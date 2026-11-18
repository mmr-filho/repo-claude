import http from 'node:http';
import { connect, type Socket } from 'node:net';
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
 * Importação (VIG-1c), quinta rodada, com o banco:
 * - R5-1: a cobertura dos ausentes é a de cada arquivo (sistema, tipo, agravos ou fichas, período e, no e-SUS, o CNES
 *   do arquivo de um estabelecimento só), a mesma na prévia, na aplicação, na substituição, no apply_result, na
 *   conciliação e na base consolidada; o resultado não depende de os arquivos irem juntos num zip ou separados;
 * - R5-2: a substituição do mesmo arquivo só devolve o ausente que nenhuma outra importação APLICADA confirma;
 * - R5-3: a vez ocupada por outro tenant dá 409 antes de ler o corpo;
 * - R5-4: o upload da SIGTAP reserva a carga do processo antes de ler o corpo;
 * - R5-5: a busca com caractere de controle dá 400.
 * Dados sintéticos.
 */

const enabled = await pgAvailable();
const MUN = '355030';
const UBS = '9000011';
const X = '9000011';
const Y = '9000028';
const ESPERA = ImportacaoService.esperaMs;
const OCIOSO = LeituraDoCorpo.ociosoMs;
const MB = 1024 * 1024;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const enc = (s: string) => new TextEncoder().encode(s);

/** Cobertura gravada no apply_result (só o que os testes comparam). */
interface CoberturaGravada {
  sistema: string;
  tipo: string;
  agravos: (string | null)[];
  grupos?: string[];
  cnes?: string[];
  de: string;
  ate: string;
}

describe.runIf(enabled)('importação, quinta rodada: cobertura por arquivo, substituição confirmada por outra aplicação, vez, SIGTAP e busca', () => {
  let t: TestApp;
  let vig = '';
  let fat = '';
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
  const previa = async (bytes: Uint8Array, nome: string, q: Record<string, string> = {}) => {
    const r = await enviar(bytes, nome, q);
    if (r.status !== 201) throw new Error(`prévia ${nome}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as DetalheImportacao;
  };
  const aplicar = async (id: string) => {
    const r = await t.http().post(`/api/vigilancia/importacoes/${id}/aplicar`).set(auth(vig));
    if (r.status !== 200) throw new Error(`aplicar ${id}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as ResultadoAplicacao;
  };
  const enviarEAplicar = async (bytes: Uint8Array, nome: string, q: Record<string, string> = {}) => {
    const p = await previa(bytes, nome, q);
    return { previa: p, resultado: await aplicar(p.id) };
  };
  /** A cobertura que a aplicação gravou no apply_result. */
  const coberturaGravada = async (id: string) => ((await db.officialImport.findUniqueOrThrow({ where: { id }, select: { applyResult: true } })).applyResult as { cobertura?: CoberturaGravada[] } | null)?.cobertura;

  /** CSV do e-SUS Notifica (síndrome gripal): número, CNES e data (DD/MM/AAAA) de cada linha. */
  const csvSg = (linhas: [string, string, string][]) =>
    enc(
      `${['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Sintoma- Febre', 'Classificação Final'].join(';')}\r\n${linhas
        .map(([n, cnes, data]) => [n, data, '3550308', cnes, `Pessoa ${n}`, 'Sim', 'Confirmado Laboratorial'].join(';'))
        .join('\r\n')}\r\n`,
    );
  /** CSV do e-SUS Sinan: número, agravo (CID) e CNES de cada linha, todos em 10/03/2026. */
  const csvEsusSinan = (linhas: [string, string, string][]) =>
    enc(
      '"nu_notific";"id_agravo";"dt_notific";"id_municip";"id_unidade";"classi_fin";"evolucao"\r\n' + linhas.map(([n, agravo, cnes]) => `"${n}";"${agravo}";"10/03/2026";"355030";"${cnes}";"1";"1"`).join('\r\n') + '\r\n',
    );
  const ausentesDe = async (sistema: 'ESUS_NOTIFICA' | 'ESUS_SINAN' | 'SINAN_ONLINE', prefixo = '') =>
    (await db.officialRecord.findMany({ where: { system: sistema, absentSince: { not: null }, number: { startsWith: prefixo } }, select: { number: true } })).map((r) => r.number).sort();
  const covid = async (ano: number) => {
    const b = await t.app.get(ConsolidadoService).carregar(sys as never, 'covid', [ano], false);
    const se = Number(semanaDaData(`${ano}-03-08`).codigo.slice(4));
    return { se10: b.semanasCobertas.get(ano)![se - 1], semanasCobertas: b.cobertura[0]!.semanasCobertas };
  };

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
  const lepto = (n: string, dt: string) => base({ NU_NOTIFIC: n, ID_AGRAVO: 'A279', DT_NOTIFIC: dt, NM_PACIENT: `LEPTO ${n}`, CS_SEXO: 'M', DT_NASC: '1980-01-01' });
  const registro = (numero: string) => db.officialRecord.findFirstOrThrow({ where: { number: numero }, select: { id: true, absentSince: true, absentImportId: true, lastImportId: true, lastSeenAt: true } });
  const oficiais = async (grupo: string, ano: number) => (await t.app.get(ConsolidadoService).carregar(sys as never, grupo, [ano], false)).linhas.filter((l) => l.origem === 'OFICIAL').reduce((a, l) => a + l.n, 0);
  const enviadaEm = (d: DetalheImportacao) => br(new Date(d.criadoEm).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }));

  beforeAll(async () => {
    t = await startTestApp('vigimpr5');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    fat = await t.login('faturamento', 'UBS Centro', 'FATURAMENTO');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    sys = { tenant, db };
  }, 180_000);

  afterEach(async () => {
    ImportacaoService.esperaMs = ESPERA;
    LeituraDoCorpo.ociosoMs = OCIOSO;
    await ImportacaoService.aguardarTrabalhos();
  });

  afterAll(async () => {
    await ImportacaoService.aguardarTrabalhos();
    await t?.close();
  });

  // ───────────── R5-1: cobertura por arquivo ─────────────

  it('R5-1 e-SUS Notifica: no zip com o CSV de X (junho) e o de Y (junho a agosto), o registro de agosto de X não fica ausente; a cobertura de cada arquivo é a mesma nos ausentes, no apply_result e na conciliação', async () => {
    await enviarEAplicar(
      csvSg([
        ['352400001101', X, '10/06/2024'],
        ['352400001102', X, '10/08/2024'],
        ['352400001103', Y, '10/06/2024'],
        ['352400001104', Y, '10/08/2024'],
      ]),
      'municipio-2024.csv',
    );
    const zip = await previa(
      zipSync({
        'ubs-x.csv': csvSg([['352400001101', X, '10/06/2024']]),
        'ubs-y.csv': csvSg([
          ['352400001103', Y, '10/06/2024'],
          ['352400001104', Y, '10/08/2024'],
        ]),
      }),
      'unidades-2024.zip',
    );
    expect(zip.arquivos.map((a) => [a.nome, a.cnes, a.periodo])).toEqual([
      ['ubs-x.csv', X, { de: '2024-06-10', ate: '2024-06-10' }],
      ['ubs-y.csv', Y, { de: '2024-06-10', ate: '2024-08-10' }],
    ]);
    const r = await aplicar(zip.id);
    expect({ previstos: zip.contagens?.ausentesPrevistos, marcados: r.ausentesMarcados, ausentes: await ausentesDe('ESUS_NOTIFICA', '3524') }).toEqual({ previstos: 0, marcados: 0, ausentes: [] });
    expect(zip.avisos).toContain(`e-SUS Notifica: 2 arquivo(s) de um estabelecimento só (ubs-x.csv, CNES ${X}; ubs-y.csv, CNES ${Y}): os ausentes de cada um valem só para o estabelecimento dele.`);
    // A cobertura que a aplicação usou fica no apply_result: uma entrada por arquivo, com o CNES e o período dele.
    expect(await coberturaGravada(zip.id)).toEqual([
      expect.objectContaining({ sistema: 'ESUS_NOTIFICA', tipo: 'INDIVIDUAL', agravos: [null], grupos: ['covid'], cnes: [X], de: '2024-06-10', ate: '2024-06-10' }),
      expect.objectContaining({ sistema: 'ESUS_NOTIFICA', tipo: 'INDIVIDUAL', agravos: [null], grupos: ['covid'], cnes: [Y], de: '2024-06-10', ate: '2024-08-10' }),
    ]);
    // ...e não vai para as respostas da API (o resultado da aplicação, o detalhe e a lista).
    expect(r).not.toHaveProperty('cobertura');
    const det = (await t.http().get(`/api/vigilancia/importacoes/${zip.id}`).set(auth(vig)).expect(200)).body as DetalheImportacao;
    expect(det.resultadoAplicacao).not.toHaveProperty('cobertura');
    const lista = (await t.http().get('/api/vigilancia/importacoes').set(auth(vig)).expect(200)).body as ListaImportacoes;
    expect(lista.find((i) => i.id === zip.id)!.resultadoAplicacao).not.toHaveProperty('cobertura');
    // A conciliação lê a cobertura gravada arquivo por arquivo (R6-2): o mesmo CNES e o mesmo período de cada um.
    const conciliacao = (await t.http().get('/api/vigilancia/conciliacao/resumo').set(auth(vig)).expect(200)).body as { cobertura: { sistema: string; cnes: string | null; de: string; ate: string }[] };
    const esus = conciliacao.cobertura.filter((c) => c.sistema === 'ESUS_NOTIFICA' && c.cnes !== null && c.de.startsWith('2024'));
    expect(esus.map((c) => [c.cnes, c.de, c.ate])).toEqual([
      [X, '2024-06-10', '2024-06-10'],
      [Y, '2024-06-10', '2024-08-10'],
    ]);
  });

  it('R5-1: os mesmos CSV do e-SUS Notifica dão os mesmos ausentes e as mesmas SE cobertas em dois envios e num zip (o teste do juiz)', async () => {
    const ausentesDoAno = async (ano: number) => (await ausentesDe('ESUS_NOTIFICA', `35${String(ano).slice(2)}`)).map((num) => num.slice(4));
    const cenarioAusentes = async (ano: number, juntos: boolean) => {
      const aa = String(ano).slice(2);
      const n = (k: number) => `35${aa}00001${100 + k}`;
      await enviarEAplicar(
        csvSg([
          [n(1), X, `10/06/${ano}`],
          [n(2), X, `10/08/${ano}`],
          [n(3), Y, `10/06/${ano}`],
          [n(4), Y, `10/08/${ano}`],
        ]),
        `municipio-${ano}.csv`,
      );
      const ubsX = csvSg([[n(1), X, `10/06/${ano}`]]);
      const ubsY = csvSg([
        [n(3), Y, `10/06/${ano}`],
        [n(4), Y, `10/08/${ano}`],
      ]);
      if (juntos) await enviarEAplicar(zipSync({ 'ubs-x.csv': ubsX, 'ubs-y.csv': ubsY }), `unidades-${ano}.zip`);
      else {
        await enviarEAplicar(ubsX, `ubs-x-${ano}.csv`);
        await enviarEAplicar(ubsY, `ubs-y-${ano}.csv`);
      }
      return ausentesDoAno(ano);
    };
    const separados = await cenarioAusentes(2022, false);
    const noZip = await cenarioAusentes(2021, true);
    expect({ separados, noZip }).toEqual({ separados: [], noZip: [] });

    const cenarioSemanas = async (ano: number, juntos: boolean) => {
      const aa = String(ano).slice(2);
      const n = (k: number) => `35${aa}00001${200 + k}`;
      const municipio = csvSg([
        [n(1), X, `12/06/${ano}`],
        [n(2), Y, `14/08/${ano}`],
      ]);
      const ubsX = csvSg([
        [n(3), X, `10/01/${ano}`],
        [n(4), X, `09/08/${ano}`],
      ]);
      if (juntos) {
        const { previa: p } = await enviarEAplicar(zipSync({ 'municipio.csv': municipio, 'ubs-x.csv': ubsX }), `misto-${ano}.zip`);
        // O arquivo da unidade fica com o CNES dele mesmo com o CSV do município no zip (o critério da terceira rodada).
        expect(p.arquivos.map((a) => [a.nome, a.cnes])).toEqual([
          ['municipio.csv', null],
          ['ubs-x.csv', X],
        ]);
        expect(p.avisos).toContain(
          `e-SUS Notifica: 1 arquivo(s) de um estabelecimento só (ubs-x.csv, CNES ${X}): os ausentes de cada um valem só para o estabelecimento dele. Os outros arquivos do e-SUS Notifica valem para o município inteiro.`,
        );
        expect(await coberturaGravada(p.id)).toEqual([expect.objectContaining({ de: `${ano}-06-12`, ate: `${ano}-08-14` }), expect.objectContaining({ cnes: [X], de: `${ano}-01-10`, ate: `${ano}-08-09` })]);
        expect((await coberturaGravada(p.id))![0]).not.toHaveProperty('cnes');
      } else {
        await enviarEAplicar(municipio, `municipio-${ano}.csv`);
        await enviarEAplicar(ubsX, `ubs-x-${ano}.csv`);
      }
      return covid(ano);
    };
    const semanasSeparados = await cenarioSemanas(2020, false);
    const semanasNoZip = await cenarioSemanas(2023, true);
    // A SE de março (só a unidade X exportou) não fica coberta como SE do município, nos dois casos.
    expect({ separados: semanasSeparados, noZip: semanasNoZip }).toEqual({ separados: { se10: false, semanasCobertas: 11 }, noZip: { se10: false, semanasCobertas: 11 } });
  });

  it('R5-1 e-SUS Sinan: o CSV de X (mpox) e o de Y (esporotricose) no zip não marcam a esporotricose de X: cada arquivo cobre os agravos dele', async () => {
    await enviarEAplicar(
      csvEsusSinan([
        ['352600002101', 'B04', X],
        ['352600002102', 'B42', X],
        ['352600002103', 'B42', Y],
      ]),
      'esus-sinan-municipio.csv',
    );
    const zip = await previa(
      zipSync({
        'x-mpox.csv': csvEsusSinan([['352600002101', 'B04', X]]),
        'y-esporotricose.csv': csvEsusSinan([['352600002103', 'B42', Y]]),
      }),
      'esus-sinan-unidades.zip',
    );
    expect(zip.arquivos.map((a) => [a.nome, a.cnes, a.agravos])).toEqual([
      ['x-mpox.csv', X, ['B04']],
      ['y-esporotricose.csv', Y, ['B42']],
    ]);
    const r = await aplicar(zip.id);
    expect({ previstos: zip.contagens?.ausentesPrevistos, marcados: r.ausentesMarcados, ausentes: await ausentesDe('ESUS_SINAN', '3526') }).toEqual({ previstos: 0, marcados: 0, ausentes: [] });
    expect((await coberturaGravada(zip.id))!.map((c) => [c.sistema, c.agravos, c.cnes])).toEqual([
      ['ESUS_SINAN', ['B04'], [X]],
      ['ESUS_SINAN', ['B42'], [Y]],
    ]);
  });

  it('R5-1 Sinan: o zip com o DENGON de 2023 e o de 2025 (sem período declarado) não cobre 2024: os registros de 2024 não ficam ausentes', async () => {
    await enviarEAplicar(escreverDbf(DENGON, [den('0024001', '2024-04-15'), den('0024002', '2024-09-02')]), 'DENGON2024.DBF');
    const zip = await previa(
      zipSync({
        'DENGON2023.DBF': escreverDbf(DENGON, [den('0023001', '2023-03-13'), den('0023002', '2023-11-20')]),
        'DENGON2025.DBF': escreverDbf(DENGON, [den('0025001', '2025-02-03'), den('0025002', '2025-10-06')]),
      }),
      'dengue-2023-2025.zip',
    );
    expect(zip.contagens?.ausentesPrevistos).toBe(0);
    const r = await aplicar(zip.id);
    expect(r.ausentesMarcados).toBe(0);
    for (const n of ['0024001', '0024002']) expect(await registro(n)).toMatchObject({ absentSince: null, absentImportId: null });
    expect((await coberturaGravada(zip.id))!.map((c) => [c.sistema, c.agravos, c.de, c.ate])).toEqual([
      ['SINAN_ONLINE', ['A90'], '2023-03-13', '2023-11-20'],
      ['SINAN_ONLINE', ['A90'], '2025-02-03', '2025-10-06'],
    ]);
    expect(await oficiais('dengue', 2024)).toBe(2);
  });

  it('R5-1: o registro dentro de duas entradas (o arquivo do município e o da unidade se cruzam) conta uma vez na prévia, como na aplicação', async () => {
    await enviarEAplicar(
      csvSg([
        ['352500001301', X, '10/07/2025'],
        ['352500001302', Y, '10/06/2025'],
        ['352500001305', X, '10/01/2025'],
        ['352500001306', X, '14/08/2025'],
        ['352500001307', X, '14/08/2025'],
      ]),
      'municipio-2025.csv',
    );
    // O 352500001301 (X, julho) não vem: está no período do CSV do município (o município inteiro) e no do CSV de X.
    const zip = await previa(
      zipSync({
        'municipio.csv': csvSg([
          ['352500001302', Y, '10/06/2025'],
          ['352500001306', X, '14/08/2025'],
        ]),
        'ubs-x.csv': csvSg([
          ['352500001305', X, '10/01/2025'],
          ['352500001307', X, '14/08/2025'],
        ]),
      }),
      'misto-2025.zip',
    );
    expect(zip.previa!.ausentes.map((a) => a.numero)).toEqual(['352500001301']);
    const r = await aplicar(zip.id);
    expect({ previstos: zip.contagens?.ausentesPrevistos, marcados: r.ausentesMarcados, ausentes: await ausentesDe('ESUS_NOTIFICA', '3525') }).toEqual({ previstos: 1, marcados: 1, ausentes: ['352500001301'] });
  });

  // ───────────── R5-2: substituição confirmada por outra aplicação ─────────────

  it('R5-2: a correção do período (I2 substitui I1) não devolve o registro que a exportação do período aplicada depois (J) também não traz; o atesto da negativa fica', async () => {
    const ano = (a: number) => ({ de: `${a}-01-01`, ate: `${a}-12-31` });
    // E: a exportação da dengue de 2022 com os dois registros.
    await enviarEAplicar(escreverDbf(DENGON, [den('0002201', '2022-03-07'), den('0002202', '2022-05-09')]), 'DENGON2022-E.DBF', ano(2022));
    expect(await oficiais('dengue', 2022)).toBe(2);
    // I1: o DENGON de 2027 declarado como 2022 (o erro): os dois de 2022 ficam ausentes por I1.
    const d2027 = escreverDbf(DENGON, [den('0002701', '2026-01-05')]);
    const { previa: i1, resultado: r1 } = await enviarEAplicar(d2027, 'DENGON-errado.DBF', ano(2022));
    expect(r1.ausentesMarcados).toBe(2);
    const marcadoEm = (await registro('0002202')).absentSince;
    // J: a exportação nova da dengue de 2022, sem o 0002202 (excluído no Sinan): o 0002201 volta; o 0002202 já estava
    // ausente e segue ausente, com a marca de I1.
    const { previa: j } = await enviarEAplicar(escreverDbf(DENGON, [den('0002201', '2022-03-07')]), 'DENGON2022-J.DBF', ano(2022));
    expect(await registro('0002202')).toMatchObject({ absentSince: marcadoEm, absentImportId: i1.id });
    expect(await oficiais('dengue', 2022)).toBe(1);
    const ubs = await db.unit.findFirstOrThrow({ where: { cnes: UBS }, select: { id: true } });
    const atesto = await db.negativeReport.create({
      data: { unitId: ubs.id, epiWeek: semanaDaData('2022-05-09').codigo, attestedBy: ubs.id, attestedAt: new Date(), attesterName: 'Atesto sintético', declaration: 'Atesto de teste.', deadlineAt: new Date() },
      select: { id: true },
    });

    // I2: o mesmo arquivo de I1 com o período certo. J (APLICADA, aplicada depois da última vez que o 0002202 veio)
    // cobre o registro e não o traz: ele não volta, e a prévia não anuncia volta nenhuma.
    const i2 = await previa(d2027, 'DENGON-errado.DBF', ano(2026));
    expect(i2.avisos[0]).toBe(`Este envio substitui a importação de ${enviadaEm(i1)} do mesmo arquivo (período 01/01/2022 a 31/12/2022, declarado). A cobertura passa a ser a deste envio.`);
    const r = await aplicar(i2.id);
    expect(r.substituidas!.map((s) => [s.id, s.voltaram])).toEqual([[i1.id, 0]]);
    // A marca passa para J (a mais recente das que confirmam), com o "ausente desde" de quando sumiu.
    expect(await registro('0002202')).toMatchObject({ absentSince: marcadoEm, absentImportId: j.id });
    const negativa = await db.negativeReport.findUniqueOrThrow({ where: { id: atesto.id }, select: { status: true } });
    expect({ oficiais2022: await oficiais('dengue', 2022), negativa: negativa.status, negativasCanceladas: r.negativasCanceladas }).toEqual({ oficiais2022: 1, negativa: 'ATESTADA', negativasCanceladas: 0 });
  });

  it('R5-2 (o cenário do r4vcet): o arquivo de março reenviado com o período mais curto não devolve o registro que a exportação de junho (aplicada) não traz', async () => {
    const A = lepto('6610001', '2021-01-11');
    const B = lepto('6610002', '2021-01-20');
    const C = lepto('6610003', '2021-02-10');
    const D = lepto('6610004', '2021-04-05');
    const casos = () => oficiais('leptospirose', 2021);
    await enviarEAplicar(escreverDbf(CAMPOS_NINDINET, [A, B, C]), 'LEPTO-jan.DBF', { de: '2021-01-01', ate: '2021-03-31' });
    const marco = escreverDbf(CAMPOS_NINDINET, [A, C]);
    const { previa: mar, resultado: r1 } = await enviarEAplicar(marco, 'LEPTO-mar.DBF', { de: '2021-01-01', ate: '2021-03-31' });
    expect(r1.ausentesMarcados).toBe(1);
    const { previa: jun } = await enviarEAplicar(escreverDbf(CAMPOS_NINDINET, [A, C, D]), 'LEPTO-jun.DBF', { de: '2021-01-01', ate: '2021-06-30' });
    expect(await registro('6610002')).toMatchObject({ absentImportId: mar.id });
    const antes = await casos();
    expect(antes).toBe(3);
    const corrigido = await previa(marco, 'LEPTO-mar.DBF', { de: '2021-02-01', ate: '2021-03-31' });
    expect(corrigido.avisos[0]).toMatch(/A cobertura passa a ser a deste envio\.$/);
    const r2 = await aplicar(corrigido.id);
    expect(r2.substituidas!.map((s) => s.voltaram)).toEqual([0]);
    expect({ marca: (await registro('6610002')).absentImportId, casos: await casos() }).toEqual({ marca: jun.id, casos: antes });
  });

  it('R5-2 (o cenário do r4vcet, em cascata): o atesto da negativa feito sem o registro apagado não é cancelado pela substituição', async () => {
    const dia = (d: number) => new Date(Date.now() - d * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const ubs = await db.unit.findUniqueOrThrow({ where: { cnes: UBS }, select: { id: true } });
    await t.http().post('/api/vigilancia/unidades-notificantes').set(auth(vig)).send({ unitId: ubs.id, desde: '2026-01-01' }).expect(201);
    const dB = dia(21);
    const A = lepto('6710001', dia(40));
    const B = lepto('6710002', dB);
    const C = lepto('6710003', dia(10));
    const D = lepto('6710004', dia(5));
    const periodo = { de: dia(60), ate: dia(1) };
    await enviarEAplicar(escreverDbf(CAMPOS_NINDINET, [A, B, C]), 'LEPTO-s1.DBF', periodo);
    const s2 = escreverDbf(CAMPOS_NINDINET, [A, C]);
    expect((await enviarEAplicar(s2, 'LEPTO-s2.DBF', periodo)).resultado.ausentesMarcados).toBe(1);
    await enviarEAplicar(escreverDbf(CAMPOS_NINDINET, [A, C, D]), 'LEPTO-s3.DBF', periodo);
    const atesto = (
      await t
        .http()
        .post('/api/vigilancia/negativas')
        .set(auth(vig))
        .send({ unitId: ubs.id, semana: semanaDaData(dB).codigo, emNome: { motivo: 'Atesto em nome da unidade para o teste.' } })
        .expect(201)
    ).body as { id: string };
    const r = await aplicar((await previa(s2, 'LEPTO-s2.DBF', { de: dia(18), ate: dia(1) })).id);
    expect(r.negativasCanceladas).toBe(0);
    expect((await db.negativeReport.findUniqueOrThrow({ where: { id: atesto.id }, select: { status: true } })).status).toBe('ATESTADA');
    expect((await registro('6710002')).absentSince).not.toBeNull();
  });

  it('R5-2 (P/Q): a marca passa para Q com a substituição; Q reaplicado com período menor não devolve o registro, porque P, ainda APLICADA, também não o traz', async () => {
    const R1 = lepto('6810001', '2019-01-14');
    const R2 = lepto('6810002', '2019-01-21');
    const R3 = lepto('6810003', '2019-03-18');
    const R4 = lepto('6810004', '2019-05-06');
    // E traz R1 e R2.
    await enviarEAplicar(escreverDbf(CAMPOS_NINDINET, [R1, R2]), 'LEPTO-E-2019.DBF', { de: '2019-01-01', ate: '2019-01-31' });
    const visto = (await registro('6810002')).lastSeenAt;
    // Q0 (o arquivo F) não traz R2: marca R2 ausente.
    const F = escreverDbf(CAMPOS_NINDINET, [R1, R3]);
    const { previa: q0 } = await enviarEAplicar(F, 'LEPTO-F.DBF', { de: '2019-01-01', ate: '2019-03-31' });
    const marcadoEm = (await registro('6810002')).absentSince;
    expect(await registro('6810002')).toMatchObject({ absentImportId: q0.id });
    // P (outra exportação, aplicada depois) também não traz R2: confirma a ausência (a marca continua com Q0).
    const { previa: p } = await enviarEAplicar(escreverDbf(CAMPOS_NINDINET, [R1, R3, R4]), 'LEPTO-P.DBF', { de: '2019-01-01', ate: '2019-06-30' });
    expect(await registro('6810002')).toMatchObject({ absentImportId: q0.id });
    // Q1: F de novo, com outro período que ainda cobre R2: substitui Q0, e R2 continua ausente, agora por Q1.
    const { previa: q1, resultado: r1 } = await enviarEAplicar(F, 'LEPTO-F.DBF', { de: '2019-01-01', ate: '2019-04-30' });
    expect(r1.substituidas!.map((s) => [s.id, s.voltaram])).toEqual([[q0.id, 0]]);
    expect(await registro('6810002')).toMatchObject({ absentSince: marcadoEm, absentImportId: q1.id, lastSeenAt: visto });
    // Q2: F com um período menor, que não cobre R2: substitui Q1. P (APLICADA, aplicada depois da última vez que R2
    // veio, e cobrindo R2) confirma a ausência: R2 não volta, e a marca passa para P.
    const q2 = await previa(F, 'LEPTO-F.DBF', { de: '2019-03-01', ate: '2019-04-30' });
    expect(q2.avisos[0]).toMatch(/A cobertura passa a ser a deste envio\.$/);
    const r2 = await aplicar(q2.id);
    expect(r2.substituidas!.map((s) => [s.id, s.voltaram])).toEqual([[q1.id, 0]]);
    expect(await registro('6810002')).toMatchObject({ absentSince: marcadoEm, absentImportId: p.id });
    expect(await oficiais('leptospirose', 2019)).toBe(3);
  });

  it('R5-2: a aplicação gravada sem a cobertura (dado antigo) não confirma a ausência: o registro volta', async () => {
    const ano = (a: number) => ({ de: `${a}-01-01`, ate: `${a}-12-31` });
    await enviarEAplicar(escreverDbf(DENGON, [den('0001801', '2018-03-05'), den('0001802', '2018-05-07')]), 'DENGON2018-E.DBF', ano(2018));
    const errado = escreverDbf(DENGON, [den('0002702', '2026-01-12')]);
    const { previa: i1 } = await enviarEAplicar(errado, 'DENGON-errado-2.DBF', ano(2018));
    const { previa: j } = await enviarEAplicar(escreverDbf(DENGON, [den('0001801', '2018-03-05')]), 'DENGON2018-J.DBF', ano(2018));
    expect(await registro('0001802')).toMatchObject({ absentImportId: i1.id });
    // J perde a cobertura gravada (como as aplicações de antes da regra e as da demonstração).
    const gravado = (await db.officialImport.findUniqueOrThrow({ where: { id: j.id }, select: { applyResult: true } })).applyResult as Record<string, unknown>;
    const { cobertura: _fora, ...semCobertura } = gravado;
    await db.officialImport.update({ where: { id: j.id }, data: { applyResult: semCobertura as never } });
    const i2 = await previa(errado, 'DENGON-errado-2.DBF', ano(2026));
    expect(i2.avisos[0]).toContain('e 1 registro(s) que ela deu como ausentes voltam.');
    expect((await aplicar(i2.id)).substituidas!.map((s) => s.voltaram)).toEqual([1]);
    expect(await registro('0001802')).toMatchObject({ absentSince: null, absentImportId: null });
  });

  // ───────────── R5-3: a vez de outro tenant antes do corpo ─────────────

  /** POST cru com Content-Length `declarado`, mandando só `primeiros` bytes; `fechar()` derruba a conexão. */
  const envioLento = (declarado: number, primeiros: number, caminho: string, token: string, tipo = 'application/octet-stream') => {
    const url = new URL(t.baseUrl.replace('[::1]', '127.0.0.1'));
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: caminho,
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': tipo, 'content-length': String(declarado) },
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
    req.on('error', () => undefined);
    req.write(Buffer.alloc(primeiros, 0x20));
    return { resposta, fechar: () => req.destroy() };
  };
  const esperarCargas = async (n: number, ms = 10_000) => {
    const fim = Date.now() + ms;
    while (ImportacaoService.cargas !== n) {
      if (Date.now() > fim) throw new Error(`cargas: ${ImportacaoService.cargas}, esperado ${n}`);
      await pausa(20);
    }
  };
  const SERVIDOR = { code: 'IMPORTACAO_SERVIDOR_OCUPADO', message: 'O servidor está recebendo ou processando outros envios agora. Tente de novo em instantes.' };
  const nindinet = (n: string) => escreverDbf(CAMPOS_NINDINET, [{ NU_NOTIFIC: n, TP_NOT: '2', ID_AGRAVO: 'A279', DT_NOTIFIC: '2024-07-01', ID_MUNICIP: MUN, ID_UNIDADE: UBS }]);

  it('R5-3: com a vez presa pela importação de outro tenant, o envio recebe 409 IMPORTACAO_SERVIDOR_OCUPADO antes de o corpo ser lido, sem reservar carga', async () => {
    LeituraDoCorpo.ociosoMs = 1500;
    const svc = t.app.get(ImportacaoService) as unknown as { exclusivo<T>(fn: () => Promise<T>): Promise<T> };
    let liberar = () => {};
    const ocupado = svc.exclusivo(() => new Promise<void>((r) => (liberar = r)));
    try {
      const lento = envioLento(8 * MB, 100, '/api/vigilancia/importacoes?nome=vez-ocupada.dbf', vig);
      try {
        const r = await lento.resposta;
        expect({ status: r.status, code: r.corpo?.code, message: r.corpo?.message, cargas: ImportacaoService.cargas }).toEqual({ status: 409, ...SERVIDOR, cargas: 0 });
        // Sem esperar o corpo (o prazo de ociosidade é de 1,5 s).
        expect(r.ms).toBeLessThan(1000);
      } finally {
        lento.fechar();
      }
    } finally {
      liberar();
      await ocupado;
    }
    expect(await db.officialImport.count({ where: { fileName: 'vez-ocupada.dbf' } })).toBe(0);
    await previa(nindinet('8500001'), 'depois-da-vez.dbf');
  });

  it('R5-3: a vez tomada por outro tenant enquanto o corpo chegava continua dando 409 depois do corpo (a corrida), e a carga é solta', async () => {
    const svc = t.app.get(ImportacaoService);
    const servico = svc as unknown as { exclusivo<T>(fn: () => Promise<T>): Promise<T> };
    const ctx = { db, tenant: { ...sys.tenant, id: 'tenant-corrida' }, session: { userId: '00000000-0000-0000-0000-000000000000' }, ip: '127.0.0.1', cbo: '' } as unknown as RequestContext;
    let liberar = () => {};
    let ocupado: Promise<void> = Promise.resolve();
    const r = await svc
      .enviar(
        ctx,
        async () => {
          // Outro tenant toma a vez no meio do corpo.
          ocupado = servico.exclusivo(() => new Promise<void>((ok) => (liberar = ok)));
          return Buffer.from(nindinet('8500002'));
        },
        { nome: 'corrida.dbf' },
      )
      .then(
        () => 'leu',
        (e: { code?: string }) => e.code ?? 'erro',
      );
    liberar();
    await ocupado;
    expect({ r, cargas: ImportacaoService.cargas }).toEqual({ r: 'IMPORTACAO_SERVIDOR_OCUPADO', cargas: 0 });
  });

  // ───────────── R5-4: o upload da SIGTAP reserva a carga ─────────────

  it('R5-4: o upload da SIGTAP reserva a carga antes de ler o corpo: um por tenant, o teto do processo vale para ele, e 4 pedidos parados não prendem 4 Buffers', async () => {
    const sigtap = '/api/billing/sigtap/import';
    // Um upload parado segura a carga do tenant (e uma do processo): o segundo do mesmo tenant recebe 409 sem ler.
    const primeiro = envioLento(60 * MB, 4, sigtap, fat, 'application/zip');
    try {
      await esperarCargas(1);
      const segundo = envioLento(60 * MB, 4, sigtap, fat, 'application/zip');
      try {
        expect(await segundo.resposta).toMatchObject({
          status: 409,
          corpo: { code: 'IMPORTACAO_SERVIDOR_OCUPADO', message: 'Outro envio da sua instituição está sendo recebido agora. Tente de novo quando ele terminar.' },
        });
      } finally {
        segundo.fechar();
      }
      // A importação da vigilância do mesmo tenant também espera (o mesmo contador).
      expect((await enviar(nindinet('8600001'), 'durante-a-sigtap.dbf').expect(409)).body).toMatchObject({ code: 'IMPORTACAO_SERVIDOR_OCUPADO' });
    } finally {
      primeiro.fechar();
    }
    await esperarCargas(0);

    // O processo cheio (os corpos de dois outros tenants sendo lidos): o upload da SIGTAP recebe 409 sem ler.
    const svc = t.app.get(ImportacaoService);
    const ctx = (tenant: string) => ({ db, tenant: { ...sys.tenant, id: tenant }, session: { userId: '00000000-0000-0000-0000-000000000000' }, ip: '127.0.0.1', cbo: '' }) as unknown as RequestContext;
    const soltar: ((e: Error) => void)[] = [];
    const corpos = ['tenant-b', 'tenant-c'].map((id) => svc.enviar(ctx(id), () => new Promise<Buffer>((_, falha) => soltar.push(falha)), { nome: `${id}.dbf` }).catch((e: Error) => e));
    try {
      await esperarCargas(2);
      const cheio = envioLento(60 * MB, 4, sigtap, fat, 'application/zip');
      try {
        const r = await cheio.resposta;
        expect(r).toMatchObject({ status: 409, corpo: SERVIDOR });
        expect(r.ms).toBeLessThan(5000);
      } finally {
        cheio.fechar();
      }
    } finally {
      for (const s of soltar) s(new Error('o cliente caiu'));
    }
    await Promise.all(corpos);
    await esperarCargas(0);

    // Quatro pedidos que só declaram 60 MB: só o primeiro é lido (um Buffer de 60 MB); os outros recebem 409.
    const porta = Number(new URL(t.baseUrl.replace('[::1]', '127.0.0.1')).port);
    const sockets: Socket[] = [];
    const respostas: Promise<string>[] = [];
    global.gc?.();
    const antes = process.memoryUsage().arrayBuffers;
    try {
      for (let i = 0; i < 4; i++) {
        const s = connect(porta, '127.0.0.1');
        sockets.push(s);
        respostas.push(
          new Promise<string>((ok) => {
            let txt = '';
            s.on('data', (d: Buffer) => (txt += d.toString()));
            s.on('close', () => ok(txt.split('\r\n')[0] ?? ''));
            s.on('error', () => ok(txt.split('\r\n')[0] ?? ''));
          }),
        );
        s.write(`POST ${sigtap} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${fat}\r\nContent-Type: application/zip\r\nContent-Length: ${60 * MB}\r\n\r\nPK\u0003\u0004`);
        await pausa(150);
      }
      await pausa(600);
      const presos = Math.round((process.memoryUsage().arrayBuffers - antes) / MB);
      expect(presos).toBeLessThan(100);
      expect(ImportacaoService.cargas).toBe(1);
    } finally {
      for (const s of sockets) s.destroy();
    }
    const linhas = await Promise.all(respostas);
    expect(linhas.filter((l) => l.includes(' 409 '))).toHaveLength(3);
    await esperarCargas(0);
  });

  // ───────────── R5-5: busca com caractere de controle ─────────────

  it('R5-5: a busca com caractere de controle (NUL, tabulação, DEL) dá 400 nas listas da conciliação e da importação; a busca comum continua 200', async () => {
    const status = async (lista: string, busca: string) => (await t.http().get(`/api/vigilancia/conciliacao/${lista}`).query({ busca }).set(auth(vig))).status;
    const listas = ['candidatas', 'so-oficial', 'so-omnisaude', 'divergentes', 'sugestoes', 'vinculados'];
    for (const lista of listas) expect({ lista, status: await status(lista, '100%_x\'"\\ José') }).toEqual({ lista, status: 200 });
    for (const busca of ['a\u0000b', 'a\tb', 'a\u007fb', 'a\u0085b'])
      for (const lista of listas) {
        const r = await t.http().get(`/api/vigilancia/conciliacao/${lista}`).query({ busca }).set(auth(vig));
        expect({ lista, busca, status: r.status, code: r.body.code, campo: r.body.details?.[0]?.path }).toEqual({ lista, busca, status: 400, code: 'VALIDACAO', campo: 'busca' });
      }
    // O espaço nas pontas sai antes (trim), como sempre.
    expect(await status('so-oficial', ' abc\n')).toBe(200);
    // O nome do arquivo enviado e o apelido de bairro também recusam (o nome é recusado antes de ler o corpo).
    expect((await enviar(nindinet('8700001'), 'arquivo\u0000.dbf').expect(400)).body.code).toBe('VALIDACAO');
    const apelido = await t.http().post('/api/vigilancia/conciliacao/bairros/apelido').set(auth(vig)).send({ nome: 'Vila\u0000Nova', neighborhoodId: '00000000-0000-0000-0000-000000000000' });
    expect({ status: apelido.status, code: apelido.body.code }).toEqual({ status: 400, code: 'VALIDACAO' });
  });
});
