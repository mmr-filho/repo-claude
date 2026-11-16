import { demoFixtures } from '@omnisaude/database';
import { intervaloDaSemana, type RespostaDiagrama } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { ConsolidadoService } from '../src/modules/vigilancia/consolidado.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Cobertura da base consolidada por semana epidemiológica (VIG-1c, achado dia-4): SE fora do período das importações
 * aplicadas e de antes do OmniSaúde entrar em uso fica null (fora do canal), mesmo em ano com caso; semana coberta sem
 * caso fica 0. O relógio fica em 17/08/2016 (SE 33): o ano em análise é 2016 e a referência, 2011 a 2015. Nenhuma
 * notificação do OmniSaúde antes de 2016. Dados sintéticos.
 */
const enabled = await pgAvailable();

const AGORA = new Date('2016-08-17T15:00:00Z');
const MUNICIPIO = demoFixtures.DEMO_TENANT.ibgeCode;

describe.runIf(enabled)('Vigilância: cobertura da base consolidada por SE (VIG-1c, dia-4)', () => {
  let t: TestApp;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let sys: { tenant: Awaited<ReturnType<TenantsService['resolve']>>; db: typeof db };
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  let autor = '';
  let nReg = 0;

  /** Arquivo AGRAVO_NET de Zika (A92.8) de uma importação aplicada, com o período lido no arquivo. */
  const zikanet = (nome: string, de: string, ate: string) => ({
    nome,
    tipo: 'AGRAVO_NET',
    sistema: 'SINAN_NET',
    tipoRegistro: 'INDIVIDUAL',
    tamanhoBytes: 1,
    registros: 1,
    codificacao: null,
    origemCodificacao: null,
    agravos: ['A928'],
    periodo: { de, ate },
    identificado: false,
    ignorado: false,
    avisos: [],
  });
  const importar = async (nome: string, de: string, ate: string) =>
    (
      await db.officialImport.create({
        data: { system: 'SINAN_NET', status: 'APLICADA', fileName: nome, sha256: String(nome.length).repeat(64).slice(0, 64), sizeBytes: 1, createdBy: autor, files: [zikanet(nome, de, ate)] },
      })
    ).id;
  /** Registro oficial individual de Zika com início dos sintomas na SE. */
  const zika = (semana: string, importacao: string) => {
    nReg++;
    const inicio = intervaloDaSemana(Number(semana.slice(0, 4)), Number(semana.slice(4))).inicio;
    return {
      system: 'SINAN_NET' as const,
      type: 'INDIVIDUAL' as const,
      naturalKey: `cob-${nReg}`,
      number: String(6_000_000 + nReg),
      notifiedOn: new Date(`${inicio}T00:00:00Z`),
      epiWeekNotified: semana,
      epiWeekOnset: semana,
      municipalityIbge: MUNICIPIO,
      residenceIbge: MUNICIPIO,
      agravo: 'A928',
      groupKey: 'zika',
      situation: 'CONFIRMADO',
      contentHash: '0'.repeat(64),
      firstImportId: importacao,
      lastImportId: importacao,
      lastSeenAt: new Date(),
    };
  };
  const diagrama = async (q: string) => (await t.http().get(`/api/vigilancia/diagrama?${q}`).set(auth(vig)).expect(200)).body as RespostaDiagrama;

  beforeAll(async () => {
    t = await startTestApp('vigdiagcob');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    sys = { tenant, db };
    t.app.get(DiagramaService).agora = () => AGORA;
    await db.controlChannel.deleteMany();
    await db.diagramSetting.deleteMany();
    await db.populationEstimate.deleteMany();
    await t.app.get(CatalogoVigilanciaService).garantir(sys);
    autor = (await db.user.findFirstOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf }, select: { id: true } })).id;

    // Zika: 2011 a 2014 com 1, 2, 3 e 4 casos em cada SE, num arquivo que cobre os 4 anos (até a SE 53/2014).
    const historico = await importar('ZIKANET2011-2014.DBF', '2011-01-02', '2015-01-03');
    const dados = [];
    for (const [i, ano] of [2011, 2012, 2013, 2014].entries()) for (let se = 1; se <= 52; se++) for (let k = 0; k <= i; k++) dados.push(zika(`${ano}${String(se).padStart(2, '0')}`, historico));
    // 2015: o arquivo só traz de 04/01 a 04/04 (SE 1 a 13), com 2 casos na SE 5; um caso da SE 40 chegou por outro envio.
    const parcial = await importar('ZIKANET2015.DBF', '2015-01-04', '2015-04-04');
    dados.push(zika('201505', parcial), zika('201505', parcial), zika('201540', parcial));
    await db.officialRecord.createMany({ data: dados });
    await t
      .http()
      .put('/api/vigilancia/diagrama/configuracao/zika')
      .set(auth(vig))
      .send({ modelo: 'MS_2025', receita: { unidade: 'CASOS' }, anosExcluidos: [], fontePopulacao: null, versaoPopulacao: null })
      .expect(200);
  });

  afterAll(async () => {
    await t?.close();
  });

  it('ano de referência importado só em parte: as SE fora do período ficam fora do canal, não viram 0', async () => {
    const r = await diagrama('grupo=zika&ano=2016');
    const canal = r.canais[0]!.canal;
    expect(canal.anosReferencia).toEqual([2011, 2012, 2013, 2014, 2015]);
    // SE 30: 2015 sem base (null) fica fora; com os 4 anos, Q1 = 1,25, mediana = 2,5 e Q3 = 3,75 (QUARTIL.EXC).
    // Com o 0 de antes, seriam n = 5, Q1 = 0,5, mediana = 2 e Q3 = 3,5 (falsos "acima do LS").
    const se30 = canal.semanas[29]!;
    expect(se30.valores.find((v) => v.ano === 2015)).toMatchObject({ casos: null, valor: null });
    expect(se30).toMatchObject({ n: 4, q1: 1.25, mediana: 2.5, q3: 3.75 });
    // SE 5 (no período): os 2 casos; SE 40 (fora do período, com caso): o caso conta, nunca se perde.
    expect(canal.semanas[4]!.valores.find((v) => v.ano === 2015)).toMatchObject({ casos: 2 });
    expect(canal.semanas[39]!.valores.find((v) => v.ano === 2015)).toMatchObject({ casos: 1 });
    expect(canal.semanas[39]!.n).toBe(5);
    // SE 6 (no período, sem caso): 0.
    expect(canal.semanas[5]!.valores.find((v) => v.ano === 2015)).toMatchObject({ casos: 0 });
    // A cobertura diz que 2015 é parcial, e o canal avisa.
    expect(r.cobertura.find((c) => c.ano === 2015)).toEqual({
      ano: 2015,
      coberto: true,
      parcial: true,
      semanasCobertas: 14,
      motivo: 'Coberto só nas SE 1 a 13 e 40 (importação aplicada: ZIKANET2015.DBF; SE com caso do agravo); as demais SE ficam fora do canal',
    });
    expect(r.cobertura.find((c) => c.ano === 2014)).toMatchObject({ coberto: true, parcial: false, semanasCobertas: 53, motivo: 'Coberto o ano todo (importação aplicada: ZIKANET2011-2014.DBF)' });
    expect(canal.avisos).toContain('Ano 2015 coberto só nas SE 1 a 13 e 40: as SE sem base importada nem OmniSaúde em uso ficam fora do canal.');
  });

  it('o ano em que o OmniSaúde entrou em uso: só as SE desde a primeira notificação ficam cobertas', async () => {
    // Uma única notificação (de dengue) conhecida na SE 20/2016; nenhuma importação traz chikungunya.
    const [paciente, unidade, condicao] = await Promise.all([
      db.patient.findFirstOrThrow({ where: { mergedIntoId: null }, select: { id: true } }),
      db.unit.findFirstOrThrow({ where: { name: 'UBS Centro' }, select: { id: true } }),
      db.notifiableCondition.findFirstOrThrow({ where: { key: 'dengue' }, select: { id: true, key: true } }),
    ]);
    const inicio = intervaloDaSemana(2016, 20).inicio;
    await db.notification.create({
      data: {
        year: 2016,
        seq: 990_001,
        number: '2016/990001',
        status: 'NOTIFICADA',
        origin: 'MANUAL',
        conditionId: condicao.id,
        conditionKey: condicao.key,
        groupKey: 'dengue',
        patientId: paciente.id,
        unitId: unidade.id,
        notifierId: autor,
        notifierRole: 'VIGILANCIA_EPIDEMIOLOGICA',
        knownAt: new Date(`${inicio}T15:00:00Z`),
        deadlineStart: 'CONHECIMENTO',
        deadlineKind: 'SEMANAL',
        targets: ['SMS'],
        symptomsOnset: new Date(`${inicio}T00:00:00Z`),
        epiWeekOnset: '201620',
        epiWeekNotified: '201620',
        outOfMunicipality: false,
        form: {},
      },
    });
    const consolidado = t.app.get(ConsolidadoService);
    const r = await consolidado.casosPorSemana(sys, { grupo: 'chikungunya', nivel: 'MUNICIPIO', territorioId: null, anos: [2015, 2016], base: 'PROVAVEIS' });
    // 2015: nenhuma base. 2016: null até a SE 19 (antes, o ano inteiro virava 0), 0 da SE 20 em diante.
    expect(r.porAno.get(2015)!.every((v) => v === null)).toBe(true);
    const s2016 = r.porAno.get(2016)!;
    expect(s2016.slice(0, 19).every((v) => v === null)).toBe(true);
    expect(s2016.slice(19, 52).every((v) => v === 0)).toBe(true);
    expect(s2016[52]).toBeNull();
    expect(r.cobertura).toEqual([
      { ano: 2015, coberto: false, parcial: false, semanasCobertas: 0, motivo: 'Nenhuma base cobre o ano: fica fora do canal' },
      { ano: 2016, coberto: true, parcial: true, semanasCobertas: 33, motivo: 'Coberto só nas SE 20 a 52 (OmniSaúde em uso desde a SE 20/2016); as demais SE ficam fora do canal' },
    ]);
    // Para a Zika, o OmniSaúde soma ao período da importação: 2016 coberto da SE 20 em diante.
    const z = await consolidado.casosPorSemana(sys, { grupo: 'zika', nivel: 'MUNICIPIO', territorioId: null, anos: [2016], base: 'PROVAVEIS' });
    expect([z.porAno.get(2016)![18], z.porAno.get(2016)![19]]).toEqual([null, 0]);
  });
});
