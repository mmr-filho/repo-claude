import { areaM2, caixaDe, centroDe, completeCpf, metrosPorGrau, normalizarArea, type Posicao } from '@omnisaude/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * Escopo de campo do ACE e da supervisão das endemias (seguranca#3, segunda rodada): a fila de pendências do território,
 * o mapa e o pacote do ACE filtram pelos quarteirões das zonas e das ordens ativas sem montar a lista no SQL (com mais
 * de 32.766 quarteirões, um IN com um parâmetro por quarteirão passa do limite do PostgreSQL e a consulta falhava).
 */
const enabled = await pgAvailable();

const O: Posicao = [-45.9, -14.4];

describe.runIf(enabled)('Território: escopo de campo do ACE e da supervisão com zonas enormes', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let tenantDb = '';
  let gestora = '';
  let supervisora = '';
  let ace = '';
  let aceId = '';
  let localidade = '';
  let zonaDoAce = '';
  let numero = 0;
  const q: Record<string, string> = {};
  const h: Record<string, string> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const ponto = (x: number, y: number): Posicao => {
    const m = metrosPorGrau(O[1]);
    return [O[0] + x / m.lng, O[1] + y / m.lat];
  };

  /** Quarteirão de 80 m com centro a (x, y) metros da origem. */
  async function quarteirao(chave: string, x: number, y: number) {
    const c = ponto(x, y);
    const m = metrosPorGrau(c[1]);
    const a: Posicao = [c[0] - 40 / m.lng, c[1] - 40 / m.lat];
    const b: Posicao = [c[0] + 40 / m.lng, c[1] + 40 / m.lat];
    const area = normalizarArea({ type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] });
    const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
    const [centerLng, centerLat] = centroDe(area);
    numero++;
    q[chave] = (
      await db.block.create({ data: { localityId: localidade, number: String(numero), geometry: area as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng, areaM2: areaM2(area), source: 'EDITOR' } })
    ).id;
  }

  /** Imóvel ligado ao quarteirão, sem posição (ou com o centro do quarteirão, precisão QUARTEIRAO). */
  async function imovel(chave: string, quarteiraoChave: string, district: string, street: string, extra: { ativo?: boolean; centro?: boolean } = {}) {
    const b = await db.block.findUniqueOrThrow({ where: { id: q[quarteiraoChave]! } });
    h[chave] = (
      await db.household.create({
        data: {
          street,
          number: chave,
          district,
          blockId: b.id,
          active: extra.ativo ?? true,
          ...(extra.centro ? { latitude: b.centerLat, longitude: b.centerLng, geoPrecision: 'QUARTEIRAO' as const, geoSource: 'centro-do-quarteirao', geoAt: new Date() } : {}),
        },
      })
    ).id;
  }

  async function ordem(status: 'ABERTA' | 'EM_CAMPO' | 'CONCLUIDA', quarteiraoChave: string, designados: string[], seq: number) {
    await db.blockingOrder.create({
      data: { year: 2093, seq, status, radiusM: 150, groups: ['dengue'], blocks: { create: [{ blockId: q[quarteiraoChave]!, distanceM: 0 }] }, assignees: { create: designados.map((userId) => ({ userId })) } },
    });
  }

  const pendencias = async (tk: string, situacao: string) => {
    const r = await t.http().get(`/api/territorio/imoveis?situacao=${situacao}`).set(auth(tk));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body as { id: string }[]).map((x) => x.id);
  };
  const ids = (...chaves: string[]) => chaves.map((c) => h[c]!);

  beforeAll(async () => {
    t = await startTestApp('terrescopo');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    const tenants = t.app.get(TenantsService);
    const info = await tenants.resolve(t.slug);
    tenantDb = info.db.name;
    db = await tenants.client(info.id);
    aceId = (await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000016') } })).id;
    localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '9', name: 'Escopo de Campo' }).expect(201)).body.id;
    // z1 e z2: zona do ACE; zs: zona sem titular; o1: ordem aberta designada ao ACE; o2: ordem em campo de outro agente;
    // oc: ordem concluída; livre: fora de zona e de ordem.
    for (const [chave, x] of [
      ['z1', 0],
      ['z2', 100],
      ['zs', 200],
      ['o1', 300],
      ['o2', 400],
      ['oc', 500],
      ['livre', 600],
    ] as const)
      await quarteirao(chave, x, 0);
    zonaDoAce = (
      await t
        .http()
        .post('/api/endemias/zonas')
        .set(auth(supervisora))
        .send({ nome: 'Zona do Agente', aceId, quarteiroes: [q.z1, q.z2] })
        .expect(201)
    ).body.id;
    await t
      .http()
      .post('/api/endemias/zonas')
      .set(auth(supervisora))
      .send({ nome: 'Zona Descoberta', quarteiroes: [q.zs] })
      .expect(201);
    const outro = (await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000017') } })).id;
    await ordem('ABERTA', 'o1', [aceId], 1);
    await ordem('EM_CAMPO', 'o2', [outro], 2);
    await ordem('CONCLUIDA', 'oc', [aceId], 3);
    // Sem posição (a fila SEM_POSICAO), em ordem de bairro e rua diferente da de criação.
    await imovel('hz1', 'z1', 'Bairro B', 'Rua 2');
    await imovel('hz2', 'z2', 'Bairro A', 'Rua 9');
    await imovel('hzs', 'zs', 'Bairro C', 'Rua 1');
    await imovel('ho1', 'o1', 'Bairro A', 'Rua 1');
    await imovel('ho2', 'o2', 'Bairro D', 'Rua 5');
    await imovel('hoc', 'oc', 'Bairro A', 'Rua 3');
    await imovel('hl', 'livre', 'Bairro A', 'Rua 4');
    await imovel('hin', 'z1', 'Bairro A', 'Rua 0', { ativo: false });
    // Com o centro do quarteirão (a fila BAIXA_PRECISAO).
    await imovel('hb', 'z2', 'Bairro E', 'Rua 7', { centro: true });
  }, 240_000);

  afterAll(async () => {
    await t?.close();
  });

  const esperado = {
    ace: { semPosicao: ['ho1', 'hz2', 'hz1'], baixa: ['hb'] },
    supervisora: { semPosicao: ['ho1', 'hz2', 'hz1', 'hzs', 'ho2'], baixa: ['hb'] },
  };

  it('a fila de pendências da supervisão e do ACE fica nas zonas e ordens ativas, em ordem de bairro e rua', async () => {
    expect(await pendencias(ace, 'SEM_POSICAO')).toEqual(ids(...esperado.ace.semPosicao));
    expect(await pendencias(supervisora, 'SEM_POSICAO')).toEqual(ids(...esperado.supervisora.semPosicao));
    expect(await pendencias(ace, 'BAIXA_PRECISAO')).toEqual(ids(...esperado.ace.baixa));
    expect(await pendencias(supervisora, 'BAIXA_PRECISAO')).toEqual(ids(...esperado.supervisora.baixa));
    // Sem quarteirão nunca está no escopo pelo quarteirão.
    expect(await pendencias(ace, 'SEM_QUARTEIRAO')).toEqual([]);
    // Quem edita o território vê todos (inclusive os de fora do campo).
    expect(await pendencias(gestora, 'SEM_POSICAO')).toEqual(expect.arrayContaining(ids('hz1', 'hz2', 'hzs', 'ho1', 'ho2', 'hoc', 'hl')));
    // O resultado tem as mesmas colunas da consulta pelo Prisma.
    const linha = (await t.http().get('/api/territorio/imoveis?situacao=BAIXA_PRECISAO').set(auth(ace)).expect(200)).body[0];
    expect(linha).toMatchObject({ id: h.hb, district: 'Bairro E', street: 'Rua 7', geoPrecision: 'QUARTEIRAO', blockId: q.z2, endereco: 'Rua 7, hb', precisaoLabel: 'Centro do quarteirão' });
  });

  it('com mais de 32.766 quarteirões na zona do ACE, a fila, o mapa e o pacote respondem, com o mesmo resultado', async () => {
    const c = new Client({ connectionString: TEST_PG.replace(/\/[^/]*$/, `/${tenantDb}`) });
    await c.connect();
    try {
      await c.query(
        `INSERT INTO blocks (id, locality_id, number, geometry, min_lng, min_lat, max_lng, max_lat, center_lat, center_lng, area_m2, source, active, updated_at)
         SELECT gen_random_uuid(), $1::uuid, 'X' || g, '{"type":"Polygon","coordinates":[[[-40,-20],[-39.9999,-20],[-39.9999,-19.9999],[-40,-19.9999],[-40,-20]]]}'::jsonb,
           -40, -20, -39.9999, -19.9999, -19.99995, -39.99995, 100, 'EDITOR', true, now()
         FROM generate_series(1, 33000) g`,
        [localidade],
      );
      await c.query(`INSERT INTO vector_zone_blocks (zone_id, block_id) SELECT $1::uuid, id FROM blocks WHERE number LIKE 'X%'`, [zonaDoAce]);
    } finally {
      await c.end();
    }
    expect(await db.vectorZoneBlock.count({ where: { zoneId: zonaDoAce } })).toBeGreaterThan(33_000);
    expect(await pendencias(supervisora, 'SEM_POSICAO')).toEqual(ids(...esperado.supervisora.semPosicao));
    expect(await pendencias(ace, 'SEM_POSICAO')).toEqual(ids(...esperado.ace.semPosicao));
    expect(await pendencias(ace, 'BAIXA_PRECISAO')).toEqual(ids(...esperado.ace.baixa));
    expect(await pendencias(supervisora, 'BAIXA_PRECISAO')).toEqual(ids(...esperado.supervisora.baixa));
    // O mapa marca a ação só nos imóveis da área de cada um.
    const p = ponto(100, 0);
    const caixa = `${p[0] - 0.0005},${p[1] - 0.0005},${p[0] + 0.0005},${p[1] + 0.0005}`;
    for (const quem of [ace, supervisora]) {
      const m = (await t.http().get(`/api/territorio/mapa?bbox=${caixa}`).set(auth(quem)).expect(200)).body as { imoveis: { id: string; campo: boolean }[] };
      expect(m.imoveis.find((i) => i.id === h.hb)?.campo).toBe(true);
    }
    const longe = ponto(600, 0);
    await db.household.update({ where: { id: h.hl! }, data: { latitude: longe[1], longitude: longe[0], geoPrecision: 'MAPA' } });
    const caixaLonge = `${longe[0] - 0.0005},${longe[1] - 0.0005},${longe[0] + 0.0005},${longe[1] + 0.0005}`;
    const fora = (await t.http().get(`/api/territorio/mapa?bbox=${caixaLonge}`).set(auth(supervisora)).expect(200)).body as { imoveis: { id: string; campo: boolean }[] };
    expect(fora.imoveis.find((i) => i.id === h.hl)?.campo).toBe(false);
    // O pacote do ACE (nomes e contagem de imóveis de cada quarteirão da zona).
    const pacote = await t.http().get('/api/endemias/campo/pacote').set(auth(ace));
    expect(pacote.status, JSON.stringify(pacote.body).slice(0, 300)).toBe(200);
  }, 180_000);
});
