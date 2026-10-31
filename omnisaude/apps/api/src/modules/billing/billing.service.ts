import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantClient } from '@omnisaude/database';
import { ageInYears, competencia as competenciaOf, localDateString } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import type { RequestContext } from '../../core/context';
import { TenantsService } from '../../core/database';
import { DomainError, notFound } from '../../core/errors';
import { BPA_C_LINE, BPA_I_LINE, controlField, renderHeader, renderLine, sheetPosition, validateBpaFile, type BpaValidation } from './bpa-layout';
import { competenciaRange } from './calendar';
import { evaluateRecord, type ProcedureRules } from './pre-glosa';
import { readSigtapTables } from './sigtap-parser';
import { readZip } from './zip';

type Instrument = 'BPA_I' | 'BPA_C' | 'APAC' | 'AIH';
type ProductionStatus = 'PENDENTE' | 'VALIDADO' | 'GLOSA_PREVISTA' | 'EXPORTADO';

const CHUNK = 5000;

function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger('Faturamento');

  constructor(
    private readonly audit: AuditService,
    private readonly tenants: TenantsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ───────────────────────────── SIGTAP ─────────────────────────────

  /** Carrega um pacote da Tabela Unificada, substituindo procedimentos e compatibilidades. */
  async loadSigtap(db: TenantClient, zip: Buffer, source: string) {
    const startedAt = new Date();
    let tables;
    try {
      tables = readSigtapTables(readZip(zip));
    } catch (err) {
      await db.sigtapSync.create({ data: { competencia: '000000', source, status: 'ERRO', error: (err as Error).message, finishedAt: new Date() } });
      throw new DomainError('SIGTAP_INVALIDA', `Pacote SIGTAP inválido: ${(err as Error).message}`);
    }
    const competencia = tables.competencia || competenciaOf(startedAt);
    await db.$transaction(
      async (tx) => {
        await tx.sigtapProcedureCbo.deleteMany();
        await tx.sigtapProcedureCid.deleteMany();
        await tx.sigtapProcedure.deleteMany();
        for (const part of chunks(tables.procedures)) {
          await tx.sigtapProcedure.createMany({
            data: part.map((p) => ({
              code: p.code,
              name: p.name,
              complexity: p.complexity,
              sex: p.sex,
              minAgeMonths: p.minAgeMonths,
              maxAgeMonths: p.maxAgeMonths,
              maxQuantity: p.maxQuantity,
              valueSh: p.valueSh,
              valueSa: p.valueSa,
              valueSp: p.valueSp,
              instruments: [...(tables.instruments.get(p.code) ?? [])].sort(),
              competencia: p.competencia || competencia,
            })),
          });
        }
        for (const part of chunks(tables.cbo)) await tx.sigtapProcedureCbo.createMany({ data: part });
        for (const part of chunks(tables.cid)) await tx.sigtapProcedureCid.createMany({ data: part });
      },
      { timeout: 300_000, maxWait: 10_000 },
    );
    const sync = await db.sigtapSync.create({
      data: { competencia, source, status: 'CONCLUIDA', procedures: tables.procedures.length, startedAt, finishedAt: new Date() },
    });
    return { syncId: sync.id, competencia, procedures: tables.procedures.length, cboLinks: tables.cbo.length, cidLinks: tables.cid.length };
  }

  async importSigtap(ctx: RequestContext, zip: Buffer) {
    const result = await this.loadSigtap(ctx.db, zip, 'UPLOAD');
    await this.audit.recordStandalone(ctx, { action: 'sigtap.importar', entityType: 'SigtapSync', entityId: result.syncId, payload: result });
    return result;
  }

  /**
   * Baixa e carrega a tabela da competência (SIGTAP_ZIP_URL com {competencia}). É o mesmo método
   * chamado pelo job mensal do primeiro dia útil; sem URL configurada, a carga é pelo upload.
   */
  async syncCompetencia(tenantId: string, competencia: string) {
    const template = this.config.SIGTAP_ZIP_URL;
    if (!template) {
      throw new DomainError('SIGTAP_SEM_ORIGEM', 'SIGTAP_ZIP_URL não configurada: use a importação manual do pacote (contingência)', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const db = await this.tenants.client(tenantId);
    const url = template.replaceAll('{competencia}', competencia);
    let zip: Buffer;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      zip = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      await db.sigtapSync.create({ data: { competencia, source: 'DATASUS', status: 'ERRO', error: `Download falhou: ${(err as Error).message}`, finishedAt: new Date() } });
      throw new DomainError('SIGTAP_DOWNLOAD', `Não foi possível baixar a SIGTAP de ${competencia}: ${(err as Error).message}`, HttpStatus.BAD_GATEWAY);
    }
    this.logger.log(`SIGTAP ${competencia} baixada (${zip.length} bytes) para o tenant ${tenantId}`);
    return this.loadSigtap(db, zip, 'DATASUS');
  }

  async sync(ctx: RequestContext, competencia: string) {
    const result = await this.syncCompetencia(ctx.tenant.id, competencia);
    await this.audit.recordStandalone(ctx, { action: 'sigtap.sincronizar', entityType: 'SigtapSync', entityId: result.syncId, payload: result });
    return result;
  }

  async syncHistory(ctx: RequestContext) {
    return ctx.db.sigtapSync.findMany({ orderBy: { startedAt: 'desc' }, take: 24 });
  }

  async procedures(ctx: RequestContext, q: string) {
    const digits = q.replace(/\D/g, '');
    return ctx.db.sigtapProcedure.findMany({
      where: digits.length >= 4 ? { code: { startsWith: digits } } : { name: { contains: q.toUpperCase() } },
      take: 30,
      orderBy: { code: 'asc' },
    });
  }

  // ───────────────────────────── Produção ─────────────────────────────

  async listProduction(ctx: RequestContext, filter: { competencia: string; status?: ProductionStatus; unitId?: string }) {
    const rows = await ctx.db.productionRecord.findMany({
      where: { competencia: filter.competencia, ...(filter.status ? { status: filter.status } : {}), ...(filter.unitId ? { unitId: filter.unitId } : {}) },
      orderBy: [{ performedAt: 'asc' }],
    });
    const [patients, users, units, procs] = await Promise.all([
      ctx.db.patient.findMany({ where: { id: { in: rows.map((r) => r.patientId).filter((x): x is string => !!x) } }, select: { id: true, name: true, cns: true } }),
      ctx.db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.professionalId))] } }, select: { id: true, name: true } }),
      ctx.db.unit.findMany({ select: { id: true, name: true, cnes: true } }),
      ctx.db.sigtapProcedure.findMany({ where: { code: { in: [...new Set(rows.map((r) => r.procedureCode))] } }, select: { code: true, name: true } }),
    ]);
    const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
    const p = byId(patients);
    const u = byId(users);
    const un = byId(units);
    const pr = new Map(procs.map((x) => [x.code, x.name]));
    const items = rows.map((r) => ({
      id: r.id,
      competencia: r.competencia,
      unit: un.get(r.unitId)?.name ?? null,
      unitId: r.unitId,
      patient: r.patientId ? (p.get(r.patientId) ?? null) : null,
      professional: u.get(r.professionalId)?.name ?? null,
      cbo: r.cbo,
      procedureCode: r.procedureCode,
      procedureName: pr.get(r.procedureCode) ?? null,
      cid: r.cid,
      quantity: r.quantity,
      performedAt: r.performedAt,
      instrument: r.instrument,
      status: r.status,
      issues: r.issues,
    }));
    const summary = { total: items.length, PENDENTE: 0, VALIDADO: 0, GLOSA_PREVISTA: 0, EXPORTADO: 0 } as Record<string, number>;
    for (const i of items) summary[i.status] = (summary[i.status] ?? 0) + 1;
    return { competencia: filter.competencia, summary, items };
  }

  async createProduction(
    ctx: RequestContext,
    input: { unitId?: string; patientId?: string; professionalId?: string; cbo?: string; procedureCode: string; cid?: string; quantity: number; performedAt: string; instrument: Instrument },
  ) {
    const performedAt = new Date(input.performedAt);
    if (Number.isNaN(performedAt.getTime())) throw new DomainError('DATA_INVALIDA', 'Data de realização inválida');
    const unitId = input.unitId ?? ctx.session.unitId;
    let cbo = input.cbo ?? '';
    const professionalId = input.professionalId ?? ctx.session.userId;
    if (!cbo) {
      const a = await ctx.db.userAssignment.findFirst({ where: { userId: professionalId, unitId, active: true }, orderBy: { role: 'asc' } });
      if (!a) throw new DomainError('CBO_DESCONHECIDO', 'Informe o CBO: o profissional não tem lotação na unidade');
      cbo = a.cbo;
    }
    const record = await ctx.db.$transaction(async (tx) => {
      const r = await tx.productionRecord.create({
        data: {
          unitId,
          competencia: competenciaOf(performedAt, ctx.tenant.timeZone),
          patientId: input.patientId ?? null,
          professionalId,
          cbo,
          procedureCode: input.procedureCode.replace(/\D/g, ''),
          cid: input.cid ? input.cid.replace(/\W/g, '').toUpperCase() : null,
          quantity: input.quantity,
          performedAt,
          instrument: input.instrument,
        },
      });
      await this.audit.record(ctx, tx, { action: 'producao.lancar', entityType: 'ProductionRecord', entityId: r.id, payload: input });
      return r;
    });
    return record;
  }

  // ───────────────────────────── Crítica pré-glosa ─────────────────────────────

  async critique(ctx: RequestContext, input: { competencia: string; unitId?: string }) {
    const db = ctx.db;
    const records = await db.productionRecord.findMany({
      where: { competencia: input.competencia, status: { not: 'EXPORTADO' }, ...(input.unitId ? { unitId: input.unitId } : {}) },
    });
    const codes = [...new Set(records.map((r) => r.procedureCode))];
    const [procs, cbos, cids, patients, professionals, totals] = await Promise.all([
      db.sigtapProcedure.findMany({ where: { code: { in: codes } } }),
      db.sigtapProcedureCbo.findMany({ where: { procedureCode: { in: codes } } }),
      db.sigtapProcedureCid.findMany({ where: { procedureCode: { in: codes } } }),
      db.patient.findMany({ where: { id: { in: records.map((r) => r.patientId).filter((x): x is string => !!x) } } }),
      db.user.findMany({ where: { id: { in: [...new Set(records.map((r) => r.professionalId))] } }, select: { id: true, cns: true } }),
      db.productionRecord.groupBy({
        by: ['patientId', 'procedureCode'],
        where: { competencia: input.competencia, patientId: { not: null } },
        _sum: { quantity: true },
      }),
    ]);
    const rules = new Map<string, ProcedureRules>(procs.map((p) => [p.code, { ...p, cbos: new Set<string>(), cids: new Set<string>() }]));
    for (const c of cbos) rules.get(c.procedureCode)?.cbos.add(c.cbo);
    for (const c of cids) rules.get(c.procedureCode)?.cids.add(c.cid);
    const patientById = new Map(patients.map((p) => [p.id, p]));
    const cnsByUser = new Map(professionals.map((u) => [u.id, u.cns]));
    const quantity = new Map(totals.map((t) => [`${t.patientId}|${t.procedureCode}`, t._sum.quantity ?? 0]));

    const results = records.map((r) => {
      const patient = r.patientId ? patientById.get(r.patientId) : undefined;
      const issues = evaluateRecord(
        {
          procedureCode: r.procedureCode,
          cbo: r.cbo,
          cid: r.cid,
          instrument: r.instrument,
          performedAt: r.performedAt,
          patient: patient ? { sex: patient.sex, birthDate: patient.birthDate, cns: patient.cns, cpf: patient.cpf } : null,
          professionalCns: cnsByUser.get(r.professionalId) ?? null,
          patientQuantityInCompetencia: r.patientId ? (quantity.get(`${r.patientId}|${r.procedureCode}`) ?? r.quantity) : r.quantity,
        },
        rules.get(r.procedureCode),
      );
      return { id: r.id, procedureCode: r.procedureCode, status: (issues.length ? 'GLOSA_PREVISTA' : 'VALIDADO') as ProductionStatus, issues };
    });

    await db.$transaction(
      async (tx) => {
        for (const r of results) {
          await tx.productionRecord.update({ where: { id: r.id }, data: { status: r.status, issues: r.issues as unknown as object } });
        }
        await this.audit.record(ctx, tx, {
          action: 'faturamento.criticar',
          entityType: 'ProductionRecord',
          payload: { competencia: input.competencia, unitId: input.unitId ?? null, results: results.map((r) => [r.id, r.status]) },
        });
      },
      { timeout: 120_000 },
    );

    const byRule: Record<string, number> = {};
    for (const r of results) for (const i of r.issues) byRule[i.rule] = (byRule[i.rule] ?? 0) + 1;
    return {
      competencia: input.competencia,
      total: results.length,
      validated: results.filter((r) => r.status === 'VALIDADO').length,
      glosas: results.filter((r) => r.status === 'GLOSA_PREVISTA').length,
      byRule,
      records: results,
    };
  }

  // ───────────────────────────── Exportação BPA ─────────────────────────────

  async exportBpa(ctx: RequestContext, input: { competencia: string; unitId: string; instrument: 'BPA_I' | 'BPA_C'; destinationName?: string; destinationType?: 'M' | 'E' }) {
    const db = ctx.db;
    const tz = ctx.tenant.timeZone;
    const unit = await db.unit.findUnique({ where: { id: input.unitId } });
    if (!unit) throw notFound('Unidade');
    const records = await db.productionRecord.findMany({
      where: { unitId: unit.id, competencia: input.competencia, instrument: input.instrument, status: 'VALIDADO' },
      orderBy: [{ performedAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (records.length === 0) {
      throw new DomainError('SEM_PRODUCAO_VALIDADA', 'Não há produção validada pela crítica para exportar nesta competência e instrumento');
    }
    const tenant = await this.tenants.master.tenant.findUnique({ where: { id: ctx.tenant.id } });
    const patients = new Map((await db.patient.findMany({ where: { id: { in: records.map((r) => r.patientId).filter((x): x is string => !!x) } } })).map((p) => [p.id, p]));
    const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(records.map((r) => r.professionalId))] } } })).map((u) => [u.id, u]));

    const ageAt = (patientId: string | null, at: Date) => {
      const p = patientId ? patients.get(patientId) : undefined;
      return p ? Math.max(0, ageInYears(p.birthDate, at)) : 0;
    };

    let lines: { text: string; procedureCode: string; quantity: number }[];
    if (input.instrument === 'BPA_C') {
      // Consolidado: soma por CBO + procedimento + idade.
      const groups = new Map<string, { cbo: string; procedureCode: string; age: number; quantity: number }>();
      for (const r of records) {
        const age = ageAt(r.patientId, r.performedAt);
        const key = `${r.cbo}|${r.procedureCode}|${age}`;
        const g = groups.get(key) ?? { cbo: r.cbo, procedureCode: r.procedureCode, age, quantity: 0 };
        g.quantity += r.quantity;
        groups.set(key, g);
      }
      lines = [...groups.values()].map((g, i) => {
        const { sheet, seq } = sheetPosition(i);
        return {
          procedureCode: g.procedureCode,
          quantity: g.quantity,
          text: renderLine(BPA_C_LINE, {
            'prd-cnes': unit.cnes,
            'prd-cmp': input.competencia,
            'prd-cbo': g.cbo,
            'prd-flh': sheet,
            'prd-seq': seq,
            'prd-pa': g.procedureCode,
            'prd-idade': g.age,
            'prd-qt': g.quantity,
          }),
        };
      });
    } else {
      const urgent = unit.type === 'UPA' || unit.type === 'SAMU';
      // INE: equipe ativa do profissional nesta unidade (CNES), quando houver.
      const teams = await db.team.findMany({ where: { unitId: unit.id, active: true }, include: { members: { where: { active: true, userId: { in: [...users.keys()] } } } } });
      const ineByUser = new Map<string, string>();
      for (const team of teams) for (const m of team.members) if (m.userId && !ineByUser.has(m.userId)) ineByUser.set(m.userId, team.ine);
      const phoneDigits = (phone: string | null | undefined) => {
        const d = (phone ?? '').replace(/\D/g, '');
        return d.length > 11 && d.startsWith('55') ? d.slice(-11) : d.slice(0, 11);
      };
      lines = records.map((r, i) => {
        const { sheet, seq } = sheetPosition(i);
        const p = r.patientId ? patients.get(r.patientId) : undefined;
        const prof = users.get(r.professionalId);
        // O layout aceita um só documento do paciente: CNS quando houver, senão CPF.
        const cns = p?.cns ?? '';
        const cpf = cns ? '' : (p?.cpf ?? '');
        return {
          procedureCode: r.procedureCode,
          quantity: r.quantity,
          text: renderLine(BPA_I_LINE, {
            'prd-cnes': unit.cnes,
            'prd-cmp': input.competencia,
            'prd-cnsmed': prof?.cns ?? '',
            'prd-cbo': r.cbo,
            'prd-dtaten': localDateString(r.performedAt, tz).replace(/-/g, ''),
            'prd-flh': sheet,
            'prd-seq': seq,
            'prd-pa': r.procedureCode,
            'prd-cnspac': cns,
            'prd-sexo': p?.sex ?? '',
            'prd-ibge': (p?.ibgeCode ?? unit.ibgeCode).slice(0, 6),
            'prd-cid': r.cid ?? '',
            'prd-idade': ageAt(r.patientId, r.performedAt),
            'prd-qt': r.quantity,
            'prd-caten': urgent ? '02' : '01',
            'prd-naut': '',
            'prd-nmpac': p?.name ?? '',
            'prd-dtnasc': p ? p.birthDate.toISOString().slice(0, 10).replace(/-/g, '') : '',
            'prd-raca': p?.racaCor ?? '99',
            'prd-etnia': p?.racaCor === '05' ? (p.etnia ?? '') : '',
            'prd-nac': p?.nationality ?? '010',
            'prd-cep-pcnte': p?.cep ?? '',
            'prd-end-pcnte': p?.street ?? '',
            'prd-compl-pcnte': p?.complement ?? '',
            'prd-num-pcnte': p?.number ?? (p?.street ? 'SN' : ''),
            'prd-bairro-pcnte': p?.district ?? '',
            'prd-ddtel-pcnte': phoneDigits(p?.phone),
            'prd-email-pcnte': p?.email ?? '',
            'prd-ine': ineByUser.get(r.professionalId) ?? '',
            'prd-cpf-pcnte': cpf,
            'prd-situacao-rua': p ? (p.homeless ? 'S' : 'N') : '',
          }),
        };
      });
    }

    const control = controlField(lines);
    const header = renderHeader({
      competencia: input.competencia,
      lines: lines.length,
      sheets: sheetPosition(lines.length - 1).sheet,
      originName: tenant?.name ?? ctx.tenant.name,
      originAcronym: ctx.tenant.slug.replace(/[^a-z0-9]/gi, '').slice(0, 6),
      originCnpj: tenant?.cnpj ?? '',
      destinationName: input.destinationName ?? 'SECRETARIA MUNICIPAL DE SAUDE',
      destinationType: input.destinationType ?? 'M',
      control,
    });
    const content = [header, ...lines.map((l) => l.text)].join('\r\n') + '\r\n';
    const fileName = `BPA_${unit.cnes}_${input.competencia}_${input.instrument}.txt`;
    // Conferência do arquivo contra o layout antes de guardar: um erro aqui é defeito do gerador, não do dado.
    const validation = validateBpaFile(content);
    if (!validation.ok) throw new DomainError('BPA_INVALIDO', 'O arquivo gerado não passou na conferência do layout', HttpStatus.INTERNAL_SERVER_ERROR, validation.issues);

    const exported = await db.$transaction(async (tx) => {
      const e = await tx.billingExport.create({
        data: {
          unitId: unit.id,
          competencia: input.competencia,
          instrument: input.instrument,
          fileName,
          content,
          lines: lines.length,
          controlField: String(control),
          createdBy: ctx.session.userId,
        },
      });
      await tx.productionRecord.updateMany({ where: { id: { in: records.map((r) => r.id) } }, data: { status: 'EXPORTADO', exportId: e.id } });
      await this.audit.record(ctx, tx, {
        action: 'faturamento.exportar',
        entityType: 'BillingExport',
        entityId: e.id,
        payload: { fileName, records: records.map((r) => r.id), control },
      });
      return e;
    });
    return { id: exported.id, fileName, lines: lines.length, records: records.length, controlField: control, validation: summarize(validation) };
  }

  /** Confere um arquivo BPA (gerado aqui ou por outro sistema) contra o layout oficial. */
  validateFile(content: string): BpaValidation {
    if (!content.trim()) throw new DomainError('ARQUIVO_VAZIO', 'Envie o conteúdo do arquivo BPA (.txt)');
    return validateBpaFile(content);
  }

  async validateExport(ctx: RequestContext, id: string): Promise<BpaValidation> {
    const e = await this.getExport(ctx, id);
    return validateBpaFile(e.content);
  }

  async listExports(ctx: RequestContext, competencia?: string) {
    const rows = await ctx.db.billingExport.findMany({
      where: competencia ? { competencia } : {},
      orderBy: { createdAt: 'desc' },
      select: { id: true, unitId: true, competencia: true, instrument: true, fileName: true, lines: true, controlField: true, createdAt: true, createdBy: true },
    });
    return rows;
  }

  async getExport(ctx: RequestContext, id: string) {
    const e = await ctx.db.billingExport.findUnique({ where: { id } });
    if (!e) throw notFound('Arquivo de produção');
    return e;
  }

  // ───────────────────────────── Espelho de AIH ─────────────────────────────

  /** Espelho (conferência) das internações da competência. A exportação do lote AIH para o SIH/SUS não faz parte deste módulo. */
  async aihMirror(ctx: RequestContext, competencia: string) {
    const { start, end } = competenciaRange(competencia, ctx.tenant.timeZone);
    const admissions = await ctx.db.admission.findMany({
      where: {
        OR: [{ admittedAt: { gte: start, lt: end } }, { dischargedAt: { gte: start, lt: end } }, { admittedAt: { lt: end }, dischargedAt: null }],
      },
      include: { encounter: { include: { patient: true, unit: true } }, bed: { include: { ward: true } } },
      orderBy: { admittedAt: 'asc' },
    });
    const procedures = await ctx.db.productionRecord.findMany({
      where: { encounterId: { in: admissions.map((a) => a.encounterId) } },
    });
    const names = new Map((await ctx.db.sigtapProcedure.findMany({ where: { code: { in: [...new Set(procedures.map((p) => p.procedureCode))] } } })).map((p) => [p.code, p.name]));
    const DAY = 86_400_000;
    return {
      competencia,
      note: 'Espelho para conferência. A geração do lote AIH para o SIH/SUS ainda não está implementada.',
      items: admissions.map((a) => {
        const until = a.dischargedAt && a.dischargedAt < end ? a.dischargedAt : new Date(Math.min(Date.now(), end.getTime()));
        return {
          admissionId: a.id,
          patient: a.encounter.patient.name,
          cns: a.encounter.patient.cns,
          unit: a.encounter.unit.name,
          ward: a.bed?.ward.name ?? null,
          bed: a.bed?.code ?? null,
          mainCid: a.mainCid,
          aihNumber: a.aihNumber,
          regulationCode: a.regulationCode,
          admittedAt: a.admittedAt,
          dischargedAt: a.dischargedAt,
          days: Math.max(0, Math.ceil((until.getTime() - a.admittedAt.getTime()) / DAY)),
          status: a.dischargedAt ? 'ALTA' : 'INTERNADO',
          procedures: procedures.filter((p) => p.encounterId === a.encounterId).map((p) => ({ code: p.procedureCode, name: names.get(p.procedureCode) ?? null, quantity: p.quantity, status: p.status })),
        };
      }),
    };
  }
}

function summarize(v: BpaValidation) {
  return { ok: v.ok, errors: v.errors, warnings: v.warnings, layout: v.layout, issues: v.issues.slice(0, 50) };
}
