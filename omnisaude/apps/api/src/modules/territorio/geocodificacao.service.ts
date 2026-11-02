import { Injectable } from '@nestjs/common';
import { distanciaM, normalizarLogradouro, normalizarNome, normalizarNumero, quadraLote, type PrecisaoGeo, type Posicao } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { LocalizadorService, posicaoMelhorOuIgual } from './localizador.service';

/** Precisão pelo nível de geocodificação do CNEFE (NV_GEO_COORD). */
function precisaoDoNivel(nivel: number): PrecisaoGeo {
  if (nivel <= 3) return 'ENDERECO';
  if (nivel === 4) return 'FACE';
  if (nivel === 5) return 'LOCALIDADE';
  return 'SETOR';
}

interface Ponto {
  latitude: number;
  longitude: number;
  level: number;
  locality: string | null;
  cep: string | null;
  ibgeCode: string;
  streetKey: string;
}

interface Resultado {
  lat: number;
  lng: number;
  precisao: PrecisaoGeo;
  fonte: string;
}

/** Mediana das coordenadas (robusta a um ponto fora do lugar). */
function mediana(pts: Ponto[]): Posicao {
  const m = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  };
  return [m(pts.map((p) => p.longitude)), m(pts.map((p) => p.latitude))];
}

/** Os candidatos estão todos perto uns dos outros (mesmo endereço repetido)? */
function concentrados(pts: Ponto[], raio: number): boolean {
  const c = mediana(pts);
  return pts.every((p) => distanciaM(c, [p.longitude, p.latitude]) <= raio);
}

/**
 * Geocodificação só local (LGPD: o endereço não sai para serviços externos). Ordem: endereço com número na base do
 * IBGE (CNEFE), quadra e lote do complemento, logradouro sem número, centro do quarteirão do imóvel, centro do bairro
 * ou da localidade pelo nome. Nunca troca uma posição melhor (GPS em campo, mapa) por uma pior.
 */
@Injectable()
export class GeocodificacaoService {
  constructor(
    private readonly localizador: LocalizadorService,
    private readonly audit: AuditService,
  ) {}

  async geocodificar(ctx: RequestContext, input: { ids?: string[]; limite?: number }) {
    const limite = Math.min(input.limite ?? 2000, 5000);
    const piores: PrecisaoGeo[] = ['LOGRADOURO', 'QUARTEIRAO', 'LOCALIDADE', 'SETOR', 'CEP', 'MUNICIPIO', 'FACE'];
    const imoveis = await ctx.db.household.findMany({
      where: { active: true, ...(input.ids?.length ? { id: { in: input.ids } } : { OR: [{ latitude: null }, { longitude: null }, { geoPrecision: null }, { geoPrecision: { in: piores } }] }) },
      select: { id: true, street: true, number: true, complement: true, district: true, cep: true, ibgeCode: true, latitude: true, longitude: true, geoPrecision: true, blockId: true },
      take: limite,
    });
    // Base inteira na memória (um município: dezenas de milhares de endereços) em índices por chave.
    const base = await ctx.db.addressPoint.findMany({ select: { latitude: true, longitude: true, level: true, locality: true, cep: true, ibgeCode: true, streetKey: true, number: true, quadraKey: true, loteKey: true } });
    const porRuaNumero = new Map<string, Ponto[]>();
    const porQuadraLote = new Map<string, Ponto[]>();
    const porRua = new Map<string, Ponto[]>();
    const add = (m: Map<string, Ponto[]>, k: string, p: Ponto) => (m.get(k) ?? m.set(k, []).get(k)!).push(p);
    for (const p of base) {
      if (p.number) add(porRuaNumero, `${p.streetKey}|${p.number}`, p);
      if (p.quadraKey && p.loteKey) add(porQuadraLote, `${p.quadraKey}|${p.loteKey}`, p);
      add(porRua, p.streetKey, p);
    }
    const [blocos, bairros, localidades] = await Promise.all([
      ctx.db.block.findMany({ where: { active: true }, select: { id: true, centerLat: true, centerLng: true } }),
      ctx.db.neighborhood.findMany({ where: { active: true, centerLat: { not: null } }, select: { name: true, aliases: true, centerLat: true, centerLng: true } }),
      ctx.db.locality.findMany({ where: { status: 'ATIVA', centerLat: { not: null } }, select: { name: true, centerLat: true, centerLng: true } }),
    ]);
    const centroBloco = new Map(blocos.map((b) => [b.id, b]));
    const centroNome = new Map<string, { lat: number; lng: number }>();
    for (const l of localidades) centroNome.set(normalizarNome(l.name), { lat: l.centerLat!, lng: l.centerLng! });
    for (const b of bairros) for (const n of [b.name, ...b.aliases]) centroNome.set(normalizarNome(n), { lat: b.centerLat!, lng: b.centerLng! });

    const resumo: Record<string, number> = {};
    let atualizados = 0;
    let semResultado = 0;
    for (const h of imoveis) {
      const r = this.tentar(h, { porRuaNumero, porQuadraLote, porRua, centroBloco, centroNome });
      if (!r) {
        semResultado++;
        continue;
      }
      if (!posicaoMelhorOuIgual(r.precisao, h.geoPrecision as PrecisaoGeo | null) || (h.geoPrecision === r.precisao && h.latitude != null)) continue;
      await ctx.db.household.update({ where: { id: h.id }, data: { latitude: r.lat, longitude: r.lng, geoPrecision: r.precisao, geoSource: r.fonte, geoAccuracyM: null, geoAt: new Date() } });
      await this.localizador.vincularImovel(ctx.db, h.id);
      resumo[r.precisao] = (resumo[r.precisao] ?? 0) + 1;
      atualizados++;
    }
    await this.audit.recordStandalone(ctx, { action: 'territorio.geocodificar', entityType: 'Household', payload: { analisados: imoveis.length, atualizados, resumo } });
    return { analisados: imoveis.length, atualizados, semResultado, porPrecisao: resumo, baseDeEnderecos: base.length };
  }

  private tentar(
    h: { street: string | null; number: string | null; complement: string | null; district: string | null; cep: string | null; ibgeCode: string | null; blockId: string | null },
    idx: {
      porRuaNumero: Map<string, Ponto[]>;
      porQuadraLote: Map<string, Ponto[]>;
      porRua: Map<string, Ponto[]>;
      centroBloco: Map<string, { centerLat: number; centerLng: number }>;
      centroNome: Map<string, { lat: number; lng: number }>;
    },
  ): Resultado | null {
    const rua = normalizarLogradouro(h.street);
    const numero = normalizarNumero(h.number);
    const cep = (h.cep ?? '').replace(/\D/g, '');
    const bairro = normalizarNome(h.district);
    const ibge = (h.ibgeCode ?? '').slice(0, 7);
    // Vários candidatos (mesma rua em bairros diferentes): estreita pelo município, pelo CEP e pela localidade.
    const filtrar = (pts: Ponto[]) => {
      let c = ibge.length === 7 ? pts.filter((p) => p.ibgeCode === ibge) : pts;
      if (cep.length === 8 && c.some((p) => p.cep === cep)) c = c.filter((p) => p.cep === cep);
      if (bairro && c.some((p) => normalizarNome(p.locality) === bairro)) c = c.filter((p) => normalizarNome(p.locality) === bairro);
      return c;
    };
    const decidir = (pts: Ponto[], fonte: string): Resultado | null => {
      if (!pts.length || !concentrados(pts, 40)) return null;
      const melhorNivel = Math.min(...pts.map((p) => p.level));
      const [lng, lat] = mediana(pts.filter((p) => p.level === melhorNivel));
      return { lat, lng, precisao: precisaoDoNivel(melhorNivel), fonte };
    };
    if (rua && numero) {
      const r = decidir(filtrar(idx.porRuaNumero.get(`${rua}|${numero}`) ?? []), 'cnefe:endereco');
      if (r) return r;
    }
    const ql = quadraLote([h.complement, h.number].filter(Boolean).join(' '));
    if (ql.quadra && ql.lote) {
      let pts = filtrar(idx.porQuadraLote.get(`${ql.quadra}|${ql.lote}`) ?? []);
      if (rua && pts.some((p) => p.streetKey === rua)) pts = pts.filter((p) => p.streetKey === rua);
      const r = decidir(pts, 'cnefe:quadra-lote');
      if (r) return r;
    }
    if (rua) {
      const pts = filtrar(idx.porRua.get(rua) ?? []);
      if (pts.length && concentrados(pts, 600)) {
        const [lng, lat] = mediana(pts);
        return { lat, lng, precisao: 'LOGRADOURO', fonte: 'cnefe:logradouro' };
      }
    }
    if (h.blockId) {
      const b = idx.centroBloco.get(h.blockId);
      if (b) return { lat: b.centerLat, lng: b.centerLng, precisao: 'QUARTEIRAO', fonte: 'centro-do-quarteirao' };
    }
    const c = bairro ? idx.centroNome.get(bairro) : undefined;
    if (c) return { lat: c.lat, lng: c.lng, precisao: 'LOCALIDADE', fonte: 'centro-do-bairro' };
    return null;
  }
}
