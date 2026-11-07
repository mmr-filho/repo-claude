import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, cnsFromBase, completeCpf, distanciaM, localDateString, metrosPorGrau, normalizarArea, normalizarLogradouro, normalizarNumero, type Posicao } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * O quarteirão escolhido pelo ACE em campo manda também quando o imóvel não tem endereço com número na base do IBGE e
 * quando a recepção corrige o endereço: o imóvel fica com o centro do próprio quarteirão (e não com a mediana da rua, que
 * pode cair em outro quarteirão), e a correção do endereço não o tira do quarteirão.
 */
const enabled = await pgAvailable();

const DIA = 86_400_000;
// Grade 5 x 5 de quarteirões de 80 m (ruas de 20 m, passo de 100 m): o quarteirão n fica na linha floor((n-1)/5) e na
// coluna (n-1)%5, com centro em (coluna × 100, linha × 100) metros a partir de O.
const O: Posicao = [-49.52, -12.04];
const mpg = metrosPorGrau(O[1]);
const ponto = (x: number, y: number): Posicao => [O[0] + x / mpg.lng, O[1] + y / mpg.lat];
const quadrado = (centro: Posicao, lado = 80) => {
  const a: Posicao = [centro[0] - lado / 2 / mpg.lng, centro[1] - lado / 2 / mpg.lat];
  const b: Posicao = [centro[0] + lado / 2 / mpg.lng, centro[1] + lado / 2 / mpg.lat];
  return { type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] };
};

type Resultado = { clientId: string; status: string; id: string | null };

describe.runIf(enabled)('Território: o quarteirão escolhido pelo ACE fica com o centro dele e resiste à correção do endereço', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let gestora = '';
  let ace = '';
  let recepcao = '';
  let medica = '';
  let ibge = '';
  let tz = 'America/Sao_Paulo';
  let seq = 0;
  const bloco: Record<string, string> = {};
  const centro: Record<string, Posicao> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const imovel = (id: string) => db.household.findUniqueOrThrow({ where: { id } });
  const dia = (n: number) => localDateString(new Date(Date.now() + n * DIA), tz);
  /** Imóvel novo do ACE no quarteirão escolhido, sem GPS. */
  async function doAce(numeroQuarteirao: string, rua: string, numero: string) {
    const op = { clientId: randomUUID(), tipo: 'IMOVEL', registradoEm: new Date(Date.now() - 60_000).toISOString(), dados: { blockId: bloco[numeroQuarteirao], propertyType: '01', street: rua, number: numero } };
    const [r] = (
      await t
        .http()
        .post('/api/endemias/campo/sync')
        .set(auth(ace))
        .send({ operacoes: [op] })
        .expect(200)
    ).body.resultados as Resultado[];
    expect(r!.status, JSON.stringify(r)).toBe('OK');
    expect(await imovel(r!.id!)).toMatchObject({ blockId: bloco[numeroQuarteirao], latitude: null, geoPrecision: null });
    return r!.id!;
  }
  /** Endereço da base do IBGE (CNEFE, nível 1). */
  const endereco = (rua: string, numero: string, p: Posicao) =>
    db.addressPoint.create({ data: { externalId: randomUUID(), ibgeCode: ibge, street: rua, streetKey: normalizarLogradouro(rua), number: normalizarNumero(numero), latitude: p[1], longitude: p[0], level: 1 } });
  const geocodificar = async (body: Record<string, unknown>) =>
    (await t.http().post('/api/territorio/imoveis/geocodificar').set(auth(gestora)).send(body).expect(200)).body as { atualizados: number; foraDoQuarteirao: number; porPrecisao: Record<string, number> };
  /** A mediana da rua como a geocodificação antiga gravava no imóvel do ACE (posição aproximada, sem mexer no quarteirão). */
  const comMedianaDaRua = (id: string, p: Posicao) =>
    db.$executeRaw`UPDATE households SET latitude = ${p[1]}, longitude = ${p[0]}, geo_precision = 'LOGRADOURO'::"GeoPrecision", geo_source = 'cnefe:logradouro', geo_at = now() WHERE id = ${id}::uuid`;
  const noPacote = async (id: string) => ((await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body.imoveis as { id: string; quarteiraoId: string }[]).find((i) => i.id === id);

  beforeAll(async () => {
    t = await startTestApp('terrescolhido');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    const supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    const tenants = t.app.get(TenantsService);
    const info = await tenants.resolve(t.slug);
    tz = info.timeZone;
    db = await tenants.client(info.id);
    ibge = (await db.unit.findFirstOrThrow({ where: { name: 'Vigilância em Saúde' } })).ibgeCode ?? '3550308';
    const localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '43', name: 'Quarteirão Escolhido' }).expect(201)).body.id;
    for (let lin = 0; lin < 5; lin++)
      for (let col = 0; col < 5; col++) {
        const area = normalizarArea(quadrado(ponto(col * 100, lin * 100)));
        const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
        const [centerLng, centerLat] = centroDe(area);
        const numero = String(lin * 5 + col + 1);
        centro[numero] = [centerLng, centerLat];
        bloco[numero] = (
          await db.block.create({ data: { localityId: localidade, number: numero, geometry: area as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng, areaM2: areaM2(area), source: 'EDITOR' } })
        ).id;
      }
    const aceId = (await db.user.findFirstOrThrow({ where: { name: { contains: 'Agente de Endemias' } } })).id;
    await t
      .http()
      .post('/api/endemias/zonas')
      .set(auth(supervisora))
      .send({ nome: 'Zona Quarteirão Escolhido', aceId, quarteiroes: Object.values(bloco) })
      .expect(201);
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it('rua na base sem o número do imóvel: o imóvel do ACE recebe o centro do quarteirão escolhido, não a mediana da rua; o caso do morador abre a ordem', async () => {
    const rua = 'Rua do Centro Escolhido';
    // Os números da rua que estão na base caem todos no quarteirão 8.
    await endereco(rua, '1', ponto(190, 95));
    await endereco(rua, '2', ponto(200, 100));
    await endereco(rua, '3', ponto(210, 105));
    const id = await doAce('3', rua, '50');
    // O mesmo imóvel, mas com a mediana da rua gravada pela geocodificação antiga (no 8, longe do 3).
    const antigo = await doAce('3', rua, '52');
    await comMedianaDaRua(antigo, ponto(200, 100));

    const geo = await geocodificar({ ids: [id, antigo] });
    // Antes: o novo ficava com a mediana da rua (LOGRADOURO, no 8) e o antigo, com a mesma precisão, não mudava mais.
    expect(geo).toMatchObject({ atualizados: 2, foraDoQuarteirao: 0, porPrecisao: { QUARTEIRAO: 2 } });
    for (const x of [id, antigo]) {
      const h = await imovel(x);
      expect(h).toMatchObject({ blockId: bloco['3'], geoPrecision: 'QUARTEIRAO', geoSource: 'centro-do-quarteirao' });
      expect(distanciaM([h.longitude!, h.latitude!], centro['3']!)).toBeLessThan(0.5);
    }

    // O morador com dengue: o centro do quarteirão serve ao bloqueio (com "conferir o imóvel"); a mediana da rua não
    // servia, e a ordem ficava aguardando a localização.
    seq++;
    const morador = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({ name: 'Morador Quarteirao Escolhido', birthDate: '1979-04-14', sex: 'F', cpf: completeCpf(String(498100000 + seq)), cns: cnsFromBase(String(29810000000 + seq)), motherName: 'Mae do Morador' })
        .expect(201)
    ).body.id as string;
    await t.http().post(`/api/households/${id}/families`).set(auth(recepcao)).send({ responsibleId: morador }).expect(201);
    const n = await t
      .http()
      .post('/api/vigilancia/notificacoes')
      .set(auth(medica))
      .send({ patientId: morador, conditionKey: 'dengue', symptomsOnset: dia(-1) });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    const ligacao = await db.blockingOrderCase.findUniqueOrThrow({ where: { notificationId: n.body.id } });
    expect(ligacao).toMatchObject({ precision: 'QUARTEIRAO', blockId: bloco['3'], householdId: id });
    const ordem = await db.blockingOrder.findUniqueOrThrow({ where: { id: ligacao.orderId }, include: { blocks: true } });
    expect(ordem).toMatchObject({ status: 'ABERTA', needsCheck: true });
    expect(ordem.blocks.map((b) => b.blockId)).toContain(bloco['3']);
  });

  it('a recepção corrige o endereço: o imóvel do ACE continua no quarteirão escolhido (e no pacote do agente)', async () => {
    // Com o centro do quarteirão (a geocodificação sem endereço na base).
    const comCentro = await doAce('13', 'Rua Sem Base Escolhido', '91');
    expect((await geocodificar({ ids: [comCentro] })).porPrecisao).toEqual({ QUARTEIRAO: 1 });
    await t.http().patch(`/api/households/${comCentro}`).set(auth(recepcao)).send({ number: '92' }).expect(200);
    // Antes: o centro do quarteirão era tratado como posição do endereço e saía com o quarteirão (o imóvel sumia do pacote).
    expect(await imovel(comCentro)).toMatchObject({ number: '92', blockId: bloco['13'], geoPrecision: 'QUARTEIRAO' });
    expect(await noPacote(comCentro)).toMatchObject({ quarteiraoId: bloco['13'] });

    // Com a mediana da rua gravada antes: a posição do endereço antigo sai, o quarteirão escolhido fica.
    const comRua = await doAce('13', 'Rua Mediana Escolhido', '93');
    await comMedianaDaRua(comRua, ponto(400, 400));
    await t.http().patch(`/api/households/${comRua}`).set(auth(recepcao)).send({ street: 'Rua Mediana Corrigida' }).expect(200);
    expect(await imovel(comRua)).toMatchObject({ street: 'Rua Mediana Corrigida', blockId: bloco['13'], latitude: null, geoPrecision: null });
    expect(await noPacote(comRua)).toMatchObject({ quarteiraoId: bloco['13'] });

    // Como sempre: o imóvel ligado ao quarteirão pela posição do endereço perde os dois quando o endereço muda.
    await endereco('Rua do Endereco Escolhido', '10', ponto(300, 300));
    const doEndereco = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: 'Rua do Endereco Escolhido', number: '10', ibgeCode: ibge }).expect(201)).body.id as string;
    await geocodificar({ ids: [doEndereco] });
    expect(await imovel(doEndereco)).toMatchObject({ blockId: bloco['19'], geoPrecision: 'ENDERECO' });
    await t.http().patch(`/api/households/${doEndereco}`).set(auth(recepcao)).send({ number: '11' }).expect(200);
    expect(await imovel(doEndereco)).toMatchObject({ blockId: null, latitude: null, geoPrecision: null });
  });
});
