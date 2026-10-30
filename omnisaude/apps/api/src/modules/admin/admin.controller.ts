import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ROLES, UNIT_TYPES } from '@omnisaude/shared';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { AdminService } from './admin.service';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

const unitSchema = z.object({
  name: z.string().trim().min(3).max(120),
  type: z.enum(UNIT_TYPES),
  cnes: z.string().regex(/^\d{7}$/, 'CNES tem 7 dígitos'),
  ibgeCode: z.string().regex(/^\d{6,7}$/, 'Código IBGE tem 6 ou 7 dígitos'),
  address: optionalText(200),
  phone: optionalText(20),
  email: z.string().trim().email().nullable().optional().or(z.literal('')),
  openingHours: optionalText(120),
  active: z.boolean().optional(),
});
const assignmentSchema = z.object({
  unitId: z.string().uuid(),
  role: z.enum(ROLES),
  cbo: z.string().regex(/^\d{6}$/, 'CBO tem 6 dígitos'),
  council: optionalText(40),
});
const userSchema = z.object({
  cpf: z.string().min(11).max(14),
  cns: optionalText(18),
  name: z.string().trim().min(5).max(120),
  socialName: optionalText(120),
  email: z.string().trim().email().nullable().optional().or(z.literal('')),
  phone: optionalText(20),
  assignments: z.array(assignmentSchema).min(1).max(20),
});
const userPatchSchema = userSchema.omit({ assignments: true }).partial().extend({ active: z.boolean().optional() });
const usersQuerySchema = z.object({ q: z.string().max(80).optional(), unitId: z.string().uuid().optional(), role: z.enum(ROLES).optional(), includeInactive: flag });
const securitySchema = z.object({ mfaRequiredRoles: z.array(z.enum(ROLES)).max(ROLES.length) });

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('units')
  @RequirePermission('cadastros.unidades')
  units(@Ctx() ctx: RequestContext, @Query('includeInactive') includeInactive?: string) {
    return this.admin.listUnits(ctx, includeInactive === 'true' || includeInactive === '1');
  }

  @Post('units')
  @RequirePermission('cadastros.unidades')
  createUnit(@Ctx() ctx: RequestContext, @Body(zv(unitSchema)) body: z.infer<typeof unitSchema>) {
    return this.admin.createUnit(ctx, { ...body, email: body.email || null });
  }

  @Patch('units/:id')
  @RequirePermission('cadastros.unidades')
  updateUnit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(unitSchema.partial())) body: z.infer<typeof unitSchema>) {
    return this.admin.updateUnit(ctx, id, { ...body, ...(body.email === undefined ? {} : { email: body.email || null }) });
  }

  @Get('users')
  @RequirePermission('cadastros.profissionais')
  users(@Ctx() ctx: RequestContext, @Query(zv(usersQuerySchema)) q: z.infer<typeof usersQuerySchema>) {
    return this.admin.listUsers(ctx, q);
  }

  @Get('users/:id')
  @RequirePermission('cadastros.profissionais')
  user(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.getUser(ctx, id);
  }

  @Post('users')
  @RequirePermission('cadastros.profissionais')
  createUser(@Ctx() ctx: RequestContext, @Body(zv(userSchema)) body: z.infer<typeof userSchema>) {
    return this.admin.createUser(ctx, { ...body, email: body.email || null });
  }

  @Patch('users/:id')
  @RequirePermission('cadastros.profissionais')
  updateUser(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(userPatchSchema)) body: z.infer<typeof userPatchSchema>) {
    return this.admin.updateUser(ctx, id, { ...body, ...(body.email === undefined ? {} : { email: body.email || null }) });
  }

  @Put('users/:id/assignments')
  @RequirePermission('cadastros.profissionais')
  assignments(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(z.array(assignmentSchema).max(20))) body: z.infer<typeof assignmentSchema>[]) {
    return this.admin.replaceAssignments(ctx, id, body);
  }

  @Post('users/:id/reset-password')
  @RequirePermission('cadastros.profissionais')
  @HttpCode(200)
  resetPassword(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.resetPassword(ctx, id);
  }

  @Post('users/:id/mfa/reset')
  @RequirePermission('cadastros.profissionais')
  @HttpCode(200)
  resetMfa(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.resetMfa(ctx, id);
  }

  @Get('security')
  @RequirePermission('seguranca.gerir')
  security(@Ctx() ctx: RequestContext) {
    return this.admin.security(ctx);
  }

  @Patch('security')
  @RequirePermission('seguranca.gerir')
  updateSecurity(@Ctx() ctx: RequestContext, @Body(zv(securitySchema)) body: z.infer<typeof securitySchema>) {
    return this.admin.updateSecurity(ctx, body);
  }
}
