import { Injectable } from '@nestjs/common';
import { distanciaM, normalizarLogradouro, normalizarNome, normalizarNumero, quadraLote, type PrecisaoGeo, type Posicao } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { ENDERECO_LIGA_QUARTEIRAO, LocalizadorService, posicaoExplicita, posicaoMelhorOuIgual, PRECISAO_LIGA_QUARTEIRAO } from './localizador.service';
import { TerritorioService } from './territorio.service';

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

/** Motivo, para a tela, dos imóveis que a geocodificação deixou como estavam por causa do quarteirão. */
export const MOTIVO_FORA_DO_QUARTEIRAO = 'o endereço na base do IBGE cai fora do quarteirão escolhido em campo para o imóvel, e a posição pelo endereço não troca esse quarteirão. Confira e marque no mapa';
/** O quarteirão escolhido em campo saiu da malha (a zona do ACE o mantém até a supervisão tirá-lo): o endereço não o substitui. */
export const MOTIVO_QUARTEIRAO_DESATIVADO =
  'o quarteirão escolhido em campo para o imóvel foi desativado na malha, e a posição pelo endereço não troca esse quarteirão. Marque o imóvel no mapa para ligá-lo ao quarteirão novo';

/**
 * Geocodificação só local (LGPD: o endereço não sai para serviços externos). Ordem: endereço com número na base do
 * IBGE (CNEFE), quadra e lote do complemento, centro do quarteirão do imóvel (o que já tem quarteirão), logradouro sem
 * número, centro do bairro ou da localidade pelo nome. Nunca troca uma posição melhor (GPS em campo, mapa) por uma
 * pior, e a posição pelo endereço nunca tira o imóvel do quarteirão escolhido em campo (o do ACE manda). O quarteirão
 * que veio da própria posição pelo endereço (endereço ou face de quadra) segue a posição melhor, menos no imóvel criado
 * pelo ACE em campo: lá o quarteirão é sempre o escolhido, até uma ação explícita mudar a posição dele.
 */
@Injectable()
export class GeocodificacaoService {
  constructor(
    private readonly localizador: LocalizadorService,
    private readonly audit: AuditService,
    private readonly territorio: TerritorioService,
  ) {}

  async geocodificar(ctx: RequestContext, input: { ids?: string[]; limite?: number; apos?: string }) {
    // Teto de imóveis analisados por chamada; os pendentes são percorridos por id, sem repetir sempre os mesmos.
    const limite = Math.min(input.limite ?? 20_000, 50_000);
    const explicito = !!input.ids?.length;
    const piores: PrecisaoGeo[] = ['LOGRADOURO', 'QUARTEIRAO', 'LOCALIDADE', 'SETOR', 'CEP', 'MUNICIPIO', 'FACE'];
    const select = { id: true, street: true, number: true, complement: true, district: true, cep: true, ibgeCode: true, latitude: true, longitude: true, geoPrecision: true, geoSource: true, blockId: true } as const;
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
    // Municípios do território (unidades e base de endereços): imóvel de outro município não ganha posição daqui.
    const municipios = new Set([...(await ctx.db.unit.findMany({ select: { ibgeCode: true } })).map((u) => u.ibgeCode), ...base.map((p) => p.ibgeCode)].map((c) => (c ?? '').slice(0, 6)).filter(Boolean));
    const centroBloco = new Map(blocos.map((b) => [b.id, b]));
    // Imóveis criados pelo ACE em campo (lidos uma vez: a sincronização não tem índice pelo imóvel).
    const doAce = await this.localizador.criadosPeloAce(ctx.db, explicito ? input.ids : undefined);
    // Nome de bairro ou localidade que existe em mais de um lugar (o "Centro" da sede e o do distrito) é ambíguo: não
    // posiciona ninguém por ele.
    const porNome = new Map<string, { lat: number; lng: number }[]>();
    const somar = (n: string, c: { lat: number; lng: number }) => (porNome.get(n) ?? porNome.set(n, []).get(n)!).push(c);
    for (const l of localidades) somar(normalizarNome(l.name), { lat: l.centerLat!, lng: l.centerLng! });
    for (const b of bairros) for (const n of new Set([b.name, ...b.aliases].map((x) => normalizarNome(x)))) somar(n, { lat: b.centerLat!, lng: b.centerLng! });
    const centroNome = new Map<string, { lat: number; lng: number }>();
    for (const [n, cs] of porNome) if (cs.every((c) => distanciaM([c.lng, c.lat], [cs[0]!.lng, cs[0]!.lat]) < 50)) centroNome.set(n, cs[0]!);

    const resumo: Record<string, number> = {};
    const posicionados: string[] = [];
    let analisados = 0;
    let atualizados = 0;
    let semResultado = 0;
    let foraDoQuarteirao = 0;
    let quarteiraoDesativado = 0;
    // Continua de onde a chamada anterior parou (a tela repete enquanto houver "proximo").
    let cursor: string | undefined = input.apos;
    let esgotou = false;
    while (analisados < limite) {
      const imoveis = await ctx.db.household.findMany({
        where: {
          active: true,
          ...(explicito ? { id: { in: input.ids } } : { OR: [{ latitude: null }, { longitude: null }, { geoPrecision: null }, { geoPrecision: { in: piores } }] }),
          ...(cursor ? { id: { gt: cursor, ...(explicito ? { in: input.ids } : {}) } } : {}),
        },
        select,
        orderBy: { id: 'asc' },
        take: Math.min(1000, limite - analisados),
      });
      if (!imoveis.length) {
        esgotou = true;
        break;
      }
      cursor = imoveis[imoveis.length - 1]!.id;
      for (const h of imoveis) {
        analisados++;
        const r = this.tentar(h, { porRuaNumero, porQuadraLote, porRua, centroBloco, centroNome, municipios });
        if (!r) {
          semResultado++;
          continue;
        }
        if (!posicaoMelhorOuIgual(r.precisao, h.geoPrecision as PrecisaoGeo | null)) continue;
        // Mesma precisão: só troca quando pedida para este imóvel (endereço corrigido) e o ponto mudou.
        if (h.geoPrecision === r.precisao && h.latitude != null && (!explicito || (h.latitude === r.lat && h.longitude === r.lng))) continue;
        // O quarteirão que veio da posição pelo endereço do próprio imóvel (endereço ou face de quadra na base do IBGE)
        // segue a posição melhor, como sempre: o endereço exato corrige o quarteirão ligado pela face de quadra, e liga ao
        // ativo o imóvel cujo quarteirão saiu da malha. Imóvel sem quarteirão também segue a regra de sempre. A exceção é
        // o imóvel criado pelo ACE em campo: o quarteirão é o escolhido lá, qualquer que seja a precisão da posição atual
        // (a face de quadra que o confirmou não o troca pelo do endereço exato), até uma ação explícita mudar a posição.
        const doEndereco = h.latitude != null && ENDERECO_LIGA_QUARTEIRAO.includes(h.geoPrecision as PrecisaoGeo);
        const escolhidoEmCampo = !!h.blockId && doAce.has(h.id) && !posicaoExplicita(h);
        if (h.blockId && (!doEndereco || escolhidoEmCampo)) {
          // O quarteirão que veio de outro lugar (imóvel sem posição, ou com posição que não liga quarteirão: centro do
          // quarteirão, rua, bairro) e o do imóvel criado pelo ACE são os escolhidos em campo e ficam. O desativado na
          // malha não está entre os ativos (nem no índice dos centros): nenhum ponto cai nele, nem a mediana da rua sem o
          // número ou o centro do bairro, que não ligam quarteirão mas poriam o imóvel longe do dele. O motivo é outro:
          // ligar o imóvel ao quarteirão novo.
          if (!centroBloco.has(h.blockId)) {
            quarteiraoDesativado++;
            continue;
          }
          // A posição pelo endereço só vale quando o ponto cai nesse mesmo quarteirão; fora dele, o imóvel fica como está
          // e é contado à parte, para a supervisão conferir no mapa.
          if (PRECISAO_LIGA_QUARTEIRAO.includes(r.precisao) && (await this.localizador.quarteiraoDoPonto(ctx.db, r.lat, r.lng))?.id !== h.blockId) {
            foraDoQuarteirao++;
            continue;
          }
        }
        if (PRECISAO_LIGA_QUARTEIRAO.includes(r.precisao)) {
          // Posição do imóvel: muda o cadastro (vai na ficha domiciliar do e-SUS).
          await ctx.db.household.update({ where: { id: h.id }, data: { latitude: r.lat, longitude: r.lng, geoPrecision: r.precisao, geoSource: r.fonte, geoAccuracyM: null, geoAt: new Date() } });
        } else {
          // Posição aproximada (rua, quarteirão, bairro) não vai ao e-SUS: grava sem mexer em updated_at, para não
          // gerar uma ficha de atualização igual à anterior.
          await ctx.db
            .$executeRaw`UPDATE households SET latitude = ${r.lat}, longitude = ${r.lng}, geo_precision = ${r.precisao}::"GeoPrecision", geo_source = ${r.fonte}, geo_accuracy_m = NULL, geo_at = now() WHERE id = ${h.id}::uuid`;
        }
        // Com os criados pelo ACE já lidos: a sincronização não é lida de novo a cada imóvel que muda de quarteirão.
        await this.localizador.vincularImovel(ctx.db, h.id, doAce);
        resumo[r.precisao] = (resumo[r.precisao] ?? 0) + 1;
        posicionados.push(h.id);
        atualizados++;
      }
    }
    await this.audit.recordStandalone(ctx, { action: 'territorio.geocodificar', entityType: 'Household', payload: { analisados, atualizados, foraDoQuarteirao, quarteiraoDesativado, resumo } });
    // Casos ativos dos moradores (ordem de bloqueio) são reavaliados com a posição nova.
    await this.territorio.imoveisPosicionados(ctx, posicionados);
    return {
      analisados,
      atualizados,
      semResultado,
      // Imóveis no quarteirão escolhido em campo cujo endereço cai em outro quarteirão (ou fora da malha), e imóveis num
      // quarteirão escolhido em campo que foi desativado na malha: ficaram como estavam.
      foraDoQuarteirao,
      quarteiraoDesativado,
      avisos: [
        ...(foraDoQuarteirao ? [`${foraDoQuarteirao} imóvel(is) ficaram como estavam: ${MOTIVO_FORA_DO_QUARTEIRAO}.`] : []),
        ...(quarteiraoDesativado ? [`${quarteiraoDesativado} imóvel(is) ficaram como estavam: ${MOTIVO_QUARTEIRAO_DESATIVADO}.`] : []),
      ],
      porPrecisao: resumo,
      baseDeEnderecos: base.length,
      proximo: esgotou || explicito ? null : (cursor ?? null),
    };
  }

  private tentar(
    h: { street: string | null; number: string | null; complement: string | null; district: string | null; cep: string | null; ibgeCode: string | null; blockId: string | null },
    idx: {
      porRuaNumero: Map<string, Ponto[]>;
      porQuadraLote: Map<string, Ponto[]>;
      porRua: Map<string, Ponto[]>;
      centroBloco: Map<string, { centerLat: number; centerLng: number }>;
      centroNome: Map<string, { lat: number; lng: number }>;
      municipios: Set<string>;
    },
  ): Resultado | null {
    const rua = normalizarLogradouro(h.street);
    const numero = normalizarNumero(h.number);
    const cep = (h.cep ?? '').replace(/\D/g, '');
    const bairro = normalizarNome(h.district);
    // IBGE com 6 ou 7 dígitos (o cadastro aceita os dois): compara pelos 6 primeiros.
    const ibge = (h.ibgeCode ?? '').replace(/\D/g, '').slice(0, 6);
    if (ibge.length === 6 && idx.municipios.size && !idx.municipios.has(ibge)) return null;
    // Vários candidatos (mesma rua em bairros diferentes): estreita pelo município, pelo CEP e pela localidade.
    const filtrar = (pts: Ponto[]) => {
      let c = ibge.length === 6 ? pts.filter((p) => p.ibgeCode.slice(0, 6) === ibge) : pts;
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
    // Imóvel que já tem quarteirão (o escolhido pelo ACE em campo): o centro dele (dezenas de metros, e dentro do próprio
    // quarteirão) vale mais que a mediana da rua sem o número, que pode cair em outro quarteirão e, por ser pior, nunca
    // seria trocada pelo centro na rodada seguinte.
    if (h.blockId) {
      const b = idx.centroBloco.get(h.blockId);
      if (b) return { lat: b.centerLat, lng: b.centerLng, precisao: 'QUARTEIRAO', fonte: 'centro-do-quarteirao' };
    }
    if (rua) {
      const pts = filtrar(idx.porRua.get(rua) ?? []);
      if (pts.length && concentrados(pts, 600)) {
        const [lng, lat] = mediana(pts);
        return { lat, lng, precisao: 'LOGRADOURO', fonte: 'cnefe:logradouro' };
      }
    }
    const c = bairro ? idx.centroNome.get(bairro) : undefined;
    if (c) return { lat: c.lat, lng: c.lng, precisao: 'LOCALIDADE', fonte: 'centro-do-bairro' };
    return null;
  }
}
