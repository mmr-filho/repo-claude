import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { StorageService } from '../../core/storage.service';
import { zv } from '../../core/zod';
import { PatientsService } from './patients.service';

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
const uploadSchema = z.object({
  kind: z.enum(['DOCUMENTO_IDENTIFICACAO', 'TERMO_CONSENTIMENTO', 'LAUDO', 'RECEITA', 'PDF_ASSINADO', 'OUTRO']),
  mimeType: z.enum(ALLOWED),
  fileBase64: z.string().min(10).max(14_000_000),
});

/** Arquivos digitais do paciente, guardados no storage de objetos com hash SHA-256 para integridade. */
@Controller('patients')
export class PatientDocumentsController {
  constructor(
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly patients: PatientsService,
  ) {}

  @Post(':id/documents')
  @RequirePermission('paciente.cadastrar', 'prontuario.evoluir')
  async upload(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(uploadSchema)) body: z.infer<typeof uploadSchema>) {
    await this.patients.ensure(ctx, id);
    const data = Buffer.from(body.fileBase64, 'base64');
    if (data.length === 0 || data.length > 10 * 1024 * 1024) throw new DomainError('ARQUIVO_INVALIDO', 'Arquivo vazio ou maior que 10 MB');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const key = `t/${ctx.tenant.id}/patients/${id}/${randomUUID()}`;
    await this.storage.put(key, data, body.mimeType);
    return ctx.db.$transaction(async (tx) => {
      const doc = await tx.patientDocument.create({
        data: { patientId: id, kind: body.kind, storageKey: key, mimeType: body.mimeType, sizeBytes: data.length, sha256, createdBy: ctx.session.userId },
      });
      await this.audit.record(ctx, tx, { action: 'documento.anexar', entityType: 'PatientDocument', entityId: doc.id, payload: { patientId: id, kind: body.kind, sha256 } });
      return doc;
    });
  }

  @Get(':id/documents')
  @RequirePermission('paciente.ler')
  list(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return ctx.db.patientDocument.findMany({ where: { patientId: id }, orderBy: { createdAt: 'desc' } });
  }

  @Get(':id/documents/:docId/content')
  @RequirePermission('paciente.ler')
  async content(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @Res() res: Response) {
    const doc = await ctx.db.patientDocument.findFirst({ where: { id: docId, patientId: id } });
    if (!doc) throw notFound('Documento');
    const data = await this.storage.get(doc.storageKey);
    if (createHash('sha256').update(data).digest('hex') !== doc.sha256) throw new DomainError('INTEGRIDADE', 'O arquivo armazenado não confere com o hash registrado', 500);
    await this.audit.recordStandalone(ctx, { action: 'documento.visualizar', entityType: 'PatientDocument', entityId: doc.id, payload: { patientId: id } });
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  }
}
