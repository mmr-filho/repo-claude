import { Injectable } from '@nestjs/common';
import { distanciaM, fromZonedParts, ORDEM_PRECISAO, PRECISAO_INFO, type PrecisaoGeo } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { TenantClient } from '@omnisaude/database';
import type { RequestContext } from '../../core/context';
import { LocalizadorService } from '../territorio/localizador.service';
import { TerritorioService } from '../territorio/territorio.service';
import { NotificacaoService } from './notificacao.service';

export interface Residencia {
  lat: number;
  lng: number;
  precisao: PrecisaoGeo;
  blockId: string | null;
  fonte: 'cadastro' | 'ficha';
  /** Domicílio atual do paciente (seguindo a unificação), só quando a posição é dele (cadastro, ou ficha a até 100 m). */
  householdId: string | null;
}

const inicioDoDia = (iso: string, tz: string) => fromZonedParts({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)), hour: 0, minute: 0, second: 0 }, tz);
const diaSeguinte = (iso: string) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + 1)).toISOString().slice(0, 10);

/**
 * Mapa de casos notificados (PLT-3): só a vigilância (sigilo da notificação compulsória, Lei 6.259/1975, art. 10, na
 * redação da Lei 14.289/2022). A posição é a do imóvel no cadastro (a melhor disponível) ou, sem ela, o retrato da
 * ficha. Agravo sigiloso só aparece para quem abre a ficha; cada consulta é auditada.
 */
@Injectable()
export class MapaCasosService {
  constructor(
    private readonly notificacoes: NotificacaoService,
    private readonly territorio: TerritorioService,
    private readonly localizador: LocalizadorService,
    private readonly audit: AuditService,
  ) {}

  /** Domicílio atual de cada paciente, seguindo a unificação de cadastros duplicados (até 5 saltos). */
  private async casas(db: Pick<TenantClient, 'patient'>, patientIds: string[]) {
    const casaDe = new Map<string, { id: string; latitude: number | null; longitude: number | null; geoPrecision: string | null; blockId: string | null } | null>();
    let pendentes = [...new Set(patientIds)];
    const destino = new Map(pendentes.map((id) => [id, id]));
    // Até 5 saltos de unificação (duplicado → sobrevivente).
    for (let salto = 0; salto < 5 && pendentes.length; salto++) {
      const pacientes = await db.patient.findMany({
        where: { id: { in: pendentes } },
        select: { id: true, mergedIntoId: true, family: { select: { household: { select: { id: true, latitude: true, longitude: true, geoPrecision: true, blockId: true } } } } },
      });
      const proximos: string[] = [];
      for (const p of pacientes) {
        const origens = [...destino.entries()].filter(([, atual]) => atual === p.id).map(([origem]) => origem);
        if (p.mergedIntoId && !p.family?.household) {
          for (const o of origens) destino.set(o, p.mergedIntoId);
          proximos.push(p.mergedIntoId);
        } else for (const o of origens) casaDe.set(o, p.family?.household ?? null);
      }
      pendentes = [...new Set(proximos)];
    }
    return casaDe;
  }

  /** Domicílio atual do paciente, com ou sem posição (identidade do caso que ainda não tem posição nenhuma). */
  async domicilios(db: Pick<TenantClient, 'patient'>, patientIds: string[]): Promise<Map<string, string | null>> {
    const casaDe = await this.casas(db, patientIds);
    return new Map(patientIds.map((id) => [id, casaDe.get(id)?.id ?? null]));
  }

  /**
   * Posição da residência do caso: a registrada na ficha (a residência notificada; só existe com posição do imóvel) e,
   * sem ela, a do domicílio atual do paciente (seguindo a unificação de cadastros duplicados). Domicílio com posição
   * sem precisão conhecida é tratado como a mais fraca, nunca como GPS. O imóvel (householdId) só acompanha a posição
   * quando ela é desse imóvel: a do cadastro ou a da ficha a até 100 m dele.
   */
  async residencias(db: Pick<TenantClient, 'patient'>, ns: { id: string; patientId: string; residenceLat: number | null; residenceLng: number | null; residencePrecision: string | null }[]) {
    const casaDe = await this.casas(
      db,
      ns.map((n) => n.patientId),
    );
    return new Map<string, Residencia | null>(
      ns.map((n): [string, Residencia | null] => {
        const h = casaDe.get(n.patientId);
        if (n.residenceLat != null && n.residenceLng != null) {
          // O domicílio atual a até 100 m do retrato é o mesmo imóvel; longe dele é outra casa (mudança de família), e o
          // caso fica com a residência notificada, sem o imóvel novo.
          const mesmoImovel = h?.latitude != null && h.longitude != null && distanciaM([h.longitude, h.latitude], [n.residenceLng, n.residenceLat]) <= 100;
          // Ficha anterior à semana 25 sem a precisão: naquela época a posição do domicílio só vinha do GPS.
          const ficha: Residencia = {
            lat: n.residenceLat,
            lng: n.residenceLng,
            precisao: (n.residencePrecision ?? 'GPS_CAMPO') as PrecisaoGeo,
            blockId: null,
            fonte: 'ficha',
            householdId: mesmoImovel ? h!.id : null,
          };
          // O mesmo imóvel confirmado depois em campo (posição melhor) vale mais que o retrato.
          const melhor = mesmoImovel && !!h!.geoPrecision && ORDEM_PRECISAO[h!.geoPrecision as PrecisaoGeo] < ORDEM_PRECISAO[ficha.precisao];
          return [n.id, melhor ? { lat: h!.latitude!, lng: h!.longitude!, precisao: h!.geoPrecision as PrecisaoGeo, blockId: h!.blockId, fonte: 'cadastro', householdId: h!.id } : ficha];
        }
        if (h?.latitude != null && h.longitude != null)
          return [n.id, { lat: h.latitude, lng: h.longitude, precisao: (h.geoPrecision ?? 'MUNICIPIO') as PrecisaoGeo, blockId: h.blockId, fonte: 'cadastro' as const, householdId: h.id }];
        return [n.id, null];
      }),
    );
  }

  async mapa(ctx: RequestContext, q: { de: string; ate: string; grupo?: string }) {
    const tz = ctx.tenant.timeZone;
    const rows = await ctx.db.notification.findMany({
      where: {
        ...this.notificacoes.escopo(ctx),
        status: { in: ['RASCUNHO', 'NOTIFICADA', 'ENCERRADA'] },
        // Encerrada como descartada não é caso.
        NOT: { status: 'ENCERRADA', finalClass: '2' },
        knownAt: { gte: inicioDoDia(q.de, tz), lt: inicioDoDia(diaSeguinte(q.ate), tz) },
        ...(q.grupo ? { groupKey: q.grupo } : {}),
      },
      include: { condition: { select: { name: true } } },
      orderBy: { knownAt: 'desc' },
      take: 5000,
    });
    let ocultas = 0;
    const visiveis = rows.filter((n) => {
      if (n.sensitive && !this.notificacoes.podeAbrirSigilosa(ctx, n)) {
        ocultas++;
        return false;
      }
      return true;
    });
    const pos = await this.residencias(ctx.db, visiveis);
    // Quarteirão do caso: o do imóvel; para o retrato da ficha, pela posição.
    const pontos = [];
    let semPosicao = 0;
    for (const n of visiveis) {
      const r = pos.get(n.id);
      if (!r) {
        semPosicao++;
        continue;
      }
      const blockId = r.blockId ?? (['GPS_CAMPO', 'MAPA', 'ENDERECO', 'FACE'].includes(r.precisao) ? ((await this.localizador.quarteiraoDoPonto(ctx.db, r.lat, r.lng))?.id ?? null) : null);
      pontos.push({
        id: n.id,
        numero: n.number,
        agravo: n.condition.name,
        grupo: n.groupKey,
        status: n.status,
        prazo: n.deadlineKind,
        conhecimento: n.knownAt.toISOString(),
        lat: r.lat,
        lng: r.lng,
        precisao: r.precisao,
        precisaoLabel: PRECISAO_INFO[r.precisao].label,
        fonte: r.fonte,
        blockId,
      });
    }
    const contagem = new Map<string, number>();
    for (const p of pontos) if (p.blockId) contagem.set(p.blockId, (contagem.get(p.blockId) ?? 0) + 1);
    const blocos = contagem.size
      ? await ctx.db.block.findMany({ where: { id: { in: [...contagem.keys()] } }, select: { id: true, number: true, localityId: true, neighborhoodId: true, centerLat: true, centerLng: true } })
      : [];
    const porQuarteirao = (await this.territorio.comNomes(ctx, blocos)).map((b) => ({
      id: b.id,
      numero: b.number,
      localidade: b.localidade,
      bairro: b.bairro,
      centro: { lat: b.centerLat, lng: b.centerLng },
      casos: contagem.get(b.id) ?? 0,
    }));
    porQuarteirao.sort((a, b) => b.casos - a.casos);
    await this.audit.recordStandalone(ctx, {
      action: 'vigilancia.mapa_casos',
      entityType: 'Notification',
      payload: { de: q.de, ate: q.ate, grupo: q.grupo ?? null, pontos: pontos.length, sigilosas: visiveis.filter((n) => n.sensitive).map((n) => n.id) },
    });
    return { pontos, semPosicao, ocultasPorSigilo: ocultas, porQuarteirao, raioBloqueioM: ctx.tenant.settings.territorio.raioBloqueioM, limitado: rows.length === 5000 };
  }

  /**
   * Quarteirões no raio do bloqueio a partir da residência do caso (base da ordem de bloqueio do ACE, semana 26).
   * Posição de baixa precisão não dispara o bloqueio sozinha: pede confirmação em campo.
   */
  async quarteiroesDoCaso(ctx: RequestContext, id: string, metros?: number) {
    const n = await this.notificacoes.acessar(ctx, id, { leitura: true });
    const r = (await this.residencias(ctx.db, [n])).get(n.id) ?? null;
    const raioM = metros ?? ctx.tenant.settings.territorio.raioBloqueioM;
    if (!r) return { ponto: null, raioM, quarteiroes: [], regra: 'CONFIRMAR_EM_CAMPO' as const, motivo: 'Residência sem posição: marque o imóvel no mapa do território ou geocodifique pela base do IBGE.' };
    const lista = await this.localizador.quarteiroesNoRaio(ctx.db, r.lat, r.lng, raioM);
    return {
      ponto: { lat: r.lat, lng: r.lng },
      precisao: r.precisao,
      precisaoLabel: PRECISAO_INFO[r.precisao].label,
      fonte: r.fonte,
      regra: PRECISAO_INFO[r.precisao].bloqueio,
      raioM,
      quarteiroes: await this.territorio.comNomes(ctx, lista),
    };
  }
}
