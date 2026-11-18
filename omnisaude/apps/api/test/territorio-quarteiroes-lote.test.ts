import { areaM2, caixaDe, type Anel, type Area } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { LocalizadorService } from '../src/modules/territorio/localizador.service';
import { derivados } from '../src/modules/territorio/territorio.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Quarteirão de muitos pontos em lote na malha com quarteirões sobrepostos (DIAGRAMA-5 e SURTO-6, quarta rodada). A
 * importação aceita sobreposição com aviso e não desativa os ausentes por padrão: a malha importada de novo com outra
 * numeração deixa cada quarteirão duas vezes. Antes, cada posição dentro de dois ou mais quarteirões voltava à consulta
 * de um ponto (500 pontos, 502 consultas). Agora o empate segue o desempate determinístico (área menor e depois o id),
 * o mesmo da consulta de um ponto, e o lote lê os mesmos candidatos que ela. Dados sintéticos, longe da demonstração.
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

/** Sorteio determinístico (o mesmo a cada execução). */
function sorteio(semente: number) {
  let s = semente >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const fechar = (a: Anel): Anel => [...a, a[0]!];
const retangulo = (x0: number, y0: number, x1: number, y1: number): Anel =>
  fechar([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
const poligono = (...aneis: Anel[]): Area => ({ type: 'Polygon', coordinates: aneis });

describe.runIf(enabled)('Território: quarteirão em lote na malha com quarteirões sobrepostos (DIAGRAMA-5, SURTO-6)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let loc: LocalizadorService;
  const ids = { localidade: '', bairro: '' };
  /** Grade de 12 × 12 quarteirões: lado de 0,0009° (~100 m) e rua de 0,0002° (~22 m). */
  const X0 = -52;
  const Y0 = -12;
  const PASSO = 0.0011;
  const LADO = 0.0009;
  /** Torre: mais quarteirões perto de um ponto do que a consulta de um ponto lê. */
  const TORRE = { lng: X0 + 0.02, lat: Y0 + 0.02 };

  /** Grava os quarteirões como a importação: caixa, centro e área (em m², com uma casa) calculados da geometria. */
  const gravar = async (blocos: { numero: string; area: Area; ativo?: boolean }[]) => {
    for (let i = 0; i < blocos.length; i += 2000)
      await db.block.createMany({
        data: blocos.slice(i, i + 2000).map((q) => ({
          localityId: ids.localidade,
          neighborhoodId: ids.bairro,
          number: q.numero,
          ...derivados(q.area),
          areaM2: Math.round(areaM2(q.area) * 10) / 10,
          source: 'IMPORTACAO',
          active: q.ativo ?? true,
        })),
      });
  };

  beforeAll(async () => {
    t = await startTestApp('terrquartlote');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    loc = t.app.get(LocalizadorService);
    const l = await db.locality.create({ data: { code: '99000432', name: 'Distrito Malha Sobreposta', category: 'DISTRITO', zone: 'URBANA', source: 'MANUAL' } });
    const b = await db.neighborhood.create({ data: { localityId: l.id, name: 'Bairro Malha Sobreposta', aliases: [] } });
    Object.assign(ids, { localidade: l.id, bairro: b.id });

    // A primeira importação: com buraco (pátio) e às vezes um quarteirão dentro dele, multipolígono, irregular, dois
    // colados (divisa sem rua) e quadrados; alguns quadrados redesenhados maiores e um inativo por cima.
    const r = sorteio(42);
    const primeira: { numero: string; area: Area; ativo?: boolean }[] = [];
    const segunda: typeof primeira = [];
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++) {
        const [x0, y0] = [X0 + i * PASSO, Y0 + j * PASSO];
        const k = (i * 12 + j) % 5;
        const quadrado = poligono(retangulo(x0, y0, x0 + LADO, y0 + LADO));
        if (k === 0) {
          primeira.push({ numero: `Q${i}-${j}`, area: poligono(retangulo(x0, y0, x0 + LADO, y0 + LADO), retangulo(x0 + LADO * 0.3, y0 + LADO * 0.3, x0 + LADO * 0.7, y0 + LADO * 0.7)) });
          if ((i + j) % 2 === 0) primeira.push({ numero: `P${i}-${j}`, area: poligono(retangulo(x0 + LADO * 0.3, y0 + LADO * 0.3, x0 + LADO * 0.7, y0 + LADO * 0.7)) });
        } else if (k === 1) {
          primeira.push({
            numero: `Q${i}-${j}`,
            area: { type: 'MultiPolygon', coordinates: [[retangulo(x0, y0, x0 + LADO * 0.45, y0 + LADO)], [retangulo(x0 + LADO * 0.55, y0, x0 + LADO, y0 + LADO)]] },
          });
        } else if (k === 2) {
          const pts: Anel = [];
          for (let v = 0; v < 24; v++) {
            const ang = (2 * Math.PI * v) / 24;
            const raio = (LADO / 2) * (0.75 + 0.25 * r());
            pts.push([x0 + LADO / 2 + raio * Math.cos(ang), y0 + LADO / 2 + raio * Math.sin(ang)]);
          }
          primeira.push({ numero: `Q${i}-${j}`, area: poligono(fechar(pts)) });
        } else if (k === 3) {
          primeira.push({ numero: `Q${i}-${j}`, area: poligono(retangulo(x0, y0, x0 + LADO / 2, y0 + LADO)) });
          primeira.push({ numero: `C${i}-${j}`, area: poligono(retangulo(x0 + LADO / 2, y0, x0 + LADO, y0 + LADO)) });
        } else {
          primeira.push({ numero: `Q${i}-${j}`, area: quadrado });
          primeira.push({ numero: `I${i}-${j}`, area: poligono(retangulo(x0 - 0.0001, y0 - 0.0001, x0 + LADO + 0.0001, y0 + LADO + 0.0001)), ativo: false });
        }
      }
    // A segunda importação, com outra numeração: os mesmos quarteirões e, nos quadrados, o contorno redesenhado ~2 m maior.
    for (const q of primeira.filter((x) => x.ativo !== false)) {
      const redesenhado = q.numero.startsWith('Q') && q.area.type === 'Polygon' && q.area.coordinates.length === 1 && q.area.coordinates[0]!.length === 5;
      const [x0, y0, x1, y1] = caixaDe(q.area);
      segunda.push({ numero: `N${q.numero}`, area: redesenhado ? poligono(retangulo(x0 - 0.00002, y0 - 0.00002, x1 + 0.00002, y1 + 0.00002)) : q.area });
    }
    // A torre: 205 quarteirões pequenos (6 m de lado) em volta do ponto, a 4-12 m dele, e um grande que o contém.
    const torre: typeof primeira = [{ numero: 'TGRANDE', area: poligono(retangulo(TORRE.lng - 0.0005, TORRE.lat - 0.0005, TORRE.lng + 0.0005, TORRE.lat + 0.0005)) }];
    for (let n = 0; n < 205; n++) {
      const ang = (2 * Math.PI * n) / 205;
      const dist = 0.00006 + (0.00004 * ((n * 7) % 5)) / 4;
      const [cx, cy] = [TORRE.lng + dist * Math.cos(ang), TORRE.lat + dist * Math.sin(ang)];
      torre.push({ numero: `T${n}`, area: poligono(retangulo(cx - 0.000027, cy - 0.000027, cx + 0.000027, cy + 0.000027)) });
    }
    await gravar([...torre, ...primeira, ...segunda]);
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  /** Pontos sorteados em toda a malha (dentro, na rua, no pátio), nas bordas, na divisa, na borda do pátio e longe. */
  const pontosDaMalha = () => {
    const r = sorteio(7);
    const pontos: { lat: number; lng: number }[] = [];
    for (let n = 0; n < 1500; n++) pontos.push({ lng: X0 - 0.0005 + r() * (12 * PASSO + 0.001), lat: Y0 - 0.0005 + r() * (12 * PASSO + 0.001) });
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++) {
        const [x0, y0] = [X0 + i * PASSO, Y0 + j * PASSO];
        pontos.push({ lng: x0, lat: y0 + LADO * r() }); // borda oeste
        pontos.push({ lng: x0 + LADO / 2, lat: y0 + LADO * r() }); // meio: divisa dos colados
        pontos.push({ lng: x0 + LADO * 0.3, lat: y0 + LADO * 0.5 }); // borda do pátio
        pontos.push({ lng: x0 + LADO * 0.5, lat: y0 + LADO * 0.5 }); // centro (pátio ou dentro)
        pontos.push({ lng: x0 + LADO + 0.0001, lat: y0 + LADO / 2 }); // rua, a ~11 m
        pontos.push({ lng: x0 - 0.00001, lat: y0 + LADO / 2 }); // ~1 m fora: no redesenhado, não no original
      }
    pontos.push({ lng: -40, lat: -5 });
    return pontos;
  };

  it('o lote dá o mesmo que a consulta de um ponto na malha importada duas vezes, sem voltar a ela', async () => {
    const pontos = pontosDaMalha();
    const umAUm: ({ id: string; number: string } | null)[] = [];
    for (const p of pontos) umAUm.push(await loc.quarteiraoDoPonto(db, p.lat, p.lng));
    const espiao = vi.spyOn(loc, 'quarteiraoDoPonto');
    try {
      const lote = await loc.quarteiroesDosPontos(db, pontos);
      const diferencas = pontos.map((p, i) => ({ p, umAUm: umAUm[i]?.number ?? null, lote: lote[i]?.number ?? null })).filter((x) => x.umAUm !== x.lote);
      expect(diferencas).toEqual([]);
      // Antes, cada posição dentro de dois ou mais quarteirões ia para a consulta de um ponto.
      expect(espiao.mock.calls.length).toBe(0);
    } finally {
      espiao.mockRestore();
    }
    // A malha sobreposta resolve pelo desempate: o redesenhado maior perde para o original (área menor) e o duplicado
    // exato, com a mesma área, fica com o menor id; o quarteirão no pátio ganha do que tem o pátio na borda dele.
    const blocos = new Map((await db.block.findMany({ where: { localityId: ids.localidade }, select: { id: true, number: true } })).map((q) => [q.number, q.id]));
    const menorId = (...numeros: string[]) => [...numeros].sort((a, b) => (blocos.get(a)! < blocos.get(b)! ? -1 : 1))[0];
    const centro = (i: number, j: number) => ({ lng: X0 + i * PASSO + LADO / 2, lat: Y0 + j * PASSO + LADO / 2 });
    // (0,4): quadrado (k = 4) e o redesenhado maior; (0,1): multipolígono duplicado; (0,0): pátio com quarteirão dentro.
    const [quadrado, multi, patio, bordaDoPatio, foraDoOriginal] = await loc.quarteiroesDosPontos(db, [
      centro(0, 4),
      { lng: X0 + LADO * 0.2, lat: Y0 + PASSO + LADO / 2 },
      centro(0, 0),
      { lng: X0 + LADO * 0.3, lat: Y0 + LADO * 0.5 },
      { lng: X0 - 0.00001, lat: Y0 + 4 * PASSO + LADO / 2 },
    ]);
    expect(quadrado!.number).toBe('Q0-4');
    expect(multi!.number).toBe(menorId('Q0-1', 'NQ0-1'));
    expect(patio!.number).toBe(menorId('P0-0', 'NP0-0'));
    expect(bordaDoPatio!.number).toBe(menorId('P0-0', 'NP0-0'));
    expect(foraDoOriginal!.number).toBe('NQ0-4');
  });

  it('mais candidatos do que a consulta de um ponto lê: o lote fica com os mesmos, os primeiros na ordem do desempate', async () => {
    // 206 quarteirões encostam na caixa do ponto: a consulta de um ponto lê os 200 de menor área, e o grande, que contém o
    // ponto, fica de fora; o resultado é o pequeno mais próximo (até 15 m).
    const pontos = [TORRE, { lng: TORRE.lng + 0.00001, lat: TORRE.lat }, { lng: TORRE.lng, lat: TORRE.lat - 0.00002 }];
    const umAUm = [];
    for (const p of pontos) umAUm.push(await loc.quarteiraoDoPonto(db, p.lat, p.lng));
    expect(umAUm.every((q) => q && q.number !== 'TGRANDE' && q.number.startsWith('T'))).toBe(true);
    const espiao = vi.spyOn(loc, 'quarteiraoDoPonto');
    try {
      expect(await loc.quarteiroesDosPontos(db, pontos)).toEqual(umAUm);
      expect(espiao.mock.calls.length).toBe(0);
    } finally {
      espiao.mockRestore();
    }
  });

  it('500 pontos na malha sobreposta: duas consultas, como 50 (antes, mais uma por posição dentro da sobreposição)', async () => {
    const r = sorteio(11);
    // Dentro dos quadrados (k = 4, colunas e linhas variadas): cada posição está no original e no redesenhado.
    const quadrados = [...Array(144).keys()].filter((n) => n % 5 === 4).map((n) => [Math.floor(n / 12), n % 12] as const);
    const pontosEm = (n: number) =>
      Array.from({ length: n }, () => {
        const [i, j] = quadrados[Math.floor(r() * quadrados.length)]!;
        return { lng: X0 + i * PASSO + 0.00005 + r() * (LADO - 0.0001), lat: Y0 + j * PASSO + 0.00005 + r() * (LADO - 0.0001) };
      });
    const consultas = async (pontos: { lat: number; lng: number }[]) => {
      let n = 0;
      const achados = await loc.quarteiroesDosPontos(
        contarConsultas(db, () => n++),
        pontos,
      );
      expect(achados.every((q) => q?.number.startsWith('Q'))).toBe(true);
      return n;
    };
    expect(await consultas(pontosEm(50))).toBe(2);
    expect(await consultas(pontosEm(500))).toBe(2);
  });
});
