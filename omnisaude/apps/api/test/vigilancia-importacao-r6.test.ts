import { calcularCanal, intervaloDaSemana, LNNC_NACIONAL, RECEITAS_MODELO, semanaDaData, type DetalheImportacao, type ResultadoAplicacao } from '@omnisaude/shared';
import { zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { arquivoCobre, arquivosCobertos, gruposDoArquivo } from '../src/modules/vigilancia/cobertura-importacao';
import { ConsolidadoService } from '../src/modules/vigilancia/consolidado.service';
import { ImportacaoService } from '../src/modules/vigilancia/importacao.service';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Importação (VIG-1c), sexta rodada, com o banco:
 * - R6-1: a prévia conta os ausentes como a aplicação marca, com o registro sem CNES (o arquivo de um CNES só antes do
 *   do município no zip), sem município (dois CSV do município que se cruzam) e sem agravo (o surto do NSURTNET), e na
 *   substituição anuncia os mesmos "voltam" que a aplicação dá;
 * - R6-2: a base consolidada e a conciliação leem o que cada arquivo cobre da cobertura dos ausentes gravada pela
 *   aplicação (só as linhas do sistema do arquivo, com o tipo do arquivo): o NINDINET com algumas linhas de dengue (do
 *   Sinan Online) não cobre a dengue nem estica o período; a aplicação gravada sem essa lista (a demonstração, dado de
 *   antes da regra) usa o files[]; sem esse NINDINET, a leitura dá o mesmo que o files[];
 * - R6-3: o caractere de controle dentro do arquivo (célula do CSV, campo do DBF, nome da entrada do zip) é limpo na
 *   leitura, com aviso, e o envio não cai; a entrada do zip cujo nome só fica oculto ou vazio depois de limpo entra ou
 *   fica fora com o motivo, e não some (r6vimp-1).
 * Dados sintéticos.
 */

const enabled = await pgAvailable();
const MUN = '355030';
const UBS = '9000011';
const X = '9000011';
const Y = '9000028';
const ESPERA = ImportacaoService.esperaMs;
const enc = (s: string) => new TextEncoder().encode(s);
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cobertura gravada no apply_result (só o que os testes comparam). */
interface CoberturaGravada {
  sistema: string;
  tipo: string;
  tipoArquivo?: string;
  agravos: (string | null)[];
  de: string;
  ate: string;
}

describe.runIf(enabled)('importação, sexta rodada: prévia × aplicação com nulos, cobertura da base consolidada e da conciliação, caractere de controle', () => {
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
  const coberturaGravada = async (id: string) => ((await db.officialImport.findUniqueOrThrow({ where: { id }, select: { applyResult: true } })).applyResult as { cobertura?: CoberturaGravada[] } | null)?.cobertura;
  const resumo = async () =>
    (await t.http().get('/api/vigilancia/conciliacao/resumo').set(auth(vig)).expect(200)).body as { cobertura: { sistema: string; grupos: string[] | null; cnes: string | null; de: string; ate: string }[] };

  /** CSV do e-SUS Notifica (síndrome gripal): número, CNES ('' = sem CNES), data (DD/MM/AAAA) e município ('' = sem). */
  const csvSg = (linhas: ([string, string, string] | [string, string, string, string])[]) =>
    enc(
      `${['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Sintoma- Febre', 'Classificação Final'].join(';')}\r\n${linhas
        .map(([n, cnes, data, mun]) => [n, data, mun ?? '3550308', cnes, `Pessoa ${n}`, 'Sim', 'Confirmado Laboratorial'].join(';'))
        .join('\r\n')}\r\n`,
    );
  const ausentesEsus = async (prefixo: string) =>
    (await db.officialRecord.findMany({ where: { system: 'ESUS_NOTIFICA', absentSince: { not: null }, number: { startsWith: prefixo } }, select: { number: true } })).map((r) => r.number).sort();

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
  const NIND: CampoEscrita[] = [...CAMPOS_NINDINET, { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 2 }, { nome: 'CRITERIO', tipo: 'C', tamanho: 1 }, { nome: 'EVOLUCAO', tipo: 'C', tamanho: 1 }];
  const DENGON: CampoEscrita[] = [...NIND, { nome: 'FEBRE', tipo: 'C', tamanho: 1 }];
  const CHIKON: CampoEscrita[] = [...NIND, { nome: 'FEBRE', tipo: 'C', tamanho: 1 }, { nome: 'CLINC_CHIK', tipo: 'C', tamanho: 1 }];
  /** O DBF de investigação da leptospirose (uma coluna da ficha fora da notificação individual). */
  const LEPTONET: CampoEscrita[] = [...NIND, { nome: 'ANT_AGUA', tipo: 'C', tamanho: 1 }];
  const den = (n: string, dt: string) => base({ NU_NOTIFIC: n, ID_AGRAVO: 'A90', DT_NOTIFIC: dt, NM_PACIENT: `DENGUE ${n}`, CS_SEXO: 'F', FEBRE: '1', CLASSI_FIN: '10', CRITERIO: '1' });
  const chik = (n: string, dt: string) => base({ NU_NOTIFIC: n, ID_AGRAVO: 'A920', DT_NOTIFIC: dt, NM_PACIENT: `CHIK ${n}`, CS_SEXO: 'F', FEBRE: '1', CLINC_CHIK: '1', CLASSI_FIN: '13', CRITERIO: '1' });
  const lepto = (n: string, dt: string) => base({ NU_NOTIFIC: n, ID_AGRAVO: 'A279', DT_NOTIFIC: dt, NM_PACIENT: `LEPTO ${n}`, CS_SEXO: 'M' });
  const hans = (n: string, dt: string) => base({ NU_NOTIFIC: n, ID_AGRAVO: 'A309', DT_NOTIFIC: dt, NM_PACIENT: `HANS ${n}`, CS_SEXO: 'M' });

  beforeAll(async () => {
    t = await startTestApp('vigimpr6');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    sys = { tenant, db };
  }, 180_000);

  afterEach(async () => {
    ImportacaoService.esperaMs = ESPERA;
    await ImportacaoService.aguardarTrabalhos();
  });

  afterAll(async () => {
    await ImportacaoService.aguardarTrabalhos();
    await t?.close();
  });

  // ───────────── R6-1: a prévia conta os ausentes como a aplicação marca ─────────────

  describe('R6-1: o registro com coluna nula não some da prévia', () => {
    /** Base: o CSV do município com A (X), B (sem CNES) e C (Y); depois o zip sem B. `unidadeAntes`: o arquivo da unidade vem antes do do município. */
    const cenario = async (ano: number, unidadeAntes: boolean) => {
      const aa = String(ano).slice(2);
      const n = (k: number) => `35${aa}0100000${k}`;
      const [A, B, C, D] = [n(1), n(2), n(3), n(4)];
      await enviarEAplicar(
        csvSg([
          [A, X, `10/06/${ano}`],
          [B, '', `12/06/${ano}`],
          [C, Y, `14/06/${ano}`],
        ]),
        `municipio-base-${ano}.csv`,
      );
      const unidade = csvSg([
        [A, X, `10/06/${ano}`],
        [D, X, `20/06/${ano}`],
      ]);
      const municipio = csvSg([
        [A, X, `10/06/${ano}`],
        [C, Y, `14/06/${ano}`],
      ]);
      // Os arquivos do zip são lidos em ordem de nome: "autocadastro-..." < "municipio.csv" < "unidade-...".
      const zip = zipSync(unidadeAntes ? { [`autocadastro-${X}.csv`]: unidade, 'municipio.csv': municipio } : { 'municipio.csv': municipio, [`unidade-${X}.csv`]: unidade });
      const { previa: p, resultado: r } = await enviarEAplicar(zip, `misto-${ano}.zip`);
      return {
        ordem: p.arquivos.map((a) => [a.nome, a.cnes]),
        res: { previstos: p.contagens?.ausentesPrevistos, amostra: p.previa?.ausentes.map((a) => a.numero) ?? [], marcados: r.ausentesMarcados, ausentes: await ausentesEsus(`35${aa}`) },
        B,
      };
    };

    it('sem CNES: com o arquivo da unidade (um CNES só) antes do do município no zip, a prévia anuncia o registro sem CNES que a aplicação marca (como com o do município antes)', async () => {
      const controle = await cenario(2024, false);
      expect(controle.ordem).toEqual([
        ['municipio.csv', null],
        [`unidade-${X}.csv`, X],
      ]);
      expect(controle.res).toEqual({ previstos: 1, amostra: [controle.B], marcados: 1, ausentes: [controle.B] });
      const unidadeAntes = await cenario(2025, true);
      expect(unidadeAntes.ordem).toEqual([
        [`autocadastro-${X}.csv`, X],
        ['municipio.csv', null],
      ]);
      expect(unidadeAntes.res).toEqual({ previstos: 1, amostra: [unidadeAntes.B], marcados: 1, ausentes: [unidadeAntes.B] });
    });

    it('sem município: dois CSV do município que se cruzam, o segundo com uma linha sem município; o registro sem município que não veio está na prévia e na aplicação', async () => {
      const ano = 2022;
      const [A, B, C, D] = ['352201000001', '352201000002', '352201000003', '352201000004'];
      await enviarEAplicar(
        csvSg([
          [A, X, `10/07/${ano}`],
          [B, Y, `12/07/${ano}`, ''],
          [C, Y, `14/07/${ano}`],
        ]),
        `municipio-base-${ano}.csv`,
      );
      // A primeira exportação só com linhas com município; a segunda com uma linha sem município (o D, novo). O B (sem
      // município, 12/07) está nas duas faixas de datas e não veio.
      const zip = zipSync({
        'a-municipio.csv': csvSg([
          [A, X, `10/07/${ano}`],
          [C, Y, `14/07/${ano}`],
        ]),
        'b-municipio.csv': csvSg([
          [C, Y, `14/07/${ano}`],
          [D, X, `11/07/${ano}`, ''],
        ]),
      });
      const { previa: p, resultado: r } = await enviarEAplicar(zip, `municipio-duas-${ano}.zip`);
      expect({ previstos: p.contagens?.ausentesPrevistos, amostra: p.previa?.ausentes.map((a) => a.numero), marcados: r.ausentesMarcados, ausentes: await ausentesEsus('3522') }).toEqual({
        previstos: 1,
        amostra: [B],
        marcados: 1,
        ausentes: [B],
      });
    });

    it('sem agravo: o surto sem agravo (NSURTNET) dentro do segundo arquivo e no período do primeiro, que só tem surto com agravo', async () => {
      const SURTO: CampoEscrita[] = [
        { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
        { nome: 'TP_NOT', tipo: 'C', tamanho: 1 },
        { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 4 },
        { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
        { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
        { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
        { nome: 'DT_SIN_PRI', tipo: 'D', tamanho: 8 },
        { nome: 'ID_MUNI_RE', tipo: 'C', tamanho: 6 },
        { nome: 'QT_TOTAL_C', tipo: 'C', tamanho: 5 },
        { nome: 'CS_LOCAL', tipo: 'C', tamanho: 2 },
        { nome: 'NM_LOCAL', tipo: 'C', tamanho: 30 },
      ];
      const surto = (n: string, dt: string, agravo: string) => ({
        NU_NOTIFIC: n,
        TP_NOT: '3',
        ID_AGRAVO: agravo,
        DT_NOTIFIC: dt,
        ID_MUNICIP: MUN,
        ID_UNIDADE: UBS,
        DT_SIN_PRI: dt,
        ID_MUNI_RE: MUN,
        QT_TOTAL_C: '5',
        CS_LOCAL: '3',
        NM_LOCAL: 'ESCOLA DO TESTE',
      });
      const [S1, S2, S3, S4] = ['2103001', '2103002', '2103003', '2103004'];
      await enviarEAplicar(escreverDbf(SURTO, [surto(S1, '2021-03-10', 'A08'), surto(S2, '2021-03-12', ''), surto(S3, '2021-03-14', 'A08')]), 'NSURTNET-base.DBF');
      expect(await db.officialRecord.findFirstOrThrow({ where: { type: 'SURTO', number: S2 }, select: { agravo: true } })).toEqual({ agravo: null });
      // "a-": surtos com agravo de 10/03 a 14/03; "b-": de 11/03 a 14/03, com um surto sem agravo (o S4, novo). O S2 (sem
      // agravo, 12/03) não veio: só o "b-" o cobre, e ele está no período do "a-" (que veio antes no zip).
      const zip = zipSync({
        'a-NSURTNET.DBF': escreverDbf(SURTO, [surto(S1, '2021-03-10', 'A08'), surto(S3, '2021-03-14', 'A08')]),
        'b-NSURTNET.DBF': escreverDbf(SURTO, [surto(S3, '2021-03-14', 'A08'), surto(S4, '2021-03-11', '')]),
      });
      const { previa: p, resultado: r } = await enviarEAplicar(zip, 'surtos-2021.zip');
      expect((await coberturaGravada(p.id))!.map((c) => [c.tipo, c.agravos, c.de, c.ate])).toEqual([
        ['SURTO', ['A08'], '2021-03-10', '2021-03-14'],
        ['SURTO', [null, 'A08'], '2021-03-11', '2021-03-14'],
      ]);
      const ausentes = (await db.officialRecord.findMany({ where: { type: 'SURTO', absentSince: { not: null }, number: { startsWith: '2103' } }, select: { number: true } })).map((x) => x.number);
      expect({ previstos: p.contagens?.ausentesPrevistos, amostra: p.previa?.ausentes.map((a) => a.numero), marcados: r.ausentesMarcados, ausentes }).toEqual({ previstos: 1, amostra: [S2], marcados: 1, ausentes: [S2] });
    });

    it('substituição: a prévia não anuncia a volta do ausente sem CNES que a aplicação mantém ausente (dentro da cobertura nova)', async () => {
      const ano = 2023;
      const [A, B, C] = ['352301000101', '352301000201', '352301000301'];
      await enviarEAplicar(
        csvSg([
          [A, X, `10/05/${ano}`],
          [B, '', `12/05/${ano}`],
          [C, Y, `15/05/${ano}`],
        ]),
        `municipio-base-${ano}.csv`,
      );
      const zip = zipSync({
        [`autocadastro-${X}.csv`]: csvSg([[A, X, `10/05/${ano}`]]),
        'municipio.csv': csvSg([
          [A, X, `10/05/${ano}`],
          [C, Y, `15/05/${ano}`],
        ]),
      });
      // Com o período de maio declarado, o zip marca o B (sem CNES), que não veio.
      const { previa: velho, resultado: rVelho } = await enviarEAplicar(zip, `misto-${ano}.zip`, { de: `${ano}-05-01`, ate: `${ano}-05-31` });
      expect({ previstos: velho.contagens?.ausentesPrevistos, marcados: rVelho.ausentesMarcados, ausentes: await ausentesEsus('3523') }).toEqual({ previstos: 1, marcados: 1, ausentes: [B] });
      // O mesmo zip com maio e junho: o B continua dentro da cobertura (o CSV do município) e não veio.
      const novo = await previa(zip, `misto-${ano}.zip`, { de: `${ano}-05-01`, ate: `${ano}-06-30` });
      const aviso = novo.avisos.find((a) => a.startsWith('Este envio substitui')) ?? '';
      const rNovo = await aplicar(novo.id);
      const registroB = await db.officialRecord.findFirstOrThrow({ where: { number: B }, select: { absentSince: true, absentImportId: true } });
      expect({ voltaram: rNovo.substituidas?.map((s) => s.voltaram), marca: registroB.absentImportId, ausente: !!registroB.absentSince }).toEqual({ voltaram: [0], marca: novo.id, ausente: true });
      expect(aviso).toMatch(/A cobertura passa a ser a deste envio\.$/);
    });
  });

  // ───────────── R6-2: a base consolidada e a conciliação usam a cobertura dos ausentes ─────────────

  describe('R6-2: o que o arquivo cobre na base consolidada e na conciliação é o que cobre nos ausentes', () => {
    it('sem o NINDINET com linhas de outro sistema, a cobertura lida do apply_result é a mesma do files[] (arquivos, SE cobertas da base consolidada e cobertura da conciliação)', async () => {
      const ids: string[] = [];
      const nomes: string[] = [];
      const aplicarArquivo = async (bytes: Uint8Array, nome: string, q: Record<string, string> = {}) => {
        const { previa: p } = await enviarEAplicar(bytes, nome, q);
        ids.push(p.id);
        nomes.push(nome);
        return p;
      };
      // Sinan Net: o NINDINET só com agravos do Sinan Net e o DBF da leptospirose; Sinan Online: o DENGON e o CHIKON.
      const nind = await aplicarArquivo(escreverDbf(NIND, [lepto('1300001', '2013-02-11'), hans('1300002', '2013-05-06'), lepto('1300003', '2013-10-14'), hans('1300004', '2013-11-18')]), 'NINDINET2013.DBF');
      expect(nind.arquivos.map((a) => a.tipo)).toEqual(['NINDINET']);
      const lnet = await aplicarArquivo(
        escreverDbf(LEPTONET, [
          { ...lepto('1300011', '2013-03-04'), ANT_AGUA: '1' },
          { ...lepto('1300012', '2013-08-19'), ANT_AGUA: '2' },
        ]),
        'LEPTONET2013.DBF',
      );
      expect(lnet.arquivos.map((a) => a.tipo)).toEqual(['AGRAVO_NET']);
      await aplicarArquivo(escreverDbf(DENGON, [den('1300021', '2013-01-21'), den('1300022', '2013-04-15'), den('1300023', '2013-06-03')]), 'DENGON2013.DBF', { de: '2013-01-01', ate: '2013-12-31' });
      const chikon = await aplicarArquivo(escreverDbf(CHIKON, [chik('1300031', '2013-02-25'), chik('1300032', '2013-09-09')]), 'CHIKON2013.DBF');
      expect(chikon.arquivos.map((a) => a.tipo)).toEqual(['CHIKON']);
      // e-SUS Notifica: o CSV de uma unidade (um CNES só) e o do município num zip.
      const esus = await aplicarArquivo(
        zipSync({
          [`ubs-${X}.csv`]: csvSg([
            ['352100990001', X, '08/03/2021'],
            ['352100990002', X, '19/04/2021'],
          ]),
          'municipio.csv': csvSg([
            ['352100990003', X, '15/03/2021'],
            ['352100990004', Y, '24/05/2021'],
          ]),
        }),
        'esus-2021.zip',
      );
      expect(esus.arquivos.map((a) => [a.nome, a.cnes])).toEqual([
        ['municipio.csv', null],
        [`ubs-${X}.csv`, X],
      ]);
      // e-SUS Sinan: mpox de duas unidades.
      await aplicarArquivo(
        enc(
          '"nu_notific";"id_agravo";"dt_notific";"id_municip";"id_unidade";"classi_fin";"evolucao"\r\n' +
            [
              ['352300990001', 'B04', '06/03/2023', X],
              ['352300990002', 'B04', '17/07/2023', Y],
            ]
              .map(([n, ag, d, c]) => `"${n}";"${ag}";"${d}";"355030";"${c}";"1";"1"`)
              .join('\r\n') +
            '\r\n',
        ),
        'esus-sinan-2023.csv',
      );
      for (const id of ids) expect((await coberturaGravada(id))!.every((c) => c.tipo !== 'INDIVIDUAL' || !!c.tipoArquivo)).toBe(true);

      const GRUPOS = [...new Set(LNNC_NACIONAL.flatMap((v) => v.conditions.map((c) => c.group)))].sort();
      const consolidado = t.app.get(ConsolidadoService);
      const retrato = async () => {
        const arquivos = (await arquivosCobertos(db, sys.tenant.timeZone))
          .filter((a) => nomes.includes(a.envio))
          .flatMap((a) => (a.cnes.length ? a.cnes : [null]).map((cnes) => JSON.stringify([a.envio, a.fonte.sistema, cnes, a.de, a.ate, GRUPOS.filter((g) => arquivoCobre(a.fonte, g)), gruposDoArquivo(a.fonte)])))
          .sort();
        const semanas: Record<string, unknown> = {};
        for (const [grupo, ano] of [
          ['leptospirose', 2013],
          ['hanseniase', 2013],
          ['dengue', 2013],
          ['chikungunya', 2013],
          ['covid', 2021],
          ['mpox', 2023],
        ] as const) {
          const b = await consolidado.carregar(sys as never, grupo, [ano], false);
          semanas[`${grupo}-${ano}`] = { cobertura: b.cobertura, semanas: b.semanasCobertas.get(ano) };
        }
        return { arquivos, semanas, conciliacao: (await resumo()).cobertura };
      };
      const pelaCobertura = await retrato();
      // Tira a cobertura do apply_result destas importações (como a aplicação gravada antes da regra): a leitura volta ao files[].
      const gravados = await db.officialImport.findMany({ where: { id: { in: ids } }, select: { id: true, applyResult: true } });
      await db.$executeRaw`UPDATE official_imports SET apply_result = apply_result - 'cobertura' WHERE id = ANY(${ids}::uuid[])`;
      try {
        const peloFiles = await retrato();
        expect(peloFiles).toEqual(pelaCobertura);
      } finally {
        for (const g of gravados) await db.officialImport.update({ where: { id: g.id }, data: { applyResult: g.applyResult as object } });
      }
      // Os arquivos lidos: um por arquivo (o zip do e-SUS Notifica, dois), com o CNES e o período de cada um.
      expect(pelaCobertura.arquivos.map((a) => (JSON.parse(a) as unknown[]).slice(0, 5)).sort()).toEqual(
        [
          ['NINDINET2013.DBF', 'SINAN_NET', null, '2013-02-11', '2013-11-18'],
          ['LEPTONET2013.DBF', 'SINAN_NET', null, '2013-03-04', '2013-08-19'],
          ['DENGON2013.DBF', 'SINAN_ONLINE', null, '2013-01-01', '2013-12-31'],
          ['CHIKON2013.DBF', 'SINAN_ONLINE', null, '2013-02-25', '2013-09-09'],
          ['esus-2021.zip', 'ESUS_NOTIFICA', null, '2021-03-15', '2021-05-24'],
          ['esus-2021.zip', 'ESUS_NOTIFICA', X, '2021-03-08', '2021-04-19'],
          ['esus-sinan-2023.csv', 'ESUS_SINAN', null, '2023-03-06', '2023-07-17'],
        ].sort(),
      );
      // E as SE cobertas são as dos arquivos: a leptospirose de fevereiro a novembro de 2013 (NINDINET e o DBF do agravo).
      expect(pelaCobertura.semanas['leptospirose-2013']).toMatchObject({ cobertura: [expect.objectContaining({ semanasCobertas: 41, motivo: expect.stringContaining('NINDINET2013.DBF, LEPTONET2013.DBF') })] });
      expect(pelaCobertura.semanas['dengue-2013']).toMatchObject({ cobertura: [expect.objectContaining({ coberto: true, parcial: false })] });
    });

    it('o NINDINET de 2022 com 2 linhas de dengue não cobre a dengue: a dengue de 2022 fica só com as SE com caso e o canal da SE 10 de 2025 não muda', async () => {
      const consolidado = t.app.get(ConsolidadoService);
      // A dengue dos anos de referência de 2025 (MS 2025: os 5 anos anteriores), menos 2022: casos na SE 10 de cada ano.
      const casosSe10: Record<number, number> = { 2020: 8, 2021: 12, 2023: 10, 2024: 14 };
      for (const [ano, n] of Object.entries(casosSe10)) {
        const dia = intervaloDaSemana(Number(ano), 10).inicio;
        const linhas = Array.from({ length: n }, (_, i) => den(`${ano.slice(2)}${String(i).padStart(5, '0')}`, dia));
        await enviarEAplicar(escreverDbf(DENGON, linhas), `DENGON${ano}.DBF`, { de: `${ano}-01-01`, ate: `${ano}-12-31` });
      }
      const canal = async () => {
        const b = await consolidado.carregar(sys as never, 'dengue', [2020, 2021, 2022, 2023, 2024], false);
        const casos = consolidado.agregar(b, { nivel: 'MUNICIPIO', territorioId: null, base: 'PROVAVEIS', anos: b.anos });
        const series = [2020, 2021, 2022, 2023, 2024].map((ano) => ({ ano, semanas: casos.porAno.get(ano) ?? [], populacao: 100_000 }));
        const c = calcularCanal(series, 2025, { ...RECEITAS_MODELO.MS_2025.receita, unidade: 'CASOS' }, []);
        const se10 = c.semanas.find((s) => s.semana === 10)!;
        const cob2022 = b.cobertura.find((x) => x.ano === 2022)!;
        return {
          anosReferencia: c.anosReferencia,
          se10: { li: se10.li, centro: se10.centro, ls: se10.ls },
          dengue2022: { semanasCobertas: cob2022.semanasCobertas, motivo: cob2022.motivo, casos: (casos.porAno.get(2022) ?? []).reduce((a: number, v) => a + (v ?? 0), 0) },
        };
      };
      const antes = await canal();
      expect(antes.dengue2022).toEqual({ semanasCobertas: 0, motivo: 'Nenhuma base cobre o ano: fica fora do canal', casos: 0 });

      // O NINDINET de 2022 (Sinan Net: leptospirose ao longo do ano) com 2 notificações de dengue, que são do Sinan Online.
      const nindinet = escreverDbf(NIND, [
        ...Array.from({ length: 10 }, (_, i) => lepto(`20${String(i).padStart(5, '0')}`, `2022-${String(i + 1).padStart(2, '0')}-10`)),
        lepto('2000010', '2022-12-20'),
        den('2209001', '2022-06-14'),
        den('2209002', '2022-09-20'),
      ]);
      const { previa: p } = await enviarEAplicar(nindinet, 'NINDINET2022.DBF');
      // O files[] mostra todas as linhas (a tela); a cobertura gravada, só as do Sinan Net, com o tipo do arquivo.
      expect(p.arquivos.map((a) => [a.tipo, a.agravos, a.periodo])).toEqual([['NINDINET', ['A279', 'A90'], { de: '2022-01-10', ate: '2022-12-20' }]]);
      expect((await coberturaGravada(p.id))!.map((c) => [c.sistema, c.tipoArquivo, c.agravos, c.de, c.ate])).toEqual([['SINAN_NET', 'NINDINET', ['A279'], '2022-01-10', '2022-12-20']]);
      const depois = await canal();
      // A dengue de 2022 fica só com as SE dos 2 casos (a regra "SE com caso do agravo"): as demais SE ficam fora do canal,
      // e a SE 10 de 2025 continua calculada só com 2020, 2021, 2023 e 2024. O ano 2022 entra na lista dos anos de
      // referência pelas 2 SE com caso, sem mudar a SE 10 (consequência aceita na decisão R6-2).
      expect(depois.dengue2022).toEqual({ semanasCobertas: 2, motivo: 'Coberto só nas SE 24 e 38 (SE com caso do agravo); as demais SE ficam fora do canal', casos: 2 });
      expect(depois.se10).toEqual(antes.se10);
      expect(antes.se10).toEqual({ li: 8.5, centro: 11, ls: 13.5 });
      expect(depois.anosReferencia).toEqual([2020, 2021, 2022, 2023, 2024]);
      // A leptospirose de 2022 continua coberta pelo NINDINET (de 10/01 a 20/12).
      const lepto2022 = (await consolidado.carregar(sys as never, 'leptospirose', [2022], false)).cobertura[0]!;
      expect(lepto2022).toMatchObject({ coberto: true, motivo: expect.stringContaining('importação aplicada: NINDINET2022.DBF') });
      expect(lepto2022.semanasCobertas).toBe(semanaDaData('2022-12-20').semana - semanaDaData('2022-01-10').semana + 1);
    });

    it('a dengue de dezembro num NINDINET não estica o período dele: a conciliação e a base consolidada cobrem o Sinan Net só até a última linha do Sinan Net', async () => {
      const { previa: p } = await enviarEAplicar(
        escreverDbf(NIND, [...Array.from({ length: 6 }, (_, i) => lepto(`18${String(i).padStart(5, '0')}`, `2018-${String(i + 1).padStart(2, '0')}-10`)), den('1809001', '2018-12-20')]),
        'NINDINET2018.DBF',
      );
      expect(p.arquivos[0]!.periodo).toEqual({ de: '2018-01-10', ate: '2018-12-20' });
      // A conciliação: o Sinan Net (todos os grupos) de 10/01 a 10/06; nada do Sinan Online por este arquivo.
      const cob2018 = (await resumo()).cobertura.filter((c) => c.de.startsWith('2018'));
      expect(cob2018).toEqual([{ sistema: 'SINAN_NET', grupos: null, cnes: null, de: '2018-01-10', ate: '2018-06-10' }]);
      // A base consolidada: a leptospirose de 2018 coberta da SE de 10/01 à de 10/06; a dengue só na SE do caso.
      const consolidado = t.app.get(ConsolidadoService);
      const lepto2018 = await consolidado.carregar(sys as never, 'leptospirose', [2018], false);
      const cobertas = lepto2018.semanasCobertas.get(2018)!.flatMap((m, i) => (m ? [i + 1] : []));
      expect([cobertas[0], cobertas[cobertas.length - 1], cobertas.length]).toEqual([
        semanaDaData('2018-01-10').semana,
        semanaDaData('2018-06-10').semana,
        semanaDaData('2018-06-10').semana - semanaDaData('2018-01-10').semana + 1,
      ]);
      const dengue2018 = (await consolidado.carregar(sys as never, 'dengue', [2018], false)).cobertura[0]!;
      expect(dengue2018).toMatchObject({ semanasCobertas: 1, motivo: expect.stringContaining('SE com caso do agravo') });
    });

    it('a aplicação gravada sem a cobertura (a demonstração) ou com a entrada sem o tipo do arquivo (antes da regra) é lida pelo files[]', async () => {
      const autor = (await db.user.findFirstOrThrow({ select: { id: true } })).id;
      let seq = 0;
      const importacao = (nome: string, files: object[], applyResult: object | null) =>
        db.officialImport.create({
          data: {
            system: 'SINAN_NET',
            status: 'APLICADA',
            fileName: nome,
            sha256: String(++seq).padStart(64, 'e'),
            sizeBytes: 1,
            files,
            createdBy: autor,
            appliedBy: autor,
            appliedAt: new Date(),
            ...(applyResult ? { applyResult } : {}),
          },
        });
      const arquivo = (nome: string, tipo: string, sistema: string, agravos: string[], de: string, ate: string) => ({
        nome,
        tipo,
        sistema,
        tipoRegistro: 'INDIVIDUAL',
        tamanhoBytes: 1,
        registros: 1,
        codificacao: null,
        origemCodificacao: null,
        agravos,
        cnes: null,
        periodo: { de, ate },
        identificado: true,
        ignorado: false,
        avisos: [],
      });
      // A demonstração: o files[] do DENGON de 2016, sem apply_result.
      await importacao('demonstracao-2016', [arquivo('DENGON2016.DBF', 'DENGON', 'SINAN_ONLINE', ['A90'], '2016-01-04', '2016-12-30')], null);
      // Gravada antes da regra: a cobertura sem o tipo do arquivo (só a leptospirose) e o files[] com a dengue.
      await importacao('nindinet-antigo-2017', [arquivo('NINDINET2017.DBF', 'NINDINET', 'SINAN_NET', ['A279', 'A90'], '2017-01-09', '2017-12-29')], {
        cobertura: [{ sistema: 'SINAN_NET', tipo: 'INDIVIDUAL', agravos: ['A279'], de: '2017-01-09', ate: '2017-06-30', municipios: [MUN], municipioNulo: false }],
      });
      const consolidado = t.app.get(ConsolidadoService);
      const dengue = await consolidado.carregar(sys as never, 'dengue', [2016, 2017], false);
      expect(dengue.cobertura.map((c) => [c.ano, c.coberto, c.motivo])).toEqual([
        [2016, true, expect.stringContaining('importação aplicada: demonstracao-2016')],
        [2017, true, expect.stringContaining('importação aplicada: nindinet-antigo-2017')],
      ]);
      expect((await resumo()).cobertura.filter((c) => c.de.startsWith('2016') || c.de.startsWith('2017'))).toEqual([
        { sistema: 'SINAN_NET', grupos: null, cnes: null, de: '2017-01-09', ate: '2017-12-29' },
        { sistema: 'SINAN_ONLINE', grupos: ['dengue'], cnes: null, de: '2016-01-04', ate: '2016-12-30' },
      ]);
    });
  });

  // ───────────── R6-3: caractere de controle dentro do arquivo ─────────────

  describe('R6-3: o caractere de controle dentro do arquivo não derruba o envio', () => {
    /** CSV do e-SUS Notifica com `n` linhas: a linha `qual` (a última, se não dada) leva `bairro` e `nome` dados. */
    const csvComBairro = (prefixo: string, n: number, linha: { bairro?: string; nome?: string; qual?: number }) =>
      enc(
        `${['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Bairro', 'Sintoma- Febre', 'Classificação Final'].join(';')}\r\n${Array.from(
          { length: n },
          (_, i) => {
            const num = `${prefixo}${String(i).padStart(4, '0')}`;
            const esta = i === (linha.qual ?? n - 1);
            return [
              num,
              '10/03/2022',
              '3550308',
              '9000011',
              esta && linha.nome !== undefined ? linha.nome : `Pessoa ${num}`,
              esta && linha.bairro !== undefined ? linha.bairro : 'Centro',
              'Sim',
              'Confirmado Laboratorial',
            ].join(';');
          },
        ).join('\r\n')}\r\n`,
      );
    const LIMPOS = '1 campo(s) com caractere de controle foram limpos (cada sequência deles virou um espaço).';
    const percurso = async (bytes: Uint8Array, nome: string, prefixo: string) => {
      const { previa: p, resultado: r } = await enviarEAplicar(bytes, nome);
      const gravados = await db.officialRecord.findMany({ where: { number: { startsWith: prefixo } }, select: { number: true, patientName: true, neighborhoodName: true } });
      return { p, r, gravados };
    };

    it('NUL na célula do CSV depois dos primeiros 4 KB (bairro): a prévia e a aplicação saem, com o bairro limpo e o aviso no arquivo', async () => {
      const { p, r, gravados } = await percurso(csvComBairro('35220100', 80, { bairro: 'Vila\u0000Nova' }), 'nul-bairro.csv', '35220100');
      expect([p.status, !!r.aplicadoEm, gravados.length]).toEqual(['PREVIA', true, 80]);
      expect(gravados.find((g) => g.number === '352201000079')!.neighborhoodName).toBe('Vila Nova');
      expect(p.arquivos[0]!.avisos).toContain(LIMPOS);
    });

    it('NUL e outros caracteres de controle no nome do paciente: o nome gravado é limpo', async () => {
      const { p, gravados } = await percurso(csvComBairro('35220200', 80, { nome: 'Maria\u0000\u0007Silva' }), 'nul-nome.csv', '35220200');
      expect(gravados).toHaveLength(80);
      expect(gravados.find((g) => g.number === '352202000079')!.patientName).toBe('Maria Silva');
      expect(p.arquivos[0]!.avisos).toContain(LIMPOS);
    });

    it('NUL no começo do CSV (nos primeiros 4 KB): o arquivo continua lido como CSV', async () => {
      const { p, gravados } = await percurso(csvComBairro('35220500', 3, { bairro: 'Jardim\u0000\u0000Sul', qual: 0 }), 'nul-comeco.csv', '35220500');
      expect(p.arquivos.map((a) => [a.tipo, a.ignorado, a.registros])).toEqual([['ESUS_NOTIFICA_CSV', false, 3]]);
      expect(gravados.find((g) => g.number === '352205000000')!.neighborhoodName).toBe('Jardim Sul');
    });

    it('NUL no meio de um campo do DBF (NM_BAIRRO): o campo é limpo e o envio entra inteiro', async () => {
      const linha = (n: string, bairro: string) => ({ ...lepto(n, '2022-04-05'), NM_BAIRRO: bairro });
      const { p, gravados } = await percurso(escreverDbf(CAMPOS_NINDINET, [linha('7220001', 'CENTRO'), linha('7220002', 'VILA\u0000NOVA')]), 'NUL-NINDINET.DBF', '72200');
      expect(gravados.map((g) => [g.number, g.neighborhoodName]).sort()).toEqual([
        ['7220001', 'CENTRO'],
        ['7220002', 'VILA NOVA'],
      ]);
      expect(p.arquivos[0]!.avisos).toContain(LIMPOS);
    });

    it('NUL no nome de um arquivo dentro do zip: o nome é limpo, com aviso; depois do 202 a leitura termina em PREVIA', async () => {
      const AVISO_NOME = 'O nome do arquivo dentro do zip tinha caractere de controle: foi limpo (cada sequência deles virou um espaço).';
      const { p, gravados } = await percurso(zipSync({ 'ubs\u0000x.csv': csvComBairro('35220300', 3, {}) }), 'nul-no-nome.zip', '35220300');
      expect(gravados).toHaveLength(3);
      expect(p.arquivos.map((a) => [a.nome, a.avisos.includes(AVISO_NOME)])).toEqual([['ubs x.csv', true]]);
      // Depois do 202 (a espera acabou), a leitura termina em segundo plano, sem erro.
      ImportacaoService.esperaMs = 1;
      const r = await enviar(zipSync({ 'ubs\u0000y.csv': csvComBairro('35220400', 3, {}), 'leia\u0001me.txt': enc('nada') }), 'nul-no-nome-2.zip');
      expect([201, 202]).toContain(r.status);
      await ImportacaoService.aguardarTrabalhos();
      await pausa(50);
      const linha = await db.officialImport.findUniqueOrThrow({ where: { id: (r.body as { id: string }).id }, select: { status: true, error: true, files: true } });
      expect({ status: linha.status, error: linha.error }).toEqual({ status: 'PREVIA', error: null });
      expect((linha.files as { nome: string; avisos: string[] }[]).map((a) => [a.nome, a.avisos.includes(AVISO_NOME)]).sort()).toEqual([
        ['leia me.txt', true],
        ['ubs y.csv', true],
      ]);
    });

    it('nome que só fica oculto ou vazio depois de limpo (r6vimp-1): "\\u0001.csv" entra com o aviso; o zip só com "\\u0001" é recusado citando o arquivo', async () => {
      const AVISO_NOME = 'O nome do arquivo dentro do zip tinha caractere de controle: foi limpo (cada sequência deles virou um espaço).';
      const { previa: p, resultado: r } = await enviarEAplicar(zipSync({ '\u0001.csv': csvComBairro('35220600', 2, {}), 'outro.csv': csvComBairro('35220610', 2, {}) }), 'nome-oculto.zip');
      expect(p.arquivos.map((a) => [a.nome, a.ignorado, a.registros, a.avisos.includes(AVISO_NOME)])).toEqual([
        ['.csv', false, 2, true],
        ['outro.csv', false, 2, false],
      ]);
      expect(r.aplicadoEm).toBeTruthy();
      const gravados = await db.officialRecord.findMany({ where: { number: { startsWith: '352206' } }, select: { number: true } });
      expect(gravados.map((g) => g.number).sort()).toEqual(['352206000000', '352206000001', '352206100000', '352206100001']);
      // Sozinha no zip, a entrada de nome só com caractere de controle fica fora, e o erro sem registros a cita.
      const so = (await enviar(zipSync({ '\u0001': enc('nada') }), 'so-controle.zip').expect(422)).body as { code: string; message: string; details: { arquivos: { nome: string }[] } };
      expect(so.code).toBe('SEM_REGISTROS');
      expect(so.message).toBe('Nenhum arquivo com notificações reconhecidas. (sem nome): fora da importação (não é .dbf nem .csv).');
      expect(so.details.arquivos.map((a) => a.nome)).toEqual(['(sem nome)']);
    });
  });
});
