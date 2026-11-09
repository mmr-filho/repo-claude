import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, distanciaM, metrosPorGrau, normalizarArea, type Posicao } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { HouseholdsService } from '../src/modules/patients/households.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * O GPS da visita do ACS segue a regra do ACE: o imóvel com quarteirão (o escolhido pelo ACE em campo) só recebe a
 * posição quando a malha liga o ponto a esse mesmo quarteirão; fora dele, a posição fica só na visita e o imóvel não
 * muda. O imóvel sem quarteirão segue como sempre (recebe a posição e é ligado ao quarteirão do ponto), e o cadastro do
 * domicílio com posição (ação explícita) continua religando.
 */
const enabled = await pgAvailable();

// Grade 3 x 3 de quarteirões de 80 m (ruas de 20 m, passo de 100 m): o quarteirão n fica na linha floor((n-1)/3) e na
// coluna (n-1)%3, com centro em (coluna × 100, linha × 100) metros a partir de O. O 5 é o do meio; o 6, o da direita.
const O: Posicao = [-49.27, -12.33];
const mpg = metrosPorGrau(O[1]);
const ponto = (x: number, y: number): Posicao => [O[0] + x / mpg.lng, O[1] + y / mpg.lat];
const quadrado = (centro: Posicao, lado = 80) => {
  const a: Posicao = [centro[0] - lado / 2 / mpg.lng, centro[1] - lado / 2 / mpg.lat];
  const b: Posicao = [centro[0] + lado / 2 / mpg.lng, centro[1] + lado / 2 / mpg.lat];
  return { type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] };
};

type Resultado = { clientId: string; status: string; id: string | null };

describe.runIf(enabled)('App do ACS: o GPS da visita não tira o imóvel do quarteirão escolhido pelo ACE', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let gestora = '';
  let ace = '';
  let recepcao = '';
  let acs = '';
  let teamId = '';
  const bloco: Record<string, string> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const imovel = (id: string) => db.household.findUniqueOrThrow({ where: { id } });

  /** Imóvel novo do ACE no quarteirão escolhido, sem GPS, que a recepção põe na equipe e microárea do ACS. */
  async function doAceNaMicroarea(numeroQuarteirao: string, numero: string) {
    const op = {
      clientId: randomUUID(),
      tipo: 'IMOVEL',
      registradoEm: new Date(Date.now() - 60_000).toISOString(),
      dados: { blockId: bloco[numeroQuarteirao], propertyType: '01', street: 'Rua do ACS Escolhido', number: numero },
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
    await t.http().patch(`/api/households/${r!.id}`).set(auth(recepcao)).send({ teamId, microArea: '01' }).expect(200);
    expect(await imovel(r!.id!)).toMatchObject({ blockId: bloco[numeroQuarteirao], latitude: null, geoPrecision: null, teamId, microArea: '01' });
    return r!.id!;
  }

  /** Visita do ACS ao imóvel com o GPS do aparelho; devolve o resultado da sincronização. */
  async function visitar(householdId: string, gps: Posicao) {
    const clientId = randomUUID();
    const r = (
      await t
        .http()
        .post('/api/acs/sync')
        .set(auth(acs))
        .send({
          operacoes: [{ tipo: 'VISITA', clientId, registradoEm: new Date(Date.now() - 60_000).toISOString(), householdId, visita: { motivos: ['1'], desfecho: '3', latitude: gps[1], longitude: gps[0], precisaoGps: 6 } }],
        })
        .expect(200)
    ).body.resultados as Resultado[];
    // Sem avisos novos no resultado da sincronização do ACS.
    expect(r).toEqual([{ clientId, tipo: 'VISITA', status: 'OK', id: expect.any(String), erro: null }]);
    // A posição do GPS fica sempre na visita.
    expect(await db.homeVisit.findUniqueOrThrow({ where: { id: r[0]!.id! } })).toMatchObject({ householdId, latitude: gps[1], longitude: gps[0] });
    return r[0]!;
  }

  beforeAll(async () => {
    t = await startTestApp('acsescolhido');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    acs = await t.login('acs', 'UBS Centro', 'ACS');
    const supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    // A equipe e a microárea do ACS da carga de demonstração.
    teamId = (await db.teamMember.findFirstOrThrow({ where: { active: true, microArea: '01', team: { unit: { name: 'UBS Centro' } } }, select: { teamId: true } })).teamId;
    const localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '47', name: 'ACS Quarteirão Escolhido' }).expect(201)).body.id;
    for (let lin = 0; lin < 3; lin++)
      for (let col = 0; col < 3; col++) {
        const area = normalizarArea(quadrado(ponto(col * 100, lin * 100)));
        const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
        const [centerLng, centerLat] = centroDe(area);
        const numero = String(lin * 3 + col + 1);
        bloco[numero] = (
          await db.block.create({ data: { localityId: localidade, number: numero, geometry: area as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng, areaM2: areaM2(area), source: 'EDITOR' } })
        ).id;
      }
    const aceId = (await db.user.findFirstOrThrow({ where: { name: { contains: 'Agente de Endemias' } } })).id;
    await t
      .http()
      .post('/api/endemias/zonas')
      .set(auth(supervisora))
      .send({ nome: 'Zona ACS Quarteirão Escolhido', aceId, quarteiroes: Object.values(bloco) })
      .expect(201);
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it('GPS da visita fora do quarteirão escolhido: o imóvel do ACE (sem posição ou com o centro do quarteirão) não muda; a posição fica só na visita', async () => {
    const semPosicao = await doAceNaMicroarea('5', '11');
    const comCentro = await doAceNaMicroarea('5', '12');
    // Sem endereço na base do IBGE, a geocodificação dá ao imóvel o centro do quarteirão escolhido.
    await t
      .http()
      .post('/api/territorio/imoveis/geocodificar')
      .set(auth(gestora))
      .send({ ids: [comCentro] })
      .expect(200);
    expect(await imovel(comCentro)).toMatchObject({ blockId: bloco['5'], geoPrecision: 'QUARTEIRAO' });

    // GPS dentro do quarteirão 6. Antes: o imóvel ganhava a posição (GPS em campo) e saía do quarteirão escolhido pelo ACE.
    const no6 = ponto(200, 110);
    await visitar(semPosicao, no6);
    expect(await imovel(semPosicao)).toMatchObject({ blockId: bloco['5'], latitude: null, longitude: null, geoPrecision: null });
    await visitar(comCentro, no6);
    expect(await imovel(comCentro)).toMatchObject({ blockId: bloco['5'], geoPrecision: 'QUARTEIRAO', geoSource: 'centro-do-quarteirao' });
    // Na rua, a 6 m do 6 e a 14 m do 5: a malha liga o ponto ao 6, e o imóvel também não muda.
    await visitar(semPosicao, ponto(154, 100));
    expect(await imovel(semPosicao)).toMatchObject({ blockId: bloco['5'], latitude: null, geoPrecision: null });
  });

  it('GPS da visita dentro do quarteirão escolhido: posiciona o imóvel, que continua nele', async () => {
    const semPosicao = await doAceNaMicroarea('5', '21');
    const dentro = ponto(110, 95);
    await visitar(semPosicao, dentro);
    const h = await imovel(semPosicao);
    expect(h).toMatchObject({ blockId: bloco['5'], geoPrecision: 'GPS_CAMPO', geoSource: 'visita', geoAccuracyM: 6 });
    expect(distanciaM([h.longitude!, h.latitude!], dentro)).toBeLessThan(0.5);

    // O centro do quarteirão também é trocado pelo GPS de dentro dele (posição melhor), sem mudar o quarteirão.
    const comCentro = await doAceNaMicroarea('5', '22');
    await t
      .http()
      .post('/api/territorio/imoveis/geocodificar')
      .set(auth(gestora))
      .send({ ids: [comCentro] })
      .expect(200);
    // Na rua, a 6 m do 5 e a 14 m do 6: a malha liga o ponto ao 5.
    const naRua = ponto(146, 100);
    await visitar(comCentro, naRua);
    const c = await imovel(comCentro);
    expect(c).toMatchObject({ blockId: bloco['5'], geoPrecision: 'GPS_CAMPO', geoSource: 'visita' });
    expect(distanciaM([c.longitude!, c.latitude!], naRua)).toBeLessThan(0.5);
  });

  it('imóvel sem quarteirão: o GPS da visita posiciona e liga ao quarteirão do ponto, como sempre', async () => {
    const id = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: 'Rua Sem Quarteirao ACS', number: '31', teamId, microArea: '01' }).expect(201)).body.id as string;
    expect(await imovel(id)).toMatchObject({ blockId: null, latitude: null });
    const no6 = ponto(205, 100);
    await visitar(id, no6);
    const h = await imovel(id);
    expect(h).toMatchObject({ blockId: bloco['6'], geoPrecision: 'GPS_CAMPO', geoSource: 'visita' });
    expect(distanciaM([h.longitude!, h.latitude!], no6)).toBeLessThan(0.5);
  });

  it('o cadastro do domicílio com posição (ação explícita do ACS) continua religando o imóvel do ACE', async () => {
    const id = await doAceNaMicroarea('5', '41');
    const no6 = ponto(200, 90);
    const r = (
      await t
        .http()
        .post('/api/acs/sync')
        .set(auth(acs))
        .send({
          operacoes: [
            {
              tipo: 'DOMICILIO',
              clientId: randomUUID(),
              registradoEm: new Date(Date.now() - 60_000).toISOString(),
              householdId: id,
              dados: { street: 'Rua do ACS Escolhido', number: '41', latitude: no6[1], longitude: no6[0] },
            },
          ],
        })
        .expect(200)
    ).body.resultados as Resultado[];
    expect(r[0], JSON.stringify(r[0])).toMatchObject({ status: 'OK' });
    expect(await imovel(id)).toMatchObject({ blockId: bloco['6'], geoPrecision: 'GPS_CAMPO', geoSource: 'cadastro' });
  });

  it('quarteirão escolhido desativado na malha: o GPS da visita (dentro do contorno antigo ou num quarteirão ativo) não posiciona nem religa', async () => {
    const id = await doAceNaMicroarea('8', '51');
    // A malha nova tirou o 8 (a zona do ACE o mantém até a supervisão tirá-lo): nenhum ponto cai nele.
    await db.block.update({ where: { id: bloco['8'] }, data: { active: false } });
    // No meio do contorno antigo, a 60 m dos vizinhos. Antes: o imóvel ganhava a posição e ficava sem quarteirão.
    await visitar(id, ponto(100, 200));
    expect(await imovel(id)).toMatchObject({ blockId: bloco['8'], latitude: null, geoPrecision: null });
    await visitar(id, ponto(200, 200));
    expect(await imovel(id)).toMatchObject({ blockId: bloco['8'], latitude: null, geoPrecision: null });
  });

  it('o quarteirão do imóvel muda entre a leitura e a gravação da visita: o GPS fica só na visita', async () => {
    const id = await doAceNaMicroarea('5', '52');
    // Outra ação (o ACE, o mapa) liga o imóvel ao 4 logo depois de a visita conferir o ponto contra o 5.
    const households = t.app.get(HouseholdsService);
    const real = households.quarteiraoDoPonto.bind(households);
    const espiao = vi.spyOn(households, 'quarteiraoDoPonto').mockImplementation(async (d, lat, lng) => {
      const r = await real(d, lat, lng);
      await db.$executeRaw`UPDATE households SET block_id = ${bloco['4']}::uuid WHERE id = ${id}::uuid`;
      return r;
    });
    try {
      await visitar(id, ponto(100, 100));
    } finally {
      espiao.mockRestore();
    }
    // Sem a condição do quarteirão na gravação, o imóvel ficava no 4 com a posição de dentro do 5.
    expect(await imovel(id)).toMatchObject({ blockId: bloco['4'], latitude: null, geoPrecision: null });
  });
});
