import { describe, expect, it } from 'vitest';
import {
  areaM2,
  areasSobrepoem,
  avaliarGps,
  centroDe,
  distanciaAteArea,
  distanciaM,
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
