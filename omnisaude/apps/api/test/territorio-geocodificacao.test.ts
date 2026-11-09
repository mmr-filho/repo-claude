import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, distanciaM, metrosPorGrau, normalizarArea, normalizarLogradouro, normalizarNumero, type Posicao } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { MOTIVO_FORA_DO_QUARTEIRAO, MOTIVO_QUARTEIRAO_DESATIVADO } from '../src/modules/territorio/geocodificacao.service';
import { LocalizadorService } from '../src/modules/territorio/localizador.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

// Grade 5 x 5 de quarteirões de 80 m (ruas de 20 m, passo de 100 m), como em endemias-campo.test.ts: o quarteirão n fica
// na linha floor((n-1)/5) e na coluna (n-1)%5, com centro em (coluna × 100, linha × 100) metros a partir de O.
const O: Posicao = [-49.31, -11.93];
const mpg = metrosPorGrau(O[1]);
const ponto = (x: number, y: number): Posicao => [O[0] + x / mpg.lng, O[1] + y / mpg.lat];
const quadrado = (centro: Posicao, lado = 80) => {
  const a: Posicao = [centro[0] - lado / 2 / mpg.lng, centro[1] - lado / 2 / mpg.lat];
  const b: Posicao = [centro[0] + lado / 2 / mpg.lng, centro[1] + lado / 2 / mpg.lat];
  return { type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] };
};
const RUA = 'Rua Sonda Geo';

type Resultado = { clientId: string; status: string; id: string | null; avisos?: string[] };
type Geocodificacao = { analisados: number; atualizados: number; foraDoQuarteirao: number; quarteiraoDesativado: number; avisos: string[]; porPrecisao: Record<string, number> };

describe.runIf(enabled)('Território: a geocodificação por endereço não tira o imóvel do quarteirão escolhido em campo; o que veio do endereço segue o endereço melhor', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let gestora = '';
  let ace = '';
  let recepcao = '';
  let ibge = '';
  const bloco: Record<string, string> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const imovel = (id: string) => db.household.findUniqueOrThrow({ where: { id } });
  /** Imóvel novo do ACE no quarteirão escolhido (com ou sem GPS). */
  async function doAce(numeroQuarteirao: string, numero: string, extra: Record<string, unknown> = {}, rua = RUA) {
    const op = {
      clientId: randomUUID(),
      tipo: 'IMOVEL',
      registradoEm: new Date(Date.now() - 60_000).toISOString(),
      dados: { blockId: bloco[numeroQuarteirao], propertyType: '01', street: rua, number: numero, ...extra },
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
    return r!;
  }
  /** Endereço da base do IBGE (CNEFE; nível 1: coordenada coletada no endereço; nível 4: face de quadra). */
  const endereco = (numero: string, p: Posicao, rua = RUA, nivel = 1) =>
    db.addressPoint.create({ data: { externalId: randomUUID(), ibgeCode: ibge, street: rua, streetKey: normalizarLogradouro(rua), number: normalizarNumero(numero), latitude: p[1], longitude: p[0], level: nivel } });
  /** Imóvel da recepção, sem posição nem quarteirão. */
  const daRecepcao = async (rua: string, numero: string) => (await t.http().post('/api/households').set(auth(recepcao)).send({ street: rua, number: numero, ibgeCode: ibge }).expect(201)).body.id as string;
  const geocodificar = async (body: Record<string, unknown>) => (await t.http().post('/api/territorio/imoveis/geocodificar').set(auth(gestora)).send(body).expect(200)).body as Geocodificacao;

  beforeAll(async () => {
    t = await startTestApp('terrgeo');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    const supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    ibge = (await db.unit.findFirstOrThrow({ where: { name: 'Vigilância em Saúde' } })).ibgeCode ?? '3550308';
    const localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '41', name: 'Geocodificação' }).expect(201)).body.id;
    for (let lin = 0; lin < 5; lin++)
      for (let col = 0; col < 5; col++) {
        const area = normalizarArea(quadrado(ponto(col * 100, lin * 100)));
        const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
        const [centerLng, centerLat] = centroDe(area);
        const numero = String(lin * 5 + col + 1);
        bloco[numero] = (
          await db.block.create({ data: { localityId: localidade, number: numero, geometry: area as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng, areaM2: areaM2(area), source: 'EDITOR' } })
        ).id;
      }
    const aceId = (await db.user.findFirstOrThrow({ where: { name: { contains: 'Agente de Endemias' } } })).id;
    await t
      .http()
      .post('/api/endemias/zonas')
      .set(auth(supervisora))
      .send({ nome: 'Zona Geocodificação', aceId, quarteiroes: Object.values(bloco) })
      .expect(201);
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it('S7: o imóvel do ACE sem posição (GPS fora do quarteirão escolhido) fica no quarteirão, sem a posição do endereço de outro', async () => {
    // GPS 22 m ao sul do quarteirão 3: o imóvel entra no 3, sem posição.
    const g = ponto(200, -62);
    const r = await doAce('3', '777', { latitude: g[1], longitude: g[0], precisaoGps: 10 });
    expect(await imovel(r.id!)).toMatchObject({ blockId: bloco['3'], latitude: null, geoPrecision: null });
    // O mesmo endereço na base do IBGE cai dentro do quarteirão 8: antes, o imóvel ganhava a posição e ia para o 8.
    await endereco('777', ponto(200, 100));
    const geo = await geocodificar({ ids: [r.id] });
    expect(geo).toMatchObject({ analisados: 1, atualizados: 0, foraDoQuarteirao: 1, avisos: [`1 imóvel(is) ficaram como estavam: ${MOTIVO_FORA_DO_QUARTEIRAO}.`] });
    expect(await imovel(r.id!)).toMatchObject({ blockId: bloco['3'], latitude: null, longitude: null, geoPrecision: null });
    // Continua no pacote do agente.
    const p = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    expect(p.imoveis.find((i: { id: string }) => i.id === r.id)).toMatchObject({ quarteiraoId: bloco['3'] });
  });

  it('o ponto do endereço dentro do próprio quarteirão (ou na rua, a até 15 m dele) continua posicionando o imóvel', async () => {
    const dentro = await doAce('3', '778');
    const pDentro = ponto(210, 10);
    await endereco('778', pDentro);
    const naRua = await doAce('3', '779');
    // 8 m ao sul do quarteirão 3, na borda da grade: a malha liga o ponto ao 3.
    const pRua = ponto(230, -48);
    await endereco('779', pRua);
    const geo = await geocodificar({ ids: [dentro.id, naRua.id] });
    expect(geo).toMatchObject({ analisados: 2, atualizados: 2, foraDoQuarteirao: 0, avisos: [], porPrecisao: { ENDERECO: 2 } });
    for (const [id, p] of [
      [dentro.id!, pDentro],
      [naRua.id!, pRua],
    ] as const) {
      const h = await imovel(id);
      expect(h).toMatchObject({ blockId: bloco['3'], geoPrecision: 'ENDERECO', geoSource: 'cnefe:endereco' });
      expect(distanciaM([h.longitude!, h.latitude!], p)).toBeLessThan(0.5);
    }
  });

  it('sem ids (todos os pendentes): o imóvel com quarteirão não muda de quarteirão, nem o que tem só o centro dele; o sem quarteirão segue como sempre', async () => {
    // Imóvel do ACE sem endereço na base: recebe o centro do próprio quarteirão (como sempre).
    const centro = await doAce('3', '15', {}, 'Rua Sem Base Geo');
    // Imóvel da recepção, sem quarteirão: o endereço o posiciona e liga ao quarteirão do ponto (como sempre).
    const recep = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: RUA, number: '780', ibgeCode: ibge }).expect(201)).body.id as string;
    await endereco('780', ponto(190, 110));
    const s7 = await db.household.findFirstOrThrow({ where: { street: RUA, number: '777' } });
    const primeiro = await geocodificar({});
    expect(primeiro.foraDoQuarteirao).toBe(1);
    expect(primeiro.avisos).toEqual([`1 imóvel(is) ficaram como estavam: ${MOTIVO_FORA_DO_QUARTEIRAO}.`]);
    expect(await imovel(s7.id)).toMatchObject({ blockId: bloco['3'], latitude: null, geoPrecision: null });
    expect(await imovel(centro.id!)).toMatchObject({ blockId: bloco['3'], geoPrecision: 'QUARTEIRAO', geoSource: 'centro-do-quarteirao' });
    expect(await imovel(recep)).toMatchObject({ blockId: bloco['8'], geoPrecision: 'ENDERECO' });

    // O endereço do imóvel que tem só o centro do quarteirão aparece na base, dentro do 8: a posição melhor não o tira do 3.
    await endereco('15', ponto(210, 90), 'Rua Sem Base Geo');
    const segundo = await geocodificar({});
    expect(segundo.foraDoQuarteirao).toBe(2);
    expect(segundo.avisos).toEqual([`2 imóvel(is) ficaram como estavam: ${MOTIVO_FORA_DO_QUARTEIRAO}.`]);
    expect(await imovel(centro.id!)).toMatchObject({ blockId: bloco['3'], geoPrecision: 'QUARTEIRAO' });
    expect(await imovel(s7.id)).toMatchObject({ blockId: bloco['3'], latitude: null });
  });
  it('o imóvel do ACE num quarteirão desativado na malha fica como está, com o motivo certo no aviso', async () => {
    const r = await doAce('13', '901');
    // A malha nova tirou o quarteirão 13 (a zona do ACE o mantém até a supervisão tirá-lo).
    await db.block.update({ where: { id: bloco['13'] }, data: { active: false } });
    // O endereço na base do IBGE cai dentro do contorno do 13, que não está mais entre os ativos.
    await endereco('901', ponto(205, 205));
    const geo = await geocodificar({ ids: [r.id] });
    // Antes, contava como "o endereço cai fora do quarteirão", um motivo que não ajuda a resolver.
    expect(geo).toMatchObject({ analisados: 1, atualizados: 0, foraDoQuarteirao: 0, quarteiraoDesativado: 1, avisos: [`1 imóvel(is) ficaram como estavam: ${MOTIVO_QUARTEIRAO_DESATIVADO}.`] });
    expect(await imovel(r.id!)).toMatchObject({ blockId: bloco['13'], latitude: null, geoPrecision: null });
  });
  it('sem o número na base, o imóvel do quarteirão desativado também fica como está: a mediana da rua não o posiciona', async () => {
    const rua = 'Rua Desativada Geo';
    // Os números da rua que estão na base caem todos no quarteirão 18; o 902 não está lá.
    await endereco('1', ponto(190, 295), rua);
    await endereco('2', ponto(200, 300), rua);
    await endereco('3', ponto(210, 305), rua);
    // O ACE, sem rede, cadastrou o imóvel no 13, que a malha nova já tinha desativado.
    await db.block.update({ where: { id: bloco['13'] }, data: { active: false } });
    const r = await doAce('13', '902', {}, rua);
    const geo = await geocodificar({ ids: [r.id] });
    // Antes: ganhava a mediana da rua (no 18), contava como localizado e a tela não dizia nada do quarteirão desativado.
    expect(geo).toMatchObject({ analisados: 1, atualizados: 0, foraDoQuarteirao: 0, quarteiraoDesativado: 1, avisos: [`1 imóvel(is) ficaram como estavam: ${MOTIVO_QUARTEIRAO_DESATIVADO}.`] });
    expect(await imovel(r.id!)).toMatchObject({ blockId: bloco['13'], latitude: null, geoPrecision: null });
  });

  it('o quarteirão que veio da face de quadra segue o endereço exato da base nova, também na geocodificação de todos os pendentes', async () => {
    const rua = 'Rua X Geo';
    const id = await daRecepcao(rua, '20');
    // Face de quadra (CNEFE nível 4) na rua, a 8 m do quarteirão 9 e a 12 m do 4: o imóvel fica no 9.
    const face = await endereco('20', ponto(300, 52), rua, 4);
    expect(await geocodificar({ ids: [id] })).toMatchObject({ atualizados: 1, foraDoQuarteirao: 0, porPrecisao: { FACE: 1 } });
    expect(await imovel(id)).toMatchObject({ blockId: bloco['9'], geoPrecision: 'FACE', geoSource: 'cnefe:endereco' });
    // Com a mesma face de quadra, a rodada de todos os pendentes não muda o imóvel nem o conta à parte.
    const antes = await geocodificar({});
    expect(await imovel(id)).toMatchObject({ blockId: bloco['9'], geoPrecision: 'FACE' });

    // A base nova traz o ponto exato do endereço (nível 1), dentro do quarteirão 4.
    await db.addressPoint.delete({ where: { id: face.id } });
    const exato = ponto(300, 20);
    await endereco('20', exato, rua);
    const geo = await geocodificar({});
    // Antes: contava mais um "fora do quarteirão" (o 9, que veio da própria face de quadra), o imóvel continuava FACE no 9
    // e o aviso voltava em toda rodada.
    expect({ foraDoQuarteirao: geo.foraDoQuarteirao, quarteiraoDesativado: geo.quarteiraoDesativado }).toEqual({ foraDoQuarteirao: antes.foraDoQuarteirao, quarteiraoDesativado: antes.quarteiraoDesativado });
    const h = await imovel(id);
    expect(h).toMatchObject({ blockId: bloco['4'], geoPrecision: 'ENDERECO', geoSource: 'cnefe:endereco' });
    expect(distanciaM([h.longitude!, h.latitude!], exato)).toBeLessThan(0.5);
    // Na rodada seguinte o imóvel já não está entre os pendentes.
    expect((await geocodificar({})).foraDoQuarteirao).toBe(antes.foraDoQuarteirao);
    expect(await imovel(id)).toMatchObject({ blockId: bloco['4'], geoPrecision: 'ENDERECO' });
  });

  it('o quarteirão desativado que veio da face de quadra: o endereço exato da base nova liga o imóvel ao quarteirão ativo', async () => {
    const rua = 'Rua Y Geo';
    const id = await daRecepcao(rua, '40');
    // Face de quadra na rua, a 4 m do quarteirão 10 (e a 16 m do 15): o imóvel fica no 10.
    const face = await endereco('40', ponto(400, 144), rua, 4);
    await geocodificar({ ids: [id] });
    expect(await imovel(id)).toMatchObject({ blockId: bloco['10'], geoPrecision: 'FACE' });
    // A malha nova tirou o quarteirão 10.
    await db.block.update({ where: { id: bloco['10'] }, data: { active: false } });
    const antes = await geocodificar({});

    // A base nova traz o ponto exato do endereço, dentro do quarteirão 15 (ativo).
    await db.addressPoint.delete({ where: { id: face.id } });
    const exato = ponto(400, 175);
    await endereco('40', exato, rua);
    const geo = await geocodificar({});
    // Antes: contava mais um "quarteirão desativado" e o imóvel continuava FACE no 10, fora da malha.
    expect({ foraDoQuarteirao: geo.foraDoQuarteirao, quarteiraoDesativado: geo.quarteiraoDesativado }).toEqual({ foraDoQuarteirao: antes.foraDoQuarteirao, quarteiraoDesativado: antes.quarteiraoDesativado });
    const h = await imovel(id);
    expect(h).toMatchObject({ blockId: bloco['15'], geoPrecision: 'ENDERECO', geoSource: 'cnefe:endereco' });
    expect(distanciaM([h.longitude!, h.latitude!], exato)).toBeLessThan(0.5);
  });

  it('P8: o imóvel do ACE que a face de quadra confirmou no quarteirão escolhido fica nele quando a base nova traz o endereço exato em outro, e é contado', async () => {
    const rua = 'Rua P8 Geo';
    const r = await doAce('3', '40', {}, rua);
    expect(await imovel(r.id!)).toMatchObject({ blockId: bloco['3'], latitude: null });
    // Face de quadra na rua, a 8 m do 3 e a 12 m do 8: a malha liga o ponto ao 3, o escolhido; o imóvel ganha a posição.
    const face = await endereco('40', ponto(200, 48), rua, 4);
    expect(await geocodificar({ ids: [r.id] })).toMatchObject({ atualizados: 1, foraDoQuarteirao: 0, porPrecisao: { FACE: 1 } });
    expect(await imovel(r.id!)).toMatchObject({ blockId: bloco['3'], geoPrecision: 'FACE', geoSource: 'cnefe:endereco' });
    const antes = await geocodificar({});

    // A base nova traz o ponto exato do endereço, dentro do 8.
    await db.addressPoint.delete({ where: { id: face.id } });
    await endereco('40', ponto(200, 80), rua);
    const geo = await geocodificar({});
    // Antes: o imóvel passava em silêncio a ENDERECO no 8 (o quarteirão "veio da face de quadra") e saía do pacote do ACE.
    expect({ foraDoQuarteirao: geo.foraDoQuarteirao, quarteiraoDesativado: geo.quarteiraoDesativado }).toEqual({ foraDoQuarteirao: antes.foraDoQuarteirao + 1, quarteiraoDesativado: antes.quarteiraoDesativado });
    expect(geo.avisos[0]).toBe(`${geo.foraDoQuarteirao} imóvel(is) ficaram como estavam: ${MOTIVO_FORA_DO_QUARTEIRAO}.`);
    expect(await imovel(r.id!)).toMatchObject({ blockId: bloco['3'], geoPrecision: 'FACE' });
    // Pedida só para ele: o mesmo.
    expect(await geocodificar({ ids: [r.id] })).toMatchObject({ analisados: 1, atualizados: 0, foraDoQuarteirao: 1, avisos: [`1 imóvel(is) ficaram como estavam: ${MOTIVO_FORA_DO_QUARTEIRAO}.`] });
    expect(await imovel(r.id!)).toMatchObject({ blockId: bloco['3'], geoPrecision: 'FACE' });
    const p = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    expect(p.imoveis.find((i: { id: string }) => i.id === r.id)).toMatchObject({ quarteiraoId: bloco['3'] });

    // O imóvel da recepção na mesma situação segue o endereço exato, como na rodada anterior.
    const recep = await daRecepcao(rua, '42');
    const faceRecep = await endereco('42', ponto(210, 48), rua, 4);
    await geocodificar({ ids: [recep] });
    expect(await imovel(recep)).toMatchObject({ blockId: bloco['3'], geoPrecision: 'FACE' });
    await db.addressPoint.delete({ where: { id: faceRecep.id } });
    await endereco('42', ponto(210, 80), rua);
    expect(await geocodificar({ ids: [recep] })).toMatchObject({ atualizados: 1, foraDoQuarteirao: 0 });
    expect(await imovel(recep)).toMatchObject({ blockId: bloco['8'], geoPrecision: 'ENDERECO' });
  });

  it('a origem dos imóveis (criados pelo ACE) é lida uma vez por chamada, também quando imóveis da recepção mudam de quarteirão', async () => {
    const rua = 'Rua Leitura Unica Geo';
    const ids = [await daRecepcao(rua, '10'), await daRecepcao(rua, '12')];
    // Faces de quadra a 8 m do 3 e a 12 m do 8: os dois ficam no 3. A base nova traz os pontos exatos dentro do 8.
    const faces = [await endereco('10', ponto(180, 48), rua, 4), await endereco('12', ponto(220, 48), rua, 4)];
    await geocodificar({ ids });
    for (const id of ids) expect(await imovel(id)).toMatchObject({ blockId: bloco['3'], geoPrecision: 'FACE' });
    for (const f of faces) await db.addressPoint.delete({ where: { id: f.id } });
    await endereco('10', ponto(180, 80), rua);
    await endereco('12', ponto(220, 80), rua);
    const leitura = vi.spyOn(t.app.get(LocalizadorService), 'criadosPeloAce');
    try {
      expect(await geocodificar({ ids })).toMatchObject({ atualizados: 2, foraDoQuarteirao: 0 });
      // Antes: uma leitura da sincronização no começo e mais uma por imóvel que mudou de quarteirão (sem índice pelo
      // imóvel, cada uma percorre a tabela inteira).
      expect(leitura).toHaveBeenCalledTimes(1);
    } finally {
      leitura.mockRestore();
    }
    for (const id of ids) expect(await imovel(id)).toMatchObject({ blockId: bloco['8'], geoPrecision: 'ENDERECO' });
  });
});
