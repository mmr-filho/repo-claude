/**
 * Geometria do território sem PostGIS: GeoJSON (RFC 7946) em WGS 84 / SIRGAS 2000 (idênticos para fins práticos,
 * IBGE R.PR 01/2015), posições [longitude, latitude]. As distâncias usam uma projeção local em metros com os raios de
 * curvatura do elipsoide na latitude do ponto: em 150 m o erro é de centímetros, bem abaixo do erro do GPS (5 a 12 m).
 */

export type Posicao = [number, number];
export type Anel = Posicao[];
export interface Poligono {
  type: 'Polygon';
  coordinates: Anel[];
}
export interface MultiPoligono {
  type: 'MultiPolygon';
  coordinates: Anel[][];
}
export type Area = Poligono | MultiPoligono;
/** [minLng, minLat, maxLng, maxLat] */
export type Caixa = [number, number, number, number];

/** Metros por grau de latitude e de longitude na latitude dada (série para o elipsoide WGS 84). */
export function metrosPorGrau(lat: number): { lat: number; lng: number } {
  const f = (lat * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * f) + 1.175 * Math.cos(4 * f) - 0.0023 * Math.cos(6 * f),
    lng: 111412.84 * Math.cos(f) - 93.5 * Math.cos(3 * f) + 0.118 * Math.cos(5 * f),
  };
}

const poligonos = (a: Area): Anel[][] => (a.type === 'Polygon' ? [a.coordinates] : a.coordinates);

export function caixaDe(a: Area): Caixa {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of poligonos(a))
    for (const [lng, lat] of p[0] ?? []) {
      if (lng < x0) x0 = lng;
      if (lng > x1) x1 = lng;
      if (lat < y0) y0 = lat;
      if (lat > y1) y1 = lat;
    }
  return [x0, y0, x1, y1];
}

/** Caixa ampliada em `metros` para cada lado (filtro antes da conta exata). */
export function ampliarCaixa([x0, y0, x1, y1]: Caixa, metros: number): Caixa {
  const m = metrosPorGrau((y0 + y1) / 2);
  const dLat = metros / m.lat;
  const dLng = metros / Math.max(m.lng, 1);
  return [x0 - dLng, y0 - dLat, x1 + dLng, y1 + dLat];
}

export function caixasSeTocam(a: Caixa, b: Caixa): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Raio do ponto (ray casting); a borda conta como dentro. */
function pontoNoAnel([x, y]: Posicao, anel: Anel): boolean {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i]!;
    const [xj, yj] = anel[j]!;
    if (naBorda([x, y], [xi, yi], [xj, yj])) return true;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function naBorda(p: Posicao, a: Posicao, b: Posicao): boolean {
  const cruz = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cruz) > 1e-14) return false;
  return Math.min(a[0], b[0]) - 1e-12 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-12 && Math.min(a[1], b[1]) - 1e-12 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-12;
}

/** Ponto dentro da área (com furos e multipolígono); sobre a borda conta como dentro. */
export function pontoNaArea(p: Posicao, a: Area): boolean {
  return poligonos(a).some((pol) => pol.length > 0 && pontoNoAnel(p, pol[0]!) && !pol.slice(1).some((furo) => pontoNoAnel(p, furo) && !furo.some((_, i) => i > 0 && naBorda(p, furo[i - 1]!, furo[i]!))));
}

/** Distância em metros do ponto ao segmento AB (projeção local na latitude do ponto). */
function distanciaAoSegmento(p: Posicao, a: Posicao, b: Posicao, m: { lat: number; lng: number }): number {
  const ax = (a[0] - p[0]) * m.lng;
  const ay = (a[1] - p[1]) * m.lat;
  const bx = (b[0] - p[0]) * m.lng;
  const by = (b[1] - p[1]) * m.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.sqrt(x * x + y * y);
}

/** Distância em metros do ponto à área: zero dentro ou na borda; fora, até a borda mais próxima. */
export function distanciaAteArea(p: Posicao, a: Area): number {
  if (pontoNaArea(p, a)) return 0;
  const m = metrosPorGrau(p[1]);
  let menor = Infinity;
  for (const pol of poligonos(a))
    for (const anel of pol)
      for (let i = 1; i < anel.length; i++) {
        const d = distanciaAoSegmento(p, anel[i - 1]!, anel[i]!, m);
        if (d < menor) menor = d;
      }
  return menor;
}

/** Distância em metros entre dois pontos próximos (projeção local; para dezenas de km use haversine). */
export function distanciaM(a: Posicao, b: Posicao): number {
  const m = metrosPorGrau((a[1] + b[1]) / 2);
  const dx = (b[0] - a[0]) * m.lng;
  const dy = (b[1] - a[1]) * m.lat;
  return Math.sqrt(dx * dx + dy * dy);
}

function areaDoAnelM2(anel: Anel, m: { lat: number; lng: number }, lat0: number, lng0: number): number {
  let s = 0;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = [(anel[i]![0] - lng0) * m.lng, (anel[i]![1] - lat0) * m.lat];
    const [xj, yj] = [(anel[j]![0] - lng0) * m.lng, (anel[j]![1] - lat0) * m.lat];
    s += xj * yi - xi * yj;
  }
  return s / 2;
}

/** Área em m² (furos descontados). */
export function areaM2(a: Area): number {
  const [x0, y0, x1, y1] = caixaDe(a);
  const lat0 = (y0 + y1) / 2;
  const lng0 = (x0 + x1) / 2;
  const m = metrosPorGrau(lat0);
  let total = 0;
  for (const pol of poligonos(a)) {
    total += Math.abs(areaDoAnelM2(pol[0] ?? [], m, lat0, lng0));
    for (const furo of pol.slice(1)) total -= Math.abs(areaDoAnelM2(furo, m, lat0, lng0));
  }
  return total;
}

/** Centro de massa do maior polígono (para rótulo e para o imóvel sem coordenada própria). */
export function centroDe(a: Area): Posicao {
  const [x0, y0, x1, y1] = caixaDe(a);
  const lat0 = (y0 + y1) / 2;
  const lng0 = (x0 + x1) / 2;
  const m = metrosPorGrau(lat0);
  let melhor: { area: number; c: Posicao } | null = null;
  for (const pol of poligonos(a)) {
    const anel = pol[0] ?? [];
    let s = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const [xi, yi] = [(anel[i]![0] - lng0) * m.lng, (anel[i]![1] - lat0) * m.lat];
      const [xj, yj] = [(anel[j]![0] - lng0) * m.lng, (anel[j]![1] - lat0) * m.lat];
      const f = xj * yi - xi * yj;
      s += f;
      cx += (xi + xj) * f;
      cy += (yi + yj) * f;
    }
    const area = Math.abs(s / 2);
    if (area > 0 && (!melhor || area > melhor.area)) melhor = { area, c: [lng0 + cx / (3 * s) / m.lng, lat0 + cy / (3 * s) / m.lat] };
  }
  return melhor ? [arred(melhor.c[0]), arred(melhor.c[1])] : [arred((x0 + x1) / 2), arred((y0 + y1) / 2)];
}

/** Sentido horário (área com sinal negativa no plano lng/lat). */
export function sentidoHorario(anel: Anel): boolean {
  let s = 0;
  // Soma de (x2 - x1)(y2 + y1) sobre cada lado: positiva no sentido horário.
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) s += (anel[i]![0] - anel[j]![0]) * (anel[i]![1] + anel[j]![1]);
  return s > 0;
}

const arred = (n: number) => Math.round(n * 1e6) / 1e6;

function segmentosCruzam(p1: Posicao, p2: Posicao, p3: Posicao, p4: Posicao): boolean {
  const d = (a: Posicao, b: Posicao, c: Posicao) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Anel que cruza a si mesmo (lados não vizinhos se cortam). */
export function anelAutointersecta(anel: Anel): boolean {
  const n = anel.length - 1;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentosCruzam(anel[i]!, anel[i + 1]!, anel[j]!, anel[j + 1]!)) return true;
    }
  return false;
}

/**
 * Folga das comparações entre quarteirões: o arredondamento a 6 casas desloca um vértice até ~8 cm, e o vértice
 * "encaixado" (snap) no lado do vizinho pode cair um pouco para dentro dele.
 */
const FOLGA_M = 0.2;

/** Ponto onde dois segmentos que se cruzam se encontram. */
function cruzamento(p1: Posicao, p2: Posicao, p3: Posicao, p4: Posicao): Posicao {
  const den = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / den;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

/**
 * Duas áreas se sobrepõem (bordas que se cortam ou um vértice dentro da outra, além da folga de 20 cm); encostar
 * não conta, nem o vértice encaixado no lado do vizinho.
 */
export function areasSobrepoem(a: Area, b: Area): boolean {
  if (!caixasSeTocam(caixaDe(a), caixaDe(b))) return false;
  const aneisA = poligonos(a).flat();
  const aneisB = poligonos(b).flat();
  for (const ra of aneisA)
    for (const rb of aneisB)
      for (let i = 1; i < ra.length; i++)
        for (let j = 1; j < rb.length; j++) {
          const [p1, p2, p3, p4] = [ra[i - 1]!, ra[i]!, rb[j - 1]!, rb[j]!];
          if (!segmentosCruzam(p1, p2, p3, p4)) continue;
          // Cruzamento colado a um vértice é ruído do encaixe ou do arredondamento, não sobreposição.
          const x = cruzamento(p1, p2, p3, p4);
          if (![p1, p2, p3, p4].every((v) => distanciaM(x, v) > FOLGA_M)) continue;
          // Lado encaixado ao longo do lado do vizinho (junção em T): os dois extremos de um ficam a menos da folga
          // do outro; o arredondamento faz os dois "se cruzarem" no meio sem haver área em comum.
          const m = metrosPorGrau(x[1]);
          const d = (u: Posicao, s1: Posicao, s2: Posicao) => distanciaAoSegmento(u, s1, s2, m) <= FOLGA_M;
          // Um lado inteiro sobre o outro (os dois extremos colados) ...
          if ((d(p1, p3, p4) && d(p2, p3, p4)) || (d(p3, p1, p2) && d(p4, p1, p2))) continue;
          // ... ou em escada (um começa no meio do outro e segue além): um extremo de cada colado no outro.
          if ((d(p1, p3, p4) || d(p2, p3, p4)) && (d(p3, p1, p2) || d(p4, p1, p2))) continue;
          return true;
        }
  const dentroEstrito = (p: Posicao, x: Area) => pontoNaArea(p, x) && distanciaAteBorda(p, x) > FOLGA_M;
  if (poligonos(a).some((pol) => (pol[0] ?? []).some((p) => dentroEstrito(p, b))) || poligonos(b).some((pol) => (pol[0] ?? []).some((p) => dentroEstrito(p, a)))) return true;
  // Bordas alinhadas (vértice sobre a borda do outro) escapam dos testes acima: amostra a interseção das caixas.
  const [ca, cb] = [caixaDe(a), caixaDe(b)];
  const [x0, y0, x1, y1] = [Math.max(ca[0], cb[0]), Math.max(ca[1], cb[1]), Math.min(ca[2], cb[2]), Math.min(ca[3], cb[3])];
  const N = 12;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const p: Posicao = [x0 + ((i + 0.5) * (x1 - x0)) / N, y0 + ((j + 0.5) * (y1 - y0)) / N];
      if (dentroEstrito(p, a) && dentroEstrito(p, b)) return true;
    }
  return false;
}

function distanciaAteBorda(p: Posicao, a: Area): number {
  const m = metrosPorGrau(p[1]);
  let menor = Infinity;
  for (const pol of poligonos(a)) for (const anel of pol) for (let i = 1; i < anel.length; i++) menor = Math.min(menor, distanciaAoSegmento(p, anel[i - 1]!, anel[i]!, m));
  return menor;
}

export class GeometriaInvalida extends Error {}

/**
 * Normaliza a geometria recebida (importação ou editor): só Polygon/MultiPolygon, números finitos dentro de
 * [-180, 180] e [-90, 90], anéis fechados com pelo menos 3 vértices distintos, sem pontos repetidos seguidos, 6 casas
 * decimais (~10 cm), anel externo anti-horário e furos horários (RFC 7946) e sem autointerseção.
 */
export function normalizarArea(bruta: unknown, avisos?: string[]): Area {
  const g = bruta as { type?: string; coordinates?: unknown };
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || !Array.isArray(g.coordinates)) throw new GeometriaInvalida('A geometria precisa ser Polygon ou MultiPolygon');
  /** Anel normalizado, ou null quando colapsa (menos de 3 vértices depois de arredondar, ou menos de 1 m²). */
  const anel = (r: unknown, externo: boolean): Anel | null => {
    if (!Array.isArray(r)) throw new GeometriaInvalida('Anel inválido');
    // Área sobre as coordenadas originais, antes de arredondar: a lasca estreita (faixa de 1 cm) vira "oito" ao
    // arredondar, e tem de sair como lasca, não recusar a feição inteira.
    const orig = r.filter((p): p is number[] => Array.isArray(p) && p.length >= 2).map((p) => [Number(p[0]), Number(p[1])] as Posicao);
    if (orig.length >= 3 && orig.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90)) {
      const m0 = metrosPorGrau(orig[0]![1]);
      if (Math.abs(areaDoAnelM2(orig, m0, orig[0]![1], orig[0]![0])) < 1) return null;
    }
    const pts: Anel = [];
    for (const p of r) {
      if (!Array.isArray(p) || p.length < 2) throw new GeometriaInvalida('Posição inválida');
      const lng = Number(p[0]);
      const lat = Number(p[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) throw new GeometriaInvalida('Coordenada fora de longitude/latitude: confira o sistema de referência');
      const q: Posicao = [arred(lng), arred(lat)];
      const ult = pts[pts.length - 1];
      if (!ult || ult[0] !== q[0] || ult[1] !== q[1]) pts.push(q);
    }
    if (pts.length > 1 && (pts[0]![0] !== pts[pts.length - 1]![0] || pts[0]![1] !== pts[pts.length - 1]![1])) pts.push([pts[0]![0], pts[0]![1]]);
    if (pts.length < 4) return null;
    // Vértice repetido fora do fechamento: o contorno passa duas vezes pelo mesmo ponto (um "oito").
    const vistos = new Set<string>();
    for (const q of pts.slice(0, -1)) {
      const k = `${q[0]},${q[1]}`;
      if (vistos.has(k)) throw new GeometriaInvalida('O contorno passa duas vezes pelo mesmo vértice');
      vistos.add(k);
    }
    if (anelAutointersecta(pts)) throw new GeometriaInvalida('O contorno cruza a si mesmo');
    const m = metrosPorGrau(pts[0]![1]);
    if (Math.abs(areaDoAnelM2(pts, m, pts[0]![1], pts[0]![0])) < 1) return null;
    return sentidoHorario(pts) === externo ? pts.reverse() : pts;
  };
  let descartados = 0;
  /** Polígono normalizado, ou null quando o contorno externo colapsa; furos colapsados são descartados. */
  const poligono = (p: unknown): Anel[] | null => {
    if (!Array.isArray(p) || p.length === 0) throw new GeometriaInvalida('Polígono vazio');
    const externo = anel(p[0], true);
    if (!externo) return null;
    const furos: Anel[] = [];
    for (const r of p.slice(1)) {
      const furo = anel(r, false);
      if (!furo) {
        descartados++;
        continue;
      }
      // Furo tem de estar dentro do contorno externo (partes separadas são MultiPolygon, não furos); o vértice que
      // toca o contorno pode cair um pouco fora pelo arredondamento.
      const m = metrosPorGrau(externo[0]![1]);
      const naBordaExterna = (q: Posicao) => externo.some((_, i) => i > 0 && distanciaAoSegmento(q, externo[i - 1]!, externo[i]!, m) <= FOLGA_M);
      const fora = furo.some((q) => !pontoNoAnel(q, externo) && !naBordaExterna(q));
      const cruza = furo.some((_, i) => i > 0 && externo.some((__, j) => j > 0 && segmentosCruzam(furo[i - 1]!, furo[i]!, externo[j - 1]!, externo[j]!)) && !(naBordaExterna(furo[i - 1]!) || naBordaExterna(furo[i]!)));
      if (fora || cruza) throw new GeometriaInvalida('Há um anel fora do contorno externo: partes separadas vão como MultiPolygon');
      furos.push(furo);
    }
    return [externo, ...furos];
  };
  const brutas = g.type === 'Polygon' ? [g.coordinates] : (g.coordinates as unknown[]);
  if (!brutas.length) throw new GeometriaInvalida('MultiPolygon vazio');
  const partes: Anel[][] = [];
  for (const b of brutas) {
    const pol = poligono(b);
    if (pol) partes.push(pol);
    else descartados++;
  }
  // Lascas (partes ou furos minúsculos de recortes e dissoluções) saem; se não sobra parte, o polígono não tem área.
  if (!partes.length) throw new GeometriaInvalida(brutas.length === 1 ? 'Polígono sem área (vértices alinhados, contorno em espinho ou menos de 3 vértices)' : 'Todas as partes do MultiPolygon são lascas sem área');
  if (descartados) avisos?.push(`${descartados} anel(is) minúsculo(s) descartado(s)`);
  return partes.length === 1 ? { type: 'Polygon', coordinates: partes[0]! } : { type: 'MultiPolygon', coordinates: partes };
}

/** Fuso UTM (1 a 60) da longitude. */
export function fusoUtm(lng: number): number {
  return Math.min(60, Math.floor((lng + 180) / 6) + 1);
}

/** EPSG do SIRGAS 2000 / UTM do fuso, hemisfério sul (17S a 25S: 31977 a 31985). */
export function epsgSirgasUtmSul(fuso: number): number | null {
  return fuso >= 17 && fuso <= 25 ? 31960 + fuso : null;
}
