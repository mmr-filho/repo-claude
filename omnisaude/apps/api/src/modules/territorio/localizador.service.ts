import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@omnisaude/database';
import { ampliarCaixa, caixasSeTocam, distanciaAteArea, ORDEM_PRECISAO, pontoNaArea, type Area, type Caixa, type PrecisaoGeo, type Posicao } from '@omnisaude/shared';

/** Ponto sobre a rua ou com erro de GPS: até esta distância de um quarteirão, o imóvel é ligado ao mais próximo. */
export const TOLERANCIA_QUARTEIRAO_M = 15;

/** Precisões boas o bastante para ligar o imóvel ao quarteirão pela posição (as demais não dizem em qual está). */
export const PRECISAO_LIGA_QUARTEIRAO: PrecisaoGeo[] = ['GPS_CAMPO', 'MAPA', 'ENDERECO', 'FACE'];

type Db = Pick<TenantClient, 'block' | 'household'>;

interface QuarteiraoGeo {
  id: string;
  number: string;
  localityId: string;
  neighborhoodId: string | null;
  geometry: Area;
  caixa: Caixa;
}

const caixaDoBloco = (b: { minLng: number; minLat: number; maxLng: number; maxLat: number }): Caixa => [b.minLng, b.minLat, b.maxLng, b.maxLat];

/** Grade simples (células de ~550 m) para achar quarteirões candidatos sem PostGIS. */
class Grade {
  private readonly celulas = new Map<string, QuarteiraoGeo[]>();
  constructor(
    blocos: QuarteiraoGeo[],
    private readonly passo = 0.005,
  ) {
    for (const b of blocos) for (const k of this.chaves(b.caixa)) (this.celulas.get(k) ?? this.celulas.set(k, []).get(k)!).push(b);
  }
  private chaves([x0, y0, x1, y1]: Caixa) {
    const out: string[] = [];
    for (let i = Math.floor(x0 / this.passo); i <= Math.floor(x1 / this.passo); i++) for (let j = Math.floor(y0 / this.passo); j <= Math.floor(y1 / this.passo); j++) out.push(`${i}:${j}`);
    return out;
  }
  candidatos(c: Caixa): QuarteiraoGeo[] {
    const vistos = new Set<string>();
    const out: QuarteiraoGeo[] = [];
    for (const k of this.chaves(c))
      for (const b of this.celulas.get(k) ?? [])
        if (!vistos.has(b.id) && caixasSeTocam(b.caixa, c)) {
          vistos.add(b.id);
          out.push(b);
        }
    return out;
  }
}

function escolher(p: Posicao, candidatos: QuarteiraoGeo[]): QuarteiraoGeo | null {
  let melhor: { b: QuarteiraoGeo; d: number } | null = null;
  for (const b of candidatos) {
    if (pontoNaArea(p, b.geometry)) return b;
    const d = distanciaAteArea(p, b.geometry);
    if (d <= TOLERANCIA_QUARTEIRAO_M && (!melhor || d < melhor.d)) melhor = { b, d };
  }
  return melhor?.b ?? null;
}

@Injectable()
export class LocalizadorService {
  /** Quarteirões ativos cuja caixa encosta na caixa dada (filtro no banco pelas colunas indexadas). */
  private async blocosNaCaixa(db: Db, [x0, y0, x1, y1]: Caixa, take = 5000): Promise<QuarteiraoGeo[]> {
    const rows = await db.block.findMany({
      where: { active: true, minLng: { lte: x1 }, maxLng: { gte: x0 }, minLat: { lte: y1 }, maxLat: { gte: y0 } },
      select: { id: true, number: true, localityId: true, neighborhoodId: true, geometry: true, minLng: true, minLat: true, maxLng: true, maxLat: true },
      take,
    });
    return rows.map((r) => ({ ...r, geometry: r.geometry as unknown as Area, caixa: caixaDoBloco(r) }));
  }

  /** Quarteirão que contém o ponto ou, se o ponto cair na rua, o mais próximo até 15 m. */
  async quarteiraoDoPonto(db: Db, lat: number, lng: number): Promise<{ id: string; number: string } | null> {
    const p: Posicao = [lng, lat];
    const caixa = ampliarCaixa([lng, lat, lng, lat], TOLERANCIA_QUARTEIRAO_M);
    const b = escolher(p, await this.blocosNaCaixa(db, caixa, 200));
    return b ? { id: b.id, number: b.number } : null;
  }

  /**
   * Quarteirões atingidos pelo raio (bloqueio de transmissão): o polígono está a até `metros` do ponto, medido até a
   * borda (o quarteirão do próprio caso tem distância zero). Ordem: do mais próximo ao mais distante.
   */
  async quarteiroesNoRaio(db: Db, lat: number, lng: number, metros: number) {
    const p: Posicao = [lng, lat];
    const blocos = await this.blocosNaCaixa(db, ampliarCaixa([lng, lat, lng, lat], metros));
    return blocos
      .map((b) => ({ b, d: distanciaAteArea(p, b.geometry) }))
      .filter((x) => x.d <= metros)
      .sort((a, b) => a.d - b.d)
      .map((x) => ({ id: x.b.id, numero: x.b.number, localityId: x.b.localityId, neighborhoodId: x.b.neighborhoodId, distanciaM: Math.round(x.d * 10) / 10 }));
  }

  /** Liga um imóvel ao quarteirão pela posição (só com precisão suficiente); devolve o quarteirão gravado. */
  async vincularImovel(db: Db, householdId: string): Promise<string | null> {
    const h = await db.household.findUnique({ where: { id: householdId }, select: { latitude: true, longitude: true, geoPrecision: true, blockId: true } });
    if (!h || h.latitude == null || h.longitude == null || !h.geoPrecision) return h?.blockId ?? null;
    if (!PRECISAO_LIGA_QUARTEIRAO.includes(h.geoPrecision as PrecisaoGeo)) return h.blockId;
    const b = await this.quarteiraoDoPonto(db, h.latitude, h.longitude);
    const novo = b?.id ?? null;
    if (novo !== h.blockId) await db.household.update({ where: { id: householdId }, data: { blockId: novo } });
    return novo;
  }

  /**
   * Religa todos os imóveis com posição boa aos quarteirões (depois de importar ou editar a malha). Imóvel com a
   * posição no centro do quarteirão (precisão QUARTEIRAO) mantém o quarteirão de origem.
   */
  async vincularTodos(db: Db): Promise<{ analisados: number; comQuarteirao: number; semQuarteirao: number; alterados: number }> {
    const todos = await db.block.findMany({ where: { active: true }, select: { id: true, number: true, localityId: true, neighborhoodId: true, geometry: true, minLng: true, minLat: true, maxLng: true, maxLat: true } });
    const grade = new Grade(todos.map((r) => ({ ...r, geometry: r.geometry as unknown as Area, caixa: caixaDoBloco(r) })));
    const r = { analisados: 0, comQuarteirao: 0, semQuarteirao: 0, alterados: 0 };
    let cursor: string | undefined;
    for (;;) {
      const lote = await db.household.findMany({
        // "id maior que o último" (e não o cursor do Prisma): o último imóvel pode ter saído do filtro entre um lote e outro.
        where: { active: true, latitude: { not: null }, longitude: { not: null }, geoPrecision: { in: PRECISAO_LIGA_QUARTEIRAO }, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, latitude: true, longitude: true, blockId: true },
        orderBy: { id: 'asc' },
        take: 1000,
      });
      if (!lote.length) break;
      cursor = lote[lote.length - 1]!.id;
      const mudancas = new Map<string | null, string[]>();
      for (const h of lote) {
        r.analisados++;
        const p: Posicao = [h.longitude!, h.latitude!];
        const b = escolher(p, grade.candidatos(ampliarCaixa([p[0], p[1], p[0], p[1]], TOLERANCIA_QUARTEIRAO_M)));
        const novo = b?.id ?? null;
        if (novo) r.comQuarteirao++;
        else r.semQuarteirao++;
        if (novo !== h.blockId) (mudancas.get(novo) ?? mudancas.set(novo, []).get(novo)!).push(h.id);
      }
      for (const [blockId, ids] of mudancas) {
        await db.household.updateMany({ where: { id: { in: ids } }, data: { blockId } });
        r.alterados += ids.length;
      }
    }
    return r;
  }
}

/** Uma posição nova só substitui a atual se for de precisão melhor ou igual. */
export function posicaoMelhorOuIgual(nova: PrecisaoGeo, atual: PrecisaoGeo | null | undefined): boolean {
  return !atual || ORDEM_PRECISAO[nova] <= ORDEM_PRECISAO[atual];
}
