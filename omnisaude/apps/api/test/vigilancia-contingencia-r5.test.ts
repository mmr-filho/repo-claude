import { demoFixtures } from '@omnisaude/database';
import { intervaloDaSemana, PLANO_MODELO_MS_2025, type DetalhePlano, type SituacaoContingencia } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { ContingenciaService } from '../src/modules/vigilancia/contingencia.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Plano de contingência na API, quinta rodada da semana 27 (R5-7): a descida olha a curva dos agravos que sustentam o
 * estágio (S). O serviço leva ao motor a SE de início do acionamento aberto (contingency_activations.started_week) e o
 * retrato gravado nele (contingency_activations.indicators): o critério de canal atendido no retrato põe o agravo em S
 * mesmo quando, desde o início, nenhuma janela de 4 SE o atendeu. Dados sintéticos.
 */
const enabled = await pgAvailable();

const MUNICIPIO = demoFixtures.DEMO_TENANT.ibgeCode;
const relogio = (dia: string) => () => new Date(`${dia}T15:00:00Z`);

describe.runIf(enabled)('Vigilância: contingência na quinta rodada (R5-7, descida pelos agravos que sustentam o estágio)', () => {
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
  const acionar = (bairro: string, estagio: string) =>
    t
      .http()
      .post('/api/vigilancia/contingencia/acionar')
      .set(auth(vig))
      .send({ estagio, justificativa: 'Chikungunya acima do limite superior há dez semanas (decisão da vigilância).', nivel: 'BAIRRO', territorio: bairro })
      .expect(201);

  /**
   * Bairro com a chikungunya em número de casos: 1 a 5 casos por SE de 2011 a 2015 (mediana 3, Q3 4,5) e, em 2016, 2 por
   * SE até a SE 19 e 10 (acima do LS) da SE 20 à 34, menos a SE 31, que cai para 2 (feriado com subnotificação).
   */
  async function bairroComQueda(codigo: string): Promise<string> {
    const loc = await db.locality.create({ data: { code: codigo, name: `Distrito Contingência ${codigo}` } });
    const bairro = await db.neighborhood.create({ data: { localityId: loc.id, name: `Bairro Contingência ${codigo}` }, select: { id: true, name: true } });
    const registro = (ano: number, se: number) => {
      n++;
      const semana = `${ano}${String(se).padStart(2, '0')}`;
      return {
        system: 'SINAN_ONLINE' as const,
        type: 'INDIVIDUAL' as const,
        naturalKey: `r5-chik-${n}`,
        number: String(7_600_000 + n),
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
    for (let se = 1; se <= 34; se++) for (let k = 0; k < (se >= 20 && se !== 31 ? 10 : 2); k++) dados.push(registro(2016, se));
    await db.officialRecord.createMany({ data: dados });
    return bairro.id;
  }

  beforeAll(async () => {
    t = await startTestApp('vigcontr5');
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
    // O CHIKON cobre de 2011 até 27/08/2016 (SE 34). Sem OmniSaúde em uso em 2016.
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
      periodo: { de: '2011-01-02', ate: '2016-08-27' },
      identificado: false,
      ignorado: false,
      avisos: [],
    };
    importacao = (await db.officialImport.create({ data: { system: 'SINAN_ONLINE', status: 'APLICADA', fileName: 'chikon-r5.zip', sha256: 'e'.repeat(64), sizeBytes: 1, createdBy: autor, files: [arquivo] } })).id;
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

  it('a SE de queda no meio da alta: a epidemia desce até o alerta (o nível da curva), não à normalidade (r4vdia-1)', async () => {
    const bairro = await bairroComQueda('99000541');
    // 03/08/2016 (SE 31): a epidemia decidida pela vigilância; o retrato vai até a SE 29.
    emDia('2016-08-03');
    await acionar(bairro, 'EPIDEMIA');
    // 07/09/2016 (SE 36): as SE 31 a 34 são as 4 completas desde o acionamento; a 31 é a da queda.
    emDia('2016-09-07');
    const s = await situacao(bairro);
    const chik = s.indicadores.find((i) => i.grupo === 'chikungunya')!;
    expect(
      chik.semanas
        .filter((x) => x.completa)
        .slice(-5)
        .map((x) => [x.semana, x.status]),
    ).toEqual([
      ['201630', 'ACIMA_LS'],
      ['201631', 'ATE_CENTRO'],
      ['201632', 'ACIMA_LS'],
      ['201633', 'ACIMA_LS'],
      ['201634', 'ACIMA_LS'],
    ]);
    // Nenhum critério atendido na SE de referência: as 4 janelas contêm a SE de queda.
    expect(s.avaliacao!.criterios.filter((c) => c.atendido === true)).toEqual([]);
    // Antes: "pode desmobilizar para Normalidade", com a curva acima do LS em 3 das 4 SE.
    expect(s.avaliacao).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: true } });
    expect(s.avaliacao!.desmobilizacao.detalhe).toBe(
      `Sugestão abaixo de Situação de epidemia nas últimas 4 SE completas: pode desmobilizar para Alerta. ${PLANO_MODELO_MS_2025.desmobilizacao.descricao}. Na SE 34/2016, a curva de chikungunya está acima do limite superior, no nível do critério de canal de Alerta: a descida para nele.`,
    );
  });

  it('S pelo retrato do acionamento: o critério de canal atendido nele segura o alerta pela curva; sem retrato, valem só as sugestões', async () => {
    const bairro = await bairroComQueda('99000542');
    emDia('2016-08-03');
    const acionamento = (await acionar(bairro, 'ALERTA')).body.acionamento as { id: string; semanaInicio: string };
    expect(acionamento.semanaInicio).toBe('201631');
    // O retrato gravado (SE completas até a 29): a chikungunya acima do LS nas SE 26 a 29, o critério de canal do alerta.
    const gravado = await db.contingencyActivation.findUniqueOrThrow({ where: { id: acionamento.id } });
    const retrato = (gravado.indicators as { grupo: string; semanas: { semana: string; status: string; completa: boolean }[] }[]).find((i) => i.grupo === 'chikungunya')!;
    expect(
      retrato.semanas
        .filter((x) => x.completa)
        .slice(-4)
        .map((x) => x.status),
    ).toEqual(['ACIMA_LS', 'ACIMA_LS', 'ACIMA_LS', 'ACIMA_LS']);

    // Desde a SE 31, nenhuma janela de 4 SE ficou inteira acima do LS: a chikungunya está em S pelo retrato, e a curva
    // acima do LS na SE 34 segura o alerta.
    emDia('2016-09-07');
    const s = await situacao(bairro);
    expect(s.estagioAtual.chave).toBe('ALERTA');
    expect(s.avaliacao).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    expect(s.avaliacao!.desmobilizacao.detalhe).toBe(
      'Sugestão abaixo de Alerta há 0 de 4 SE completas seguidas: manter Alerta até completar 4. A SE 34/2016 não conta como abaixo: a curva de chikungunya está acima do limite superior, no nível do critério de canal de Alerta; descer pede a curva abaixo desse nível em cada SE.',
    );

    // O mesmo acionamento sem retrato (como o da demonstração, gravado com a lista vazia): S fica vazio e, com o dado
    // presente, valem só as sugestões das 4 SE (antes, a curva de todo agravo com canal segurava o alerta).
    await db.contingencyActivation.update({ where: { id: acionamento.id }, data: { indicators: [] } });
    const semRetrato = await situacao(bairro);
    expect(semRetrato.avaliacao).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
    expect(semRetrato.avaliacao!.desmobilizacao.detalhe).toContain('pode desmobilizar para Normalidade');
  });
});
