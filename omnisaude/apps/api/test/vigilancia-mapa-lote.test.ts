import { demoFixtures } from '@omnisaude/database';
import { areaM2, semanaDaData, type Area, type PrecisaoGeo } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { LocalizadorService, PRECISAO_LIGA_QUARTEIRAO } from '../src/modules/territorio/localizador.service';
import { derivados } from '../src/modules/territorio/territorio.service';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Mapa de casos com o quarteirão da ficha em lote (N9, quarta rodada): GET /vigilancia/mapa localiza na malha todas as
 * posições da ficha sem quarteirão com um número fixo de consultas, e não uma por notificação (antes, 600 notificações
 * com GPS eram 600 consultas de um ponto). Para cada ponto, o quarteirão é o mesmo da consulta de um ponto. Malha e
 * notificações sintéticas, em 2016 e longe da demonstração.
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

interface PontoMapa {
  id: string;
  lat: number;
  lng: number;
  precisao: PrecisaoGeo;
  blockId: string | null;
}

describe.runIf(enabled)('Vigilância: mapa de casos com o quarteirão da ficha em lote (N9)', () => {
  let t: TestApp;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  /** Grade de 20 × 20 quarteirões: lado de 0,0009° (~100 m) e rua de 0,0002° (~22 m). */
  const X0 = -54;
  const Y0 = -14;
  const PASSO = 0.0011;
  const LADO = 0.0009;
  let seq = 0;

  beforeAll(async () => {
    t = await startTestApp('vigmapalote');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    await t.app.get(CatalogoVigilanciaService).garantir({ tenant, db });
    const loc = await db.locality.create({ data: { code: '99000433', name: 'Distrito Mapa em Lote', category: 'DISTRITO', zone: 'URBANA', source: 'MANUAL' } });
    const blocos = [];
    for (let i = 0; i < 20; i++)
      for (let j = 0; j < 20; j++) {
        const [x0, y0] = [X0 + i * PASSO, Y0 + j * PASSO];
        const area: Area = {
          type: 'Polygon',
          coordinates: [
            [
              [x0, y0],
              [x0 + LADO, y0],
              [x0 + LADO, y0 + LADO],
              [x0, y0 + LADO],
              [x0, y0],
            ],
          ],
        };
        blocos.push({ localityId: loc.id, number: `M${i}-${j}`, ...derivados(area), areaM2: Math.round(areaM2(area) * 10) / 10, source: 'IMPORTACAO' });
      }
    await db.block.createMany({ data: blocos });
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  /** Notificações de dengue NOTIFICADAS conhecidas no dia, com a posição da ficha e a precisão dela. */
  const notificar = async (dia: string, posicoes: { lat: number; lng: number; precisao: PrecisaoGeo }[]) => {
    const paciente = (await db.patient.findFirstOrThrow({ where: { mergedIntoId: null }, select: { id: true } })).id;
    const unidade = (await db.unit.findFirstOrThrow({ where: { name: 'UBS Centro' }, select: { id: true } })).id;
    const notificador = (await db.user.findFirstOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf }, select: { id: true } })).id;
    const c = await db.notifiableCondition.findFirstOrThrow({ where: { groupKey: 'dengue', context: 'CASO' }, select: { id: true, key: true } });
    const semana = semanaDaData(dia).codigo;
    await db.notification.createMany({
      data: posicoes.map((p) => {
        seq++;
        return {
          year: 2016,
          seq: 960_000 + seq,
          number: `2016/${960_000 + seq}`,
          status: 'NOTIFICADA' as const,
          origin: 'MANUAL' as const,
          conditionId: c.id,
          conditionKey: c.key,
          groupKey: 'dengue',
          patientId: paciente,
          unitId: unidade,
          notifierId: notificador,
          notifierRole: 'VIGILANCIA_EPIDEMIOLOGICA' as const,
          knownAt: new Date(`${dia}T15:00:00Z`),
          deadlineStart: 'CONHECIMENTO' as const,
          deadlineKind: 'SEMANAL' as const,
          targets: ['SMS'],
          symptomsOnset: new Date(`${dia}T00:00:00Z`),
          epiWeekOnset: semana,
          epiWeekNotified: semana,
          residenceLat: p.lat,
          residenceLng: p.lng,
          residencePrecision: p.precisao,
          form: {},
        };
      }),
    });
  };

  /** GET /vigilancia/mapa contando as consultas ao banco do município durante o pedido. */
  const mapa = async (de: string, ate: string) => {
    const tenants = t.app.get(TenantsService);
    const original = tenants.client.bind(tenants);
    let consultas = 0;
    tenants.client = (async (id: string) => contarConsultas(await original(id), () => consultas++)) as typeof tenants.client;
    try {
      const r = await t.http().get(`/api/vigilancia/mapa?de=${de}&ate=${ate}&grupo=dengue`).set(auth(vig)).expect(200);
      return { pontos: r.body.pontos as PontoMapa[], porQuarteirao: r.body.porQuarteirao as { id: string; casos: number }[], consultas };
    } finally {
      tenants.client = original;
    }
  };

  it('600 notificações com a posição da ficha: o mesmo quarteirão da consulta de um ponto, com as consultas de 6', async () => {
    const precisoes: PrecisaoGeo[] = ['GPS_CAMPO', 'GPS_CAMPO', 'GPS_CAMPO', 'MAPA', 'ENDERECO', 'FACE', 'LOCALIDADE'];
    // Dentro dos quarteirões, na rua a ~5 m e a ~11 m (o mais próximo até 15 m), no meio do cruzamento (fora de todos)
    // e repetidas (o mesmo imóvel em várias notificações).
    const posicao = (k: number) => {
      const [i, j] = [k % 20, Math.floor(k / 20) % 20];
      const [x0, y0] = [X0 + i * PASSO, Y0 + j * PASSO];
      const onde = k % 6;
      const lng = onde === 3 ? x0 + LADO + 0.00005 : onde === 4 ? x0 + LADO + 0.0001 : onde === 5 ? x0 + LADO + 0.0001 : x0 + 0.0001 + (k % 7) * 0.0001;
      const lat = onde === 5 ? y0 + LADO + 0.0001 : y0 + 0.0002 + (k % 5) * 0.0001;
      return { lat, lng, precisao: precisoes[k % precisoes.length]! };
    };
    await notificar(
      '2016-02-10',
      Array.from({ length: 6 }, (_, k) => posicao(k)),
    );
    await notificar(
      '2016-03-09',
      Array.from({ length: 600 }, (_, k) => posicao(k % 550)),
    );

    const loc = t.app.get(LocalizadorService);
    const espiao = vi.spyOn(loc, 'quarteiraoDoPonto');
    let poucas: Awaited<ReturnType<typeof mapa>>;
    let muitas: Awaited<ReturnType<typeof mapa>>;
    try {
      poucas = await mapa('2016-02-01', '2016-02-29');
      muitas = await mapa('2016-03-01', '2016-03-31');
      // Antes: uma consulta de um ponto por notificação com a posição da ficha.
      expect(espiao.mock.calls.length).toBe(0);
    } finally {
      espiao.mockRestore();
    }
    expect(poucas.pontos).toHaveLength(6);
    expect(muitas.pontos).toHaveLength(600);
    expect(muitas.consultas).toBe(poucas.consultas);

    // Cada ponto no quarteirão da consulta de um ponto; a precisão que não liga ao quarteirão fica sem.
    let comQuarteirao = 0;
    for (const p of muitas.pontos) {
      const esperado = PRECISAO_LIGA_QUARTEIRAO.includes(p.precisao) ? ((await loc.quarteiraoDoPonto(db, p.lat, p.lng))?.id ?? null) : null;
      expect(p.blockId).toBe(esperado);
      if (esperado) comQuarteirao++;
    }
    expect(comQuarteirao).toBeGreaterThan(400);
    expect(muitas.pontos.filter((p) => p.precisao === 'LOCALIDADE').every((p) => p.blockId === null)).toBe(true);
    expect(muitas.porQuarteirao.reduce((s, q) => s + q.casos, 0)).toBe(comQuarteirao);
  });
});
