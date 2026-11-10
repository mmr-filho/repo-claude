import { randomUUID } from 'node:crypto';
import { demoFixtures } from '@omnisaude/database';
import { calcularCanal, csvDoCanal, intervaloDaSemana, RECEITAS_MODELO, semanasNoAno, type RespostaDiagrama, type SerieAnual } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { ConsolidadoService } from '../src/modules/vigilancia/consolidado.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Base consolidada, população e diagrama de controle na API (VIG-1c, frente F3). Os registros oficiais e as
 * notificações são criados direto no banco (sem depender da importação). O relógio do serviço fica em 17/08/2016
 * (SE 33/2016): o ano em análise é 2016 e a referência, 2011 a 2015, longe dos dados da demonstração. Dados sintéticos.
 */
const enabled = await pgAvailable();

const AGORA = new Date('2016-08-17T15:00:00Z');
const MUNICIPIO = demoFixtures.DEMO_TENANT.ibgeCode;
const OUTRO_MUNICIPIO = '1709500';
/** População do município (fonte MANUAL, versão F3) nos anos de referência; 2016 não tem: repete 2015. */
const POP: Record<number, number> = { 2011: 100_000, 2012: 101_000, 2013: 102_000, 2014: 103_000, 2015: 104_000 };
/** Casos prováveis do município que a base consolidada deve contar, por ano e SE (o resto dos dados fica fora). */
const CASOS: Record<number, Record<number, number>> = { 2013: { 10: 3, 11: 1 }, 2014: { 10: 4, 53: 1 }, 2015: { 10: 5, 30: 2 } };
const COBERTOS = new Set([2011, 2013, 2014, 2015]);
const serieEsperada = (ano: number): (number | null)[] => Array.from({ length: 53 }, (_, i) => (!COBERTOS.has(ano) || i >= semanasNoAno(ano) ? null : (CASOS[ano]?.[i + 1] ?? 0)));

describe.runIf(enabled)('Vigilância: base consolidada, população e diagrama de controle (VIG-1c, F3)', () => {
  let t: TestApp;
  let vig = '';
  let gestora = '';
  let ace = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let sys: { tenant: Awaited<ReturnType<TenantsService['resolve']>>; db: typeof db };
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const ids = { localidade: '', bairro: '', importacao: '', paciente: '', unidade: '', notificador: '', caso: '', obito: '' };
  const cond: Record<'caso' | 'obito', { id: string; key: string }> = { caso: { id: '', key: '' }, obito: { id: '', key: '' } };
  let nReg = 0;
  let nNot = 0;

  const inicio = (semana: string) => intervaloDaSemana(Number(semana.slice(0, 4)), Number(semana.slice(4))).inicio;
  /** Registro oficial INDIVIDUAL de dengue (Sinan Online). */
  const registro = (o: {
    semana: string | null;
    semanaNotificacao?: string;
    situacao?: string;
    residencia?: string | null;
    excluido?: boolean;
    ausente?: boolean;
    bairro?: string;
    gravidade?: string;
    evolucao?: string;
    notificacao?: string;
  }) => {
    nReg++;
    const sem = o.semana ?? o.semanaNotificacao!;
    return {
      system: 'SINAN_ONLINE' as const,
      type: 'INDIVIDUAL' as const,
      naturalKey: `f3-${nReg}`,
      number: String(7_000_000 + nReg),
      notifiedOn: new Date(`${inicio(sem)}T00:00:00Z`),
      epiWeekNotified: o.semanaNotificacao ?? sem,
      epiWeekOnset: o.semana,
      municipalityIbge: MUNICIPIO,
      agravo: 'A90',
      groupKey: 'dengue',
      residenceIbge: o.residencia === undefined ? MUNICIPIO : o.residencia,
      neighborhoodName: o.bairro ?? null,
      situation: o.situacao ?? 'CONFIRMADO',
      severity: o.gravidade ?? null,
      evolution: o.evolucao ?? null,
      excluded: o.excluido ?? false,
      absentSince: o.ausente ? new Date() : null,
      contentHash: '0'.repeat(64),
      firstImportId: ids.importacao,
      lastImportId: ids.importacao,
      lastSeenAt: new Date(),
      notificationId: o.notificacao ?? null,
      matchMethod: o.notificacao ? ('MANUAL' as const) : null,
    };
  };
  /** Notificação do OmniSaúde de dengue (caso ou óbito ligado ao caso). */
  const notificacao = async (o: {
    semana: string;
    status?: 'NOTIFICADA' | 'ENCERRADA';
    classificacao?: string;
    foraDoMunicipio?: boolean;
    posicao?: { lat: number; lng: number };
    bairroFicha?: string;
    obitoDe?: string;
  }) => {
    nNot++;
    const ano = Number(o.semana.slice(0, 4));
    const c = o.obitoDe ? cond.obito : cond.caso;
    const n = await db.notification.create({
      data: {
        year: ano,
        seq: 900_000 + nNot,
        number: `${ano}/${900_000 + nNot}`,
        status: o.status ?? 'NOTIFICADA',
        origin: o.obitoDe ? 'OBITO' : 'MANUAL',
        conditionId: c.id,
        conditionKey: c.key,
        groupKey: 'dengue',
        patientId: ids.paciente,
        unitId: ids.unidade,
        notifierId: ids.notificador,
        notifierRole: 'VIGILANCIA_EPIDEMIOLOGICA',
        knownAt: new Date(`${inicio(o.semana)}T15:00:00Z`),
        deadlineStart: 'CONHECIMENTO',
        deadlineKind: 'SEMANAL',
        targets: ['SMS'],
        symptomsOnset: new Date(`${inicio(o.semana)}T00:00:00Z`),
        epiWeekOnset: o.semana,
        epiWeekNotified: o.semana,
        finalClass: o.classificacao ?? null,
        outOfMunicipality: o.foraDoMunicipio ?? false,
        residenceLat: o.posicao?.lat ?? null,
        residenceLng: o.posicao?.lng ?? null,
        residencePrecision: o.posicao ? 'GPS_CAMPO' : null,
        form: { NM_BAIRRO: o.bairroFicha ?? null },
        relatedNotificationId: o.obitoDe ?? null,
      },
    });
    return n.id;
  };
  const diagrama = async (q: string, tk = vig) => (await t.http().get(`/api/vigilancia/diagrama?${q}`).set(auth(tk)).expect(200)).body as RespostaDiagrama;
  const semanaDoCanal = (r: RespostaDiagrama, se: number, canal = 0) => r.canais[canal]!.canal.semanas[se - 1]!;
  const valorDoAno = (r: RespostaDiagrama, se: number, ano: number) => semanaDoCanal(r, se).valores.find((v) => v.ano === ano);

  beforeAll(async () => {
    t = await startTestApp('vigdiagrama');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    sys = { tenant, db };
    t.app.get(DiagramaService).agora = () => AGORA;
    // As tabelas desta frente começam vazias (a demonstração pode ter semeado população, receita e canal).
    await db.controlChannel.deleteMany();
    await db.diagramSetting.deleteMany();
    await db.populationEstimate.deleteMany();

    await t.app.get(CatalogoVigilanciaService).garantir(sys);
    ids.paciente = (await db.patient.findFirstOrThrow({ where: { mergedIntoId: null }, select: { id: true } })).id;
    ids.unidade = (await db.unit.findFirstOrThrow({ where: { name: 'UBS Centro' }, select: { id: true } })).id;
    ids.notificador = (await db.user.findFirstOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf }, select: { id: true } })).id;
    for (const [k, key] of [
      ['caso', 'dengue'],
      ['obito', 'dengue-obito'],
    ] as const)
      cond[k] = await db.notifiableCondition.findFirstOrThrow({ where: { key }, select: { id: true, key: true } });

    // Território próprio, longe da malha da demonstração: uma localidade com um bairro e um quarteirão.
    const loc = await db.locality.create({ data: { code: '99000327', name: 'Distrito Diagrama F3', category: 'DISTRITO', zone: 'URBANA', source: 'MANUAL' } });
    const bairro = await db.neighborhood.create({ data: { localityId: loc.id, name: 'Bairro Diagrama F3', aliases: [] } });
    ids.localidade = loc.id;
    ids.bairro = bairro.id;
    const [x0, y0, x1, y1] = [-50.001, -10.001, -49.999, -9.999];
    await db.block.create({
      data: {
        localityId: loc.id,
        neighborhoodId: bairro.id,
        number: '327',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
              [x0, y0],
            ],
          ],
        },
        minLng: x0,
        minLat: y0,
        maxLng: x1,
        maxLat: y1,
        centerLat: -10,
        centerLng: -50,
        areaM2: 48_000,
      },
    });

    // Importações aplicadas: a dos registros e um DENGON de 2011 sem nenhum caso (cobre o ano: semana sem caso = 0).
    const imp = await db.officialImport.create({ data: { system: 'SINAN_ONLINE', status: 'APLICADA', fileName: 'f3-registros.zip', sha256: 'a'.repeat(64), sizeBytes: 1, createdBy: ids.notificador } });
    ids.importacao = imp.id;
    await db.officialImport.create({
      data: {
        system: 'SINAN_ONLINE',
        status: 'APLICADA',
        fileName: 'DENGON2011.DBF',
        sha256: 'b'.repeat(64),
        sizeBytes: 1,
        createdBy: ids.notificador,
        files: [
          {
            nome: 'DENGON2011.DBF',
            tipo: 'DENGON',
            sistema: 'SINAN_ONLINE',
            tipoRegistro: 'INDIVIDUAL',
            tamanhoBytes: 1,
            registros: 0,
            codificacao: null,
            origemCodificacao: null,
            agravos: ['A90'],
            periodo: { de: '2011-01-02', ate: '2011-12-31' },
            identificado: false,
            ignorado: false,
            avisos: [],
          },
        ],
      },
    });

    // 2014: notificações do OmniSaúde (um caso sem registro, o óbito dele ainda aberto, um par ligado, um de fora e um descartado).
    ids.caso = await notificacao({ semana: '201410' });
    ids.obito = await notificacao({ semana: '201410', obitoDe: ids.caso });
    const ligada = await notificacao({ semana: '201410' });
    await notificacao({ semana: '201410', foraDoMunicipio: true });
    await notificacao({ semana: '201410', status: 'ENCERRADA', classificacao: '2' });
    // 2016: um caso no quarteirão do bairro (SE 31) e um sem posição, com o bairro na ficha (SE 25).
    await notificacao({ semana: '201631', posicao: { lat: -10, lng: -50 } });
    await notificacao({ semana: '201625', bairroFicha: 'Bairro Diagrama F3' });

    await db.officialRecord.createMany({
      data: [
        // 2013, SE 10: 3 prováveis (um grave com óbito, um com sinais de alarme e óbito em investigação); o resto fica fora.
        registro({ semana: '201310', gravidade: 'GRAVE', evolucao: '2' }),
        registro({ semana: '201310', gravidade: 'SINAIS_ALARME', evolucao: '4' }),
        registro({ semana: '201310' }),
        registro({ semana: '201310', situacao: 'DESCARTADO' }),
        registro({ semana: '201310', excluido: true }),
        registro({ semana: '201310', ausente: true }),
        registro({ semana: '201310', residencia: OUTRO_MUNICIPIO }),
        registro({ semana: '201310', residencia: null }),
        // Sem SE de início dos sintomas: conta pela semana da notificação.
        registro({ semana: null, semanaNotificacao: '201311', situacao: 'EM_INVESTIGACAO' }),
        // 2014: 2 registros + o par ligado (conta uma vez, pelo registro) na SE 10; a SE 53 soma na 52 do canal.
        registro({ semana: '201410' }),
        registro({ semana: '201410' }),
        registro({ semana: '201410', notificacao: ligada }),
        registro({ semana: '201453' }),
        ...Array.from({ length: 5 }, () => registro({ semana: '201510' })),
        ...Array.from({ length: 2 }, () => registro({ semana: '201530' })),
        // 2016 (ano em análise): SE 10, a SE 32 (incompleta) e um registro com o bairro escrito pelo apelido.
        registro({ semana: '201610' }),
        registro({ semana: '201610' }),
        registro({ semana: '201632' }),
        registro({ semana: '201620', bairro: 'VILA DO TESTE  F3' }),
      ],
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  it('GESTOR lê e não grava; ACE não lê', async () => {
    await t.http().get('/api/vigilancia/diagrama?grupo=dengue&ano=2016').set(auth(gestora)).expect(200);
    await t.http().get('/api/vigilancia/populacao').set(auth(gestora)).expect(200);
    await t.http().get('/api/vigilancia/diagrama/configuracao/dengue').set(auth(gestora)).expect(200);
    await t
      .http()
      .put('/api/vigilancia/populacao')
      .set(auth(gestora))
      .send({ linhas: [{ ano: 2016, nivel: 'MUNICIPIO', territorioId: null, populacao: 1000, fonte: 'MANUAL' }] })
      .expect(403);
    await t.http().put('/api/vigilancia/diagrama/configuracao/dengue').set(auth(gestora)).send({ modelo: 'MS_2025', anosExcluidos: [], fontePopulacao: null, versaoPopulacao: null }).expect(403);
    await t.http().post('/api/vigilancia/diagrama/congelar').set(auth(gestora)).send({ grupo: 'dengue', nivel: 'MUNICIPIO', territorio: null, ano: 2016 }).expect(403);
    await t.http().delete(`/api/vigilancia/populacao/${randomUUID()}`).set(auth(gestora)).expect(403);
    for (const rota of ['diagrama?grupo=dengue&ano=2016', 'diagrama.csv?grupo=dengue&ano=2016', 'populacao', 'diagrama/configuracao/dengue', 'diagrama/anos-epidemicos?grupo=dengue&ano=2016'])
      await t.http().get(`/api/vigilancia/${rota}`).set(auth(ace)).expect(403);
  });

  it('população: grava o lote por chave (ano, território, fonte e versão), recusa o que não fecha e remove', async () => {
    const linha = (ano: number, populacao: number, fonte = 'MANUAL', versao = 'F3', nivel = 'MUNICIPIO', territorioId: string | null = null) => ({ ano, nivel, territorioId, populacao, fonte, versao });
    const lote = [
      ...Object.entries(POP).map(([a, p]) => linha(Number(a), p)),
      // Outra fonte e outra versão, com 2016: não podem entrar na série MANUAL/F3.
      ...[2011, 2012, 2013, 2014, 2015, 2016].map((a) => linha(a, 200_000 + a, 'RIPSA', 'F3R')),
      linha(2016, 999_999, 'MANUAL', 'F3-OUTRA'),
      // Censo 2022 do município, do bairro e da localidade (proporções 0,1 e 0,2).
      linha(2022, 104_000, 'CENSO_2022', 'F3'),
      linha(2022, 10_400, 'CENSO_2022', 'F3', 'BAIRRO', ids.bairro),
      linha(2022, 20_800, 'CENSO_2022', 'F3', 'LOCALIDADE', ids.localidade),
      linha(2016, 5, 'MANUAL', 'temporaria'),
    ];
    expect((await t.http().put('/api/vigilancia/populacao').set(auth(vig)).send({ linhas: lote }).expect(200)).body).toEqual({ criadas: lote.length, atualizadas: 0 });
    const r = (
      await t
        .http()
        .put('/api/vigilancia/populacao')
        .set(auth(vig))
        .send({ linhas: [linha(2011, 100_000), linha(2016, 6, 'MANUAL', 'temporaria')] })
        .expect(200)
    ).body;
    expect(r).toEqual({ criadas: 0, atualizadas: 1 });
    // Município com território, bairro sem território, Censo fora de 2022 e linha repetida no lote.
    for (const ruim of [
      [{ ...linha(2016, 10), territorioId: ids.bairro }],
      [linha(2016, 10, 'MANUAL', 'F3', 'BAIRRO', null)],
      [linha(2021, 10, 'CENSO_2022', 'F3')],
      [linha(2016, 10), linha(2016, 11)],
      [linha(2016, 10, 'MANUAL', 'F3', 'BAIRRO', randomUUID())],
    ])
      await t.http().put('/api/vigilancia/populacao').set(auth(vig)).send({ linhas: ruim }).expect(400);
    const bairros = (await t.http().get(`/api/vigilancia/populacao?nivel=BAIRRO`).set(auth(vig)).expect(200)).body as { territorioNome: string; populacao: number; fonte: string }[];
    expect(bairros).toEqual([expect.objectContaining({ territorioNome: 'Bairro Diagrama F3', populacao: 10_400, fonte: 'CENSO_2022' })]);
    const temporaria = ((await t.http().get('/api/vigilancia/populacao?nivel=MUNICIPIO').set(auth(vig)).expect(200)).body as { id: string; versao: string; populacao: number }[]).find((l) => l.versao === 'temporaria')!;
    expect(temporaria.populacao).toBe(6);
    await t.http().delete(`/api/vigilancia/populacao/${temporaria.id}`).set(auth(vig)).expect(200, { ok: true });
    await t.http().delete(`/api/vigilancia/populacao/${temporaria.id}`).set(auth(vig)).expect(404);
    expect(await db.auditEntry.count({ where: { action: { in: ['vigilancia.populacao_gravada', 'vigilancia.populacao_removida'] } } })).toBe(3);
  });

  it('sem fonte configurada, o sistema escolhe a que cobre mais anos e avisa; a receita padrão é a do MS 2025', async () => {
    const cfg = (await t.http().get('/api/vigilancia/diagrama/configuracao/dengue').set(auth(vig)).expect(200)).body;
    expect(cfg).toMatchObject({ grupo: 'dengue', modelo: 'MS_2025', padrao: true, fontePopulacao: null, receita: RECEITAS_MODELO.MS_2025.receita });
    const r = await diagrama('grupo=dengue&ano=2016');
    expect(r.populacao.every((p) => p.fonte === 'RIPSA' && p.versao === 'F3R' && p.origem === 'OFICIAL')).toBe(true);
    expect(r.avisos.some((a) => a.startsWith('Fonte da população escolhida pelo sistema: RIPSA'))).toBe(true);
    await t.http().get('/api/vigilancia/diagrama/configuracao/nao-existe').set(auth(vig)).expect(404);
    await t.http().get('/api/vigilancia/diagrama?grupo=nao-existe&ano=2016').set(auth(vig)).expect(404);
  });

  it('configuração validada: receita a partir do modelo, anos excluídos com motivo e fonte da população que existe', async () => {
    const put = (body: object, status: number) => t.http().put('/api/vigilancia/diagrama/configuracao/dengue').set(auth(vig)).send(body).expect(status);
    const base = { modelo: 'MS_2025', anosExcluidos: [], fontePopulacao: 'MANUAL', versaoPopulacao: 'F3' };
    expect((await put({ ...base, receita: { janela: 'AGRUPADA_5' } }, 422)).body.code).toBe('CONFIGURACAO_INVALIDA');
    expect((await put({ ...base, receita: { anos: 2 } }, 422)).body.message).toContain('QUARTIL.EXC');
    expect((await put({ ...base, fontePopulacao: 'IBGE_DOU', versaoPopulacao: '2025' }, 422)).body.message).toContain('cadastre-a antes');
    await put(
      {
        ...base,
        anosExcluidos: [
          { ano: 2014, motivo: 'Ano epidêmico no município' },
          { ano: 2014, motivo: 'Ano epidêmico no município' },
        ],
      },
      422,
    );
    await put({ ...base, anosExcluidos: [{ ano: 2018, motivo: 'Ano ainda não terminou' }] }, 422);
    await put({ ...base, anosExcluidos: [{ ano: 2014, motivo: 'curto' }] }, 400);
    await put({ ...base, modelo: 'MODELO_INVENTADO' }, 400);
    // Ajuste fora do modelo: a configuração mostra que a receita é própria (modelo nulo).
    expect((await put({ ...base, modelo: 'NT_1_2023', receita: { anos: 6 } }, 200)).body).toMatchObject({ modelo: null, receita: { anos: 6, quartil: 'EXC' }, padrao: false });
    const ok = (await put(base, 200)).body;
    expect(ok).toMatchObject({ modelo: 'MS_2025', fontePopulacao: 'MANUAL', versaoPopulacao: 'F3', padrao: false, atualizadoPor: 'Vera Lúcia Vigilância Epidemiológica' });
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.diagrama_configurado' } })).toBe(2);
  });

  it('base consolidada: par vinculado conta uma vez, descartado, ausente, excluído e de fora ficam fora; ano sem cobertura = null e semana sem caso = 0', async () => {
    const r = await diagrama('grupo=dengue&ano=2016');
    expect(r).toMatchObject({ grupo: 'dengue', agravo: 'Dengue', territorio: { nivel: 'MUNICIPIO', id: null, nome: 'Município' }, eixo: 'EPIDEMIOLOGICO' });
    const canal = r.canais[0]!;
    expect(canal.congelado).toBeNull();
    expect(canal.canal.anosReferencia).toEqual([2011, 2013, 2014, 2015]);
    expect(r.cobertura.find((c) => c.ano === 2011)).toMatchObject({ coberto: true, motivo: expect.stringContaining('DENGON2011.DBF') });
    expect(r.cobertura.find((c) => c.ano === 2012)).toMatchObject({ coberto: false });
    expect(canal.canal.avisos).toContain('Ano 2012 fora do canal: sem cobertura (nenhuma base cobre o ano).');
    // SE 10: 2011 coberto sem caso = 0; 2013 = 3; 2014 = 2 registros + 1 caso do OmniSaúde + o par = 4; 2015 = 5.
    expect([2011, 2013, 2014, 2015].map((a) => valorDoAno(r, 10, a)?.casos)).toEqual([0, 3, 4, 5]);
    expect(valorDoAno(r, 11, 2013)?.casos).toBe(1);
    // A SE 53 de 2014 soma na SE 52 do canal.
    expect(valorDoAno(r, 52, 2014)?.casos).toBe(1);
    expect(r.semSemanaSintomas).toBe(1);
    expect(r.avisos).toContain('1 registro(s) oficial(is) sem município de residência ficaram fora.');

    // Outras bases sobre os mesmos dados: notificados contam os descartados; confirmados, só os confirmados.
    const consolidado = t.app.get(ConsolidadoService);
    const consulta = { grupo: 'dengue', nivel: 'MUNICIPIO' as const, territorioId: null, anos: [2013, 2014] };
    const notificados = await consolidado.casosPorSemana(sys, { ...consulta, base: 'NOTIFICADOS' });
    expect([notificados.porAno.get(2013)![9], notificados.porAno.get(2014)![9]]).toEqual([4, 5]);
    const confirmados = await consolidado.casosPorSemana(sys, { ...consulta, base: 'CONFIRMADOS' });
    expect([confirmados.porAno.get(2013)![9], confirmados.porAno.get(2013)![10], confirmados.porAno.get(2014)![9]]).toEqual([3, 0, 3]);
    expect(notificados.porAno.get(2014)![52]).toBe(1);
    expect(notificados.porAno.get(2013)![52]).toBeNull();
  });

  it('indicadores: graves, sinais de alarme e óbitos do registro oficial; o óbito do OmniSaúde ligado ao caso não é outro caso', async () => {
    const consolidado = t.app.get(ConsolidadoService);
    expect(await consolidado.indicadores(sys, 'dengue', 2013, '201352')).toEqual({ provaveis: 4, graves: 1, sinaisAlarme: 1, obitosAgravo: 1, obitosInvestigacao: 1 });
    expect(await consolidado.indicadores(sys, 'dengue', 2014, '201453')).toEqual({ provaveis: 5, graves: 0, sinaisAlarme: 0, obitosAgravo: 0, obitosInvestigacao: 1 });
    // Até a SE 9 ainda não há caso no ano.
    expect((await consolidado.indicadores(sys, 'dengue', 2013, '201309')).provaveis).toBe(0);
    // Encerrado o óbito como confirmado, vira óbito pelo agravo.
    await db.notification.update({ where: { id: ids.obito }, data: { status: 'ENCERRADA', finalClass: '1' } });
    expect(await consolidado.indicadores(sys, 'dengue', 2014, '201453')).toMatchObject({ provaveis: 5, obitosAgravo: 1, obitosInvestigacao: 0 });
    await db.notification.update({ where: { id: ids.obito }, data: { status: 'NOTIFICADA', finalClass: null } });
  });

  it('canal do endpoint igual ao calculado direto pela função compartilhada, com a população da mesma fonte e versão', async () => {
    const r = await diagrama('grupo=dengue&ano=2016');
    const series: SerieAnual[] = [2011, 2012, 2013, 2014, 2015].map((ano) => ({ ano, semanas: serieEsperada(ano), populacao: POP[ano]! }));
    expect(r.canais[0]!.canal).toEqual(calcularCanal(series, 2016, RECEITAS_MODELO.MS_2025.receita, []));
    // Mesma fonte e versão em todos os anos; o ano em análise sem a fonte repete o último ano (e não usa a RIPSA nem a outra versão).
    expect(r.populacao).toEqual([
      ...[2011, 2012, 2013, 2014, 2015].map((ano) => ({ ano, populacao: POP[ano], fonte: 'MANUAL', versao: 'F3', origem: 'OFICIAL' })),
      { ano: 2016, populacao: 104_000, fonte: 'MANUAL', versao: 'F3', origem: 'REPETIDA' },
    ]);
    expect(r.avisos.some((a) => a.startsWith('População repetida do último ano disponível') && a.includes('2016'))).toBe(true);
    // Curva observada de 2016 na mesma unidade (incidência com a população repetida), semanas incompletas e futuras.
    const ponto = (se: number) => r.pontos.find((p) => p.semana === se)!;
    expect(ponto(10)).toMatchObject({ rotulo: '10/2016', casos: 2, valor: (2 * 100_000) / 104_000, incompleta: false });
    expect(ponto(31)).toMatchObject({ casos: 1, incompleta: false });
    expect(ponto(32)).toMatchObject({ casos: 1, incompleta: true });
    expect(ponto(33)).toMatchObject({ casos: 0, incompleta: true });
    expect(ponto(34)).toMatchObject({ casos: null, valor: null, status: 'SEM_CANAL', incompleta: false });
    expect(r.semanasIncompletas).toEqual(['201632', '201633']);
    expect(r.pontos).toHaveLength(52);
    expect(ponto(10).canal).toEqual({ centro: semanaDoCanal(r, 10).centro, li: semanaDoCanal(r, 10).li, ls: semanaDoCanal(r, 10).ls });
    // SE 10: 1,92 por 100 mil, entre o Q1 (0,74) e a mediana (3,41); SE 31: canal todo em zero, um caso já passa do LS.
    expect([ponto(10).status, ponto(31).status]).toEqual(['ATE_CENTRO', 'ACIMA_LS']);
  });

  it('bairro pelo código ou nome/apelido (lido na hora) e pelo quarteirão da residência; população pela proporção do Censo', async () => {
    const q = `grupo=dengue&ano=2016&nivel=BAIRRO&territorio=${ids.bairro}`;
    let r = await diagrama(q);
    expect(r.territorio).toEqual({ nivel: 'BAIRRO', id: ids.bairro, nome: 'Bairro Diagrama F3' });
    const casos = (resp: RespostaDiagrama) => Object.fromEntries(resp.pontos.filter((p) => p.casos).map((p) => [p.semana, p.casos]));
    // SE 25 pelo bairro da ficha (sem posição) e SE 31 pelo quarteirão; o registro da SE 20 ainda não casa.
    expect(casos(r)).toEqual({ 25: 1, 31: 1 });
    expect(r.bairrosSemCorrespondencia).toBe(1);
    expect(r.avisos.some((a) => a.includes('sem bairro identificado') && a.includes('1 nome(s) de bairro sem correspondência'))).toBe(true);
    // População do bairro: estimativa do município × 0,1 (Censo 2022), marcada como estimada.
    expect(r.populacao.find((p) => p.ano === 2016)).toEqual({ ano: 2016, populacao: 10_400, fonte: 'MANUAL', versao: 'F3', origem: 'ESTIMADA' });
    expect(r.populacao.find((p) => p.ano === 2013)).toMatchObject({ populacao: 10_200, origem: 'ESTIMADA' });
    expect(r.avisos.some((a) => a.startsWith('População estimada pela proporção do Censo 2022'))).toBe(true);

    // O apelido novo vale na próxima consulta, sem reprocessar nada.
    await db.neighborhood.update({ where: { id: ids.bairro }, data: { aliases: ['Vila do Teste F3'] } });
    r = await diagrama(q);
    expect(casos(r)).toEqual({ 20: 1, 25: 1, 31: 1 });
    expect(r.bairrosSemCorrespondencia).toBe(0);
    const loc = await diagrama(`grupo=dengue&ano=2016&nivel=LOCALIDADE&territorio=${ids.localidade}`);
    expect(casos(loc)).toEqual({ 20: 1, 25: 1, 31: 1 });
    expect(loc.populacao.find((p) => p.ano === 2016)).toMatchObject({ populacao: 20_800, origem: 'ESTIMADA' });
    // Território inexistente, nível sem território e município com território.
    await t.http().get(`/api/vigilancia/diagrama?grupo=dengue&ano=2016&nivel=BAIRRO&territorio=${randomUUID()}`).set(auth(vig)).expect(404);
    await t.http().get('/api/vigilancia/diagrama?grupo=dengue&ano=2016&nivel=BAIRRO').set(auth(vig)).expect(400);
    await t.http().get(`/api/vigilancia/diagrama?grupo=dengue&ano=2016&territorio=${ids.bairro}`).set(auth(vig)).expect(400);
  });

  it('território acima do limite superior do próprio canal na última semana completa (para as sugestões de surto)', async () => {
    const excessos = await t.app.get(DiagramaService).excessos(sys, ['dengue', 'nao-existe'], '2016-08-17');
    expect(excessos).toHaveLength(2);
    expect(excessos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grupo: 'dengue', nivel: 'BAIRRO', territorioId: ids.bairro, territorioNome: 'Bairro Diagrama F3', semana: '201631', casos: 1, ls: 0 }),
        expect.objectContaining({ grupo: 'dengue', nivel: 'LOCALIDADE', territorioId: ids.localidade, semana: '201631', casos: 1 }),
      ]),
    );
  });

  it('CSV do canal: o mesmo canal da tela, com BOM, ponto e vírgula e as fórmulas do Excel', async () => {
    const r = await diagrama('grupo=dengue&ano=2016');
    const res = await t.http().get('/api/vigilancia/diagrama.csv?grupo=dengue&ano=2016').set(auth(vig)).buffer(true).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('diagrama-dengue-municipio-2016.csv');
    const texto = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text;
    const esperado = csvDoCanal(r.canais[0]!.canal, r.canais[0]!.observado, { titulo: 'Dengue, Município, 2016', fontePopulacao: 'Informada pela vigilância, versão F3', geradoEm: AGORA.toISOString() });
    expect(texto).toBe(esperado);
    expect(texto.charCodeAt(0)).toBe(0xfeff);
    expect(texto).toContain('QUARTIL.EXC(');
  });

  it('eixo sazonal: SE 27 a 52 do ano e 1 a 26 do seguinte, cada ponto com o canal do próprio ano', async () => {
    const r = await diagrama('grupo=dengue&ano=2015&eixo=SAZONAL');
    expect(r.canais.map((c) => c.ano)).toEqual([2015, 2016]);
    expect(r.pontos).toHaveLength(26 + 26);
    expect([r.pontos[0]!.rotulo, r.pontos[25]!.rotulo, r.pontos[26]!.rotulo, r.pontos[51]!.rotulo]).toEqual(['27/2015', '52/2015', '01/2016', '26/2016']);
    const se10 = r.pontos.find((p) => p.ano === 2016 && p.semana === 10)!;
    const doCanal = r.canais[1]!.canal.semanas[9]!;
    expect(se10.canal).toEqual({ centro: doCanal.centro, li: doCanal.li, ls: doCanal.ls });
    expect(r.pontos.find((p) => p.ano === 2015 && p.semana === 30)!.casos).toBe(2);
    expect(r.populacao.find((p) => p.ano === 2015)).toMatchObject({ origem: 'OFICIAL' });
  });

  it('congelar gera versão nova, só uma fica ativa, e o canal congelado não muda com dados novos', async () => {
    const corpo = { grupo: 'dengue', nivel: 'MUNICIPIO', territorio: null, ano: 2016, nota: 'Canal da temporada' };
    const v1 = (await t.http().post('/api/vigilancia/diagrama/congelar').set(auth(vig)).send(corpo).expect(201)).body;
    expect(v1).toMatchObject({ versao: 1, ano: 2016, anterior: null });
    const v2 = (await t.http().post('/api/vigilancia/diagrama/congelar').set(auth(vig)).send(corpo).expect(201)).body;
    expect(v2).toMatchObject({ versao: 2, anterior: { id: v1.id, versao: 1 } });
    const canais = await db.controlChannel.findMany({ where: { groupKey: 'dengue', year: 2016, level: 'MUNICIPIO' }, orderBy: { version: 'asc' } });
    expect(canais.map((c) => [c.version, c.active])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(canais[1]).toMatchObject({ populationSource: 'MANUAL', populationVersion: 'F3', referenceYears: [2011, 2013, 2014, 2015], notes: 'Canal da temporada' });
    const antes = await diagrama('grupo=dengue&ano=2016');
    expect(antes.canais[0]!.congelado).toMatchObject({ id: v2.id, versao: 2, nota: 'Canal da temporada', calculadoPor: 'Vera Lúcia Vigilância Epidemiológica', fontePopulacao: 'MANUAL', versaoPopulacao: 'F3' });
    // Caso novo num ano de referência e população revista: a prévia mudaria, o congelado não (e avisa da população).
    await db.officialRecord.createMany({ data: Array.from({ length: 9 }, () => registro({ semana: '201510' })) });
    await t
      .http()
      .put('/api/vigilancia/populacao')
      .set(auth(vig))
      .send({ linhas: [{ ano: 2013, nivel: 'MUNICIPIO', territorioId: null, populacao: 102_500, fonte: 'MANUAL', versao: 'F3' }] })
      .expect(200);
    const depois = await diagrama('grupo=dengue&ano=2016');
    expect(depois.canais[0]!.canal).toEqual(antes.canais[0]!.canal);
    expect(depois.avisos).toContain('A população de 2013 mudou depois do congelamento: o canal congelado segue com a antiga (congele de novo para usar a atual).');
    expect(antes.avisos.some((a) => a.includes('mudou depois do congelamento'))).toBe(false);
    const previa = await diagrama('grupo=dengue&ano=2016&nivel=BAIRRO&territorio=' + ids.bairro);
    expect(previa.canais[0]!.congelado).toBeNull();
    // Ano sem referência nenhuma não congela.
    expect(
      (
        await t
          .http()
          .post('/api/vigilancia/diagrama/congelar')
          .set(auth(vig))
          .send({ ...corpo, ano: 2001 })
          .expect(422)
      ).body.code,
    ).toBe('SEM_REFERENCIA');
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.canal_congelado' } })).toBe(2);
  });

  it('anos epidêmicos sugeridos sobre a série do município (só sugere)', async () => {
    const r = (await t.http().get('/api/vigilancia/diagrama/anos-epidemicos?grupo=dengue&ano=2016').set(auth(gestora)).expect(200)).body;
    expect(r).toMatchObject({ grupo: 'dengue', ano: 2016, excluidos: [] });
    expect(r.sugestao.anos.map((a: { ano: number }) => a.ano)).toEqual([2011, 2013, 2014, 2015]);
    expect(r.sugestao.nota).toContain('SES-GO');
  });
});
