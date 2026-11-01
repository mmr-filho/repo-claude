import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { codigoAcessoDe, isValidCpf, localDateString, mascararTelefone, onlyDigits } from '@omnisaude/shared';
import { buildAccessCodeTemplate, normalizeBrazilPhone } from '@omnisaude/messaging';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { TenantsService } from '../../core/database';
import { DomainError, notFound } from '../../core/errors';
import { TokenService } from '../../core/tokens';
import { MessagingService, type SystemContext } from '../integrations/messaging.service';

const VALIDADE_WHATSAPP_MIN = 10;
const VALIDADE_RECEPCAO_H = 24;
const MAX_TENTATIVAS = 5;
const MAX_PEDIDOS_15MIN = 3;

const hash = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * Acesso do cidadão ao app: CPF e data de nascimento identificam o cadastro; um código de uso único chega pelo
 * WhatsApp (10 minutos) ou é entregue pela recepção (24 horas). O código confirma a identidade e abre uma sessão
 * de 12 horas (token "citizen"). Nunca revela se o CPF existe.
 */
@Injectable()
export class CitizenAuthService {
  constructor(
    private readonly tenants: TenantsService,
    private readonly tokens: TokenService,
    private readonly messaging: MessagingService,
    private readonly audit: AuditService,
  ) {}

  private async localizar(input: { tenant: string; cpf: string; birthDate: string }) {
    const cpf = onlyDigits(input.cpf);
    if (!isValidCpf(cpf) || !/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate)) return null;
    let tenant;
    try {
      tenant = await this.tenants.resolve(input.tenant.trim().toLowerCase());
    } catch {
      return null;
    }
    const db = await this.tenants.client(tenant.id);
    const patient = await db.patient.findUnique({ where: { cpf }, select: { id: true, name: true, socialName: true, phone: true, whatsappOptIn: true, birthDate: true, mergedIntoId: true } });
    if (!patient || patient.mergedIntoId || localDateString(patient.birthDate, 'UTC') !== input.birthDate) return null;
    return { sys: { tenant, db } as SystemContext, patient };
  }

  /** Pede o código: resposta genérica (sem confirmar a existência do cadastro); envia pelo WhatsApp quando há consentimento. */
  async solicitar(input: { tenant: string; cpf: string; birthDate: string }, ip: string) {
    const generico = { canal: 'nenhum' as const, orientacao: 'Se o cadastro existir e tiver WhatsApp autorizado, o código chega em instantes. Sem WhatsApp, peça o código de acesso na recepção da sua unidade de saúde.' };
    const found = await this.localizar(input);
    if (!found) return generico;
    const { sys, patient } = found;
    const recentes = await sys.db.citizenAccessCode.count({ where: { patientId: patient.id, channel: 'WHATSAPP', createdAt: { gte: new Date(Date.now() - 15 * 60_000) } } });
    if (recentes >= MAX_PEDIDOS_15MIN) throw new DomainError('MUITOS_PEDIDOS', 'Muitos pedidos de código em pouco tempo. Aguarde alguns minutos.', HttpStatus.TOO_MANY_REQUESTS);
    const phone = patient.phone ? normalizeBrazilPhone(patient.phone) : null;
    if (!phone || !patient.whatsappOptIn || !sys.tenant.settings.whatsappEnabled) return generico;
    const code = codigoAcessoDe(randomBytes(4));
    await sys.db.citizenAccessCode.create({ data: { patientId: patient.id, codeHash: hash(code), channel: 'WHATSAPP', phone, expiresAt: new Date(Date.now() + VALIDADE_WHATSAPP_MIN * 60_000), ip } });
    const template = buildAccessCodeTemplate({ patientName: patient.socialName ?? patient.name, code, validMinutes: VALIDADE_WHATSAPP_MIN });
    await this.messaging.sendTemplateNow(sys, patient.id, phone, template);
    return { canal: 'whatsapp' as const, telefone: mascararTelefone(patient.phone), validadeMinutos: VALIDADE_WHATSAPP_MIN };
  }

  /** Confere o código (até 5 tentativas por código) e abre a sessão do cidadão. */
  async confirmar(input: { tenant: string; cpf: string; birthDate: string; codigo: string }, ip: string) {
    const invalido = () => new DomainError('CODIGO_INVALIDO', 'Código inválido ou vencido. Peça um novo código.', HttpStatus.UNAUTHORIZED);
    const found = await this.localizar(input);
    if (!found) throw invalido();
    const { sys, patient } = found;
    const codigo = onlyDigits(input.codigo);
    const candidatos = await sys.db.citizenAccessCode.findMany({
      where: { patientId: patient.id, usedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_TENTATIVAS } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const certo = candidatos.find((c) => c.codeHash === hash(codigo));
    if (!certo) {
      if (candidatos.length) await sys.db.citizenAccessCode.updateMany({ where: { id: { in: candidatos.map((c) => c.id) } }, data: { attempts: { increment: 1 } } });
      throw invalido();
    }
    await sys.db.citizenAccessCode.update({ where: { id: certo.id }, data: { usedAt: new Date(), ip } });
    const token = await this.tokens.sign({ stage: 'citizen', tid: sys.tenant.id, tslug: sys.tenant.slug, sub: patient.id, mfa: false });
    return {
      token,
      cidadao: { id: patient.id, nome: patient.socialName ?? patient.name, primeiroNome: (patient.socialName ?? patient.name).split(' ')[0] },
      instituicao: { slug: sys.tenant.slug, nome: sys.tenant.name },
    };
  }

  /** A recepção entrega um código ao cidadão sem WhatsApp (vale 24 horas; fica na auditoria). */
  async codigoRecepcao(ctx: RequestContext, patientId: string) {
    const patient = await ctx.db.patient.findUnique({ where: { id: patientId }, select: { id: true, name: true, cpf: true, mergedIntoId: true } });
    if (!patient || patient.mergedIntoId) throw notFound('Paciente');
    if (!patient.cpf) throw new DomainError('SEM_CPF', 'O acesso ao app exige CPF no cadastro', HttpStatus.UNPROCESSABLE_ENTITY);
    const code = codigoAcessoDe(randomBytes(4));
    const expiresAt = new Date(Date.now() + VALIDADE_RECEPCAO_H * 3_600_000);
    await ctx.db.citizenAccessCode.create({ data: { patientId, codeHash: hash(code), channel: 'RECEPCAO', expiresAt, createdBy: ctx.session.userId, ip: ctx.ip } });
    await this.audit.recordStandalone(ctx, { action: 'cidadao.codigo_recepcao', entityType: 'Patient', entityId: patientId, payload: { expiresAt } });
    return {
      codigo: code,
      validoAte: expiresAt.toISOString(),
      validadeHoras: VALIDADE_RECEPCAO_H,
      instrucoes: `Acesse o app do cidadão com o CPF ${patient.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')}, a data de nascimento e este código.`,
    };
  }
}
