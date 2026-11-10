import { demoFixtures } from '@omnisaude/database';
import { intervaloDaSemana, PLANO_MODELO_MS_2025, type DetalhePlano, type PlanoContingencia, type SituacaoContingencia } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { acoesDoEstagio, ContingenciaService } from '../src/modules/vigilancia/contingencia.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Plano de contingência na API (VIG-1c, frente F3). O relógio dos serviços fica em agosto de 2016; a série de dengue
 * (registros oficiais criados direto no banco) tem 1, 2, 3, 4 e 5 casos por semana em 2011 a 2015: em cada SE, Q1 =
 * 1,5, mediana = 3 e Q3 = 4,5 (QUARTIL.EXC, receita em número de casos). Em 2016, 2 casos por semana até a SE 29
 * (até o centro) e 4 casos da SE 30 à 33 (entre o centro e o limite superior). Dados sintéticos.
 */
const enabled = await pgAvailable();

const MUNICIPIO = demoFixtures.DEMO_TENANT.ibgeCode;
const relogio = (dia: string) => () => new Date(`${dia}T15:00:00Z`);

describe.runIf(enabled)('Vigilância: plano de contingência, sugestão de estágio e acionamento (VIG-1c, F3)', () => {
  let t: TestApp;
  let vig = '';
  let gestora = '';
  let ace = '';
  let nucleo = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const planos: Record<string, DetalhePlano> = {};
  const acionamentos: Record<string, string> = {};

  /** Põe os dois serviços na mesma data (o da contingência decide a semana; o do diagrama valida o ano). */
  const emDia = (dia: string) => {
    t.app.get(ContingenciaService).agora = relogio(dia);
    t.app.get(DiagramaService).agora = relogio(dia);
  };
  const situacao = async (tk = vig) => (await t.http().get('/api/vigilancia/contingencia').set(auth(tk)).expect(200)).body as SituacaoContingencia;
  const criterio = (s: SituacaoContingencia, id: string, agravo?: string) => s.avaliacao!.criterios.find((c) => c.id === id && (agravo === undefined || c.agravo === agravo))!;

  beforeAll(async () => {
    t = await startTestApp('vigcontingencia');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    nucleo = await t.login('nucleo', 'Hospital Municipal São Lucas', 'NUCLEO_VIGILANCIA');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    await t.app.get(CatalogoVigilanciaService).garantir({ tenant, db });
    emDia('2016-08-17');
    // As tabelas desta frente começam vazias (a demonstração pode ter semeado plano, acionamento, receita e população).
    await db.contingencyActionItem.deleteMany();
    await db.contingencyActivation.deleteMany();
    await db.contingencyInput.deleteMany();
    await db.contingencyPlan.deleteMany();
    await db.controlChannel.deleteMany();
    await db.diagramSetting.deleteMany();
    await db.populationEstimate.deleteMany();

    const autor = (await db.user.findFirstOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf }, select: { id: true } })).id;
    const imp = await db.officialImport.create({ data: { system: 'SINAN_ONLINE', status: 'APLICADA', fileName: 'f3-contingencia.zip', sha256: 'c'.repeat(64), sizeBytes: 1, createdBy: autor } });
    let n = 0;
    const registro = (ano: number, se: number) => {
      n++;
      const semana = `${ano}${String(se).padStart(2, '0')}`;
      return {
        system: 'SINAN_ONLINE' as const,
        type: 'INDIVIDUAL' as const,
        naturalKey: `f3c-${n}`,
        number: String(8_000_000 + n),
        notifiedOn: new Date(`${intervaloDaSemana(ano, se).inicio}T00:00:00Z`),
        epiWeekNotified: semana,
        epiWeekOnset: semana,
        municipalityIbge: MUNICIPIO,
        residenceIbge: MUNICIPIO,
        agravo: 'A90',
        groupKey: 'dengue',
        situation: 'CONFIRMADO',
        contentHash: '0'.repeat(64),
        firstImportId: imp.id,
        lastImportId: imp.id,
        lastSeenAt: new Date(),
      };
    };
    const dados = [];
    for (const [i, ano] of [2011, 2012, 2013, 2014, 2015].entries()) for (let se = 1; se <= 52; se++) for (let k = 0; k <= i; k++) dados.push(registro(ano, se));
    for (let se = 1; se <= 33; se++) for (let k = 0; k < (se >= 30 ? 4 : 2); k++) dados.push(registro(2016, se));
    await db.officialRecord.createMany({ data: dados });
    // Receita do MS 2025 em número de casos (sem população cadastrada).
    await t
      .http()
      .put('/api/vigilancia/diagrama/configuracao/dengue')
      .set(auth(vig))
      .send({ modelo: 'MS_2025', receita: { unidade: 'CASOS' }, anosExcluidos: [], fontePopulacao: null, versaoPopulacao: null })
      .expect(200);
  });

  afterAll(async () => {
    await t?.close();
  });

  it('sem plano: a situação mostra a normalidade e os indicadores, sem avaliação; GESTOR e núcleo leem, ACE não', async () => {
    const s = await situacao(gestora);
    expect(s.plano).toBeNull();
    expect(s.avaliacao).toBeNull();
    expect(s.estagioAtual).toEqual({ chave: 'NORMALIDADE', nome: 'Normalidade', desde: null, acionamentoId: null });
    expect(s.semanaReferencia).toBe('201631');
    expect(s.semanasIncompletas).toEqual(['201632', '201633']);
    expect(s.indicadores.map((i) => i.grupo)).toEqual(['dengue', 'chikungunya', 'zika']);
    expect(s.avisos[0]).toContain('Sem plano de contingência em vigor');
    await situacao(nucleo);
    await t.http().get('/api/vigilancia/contingencia').set(auth(ace)).expect(403);
    await t.http().get('/api/vigilancia/contingencia/planos').set(auth(ace)).expect(403);
    await t.http().get('/api/vigilancia/contingencia/planos').set(auth(gestora)).expect(200, []);
  });

  it('plano a partir do modelo do MS: nasce rascunho, com a definição do modelo', async () => {
    await t.http().post('/api/vigilancia/contingencia/planos').set(auth(gestora)).send({ modelo: 'MS_2025' }).expect(403);
    const p = (await t.http().post('/api/vigilancia/contingencia/planos').set(auth(vig)).send({ modelo: 'MS_2025' }).expect(201)).body as DetalhePlano;
    expect(p).toMatchObject({ escopo: 'ARBOVIROSES', versao: 1, status: 'RASCUNHO', vigenteDesde: null, nome: 'Plano de contingência das arboviroses (modelo do MS, 2025)' });
    expect(p.fonte).toContain('Apêndice B');
    expect(p.definicao).toEqual(PLANO_MODELO_MS_2025);
    expect((await t.http().get(`/api/vigilancia/contingencia/planos/${p.id}`).set(auth(gestora)).expect(200)).body).toEqual(p);
    planos.v1 = p;
  });

  it('edição só em rascunho, com a definição validada', async () => {
    const id = planos.v1!.id;
    const put = (definicao: PlanoContingencia, status: number, tk = vig) => t.http().put(`/api/vigilancia/contingencia/planos/${id}`).set(auth(tk)).send({ definicao }).expect(status);
    const def = structuredClone(PLANO_MODELO_MS_2025);
    def.desmobilizacao.semanas = 3;
    await put(def, 403, gestora);
    // Critério de um estágio que não existe, critério na normalidade e agravo fora do plano.
    const semEstagio = structuredClone(def);
    semEstagio.criterios[0]!.estagio = 'INEXISTENTE';
    expect((await put(semEstagio, 422)).body).toMatchObject({ code: 'PLANO_INVALIDO', message: expect.stringContaining('não existe no plano') });
    const naNormalidade = structuredClone(def);
    naNormalidade.criterios[0]!.estagio = 'NORMALIDADE';
    expect((await put(naNormalidade, 422)).body.message).toContain('a normalidade não tem critério');
    const foraDoPlano = structuredClone(def);
    foraDoPlano.criterios[0]!.agravos = ['febre-amarela'];
    expect((await put(foraDoPlano, 422)).body.message).toContain('fora do plano');
    const semSemanas = structuredClone(def);
    delete semSemanas.criterios[0]!.semanas;
    expect((await put(semSemanas, 422)).body.message).toContain('semanas seguidas');
    const semLimiar = structuredClone(def);
    delete semLimiar.criterios.find((c) => c.tipo === 'LETALIDADE')!.limiar;
    expect((await put(semLimiar, 422)).body.message).toContain('limiar');
    // Formato errado (zod): estágio com chave minúscula.
    await put({ ...def, estagios: def.estagios.map((e, i) => (i ? e : { ...e, chave: 'normal' })) }, 400);
    // A tela manda null nos campos vazios: some da definição gravada.
    const comNulos = { ...def, criterios: def.criterios.map((c) => ({ ...c, limiar: c.limiar ?? null, comparador: c.comparador ?? null })) };
    const editado = (await put(comNulos as unknown as PlanoContingencia, 200)).body as DetalhePlano;
    expect(editado.definicao).toEqual(def);
    expect(editado.definicao.desmobilizacao.semanas).toBe(3);
    // Desfaz a troca (o resto do teste usa o modelo).
    await put(PLANO_MODELO_MS_2025, 200);
  });

  it('vigência: o rascunho entra em vigor; a cópia em vigor arquiva o anterior na véspera e o vigente não se edita', async () => {
    const v1 = planos.v1!.id;
    await t.http().post(`/api/vigilancia/contingencia/planos/${v1}/vigencia`).set(auth(vig)).send({ desde: '2016-08-18' }).expect(400);
    const vigente = (await t.http().post(`/api/vigilancia/contingencia/planos/${v1}/vigencia`).set(auth(vig)).send({ desde: '2016-01-04' }).expect(200)).body as DetalhePlano;
    expect(vigente).toMatchObject({ status: 'VIGENTE', vigenteDesde: '2016-01-04', vigenteAte: null });
    await t.http().put(`/api/vigilancia/contingencia/planos/${v1}`).set(auth(vig)).send({ definicao: PLANO_MODELO_MS_2025 }).expect(409);
    await t.http().post(`/api/vigilancia/contingencia/planos/${v1}/vigencia`).set(auth(vig)).send({ desde: '2016-02-01' }).expect(409);

    const copia = (await t.http().post('/api/vigilancia/contingencia/planos').set(auth(vig)).send({ copiarDe: v1, nome: 'Plano municipal 2016' }).expect(201)).body as DetalhePlano;
    expect(copia).toMatchObject({ versao: 2, status: 'RASCUNHO', nome: 'Plano municipal 2016', definicao: PLANO_MODELO_MS_2025 });
    // Não começa antes do plano em vigor.
    expect((await t.http().post(`/api/vigilancia/contingencia/planos/${copia.id}/vigencia`).set(auth(vig)).send({ desde: '2015-12-31' }).expect(422)).body.code).toBe('VIGENCIA_INVALIDA');
    await t.http().post(`/api/vigilancia/contingencia/planos/${copia.id}/vigencia`).set(auth(gestora)).send({ desde: '2016-08-01' }).expect(403);
    await t.http().post(`/api/vigilancia/contingencia/planos/${copia.id}/vigencia`).set(auth(vig)).send({ desde: '2016-08-01' }).expect(200);
    const lista = (await t.http().get('/api/vigilancia/contingencia/planos').set(auth(vig)).expect(200)).body as DetalhePlano[];
    expect(lista.map((p) => [p.versao, p.status, p.vigenteDesde, p.vigenteAte])).toEqual([
      [2, 'VIGENTE', '2016-08-01', null],
      [1, 'ARQUIVADO', '2016-01-04', '2016-07-31'],
    ]);
    // O arquivado não volta a vigorar.
    await t.http().post(`/api/vigilancia/contingencia/planos/${v1}/vigencia`).set(auth(vig)).send({ desde: '2016-08-10' }).expect(409);
    planos.v2 = copia;
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.plano_vigente' } })).toBe(2);
  });

  it('sugestão só com as semanas completas: as incompletas não completam as 4 SE da mobilização', async () => {
    // 17/08/2016 (SE 33): SE 32 e 33 incompletas; nas 4 últimas completas (28 a 31), só a 30 e a 31 passam do centro.
    let s = await situacao();
    expect(s.plano!.id).toBe(planos.v2!.id);
    const dengue = s.indicadores.find((i) => i.grupo === 'dengue')!;
    expect(dengue.semanas).toHaveLength(33);
    expect(dengue.semanas.slice(27).map((x) => [x.semana, x.status, x.completa])).toEqual([
      ['201628', 'ATE_CENTRO', true],
      ['201629', 'ATE_CENTRO', true],
      ['201630', 'ENTRE_CENTRO_E_LS', true],
      ['201631', 'ENTRE_CENTRO_E_LS', true],
      ['201632', 'ENTRE_CENTRO_E_LS', false],
      ['201633', 'ENTRE_CENTRO_E_LS', false],
    ]);
    // Prováveis do ano até a semana de referência (SE 31): 2 × 29 + 4 × 2.
    expect(dengue).toMatchObject({ provaveis: 66, graves: 0, sinaisAlarme: 0, obitosAgravo: 0, obitosInvestigacao: 0, incidenciaAcumulada: null });
    expect(criterio(s, 'mob-canal', 'dengue')).toMatchObject({ atendido: false, valor: 2 });
    expect(criterio(s, 'mob-rtpcr').atendido).toBeNull();
    expect(s.avaliacao!.sugerido).toBe('NORMALIDADE');

    // Duas semanas depois (SE 35), a SE 32 e a 33 ficaram completas: 4 SE seguidas acima do centro.
    emDia('2016-08-31');
    s = await situacao();
    expect(s.semanaReferencia).toBe('201633');
    expect(criterio(s, 'mob-canal', 'dengue')).toMatchObject({ atendido: true, valor: 4 });
    expect(s.avaliacao!.sugerido).toBe('MOBILIZACAO');
    expect(s.avaliacao!.porEstagio).toMatchObject({ MOBILIZACAO: 1, ALERTA: 0, EPIDEMIA: 0 });
    emDia('2016-08-17');
  });

  it('respostas manuais da semana: entram na avaliação, regravam a anterior e só valem para critério manual', async () => {
    const post = (body: object, status: number, tk = vig) => t.http().post('/api/vigilancia/contingencia/respostas').set(auth(tk)).send(body).expect(status);
    await post({ semana: '201631', criterio: 'mob-rtpcr', atendido: true }, 403, gestora);
    const r = (await post({ semana: '201631', criterio: 'mob-rtpcr', atendido: true, nota: 'Positividade de 25% nas últimas 4 SE' }, 200)).body;
    expect(r).toMatchObject({ semana: '201631', criterio: 'mob-rtpcr', atendido: true, nota: 'Positividade de 25% nas últimas 4 SE', respondidoPor: 'Vera Lúcia Vigilância Epidemiológica' });
    let s = await situacao();
    expect(s.respostas).toEqual([expect.objectContaining({ criterio: 'mob-rtpcr', atendido: true })]);
    expect(criterio(s, 'mob-rtpcr')).toMatchObject({ atendido: true });
    expect(s.avaliacao!.sugerido).toBe('MOBILIZACAO');
    // Respondido de novo na mesma semana: regrava (um registro só).
    await post({ semana: '201631', criterio: 'mob-rtpcr', atendido: false }, 200);
    s = await situacao();
    expect(criterio(s, 'mob-rtpcr').atendido).toBe(false);
    expect(s.avaliacao!.sugerido).toBe('NORMALIDADE');
    expect(await db.contingencyInput.count()).toBe(1);
    // Critério avaliado pelo sistema, critério inexistente, semana futura e semana inexistente.
    expect((await post({ semana: '201631', criterio: 'mob-canal', atendido: true }, 400)).body.code).toBe('CRITERIO_AUTOMATICO');
    expect((await post({ semana: '201631', criterio: 'nao-existe', atendido: true }, 400)).body.code).toBe('CRITERIO_INVALIDO');
    expect((await post({ semana: '201640', criterio: 'mob-rtpcr', atendido: true }, 400)).body.code).toBe('SEMANA_FUTURA');
    await post({ semana: '201654', criterio: 'mob-rtpcr', atendido: true }, 400);
    // Resposta de outra semana não entra na avaliação da semana de referência.
    await post({ semana: '201630', criterio: 'ale-zdc', atendido: true }, 200);
    expect(criterio(await situacao(), 'ale-zdc').atendido).toBeNull();
  });

  it('acionar: exige justificativa, fecha o acionamento anterior na véspera e cria o checklist cumulativo', async () => {
    const acionar = (body: object, status: number, tk = vig) => t.http().post('/api/vigilancia/contingencia/acionar').set(auth(tk)).send(body).expect(status);
    const justificativa = 'Incidência acima da mediana há duas semanas e positividade em alta.';
    await acionar({ estagio: 'MOBILIZACAO', justificativa, nivel: 'MUNICIPIO', territorio: null }, 403, gestora);
    await acionar({ estagio: 'MOBILIZACAO', justificativa: 'Curta demais', nivel: 'MUNICIPIO', territorio: null }, 400);
    expect((await acionar({ estagio: 'INEXISTENTE', justificativa, nivel: 'MUNICIPIO', territorio: null }, 400)).body.code).toBe('ESTAGIO_INVALIDO');

    const mob = (await acionar({ estagio: 'MOBILIZACAO', justificativa, ato: 'Portaria SMS nº 12/2016', nivel: 'MUNICIPIO', territorio: null }, 201)).body;
    const acoesMob = acoesDoEstagio(PLANO_MODELO_MS_2025, 'MOBILIZACAO');
    expect(acoesMob.map((a) => a.estagio)).toEqual([...Array(21).fill('NORMALIDADE'), ...Array(19).fill('MOBILIZACAO')]);
    expect(mob).toMatchObject({ anteriorEncerrado: null, acoesCriadas: acoesMob.length });
    expect(mob.acionamento).toMatchObject({
      estagio: 'MOBILIZACAO',
      estagioNome: 'Mobilização',
      inicio: '2016-08-17',
      semanaInicio: '201633',
      fim: null,
      ato: 'Portaria SMS nº 12/2016',
      decididoPor: 'Vera Lúcia Vigilância Epidemiológica',
    });
    expect(mob.acionamento.indicadores.map((i: { grupo: string }) => i.grupo)).toEqual(['dengue', 'chikungunya', 'zika']);
    acionamentos.mob = mob.acionamento.id;
    let s = await situacao();
    expect(s.estagioAtual).toEqual({ chave: 'MOBILIZACAO', nome: 'Mobilização', desde: '2016-08-17', acionamentoId: mob.acionamento.id });
    expect(s.checklist.map((a) => [a.estagio, a.eixo, a.descricao])).toEqual(acoesMob.map((a) => [a.estagio, a.eixo, a.descricao]));
    // O mesmo estágio de novo não abre outro acionamento.
    await acionar({ estagio: 'MOBILIZACAO', justificativa, nivel: 'MUNICIPIO', territorio: null }, 409);
    // Em 07/09 (SE 36) a SE 34 veio sem caso: a sugestão caiu abaixo da mobilização há só 1 SE completa, então mantém.
    emDia('2016-09-07');
    s = await situacao();
    expect(s.avaliacao).toMatchObject({ sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: false, detalhe: expect.stringContaining('há 1 de 4 SE completas seguidas') } });

    // Uma semana depois, o alerta: o anterior termina na véspera e o checklist traz normalidade, mobilização e alerta.
    emDia('2016-08-24');
    const ale = (await acionar({ estagio: 'ALERTA', justificativa: 'Curva acima do limite superior e casos graves em alta.', nivel: 'MUNICIPIO', territorio: null }, 201)).body;
    const acoesAle = acoesDoEstagio(PLANO_MODELO_MS_2025, 'ALERTA');
    expect(acoesAle).toHaveLength(21 + 19 + 14);
    expect(ale).toMatchObject({ anteriorEncerrado: { id: mob.acionamento.id, fim: '2016-08-23' }, acoesCriadas: acoesAle.length });
    acionamentos.ale = ale.acionamento.id;
    s = await situacao();
    expect(s.estagioAtual).toMatchObject({ chave: 'ALERTA', desde: '2016-08-24' });
    expect(s.checklist).toHaveLength(acoesAle.length);
    expect(s.historico.map((h) => [h.estagio, h.inicio, h.semanaInicio, h.fim, h.semanaFim])).toEqual([
      ['ALERTA', '2016-08-24', '201634', null, null],
      ['MOBILIZACAO', '2016-08-17', '201633', '2016-08-23', '201634'],
    ]);
    expect(await db.contingencyActivation.count({ where: { endedOn: null } })).toBe(1);
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.contingencia_acionada' } })).toBe(2);
  });

  it('checklist: atualiza a ação do acionamento aberto; a do encerrado não muda', async () => {
    const s = await situacao();
    const acao = s.checklist.find((a) => a.estagio === 'ALERTA')!;
    await t.http().patch(`/api/vigilancia/contingencia/acoes/${acao.id}`).set(auth(gestora)).send({ status: 'FEITA' }).expect(403);
    await t.http().patch(`/api/vigilancia/contingencia/acoes/${acao.id}`).set(auth(vig)).send({}).expect(400);
    const r = (await t.http().patch(`/api/vigilancia/contingencia/acoes/${acao.id}`).set(auth(vig)).send({ status: 'EM_ANDAMENTO', responsavel: 'Coordenação de vigilância', nota: 'Reunião marcada' }).expect(200)).body;
    expect(r).toMatchObject({ id: acao.id, status: 'EM_ANDAMENTO', responsavel: 'Coordenação de vigilância', nota: 'Reunião marcada', atualizadoPor: 'Vera Lúcia Vigilância Epidemiológica' });
    expect((await situacao()).checklist.find((a) => a.id === acao.id)).toMatchObject({ status: 'EM_ANDAMENTO' });
    const daMobilizacao = await db.contingencyActionItem.findFirstOrThrow({ where: { activationId: acionamentos.mob } });
    await t.http().patch(`/api/vigilancia/contingencia/acoes/${daMobilizacao.id}`).set(auth(vig)).send({ status: 'FEITA' }).expect(409);
  });

  it('território: bairro com acionamento próprio, sem mexer no do município', async () => {
    const loc = await db.locality.create({ data: { code: '99000328', name: 'Distrito Contingência F3', source: 'MANUAL' } });
    const bairro = await db.neighborhood.create({ data: { localityId: loc.id, name: 'Bairro Contingência F3' }, select: { id: true, name: true } });
    const q = `nivel=BAIRRO&territorio=${bairro.id}`;
    const s = (await t.http().get(`/api/vigilancia/contingencia?${q}`).set(auth(vig)).expect(200)).body as SituacaoContingencia;
    expect(s.territorio).toEqual({ nivel: 'BAIRRO', id: bairro.id, nome: bairro.name });
    expect(s.estagioAtual.chave).toBe('NORMALIDADE');
    expect(s.historico).toEqual([]);
    await t
      .http()
      .post('/api/vigilancia/contingencia/acionar')
      .set(auth(vig))
      .send({ estagio: 'MOBILIZACAO', justificativa: 'Aglomerado de casos no bairro nas últimas semanas.', nivel: 'BAIRRO', territorio: bairro.id })
      .expect(201);
    expect((await situacao()).estagioAtual.chave).toBe('ALERTA');
    expect(await db.contingencyActivation.count({ where: { endedOn: null } })).toBe(2);
  });
});
