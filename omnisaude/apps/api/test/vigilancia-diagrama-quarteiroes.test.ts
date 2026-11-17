import { demoFixtures } from '@omnisaude/database';
import { semanaDaData, type RespostaSugestoesSurto } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { LocalizadorService } from '../src/modules/territorio/localizador.service';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { ConsolidadoService } from '../src/modules/vigilancia/consolidado.service';
import { SurtoService } from '../src/modules/vigilancia/surto.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Quarteirão da residência em lote (DIAGRAMA-5 e SURTO-6): a base consolidada por território e as sugestões de surto
 * localizam na malha todas as notificações com posição e sem quarteirão com um número fixo de consultas, e não uma por
 * notificação. Para cada ponto, o lote dá o mesmo quarteirão que a consulta de um ponto, inclusive na divisa de dois
 * quarteirões, na rua (o mais próximo até 15 m) e longe da malha. Território e notificações sintéticos, em 2016 (longe
 * dos dados da demonstração).
 */
const enabled = await pgAvailable();

/** Cliente que conta as consultas ao banco: cada chamada de modelo (findMany, count...) e cada consulta crua. */
function contarConsultas<T extends object>(db: T, aoConsultar: () => void): T {
  const contada =
    (f: (...a: unknown[]) => unknown, alvo: unknown) =>
    (...a: unknown[]) => {
      aoConsultar();
      return f.apply(alvo, a);
    };
  return new Proxy(db, {
    get(alvo, prop, receptor) {
      const v = Reflect.get(alvo, prop, receptor) as unknown;
      if (typeof prop !== 'string') return v;
      if (['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'].includes(prop)) return contada(v as (...a: unknown[]) => unknown, alvo);
      if (!prop.startsWith('$') && !prop.startsWith('_') && v && typeof v === 'object')
        return new Proxy(v, {
          get(m, op, r) {
            const f = Reflect.get(m, op, r) as unknown;
            return typeof f === 'function' ? contada(f as (...a: unknown[]) => unknown, m) : f;
          },
        });
      return v;
    },
  });
}

/** Quadrado [x0, y0, x1, y1] como polígono GeoJSON. */
const quadrado = ([x0, y0, x1, y1]: number[]) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [x0!, y0!],
      [x1!, y0!],
      [x1!, y1!],
      [x0!, y1!],
      [x0!, y0!],
    ],
  ],
});

describe.runIf(enabled)('Território: quarteirão da residência em lote (DIAGRAMA-5, SURTO-6)', () => {
  let t: TestApp;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let tenant: Awaited<ReturnType<TenantsService['resolve']>>;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const ids = { paciente: '', unidade: '', notificador: '', bairroA: '', bairroB: '', localidade: '' };
  const cond: Record<'dengue' | 'leptospirose', { id: string; key: string }> = { dengue: { id: '', key: '' }, leptospirose: { id: '', key: '' } };
  /** Quarteirões da grade: [coluna][linha] com a caixa [x0, y0, x1, y1]. Lado de 0,0009° (~100 m), rua de 0,0002° (~22 m). */
  const X0 = -51;
  const Y0 = -11;
  const PASSO = 0.0011;
  const LADO = 0.0009;
  const caixa = (i: number, j: number) => [X0 + i * PASSO, Y0 + j * PASSO, X0 + i * PASSO + LADO, Y0 + j * PASSO + LADO];
  const centro = (i: number, j: number) => ({ lng: X0 + i * PASSO + LADO / 2, lat: Y0 + j * PASSO + LADO / 2 });
  const quarteirao = new Map<string, string>();
  let nNot = 0;

  /** Notificação do OmniSaúde NOTIFICADA conhecida no dia, com a posição da ficha (GPS) ou o bairro escrito na ficha. */
  const notificacao = async (o: { grupo: 'dengue' | 'leptospirose'; dia: string; posicao?: { lat: number; lng: number }; bairroFicha?: unknown }) => {
    nNot++;
    const ano = Number(o.dia.slice(0, 4));
    const c = cond[o.grupo];
    const semana = semanaDaData(o.dia).codigo;
    await db.notification.create({
      data: {
        year: ano,
        seq: 950_000 + nNot,
        number: `${ano}/${950_000 + nNot}`,
        status: 'NOTIFICADA',
        origin: 'MANUAL',
        conditionId: c.id,
        conditionKey: c.key,
        groupKey: o.grupo,
        patientId: ids.paciente,
        unitId: ids.unidade,
        notifierId: ids.notificador,
        notifierRole: 'VIGILANCIA_EPIDEMIOLOGICA',
        knownAt: new Date(`${o.dia}T15:00:00Z`),
        deadlineStart: 'CONHECIMENTO',
        deadlineKind: 'SEMANAL',
        targets: ['SMS'],
        symptomsOnset: new Date(`${o.dia}T00:00:00Z`),
        epiWeekOnset: semana,
        epiWeekNotified: semana,
        residenceLat: o.posicao?.lat ?? null,
        residenceLng: o.posicao?.lng ?? null,
        residencePrecision: o.posicao ? 'GPS_CAMPO' : null,
        form: { NM_BAIRRO: o.bairroFicha ?? null } as object,
      },
    });
  };

  beforeAll(async () => {
    t = await startTestApp('vigdiaquart');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    await t.app.get(CatalogoVigilanciaService).garantir({ tenant, db });
    ids.paciente = (await db.patient.findFirstOrThrow({ where: { mergedIntoId: null }, select: { id: true } })).id;
    ids.unidade = (await db.unit.findFirstOrThrow({ where: { name: 'UBS Centro' }, select: { id: true } })).id;
    ids.notificador = (await db.user.findFirstOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf }, select: { id: true } })).id;
    for (const g of ['dengue', 'leptospirose'] as const) cond[g] = await db.notifiableCondition.findFirstOrThrow({ where: { groupKey: g, context: 'CASO' }, select: { id: true, key: true } });

    // Grade de 3 × 3 quarteirões (colunas 0 e 1 no bairro A, coluna 2 no bairro B), dois quarteirões lado a lado com a
    // divisa em comum (C e D) e um quarteirão dentro de outro (F dentro de E), para o empate.
    const loc = await db.locality.create({ data: { code: '99000427', name: 'Distrito Quarteirões R3', category: 'DISTRITO', zone: 'URBANA', source: 'MANUAL' } });
    const a = await db.neighborhood.create({ data: { localityId: loc.id, name: 'Bairro Quarteirões A', aliases: [] } });
    const b = await db.neighborhood.create({ data: { localityId: loc.id, name: 'Bairro Quarteirões B', aliases: [] } });
    Object.assign(ids, { localidade: loc.id, bairroA: a.id, bairroB: b.id });
    const criar = async (numero: string, [x0, y0, x1, y1]: number[], bairro: string) => {
      const q = await db.block.create({
        data: {
          localityId: loc.id,
          neighborhoodId: bairro,
          number: numero,
          geometry: quadrado([x0!, y0!, x1!, y1!]),
          minLng: x0!,
          minLat: y0!,
          maxLng: x1!,
          maxLat: y1!,
          centerLat: (y0! + y1!) / 2,
          centerLng: (x0! + x1!) / 2,
          areaM2: 10_000,
        },
      });
      quarteirao.set(numero, q.id);
    };
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) await criar(`Q${i}${j}`, caixa(i, j), i < 2 ? a.id : b.id);
    const xc = X0 + 5 * PASSO;
    await criar('C', [xc, Y0, xc + LADO, Y0 + LADO], a.id);
    await criar('D', [xc + LADO, Y0, xc + 2 * LADO, Y0 + LADO], b.id);
    const xe = X0 + 8 * PASSO;
    await criar('E', [xe, Y0, xe + LADO, Y0 + LADO], a.id);
    await criar('F', [xe + LADO / 4, Y0 + LADO / 4, xe + LADO / 2, Y0 + LADO / 2], b.id);
  });

  afterAll(async () => {
    await t?.close();
  });

  it('para cada ponto, o lote dá o mesmo quarteirão que a consulta de um ponto (dentro, rua, divisa, empate e longe)', async () => {
    const loc = t.app.get(LocalizadorService);
    const xc = X0 + 5 * PASSO;
    const xe = X0 + 8 * PASSO;
    const pontos = [
      centro(0, 0),
      // Dentro do Q11, perto do canto.
      { lng: X0 + PASSO + 0.00001, lat: Y0 + PASSO + 0.00001 },
      // Na rua entre o Q00 e o Q10: ~5,5 m do Q00 e ~16 m do Q10.
      { lng: X0 + LADO + 0.00005, lat: Y0 + LADO / 2 },
      // Na rua entre o Q00 e o Q10: ~4,4 m do Q10.
      { lng: X0 + PASSO - 0.00004, lat: Y0 + LADO / 3 },
      // Na rua, longe de tudo além de 15 m: nenhum.
      { lng: X0 + 3 * PASSO + 0.0003, lat: Y0 + LADO / 2 },
      // Sobre a divisa do C com o D (a borda conta como dentro dos dois): empate.
      { lng: xc + LADO, lat: Y0 + LADO / 2 },
      // Dentro do F, que fica dentro do E: empate.
      { lng: xe + LADO / 3, lat: Y0 + LADO / 3 },
      // O mesmo ponto duas vezes e um longe da malha.
      centro(0, 0),
      centro(2, 2),
      { lng: -40, lat: -5 },
    ];
    const umAUm = [];
    for (const p of pontos) umAUm.push(await loc.quarteiraoDoPonto(db, p.lat, p.lng));
    const espiao = vi.spyOn(loc, 'quarteiraoDoPonto');
    try {
      const lote = await loc.quarteiroesDosPontos(db, pontos);
      expect(lote).toEqual(umAUm);
      // Só os dois empates (divisa e quarteirão dentro de outro) vão para a consulta de um ponto.
      expect(espiao).toHaveBeenCalledTimes(2);
    } finally {
      espiao.mockRestore();
    }
    expect(umAUm.map((q) => q?.number ?? null)).toEqual(['Q00', 'Q11', 'Q00', 'Q10', null, umAUm[5]!.number, umAUm[6]!.number, 'Q00', 'Q22', null]);
    expect(['C', 'D']).toContain(umAUm[5]!.number);
    expect(['E', 'F']).toContain(umAUm[6]!.number);
    expect(await loc.quarteiroesDosPontos(db, [])).toEqual([]);
  });

  it('base consolidada por bairro: N notificações com posição viram um número fixo de consultas (DIAGRAMA-5)', async () => {
    const consolidado = t.app.get(ConsolidadoService);
    let consultas = 0;
    const carregar = async () => {
      consultas = 0;
      const base = await consolidado.carregar({ tenant, db: contarConsultas(db, () => consultas++) }, 'dengue', [2016], true);
      return { base, consultas };
    };
    // Duas notificações com posição, uma só com o bairro escrito na ficha e uma com o bairro da ficha que não é texto.
    await notificacao({ grupo: 'dengue', dia: '2016-03-07', posicao: centro(0, 0) });
    await notificacao({ grupo: 'dengue', dia: '2016-03-08', posicao: centro(2, 1) });
    await notificacao({ grupo: 'dengue', dia: '2016-03-09', bairroFicha: 'Bairro Quarteirões B' });
    await notificacao({ grupo: 'dengue', dia: '2016-03-10', bairroFicha: 1234 });
    const poucas = await carregar();
    const linhas = poucas.base.linhas.filter((l) => l.origem === 'OMNISAUDE');
    expect(linhas.map((l) => l.bairroId).sort()).toEqual([ids.bairroA, ids.bairroB, ids.bairroB, null].sort());
    // Mais 40 notificações com posição em toda a grade (antes: uma consulta de quarteirão por notificação).
    for (let k = 0; k < 40; k++) await notificacao({ grupo: 'dengue', dia: '2016-03-11', posicao: centro(k % 3, Math.floor(k / 3) % 3) });
    const muitas = await carregar();
    expect(muitas.base.linhas.filter((l) => l.origem === 'OMNISAUDE')).toHaveLength(44);
    expect(muitas.base.linhas.filter((l) => l.origem === 'OMNISAUDE' && l.bairroId === ids.bairroB)).toHaveLength(1 + 1 + 13);
    expect(muitas.consultas).toBe(poucas.consultas);
  });

  it('sugestões de surto: N notificações com posição viram um número fixo de consultas (SURTO-6)', async () => {
    const tenants = t.app.get(TenantsService);
    const original = tenants.client.bind(tenants);
    let consultas = 0;
    let contando = false;
    tenants.client = (async (id: string) => {
      const c = await original(id);
      return contando ? contarConsultas(c, () => consultas++) : c;
    }) as typeof tenants.client;
    t.app.get(SurtoService).agora = () => new Date('2016-08-17T15:00:00Z');
    const sugestoes = async () => {
      consultas = 0;
      contando = true;
      try {
        const r = (await t.http().get('/api/vigilancia/surtos/sugestoes').set(auth(vig)).expect(200)).body as RespostaSugestoesSurto;
        return { r, consultas };
      } finally {
        contando = false;
      }
    };
    try {
      // Leptospirose (as regras de vizinhança valem para ela): dois casos no Q01 em 7 dias.
      await notificacao({ grupo: 'leptospirose', dia: '2016-08-10', posicao: centro(0, 1) });
      await notificacao({ grupo: 'leptospirose', dia: '2016-08-11', posicao: centro(0, 1) });
      const poucas = await sugestoes();
      expect(poucas.r.sugestoes.find((s) => s.regra === 'quarteirao-7d')).toMatchObject({ vinculoNome: 'Quarteirão Q01 (Distrito Quarteirões R3)' });
      for (let k = 0; k < 30; k++) await notificacao({ grupo: 'leptospirose', dia: '2016-08-12', posicao: centro(k % 3, 2) });
      const muitas = await sugestoes();
      expect(
        muitas.r.sugestoes
          .filter((s) => s.regra === 'quarteirao-7d')
          .map((s) => s.vinculoNome)
          .sort(),
      ).toEqual(['Quarteirão Q01 (Distrito Quarteirões R3)', 'Quarteirão Q02 (Distrito Quarteirões R3)', 'Quarteirão Q12 (Distrito Quarteirões R3)', 'Quarteirão Q22 (Distrito Quarteirões R3)']);
      // Antes: uma consulta de quarteirão por notificação (mais 30 aqui).
      expect(muitas.consultas).toBe(poucas.consultas);
    } finally {
      tenants.client = original;
    }
  });
});
