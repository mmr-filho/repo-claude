import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { UFS } from '@omnisaude/shared';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { TransportService } from './transport.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const hora = z.string().regex(/^\d{2}:\d{2}$/, 'Horário no formato HH:MM');
const texto = (max: number) => z.string().trim().max(max);
const veiculoSchema = z.object({
  plate: texto(10).min(7),
  model: texto(80).min(2),
  kind: z.enum(['AMBULANCIA_BASICA', 'AMBULANCIA_UTI', 'VAN', 'MICRO_ONIBUS', 'ONIBUS', 'CARRO']),
  seats: z.number().int().min(1).max(60).nullish(),
  wheelchair: z.boolean().optional(),
  odometerKm: z.number().int().min(0).optional(),
  nextMaintenanceKm: z.number().int().min(0).nullish(),
  nextMaintenanceAt: day.nullish(),
  unitId: z.string().uuid().nullish(),
  active: z.boolean().optional(),
  notes: texto(500).nullish(),
});
const registroSchema = z.object({
  kind: z.enum(['MANUTENCAO', 'ABASTECIMENTO']),
  odometerKm: z.number().int().min(0),
  cost: z.number().min(0),
  liters: z.number().positive().nullish(),
  description: texto(300).min(2),
  at: z.string().datetime({ offset: true }).nullish(),
  nextMaintenanceKm: z.number().int().min(0).nullish(),
  nextMaintenanceAt: day.nullish(),
});
const motoristaSchema = z.object({
  name: texto(120).min(3),
  cpf: texto(14).nullish(),
  phone: texto(30).nullish(),
  cnh: texto(20).min(5),
  cnhCategory: texto(2).min(1),
  cnhExpiry: day,
  userId: z.string().uuid().nullish(),
  active: z.boolean().optional(),
});
const rotaSchema = z.object({
  name: texto(120).min(3),
  destinationCity: texto(80).min(2),
  destinationUf: z.enum(UFS),
  stops: z
    .array(z.object({ nome: texto(120).min(1), endereco: texto(200).nullish(), horario: hora.nullish() }))
    .max(30)
    .optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  departureTime: hora,
  returnTime: hora.nullish(),
  vehicleId: z.string().uuid().nullish(),
  active: z.boolean().optional(),
});
const viagemSchema = z.object({
  routeId: z.string().uuid().nullish(),
  vehicleId: z.string().uuid().nullish(),
  driverId: z.string().uuid(),
  date: day,
  departureTime: hora.nullish(),
  destinationCity: texto(80).nullish(),
  destinationUf: z.enum(UFS).nullish(),
  destinationPlace: texto(160).nullish(),
  notes: texto(500).nullish(),
});
const passageiroSchema = z.object({
  patientId: z.string().uuid(),
  companionName: texto(120).nullish(),
  pickupAddress: texto(200).nullish(),
  appointmentAt: z.string().datetime({ offset: true }).nullish(),
  appointmentPlace: texto(160).nullish(),
  wheelchair: z.boolean().optional(),
  tfdId: z.string().uuid().nullish(),
  requestId: z.string().uuid().nullish(),
  notes: texto(300).nullish(),
});
const statusPassageiroSchema = z.object({ status: z.enum(['AGENDADO', 'EMBARCOU', 'FALTOU', 'CANCELADO']), notes: texto(300).nullish() });
const listaViagensSchema = z.object({
  from: day.optional(),
  to: day.optional(),
  status: z.enum(['PLANEJADA', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA']).optional(),
  vehicleId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
});
const iniciarSchema = z.object({ odometerStart: z.number().int().min(0) });
const concluirSchema = z.object({ odometerEnd: z.number().int().min(0), fuelLiters: z.number().positive().nullish(), fuelCost: z.number().min(0).nullish(), notes: texto(500).nullish() });
const motivoSchema = z.object({ reason: texto(500).min(3) });

/** Transporte sanitário: frota, motoristas, rotas, viagens com passageiros, roteiro do dia, manutenção e abastecimento. */
@Controller('transporte')
export class TransportController {
  constructor(private readonly transport: TransportService) {}

  @Get('veiculos')
  @RequirePermission('transporte.ler')
  veiculos(@Ctx() ctx: RequestContext) {
    return this.transport.veiculos(ctx);
  }

  @Post('veiculos')
  @RequirePermission('transporte.gerir')
  criarVeiculo(@Ctx() ctx: RequestContext, @Body(zv(veiculoSchema)) body: z.infer<typeof veiculoSchema>) {
    return this.transport.criarVeiculo(ctx, body);
  }

  @Patch('veiculos/:id')
  @RequirePermission('transporte.gerir')
  atualizarVeiculo(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(veiculoSchema)) body: z.infer<typeof veiculoSchema>) {
    return this.transport.atualizarVeiculo(ctx, id, body);
  }

  @Get('veiculos/:id/registros')
  @RequirePermission('transporte.ler')
  registros(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.transport.registros(ctx, id);
  }

  @Post('veiculos/:id/registros')
  @RequirePermission('transporte.gerir')
  registrar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(registroSchema)) body: z.infer<typeof registroSchema>) {
    return this.transport.registrar(ctx, id, body);
  }

  @Get('motoristas')
  @RequirePermission('transporte.ler')
  motoristas(@Ctx() ctx: RequestContext) {
    return this.transport.motoristas(ctx);
  }

  @Post('motoristas')
  @RequirePermission('transporte.gerir')
  criarMotorista(@Ctx() ctx: RequestContext, @Body(zv(motoristaSchema)) body: z.infer<typeof motoristaSchema>) {
    return this.transport.criarMotorista(ctx, body);
  }

  @Patch('motoristas/:id')
  @RequirePermission('transporte.gerir')
  atualizarMotorista(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motoristaSchema)) body: z.infer<typeof motoristaSchema>) {
    return this.transport.atualizarMotorista(ctx, id, body);
  }

  @Get('rotas')
  @RequirePermission('transporte.ler')
  rotas(@Ctx() ctx: RequestContext) {
    return this.transport.rotas(ctx);
  }

  @Post('rotas')
  @RequirePermission('transporte.gerir')
  criarRota(@Ctx() ctx: RequestContext, @Body(zv(rotaSchema)) body: z.infer<typeof rotaSchema>) {
    return this.transport.criarRota(ctx, body);
  }

  @Patch('rotas/:id')
  @RequirePermission('transporte.gerir')
  atualizarRota(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(rotaSchema)) body: z.infer<typeof rotaSchema>) {
    return this.transport.atualizarRota(ctx, id, body);
  }

  @Get('viagens')
  @RequirePermission('transporte.ler')
  viagens(@Ctx() ctx: RequestContext, @Query(zv(listaViagensSchema)) q: z.infer<typeof listaViagensSchema>) {
    return this.transport.viagens(ctx, q);
  }

  @Post('viagens')
  @RequirePermission('transporte.gerir')
  criarViagem(@Ctx() ctx: RequestContext, @Body(zv(viagemSchema)) body: z.infer<typeof viagemSchema>) {
    return this.transport.criarViagem(ctx, body);
  }

  @Get('viagens/:id')
  @RequirePermission('transporte.ler')
  viagem(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.transport.viagem(ctx, id);
  }

  @Post('viagens/:id/passageiros')
  @HttpCode(200)
  @RequirePermission('transporte.gerir', 'tfd.gerir')
  passageiro(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(passageiroSchema)) body: z.infer<typeof passageiroSchema>) {
    return this.transport.adicionarPassageiro(ctx, id, body);
  }

  @Post('passageiros/:id/status')
  @HttpCode(200)
  @RequirePermission('transporte.gerir')
  statusPassageiro(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(statusPassageiroSchema)) body: z.infer<typeof statusPassageiroSchema>) {
    return this.transport.statusPassageiro(ctx, id, body.status, body.notes);
  }

  @Post('viagens/:id/iniciar')
  @HttpCode(200)
  @RequirePermission('transporte.gerir')
  iniciar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(iniciarSchema)) body: z.infer<typeof iniciarSchema>) {
    return this.transport.iniciar(ctx, id, body.odometerStart);
  }

  @Post('viagens/:id/concluir')
  @HttpCode(200)
  @RequirePermission('transporte.gerir')
  concluir(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(concluirSchema)) body: z.infer<typeof concluirSchema>) {
    return this.transport.concluir(ctx, id, body);
  }

  @Post('viagens/:id/cancelar')
  @HttpCode(200)
  @RequirePermission('transporte.gerir')
  cancelar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.transport.cancelarViagem(ctx, id, body.reason);
  }

  @Get('roteiro')
  @RequirePermission('transporte.ler')
  roteiro(@Ctx() ctx: RequestContext, @Query('date') date?: string) {
    return this.transport.roteiro(ctx, date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : this.transport.hoje(ctx));
  }

  @Get('indicadores')
  @RequirePermission('transporte.ler')
  indicadores(@Ctx() ctx: RequestContext, @Query('from') from?: string, @Query('to') to?: string) {
    const hoje = this.transport.hoje(ctx);
    const ok = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    return this.transport.indicadores(ctx, ok(from) ?? `${hoje.slice(0, 7)}-01`, ok(to) ?? hoje);
  }
}
