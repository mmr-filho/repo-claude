import { demoFixtures } from '@omnisaude/database';
import { intervaloDaSemana, PLANO_MODELO_MS_2025, type DetalhePlano, type SituacaoContingencia } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { ContingenciaService } from '../src/modules/vigilancia/contingencia.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Plano de contingência na API, sexta rodada da semana 27 (R6-4, r5vdia-1): o acionamento grava o início na SE em curso
 * (started_week, W) e o retrato com as SE completas do dia (com as 2 semanas incompletas do padrão, até a W-2). Os
 * agravos que sustentam o estágio (S) também olham as SE entre o retrato e o início: o critério de canal que fechou na
 * SE ainda incompleta no dia da decisão (a vigilância acionou pelo nowcasting, ou vendo a SE incompleta no diagrama) põe
 * o agravo em S, e a SE de queda no acionamento não leva mais a descida à normalidade com a curva acima do LS (N8).
 * Dados sintéticos (chikungunya em número de casos, como os testes da quinta rodada).
 */
const enabled = await pgAvailable();

const MUNICIPIO = demoFixtures.DEMO_TENANT.ibgeCode;
const relogio = (dia: string) => () => new Date(`${dia}T15:00:00Z`);
const MANTER_ALERTA =
  'Sugestão abaixo de Alerta há 0 de 4 SE completas seguidas: manter Alerta até completar 4. A SE 34/2016 não conta como abaixo: a curva de chikungunya está acima do limite superior, no nível do critério de canal de Alerta; descer pede a curva abaixo desse nível em cada SE.';

describe.runIf(enabled)('Vigilância: contingência na sexta rodada (R6-4, S enxerga a SE que estava incompleta no acionamento)', () => {
  let t: TestApp;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let autor = '';
  let importacao = '';
  let n = 0;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  /** Põe os dois serviços na mesma data. */
  const emDia = (dia: string) => {
    t.app.get(ContingenciaService).agora = relogio(dia);
    t.app.get(DiagramaService).agora = relogio(dia);
  };
  const situacao = async (bairro: string) => (await t.http().get(`/api/vigilancia/contingencia?nivel=BAIRRO&territorio=${bairro}`).set(auth(vig)).expect(200)).body as SituacaoContingencia;
  /** Aciona o estágio e devolve o acionamento com a última SE completa do retrato gravado. */
  const acionar = async (bairro: string, estagio: string) => {
    const r = await t
      .http()
      .post('/api/vigilancia/contingencia/acionar')
      .set(auth(vig))
      .send({ estagio, justificativa: 'Decisão da vigilância pela curva da chikungunya (sexta rodada).', nivel: 'BAIRRO', territorio: bairro })
      .expect(201);
    const acionamento = r.body.acionamento as { id: string; semanaInicio: string };
    const gravado = await db.contingencyActivation.findUniqueOrThrow({ where: { id: acionamento.id } });
    const retrato = (gravado.indicators as { grupo: string; semanas: { semana: string; completa: boolean }[] }[]).find((i) => i.grupo === 'chikungunya')!;
    return { ...acionamento, ultimaDoRetrato: retrato.semanas.filter((x) => x.completa).at(-1)!.semana };
  };
  /** As SE completas de `de` a `ate` da chikungunya, com o status. */
  const statusDe = (s: SituacaoContingencia, de: string, ate: string) =>
    s.indicadores
      .find((i) => i.grupo === 'chikungunya')!
      .semanas.filter((x) => x.completa && x.semana >= de && x.semana <= ate)
      .map((x) => `${x.semana.slice(4)}:${x.status}`);

  /**
   * Bairro com a chikungunya em número de casos: 1 a 5 casos por SE de 2011 a 2015 (mediana 3, Q3 4,5: 2 casos ficam até
   * o centro e 10 acima do LS) e, em 2016, os casos por SE dados por `casos(se)` até a SE 35.
   */
  async function bairroCom(codigo: string, casos: (se: number) => number): Promise<string> {
    const loc = await db.locality.create({ data: { code: codigo, name: `Distrito Contingência ${codigo}` } });
    const bairro = await db.neighborhood.create({ data: { localityId: loc.id, name: `Bairro Contingência ${codigo}` }, select: { id: true, name: true } });
    const registro = (ano: number, se: number) => {
      n++;
      const semana = `${ano}${String(se).padStart(2, '0')}`;
      return {
        system: 'SINAN_ONLINE' as const,
        type: 'INDIVIDUAL' as const,
        naturalKey: `r6-chik-${n}`,
        number: String(7_800_000 + n),
        notifiedOn: new Date(`${intervaloDaSemana(ano, se).inicio}T00:00:00Z`),
        epiWeekNotified: semana,
        epiWeekOnset: semana,
        municipalityIbge: MUNICIPIO,
        residenceIbge: MUNICIPIO,
        neighborhoodName: bairro.name,
        agravo: 'A92.0',
        groupKey: 'chikungunya',
        situation: 'CONFIRMADO',
        contentHash: '0'.repeat(64),
        firstImportId: importacao,
        lastImportId: importacao,
        lastSeenAt: new Date(),
      };
    };
    const dados = [];
    for (const [i, ano] of [2011, 2012, 2013, 2014, 2015].entries()) for (let se = 1; se <= 52; se++) for (let k = 0; k <= i; k++) dados.push(registro(ano, se));
    for (let se = 1; se <= 35; se++) for (let k = 0; k < casos(se); k++) dados.push(registro(2016, se));
    await db.officialRecord.createMany({ data: dados });
    return bairro.id;
  }

  beforeAll(async () => {
    t = await startTestApp('vigcontr6');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    await t.app.get(CatalogoVigilanciaService).garantir({ tenant, db });
    // As tabelas desta frente começam vazias (a demonstração semeia plano e acionamento).
    await db.contingencyActionItem.deleteMany();
    await db.contingencyActivation.deleteMany();
    await db.contingencyInput.deleteMany();
    await db.contingencyPlan.deleteMany();
    await db.controlChannel.deleteMany();
    await db.diagramSetting.deleteMany();
    autor = (await db.user.findFirstOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf }, select: { id: true } })).id;
    // O CHIKON cobre de 2011 até 03/09/2016 (fim da SE 35). Sem OmniSaúde em uso em 2016.
    const arquivo = {
      nome: 'CHIKON.DBF',
      tipo: 'CHIKON',
      sistema: 'SINAN_ONLINE',
      tipoRegistro: 'INDIVIDUAL',
      tamanhoBytes: 1,
      registros: 1,
      codificacao: null,
      origemCodificacao: null,
      agravos: ['A92.0'],
      periodo: { de: '2011-01-02', ate: '2016-09-03' },
      identificado: false,
      ignorado: false,
      avisos: [],
    };
    importacao = (await db.officialImport.create({ data: { system: 'SINAN_ONLINE', status: 'APLICADA', fileName: 'chikon-r6.zip', sha256: 'd'.repeat(64), sizeBytes: 1, createdBy: autor, files: [arquivo] } })).id;
    emDia('2016-08-03');
    await t
      .http()
      .put('/api/vigilancia/diagrama/configuracao/chikungunya')
      .set(auth(vig))
      .send({ modelo: 'MS_2025', receita: { unidade: 'CASOS' }, anosExcluidos: [], fontePopulacao: null, versaoPopulacao: null })
      .expect(200);
    const plano = (await t.http().post('/api/vigilancia/contingencia/planos').set(auth(vig)).send({ modelo: 'MS_2025' }).expect(201)).body as DetalhePlano;
    await t.http().post(`/api/vigilancia/contingencia/planos/${plano.id}/vigencia`).set(auth(vig)).send({ desde: '2016-01-04' }).expect(200);
  });

  afterAll(async () => {
    await t?.close();
  });

  it('r5vdia-1: o alerta acionado pelo nowcasting com a 4ª SE acima do LS ainda incompleta e a SE do acionamento de queda é mantido', async () => {
    // 2016: 2 casos por SE (até o centro) até a SE 26; 10 (acima do LS) nas SE 27 a 30; a SE 31 (a do acionamento) cai
    // para 2 (feriado com subnotificação); 10 nas SE 32 a 35.
    const bairro = await bairroCom('99000661', (se) => (se >= 27 && se !== 31 ? 10 : 2));
    // 03/08/2016 (SE 31, em curso): a vigilância responde o nowcasting do alerta na semana de referência (SE 29), o
    // plano sugere o alerta e ela aciona. O retrato vai até a SE 29 (SE 30 e 31 incompletas), sem critério de canal
    // atendido.
    emDia('2016-08-03');
    const antes = await situacao(bairro);
    expect(antes.semanaReferencia).toBe('201629');
    expect(statusDe(antes, '201626', '201629')).toEqual(['26:ATE_CENTRO', '27:ACIMA_LS', '28:ACIMA_LS', '29:ACIMA_LS']);
    await t
      .http()
      .post('/api/vigilancia/contingencia/respostas')
      .set(auth(vig))
      .send({ semana: '201629', criterio: 'ale-nowcasting', atendido: true, nota: 'InfoDengue: acima do LS nas SE 27 a 30.', nivel: 'BAIRRO', territorio: bairro })
      .expect(200);
    expect((await situacao(bairro)).avaliacao!.sugerido).toBe('ALERTA');
    const acionamento = await acionar(bairro, 'ALERTA');
    expect(acionamento).toMatchObject({ semanaInicio: '201631', ultimaDoRetrato: '201629' });

    // 07/09/2016 (SE 36): as SE 31 a 34 são as 4 completas desde o acionamento. O critério de canal do alerta fechou na
    // SE 30 (27 a 30), a que estava incompleta no dia da decisão: a chikungunya está em S, e a curva acima do LS na SE
    // 34 segura o alerta. Antes: "pode desmobilizar para Normalidade" com a curva acima do LS em 3 das 4 SE.
    emDia('2016-09-07');
    const s = await situacao(bairro);
    expect(statusDe(s, '201627', '201634')).toEqual(['27:ACIMA_LS', '28:ACIMA_LS', '29:ACIMA_LS', '30:ACIMA_LS', '31:ATE_CENTRO', '32:ACIMA_LS', '33:ACIMA_LS', '34:ACIMA_LS']);
    expect(s.avaliacao!.criterios.filter((c) => c.atendido === true)).toEqual([]);
    expect(s.avaliacao).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: MANTER_ALERTA } });

    // 14/09/2016 (SE 37): a SE 35 acima do LS fecha o critério de novo e confirma o alerta (sem vai e volta).
    emDia('2016-09-14');
    expect((await situacao(bairro)).avaliacao).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: '' } });
  });

  it('r5vdia-1 na epidemia: a mesma curva leva a descida só até o alerta (o piso de nível), não à normalidade', async () => {
    const bairro = await bairroCom('99000662', (se) => (se >= 27 && se !== 31 ? 10 : 2));
    emDia('2016-08-03');
    expect(await acionar(bairro, 'EPIDEMIA')).toMatchObject({ semanaInicio: '201631', ultimaDoRetrato: '201629' });
    emDia('2016-09-07');
    const s = await situacao(bairro);
    expect(s.avaliacao).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: true } });
    expect(s.avaliacao!.desmobilizacao.detalhe).toBe(
      `Sugestão abaixo de Situação de epidemia nas últimas 4 SE completas: pode desmobilizar para Alerta. ${PLANO_MODELO_MS_2025.desmobilizacao.descricao}. Na SE 34/2016, a curva de chikungunya está acima do limite superior, no nível do critério de canal de Alerta: a descida para nele.`,
    );
  });

  it('com 3 semanas incompletas, o retrato vai até a W-3 e a SE W-2 também conta para S', async () => {
    // A configuração da consolidação vale para o retrato e para a situação.
    const config = (semanasIncompletas: number) => t.http().patch('/api/vigilancia/configuracoes').set(auth(vig)).send({ consolidacao: { semanasIncompletas } }).expect(200);
    await config(3);
    try {
      // 2016: acima do LS nas SE 26 a 29 (o critério de canal do alerta fecha na SE 29, a W-2), queda nas SE 30 e 31 (a
      // 31 é a do acionamento) e acima do LS nas SE 32 a 35. Nenhuma janela que termina na SE 30 ou depois fica inteira
      // acima do LS, e o retrato (até a SE 28) também não atende o critério.
      const bairro = await bairroCom('99000663', (se) => ((se >= 26 && se <= 29) || se >= 32 ? 10 : 2));
      emDia('2016-08-03');
      expect(await acionar(bairro, 'ALERTA')).toMatchObject({ semanaInicio: '201631', ultimaDoRetrato: '201628' });
      // 14/09/2016 (SE 37): com 3 semanas incompletas, as SE 31 a 34 são as 4 completas desde o acionamento.
      emDia('2016-09-14');
      const s = await situacao(bairro);
      expect(s.semanasIncompletas).toEqual(['201635', '201636', '201637']);
      expect(statusDe(s, '201625', '201634')).toEqual(['25:ATE_CENTRO', '26:ACIMA_LS', '27:ACIMA_LS', '28:ACIMA_LS', '29:ACIMA_LS', '30:ATE_CENTRO', '31:ATE_CENTRO', '32:ACIMA_LS', '33:ACIMA_LS', '34:ACIMA_LS']);
      expect(s.avaliacao).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: MANTER_ALERTA } });
    } finally {
      await config(2);
    }
  });
});
