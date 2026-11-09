import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, metrosPorGrau, normalizarArea, type Posicao } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Listas que passam do limite de parâmetros do PostgreSQL (32.767 por consulta): o pacote do ACE com mais de 32.766
 * imóveis na área, e as zonas e os quarteirões livres com mais de 32.766 quarteirões em zonas. As linhas em massa são
 * inseridas por SQL (generate_series), para o teste ser rápido.
 */
const enabled = await pgAvailable();

const MUITOS = 33_000;
const O: Posicao = [-48.21, -10.18];
const mpg = metrosPorGrau(O[1]);
const ponto = (x: number, y: number): Posicao => [O[0] + x / mpg.lng, O[1] + y / mpg.lat];
const quadrado = (centro: Posicao, lado = 80) => {
  const a: Posicao = [centro[0] - lado / 2 / mpg.lng, centro[1] - lado / 2 / mpg.lat];
  const b: Posicao = [centro[0] + lado / 2 / mpg.lng, centro[1] + lado / 2 / mpg.lat];
  return { type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] };
};
/** Segundos atrás: as visitas ficam no ciclo bimestral de agora. */
const segundosAtras = (s: number) => new Date(Date.now() - s * 1000).toISOString();

type Imovel = { id: string; noCiclo: { situacao: string; em: string } | null };

describe.runIf(enabled)('VIG-3a: pacote do ACE e zonas com listas acima do limite de parâmetros do banco', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let ace = '';
  let supervisora = '';
  let gestora = '';
  let aceId = '';
  let localidade = '';
  const q: Record<string, string> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const sync = async (operacoes: unknown[]) => (await t.http().post('/api/endemias/campo/sync').set(auth(ace)).send({ operacoes }).expect(200)).body.resultados as { status: string; erro: string | null }[];
  const visita = (householdId: string, segundos: number, v: Record<string, unknown>) => ({
    clientId: randomUUID(),
    tipo: 'VISITA_VETORIAL',
    registradoEm: segundosAtras(segundos),
    householdId,
    visita: { atividade: 'LI_T', situacao: 'TRABALHADO', depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } }, ...v },
  });

  async function quarteirao(numero: string, centro: Posicao, ativo = true) {
    const area = normalizarArea(quadrado(centro));
    const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
    const [centerLng, centerLat] = centroDe(area);
    return (
      await db.block.create({
        data: { localityId: localidade, number: numero, geometry: area as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng, areaM2: areaM2(area), source: 'EDITOR', active: ativo },
      })
    ).id;
  }

  beforeAll(async () => {
    t = await startTestApp('campogrande');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    aceId = (await db.user.findFirstOrThrow({ where: { name: { contains: 'Agente de Endemias' } } })).id;
    const vigUnit = (await db.unit.findFirstOrThrow({ where: { name: 'Vigilância em Saúde' } })).id;
    localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '31', name: 'Listas Grandes' }).expect(201)).body.id;
    q['1'] = await quarteirao('1', ponto(0, 0));
    q['2'] = await quarteirao('2', ponto(100, 0));
    q['3'] = await quarteirao('3', ponto(200, 0));
    q.livre = await quarteirao('4', ponto(300, 0));
    q.inativo = await quarteirao('5', ponto(400, 0), false);
    await t
      .http()
      .post('/api/endemias/zonas')
      .set(auth(supervisora))
      .send({ nome: 'Zona do Agente', aceId, quarteiroes: [q['1'], q['2'], q['3']] })
      .expect(201);
    // Zona com mais de 32.766 quarteirões (longe da grade do agente) e um imóvel em cada um dos 10 primeiros.
    await db.$executeRaw`
      INSERT INTO blocks (id, locality_id, number, geometry, min_lng, min_lat, max_lng, max_lat, center_lat, center_lng, area_m2, source, active, updated_at)
      SELECT gen_random_uuid(), ${localidade}::uuid, 'G' || g, jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array(jsonb_build_array(
          jsonb_build_array(x, y), jsonb_build_array(x + 0.0007, y), jsonb_build_array(x + 0.0007, y + 0.0007), jsonb_build_array(x, y + 0.0007), jsonb_build_array(x, y)))),
        x, y, x + 0.0007, y + 0.0007, y + 0.00035, x + 0.00035, 6000, 'EDITOR', true, now()
      FROM generate_series(1, ${MUITOS}::int) g, LATERAL (SELECT -47.0 + (g % 200) * 0.001 AS x, -9.0 + (g / 200) * 0.001 AS y) p`;
    const [zona] = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO vector_zones (id, unit_id, name, active, updated_at) VALUES (gen_random_uuid(), ${vigUnit}::uuid, 'Zona Grande', true, now()) RETURNING id`;
    await db.$executeRaw`INSERT INTO vector_zone_blocks (zone_id, block_id) SELECT ${zona!.id}::uuid, id FROM blocks WHERE locality_id = ${localidade}::uuid AND number LIKE 'G%'`;
    await db.$executeRaw`
      INSERT INTO households (id, street, number, block_id, property_type, active, updated_at)
      SELECT gen_random_uuid(), 'Rua da Zona Grande', g::text, b.id, '01', true, now()
      FROM (SELECT id, row_number() OVER (ORDER BY number) AS g FROM blocks WHERE locality_id = ${localidade}::uuid AND number LIKE 'G%') b WHERE b.g <= 10`;
    // Mais de 32.766 imóveis no quarteirão 1 da zona do agente.
    await db.$executeRaw`
      INSERT INTO households (id, street, number, block_id, property_type, active, updated_at)
      SELECT gen_random_uuid(), 'Rua Gerada', g::text, ${q['1']}::uuid, '01', true, now() FROM generate_series(1, ${MUITOS}::int) g`;
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it(`pacote com mais de 32.766 imóveis na área: responde, com a última visita do ciclo e as visitas da ordem`, async () => {
    const [x, y, z] = await db.household.findMany({ where: { blockId: q['1'] }, select: { id: true }, orderBy: { number: 'asc' }, take: 3 });
    // Aberta antes das visitas: aberta agora, logo depois da meia-noite a visita de 20 s atrás cairia na véspera da
    // abertura e ficaria fora da ordem.
    const aberta = new Date(segundosAtras(60));
    const ordem = await db.blockingOrder.create({
      data: { year: 2026, seq: 7001, status: 'ABERTA', radiusM: 150, groups: ['dengue'], openedAt: aberta, blocks: { create: [{ blockId: q['1']!, distanceM: 0 }] }, assignees: { create: [{ userId: aceId }] } },
    });
    const rs = await sync([
      // x: fechado e, depois, trabalhado (a última do ciclo é a que vale).
      visita(x!.id, 40, { situacao: 'FECHADO', depositos: undefined }),
      visita(x!.id, 30, {}),
      // y: trabalhado no bloqueio (entra na ordem e no ciclo).
      visita(y!.id, 20, { atividade: 'BLOQUEIO', ordemId: ordem.id, acaoEducativa: true }),
      // z: só fechado.
      visita(z!.id, 10, { situacao: 'FECHADO', depositos: undefined }),
    ]);
    for (const r of rs) expect(r, JSON.stringify(r)).toMatchObject({ status: 'OK' });
    const r = await t.http().get('/api/endemias/campo/pacote').set(auth(ace));
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const p = r.body as { ciclo: { chave: string }; imoveis: Imovel[]; ordens: { id: string; visitados: Record<string, { situacao: string; em: string }> }[] };
    expect(p.imoveis.length).toBe(MUITOS);
    const doPacote = new Map(p.imoveis.map((i) => [i.id, i]));
    const em = async (householdId: string, situation: 'TRABALHADO' | 'FECHADO') => (await db.vectorVisit.findFirstOrThrow({ where: { householdId, situation }, orderBy: { visitedAt: 'desc' } })).visitedAt.toISOString();
    expect(doPacote.get(x!.id)!.noCiclo).toEqual({ situacao: 'TRABALHADO', em: await em(x!.id, 'TRABALHADO') });
    expect(doPacote.get(y!.id)!.noCiclo).toEqual({ situacao: 'TRABALHADO', em: await em(y!.id, 'TRABALHADO') });
    expect(doPacote.get(z!.id)!.noCiclo).toEqual({ situacao: 'FECHADO', em: await em(z!.id, 'FECHADO') });
    expect(p.imoveis.filter((i) => i.noCiclo).length).toBe(3);
    const daOrdem = p.ordens.find((o) => o.id === ordem.id)!;
    expect(daOrdem.visitados).toEqual({ [y!.id]: { situacao: 'TRABALHADO', em: await em(y!.id, 'TRABALHADO') } });
  });

  it('zonas e quarteirões livres com mais de 32.766 quarteirões em zonas: respondem, com o progresso do ciclo', async () => {
    const r = await t.http().get('/api/endemias/zonas').set(auth(supervisora));
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const zonas = r.body.zonas as { nome: string; quarteiroes: { id: string }[]; progressoCiclo: Record<string, number | null> }[];
    const grande = zonas.find((z) => z.nome === 'Zona Grande')!;
    expect(grande.quarteiroes).toHaveLength(MUITOS);
    expect(grande.progressoCiclo).toMatchObject({ imoveis: 10, trabalhados: 0, pendentes: 0, semVisita: 10 });
    const doAgente = zonas.find((z) => z.nome === 'Zona do Agente')!;
    expect(doAgente.quarteiroes.map((b) => b.id).sort()).toEqual([q['1'], q['2'], q['3']].sort());
    // x e y trabalhados (a última visita de cada um no ciclo), z fechado.
    expect(doAgente.progressoCiclo).toMatchObject({ imoveis: MUITOS, trabalhados: 2, pendentes: 1, semVisita: MUITOS - 3 });

    const livres = await t.http().get('/api/endemias/zonas/quarteiroes-livres').set(auth(supervisora));
    expect(livres.status, JSON.stringify(livres.body).slice(0, 300)).toBe(200);
    expect(livres.body.map((b: { id: string }) => b.id)).toEqual([q.livre]);
  });

  it('pacote com mais de 32.766 quarteirões na área (as outras listas do pacote): responde com todos', async () => {
    await db.$executeRaw`UPDATE vector_zones SET ace_id = ${aceId}::uuid WHERE name = 'Zona Grande'`;
    try {
      const r = await t.http().get('/api/endemias/campo/pacote').set(auth(ace));
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
      expect(r.body.quarteiroes).toHaveLength(MUITOS + 3);
      expect(r.body.imoveis).toHaveLength(MUITOS + 10);
      expect(r.body.imoveis.filter((i: Imovel) => i.noCiclo)).toHaveLength(3);
    } finally {
      await db.$executeRaw`UPDATE vector_zones SET ace_id = NULL WHERE name = 'Zona Grande'`;
    }
  });
});
