import { demoFixtures } from '@omnisaude/database';
import { intervaloDaSemana, type DetalhePlano, type SituacaoContingencia } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { ContingenciaService } from '../src/modules/vigilancia/contingencia.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Plano de contingência na API, quarta rodada da semana 27: a epidemia em vigor com as últimas SE sem canal e sem
 * acumulado acima do limiar não sugere descer (DIAGRAMA-1), e pôr o plano em vigor ao mesmo tempo, o mesmo rascunho ou
 * dois rascunhos, passa um pedido por vez (N10), e a edição do rascunho que entra em vigor ao mesmo tempo recebe 409.
 * Dados sintéticos.
 */
const enabled = await pgAvailable();

const MUNICIPIO = demoFixtures.DEMO_TENANT.ibgeCode;
const relogio = (dia: string) => () => new Date(`${dia}T15:00:00Z`);

describe.runIf(enabled)('Vigilância: contingência na quarta rodada (DIAGRAMA-1 e N10)', () => {
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
  const novoRascunho = async () => ((await t.http().post('/api/vigilancia/contingencia/planos').set(auth(vig)).send({ modelo: 'MS_2025' }).expect(201)).body as DetalhePlano).id;
  const vigencia = (id: string, desde: string) => t.http().post(`/api/vigilancia/contingencia/planos/${id}/vigencia`).set(auth(vig)).send({ desde });
  const auditorias = (id: string) => db.auditEntry.count({ where: { action: 'vigilancia.plano_vigente', entityId: id } });
  const plano = (id: string) => db.contingencyPlan.findUniqueOrThrow({ where: { id } });
  const dia = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

  beforeAll(async () => {
    t = await startTestApp('vigcontr4');
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

  it('epidemia em vigor, importação só até a SE 29 e nenhum óbito: as SE sem canal não sugerem descer (DIAGRAMA-1)', async () => {
    // Chikungunya em número de casos; o CHIKON cobre de 2011 até 23/07/2016 (SE 29). Sem OmniSaúde em uso em 2016.
    const loc = await db.locality.create({ data: { code: '99000431', name: 'Distrito Contingência R4', source: 'MANUAL' } });
    const bairro = await db.neighborhood.create({ data: { localityId: loc.id, name: 'Bairro Chikungunya R4' }, select: { id: true, name: true } });
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
    const imp = (await db.officialImport.create({ data: { system: 'SINAN_ONLINE', status: 'APLICADA', fileName: 'chikon-r4.zip', sha256: 'f'.repeat(64), sizeBytes: 1, createdBy: autor, files: [arquivo] } })).id;
    let n = 0;
    const registro = (ano: number, se: number) => {
      n++;
      const semana = `${ano}${String(se).padStart(2, '0')}`;
      return {
        system: 'SINAN_ONLINE' as const,
        type: 'INDIVIDUAL' as const,
        naturalKey: `r4-chik-${n}`,
        number: String(7_500_000 + n),
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
        firstImportId: imp,
        lastImportId: imp,
        lastSeenAt: new Date(),
      };
    };
    // 2011 a 2015: 1, 2, 3, 4 e 5 casos por SE. Em 2016: 2 casos por SE até a SE 19 e 10 da SE 20 à 29 (acima do LS).
    const dados = [];
    for (const [i, ano] of [2011, 2012, 2013, 2014, 2015].entries()) for (let se = 1; se <= 52; se++) for (let k = 0; k <= i; k++) dados.push(registro(ano, se));
    for (let se = 1; se <= 29; se++) for (let k = 0; k < (se >= 20 ? 10 : 2); k++) dados.push(registro(2016, se));
    await db.officialRecord.createMany({ data: dados });
    emDia('2016-08-03');
    await t
      .http()
      .put('/api/vigilancia/diagrama/configuracao/chikungunya')
      .set(auth(vig))
      .send({ modelo: 'MS_2025', receita: { unidade: 'CASOS' }, anosExcluidos: [], fontePopulacao: null, versaoPopulacao: null })
      .expect(200);
    await vigencia(await novoRascunho(), '2016-01-04').expect(200);
    await t
      .http()
      .post('/api/vigilancia/contingencia/acionar')
      .set(auth(vig))
      .send({ estagio: 'EPIDEMIA', justificativa: 'Chikungunya acima do limite superior há dez semanas (decisão da vigilância).', nivel: 'BAIRRO', territorio: bairro.id })
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
    // Nenhum critério do acumulado do ano segura a epidemia (sem óbito).
    expect(chik).toMatchObject({ provaveis: 138, obitosAgravo: 0, obitosInvestigacao: 0 });
    expect(s.avaliacao!.criterios.filter((c) => c.agravo === 'chikungunya' && c.atendido === true)).toEqual([]);
    expect(s.estagioAtual.chave).toBe('EPIDEMIA');
    // Antes: sugerido NORMALIDADE e "pode desmobilizar para Normalidade ... volta da curva ao canal endêmico", sem dado nas SE.
    expect(s.avaliacao).toMatchObject({ sugerido: 'EPIDEMIA', desmobilizacao: { sugerida: false } });
    expect(s.avaliacao!.desmobilizacao.detalhe).toBe(
      'Sugestão abaixo de Situação de epidemia há 0 de 4 SE completas seguidas: manter Situação de epidemia até completar 4. A SE sem canal (sem base que cubra a semana, sem população ou com o quartil indefinido) não conta como abaixo: a curva pode não ter descido.',
    );
  });

  it('o mesmo rascunho posto em vigor duas vezes ao mesmo tempo: o segundo pedido recebe 409 e a auditoria é uma só (N10)', async () => {
    emDia('2017-03-10');
    for (const desde of ['2017-03-01', '2017-03-02', '2017-03-03']) {
      const id = await novoRascunho();
      const rs = await Promise.all([vigencia(id, desde), vigencia(id, desde)]);
      // Antes, os dois liam o rascunho sem trava: [200, 200] e duas auditorias 'vigilancia.plano_vigente'.
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(rs.find((r) => r.status === 409)!.body).toMatchObject({ code: 'CONFLITO', message: 'O plano já está em vigor' });
      expect(await auditorias(id)).toBe(1);
      expect(await plano(id)).toMatchObject({ status: 'VIGENTE', validTo: null });
      expect(dia((await plano(id)).validFrom)).toBe(desde);
      expect(await db.contingencyPlan.count({ where: { status: 'VIGENTE' } })).toBe(1);
    }
  });

  it('dois rascunhos postos em vigor ao mesmo tempo entram em ordem: o segundo arquiva o primeiro, ou recebe 422 se começar antes (N10)', async () => {
    emDia('2017-03-10');
    const anterior = (await db.contingencyPlan.findFirstOrThrow({ where: { status: 'VIGENTE' } })).id;
    // A mesma data: os dois entram, um depois do outro (antes, o segundo batia no índice único: 409 'Registro duplicado').
    const [x, y] = [await novoRascunho(), await novoRascunho()];
    const rs = await Promise.all([vigencia(x, '2017-03-04'), vigencia(y, '2017-03-04')]);
    expect(rs.map((r) => [r.status, r.body.code ?? null])).toEqual([
      [200, null],
      [200, null],
    ]);
    const [px, py] = [await plano(x), await plano(y)];
    const [primeiro, segundo] = px.status === 'ARQUIVADO' ? [px, py] : [py, px];
    expect(segundo).toMatchObject({ status: 'VIGENTE', validTo: null });
    // O primeiro vigorou só naquele dia; o vigente de antes foi arquivado na véspera.
    expect([primeiro.status, dia(primeiro.validFrom), dia(primeiro.validTo)]).toEqual(['ARQUIVADO', '2017-03-04', '2017-03-04']);
    expect(dia((await plano(anterior)).validTo)).toBe('2017-03-03');
    expect((await auditorias(x)) + (await auditorias(y))).toBe(2);

    // Datas diferentes: quem chega primeiro decide. O de 05/03 depois do de 06/03 começaria antes do vigente: 422.
    const [z, w] = [await novoRascunho(), await novoRascunho()];
    const corrida = await Promise.all([vigencia(z, '2017-03-05'), vigencia(w, '2017-03-06')]);
    const status = corrida.map((r) => r.status);
    expect(status[1]).toBe(200);
    if (status[0] === 200) {
      expect([(await plano(z)).status, dia((await plano(z)).validTo)]).toEqual(['ARQUIVADO', '2017-03-05']);
    } else {
      expect(corrida[0]!.body).toMatchObject({ code: 'VIGENCIA_INVALIDA', message: 'O plano em vigor vale desde 2017-03-06: o novo não pode começar antes' });
      expect((await plano(z)).status).toBe('RASCUNHO');
    }
    expect(await plano(w)).toMatchObject({ status: 'VIGENTE', validTo: null });
    expect(await db.contingencyPlan.count({ where: { status: 'VIGENTE' } })).toBe(1);
    // Nenhum dos pedidos bate no índice único dos vigentes.
    expect(corrida.map((r) => r.body.code)).not.toContain('DUPLICADO');
  });

  it('editar o rascunho enquanto ele é posto em vigor: a edição espera a vigência e recebe 409, sem mudar o plano em vigor', async () => {
    emDia('2017-03-10');
    const id = await novoRascunho();
    const p = await plano(id);
    // A vigência no meio da transação, com a trava do escopo: o plano já está VIGENTE, ainda sem o commit.
    let soltar!: () => void;
    const segura = new Promise<void>((r) => (soltar = r));
    let travou!: () => void;
    const travada = new Promise<void>((r) => (travou = r));
    const vigencia = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contingencia-plano:${p.scope}`}))`;
        await tx.contingencyPlan.updateMany({ where: { scope: p.scope, status: 'VIGENTE' }, data: { status: 'ARQUIVADO', validTo: new Date('2017-03-09T00:00:00Z') } });
        await tx.contingencyPlan.update({ where: { id }, data: { status: 'VIGENTE', validFrom: new Date('2017-03-10T00:00:00Z'), validTo: null } });
        travou();
        await segura;
      },
      { timeout: 30_000 },
    );
    await travada;
    const edicao = t
      .http()
      .put(`/api/vigilancia/contingencia/planos/${id}`)
      .set(auth(vig))
      .send({ nome: 'Editado durante a vigência', definicao: p.definition })
      .then((r) => r);
    // A edição chega a esperar uma trava (antes, a da linha do plano, depois de ler o rascunho sem trava).
    for (let i = 0; i < 100; i++) {
      const { n } = (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!;
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    soltar();
    await vigencia;
    const r = await edicao;
    // Antes: 200, e o plano em vigor ganhava o nome (e a definição) da edição.
    expect([r.status, r.body.message]).toEqual([409, 'Só o rascunho pode ser editado: este plano está em vigor. Faça uma cópia para mudar.']);
    expect(await plano(id)).toMatchObject({ status: 'VIGENTE', name: p.name });
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.plano_editado', entityId: id } })).toBe(0);
  });
});
