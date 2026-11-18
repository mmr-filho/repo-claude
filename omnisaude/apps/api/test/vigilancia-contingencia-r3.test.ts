import { demoFixtures } from '@omnisaude/database';
import { intervaloDaSemana, type DetalhePlano, type PlanoResumo, type SituacaoContingencia } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { ContingenciaService } from '../src/modules/vigilancia/contingencia.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Plano de contingência na API, terceira rodada da semana 27: a importação que não cobre as últimas SE não faz a curva
 * "voltar ao canal" (DIAGRAMA-1), o plano posto em vigor e substituído no mesmo dia (DIAGRAMA-3), as versões criadas ao
 * mesmo tempo (DIAGRAMA-7) e as restrições da 0031 nas tabelas da contingência. Dados sintéticos.
 */
const enabled = await pgAvailable();

const MUNICIPIO = demoFixtures.DEMO_TENANT.ibgeCode;
const relogio = (dia: string) => () => new Date(`${dia}T15:00:00Z`);

describe.runIf(enabled)('Vigilância: contingência na terceira rodada (DIAGRAMA-1, DIAGRAMA-3, DIAGRAMA-7 e restrições da 0031)', () => {
  let t: TestApp;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let autor = '';
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  /** Põe os dois serviços na mesma data. */
  const emDia = (dia: string) => {
    t.app.get(ContingenciaService).agora = relogio(dia);
    t.app.get(DiagramaService).agora = relogio(dia);
  };

  beforeAll(async () => {
    t = await startTestApp('vigcontr3');
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
  });

  afterAll(async () => {
    await t?.close();
  });

  it('três planos criados ao mesmo tempo saem com as versões 1, 2 e 3 (DIAGRAMA-7)', async () => {
    emDia('2016-08-03');
    const rs = await Promise.all([1, 2, 3].map(() => t.http().post('/api/vigilancia/contingencia/planos').set(auth(vig)).send({ modelo: 'MS_2025' })));
    // Antes, os três liam o mesmo máximo e gravavam a mesma versão.
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(rs.map((r) => (r.body as DetalhePlano).versao).sort()).toEqual([1, 2, 3]);
    const lista = (await t.http().get('/api/vigilancia/contingencia/planos').set(auth(vig)).expect(200)).body as PlanoResumo[];
    expect(lista.map((p) => p.versao).sort()).toEqual([1, 2, 3]);
  });

  it('plano posto em vigor e substituído no mesmo dia: o anterior vigorou só naquele dia (DIAGRAMA-3)', async () => {
    emDia('2017-03-10');
    const [b, c] = (await db.contingencyPlan.findMany({ orderBy: { version: 'asc' }, take: 2 })).map((p) => p.id);
    const vigencia = (id: string, desde: string) => t.http().post(`/api/vigilancia/contingencia/planos/${id}/vigencia`).set(auth(vig)).send({ desde });
    expect((await vigencia(b!, '2017-03-01')).status).toBe(200);
    // A cópia corrigida posta em vigor no mesmo dia: antes, o anterior ficava "de 01/03/2017 a 28/02/2017".
    const novo = await vigencia(c!, '2017-03-01');
    expect(novo.status).toBe(200);
    expect(novo.body).toMatchObject({ status: 'VIGENTE', vigenteDesde: '2017-03-01', vigenteAte: null });
    const lista = (await t.http().get('/api/vigilancia/contingencia/planos').set(auth(vig)).expect(200)).body as PlanoResumo[];
    expect(lista.find((p) => p.id === b)).toMatchObject({ status: 'ARQUIVADO', vigenteDesde: '2017-03-01', vigenteAte: '2017-03-01' });
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.plano_vigente', entityId: c! } })).toBe(1);
    // Com o novo começando depois, o anterior continua arquivado na véspera.
    const [, , d] = (await db.contingencyPlan.findMany({ orderBy: { version: 'asc' } })).map((p) => p.id);
    expect((await vigencia(d!, '2017-03-05')).status).toBe(200);
    expect((await db.contingencyPlan.findUniqueOrThrow({ where: { id: c! } })).validTo?.toISOString().slice(0, 10)).toBe('2017-03-04');
  });

  it('0031: vigência do plano e do acionamento nunca termina antes de começar; versão única por escopo', async () => {
    const erro = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    const plano = (id: string, versao: number, de: string, ate: string | null) =>
      db.$executeRaw`INSERT INTO contingency_plans (id, scope, name, version, status, valid_from, valid_to, definition, updated_at)
        VALUES (${id}::uuid, 'TESTE_R3', 'Plano de teste', ${versao}, 'ARQUIVADO', ${de}::date, ${ate}::date, '{}'::jsonb, now())`;
    expect(await erro(plano('00000000-0000-7000-8000-000000000001', 1, '2017-03-01', '2017-02-28'))).toContain('contingency_plans_vigencia');
    expect(await erro(plano('00000000-0000-7000-8000-000000000002', 1, '2017-03-01', '2017-03-01'))).toBeNull();
    expect(await erro(plano('00000000-0000-7000-8000-000000000003', 1, '2017-03-02', null))).toContain('contingency_plans_versao');
    const acionamento = (id: string, inicio: string, fim: string) =>
      db.$executeRaw`INSERT INTO contingency_activations (id, plan_id, level, stage, started_on, started_week, ended_on, ended_week, justification, indicators, decided_by)
        VALUES (${id}::uuid, '00000000-0000-7000-8000-000000000002'::uuid, 'MUNICIPIO', 'ALERTA', ${inicio}::date, '201709', ${fim}::date, '201709', 'Teste das restrições da 0031', '[]'::jsonb, ${autor}::uuid)`;
    expect(await erro(acionamento('00000000-0000-7000-8000-000000000011', '2017-03-01', '2017-02-28'))).toContain('contingency_activations_vigencia');
    expect(await erro(acionamento('00000000-0000-7000-8000-000000000012', '2017-03-01', '2017-03-01'))).toBeNull();
    await db.$executeRaw`DELETE FROM contingency_activations WHERE plan_id = '00000000-0000-7000-8000-000000000002'::uuid`;
    await db.$executeRaw`DELETE FROM contingency_plans WHERE scope = 'TESTE_R3'`;
  });

  it('bairro com a importação só até a SE 29: as SE sem canal não soltam o acumulado nem sugerem descer (DIAGRAMA-1)', async () => {
    // Chikungunya em número de casos; o CHIKON cobre de 2011 até 23/07/2016 (SE 29). Sem OmniSaúde em uso em 2016.
    const loc = await db.locality.create({ data: { code: '99000331', name: 'Distrito Contingência R3', source: 'MANUAL' } });
    const bairro = await db.neighborhood.create({ data: { localityId: loc.id, name: 'Bairro Chikungunya R3' }, select: { id: true, name: true } });
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
      periodo: { de: '2011-01-02', ate: '2016-07-23' },
      identificado: false,
      ignorado: false,
      avisos: [],
    };
    const imp = (await db.officialImport.create({ data: { system: 'SINAN_ONLINE', status: 'APLICADA', fileName: 'chikon-r3.zip', sha256: 'd'.repeat(64), sizeBytes: 1, createdBy: autor, files: [arquivo] } })).id;
    let n = 0;
    const registro = (ano: number, se: number, obito = false) => {
      n++;
      const semana = `${ano}${String(se).padStart(2, '0')}`;
      return {
        system: 'SINAN_ONLINE' as const,
        type: 'INDIVIDUAL' as const,
        naturalKey: `r3-chik-${n}`,
        number: String(7_000_000 + n),
        notifiedOn: new Date(`${intervaloDaSemana(ano, se).inicio}T00:00:00Z`),
        epiWeekNotified: semana,
        epiWeekOnset: semana,
        municipalityIbge: MUNICIPIO,
        residenceIbge: MUNICIPIO,
        neighborhoodName: bairro.name,
        agravo: 'A92.0',
        groupKey: 'chikungunya',
        situation: 'CONFIRMADO',
        evolution: obito ? '2' : null,
        contentHash: '0'.repeat(64),
        firstImportId: imp,
        lastImportId: imp,
        lastSeenAt: new Date(),
      };
    };
    // 2011 a 2015: 1, 2, 3, 4 e 5 casos por SE (Q1 = 1,5, mediana = 3 e Q3 = 4,5). Em 2016: 2 casos por SE até a SE 19 e
    // 10 da SE 20 à 29 (acima do LS), com 1 óbito.
    const dados = [];
    for (const [i, ano] of [2011, 2012, 2013, 2014, 2015].entries()) for (let se = 1; se <= 52; se++) for (let k = 0; k <= i; k++) dados.push(registro(ano, se));
    for (let se = 1; se <= 29; se++) for (let k = 0; k < (se >= 20 ? 10 : 2); k++) dados.push(registro(2016, se, se === 25 && k === 0));
    await db.officialRecord.createMany({ data: dados });
    emDia('2016-08-03');
    await t
      .http()
      .put('/api/vigilancia/diagrama/configuracao/chikungunya')
      .set(auth(vig))
      .send({ modelo: 'MS_2025', receita: { unidade: 'CASOS' }, anosExcluidos: [], fontePopulacao: null, versaoPopulacao: null })
      .expect(200);
    // Plano em vigor desde o começo de 2016: o vigente do teste acima começa em 2017 e fica arquivado direto no banco.
    await db.contingencyPlan.updateMany({ data: { status: 'ARQUIVADO' }, where: { status: 'VIGENTE' } });
    const p = (await t.http().post('/api/vigilancia/contingencia/planos').set(auth(vig)).send({ modelo: 'MS_2025' }).expect(201)).body as DetalhePlano;
    await t.http().post(`/api/vigilancia/contingencia/planos/${p.id}/vigencia`).set(auth(vig)).send({ desde: '2016-01-04' }).expect(200);
    await t
      .http()
      .post('/api/vigilancia/contingencia/acionar')
      .set(auth(vig))
      .send({ estagio: 'EPIDEMIA', justificativa: 'Chikungunya acima do limite superior há dez semanas e óbito confirmado.', nivel: 'BAIRRO', territorio: bairro.id })
      .expect(201);

    // 07/09/2016 (SE 36): a última SE completa é a 34; as SE 30 a 34 ficam sem canal (a importação para na 29).
    emDia('2016-09-07');
    const s = (await t.http().get(`/api/vigilancia/contingencia?nivel=BAIRRO&territorio=${bairro.id}`).set(auth(vig)).expect(200)).body as SituacaoContingencia;
    const chik = s.indicadores.find((i) => i.grupo === 'chikungunya')!;
    expect(
      chik.semanas
        .filter((x) => x.completa)
        .slice(-6)
        .map((x) => [x.semana, x.status]),
    ).toEqual([
      ['201629', 'ACIMA_LS'],
      ['201630', 'SEM_CANAL'],
      ['201631', 'SEM_CANAL'],
      ['201632', 'SEM_CANAL'],
      ['201633', 'SEM_CANAL'],
      ['201634', 'SEM_CANAL'],
    ]);
    expect(chik).toMatchObject({ provaveis: 138, obitosAgravo: 1 });
    expect(s.estagioAtual.chave).toBe('EPIDEMIA');
    // Antes: sugerido NORMALIDADE e "pode desmobilizar ... volta da curva ao canal endêmico", sem dado nas SE.
    expect(s.avaliacao).toMatchObject({ sugerido: 'EPIDEMIA', desmobilizacao: { sugerida: false } });
    expect(s.avaliacao!.criterios.find((c) => c.id === 'epi-letalidade' && c.agravo === 'chikungunya')).toMatchObject({ atendido: true });
  });
});
