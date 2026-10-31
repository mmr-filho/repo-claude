import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { RegulationRndsService } from './regulation-rnds.service';
import { RegulationService } from './regulation.service';

const prioridade = z.enum(['VERMELHA', 'AMARELA', 'VERDE', 'AZUL']);
const tipo = z.enum(['CONSULTA', 'EXAME', 'PROCEDIMENTO']);
const status = z.enum(['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'AGENDADA', 'NEGADA', 'CANCELADA', 'REALIZADA']);
const codigo = z.string().regex(/^[A-Z0-9_]{2,40}$/);
const texto = (max: number) => z.string().trim().max(max);

const solicitarSchema = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid().nullish(),
  kind: tipo,
  specialty: codigo,
  priority: prioridade,
  priorityJustification: texto(1000).nullish(),
  clinicalSummary: texto(4000).min(10, 'Descreva o quadro clínico (mínimo de 10 caracteres)'),
  criteria: z.array(codigo).max(20).default([]),
  cid: z.string().max(5).nullish(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
});
const verificarSchema = solicitarSchema.pick({ patientId: true, kind: true, specialty: true, priority: true, priorityJustification: true, criteria: true });
const listarSchema = z.object({
  status: status.optional(),
  unitId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  specialty: codigo.optional(),
  priority: prioridade.optional(),
  kind: tipo.optional(),
  escopo: z.enum(['unidade', 'central']).optional(),
});
const filaSchema = z.object({ specialty: codigo.optional(), priority: prioridade.optional(), kind: tipo.optional() });
const motivoSchema = z.object({ reason: texto(2000).min(5, 'Informe o motivo') });
const autorizarSchema = z.object({ priority: prioridade.optional(), providerId: z.string().uuid().nullish(), providerUnitId: z.string().uuid().nullish(), notes: texto(2000).nullish() });
const competencia = z.string().regex(/^\d{4}-\d{2}$/, 'Competência no formato AAAA-MM');
const prestadorSchema = z.object({
  name: texto(160).min(3),
  kind: z.enum(['PROPRIO', 'CONTRATADO', 'FILANTROPICO', 'CONSORCIADO']),
  unitId: z.string().uuid().nullish(),
  cnes: z
    .string()
    .regex(/^\d{7}$/)
    .nullish(),
  cnpj: z.string().max(18).nullish(),
  contractNumber: texto(60).nullish(),
  contractStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  contractEnd: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  physicalCeiling: z.number().int().min(0).nullish(),
  financialCeiling: z.number().min(0).nullish(),
  phone: texto(30).nullish(),
  address: texto(200).nullish(),
  notes: texto(1000).nullish(),
  active: z.boolean().optional(),
});
const cotasSchema = z.object({
  competencia,
  cotas: z
    .array(
      z.object({
        id: z.string().uuid().nullish(),
        kind: tipo,
        specialty: codigo,
        quantity: z.number().int().min(0).max(100000),
        unitValue: z.number().min(0).nullish(),
        originUnitId: z.string().uuid().nullish(),
        notes: texto(200).nullish(),
      }),
    )
    .max(200),
});
const ofertasSchema = z.object({ kind: tipo, specialty: codigo, unitId: z.string().uuid().optional(), competencia: competencia.optional() });
const agendarSchema = z.object({ scheduleId: z.string().uuid(), startsAt: z.string().datetime({ offset: true }) });
const remarcarSchema = z.object({ startsAt: z.string().datetime({ offset: true }) });
const realizarSchema = z.object({ notes: texto(1000).nullish() });
const complementarSchema = z.object({
  notes: texto(2000).min(5, 'Descreva o que foi complementado'),
  priority: prioridade.optional(),
  priorityJustification: texto(1000).nullish(),
  clinicalSummary: texto(4000).optional(),
  criteria: z.array(codigo).max(20).optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
});
const mensagemSchema = z.object({ notes: texto(2000).min(2) });

/** Regulação ambulatorial: solicitações a partir do atendimento, fila única, decisão do regulador e devolutiva. */
const rndsListaSchema = z.object({ status: z.enum(['PENDENTE', 'ENVIADO', 'ERRO', 'DESCARTADO']).optional(), fonte: z.enum(['AMBULATORIAL', 'LEITO']).optional(), requestId: z.string().uuid().optional() });
const rndsEnfileirarSchema = z.object({ fonte: z.enum(['AMBULATORIAL', 'LEITO']), requestId: z.string().uuid() });
const codigoExternoSchema = z.object({ externalCode: z.string().trim().max(40).nullish() });

@Controller('regulacao')
export class RegulationController {
  constructor(
    private readonly regulation: RegulationService,
    private readonly rnds: RegulationRndsService,
  ) {}

  @Get('protocolos')
  @RequirePermission('regulacao.ler')
  protocolos() {
    return this.regulation.protocolos();
  }

  @Post('verificar')
  @HttpCode(200)
  @RequirePermission('regulacao.solicitar')
  verificar(@Ctx() ctx: RequestContext, @Body(zv(verificarSchema)) body: z.infer<typeof verificarSchema>) {
    return this.regulation.verificar(ctx, body);
  }

  @Post('solicitacoes')
  @RequirePermission('regulacao.solicitar')
  solicitar(@Ctx() ctx: RequestContext, @Body(zv(solicitarSchema)) body: z.infer<typeof solicitarSchema>) {
    return this.regulation.solicitar(ctx, body);
  }

  @Get('solicitacoes')
  @RequirePermission('regulacao.ler')
  listar(@Ctx() ctx: RequestContext, @Query(zv(listarSchema)) q: z.infer<typeof listarSchema>) {
    return this.regulation.listar(ctx, q);
  }

  @Get('fila')
  @RequirePermission('regulacao.regular')
  fila(@Ctx() ctx: RequestContext, @Query(zv(filaSchema)) q: z.infer<typeof filaSchema>) {
    return this.regulation.fila(ctx, q);
  }

  @Get('painel')
  @RequirePermission('regulacao.ler')
  painel(@Ctx() ctx: RequestContext, @Query('unitId') unitId?: string) {
    return this.regulation.painel(ctx, unitId || undefined);
  }

  // ─── Prestadores, PPI e cotas (REG-3) ───

  @Get('prestadores')
  @RequirePermission('regulacao.ler')
  prestadores(@Ctx() ctx: RequestContext, @Query('competencia') comp?: string) {
    return this.regulation.listarPrestadores(ctx, comp && /^\d{4}-\d{2}$/.test(comp) ? comp : undefined);
  }

  @Post('prestadores')
  @RequirePermission('regulacao.regular')
  criarPrestador(@Ctx() ctx: RequestContext, @Body(zv(prestadorSchema)) body: z.infer<typeof prestadorSchema>) {
    return this.regulation.criarPrestador(ctx, body);
  }

  @Patch('prestadores/:id')
  @RequirePermission('regulacao.regular')
  atualizarPrestador(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(prestadorSchema)) body: z.infer<typeof prestadorSchema>) {
    return this.regulation.atualizarPrestador(ctx, id, body);
  }

  @Get('prestadores/:id/cotas')
  @RequirePermission('regulacao.ler')
  cotas(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query('competencia') comp?: string) {
    return this.regulation.cotasDoPrestador(ctx, id, comp && /^\d{4}-\d{2}$/.test(comp) ? comp : undefined);
  }

  @Put('prestadores/:id/cotas')
  @RequirePermission('regulacao.regular')
  definirCotas(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(cotasSchema)) body: z.infer<typeof cotasSchema>) {
    return this.regulation.definirCotas(ctx, id, body.competencia, body.cotas);
  }

  @Get('prestadores/:id/agendas')
  @RequirePermission('regulacao.regular', 'agenda.marcar')
  agendas(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.regulation.agendasDoPrestador(ctx, id);
  }

  @Get('ofertas')
  @RequirePermission('regulacao.regular')
  ofertas(@Ctx() ctx: RequestContext, @Query(zv(ofertasSchema)) q: z.infer<typeof ofertasSchema>) {
    return this.regulation.ofertas(ctx, q);
  }

  // ─── Agendamento regulado (REG-4) ───

  @Post('solicitacoes/:id/agendar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular', 'agenda.marcar')
  agendar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(agendarSchema)) body: z.infer<typeof agendarSchema>) {
    return this.regulation.agendar(ctx, id, body);
  }

  @Post('solicitacoes/:id/remarcar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular', 'agenda.marcar')
  remarcar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(remarcarSchema)) body: z.infer<typeof remarcarSchema>) {
    return this.regulation.remarcar(ctx, id, body);
  }

  @Post('solicitacoes/:id/desmarcar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular', 'agenda.marcar')
  desmarcar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.regulation.desmarcar(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/falta')
  @HttpCode(200)
  @RequirePermission('regulacao.regular', 'agenda.marcar')
  falta(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.regulation.falta(ctx, id);
  }

  @Post('solicitacoes/:id/realizar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular', 'agenda.marcar')
  realizar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(realizarSchema)) body: z.infer<typeof realizarSchema>) {
    return this.regulation.realizar(ctx, id, body.notes);
  }

  @Get('solicitacoes/:id')
  @RequirePermission('regulacao.ler')
  detalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.regulation.detalhe(ctx, id);
  }

  @Post('solicitacoes/:id/analisar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  analisar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.regulation.analisar(ctx, id);
  }

  @Post('solicitacoes/:id/autorizar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  autorizar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(autorizarSchema)) body: z.infer<typeof autorizarSchema>) {
    return this.regulation.autorizar(ctx, id, body);
  }

  @Post('solicitacoes/:id/devolver')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  devolver(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.regulation.devolver(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/negar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  negar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.regulation.negar(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/complementar')
  @HttpCode(200)
  @RequirePermission('regulacao.solicitar')
  complementar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(complementarSchema)) body: z.infer<typeof complementarSchema>) {
    return this.regulation.complementar(ctx, id, body);
  }

  @Post('solicitacoes/:id/cancelar')
  @HttpCode(200)
  @RequirePermission('regulacao.solicitar', 'regulacao.regular')
  cancelar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.regulation.cancelar(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/mensagem')
  @HttpCode(200)
  @RequirePermission('regulacao.solicitar', 'regulacao.regular')
  mensagem(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(mensagemSchema)) body: z.infer<typeof mensagemSchema>) {
    return this.regulation.mensagem(ctx, id, body.notes);
  }

  // ─── Envio à RNDS (Portaria GM/MS 6.656/2025) ───

  @Get('rnds/painel')
  @RequirePermission('regulacao.ler', 'leitos_rede.ler')
  rndsPainel(@Ctx() ctx: RequestContext) {
    return this.rnds.painel(ctx);
  }

  @Get('rnds/documentos')
  @RequirePermission('regulacao.ler', 'leitos_rede.ler')
  rndsDocumentos(@Ctx() ctx: RequestContext, @Query(zv(rndsListaSchema)) q: z.infer<typeof rndsListaSchema>) {
    return this.rnds.documentos(ctx, q);
  }

  @Get('rnds/documentos/:id/previa')
  @RequirePermission('regulacao.regular', 'leitos_rede.regular')
  rndsPrevia(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.rnds.previa(ctx, id);
  }

  @Post('rnds/documentos/:id/reenviar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular', 'leitos_rede.regular')
  rndsReenviar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.rnds.reenviar(ctx, id);
  }

  @Post('rnds/enfileirar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular', 'leitos_rede.regular')
  rndsEnfileirar(@Ctx() ctx: RequestContext, @Body(zv(rndsEnfileirarSchema)) body: z.infer<typeof rndsEnfileirarSchema>) {
    return this.rnds.enfileirar(ctx, body.fonte, body.requestId);
  }

  @Post('rnds/carga-inicial')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  rndsCargaInicial(@Ctx() ctx: RequestContext) {
    return this.rnds.cargaInicial(ctx);
  }

  @Post('solicitacoes/:id/codigo-externo')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  codigoExterno(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(codigoExternoSchema)) body: z.infer<typeof codigoExternoSchema>) {
    return this.rnds.codigoExterno(ctx, id, body.externalCode ?? null);
  }
}
