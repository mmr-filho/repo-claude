import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, cnsFromBase, completeCpf, distanciaM, localDateString, metrosPorGrau, normalizarArea, normalizarLogradouro, normalizarNumero, type Posicao } from '@omnisaude/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { LocalizadorService } from '../src/modules/territorio/localizador.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * O quarteirão escolhido pelo ACE em campo manda também quando o imóvel não tem endereço com número na base do IBGE e
 * quando a recepção corrige o endereço: o imóvel fica com o centro do próprio quarteirão (e não com a mediana da rua, que
 * pode cair em outro quarteirão), e a correção do endereço não o tira do quarteirão. A religação depois de mexer na
 * malha também não, nem tirar a posição pelo cadastro; só uma ação explícita (marcar no mapa, cadastro do domicílio com
 * posição) muda o quarteirão dele.
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
type Vinculo = { analisados: number; comQuarteirao: number; semQuarteirao: number; alterados: number; foraDoQuarteirao: number };

describe.runIf(enabled)('Território: o quarteirão escolhido pelo ACE fica com o centro dele e resiste à correção do endereço', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let gestora = '';
  let ace = '';
  let recepcao = '';
  let medica = '';
  let ibge = '';
  let tz = 'America/Sao_Paulo';
  let localidade = '';
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
  /** Imóvel novo do ACE no quarteirão escolhido, com o GPS dentro dele (a posição é gravada). */
  async function doAceComGps(numeroQuarteirao: string, rua: string, numero: string, p: Posicao) {
    const op = {
      clientId: randomUUID(),
      tipo: 'IMOVEL',
      registradoEm: new Date(Date.now() - 60_000).toISOString(),
      dados: { blockId: bloco[numeroQuarteirao], propertyType: '01', street: rua, number: numero, latitude: p[1], longitude: p[0], precisaoGps: 8 },
    };
    const [r] = (
      await t
        .http()
        .post('/api/endemias/campo/sync')
        .set(auth(ace))
        .send({ operacoes: [op] })
        .expect(200)
    ).body.resultados as Resultado[];
    expect(r!.status, JSON.stringify(r)).toBe('OK');
    expect(await imovel(r!.id!)).toMatchObject({ blockId: bloco[numeroQuarteirao], geoPrecision: 'GPS_CAMPO', geoSource: 'ace' });
    return r!.id!;
  }
  /** Endereço da base do IBGE (CNEFE; nível 1: coordenada coletada no endereço; nível 4: face de quadra). */
  const endereco = (rua: string, numero: string, p: Posicao, nivel = 1) =>
    db.addressPoint.create({ data: { externalId: randomUUID(), ibgeCode: ibge, street: rua, streetKey: normalizarLogradouro(rua), number: normalizarNumero(numero), latitude: p[1], longitude: p[0], level: nivel } });
  /** Retângulo da malha (em metros a partir de O) com os campos derivados, para mexer na malha direto no banco. */
  const retangulo = (x0: number, y0: number, x1: number, y1: number) => {
    const a = ponto(x0, y0);
    const b = ponto(x1, y1);
    const area = normalizarArea({ type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] });
    const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
    const [centerLng, centerLat] = centroDe(area);
    return { geometry: area as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng, areaM2: areaM2(area) };
  };
  /** "Religar todos aos quarteirões" (depois de importar ou editar a malha). */
  const religarTodos = async () => (await t.http().post('/api/territorio/imoveis/vincular').set(auth(gestora)).expect(200)).body as Vinculo;
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
    localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '43', name: 'Quarteirão Escolhido' }).expect(201)).body.id;
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('a recepção corrige o número do imóvel do ACE que o endereço da base do IBGE confirmou no quarteirão: a posição sai, o quarteirão fica', async () => {
    // Endereço exato dentro do 14, o escolhido.
    const exato = await doAce('14', 'Rua do Numero Escolhido', '60');
    await endereco('Rua do Numero Escolhido', '60', ponto(310, 205));
    // Face de quadra na rua, a 8 m do 14 e a 12 m do 19: a malha liga o ponto ao 14, o escolhido.
    const face = await doAce('14', 'Rua da Face Escolhida', '62');
    await endereco('Rua da Face Escolhida', '62', ponto(300, 248), 4);
    expect((await geocodificar({ ids: [exato, face] })).porPrecisao).toEqual({ ENDERECO: 1, FACE: 1 });
    expect(await imovel(exato)).toMatchObject({ blockId: bloco['14'], geoPrecision: 'ENDERECO' });
    expect(await imovel(face)).toMatchObject({ blockId: bloco['14'], geoPrecision: 'FACE' });

    await t.http().patch(`/api/households/${exato}`).set(auth(recepcao)).send({ number: '61' }).expect(200);
    await t.http().patch(`/api/households/${face}`).set(auth(recepcao)).send({ street: 'Rua da Face Corrigida' }).expect(200);
    // Antes: o quarteirão saía junto com a posição do endereço (ENDERECO e FACE ligam quarteirão), e o imóvel sumia do
    // pacote do agente.
    expect(await imovel(exato)).toMatchObject({ number: '61', blockId: bloco['14'], latitude: null, geoPrecision: null, geoSource: null });
    expect(await imovel(face)).toMatchObject({ street: 'Rua da Face Corrigida', blockId: bloco['14'], latitude: null, geoPrecision: null });
    expect(await noPacote(exato)).toMatchObject({ quarteiraoId: bloco['14'] });
    expect(await noPacote(face)).toMatchObject({ quarteiraoId: bloco['14'] });
  });

  it('religar todos depois de mexer na malha: o imóvel do ACE fica no quarteirão escolhido; o da recepção segue a posição', async () => {
    // Três imóveis perto da borda leste do 24 (x de 260 a 340): o do ACE com o GPS dentro do 24, o do ACE que o endereço
    // da base do IBGE confirmou no 24 e o da recepção ligado ao 24 pelo endereço.
    const comGps = await doAceComGps('24', 'Rua da Malha Nova', '1', ponto(330, 400));
    const comEndereco = await doAce('24', 'Rua da Malha Nova', '3');
    await endereco('Rua da Malha Nova', '3', ponto(332, 410));
    await endereco('Rua da Malha Nova', '5', ponto(334, 390));
    const recep = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: 'Rua da Malha Nova', number: '5', ibgeCode: ibge }).expect(201)).body.id as string;
    await geocodificar({ ids: [comEndereco, recep] });
    for (const id of [comEndereco, recep]) expect(await imovel(id)).toMatchObject({ blockId: bloco['24'], geoPrecision: 'ENDERECO' });

    // A malha nova: o 24 encolhe para o lado oeste (x de 260 a 300) e o 24-A cobre o lado leste (x de 310 a 350).
    await db.block.update({ where: { id: bloco['24'] }, data: retangulo(260, 360, 300, 440) });
    const novo = (await db.block.create({ data: { localityId: localidade, number: '24-A', source: 'EDITOR', ...retangulo(310, 360, 350, 440) } })).id;
    const r = await religarTodos();
    // Antes: os dois imóveis do ACE iam para o 24-A (fora da zona dele) e sumiam do pacote do agente.
    expect(await imovel(comGps)).toMatchObject({ blockId: bloco['24'], geoPrecision: 'GPS_CAMPO' });
    expect(await imovel(comEndereco)).toMatchObject({ blockId: bloco['24'], geoPrecision: 'ENDERECO' });
    expect(await imovel(recep)).toMatchObject({ blockId: novo });
    expect(r.foraDoQuarteirao).toBeGreaterThanOrEqual(2);
    for (const id of [comGps, comEndereco]) expect(await noPacote(id)).toMatchObject({ quarteiraoId: bloco['24'] });
    // Rodar de novo não muda nada.
    expect((await religarTodos()).alterados).toBe(0);
  });

  it('editar o contorno do quarteirão religa o entorno: o imóvel do ACE fica no escolhido; o da recepção segue a posição', async () => {
    // Perto da borda leste do 22 (x de 60 a 140): o do ACE com o GPS dentro do 22 e o da recepção com o GPS do cadastro.
    const doAgente = await doAceComGps('22', 'Rua do Contorno', '1', ponto(132, 400));
    const p = ponto(134, 395);
    const recep = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: 'Rua do Contorno', number: '2', latitude: p[1], longitude: p[0] }).expect(201)).body.id as string;
    expect(await imovel(recep)).toMatchObject({ blockId: bloco['22'], geoSource: 'cadastro' });
    // O 22 encolhe para x de 60 a 110: os dois pontos ficam a mais de 15 m dele e do 23.
    const a = ponto(60, 360);
    const b = ponto(110, 440);
    const q = (
      await t
        .http()
        .patch(`/api/territorio/quarteiroes/${bloco['22']}`)
        .set(auth(gestora))
        .send({ geometry: { type: 'Polygon', coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] } })
        .expect(200)
    ).body;
    // Antes: o imóvel do ACE também saía do 22 (ficava sem quarteirão) e sumia do pacote do agente.
    expect(q.religados).toBe(1);
    expect(await imovel(doAgente)).toMatchObject({ blockId: bloco['22'], geoPrecision: 'GPS_CAMPO' });
    expect(await imovel(recep)).toMatchObject({ blockId: null, geoPrecision: 'GPS_CAMPO' });
    expect(await noPacote(doAgente)).toMatchObject({ quarteiraoId: bloco['22'] });
  });

  it('a marcação no mapa (e o cadastro com posição) muda o quarteirão do imóvel do ACE; daí em diante a posição explícita manda', async () => {
    const marcado = await doAce('2', 'Rua do Mapa Escolhido', '1');
    const cadastrado = await doAce('2', 'Rua do Mapa Escolhido', '3');
    // A supervisão marca no mapa dentro do 7 (x de 60 a 140, y de 60 a 140); a recepção cadastra a posição lida no imóvel.
    const m = ponto(120, 100);
    expect((await t.http().post(`/api/territorio/imoveis/${marcado}/posicao`).set(auth(gestora)).send({ lat: m[1], lng: m[0], origem: 'MAPA' }).expect(200)).body).toMatchObject({ blockId: bloco['7'] });
    const c = ponto(125, 110);
    await t.http().patch(`/api/households/${cadastrado}`).set(auth(recepcao)).send({ latitude: c[1], longitude: c[0] }).expect(200);
    expect(await imovel(marcado)).toMatchObject({ blockId: bloco['7'], geoPrecision: 'MAPA', geoSource: 'mapa' });
    expect(await imovel(cadastrado)).toMatchObject({ blockId: bloco['7'], geoPrecision: 'GPS_CAMPO', geoSource: 'cadastro' });

    // A malha nova: o 7 encolhe para x de 60 a 100 e o 7-A cobre x de 105 a 140. A religação segue a posição explícita.
    await db.block.update({ where: { id: bloco['7'] }, data: retangulo(60, 60, 100, 140) });
    const novo = (await db.block.create({ data: { localityId: localidade, number: '7-A', source: 'EDITOR', ...retangulo(105, 60, 140, 140) } })).id;
    await religarTodos();
    expect(await imovel(marcado)).toMatchObject({ blockId: novo, geoPrecision: 'MAPA' });
    expect(await imovel(cadastrado)).toMatchObject({ blockId: novo, geoPrecision: 'GPS_CAMPO' });
    // A correção do endereço não tira a posição explícita (nem o quarteirão que veio dela).
    await t.http().patch(`/api/households/${marcado}`).set(auth(recepcao)).send({ number: '2' }).expect(200);
    expect(await imovel(marcado)).toMatchObject({ blockId: novo, geoPrecision: 'MAPA' });
  });

  it('o cadastro que tira a posição tira só a posição do imóvel do ACE no quarteirão escolhido; o da recepção e o marcado no mapa perdem os dois', async () => {
    // No 10 (x de 360 a 440, y de 60 a 140): o do ACE com o GPS do aparelho, o do ACE com o centro do quarteirão, o da
    // recepção com a posição do cadastro, o da recepção com a posição do endereço da base do IBGE e o do ACE marcado no
    // mapa.
    const rua = 'Rua da Posicao Tirada';
    const comGps = await doAceComGps('10', rua, '1', ponto(380, 90));
    const comCentro = await doAce('10', rua, '3');
    expect((await geocodificar({ ids: [comCentro] })).porPrecisao).toEqual({ QUARTEIRAO: 1 });
    const p = ponto(390, 110);
    const recep = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: rua, number: '5', latitude: p[1], longitude: p[0] }).expect(201)).body.id as string;
    await endereco(rua, '9', ponto(420, 120));
    const recepEndereco = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: rua, number: '9', ibgeCode: ibge }).expect(201)).body.id as string;
    expect((await geocodificar({ ids: [recepEndereco] })).porPrecisao).toEqual({ ENDERECO: 1 });
    const marcado = await doAce('10', rua, '7');
    const m = ponto(410, 100);
    await t.http().post(`/api/territorio/imoveis/${marcado}/posicao`).set(auth(gestora)).send({ lat: m[1], lng: m[0], origem: 'MAPA' }).expect(200);
    for (const id of [comGps, comCentro, recep, recepEndereco, marcado]) expect(await imovel(id)).toMatchObject({ blockId: bloco['10'] });

    // A origem do imóvel só é consultada quando a posição sai: corrigir o número não lê a sincronização.
    const origem = vi.spyOn(t.app.get(LocalizadorService), 'criadosPeloAce');
    await t.http().patch(`/api/households/${comGps}`).set(auth(recepcao)).send({ number: '1-A' }).expect(200);
    expect(origem).not.toHaveBeenCalled();

    // A API aceita latitude e longitude nulas no cadastro (a tela não manda).
    for (const id of [comGps, comCentro, recep, recepEndereco, marcado]) await t.http().patch(`/api/households/${id}`).set(auth(recepcao)).send({ latitude: null, longitude: null }).expect(200);
    const lidas = origem.mock.calls.map(([, ids]) => ids);
    // Antes: os dois do ACE perdiam o quarteirão junto com a posição e sumiam do pacote do agente.
    for (const id of [comGps, comCentro]) {
      expect(await imovel(id)).toMatchObject({ blockId: bloco['10'], latitude: null, longitude: null, geoPrecision: null, geoSource: null, geoAt: null });
      expect(await noPacote(id)).toMatchObject({ quarteiraoId: bloco['10'] });
    }
    // Como sempre: a posição explícita (cadastro ou mapa) sai com o quarteirão que veio dela, e o imóvel da recepção perde
    // os dois também com a posição do endereço (não explícita).
    for (const id of [recep, recepEndereco, marcado]) {
      expect(await imovel(id)).toMatchObject({ blockId: null, latitude: null, longitude: null, geoPrecision: null });
      expect(await noPacote(id)).toBeUndefined();
    }
    // A origem é lida para os dois do ACE e para o da recepção com a posição do endereço; o da recepção com a posição do
    // cadastro e o marcado no mapa têm posição explícita.
    expect(lidas).toEqual([[comGps], [comCentro], [recepEndereco]]);
  });
});
