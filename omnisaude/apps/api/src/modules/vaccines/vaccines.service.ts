import { HttpStatus, Injectable } from '@nestjs/common';
import { DOSE_VACINA, ESTRATEGIA_VACINACAO, FABRICANTE_RNDS, IMUNOBIOLOGICO, LOCAL_APLICACAO_VACINA, VIA_ADMINISTRACAO_MEDICAMENTO } from '@omnisaude/esus';
import { ageInYears, aprazar, CALENDARIO_NACIONAL, componentesDaVacina, GRUPO_LABEL, localDateString, proximasDoses, type DoseAplicada, type SituacaoDose } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { OutboxService } from '../../core/outbox.service';
import { carregarDadosEquipe, carregarDadosUnidade } from '../indicators/indicators.service';
import { debit } from '../pharmacy/stock';
import { renderDocument } from '../signatures/pdf';
import { certificadoVacinacaoModel } from './certificate';

const DIA = 86_400_000;
/** Vacinas com indicação de via/local padrão quando o profissional não informa. */
const VIA_PADRAO: Record<string, string> = { '45': '0', '65': '0', '28': '0' };

export interface AplicarInput {
  patientId: string;
  vaccineCode: string;
  lotId?: string;
  lotNumber?: string;
  manufacturerCode?: string;
  manufacturer?: string;
  expiry?: string;
  doseCode: string;
  strategyCode?: string;
  routeCode?: string;
  siteCode?: string;
  appliedAt?: string;
  encounterId?: string;
  nextDueAt?: string;
  transcription?: boolean;
  locationId?: string;
}

/** Sala de vacina: cartão, aplicação com baixa do estoque por lote, aprazamento, faltosos e certificado. */
@Injectable()
export class VaccinesService {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  calendario() {
    return {
      regras: CALENDARIO_NACIONAL,
      grupos: GRUPO_LABEL,
      imunobiologicos: Object.entries(IMUNOBIOLOGICO)
        .filter(([code, name]) => /vacina/i.test(name) && Number(code) < 1000)
        .map(([code, name]) => ({ code, name })),
      doses: DOSE_VACINA,
      estrategias: ESTRATEGIA_VACINACAO,
      vias: VIA_ADMINISTRACAO_MEDICAMENTO,
      locais: LOCAL_APLICACAO_VACINA,
      fabricantes: FABRICANTE_RNDS,
    };
  }

  private async gestacaoDum(ctx: RequestContext, patientId: string, hoje: Date): Promise<Date | null> {
    const cond = await ctx.db.patientCondition.findFirst({
      where: { patientId, active: true, OR: [{ lineOfCare: 'GESTANTE' }, { code: { startsWith: 'Z34' } }, { code: { startsWith: 'Z33' } }] },
      orderBy: { recordedAt: 'desc' },
    });
    if (!cond) return null;
    const dum = cond.onsetAt ?? cond.recordedAt;
    return hoje.getTime() - dum.getTime() <= 294 * DIA ? dum : null;
  }

  /** Cartão de vacinação: doses registradas, situação na RNDS e aprazamento pelo calendário. */
  async cartao(ctx: RequestContext, patientId: string) {
    const patient = await ctx.db.patient.findUnique({ where: { id: patientId } });
    if (!patient) throw notFound('Paciente');
    const hoje = new Date();
    const rows = await ctx.db.vaccination.findMany({ where: { patientId }, orderBy: { appliedAt: 'desc' } });
    const [outbox, units, users] = await Promise.all([
      rows.length ? ctx.db.outboxMessage.findMany({ where: { kind: 'RNDS_IMUNIZACAO', aggregateId: { in: rows.map((r) => r.id) } }, select: { aggregateId: true, status: true, lastError: true } }) : [],
      ctx.db.unit.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.unitId))] } }, select: { id: true, name: true } }),
      ctx.db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.professionalId))] } }, select: { id: true, name: true } }),
    ]);
    const rnds = new Map(outbox.map((o) => [o.aggregateId, o]));
    const unitName = new Map(units.map((u) => [u.id, u.name]));
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const doses: DoseAplicada[] = rows.map((r) => ({ componentes: componentesDaVacina(r.vaccineCode, r.vaccineName), at: r.appliedAt }));
    const gestacaoDum = patient.sex === 'F' ? await this.gestacaoDum(ctx, patientId, hoje) : null;
    const aprazamento = aprazar({ birthDate: patient.birthDate, sex: patient.sex, gestacaoDum }, doses, hoje);
    return {
      patient: {
        id: patient.id,
        name: patient.socialName ?? patient.name,
        birthDate: localDateString(patient.birthDate, 'UTC'),
        age: ageInYears(patient.birthDate, hoje),
        sex: patient.sex,
        cns: patient.cns,
        cpf: patient.cpf,
        gestante: !!gestacaoDum,
      },
      doses: rows.map((r) => ({
        id: r.id,
        vaccineCode: r.vaccineCode,
        vaccineName: r.vaccineName,
        dose: r.dose,
        doseCode: r.doseCode,
        lot: r.lot,
        manufacturer: r.manufacturer,
        expiry: r.expiry ? localDateString(r.expiry, 'UTC') : null,
        route: r.route,
        site: r.site,
        strategy: r.strategyCode ? (ESTRATEGIA_VACINACAO[r.strategyCode] ?? r.strategyCode) : null,
        transcription: r.transcription,
        appliedAt: r.appliedAt.toISOString(),
        nextDueAt: r.nextDueAt ? localDateString(r.nextDueAt, 'UTC') : null,
        unit: unitName.get(r.unitId) ?? null,
        professional: userName.get(r.professionalId) ?? null,
        rnds: r.transcription
          ? { status: 'NAO_SE_APLICA' }
          : rnds.has(r.id)
            ? { status: rnds.get(r.id)!.status, error: rnds.get(r.id)!.lastError }
            : { status: ctx.tenant.settings.rndsEnabled ? 'PENDENTE' : 'DESLIGADA' },
      })),
      aprazamento,
      proximas: proximasDoses(aprazamento),
      atrasadas: proximasDoses(aprazamento).filter((s) => s.situacao === 'ATRASADA').length,
    };
  }

  /** Aplica (ou transcreve) uma dose: baixa o lote no estoque da sala, registra e envia à RNDS. */
  async aplicar(ctx: RequestContext, input: AplicarInput) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw notFound('Paciente');
    const vaccineName = IMUNOBIOLOGICO[input.vaccineCode];
    if (!vaccineName) throw new DomainError('IMUNOBIOLOGICO_INVALIDO', `Imunobiológico desconhecido: ${input.vaccineCode}`, 400);
    if (!DOSE_VACINA[input.doseCode]) throw new DomainError('DOSE_INVALIDA', `Dose desconhecida: ${input.doseCode}`, 400);
    const appliedAt = input.appliedAt ? new Date(input.appliedAt) : new Date();
    if (appliedAt.getTime() > Date.now() + 60_000) throw new DomainError('DATA_FUTURA', 'A data de aplicação não pode ser futura', 400);
    if (appliedAt.getTime() < patient.birthDate.getTime()) throw new DomainError('DATA_INVALIDA', 'A data de aplicação é anterior ao nascimento', 400);
    const transcription = input.transcription === true;
    const routeCode = input.routeCode ?? VIA_PADRAO[input.vaccineCode] ?? '14';
    if (!VIA_ADMINISTRACAO_MEDICAMENTO[routeCode]) throw new DomainError('VIA_INVALIDA', `Via de administração desconhecida: ${routeCode}`, 400);
    if (input.siteCode && !LOCAL_APLICACAO_VACINA[input.siteCode]) throw new DomainError('LOCAL_INVALIDO', `Local de aplicação desconhecido: ${input.siteCode}`, 400);
    const strategyCode = input.strategyCode ?? (transcription ? '8' : '1');
    if (!ESTRATEGIA_VACINACAO[strategyCode]) throw new DomainError('ESTRATEGIA_INVALIDA', `Estratégia desconhecida: ${strategyCode}`, 400);

    let lot: { id: string; lotNumber: string; expiry: Date; manufacturer: string | null; productId: string } | null = null;
    let locationId: string | null = null;
    if (!transcription) {
      if (!input.lotId) throw new DomainError('LOTE_OBRIGATORIO', 'Escolha o lote do estoque da sala de vacina (ou marque como transcrição da caderneta)', 400);
      const found = await ctx.db.stockLot.findUnique({ where: { id: input.lotId }, include: { product: true } });
      if (!found) throw notFound('Lote');
      if (found.product.vaccineCode !== input.vaccineCode) throw new DomainError('LOTE_INCOMPATIVEL', `O lote ${found.lotNumber} é de ${found.product.description}, não do imunobiológico informado`, 400);
      if (found.expiry.getTime() < new Date(localDateString(appliedAt, ctx.tenant.timeZone)).getTime())
        throw new DomainError('LOTE_VENCIDO', `Lote ${found.lotNumber} vencido em ${localDateString(found.expiry, 'UTC')}`, HttpStatus.UNPROCESSABLE_ENTITY);
      const balances = await ctx.db.stockBalance.findMany({
        where: { lotId: found.id, quantity: { gt: 0 }, location: { unitId: ctx.session.unitId, ...(input.locationId ? { id: input.locationId } : {}) } },
        include: { location: true },
      });
      const balance = balances.sort((a, b) => Number(b.location.kind === 'SALA_DE_VACINA') - Number(a.location.kind === 'SALA_DE_VACINA'))[0];
      if (!balance) throw new DomainError('SALDO_INSUFICIENTE', `Sem saldo do lote ${found.lotNumber} nesta unidade`, HttpStatus.UNPROCESSABLE_ENTITY);
      lot = { id: found.id, lotNumber: found.lotNumber, expiry: found.expiry, manufacturer: found.manufacturer, productId: found.productId };
      locationId = balance.locationId;
    } else if (!input.lotNumber?.trim()) {
      throw new DomainError('LOTE_OBRIGATORIO', 'Informe o lote que consta na caderneta', 400);
    }
    const manufacturerCode = input.manufacturerCode && FABRICANTE_RNDS[input.manufacturerCode] ? input.manufacturerCode : null;
    const manufacturer = (manufacturerCode ? FABRICANTE_RNDS[manufacturerCode] : null) ?? lot?.manufacturer ?? input.manufacturer?.trim() ?? 'Não informado';
    const expiry = lot ? lot.expiry : input.expiry ? new Date(input.expiry) : null;

    const created = await ctx.db.$transaction(async (tx) => {
      const v = await tx.vaccination.create({
        data: {
          patientId: patient.id,
          unitId: ctx.session.unitId,
          professionalId: ctx.session.userId,
          encounterId: input.encounterId ?? null,
          vaccineCode: input.vaccineCode,
          vaccineName,
          lot: lot?.lotNumber ?? input.lotNumber!.trim(),
          manufacturer,
          manufacturerCode,
          expiry,
          lotId: lot?.id ?? null,
          locationId,
          dose: DOSE_VACINA[input.doseCode]!,
          doseCode: input.doseCode,
          route: VIA_ADMINISTRACAO_MEDICAMENTO[routeCode]!,
          routeCode,
          site: input.siteCode ? (LOCAL_APLICACAO_VACINA[input.siteCode] ?? null) : null,
          siteCode: input.siteCode ?? null,
          strategyCode,
          transcription,
          nextDueAt: input.nextDueAt ? new Date(input.nextDueAt) : null,
          appliedAt,
        },
      });
      // Uma dose sai do lote no local de estoque da sala (saldo insuficiente desfaz tudo).
      if (lot && locationId) await debit(tx, locationId, lot.id, 1, { kind: 'ADMINISTRACAO', userId: ctx.session.userId, refType: 'Vaccination', refId: v.id, patientId: patient.id });
      await this.audit.record(ctx, tx, {
        action: transcription ? 'vacina.transcrever' : 'vacina.aplicar',
        entityType: 'Vaccination',
        entityId: v.id,
        payload: { vaccineCode: input.vaccineCode, doseCode: input.doseCode, lot: v.lot, lotId: lot?.id ?? null, strategyCode, transcription },
      });
      if (ctx.tenant.settings.rndsEnabled && !transcription) await this.outbox.enqueue(tx, 'RNDS_IMUNIZACAO', v.id);
      return v;
    });
    return { id: created.id, cartao: await this.cartao(ctx, patient.id) };
  }

  /** Lotes de vacina com saldo nos locais de estoque da unidade (sala de vacina primeiro). */
  async estoque(ctx: RequestContext, locationId?: string) {
    const hoje = new Date(localDateString(new Date(), ctx.tenant.timeZone));
    const balances = await ctx.db.stockBalance.findMany({
      where: { location: { unitId: ctx.session.unitId, ...(locationId ? { id: locationId } : {}) }, lot: { product: { vaccineCode: { not: null } } } },
      include: { location: true, lot: { include: { product: true } } },
    });
    return balances
      .map((b) => ({
        locationId: b.locationId,
        locationName: b.location.name,
        locationKind: b.location.kind,
        lotId: b.lotId,
        lotNumber: b.lot.lotNumber,
        expiry: localDateString(b.lot.expiry, 'UTC'),
        vencido: b.lot.expiry.getTime() < hoje.getTime(),
        manufacturer: b.lot.manufacturer,
        productId: b.lot.productId,
        productDescription: b.lot.product.description,
        vaccineCode: b.lot.product.vaccineCode as string,
        vaccineName: IMUNOBIOLOGICO[b.lot.product.vaccineCode as string] ?? b.lot.product.description,
        quantity: Number(b.quantity),
      }))
      .sort((a, b) => Number(b.locationKind === 'SALA_DE_VACINA') - Number(a.locationKind === 'SALA_DE_VACINA') || a.vaccineName.localeCompare(b.vaccineName, 'pt-BR') || a.expiry.localeCompare(b.expiry));
  }

  private async pessoasDoEscopo(ctx: RequestContext, escopo: { unitId?: string; teamId?: string }, hoje: Date) {
    let dados;
    let escopoNome: string;
    if (escopo.teamId) {
      const team = await ctx.db.team.findUnique({ where: { id: escopo.teamId } });
      if (!team) throw notFound('Equipe');
      dados = await carregarDadosEquipe(ctx.db, { id: team.id, typeCode: team.typeCode, name: team.name, unitId: team.unitId }, new Set(), hoje);
      escopoNome = team.name;
    } else {
      const unit = await ctx.db.unit.findUnique({ where: { id: escopo.unitId ?? ctx.session.unitId } });
      if (!unit) throw notFound('Unidade');
      dados = await carregarDadosUnidade(ctx.db, { id: unit.id, name: unit.name }, hoje);
      escopoNome = unit.name;
    }
    const vacinasPor = new Map<string, DoseAplicada[]>();
    for (const v of dados.vacinas) {
      const arr = vacinasPor.get(v.patientId) ?? [];
      arr.push({ componentes: v.componentes, at: v.at });
      vacinasPor.set(v.patientId, arr);
    }
    const gestantes = new Map<string, Date>();
    for (const c of dados.condicoes) {
      if (!c.active) continue;
      if (c.lineOfCare === 'GESTANTE' || /^Z3[34]/.test(c.code.toUpperCase())) {
        const dum = c.onsetAt ?? c.recordedAt;
        if (hoje.getTime() - dum.getTime() <= 294 * DIA) gestantes.set(c.patientId, dum);
      }
    }
    return {
      escopoNome,
      pessoas: dados.pessoas.map((p) => ({
        patientId: p.id,
        nome: p.name,
        idade: ageInYears(p.birthDate, hoje),
        sexo: p.sex,
        situacoes: aprazar({ birthDate: p.birthDate, sex: p.sex, gestacaoDum: gestantes.get(p.id) ?? null }, vacinasPor.get(p.id) ?? [], hoje),
      })),
    };
  }

  /** Pessoas com doses atrasadas (busca ativa da sala de vacina). */
  async faltosos(ctx: RequestContext, escopo: { unitId?: string; teamId?: string }) {
    const hoje = new Date();
    const { escopoNome, pessoas } = await this.pessoasDoEscopo(ctx, escopo, hoje);
    const rows = pessoas
      .map((p) => ({ ...p, atrasadas: proximasDoses(p.situacoes).filter((s) => s.situacao === 'ATRASADA'), situacoes: undefined }))
      .filter((p) => p.atrasadas.length > 0)
      .sort((a, b) => b.atrasadas.length - a.atrasadas.length || a.nome.localeCompare(b.nome, 'pt-BR'));
    await this.audit.record(ctx, ctx.db, { action: 'vacinas.faltosos', entityType: 'Unit', entityId: escopo.teamId ?? escopo.unitId ?? ctx.session.unitId, payload: { escopo: escopoNome, pessoas: rows.length } });
    return { escopo: escopoNome, ate: hoje.toISOString(), total: pessoas.length, faltosos: rows.length, pessoas: rows.map(({ situacoes: _s, ...r }) => r) };
  }

  /** Doses aprazadas num intervalo de datas (agenda da sala de vacina). */
  async aprazamentos(ctx: RequestContext, escopo: { unitId?: string; teamId?: string }, from: string, to: string) {
    const hoje = new Date();
    const { escopoNome, pessoas } = await this.pessoasDoEscopo(ctx, escopo, hoje);
    const rows: { patientId: string; nome: string; idade: number; dose: SituacaoDose }[] = [];
    for (const p of pessoas) for (const s of proximasDoses(p.situacoes)) if (s.prevista && s.prevista >= from && s.prevista <= to) rows.push({ patientId: p.patientId, nome: p.nome, idade: p.idade, dose: s });
    rows.sort((a, b) => (a.dose.prevista ?? '').localeCompare(b.dose.prevista ?? '') || a.nome.localeCompare(b.nome, 'pt-BR'));
    return { escopo: escopoNome, from, to, total: rows.length, doses: rows };
  }

  /** Certificado de vacinação em PDF (sem assinatura; a assinatura ICP-Brasil é feita pelo módulo de assinaturas). */
  async certificado(ctx: RequestContext, patientId: string): Promise<{ data: Buffer; fileName: string }> {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId }, select: { name: true, cpf: true } });
    const model = await certificadoVacinacaoModel(ctx.db, {
      patientId,
      unitId: ctx.session.unitId,
      userId: ctx.session.userId,
      role: ctx.session.role,
      cbo: ctx.cbo,
      signer: { name: user.name, cpf: user.cpf },
      issuedAt: new Date(),
      timeZone: ctx.tenant.timeZone,
    });
    model.footer.push('Documento sem assinatura digital. A versão assinada com certificado ICP-Brasil pode ser conferida em Validar documento.');
    const data = await renderDocument(model, { reason: 'Certificado de vacinação', location: model.unit.name, contactInfo: ctx.tenant.name });
    await this.audit.record(ctx, ctx.db, { action: 'vacinas.certificado', entityType: 'Patient', entityId: patientId, payload: { doses: model.sections[1]?.paragraphs.length ?? 0 } });
    return { data, fileName: `certificado-vacinacao-${patientId.slice(0, 8)}.pdf` };
  }
}
