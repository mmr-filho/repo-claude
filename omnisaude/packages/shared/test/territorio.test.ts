import { describe, expect, it } from 'vitest';
import {
  areaM2,
  areasSobrepoem,
  avaliarGps,
  centroDe,
  distanciaAteArea,
  distanciaM,
  escaparHtml,
  epsgSirgasUtmSul,
  fusoUtm,
  GeometriaInvalida,
  metrosPorGrau,
  normalizarArea,
  normalizarLogradouro,
  normalizarNumero,
  normalizarCodigoLocalidade,
  normalizarNumeroQuarteirao,
  ORDEM_PRECISAO,
  PRECISAO_INFO,
  PRECISOES,
  pontoNaArea,
  quadraLote,
  raio95,
  sentidoHorario,
  type Area,
  type Posicao,
} from '../src';

// Quarteirão de 100 m x 100 m centrado num ponto de Gurupi/TO.
const C: Posicao = [-49.0686, -11.7298];
const m = metrosPorGrau(C[1]);
const quadrado = (centro: Posicao, lado: number): Area => {
  const dx = lado / 2 / m.lng;
  const dy = lado / 2 / m.lat;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [centro[0] - dx, centro[1] - dy],
        [centro[0] + dx, centro[1] - dy],
        [centro[0] + dx, centro[1] + dy],
        [centro[0] - dx, centro[1] + dy],
        [centro[0] - dx, centro[1] - dy],
      ],
    ],
  };
};
const desloca = (p: Posicao, lesteM: number, norteM: number): Posicao => [p[0] + lesteM / m.lng, p[1] + norteM / m.lat];

describe('geometria do território', () => {
  it('metros por grau batem com os valores de referência do elipsoide', () => {
    expect(metrosPorGrau(0).lat).toBeCloseTo(110574, -1);
    expect(metrosPorGrau(0).lng).toBeCloseTo(111320, -1);
    expect(metrosPorGrau(45).lat).toBeCloseTo(111132, -1);
  });

  it('ponto dentro, fora, na borda e no furo', () => {
    const q = quadrado(C, 100);
    expect(pontoNaArea(C, q)).toBe(true);
    expect(pontoNaArea(desloca(C, 60, 0), q)).toBe(false);
    expect(pontoNaArea(q.type === 'Polygon' ? q.coordinates[0]![0]! : C, q)).toBe(true);
    const comFuro: Area = { type: 'Polygon', coordinates: [(quadrado(C, 100) as { coordinates: Posicao[][] }).coordinates[0]!, (quadrado(C, 20) as { coordinates: Posicao[][] }).coordinates[0]!.slice().reverse()] };
    expect(pontoNaArea(C, comFuro)).toBe(false);
    expect(pontoNaArea(desloca(C, 30, 0), comFuro)).toBe(true);
  });

  it('distância à área em metros: zero dentro, até a borda fora', () => {
    const q = quadrado(C, 100);
    expect(distanciaAteArea(C, q)).toBe(0);
    expect(distanciaAteArea(desloca(C, 150, 0), q)).toBeCloseTo(100, 0);
    expect(distanciaAteArea(desloca(C, 0, -200), q)).toBeCloseTo(150, 0);
    // Na diagonal, até o canto: 100 m para leste e 100 m para norte da quina.
    expect(distanciaAteArea(desloca(C, 150, 150), q)).toBeCloseTo(Math.SQRT2 * 100, 0);
    expect(distanciaM(C, desloca(C, 0, 150))).toBeCloseTo(150, 1);
  });

  it('área de 1 hectare e centro do quarteirão', () => {
    const q = quadrado(C, 100);
    expect(areaM2(q)).toBeGreaterThan(9990);
    expect(areaM2(q)).toBeLessThan(10010);
    const c = centroDe(q);
    expect(distanciaM(c, C)).toBeLessThan(0.5);
  });

  it('normaliza: fecha o anel, põe o externo anti-horário e arredonda a 6 casas', () => {
    const horario = [
      [-49.07, -11.73],
      [-49.07, -11.729],
      [-49.069, -11.729],
      [-49.069, -11.73],
    ];
    const n = normalizarArea({ type: 'Polygon', coordinates: [horario] });
    expect(n.type).toBe('Polygon');
    const anel = (n as { coordinates: Posicao[][] }).coordinates[0]!;
    expect(anel).toHaveLength(5);
    expect(anel[0]).toEqual(anel[4]);
    expect(sentidoHorario(anel)).toBe(false);
    expect(
      normalizarArea({
        type: 'Polygon',
        coordinates: [
          [
            [-49.0700001234, -11.73],
            [-49.069, -11.73],
            [-49.069, -11.729],
            [-49.0700001234, -11.73],
          ],
        ],
      }).coordinates[0]![0],
    ).toEqual([-49.07, -11.73]);
  });

  it('recusa contorno cruzado, coordenada em metros (UTM sem reprojeção) e polígono degenerado', () => {
    const gravata = [
      [-49.07, -11.73],
      [-49.069, -11.729],
      [-49.069, -11.73],
      [-49.07, -11.729],
      [-49.07, -11.73],
    ];
    expect(() => normalizarArea({ type: 'Polygon', coordinates: [gravata] })).toThrow(GeometriaInvalida);
    expect(() =>
      normalizarArea({
        type: 'Polygon',
        coordinates: [
          [
            [710494, 8702602],
            [710594, 8702602],
            [710594, 8702702],
            [710494, 8702602],
          ],
        ],
      }),
    ).toThrow(/sistema de referência/);
    expect(() =>
      normalizarArea({
        type: 'Polygon',
        coordinates: [
          [
            [-49.07, -11.73],
            [-49.069, -11.73],
            [-49.07, -11.73],
          ],
        ],
      }),
    ).toThrow(GeometriaInvalida);
    expect(() => normalizarArea({ type: 'Point', coordinates: [-49, -11] })).toThrow(GeometriaInvalida);
  });

  it('sobreposição: cruzar ou conter conta; encostar e afastar não', () => {
    const a = quadrado(C, 100);
    expect(areasSobrepoem(a, quadrado(desloca(C, 50, 0), 100))).toBe(true);
    expect(areasSobrepoem(a, quadrado(C, 40))).toBe(true);
    expect(areasSobrepoem(a, quadrado(desloca(C, 300, 0), 100))).toBe(false);
    const encostado = quadrado(desloca(C, 100, 0), 100);
    expect(areasSobrepoem(normalizarArea(a), normalizarArea(encostado))).toBe(false);
  });

  it('vértice encaixado no meio do lado inclinado do vizinho (junção em T) não é sobreposição', () => {
    const P: Posicao = [-49.068712, -11.730113];
    const Q: Posicao = [-49.068291, -11.729177];
    const oeste = (p: Posicao): Posicao => [p[0] - 0.0008, p[1]];
    const leste = (p: Posicao): Posicao => [p[0] + 0.0008, p[1]];
    const A = normalizarArea({ type: 'Polygon', coordinates: [[P, Q, oeste(Q), oeste(P), P]] });
    let falsos = 0;
    for (let i = 1; i < 200; i++) {
      const t = i / 200;
      const V: Posicao = [P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])];
      const B = normalizarArea({ type: 'Polygon', coordinates: [[P, leste(P), leste(Q), Q, V, P]] });
      if (areasSobrepoem(A, B)) falsos++;
    }
    expect(falsos).toBe(0);
    // Invadir 5 m continua sendo sobreposição.
    const m = metrosPorGrau(P[1]);
    const dentro = (p: Posicao): Posicao => [p[0] - 5 / m.lng, p[1]];
    expect(areasSobrepoem(A, normalizarArea({ type: 'Polygon', coordinates: [[dentro(P), leste(P), leste(Q), dentro(Q), dentro(P)]] }))).toBe(true);
  });

  it('recusa anel sem área, espinho, oito pelo mesmo vértice e furo fora do contorno', () => {
    const o: Posicao = [-49.07, -11.73];
    const d = (x: number, y: number): Posicao => [o[0] + x * 0.0001, o[1] + y * 0.0001];
    expect(() => normalizarArea({ type: 'Polygon', coordinates: [[d(0, 0), d(1, 1), d(2, 2), d(0, 0)]] })).toThrow(GeometriaInvalida);
    expect(() => normalizarArea({ type: 'Polygon', coordinates: [[d(0, 0), d(5, 0), d(5, 5), d(5, 0), d(0, 0)]] })).toThrow(GeometriaInvalida);
    expect(() => normalizarArea({ type: 'Polygon', coordinates: [[d(0, 0), d(4, 0), d(4, 4), d(2, 2), d(0, 4), d(-2, 2), d(2, 2), d(0, 0)]] })).toThrow(GeometriaInvalida);
    const quadrado = (x: number, y: number) => [d(x, y), d(x + 3, y), d(x + 3, y + 3), d(x, y + 3), d(x, y)];
    expect(() => normalizarArea({ type: 'Polygon', coordinates: [quadrado(0, 0), quadrado(10, 10)] })).toThrow(/MultiPolygon/);
    // Furo de verdade continua aceito.
    expect(normalizarArea({ type: 'Polygon', coordinates: [[d(0, 0), d(10, 0), d(10, 10), d(0, 10), d(0, 0)], quadrado(3, 3)] }).coordinates).toHaveLength(2);
  });

  it('dois vértices encaixados ao longo do lado do vizinho (lado colado) não são sobreposição', () => {
    const P: Posicao = [-49.068712, -11.730113];
    const Q: Posicao = [-49.068291, -11.729177];
    const oeste = (p: Posicao): Posicao => [p[0] - 0.0008, p[1]];
    const leste = (p: Posicao): Posicao => [p[0] + 0.0008, p[1]];
    const A = normalizarArea({ type: 'Polygon', coordinates: [[P, Q, oeste(Q), oeste(P), P]] });
    const ponto = (t: number): Posicao => [P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])];
    let falsos = 0;
    for (let i = 1; i < 100; i++) {
      const [S1, S2] = [ponto(i / 200), ponto(0.5 + i / 200)];
      if (areasSobrepoem(A, normalizarArea({ type: 'Polygon', coordinates: [[S1, leste(S1), leste(S2), S2, S1]] }))) falsos++;
    }
    expect(falsos).toBe(0);
  });

  it('lado encaixado em escada (começa no meio do lado do vizinho e segue além) não é sobreposição', () => {
    const P: Posicao = [-49.068712, -11.730113];
    const Q: Posicao = [-49.068291, -11.729177];
    const oeste = (p: Posicao): Posicao => [p[0] - 0.0008, p[1]];
    const leste = (p: Posicao): Posicao => [p[0] + 0.0008, p[1]];
    const A = normalizarArea({ type: 'Polygon', coordinates: [[P, Q, oeste(Q), oeste(P), P]] });
    const S2: Posicao = [Q[0] + 0.5 * (Q[0] - P[0]), Q[1] + 0.5 * (Q[1] - P[1])];
    let falsos = 0;
    for (let i = 1; i < 150; i++) {
      const t = i / 150;
      const S1: Posicao = [P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])];
      if (areasSobrepoem(A, normalizarArea({ type: 'Polygon', coordinates: [[S1, leste(S1), leste(S2), S2, S1]] }))) falsos++;
    }
    expect(falsos).toBe(0);
  });

  it('lasca é decidida pela espessura: faixa de 2 cm com mais de 1 m² sai; gravata (vértices trocados) é recusada', () => {
    const o: Posicao = [-49.07, -11.73];
    const m = metrosPorGrau(o[1]);
    const d = (x: number, y: number): Posicao => [o[0] + x / m.lng, o[1] + y / m.lat];
    const quarteirao = [d(0, 0), d(100, 0), d(100, 55), d(0, 55), d(0, 0)];
    // Faixa de 2,2 cm x 119 m (2,6 m²), com vértice no meio de cada lado.
    const faixa = [d(150, 0), d(150, 59.5), d(150, 119), d(150.022, 119), d(150.022, 59.5), d(150.022, 0), d(150, 0)];
    const avisos: string[] = [];
    expect(normalizarArea({ type: 'MultiPolygon', coordinates: [[quarteirao], [faixa]] }, avisos).type).toBe('Polygon');
    expect(avisos[0]).toMatch(/descartado/);
    // Retângulo de 100 x 50 m com dois vértices trocados: área com sinal zero, mas não é lasca.
    const gravata = [d(200, 0), d(300, 0), d(200, 50), d(300, 50), d(200, 0)];
    expect(() => normalizarArea({ type: 'MultiPolygon', coordinates: [[quarteirao], [gravata]] })).toThrow(/cruza a si mesmo/);
    expect(() => normalizarArea({ type: 'Polygon', coordinates: [quarteirao, [d(20, 10), d(80, 10), d(20, 40), d(80, 40), d(20, 10)]] })).toThrow(/cruza a si mesmo/);
  });

  it('defeitos milimétricos do desenho são absorvidos; lasca que se cruza ou passa duas vezes pelo vértice sai como lasca', () => {
    const o: Posicao = [-49.07, -11.73];
    const m = metrosPorGrau(o[1]);
    const d = (x: number, y: number): Posicao => [o[0] + x / m.lng, o[1] + y / m.lat];
    const ok = (anel: Posicao[]) => normalizarArea({ type: 'Polygon', coordinates: [anel] });
    // Fechamento a 1 µm do primeiro vértice, canto duplicado a 1 µm, último clique 7 mm além do primeiro, nó de 5 mm.
    expect(areaM2(ok([d(0, 0), d(100, 0), d(100, 55), d(0, 55), d(0.0000007, -0.0000007)]))).toBeGreaterThan(5490);
    expect(areaM2(ok([d(0, 0), d(100, 0), d(99.9999993, -0.0000007), d(100, 55), d(0, 55), d(0, 0)]))).toBeGreaterThan(5490);
    expect(areaM2(ok([d(0, 0), d(100, 0), d(100, 55), d(0, 55), d(0.005, -0.005), d(0, 0)]))).toBeGreaterThan(5490);
    expect(areaM2(ok([d(0, 0), d(50, 0), d(50.003, 0.004), d(50.005, -0.002), d(50, 0.001), d(100, 0), d(100, 55), d(0, 55), d(0, 0)]))).toBeGreaterThan(5490);
    // Lascas (2 cm de largura) que se cruzam ou passam duas vezes pelo mesmo vértice: descartadas com aviso.
    const quarteirao = [d(0, 0), d(100, 0), d(100, 55), d(0, 55), d(0, 0)];
    const cruzada = [d(150, 0), d(165, 0.01), d(195, -0.01), d(210, 0), d(195, 0.01), d(165, -0.01), d(150, 0)];
    const oito = [d(150, 0), d(165, 0.005), d(180, 0), d(195, 0.005), d(210, 0), d(195, -0.005), d(180, 0), d(165, -0.005), d(150, 0)];
    for (const lasca of [cruzada, oito]) {
      const avisos: string[] = [];
      expect(normalizarArea({ type: 'MultiPolygon', coordinates: [[quarteirao], [lasca]] }, avisos).type).toBe('Polygon');
      expect(avisos[0]).toMatch(/descartado/);
    }
    expect(normalizarArea({ type: 'Polygon', coordinates: [quarteirao, oito.map(([x, y]) => [x - 0.0012, y + 0.0002] as Posicao)] }).coordinates).toHaveLength(1);

    // Lascas que se cruzam e não são retas: em L, dobrada 1 grau, em lente; e um furo em L torcido.
    const emL = [d(0, -0.02), d(50, -0.02), d(60, 0), d(100.02, -0.02), d(100.02, 55), d(100, 55), d(100, 0), d(60, -0.02), d(50, 0), d(0, 0)];
    const dobra = (x: number) => (x <= 50 ? 0 : (x - 50) * Math.tan(Math.PI / 180));
    const dobrada = [d(200, 0), d(240, 0.02), d(260, -0.02 + dobra(260 - 200 + 0)), d(300, dobra(300 - 200)), d(300, dobra(100) + 0.02), d(260, dobra(60)), d(240, -0.0), d(200, 0.02), d(200, 0)];
    const lente: Posicao[] = [];
    for (let x = 0; x <= 100; x += 10) lente.push(d(400 + x, (0.25 * (1 - Math.abs((2 * x) / 100 - 1))) / 2));
    for (let x = 90; x >= 10; x -= 10) lente.push(d(400 + x, -(0.25 * (1 - Math.abs((2 * x) / 100 - 1))) / 2));
    lente[1] = d(410, -0.026);
    for (const lasca of [emL, dobrada, lente]) {
      const avisos: string[] = [];
      expect(normalizarArea({ type: 'MultiPolygon', coordinates: [[quarteirao], [lasca]] }, avisos).type).toBe('Polygon');
      expect(avisos[0]).toMatch(/descartado/);
    }
    const grande = [d(-10, -10), d(120, -10), d(120, 70), d(-10, 70), d(-10, -10)];
    expect(normalizarArea({ type: 'Polygon', coordinates: [grande, emL] }).coordinates).toHaveLength(1);
    // A gravata de 100 x 50 m continua recusada.
    expect(() => normalizarArea({ type: 'MultiPolygon', coordinates: [[quarteirao], [[d(200, 0), d(300, 0), d(200, 50), d(300, 50), d(200, 0)]]] })).toThrow(/cruza a si mesmo/);
  });

  it('cunha real entre vizinhos (canto quase encaixado, lado que entra 2 m) continua sendo sobreposição', () => {
    const o: Posicao = [-49.07, -11.73];
    const m = metrosPorGrau(o[1]);
    const ang = (-20 * Math.PI) / 180;
    const g = (x: number, y: number): Posicao => [o[0] + (x * Math.cos(ang) - y * Math.sin(ang)) / m.lng, o[1] + (x * Math.sin(ang) + y * Math.cos(ang)) / m.lat];
    const A = normalizarArea({ type: 'Polygon', coordinates: [[g(0, 0.14), g(100.1, -2), g(100.1, 50), g(0, 50), g(0, 0.14)]] });
    const B = normalizarArea({ type: 'Polygon', coordinates: [[g(0, 0), g(0, -50), g(100, -50), g(100, 0), g(0, 0)]] });
    expect(areasSobrepoem(A, B)).toBe(true);
    expect(areasSobrepoem(B, A)).toBe(true);
  });

  it('furo encostado no contorno que atravessa o vão de um quarteirão em U é recusado', () => {
    const o: Posicao = [-49.07, -11.73];
    const m = metrosPorGrau(o[1]);
    const d = (x: number, y: number): Posicao => [o[0] + x / m.lng, o[1] + y / m.lat];
    const u = [d(0, 0), d(100, 0), d(100, 100), d(70, 100), d(70, 40), d(30, 40), d(30, 100), d(0, 100), d(0, 0)];
    expect(() => normalizarArea({ type: 'Polygon', coordinates: [u, [d(0, 70), d(90, 60), d(90, 80), d(0, 70)]] })).toThrow(/fora do contorno/);
  });

  it('lasca estreita com muitos vértices (faixa de 1 cm) sai como lasca, sem recusar a feição', () => {
    const o: Posicao = [-49.07, -11.73];
    const m = metrosPorGrau(o[1]);
    const d = (xm: number, ym: number): Posicao => [o[0] + xm / m.lng, o[1] + ym / m.lat];
    const grande = [d(0, 0), d(200, 0), d(200, 200), d(0, 200), d(0, 0)];
    const cima = Array.from({ length: 8 }, (_, i) => d(300 + i * 5, 0.01));
    const baixo = Array.from({ length: 8 }, (_, i) => d(335 - i * 5, 0));
    const lasca = [...cima, ...baixo, cima[0]!];
    const avisos: string[] = [];
    expect(normalizarArea({ type: 'MultiPolygon', coordinates: [[grande], [lasca]] }, avisos).type).toBe('Polygon');
    expect(avisos[0]).toMatch(/descartado/);
  });

  it('lascas de recorte saem sem recusar a feição; furo que toca o contorno é aceito', () => {
    const o: Posicao = [-49.07, -11.73];
    const d = (x: number, y: number): Posicao => [o[0] + x * 0.0001, o[1] + y * 0.0001];
    const grande = [d(0, 0), d(20, 0), d(20, 20), d(0, 20), d(0, 0)];
    const lasca = [d(30, 30), d(30.003, 30), d(30.003, 30.003), d(30, 30)];
    const avisos: string[] = [];
    const r = normalizarArea({ type: 'MultiPolygon', coordinates: [[grande], [lasca]] }, avisos);
    expect(r.type).toBe('Polygon');
    expect(avisos[0]).toMatch(/descartado/);
    // Furo minúsculo descartado; furo encostado no lado diagonal do contorno, aceito.
    expect(normalizarArea({ type: 'Polygon', coordinates: [grande, [d(5, 5), d(5.003, 5), d(5.003, 5.003), d(5, 5)]] }).coordinates).toHaveLength(1);
    const tri = [d(0, 0), d(20, 0), d(0, 20), d(0, 0)];
    const furoNaDiagonal = [d(10, 10), d(5, 10), d(5, 5), d(10, 10)];
    expect(normalizarArea({ type: 'Polygon', coordinates: [tri, furoNaDiagonal] }).coordinates).toHaveLength(2);
  });

  it('fuso UTM e EPSG do SIRGAS 2000 no Tocantins', () => {
    expect(fusoUtm(-49.07)).toBe(22);
    expect(epsgSirgasUtmSul(22)).toBe(31982);
    expect(fusoUtm(-47.9)).toBe(23);
    expect(epsgSirgasUtmSul(23)).toBe(31983);
    expect(epsgSirgasUtmSul(10)).toBeNull();
  });
});

describe('regras do território', () => {
  it('normaliza logradouro, número, quadra e lote para casar com a base do IBGE', () => {
    expect(normalizarLogradouro('Av. Goiás')).toBe('GOIAS');
    expect(normalizarLogradouro('AVENIDA GOIAS')).toBe('GOIAS');
    expect(normalizarLogradouro('Rua Dr. Antônio Pereira')).toBe('ANTONIO PEREIRA');
    expect(normalizarLogradouro('Rua 7')).toBe('7');
    expect(normalizarNumero('0123A')).toBe('123');
    expect(normalizarNumero('S/N')).toBeNull();
    expect(quadraLote('QUADRA 12 LOTE 07')).toEqual({ quadra: '12', lote: '7' });
    expect(quadraLote('QD.05 LT.3')).toEqual({ quadra: '5', lote: '3' });
    expect(quadraLote('LOJA 2')).toEqual({ quadra: null, lote: null });
  });

  it('GPS: normaliza a confiança do Android para 95% e classifica a leitura', () => {
    expect(raio95(10, 68)).toBeCloseTo(16.2, 1);
    expect(avaliarGps(raio95(10, 68))).toBe('ACEITA');
    expect(avaliarGps(35)).toBe('ALERTA');
    expect(avaliarGps(80)).toBe('NOVA_LEITURA');
  });

  it('ordem de qualidade da posição coerente com a regra do bloqueio', () => {
    const peso = { AUTOMATICO: 0, COM_AVISO: 1, CONFIRMAR_EM_CAMPO: 2 } as const;
    // Uma posição nunca é trocada por outra de regra pior: a ordem acompanha automático → com aviso → confirmar em campo.
    for (let i = 1; i < PRECISOES.length; i++) expect(peso[PRECISAO_INFO[PRECISOES[i]!].bloqueio]).toBeGreaterThanOrEqual(peso[PRECISAO_INFO[PRECISOES[i - 1]!].bloqueio]);
    expect(ORDEM_PRECISAO.QUARTEIRAO).toBeLessThan(ORDEM_PRECISAO.LOGRADOURO);
  });

  it('texto do cadastro vai às dicas do mapa como texto, nunca como HTML', () => {
    expect(escaparHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(escaparHtml("Rua D'Ávila & Cia")).toBe('Rua D&#39;Ávila &amp; Cia');
  });

  it('número do quarteirão em forma única (editor e importação)', () => {
    expect(['012', '12', ' 12 ', '0012'].map(normalizarNumeroQuarteirao)).toEqual(['12', '12', '12', '12']);
    expect(normalizarNumeroQuarteirao('007-a')).toBe('7-A');
    expect(normalizarNumeroQuarteirao('0')).toBe('0');
    expect(normalizarNumeroQuarteirao('12 A')).toBe('12-A');
    expect(normalizarNumeroQuarteirao('12A')).toBe(normalizarNumeroQuarteirao('12-a'));
    expect(normalizarNumeroQuarteirao('123')).toBe('123');
    expect(normalizarNumeroQuarteirao('12-1')).toBe('12-1');
    expect(['0001', '1', ' 001 '].map(normalizarCodigoLocalidade)).toEqual(['1', '1', '1']);
  });
});
