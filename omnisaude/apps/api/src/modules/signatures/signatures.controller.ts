import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Authenticated, Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { DomainError } from '../../core/errors';
import { zv } from '../../core/zod';
import { SignaturesService, type SignableEntity } from './signatures.service';

const ENTITY_TYPES = ['ClinicalNote', 'Prescription', 'VaccinationCertificate'] as const;
const certificateSchema = z.object({
  pfxBase64: z.string().min(16).max(200_000),
  password: z.string().min(1).max(200),
});
const signSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().uuid(),
  password: z.string().min(1).max(200),
});
const validateSchema = z.object({
  pdfBase64: z.string().min(16).max(21_000_000),
});

@Controller('signatures')
export class SignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  @Get('certificates/me')
  @Authenticated()
  myCertificate(@Ctx() ctx: RequestContext) {
    return this.signatures.myCertificate(ctx);
  }

  @Post('certificates')
  @Authenticated()
  register(@Ctx() ctx: RequestContext, @Body(zv(certificateSchema)) body: z.infer<typeof certificateSchema>) {
    return this.signatures.registerCertificate(ctx, body);
  }

  @Delete('certificates/me')
  @Authenticated()
  revoke(@Ctx() ctx: RequestContext) {
    return this.signatures.revokeCertificate(ctx);
  }

  @Post('sign')
  @Authenticated()
  sign(@Ctx() ctx: RequestContext, @Body(zv(signSchema)) body: z.infer<typeof signSchema>) {
    return this.signatures.sign(ctx, body);
  }

  @Get()
  @RequirePermission('prontuario.ler')
  list(@Ctx() ctx: RequestContext, @Query('entityType') entityType?: string, @Query('entityIds') entityIds?: string) {
    if (!ENTITY_TYPES.includes(entityType as SignableEntity)) throw new DomainError('VALIDACAO', 'entityType deve ser ClinicalNote, Prescription ou VaccinationCertificate', 400);
    const ids = (entityIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
    return this.signatures.listForEntities(ctx, entityType as SignableEntity, ids);
  }

  @Get(':id/pdf')
  @RequirePermission('prontuario.ler')
  async pdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const file = await this.signatures.pdf(ctx, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.data);
  }

  @Post('validate')
  @HttpCode(200)
  @Authenticated()
  validate(@Ctx() ctx: RequestContext, @Body(zv(validateSchema)) body: z.infer<typeof validateSchema>) {
    return this.signatures.validate(ctx, body.pdfBase64);
  }
}
