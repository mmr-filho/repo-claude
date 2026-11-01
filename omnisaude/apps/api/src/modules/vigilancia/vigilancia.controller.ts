import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { CatalogoVigilanciaService } from './catalogo.service';
import { CAMPOS_EDITAVEIS } from './ficha';
import { NotificacaoService } from './notificacao.service';

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const esfera = z.enum(['SMS', 'SES', 'MS']);
const contexto = z.enum(['CASO', 'OBITO', 'GESTANTE', 'ANOMALIA_CONGENITA', 'OUTRO']);
const manualSchema = z.object({
  patientId: z.string().uuid(),
  conditionKey: z.string().trim().min(2).max(60),
  encounterId: z.string().uuid().nullish(),
  vaccinationId: z.string().uuid().nullish(),
  knownAt: z.string().datetime({ offset: true }).nullish(),
  symptomsOnset: dia.nullish(),
});
const fichaSchema = z.object(Object.fromEntries(CAMPOS_EDITAVEIS.map((c) => [c, z.string().trim().max(120).nullish()])) as Record<(typeof CAMPOS_EDITAVEIS)[number], z.ZodOptional<z.ZodNullable<z.ZodString>>>).partial();
const editarSchema = z.object({
  conditionKey: z.string().trim().min(2).max(60).optional(),
  basis: z.enum(['SUSPEITA', 'CONFIRMADO']).optional(),
  confirmedAt: z.string().datetime({ offset: true }).nullish(),
  symptomsOnset: dia.nullish(),
  ficha: fichaSchema.optional(),
});
const descartarSchema = z.object({ reason: z.string().trim().min(10).max(1000) });
const comunicarSchema = z.object({
  target: esfera,
  channel: z.enum(['TELEFONE', 'EMAIL', 'FORMULARIO', 'PRESENCIAL', 'OUTRO']),
  communicatedAt: z.string().datetime({ offset: true }),
  counterpartName: z.string().trim().min(2).max(120),
  counterpartOrg: z.string().trim().max(120).nullish(),
  contactId: z.string().uuid().nullish(),
  contactValue: z.string().trim().max(160).nullish(),
  protocol: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});
const painelSchema = z.object({
  status: z.enum(['RASCUNHO', 'NOTIFICADA', 'DESCARTADA']).optional(),
  grupo: z.string().trim().max(40).optional(),
  unitId: z.string().uuid().optional(),
  situacao: z.enum(['NO_PRAZO', 'A_VENCER', 'VENCIDO', 'CUMPRIDO', 'REPASSE']).optional(),
  semana: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
const minhasSchema = z.object({ status: z.enum(['RASCUNHO', 'NOTIFICADA', 'DESCARTADA']).optional(), de: dia.optional(), ate: dia.optional() });
const condicaoLocal = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,60}$/),
  groupKey: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/)
    .optional(),
  item: z.number().int().min(1).max(999),
  subitem: z
    .string()
    .regex(/^[a-z]$/)
    .nullish(),
  name: z.string().trim().min(3).max(200),
  context: contexto.optional(),
  immediateMs: z.boolean(),
  immediateSes: z.boolean(),
  immediateSms: z.boolean(),
  weekly: z.boolean(),
  notifyOn: z.enum(['SUSPEITA', 'CONFIRMACAO']).optional(),
  deadlineStart: z.enum(['ATENDIMENTO', 'CONHECIMENTO', 'CONFIRMACAO']).optional(),
  sensitive: z.boolean().optional(),
  once: z.boolean().optional(),
  normativeNote: z.string().trim().max(500).nullish(),
});
const versaoLocalSchema = z.object({
  scope: z.enum(['ESTADUAL', 'MUNICIPAL']),
  act: z.string().trim().min(5).max(200),
  validFrom: dia,
  validTo: dia.nullish(),
  notes: z.string().trim().max(1000).nullish(),
  conditions: z.array(condicaoLocal).min(1).max(200),
});
const codigosSchema = z.object({ busca: z.string().trim().max(40).optional(), status: z.enum(['PROPOSTO', 'HOMOLOGADO', 'INATIVO']).optional() });
const novoCodigoSchema = z.object({
  system: z.enum(['CID10', 'CIAP2']),
  codePrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z][0-9A-Za-z.]{0,5}$/),
  groupKey: z.string().trim().min(2).max(40),
  context: contexto.nullish(),
  source: z.string().trim().min(3).max(300),
});
const homologarSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });
const alterarCodigoSchema = z.object({ status: z.enum(['PROPOSTO', 'HOMOLOGADO', 'INATIVO']) });
const contatoSchema = z.object({
  sphere: esfera,
  label: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email().max(160).nullish(),
  formUrl: z.string().trim().url().max(300).nullish(),
  hours: z.string().trim().max(120).nullish(),
  onCall: z.boolean().optional(),
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(999).optional(),
});
const configuracoesSchema = z.object({ ackMinutes: z.number().int().min(5).max(720).optional(), onCallPhones: z.array(z.string().trim().min(8).max(20)).max(10).optional(), whatsappAlerts: z.boolean().optional() });

/** Vigilância em saúde: notificação compulsória (VIG-1a), painel da vigilância e catálogo da LNNC. */
@Controller('vigilancia')
export class VigilanciaController {
  constructor(
    private readonly notificacoes: NotificacaoService,
    private readonly catalogo: CatalogoVigilanciaService,
  ) {}

  @Get('painel')
  @RequirePermission('vigilancia.painel')
  painel(@Ctx() ctx: RequestContext, @Query(zv(painelSchema)) q: z.infer<typeof painelSchema>) {
    return this.notificacoes.painel(ctx, q);
  }

  @Get('descartes')
  @RequirePermission('vigilancia.painel')
  descartes(@Ctx() ctx: RequestContext) {
    return this.notificacoes.descartes(ctx);
  }

  @Get('resumo')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  resumo(@Ctx() ctx: RequestContext) {
    return this.notificacoes.resumo(ctx);
  }

  @Get('notificacoes/minhas')
  @RequirePermission('notificacao.registrar')
  minhas(@Ctx() ctx: RequestContext, @Query(zv(minhasSchema)) q: z.infer<typeof minhasSchema>) {
    return this.notificacoes.minhas(ctx, q);
  }

  @Post('notificacoes')
  @RequirePermission('notificacao.registrar')
  criar(@Ctx() ctx: RequestContext, @Body(zv(manualSchema)) body: z.infer<typeof manualSchema>) {
    return this.notificacoes.criarManual(ctx, body);
  }

  @Get('notificacoes/:id')
  @RequirePermission('notificacao.registrar', 'vigilancia.painel')
  detalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificacoes.detalhe(ctx, id);
  }

  @Patch('notificacoes/:id')
  @RequirePermission('notificacao.registrar', 'vigilancia.painel')
  editar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(editarSchema)) body: z.infer<typeof editarSchema>) {
    return this.notificacoes.editar(ctx, id, body);
  }

  @Post('notificacoes/:id/confirmar')
  @HttpCode(200)
  @RequirePermission('notificacao.registrar', 'vigilancia.painel')
  confirmar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificacoes.confirmar(ctx, id);
  }

  @Post('notificacoes/:id/descartar')
  @HttpCode(200)
  @RequirePermission('notificacao.registrar', 'vigilancia.painel')
  descartar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(descartarSchema)) body: z.infer<typeof descartarSchema>) {
    return this.notificacoes.descartar(ctx, id, body.reason);
  }

  @Post('notificacoes/:id/ciencia')
  @HttpCode(200)
  @RequirePermission('vigilancia.ciencia')
  ciencia(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificacoes.ciencia(ctx, id);
  }

  @Post('notificacoes/:id/comunicacoes')
  @RequirePermission('vigilancia.comunicar')
  comunicar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(comunicarSchema)) body: z.infer<typeof comunicarSchema>) {
    return this.notificacoes.comunicar(ctx, id, body);
  }

  @Get('pacientes/:id/notificacoes')
  @RequirePermission('notificacao.registrar', 'vigilancia.painel')
  doPaciente(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificacoes.doPaciente(ctx, id);
  }

  // Catálogo (LNNC) — leitura para quem notifica; gestão pela vigilância municipal.
  @Get('catalogo/vigente')
  @RequirePermission('notificacao.registrar', 'vigilancia.painel')
  vigente(@Ctx() ctx: RequestContext, @Query(zv(z.object({ data: dia.optional() }))) q: { data?: string }) {
    return this.catalogo.retratoNaData(ctx, q.data ?? new Date().toISOString().slice(0, 10));
  }

  @Get('catalogo/versoes')
  @RequirePermission('vigilancia.painel')
  versoes(@Ctx() ctx: RequestContext) {
    return this.catalogo.versoes(ctx);
  }

  @Get('catalogo/versoes/:id')
  @RequirePermission('vigilancia.painel')
  versao(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalogo.condicoesDaVersao(ctx, id);
  }

  @Post('catalogo/versoes')
  @RequirePermission('vigilancia.catalogo')
  novaVersao(@Ctx() ctx: RequestContext, @Body(zv(versaoLocalSchema)) body: z.infer<typeof versaoLocalSchema>) {
    return this.catalogo.criarVersaoLocal(ctx, body);
  }

  @Get('codigos')
  @RequirePermission('vigilancia.painel')
  codigos(@Ctx() ctx: RequestContext, @Query(zv(codigosSchema)) q: z.infer<typeof codigosSchema>) {
    return this.catalogo.codigos(ctx, q);
  }

  @Post('codigos')
  @RequirePermission('vigilancia.catalogo')
  novoCodigo(@Ctx() ctx: RequestContext, @Body(zv(novoCodigoSchema)) body: z.infer<typeof novoCodigoSchema>) {
    return this.catalogo.novoCodigo(ctx, body);
  }

  @Post('codigos/homologar')
  @HttpCode(200)
  @RequirePermission('vigilancia.catalogo')
  homologar(@Ctx() ctx: RequestContext, @Body(zv(homologarSchema)) body: z.infer<typeof homologarSchema>) {
    return this.catalogo.homologar(ctx, body.ids);
  }

  @Patch('codigos/:id')
  @RequirePermission('vigilancia.catalogo')
  alterarCodigo(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(alterarCodigoSchema)) body: z.infer<typeof alterarCodigoSchema>) {
    return this.catalogo.alterarCodigo(ctx, id, body.status);
  }

  @Get('contatos')
  @RequirePermission('vigilancia.painel', 'notificacao.registrar')
  contatos(@Ctx() ctx: RequestContext) {
    return this.notificacoes.contatos(ctx);
  }

  @Post('contatos')
  @RequirePermission('vigilancia.catalogo')
  novoContato(@Ctx() ctx: RequestContext, @Body(zv(contatoSchema)) body: z.infer<typeof contatoSchema>) {
    return this.notificacoes.salvarContato(ctx, null, body);
  }

  @Put('contatos/:id')
  @RequirePermission('vigilancia.catalogo')
  alterarContato(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(contatoSchema)) body: z.infer<typeof contatoSchema>) {
    return this.notificacoes.salvarContato(ctx, id, body);
  }

  @Get('configuracoes')
  @RequirePermission('vigilancia.catalogo')
  configuracoes(@Ctx() ctx: RequestContext) {
    return this.notificacoes.configuracoes(ctx);
  }

  @Patch('configuracoes')
  @RequirePermission('vigilancia.catalogo')
  salvarConfiguracoes(@Ctx() ctx: RequestContext, @Body(zv(configuracoesSchema)) body: z.infer<typeof configuracoesSchema>) {
    return this.notificacoes.salvarConfiguracoes(ctx, body);
  }
}
