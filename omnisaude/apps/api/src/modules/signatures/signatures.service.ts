import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { TenantClient } from '@omnisaude/database';
import { ROLE_LABELS, type Role } from '@omnisaude/shared';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../../core/audit.service';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import type { RequestContext } from '../../core/context';
import { certificadoVacinacaoModel } from '../vaccines/certificate';
import { decryptSecret, encryptSecret } from '../../core/crypto';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { StorageService } from '../../core/storage.service';
import { describeCertificate, parsePfx, PfxError, verifyPdfSignatures, type ParsedPfx } from './cms';
import { formatDateTime, maskCpf, renderDocument, signPdf, type DocumentModel } from './pdf';

export type SignableEntity = 'ClinicalNote' | 'Prescription' | 'VaccinationCertificate';
export type SignedKind = 'PRONTUARIO' | 'RECEITA' | 'ATESTADO' | 'DOCUMENTO';

type CertificateRow = NonNullable<Awaited<ReturnType<TenantClient['signingCertificate']['findFirst']>>>;
type DocumentRow = NonNullable<Awaited<ReturnType<TenantClient['signedDocument']['findFirst']>>>;

const MAX_PFX_BYTES = 64 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const NOTE_TITLES: Record<string, string> = {
  SOAP: 'Registro de atendimento',
  EVOLUCAO: 'Evolução clínica',
  ODONTOGRAMA: 'Odontograma',
  LAUDO_INTERNACAO: 'Laudo para internação',
  SUMARIO_ALTA: 'Sumário de alta',
  ATESTADO: 'Atestado',
};
const SOAP_HEADINGS: [key: 'subjective' | 'objective' | 'assessment' | 'plan', label: string][] = [
  ['subjective', 'Subjetivo'],
  ['objective', 'Objetivo'],
  ['assessment', 'Avaliação'],
  ['plan', 'Plano'],
];
const REASONS: Record<SignedKind, string> = {
  PRONTUARIO: 'Assinatura do registro clínico',
  RECEITA: 'Assinatura da prescrição',
  ATESTADO: 'Assinatura do atestado',
  DOCUMENTO: 'Assinatura do documento',
};
const ROUTE_LABELS: Record<string, string> = {
  ORAL: 'via oral',
  IV: 'intravenosa',
  IM: 'intramuscular',
  SC: 'subcutânea',
  TOPICA: 'tópica',
  INALATORIA: 'inalatória',
  RETAL: 'retal',
  OFTALMICA: 'oftálmica',
  NASAL: 'nasal',
  SUBLINGUAL: 'sublingual',
  OUTRA: 'outra via',
};

function formatCode(stored: string): string {
  const [system, code] = stored.split(':');
  return code ? `${system === 'CID10' ? 'CID-10' : system === 'CIAP2' ? 'CIAP-2' : system} ${code}` : stored;
}

/**
 * Assinatura digital ICP-Brasil com certificado A1 guardado no servidor: o profissional envia o .pfx uma vez
 * (fica cifrado com a chave do servidor) e informa a senha a cada assinatura. O documento sai em PDF/PAdES,
 * vai para o armazenamento de objetos e fica registrado para consulta e validação.
 */
@Injectable()
export class SignaturesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ── Certificados ─────────────────────────────────────────────────────────

  async myCertificate(ctx: RequestContext) {
    const cert = await ctx.db.signingCertificate.findFirst({
      where: { userId: ctx.session.userId, active: true },
      orderBy: { createdAt: 'desc' },
    });
    return { certificate: cert ? this.publicCertificate(cert) : null };
  }

  async registerCertificate(ctx: RequestContext, input: { pfxBase64: string; password: string }) {
    const pfx = Buffer.from(input.pfxBase64, 'base64');
    if (!pfx.length || pfx.length > MAX_PFX_BYTES) throw new DomainError('ARQUIVO_INVALIDO', 'Envie o arquivo .pfx/.p12 do certificado (até 64 KB)');
    const parsed = this.open(pfx, input.password);
    const info = describeCertificate(parsed.leaf, parsed.chain);
    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: ctx.session.userId },
      select: { cpf: true },
    });
    if (!info.cpf) throw new DomainError('CERTIFICADO_SEM_CPF', 'O certificado não traz o CPF do titular (campo de pessoa física da ICP-Brasil). Use um e-CPF.');
    if (info.cpf !== user.cpf) throw new DomainError('CERTIFICADO_CPF_DIVERGENTE', `O certificado pertence ao CPF ${maskCpf(info.cpf)}; a sua conta é do CPF ${maskCpf(user.cpf)}`);
    const now = new Date();
    if (info.notAfter < now) throw new DomainError('CERTIFICADO_VENCIDO', `Certificado vencido em ${formatDateTime(info.notAfter, ctx.tenant.timeZone)}`);
    if (info.notBefore > now) throw new DomainError('CERTIFICADO_FUTURO', 'O certificado ainda não está no período de validade');
    if (!info.canSign) throw new DomainError('CERTIFICADO_NAO_ASSINA', 'O certificado não permite assinatura digital (uso de chave)');
    const sealed = encryptSecret(pfx.toString('base64'), this.config.DATA_KEY);
    const created = await ctx.db.$transaction(async (tx) => {
      await tx.signingCertificate.updateMany({
        where: { userId: ctx.session.userId, active: true },
        data: { active: false, revokedAt: now },
      });
      const cert = await tx.signingCertificate.create({
        data: {
          userId: ctx.session.userId,
          subject: info.subject,
          cpf: info.cpf!,
          issuer: info.issuer,
          serial: info.serial,
          notBefore: info.notBefore,
          notAfter: info.notAfter,
          icpBrasil: info.icpBrasil,
          fingerprint: info.fingerprint,
          pfxEncrypted: sealed,
        },
      });
      await this.audit.record(ctx, tx, {
        action: 'certificado.cadastrar',
        entityType: 'SigningCertificate',
        entityId: cert.id,
        payload: {
          subject: info.subject,
          issuer: info.issuer,
          fingerprint: info.fingerprint,
          notAfter: info.notAfter,
          icpBrasil: info.icpBrasil,
        },
      });
      return cert;
    });
    return {
      certificate: {
        ...this.publicCertificate(created),
        chainError: info.chainError,
      },
    };
  }

  async revokeCertificate(ctx: RequestContext) {
    const cert = await ctx.db.signingCertificate.findFirst({
      where: { userId: ctx.session.userId, active: true },
    });
    if (!cert) throw notFound('Certificado');
    await ctx.db.$transaction(async (tx) => {
      await tx.signingCertificate.update({
        where: { id: cert.id },
        data: { active: false, revokedAt: new Date() },
      });
      await this.audit.record(ctx, tx, {
        action: 'certificado.remover',
        entityType: 'SigningCertificate',
        entityId: cert.id,
        payload: { fingerprint: cert.fingerprint },
      });
    });
    return { ok: true };
  }

  private publicCertificate(c: CertificateRow) {
    const now = Date.now();
    return {
      id: c.id,
      subject: c.subject,
      cpf: c.cpf,
      issuer: c.issuer,
      serial: c.serial,
      notBefore: c.notBefore,
      notAfter: c.notAfter,
      icpBrasil: c.icpBrasil,
      fingerprint: c.fingerprint,
      active: c.active,
      createdAt: c.createdAt,
      expired: c.notAfter.getTime() < now,
      daysLeft: Math.max(0, Math.ceil((c.notAfter.getTime() - now) / 86_400_000)),
    };
  }

  private open(pfx: Buffer, password: string): ParsedPfx {
    try {
      return parsePfx(pfx, password);
    } catch (err) {
      if (err instanceof PfxError) {
        if (err.code === 'SENHA') throw new DomainError('SENHA_CERTIFICADO', err.message);
        throw new DomainError('ARQUIVO_INVALIDO', err.message);
      }
      throw new DomainError('ARQUIVO_INVALIDO', 'Não foi possível ler o certificado');
    }
  }

  // ── Assinatura ───────────────────────────────────────────────────────────

  async sign(ctx: RequestContext, input: { entityType: SignableEntity; entityId: string; password: string }) {
    const cert = await ctx.db.signingCertificate.findFirst({
      where: { userId: ctx.session.userId, active: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!cert) throw new DomainError('SEM_CERTIFICADO', 'Cadastre o seu certificado digital em Minha conta antes de assinar');
    if (cert.notAfter < new Date()) throw new DomainError('CERTIFICADO_VENCIDO', 'O seu certificado digital venceu; cadastre o renovado em Minha conta');
    const pfx = this.open(Buffer.from(decryptSecret(cert.pfxEncrypted, this.config.DATA_KEY), 'base64'), input.password);

    const existing = await ctx.db.signedDocument.findFirst({
      where: {
        entityType: input.entityType,
        entityId: input.entityId,
        signerId: ctx.session.userId,
      },
      orderBy: { signedAt: 'desc' },
    });
    // O certificado de vacinação pode ser assinado de novo a cada dose nova.
    if (existing && input.entityType !== 'VaccinationCertificate') return { ...this.publicDocument(existing), alreadySigned: true };

    const signingTime = new Date();
    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: ctx.session.userId },
      select: { name: true },
    });
    const { model, kind, patientId } = await this.loadDocument(ctx, input.entityType, input.entityId, { name: user.name, cpf: cert.cpf }, signingTime);
    const unsigned = await renderDocument(model, {
      reason: REASONS[kind],
      location: model.unit.name,
      contactInfo: ctx.tenant.name,
    });
    const { pdf, cms } = await signPdf(unsigned, pfx, signingTime);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const storageKey = `assinaturas/${ctx.tenant.slug}/${randomUUID()}.pdf`;
    await this.storage.put(storageKey, pdf, 'application/pdf');

    const doc = await ctx.db.$transaction(async (tx) => {
      const created = await tx.signedDocument.create({
        data: {
          kind,
          entityType: input.entityType,
          entityId: input.entityId,
          patientId,
          signerId: ctx.session.userId,
          certificateId: cert.id,
          sha256,
          storageKey,
          sizeBytes: pdf.length,
          subject: cert.subject,
          cpf: cert.cpf,
          source: 'A1_SERVIDOR',
          signedAt: signingTime,
        },
      });
      if (input.entityType === 'ClinicalNote')
        await tx.clinicalNote.update({
          where: { id: input.entityId },
          data: { signature: cms.toString('base64') },
        });
      await this.audit.record(ctx, tx, {
        action: 'assinatura.icp',
        entityType: input.entityType,
        entityId: input.entityId,
        payload: {
          documentId: created.id,
          kind,
          sha256,
          cpf: cert.cpf,
          subject: cert.subject,
          fingerprint: cert.fingerprint,
          icpBrasil: cert.icpBrasil,
        },
      });
      return created;
    });
    return { ...this.publicDocument(doc), alreadySigned: false };
  }

  private async loadDocument(
    ctx: RequestContext,
    entityType: SignableEntity,
    entityId: string,
    signer: { name: string; cpf: string },
    issuedAt: Date,
  ): Promise<{ model: DocumentModel; kind: SignedKind; patientId: string }> {
    const tz = ctx.tenant.timeZone;
    if (entityType === 'VaccinationCertificate') {
      const model = await certificadoVacinacaoModel(ctx.db, { patientId: entityId, unitId: ctx.session.unitId, userId: ctx.session.userId, role: ctx.session.role, cbo: ctx.cbo, signer, issuedAt, timeZone: tz });
      return { kind: 'DOCUMENTO', patientId: entityId, model };
    }
    if (entityType === 'ClinicalNote') {
      const note = await ctx.db.clinicalNote.findUnique({
        where: { id: entityId },
        include: { encounter: { include: { unit: true, patient: true } } },
      });
      if (!note) throw notFound('Registro clínico');
      if (note.authorId !== ctx.session.userId) throw forbidden('Só o autor do registro pode assiná-lo com o certificado digital');
      if (note.status !== 'ASSINADO') throw new DomainError('REGISTRO_EM_RASCUNHO', 'Assine o registro no prontuário antes de aplicar o certificado digital');
      const kind: SignedKind = note.kind === 'ATESTADO' ? 'ATESTADO' : 'PRONTUARIO';
      const data = (note.data ?? {}) as Record<string, unknown>;
      const sections: DocumentModel['sections'] = [];
      if (note.kind === 'ATESTADO') {
        sections.push({ paragraphs: [note.plan ?? ''] });
        const details = [
          typeof data.days === 'number' ? `Dias de afastamento: ${data.days}` : null,
          data.includeCid && typeof data.cid === 'string' && data.cid ? `CID-10: ${data.cid} (incluído com autorização expressa do paciente)` : null,
        ].filter((x): x is string => !!x);
        if (details.length) sections.push({ paragraphs: details });
      } else {
        for (const [key, label] of SOAP_HEADINGS) {
          const text = note[key];
          if (text?.trim()) sections.push({ heading: label, paragraphs: [text] });
        }
        const extra = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
        if (extra.length)
          sections.push({
            heading: 'Dados estruturados',
            paragraphs: extra.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`),
          });
        if (note.codes.length)
          sections.push({
            heading: 'Códigos',
            paragraphs: [note.codes.map(formatCode).join(' · ')],
          });
      }
      const professional = await this.professional(ctx, note.authorId, note.encounter.unitId, note.role, note.cbo);
      return {
        kind,
        patientId: note.encounter.patientId,
        model: {
          title: NOTE_TITLES[note.kind] ?? 'Documento clínico',
          unit: {
            name: note.encounter.unit.name,
            cnes: note.encounter.unit.cnes,
            address: note.encounter.unit.address,
          },
          patient: this.patient(note.encounter.patient),
          professional,
          issuedAt,
          timeZone: tz,
          sections,
          footer: [`Registro ${note.id} · atendimento ${note.encounterId} · assinado no sistema em ${note.signedAt ? formatDateTime(note.signedAt, tz) : '—'} · hash da trilha de auditoria ${note.auditHash ?? '—'}`],
          signer,
        },
      };
    }
    const rx = await ctx.db.prescription.findUnique({
      where: { id: entityId },
      include: {
        items: true,
        encounter: { include: { unit: true, patient: true } },
      },
    });
    if (!rx) throw notFound('Prescrição');
    if (rx.prescriberId !== ctx.session.userId) throw forbidden('Só quem prescreveu pode assinar a prescrição com o certificado digital');
    const items = rx.items.map((i, n) => {
      const parts = [
        `${n + 1}. ${i.description}`,
        i.dose ? `${String(i.dose)} ${i.doseUnit ?? ''}`.trim() : null,
        i.route ? (ROUTE_LABELS[i.route] ?? i.route) : null,
        i.frequencyHours ? `a cada ${i.frequencyHours} h` : null,
        i.durationDays ? `por ${i.durationDays} dia(s)` : null,
        i.quantity ? `quantidade ${String(i.quantity)}` : null,
        i.suspendedAt ? '(suspenso)' : null,
      ].filter(Boolean);
      return `${parts.join(' · ')}${i.instructions ? `\n   ${i.instructions}` : ''}`;
    });
    const sections: DocumentModel['sections'] = [
      {
        heading: rx.kind === 'HOSPITALAR' ? 'Prescrição' : 'Medicamentos',
        paragraphs: items,
      },
    ];
    if (rx.justification)
      sections.push({
        heading: 'Justificativa',
        paragraphs: [rx.justification],
      });
    const professional = await this.professional(ctx, rx.prescriberId, rx.encounter.unitId, ctx.session.role, ctx.cbo);
    return {
      kind: 'RECEITA',
      patientId: rx.patientId,
      model: {
        title: rx.kind === 'HOSPITALAR' ? 'Prescrição hospitalar' : 'Receita',
        unit: {
          name: rx.encounter.unit.name,
          cnes: rx.encounter.unit.cnes,
          address: rx.encounter.unit.address,
        },
        patient: this.patient(rx.encounter.patient),
        professional,
        issuedAt,
        timeZone: tz,
        sections,
        footer: [`Prescrição ${rx.id} · atendimento ${rx.encounterId} · emitida em ${formatDateTime(rx.signedAt, tz)} · hash da trilha de auditoria ${rx.auditHash ?? '—'}`],
        signer,
      },
    };
  }

  private patient(p: { name: string; socialName: string | null; cpf: string | null; cns: string | null; birthDate: Date }): DocumentModel['patient'] {
    return {
      name: p.socialName ? `${p.socialName} (nome civil: ${p.name})` : p.name,
      cpf: p.cpf,
      cns: p.cns,
      birthDate: p.birthDate,
    };
  }

  private async professional(ctx: RequestContext, userId: string, unitId: string, role: Role, cbo: string): Promise<DocumentModel['professional']> {
    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: userId },
      include: { assignments: { where: { unitId } } },
    });
    const assignment = user.assignments.find((a) => a.role === role) ?? user.assignments[0];
    return {
      name: user.name,
      council: assignment?.council ?? null,
      cbo: assignment?.cbo ?? cbo,
      roleLabel: ROLE_LABELS[role] ?? role,
    };
  }

  private publicDocument(
    d: DocumentRow & {
      signer?: { name: string } | null;
      certificate?: { icpBrasil: boolean } | null;
    },
  ) {
    return {
      id: d.id,
      kind: d.kind,
      entityType: d.entityType,
      entityId: d.entityId,
      patientId: d.patientId,
      signerId: d.signerId,
      signerName: d.signer?.name ?? null,
      subject: d.subject,
      cpf: d.cpf,
      source: d.source,
      sha256: d.sha256,
      sizeBytes: d.sizeBytes,
      signedAt: d.signedAt,
      icpBrasil: d.certificate?.icpBrasil ?? null,
    };
  }

  // ── Consulta e validação ─────────────────────────────────────────────────

  async listForEntities(ctx: RequestContext, entityType: SignableEntity, entityIds: string[]) {
    if (!entityIds.length) return [];
    const docs = await ctx.db.signedDocument.findMany({
      where: { entityType, entityId: { in: entityIds.slice(0, 200) } },
      include: {
        signer: { select: { name: true } },
        certificate: { select: { icpBrasil: true } },
      },
      orderBy: { signedAt: 'asc' },
    });
    return docs.map((d) => this.publicDocument(d));
  }

  async pdf(ctx: RequestContext, id: string): Promise<{ data: Buffer; fileName: string }> {
    const doc = await ctx.db.signedDocument.findUnique({ where: { id } });
    if (!doc) throw notFound('Documento assinado');
    const data = await this.storage.get(doc.storageKey);
    if (createHash('sha256').update(data).digest('hex') !== doc.sha256) throw new DomainError('INTEGRIDADE', 'O arquivo armazenado não confere com o hash registrado', HttpStatus.INTERNAL_SERVER_ERROR);
    await this.audit.recordStandalone(ctx, {
      action: 'assinatura.baixar',
      entityType: 'SignedDocument',
      entityId: doc.id,
      payload: { patientId: doc.patientId, sha256: doc.sha256 },
    });
    const stamp = doc.signedAt.toISOString().slice(0, 10).replace(/-/g, '');
    return {
      data,
      fileName: `${doc.kind.toLowerCase()}-${stamp}-${doc.id.slice(0, 8)}.pdf`,
    };
  }

  async validate(ctx: RequestContext, pdfBase64: string) {
    const pdf = Buffer.from(pdfBase64, 'base64');
    if (!pdf.length || pdf.length > MAX_PDF_BYTES) throw new DomainError('ARQUIVO_INVALIDO', 'Envie um PDF de até 15 MB');
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new DomainError('ARQUIVO_INVALIDO', 'O arquivo não é um PDF');
    const signatures = verifyPdfSignatures(pdf);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const known = await ctx.db.signedDocument.findFirst({
      where: { sha256 },
      include: { signer: { select: { name: true } } },
    });
    await this.audit.recordStandalone(ctx, {
      action: 'assinatura.validar',
      entityType: 'SignedDocument',
      entityId: known?.id,
      payload: {
        sha256,
        signatures: signatures.length,
        valid: signatures.length > 0 && signatures.every((s) => s.valid),
      },
    });
    return {
      sha256,
      sizeBytes: pdf.length,
      valid: signatures.length > 0 && signatures.every((s) => s.valid),
      signatures,
      issuedHere: known
        ? {
            id: known.id,
            kind: known.kind,
            entityType: known.entityType,
            entityId: known.entityId,
            signedAt: known.signedAt,
            signerName: known.signer.name,
            cpf: known.cpf,
          }
        : null,
    };
  }
}
