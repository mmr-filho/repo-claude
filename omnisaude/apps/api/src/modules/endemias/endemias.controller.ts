import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { SITUACOES_VISITA } from '@omnisaude/shared';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { BloqueioService } from './bloqueio.service';
import { CampoAceService, MAX_OPERACOES_SYNC } from './campo.service';
import { EstoqueVetorialService } from './estoque-vetorial.service';
import { SupervisaoEndemiasService } from './supervisao.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullish();
// Sincronização do campo: aqui só o envelope; cada operação é validada sozinha no serviço (campo.schema.ts), e a
// inválida volta ERRO sem derrubar as outras do lote.
const syncSchema = z.object({ operacoes: z.array(z.unknown()).min(1).max(MAX_OPERACOES_SYNC) });
const listaSchema = z.object({ situacao: z.enum(['ATIVAS', 'ENCERRADAS', 'TODAS']).optional() });
const designarSchema = z.object({ agentes: z.array(z.string().uuid()).max(50) });
const notaSchema = z.object({ nota: text(2000) });
const motivoSchema = z.object({ motivo: z.string().trim().min(5).max(2000) });
const zonaSchema = z.object({ nome: z.string().trim().min(1).max(60), aceId: z.string().uuid().nullish(), quarteiroes: z.array(z.string().uuid()).max(2000), ativa: z.boolean().optional(), observacao: text(500) });
const periodoSchema = z.object({ de: day.optional(), ate: day.optional() });
const visitasSchema = periodoSchema.extend({ agenteId: z.string().uuid().optional(), situacao: z.enum(SITUACOES_VISITA).optional(), ordemId: z.string().uuid().optional(), quarteiraoId: z.string().uuid().optional() });
// depositoId: depósito de endemias de onde saiu o larvicida (obrigatório quando a unidade da visita não tem depósito).
const resolverSchema = z.object({ acao: z.enum(['BAIXAR', 'REGULARIZAR', 'CANCELAR']), loteId: z.string().uuid().nullish(), depositoId: z.string().uuid().nullish(), nota: z.string().trim().min(5).max(1000) });
const estornoSchema = z.object({ motivo: z.string().trim().min(5).max(500) });
const produtoSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(30)
    .regex(/^[A-Za-z0-9._-]+$/),
  description: z.string().trim().min(3).max(200),
  activeIngredient: text(120),
  concentration: text(60),
  pharmaceuticalForm: text(80),
  unit: z
    .string()
    .trim()
    .min(1)
    .max(6)
    .regex(/^[A-Za-z]+$/),
  tipo: z.enum(['LARVICIDA', 'ADULTICIDA']),
});
const entradaSchema = z.object({
  productId: z.string().uuid(),
  lotNumber: z.string().trim().min(1).max(40),
  expiry: day,
  manufacturedAt: day.nullish(),
  // O estoque guarda três casas decimais: abaixo de 0,001 a entrada seria zero.
  quantity: z
    .number()
    .positive()
    .max(10_000_000)
    .refine((q) => Math.round(q * 1000) >= 1, 'Quantidade mínima de 0,001'),
  document: z.string().trim().min(1).max(60),
  origin: z.enum(['SIES', 'SES', 'MUNICIPIO', 'OUTRA']),
  notes: text(500),
});
const validadeSchema = z.object({ validade: day, documento: z.string().trim().min(3).max(200) });
const configSchema = z.object({
  bloqueioAutomatico: z.boolean().optional(),
  janelaAgrupamentoDias: z.number().int().min(1).max(30).optional(),
  gruposBloqueio: z
    .array(z.enum(['dengue', 'chikungunya', 'zika', 'febre-amarela']))
    .min(1)
    .max(4)
    .optional(),
  alertaSemInicioDias: z.number().int().min(1).max(30).optional(),
});

const hoje = () => new Date().toISOString().slice(0, 10);
const ha = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);

/**
 * Endemias (VIG-3a): app de campo do ACE (pacote sem internet e sincronização), ordens de bloqueio de transmissão,
 * zonas, visitas, pendências, produção, estoque de larvicidas e configuração do bloqueio.
 */
@Controller('endemias')
export class EndemiasController {
  constructor(
    private readonly campo: CampoAceService,
    private readonly bloqueio: BloqueioService,
    private readonly supervisao: SupervisaoEndemiasService,
    private readonly estoque: EstoqueVetorialService,
  ) {}

  // ─── Campo (ACE) ───
  @Get('campo/pacote')
  @RequirePermission('endemias.campo')
  pacote(@Ctx() ctx: RequestContext) {
    return this.campo.pacote(ctx);
  }

  @Post('campo/sync')
  @HttpCode(200)
  @RequirePermission('endemias.campo')
  sync(@Ctx() ctx: RequestContext, @Body(zv(syncSchema)) body: z.infer<typeof syncSchema>) {
    return this.campo.sync(ctx, body.operacoes);
  }

  // ─── Ordens de bloqueio ───
  @Get('bloqueios')
  @RequirePermission('endemias.ler', 'endemias.supervisionar')
  bloqueios(@Ctx() ctx: RequestContext, @Query(zv(listaSchema)) q: z.infer<typeof listaSchema>) {
    return this.bloqueio.listar(ctx, q);
  }

  @Get('bloqueios/da-notificacao/:notificationId')
  @RequirePermission('endemias.ler', 'endemias.supervisionar')
  daNotificacao(@Ctx() ctx: RequestContext, @Param('notificationId', ParseUUIDPipe) id: string) {
    return this.bloqueio.daNotificacao(ctx, id);
  }

  @Get('bloqueios/:id')
  @RequirePermission('endemias.ler', 'endemias.supervisionar')
  bloqueioDetalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.bloqueio.detalhe(ctx, id);
  }

  @Post('bloqueios/:id/agentes')
  @HttpCode(200)
  @RequirePermission('endemias.supervisionar')
  designar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(designarSchema)) body: z.infer<typeof designarSchema>) {
    return this.bloqueio.designar(ctx, id, body.agentes);
  }

  @Post('bloqueios/:id/concluir')
  @HttpCode(200)
  @RequirePermission('endemias.supervisionar')
  concluir(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(notaSchema)) body: z.infer<typeof notaSchema>) {
    return this.bloqueio.concluir(ctx, id, body.nota);
  }

  @Post('bloqueios/:id/reabrir')
  @HttpCode(200)
  @RequirePermission('endemias.supervisionar')
  reabrir(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.bloqueio.reabrir(ctx, id, body.motivo);
  }

  @Post('bloqueios/:id/cancelar')
  @HttpCode(200)
  @RequirePermission('endemias.coordenar')
  cancelar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.bloqueio.cancelar(ctx, id, body.motivo);
  }

  @Post('bloqueios/:id/recalcular')
  @HttpCode(200)
  @RequirePermission('endemias.supervisionar')
  recalcular(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.bloqueio.recalcularManual(ctx, id);
  }

  /** Executa a varredura agora (a tarefa periódica roda a cada 5 minutos). */
  @Post('bloqueios/varredura')
  @HttpCode(200)
  @RequirePermission('endemias.coordenar')
  varredura(@Ctx() ctx: RequestContext) {
    return this.bloqueio.varredura(ctx);
  }

  // ─── Zonas, visitas, pendências, produção ───
  @Get('agentes')
  @RequirePermission('endemias.supervisionar')
  agentes(@Ctx() ctx: RequestContext) {
    return this.supervisao.agentes(ctx);
  }

  @Get('zonas')
  @RequirePermission('endemias.ler', 'endemias.supervisionar')
  zonas(@Ctx() ctx: RequestContext) {
    return this.supervisao.zonas(ctx);
  }

  @Get('zonas/quarteiroes-livres')
  @RequirePermission('endemias.supervisionar')
  livres(@Ctx() ctx: RequestContext) {
    return this.supervisao.quarteiroesLivres(ctx);
  }

  @Post('zonas')
  @RequirePermission('endemias.supervisionar')
  criarZona(@Ctx() ctx: RequestContext, @Body(zv(zonaSchema)) body: z.infer<typeof zonaSchema>) {
    return this.supervisao.salvarZona(ctx, null, body);
  }

  @Put('zonas/:id')
  @RequirePermission('endemias.supervisionar')
  alterarZona(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(zonaSchema)) body: z.infer<typeof zonaSchema>) {
    return this.supervisao.salvarZona(ctx, id, body);
  }

  @Get('visitas')
  @RequirePermission('endemias.ler', 'endemias.supervisionar')
  visitas(@Ctx() ctx: RequestContext, @Query(zv(visitasSchema)) q: z.infer<typeof visitasSchema>) {
    return this.supervisao.visitas(ctx, { ...q, de: q.de ?? ha(7), ate: q.ate ?? hoje() });
  }

  @Get('pendencias')
  @RequirePermission('endemias.supervisionar')
  pendencias(@Ctx() ctx: RequestContext) {
    return this.supervisao.pendencias(ctx);
  }

  @Get('producao')
  @RequirePermission('endemias.ler', 'endemias.supervisionar')
  producao(@Ctx() ctx: RequestContext, @Query(zv(periodoSchema)) q: z.infer<typeof periodoSchema>) {
    return this.supervisao.producao(ctx, { de: q.de ?? ha(30), ate: q.ate ?? hoje() });
  }

  // ─── Estoque de larvicidas ───
  @Get('estoque')
  @RequirePermission('endemias.supervisionar', 'estoque.ler')
  painelEstoque(@Ctx() ctx: RequestContext) {
    return this.estoque.painel(ctx);
  }

  @Get('estoque/pendentes')
  @RequirePermission('endemias.supervisionar')
  baixasPendentes(@Ctx() ctx: RequestContext) {
    return this.estoque.pendentes(ctx);
  }

  @Post('estoque/pendentes/:id/resolver')
  @HttpCode(200)
  @RequirePermission('endemias.supervisionar')
  resolver(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(resolverSchema)) body: z.infer<typeof resolverSchema>) {
    return this.estoque.resolver(ctx, id, body);
  }

  @Post('estoque/produtos')
  @RequirePermission('endemias.coordenar')
  produto(@Ctx() ctx: RequestContext, @Body(zv(produtoSchema)) body: z.infer<typeof produtoSchema>) {
    return this.estoque.cadastrarProduto(ctx, body);
  }

  @Post('estoque/entradas')
  @RequirePermission('endemias.coordenar')
  entrada(@Ctx() ctx: RequestContext, @Body(zv(entradaSchema)) body: z.infer<typeof entradaSchema>) {
    return this.estoque.entrada(ctx, body);
  }

  /** As 100 entradas de remessa mais recentes, com o estorno quando houver. */
  @Get('estoque/entradas')
  @RequirePermission('endemias.supervisionar', 'estoque.ler')
  entradas(@Ctx() ctx: RequestContext) {
    return this.estoque.entradas(ctx);
  }

  /** Estorno da entrada lançada errada (movimento inverso); a mesma guia pode ser lançada de novo. */
  @Post('estoque/entradas/:id/estorno')
  @HttpCode(200)
  @RequirePermission('endemias.coordenar')
  estornar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(estornoSchema)) body: z.infer<typeof estornoSchema>) {
    return this.estoque.estornar(ctx, id, body.motivo);
  }

  @Post('estoque/lotes/:id/validade')
  @HttpCode(200)
  @RequirePermission('endemias.coordenar')
  validade(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(validadeSchema)) body: z.infer<typeof validadeSchema>) {
    return this.estoque.prorrogarValidade(ctx, id, body);
  }

  // ─── Configuração ───
  @Get('configuracao')
  @RequirePermission('endemias.ler', 'endemias.supervisionar')
  config(@Ctx() ctx: RequestContext) {
    return this.supervisao.config(ctx);
  }

  @Put('configuracao')
  @RequirePermission('endemias.coordenar')
  salvarConfig(@Ctx() ctx: RequestContext, @Body(zv(configSchema)) body: z.infer<typeof configSchema>) {
    return this.supervisao.salvarConfig(ctx, body);
  }
}
