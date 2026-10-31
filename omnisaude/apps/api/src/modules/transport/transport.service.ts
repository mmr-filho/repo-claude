import { HttpStatus, Injectable } from '@nestjs/common';
import {
  alertasFrota,
  consumoMedio,
  localDateString,
  ocupacaoViagem,
  STATUS_PASSAGEIRO,
  STATUS_VIAGEM,
  TIPO_VEICULO,
  type StatusPassageiro,
  type StatusViagem,
  type TipoRegistroVeiculo,
  type TipoVeiculo,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, notFound } from '../../core/errors';
import { patientSummary } from '../patients/patients.service';

const DIA = 86_400_000;

export interface VeiculoInput {
  plate: string;
  model: string;
  kind: TipoVeiculo;
  seats?: number | null;
  wheelchair?: boolean;
  odometerKm?: number;
  nextMaintenanceKm?: number | null;
  nextMaintenanceAt?: string | null;
  unitId?: string | null;
  active?: boolean;
  notes?: string | null;
}
export interface MotoristaInput {
  name: string;
  cpf?: string | null;
  phone?: string | null;
  cnh: string;
  cnhCategory: string;
  cnhExpiry: string;
  userId?: string | null;
  active?: boolean;
}
export interface RotaInput {
  name: string;
  destinationCity: string;
  destinationUf: string;
  stops?: { nome: string; endereco?: string | null; horario?: string | null }[];
  weekdays: number[];
  departureTime: string;
  returnTime?: string | null;
  vehicleId?: string | null;
  active?: boolean;
}
export interface ViagemInput {
  routeId?: string | null;
  vehicleId?: string | null;
  driverId: string;
  date: string;
  departureTime?: string | null;
  destinationCity?: string | null;
  destinationUf?: string | null;
  destinationPlace?: string | null;
  notes?: string | null;
}
export interface PassageiroInput {
  patientId: string;
  companionName?: string | null;
  pickupAddress?: string | null;
  appointmentAt?: string | null;
  appointmentPlace?: string | null;
  wheelchair?: boolean;
  tfdId?: string | null;
  requestId?: string | null;
  notes?: string | null;
}

const dia = (v: string) => new Date(`${v}T12:00:00Z`);
const dec = (x: unknown) => (x === null || x === undefined ? null : Number(x));

/** Transporte sanitário: frota, motoristas, rotas, viagens com passageiros, roteiro do dia, manutenção e abastecimento. */
@Injectable()
export class TransportService {
  constructor(private readonly audit: AuditService) {}

  // ─── Frota ──────────────────────────────────────────────────────────────────

  async veiculos(ctx: RequestContext) {
    const hoje = new Date();
    const inicioMes = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));
    const rows = await ctx.db.vehicle.findMany({
      orderBy: [{ active: 'desc' }, { plate: 'asc' }],
      include: { logs: { orderBy: { at: 'asc' } }, trips: { where: { status: 'CONCLUIDA', date: { gte: inicioMes } }, select: { odometerStart: true, odometerEnd: true, fuelCost: true } } },
    });
    const motoristas = await ctx.db.driver.findMany({ where: { active: true }, select: { name: true, cnhExpiry: true } });
    const veiculos = rows.map((v) => {
      const abastecimentos = v.logs.filter((l) => l.kind === 'ABASTECIMENTO').map((l) => ({ odometerKm: l.odometerKm, liters: dec(l.liters) }));
      const kmMes = v.trips.reduce((s, t) => s + (t.odometerEnd !== null && t.odometerStart !== null ? Math.max(0, t.odometerEnd - t.odometerStart) : 0), 0);
      const custoMes = v.logs.filter((l) => l.at >= inicioMes).reduce((s, l) => s + Number(l.cost), 0);
      return {
        id: v.id,
        plate: v.plate,
        model: v.model,
        kind: v.kind,
        kindLabel: TIPO_VEICULO[v.kind].label,
        seats: v.seats,
        wheelchair: v.wheelchair,
        odometerKm: v.odometerKm,
        nextMaintenanceKm: v.nextMaintenanceKm,
        nextMaintenanceAt: v.nextMaintenanceAt?.toISOString().slice(0, 10) ?? null,
        unitId: v.unitId,
        active: v.active,
        notes: v.notes,
        consumoMedioKmL: consumoMedio(abastecimentos),
        kmMes,
        custoMes: Math.round(custoMes * 100) / 100,
        viagensMes: v.trips.length,
        ultimaManutencao:
          v.logs
            .filter((l) => l.kind === 'MANUTENCAO')
            .at(-1)
            ?.at.toISOString() ?? null,
      };
    });
    return {
      veiculos,
      alertas: alertasFrota(
        rows.map((v) => ({ plate: v.plate, odometerKm: v.odometerKm, nextMaintenanceKm: v.nextMaintenanceKm, nextMaintenanceAt: v.nextMaintenanceAt })),
        motoristas,
        hoje,
      ),
    };
  }

  private veiculoData(input: VeiculoInput) {
    return {
      plate: input.plate.toUpperCase().replace(/[^A-Z0-9]/g, ''),
      model: input.model.trim(),
      kind: input.kind,
      seats: input.seats ?? TIPO_VEICULO[input.kind].assentos,
      wheelchair: input.wheelchair ?? false,
      ...(input.odometerKm === undefined ? {} : { odometerKm: input.odometerKm }),
      nextMaintenanceKm: input.nextMaintenanceKm ?? null,
      nextMaintenanceAt: input.nextMaintenanceAt ? dia(input.nextMaintenanceAt) : null,
      unitId: input.unitId ?? null,
      ...(input.active === undefined ? {} : { active: input.active }),
      notes: input.notes?.trim() || null,
    };
  }

  async criarVeiculo(ctx: RequestContext, input: VeiculoInput) {
    const data = this.veiculoData(input);
    if (await ctx.db.vehicle.findUnique({ where: { plate: data.plate } })) throw conflict(`Já existe veículo com a placa ${data.plate}`);
    const v = await ctx.db.vehicle.create({ data });
    await this.audit.recordStandalone(ctx, { action: 'transporte.veiculo.criar', entityType: 'Vehicle', entityId: v.id, payload: data });
    return this.veiculo(ctx, v.id);
  }

  async atualizarVeiculo(ctx: RequestContext, id: string, input: VeiculoInput) {
    if (!(await ctx.db.vehicle.findUnique({ where: { id } }))) throw notFound('Veículo');
    const data = this.veiculoData(input);
    await ctx.db.vehicle.update({ where: { id }, data });
    await this.audit.recordStandalone(ctx, { action: 'transporte.veiculo.atualizar', entityType: 'Vehicle', entityId: id, payload: data });
    return this.veiculo(ctx, id);
  }

  /** Visão de um veículo com consumo, custos e viagens do mês. */
  async veiculo(ctx: RequestContext, id: string) {
    const v = (await this.veiculos(ctx)).veiculos.find((x) => x.id === id);
    if (!v) throw notFound('Veículo');
    return v;
  }

  async registros(ctx: RequestContext, vehicleId: string) {
    if (!(await ctx.db.vehicle.findUnique({ where: { id: vehicleId } }))) throw notFound('Veículo');
    const rows = await ctx.db.vehicleLog.findMany({ where: { vehicleId }, orderBy: { at: 'desc' }, take: 200 });
    const users = new Map((await ctx.db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((r) => ({ id: r.id, kind: r.kind, at: r.at.toISOString(), odometerKm: r.odometerKm, cost: Number(r.cost), liters: dec(r.liters), description: r.description, usuario: users.get(r.userId) ?? null }));
  }

  /** Manutenção ou abastecimento: atualiza o odômetro do veículo e, na manutenção, a próxima prevista. */
  async registrar(
    ctx: RequestContext,
    vehicleId: string,
    input: { kind: TipoRegistroVeiculo; odometerKm: number; cost: number; liters?: number | null; description: string; at?: string | null; nextMaintenanceKm?: number | null; nextMaintenanceAt?: string | null },
  ) {
    const v = await ctx.db.vehicle.findUnique({ where: { id: vehicleId } });
    if (!v) throw notFound('Veículo');
    if (input.kind === 'ABASTECIMENTO' && !(input.liters && input.liters > 0)) throw new DomainError('LITROS_OBRIGATORIOS', 'Informe os litros do abastecimento', HttpStatus.UNPROCESSABLE_ENTITY);
    return ctx.db.$transaction(async (tx) => {
      const log = await tx.vehicleLog.create({
        data: {
          vehicleId,
          kind: input.kind,
          at: input.at ? new Date(input.at) : new Date(),
          odometerKm: input.odometerKm,
          cost: input.cost,
          liters: input.liters ?? null,
          description: input.description.trim(),
          userId: ctx.session.userId,
        },
      });
      await tx.vehicle.update({
        where: { id: vehicleId },
        data: {
          odometerKm: Math.max(v.odometerKm, input.odometerKm),
          ...(input.kind === 'MANUTENCAO'
            ? {
                nextMaintenanceKm: input.nextMaintenanceKm === undefined ? v.nextMaintenanceKm : input.nextMaintenanceKm,
                nextMaintenanceAt: input.nextMaintenanceAt === undefined ? v.nextMaintenanceAt : input.nextMaintenanceAt ? dia(input.nextMaintenanceAt) : null,
              }
            : {}),
        },
      });
      await this.audit.record(ctx, tx, {
        action: 'transporte.veiculo.registro',
        entityType: 'Vehicle',
        entityId: vehicleId,
        payload: { kind: input.kind, odometerKm: input.odometerKm, cost: input.cost, liters: input.liters ?? null },
      });
      return { ...log, cost: Number(log.cost), liters: dec(log.liters) };
    });
  }

  // ─── Motoristas e rotas ───────────────────────────────────────────────────────

  async motoristas(ctx: RequestContext) {
    const hoje = Date.now();
    const rows = await ctx.db.driver.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] });
    return rows.map((d) => ({
      ...d,
      cnhExpiry: d.cnhExpiry.toISOString().slice(0, 10),
      cnhVencida: d.cnhExpiry.getTime() < hoje,
      cnhVenceEm30: d.cnhExpiry.getTime() >= hoje && d.cnhExpiry.getTime() <= hoje + 30 * DIA,
    }));
  }

  private motoristaData(input: MotoristaInput) {
    return {
      name: input.name.trim(),
      cpf: input.cpf?.replace(/\D/g, '') || null,
      phone: input.phone?.trim() || null,
      cnh: input.cnh.trim(),
      cnhCategory: input.cnhCategory.toUpperCase().padEnd(2, ' ').slice(0, 2).trim().padEnd(2),
      cnhExpiry: dia(input.cnhExpiry),
      userId: input.userId ?? null,
      ...(input.active === undefined ? {} : { active: input.active }),
    };
  }

  async criarMotorista(ctx: RequestContext, input: MotoristaInput) {
    const d = await ctx.db.driver.create({ data: this.motoristaData(input) });
    await this.audit.recordStandalone(ctx, { action: 'transporte.motorista.criar', entityType: 'Driver', entityId: d.id, payload: { name: d.name, cnh: d.cnh } });
    return d;
  }

  async atualizarMotorista(ctx: RequestContext, id: string, input: MotoristaInput) {
    if (!(await ctx.db.driver.findUnique({ where: { id } }))) throw notFound('Motorista');
    const d = await ctx.db.driver.update({ where: { id }, data: this.motoristaData(input) });
    await this.audit.recordStandalone(ctx, { action: 'transporte.motorista.atualizar', entityType: 'Driver', entityId: id, payload: { name: d.name } });
    return d;
  }

  rotas(ctx: RequestContext) {
    return ctx.db.transportRoute.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] });
  }

  private rotaData(input: RotaInput) {
    if (!/^\d{2}:\d{2}$/.test(input.departureTime)) throw new DomainError('HORARIO_INVALIDO', 'Horário de saída no formato HH:MM', HttpStatus.UNPROCESSABLE_ENTITY);
    return {
      name: input.name.trim(),
      destinationCity: input.destinationCity.trim(),
      destinationUf: input.destinationUf.toUpperCase(),
      stops: (input.stops ?? []).map((s) => ({ nome: s.nome.trim(), endereco: s.endereco?.trim() || null, horario: s.horario?.trim() || null })),
      weekdays: [...new Set(input.weekdays)].sort(),
      departureTime: input.departureTime,
      returnTime: input.returnTime?.trim() || null,
      vehicleId: input.vehicleId ?? null,
      ...(input.active === undefined ? {} : { active: input.active }),
    };
  }

  async criarRota(ctx: RequestContext, input: RotaInput) {
    const r = await ctx.db.transportRoute.create({ data: this.rotaData(input) });
    await this.audit.recordStandalone(ctx, { action: 'transporte.rota.criar', entityType: 'TransportRoute', entityId: r.id, payload: { name: r.name } });
    return r;
  }

  async atualizarRota(ctx: RequestContext, id: string, input: RotaInput) {
    if (!(await ctx.db.transportRoute.findUnique({ where: { id } }))) throw notFound('Rota');
    const r = await ctx.db.transportRoute.update({ where: { id }, data: this.rotaData(input) });
    await this.audit.recordStandalone(ctx, { action: 'transporte.rota.atualizar', entityType: 'TransportRoute', entityId: id, payload: { name: r.name } });
    return r;
  }

  // ─── Viagens ─────────────────────────────────────────────────────────────────

  private readonly tripInclude = {
    vehicle: { select: { id: true, plate: true, model: true, kind: true, seats: true, wheelchair: true } },
    driver: { select: { id: true, name: true, phone: true, cnhExpiry: true } },
    route: { select: { id: true, name: true, stops: true, returnTime: true } },
    passengers: { include: { patient: { select: { id: true, name: true, socialName: true, cns: true, cpf: true, birthDate: true, sex: true, motherName: true, phone: true } } }, orderBy: { createdAt: 'asc' as const } },
  };

  private viagemView(t: {
    id: string;
    routeId: string | null;
    date: Date;
    departureTime: string;
    destinationCity: string;
    destinationUf: string;
    destinationPlace: string | null;
    status: StatusViagem;
    odometerStart: number | null;
    odometerEnd: number | null;
    fuelLiters: unknown;
    fuelCost: unknown;
    notes: string | null;
    createdAt: Date;
    vehicle: { id: string; plate: string; model: string; kind: TipoVeiculo; seats: number; wheelchair: boolean };
    driver: { id: string; name: string; phone: string | null; cnhExpiry: Date };
    route: { id: string; name: string; stops: unknown; returnTime: string | null } | null;
    passengers: {
      id: string;
      patientId: string;
      companionName: string | null;
      pickupAddress: string | null;
      appointmentAt: Date | null;
      appointmentPlace: string | null;
      wheelchair: boolean;
      tfdId: string | null;
      requestId: string | null;
      status: StatusPassageiro;
      notes: string | null;
      patient: Parameters<typeof patientSummary>[0] & { phone: string | null };
    }[];
  }) {
    const ocupacao = ocupacaoViagem(
      t.vehicle.seats,
      t.passengers.map((p) => ({ status: p.status, acompanhante: !!p.companionName, cadeirante: p.wheelchair })),
    );
    return {
      id: t.id,
      routeId: t.routeId,
      route: t.route,
      date: t.date.toISOString().slice(0, 10),
      departureTime: t.departureTime,
      destinationCity: t.destinationCity,
      destinationUf: t.destinationUf,
      destinationPlace: t.destinationPlace,
      status: t.status,
      statusLabel: STATUS_VIAGEM[t.status],
      odometerStart: t.odometerStart,
      odometerEnd: t.odometerEnd,
      km: t.odometerStart !== null && t.odometerEnd !== null ? Math.max(0, t.odometerEnd - t.odometerStart) : null,
      fuelLiters: dec(t.fuelLiters),
      fuelCost: dec(t.fuelCost),
      notes: t.notes,
      vehicle: { ...t.vehicle, kindLabel: TIPO_VEICULO[t.vehicle.kind].label },
      driver: { id: t.driver.id, name: t.driver.name, phone: t.driver.phone, cnhVencida: t.driver.cnhExpiry.getTime() < Date.now() },
      ocupacao,
      passageiros: t.passengers.map((p) => ({
        id: p.id,
        paciente: { ...patientSummary(p.patient), phone: p.patient.phone },
        companionName: p.companionName,
        pickupAddress: p.pickupAddress,
        appointmentAt: p.appointmentAt?.toISOString() ?? null,
        appointmentPlace: p.appointmentPlace,
        wheelchair: p.wheelchair,
        tfdId: p.tfdId,
        requestId: p.requestId,
        status: p.status,
        statusLabel: STATUS_PASSAGEIRO[p.status],
        notes: p.notes,
      })),
      createdAt: t.createdAt.toISOString(),
    };
  }

  async viagens(ctx: RequestContext, q: { from?: string; to?: string; status?: StatusViagem; vehicleId?: string; patientId?: string }) {
    const from = q.from ? dia(q.from) : new Date(Date.now() - 30 * DIA);
    const to = q.to ? dia(q.to) : new Date(Date.now() + 60 * DIA);
    const rows = await ctx.db.transportTrip.findMany({
      where: { date: { gte: from, lte: to }, ...(q.status ? { status: q.status } : {}), ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}), ...(q.patientId ? { passengers: { some: { patientId: q.patientId } } } : {}) },
      include: this.tripInclude,
      orderBy: [{ date: 'asc' }, { departureTime: 'asc' }],
      take: 300,
    });
    return rows.map((t) => this.viagemView(t));
  }

  async viagem(ctx: RequestContext, id: string) {
    const t = await ctx.db.transportTrip.findUnique({ where: { id }, include: this.tripInclude });
    if (!t) throw notFound('Viagem');
    return this.viagemView(t);
  }

  async criarViagem(ctx: RequestContext, input: ViagemInput) {
    const route = input.routeId ? await ctx.db.transportRoute.findUnique({ where: { id: input.routeId } }) : null;
    if (input.routeId && !route) throw notFound('Rota');
    const vehicleId = input.vehicleId ?? route?.vehicleId ?? null;
    if (!vehicleId) throw new DomainError('VEICULO_OBRIGATORIO', 'Informe o veículo da viagem', HttpStatus.UNPROCESSABLE_ENTITY);
    const vehicle = await ctx.db.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle || !vehicle.active) throw notFound('Veículo');
    const driver = await ctx.db.driver.findUnique({ where: { id: input.driverId } });
    if (!driver || !driver.active) throw notFound('Motorista');
    if (driver.cnhExpiry.getTime() < Date.now()) throw new DomainError('CNH_VENCIDA', `${driver.name} está com a CNH vencida`, HttpStatus.UNPROCESSABLE_ENTITY);
    const departureTime = input.departureTime ?? route?.departureTime;
    if (!departureTime || !/^\d{2}:\d{2}$/.test(departureTime)) throw new DomainError('HORARIO_INVALIDO', 'Horário de saída no formato HH:MM', HttpStatus.UNPROCESSABLE_ENTITY);
    const date = dia(input.date);
    const ocupado = await ctx.db.transportTrip.findFirst({ where: { vehicleId, date, departureTime, status: { not: 'CANCELADA' } } });
    if (ocupado) throw conflict(`${vehicle.plate} já tem viagem em ${input.date} às ${departureTime}`);
    const t = await ctx.db.transportTrip.create({
      data: {
        routeId: route?.id ?? null,
        vehicleId,
        driverId: driver.id,
        date,
        departureTime,
        destinationCity: (input.destinationCity ?? route?.destinationCity ?? '').trim(),
        destinationUf: (input.destinationUf ?? route?.destinationUf ?? '').toUpperCase(),
        destinationPlace: input.destinationPlace?.trim() || null,
        notes: input.notes?.trim() || null,
        createdBy: ctx.session.userId,
      },
    });
    if (!t.destinationCity) throw new DomainError('DESTINO_OBRIGATORIO', 'Informe o destino da viagem', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.audit.recordStandalone(ctx, { action: 'transporte.viagem.criar', entityType: 'TransportTrip', entityId: t.id, payload: { date: input.date, vehicleId, driverId: driver.id, destino: t.destinationCity } });
    return this.viagem(ctx, t.id);
  }

  async adicionarPassageiro(ctx: RequestContext, tripId: string, input: PassageiroInput) {
    const t = await ctx.db.transportTrip.findUnique({ where: { id: tripId }, include: this.tripInclude });
    if (!t) throw notFound('Viagem');
    if (t.status === 'CONCLUIDA' || t.status === 'CANCELADA') throw new DomainError('VIAGEM_ENCERRADA', `Viagem ${STATUS_VIAGEM[t.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId } });
    if (!patient || patient.mergedIntoId) throw notFound('Paciente');
    if (t.passengers.some((p) => p.patientId === input.patientId && p.status !== 'CANCELADO')) throw conflict('Esta pessoa já está nesta viagem');
    const ocupacao = ocupacaoViagem(
      t.vehicle.seats,
      t.passengers.map((p) => ({ status: p.status, acompanhante: !!p.companionName, cadeirante: p.wheelchair })),
    );
    const precisa = 1 + (input.companionName ? 1 : 0);
    if (ocupacao.livres < precisa) throw new DomainError('VIAGEM_LOTADA', `Sem lugar: ${ocupacao.usados}/${ocupacao.assentos} ocupados`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.wheelchair && !t.vehicle.wheelchair) throw new DomainError('SEM_ACESSIBILIDADE', `${t.vehicle.plate} não transporta cadeirante`, HttpStatus.UNPROCESSABLE_ENTITY);
    const endereco = input.pickupAddress?.trim() || [patient.street, patient.number, patient.district].filter(Boolean).join(', ') || null;
    const p = await ctx.db.transportPassenger.create({
      data: {
        tripId,
        patientId: input.patientId,
        companionName: input.companionName?.trim() || null,
        pickupAddress: endereco,
        appointmentAt: input.appointmentAt ? new Date(input.appointmentAt) : null,
        appointmentPlace: input.appointmentPlace?.trim() || null,
        wheelchair: input.wheelchair ?? false,
        tfdId: input.tfdId ?? null,
        requestId: input.requestId ?? null,
        notes: input.notes?.trim() || null,
      },
    });
    await this.audit.recordStandalone(ctx, { action: 'transporte.passageiro.incluir', entityType: 'TransportTrip', entityId: tripId, payload: { patientId: input.patientId, tfdId: input.tfdId ?? null } });
    return { passageiroId: p.id, viagem: await this.viagem(ctx, tripId) };
  }

  async statusPassageiro(ctx: RequestContext, passengerId: string, status: StatusPassageiro, notes?: string | null) {
    const p = await ctx.db.transportPassenger.findUnique({ where: { id: passengerId } });
    if (!p) throw notFound('Passageiro');
    await ctx.db.transportPassenger.update({ where: { id: passengerId }, data: { status, ...(notes === undefined ? {} : { notes: notes?.trim() || null }) } });
    await this.audit.recordStandalone(ctx, { action: 'transporte.passageiro.status', entityType: 'TransportTrip', entityId: p.tripId, payload: { passengerId, status } });
    return this.viagem(ctx, p.tripId);
  }

  async iniciar(ctx: RequestContext, id: string, odometerStart: number) {
    const t = await ctx.db.transportTrip.findUnique({ where: { id }, include: { vehicle: true } });
    if (!t) throw notFound('Viagem');
    if (t.status !== 'PLANEJADA') throw new DomainError('STATUS_INVALIDO', `Viagem ${STATUS_VIAGEM[t.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.$transaction(async (tx) => {
      await tx.transportTrip.update({ where: { id }, data: { status: 'EM_ANDAMENTO', odometerStart } });
      await tx.vehicle.update({ where: { id: t.vehicleId }, data: { odometerKm: Math.max(t.vehicle.odometerKm, odometerStart) } });
      await this.audit.record(ctx, tx, { action: 'transporte.viagem.iniciar', entityType: 'TransportTrip', entityId: id, payload: { odometerStart } });
    });
    return this.viagem(ctx, id);
  }

  /** Conclui a viagem: km rodados, combustível (vira registro de abastecimento) e quem ainda estava "agendado" passa a embarcado. */
  async concluir(ctx: RequestContext, id: string, input: { odometerEnd: number; fuelLiters?: number | null; fuelCost?: number | null; notes?: string | null }) {
    const t = await ctx.db.transportTrip.findUnique({ where: { id }, include: { vehicle: true } });
    if (!t) throw notFound('Viagem');
    if (t.status !== 'EM_ANDAMENTO' && t.status !== 'PLANEJADA') throw new DomainError('STATUS_INVALIDO', `Viagem ${STATUS_VIAGEM[t.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (t.odometerStart !== null && input.odometerEnd < t.odometerStart) throw new DomainError('ODOMETRO_INVALIDO', 'Odômetro final menor que o inicial', HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.$transaction(async (tx) => {
      await tx.transportTrip.update({
        where: { id },
        data: { status: 'CONCLUIDA', odometerEnd: input.odometerEnd, fuelLiters: input.fuelLiters ?? null, fuelCost: input.fuelCost ?? null, notes: input.notes?.trim() || t.notes },
      });
      await tx.transportPassenger.updateMany({ where: { tripId: id, status: 'AGENDADO' }, data: { status: 'EMBARCOU' } });
      await tx.vehicle.update({ where: { id: t.vehicleId }, data: { odometerKm: Math.max(t.vehicle.odometerKm, input.odometerEnd) } });
      if (input.fuelLiters && input.fuelCost !== null && input.fuelCost !== undefined) {
        await tx.vehicleLog.create({
          data: {
            vehicleId: t.vehicleId,
            kind: 'ABASTECIMENTO',
            odometerKm: input.odometerEnd,
            cost: input.fuelCost,
            liters: input.fuelLiters,
            description: `Abastecimento na viagem para ${t.destinationCity}`,
            userId: ctx.session.userId,
          },
        });
      }
      await this.audit.record(ctx, tx, {
        action: 'transporte.viagem.concluir',
        entityType: 'TransportTrip',
        entityId: id,
        payload: { odometerEnd: input.odometerEnd, fuelLiters: input.fuelLiters ?? null, fuelCost: input.fuelCost ?? null },
      });
    });
    return this.viagem(ctx, id);
  }

  async cancelarViagem(ctx: RequestContext, id: string, reason: string) {
    const t = await ctx.db.transportTrip.findUnique({ where: { id } });
    if (!t) throw notFound('Viagem');
    if (t.status === 'CONCLUIDA' || t.status === 'CANCELADA') throw new DomainError('STATUS_INVALIDO', `Viagem ${STATUS_VIAGEM[t.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.$transaction(async (tx) => {
      await tx.transportTrip.update({ where: { id }, data: { status: 'CANCELADA', notes: reason.trim() } });
      await tx.transportPassenger.updateMany({ where: { tripId: id, status: { in: ['AGENDADO', 'EMBARCOU'] } }, data: { status: 'CANCELADO' } });
      await this.audit.record(ctx, tx, { action: 'transporte.viagem.cancelar', entityType: 'TransportTrip', entityId: id, payload: { reason } });
    });
    return this.viagem(ctx, id);
  }

  /** Roteiro do dia: viagens com veículo, motorista e passageiros (ordem de embarque pelos pontos da rota e endereço). */
  async roteiro(ctx: RequestContext, date: string) {
    const rows = await ctx.db.transportTrip.findMany({ where: { date: dia(date), status: { not: 'CANCELADA' } }, include: this.tripInclude, orderBy: [{ departureTime: 'asc' }] });
    const viagens = rows.map((t) => this.viagemView(t));
    const { alertas } = await this.veiculos(ctx);
    return {
      date,
      viagens,
      totais: { viagens: viagens.length, passageiros: viagens.reduce((s, v) => s + v.passageiros.filter((p) => p.status !== 'CANCELADO').length, 0), cadeirantes: viagens.reduce((s, v) => s + v.ocupacao.cadeirantes, 0) },
      alertas,
    };
  }

  /** Indicadores do período por veículo: viagens, km, passageiros, custo de combustível e manutenção. */
  async indicadores(ctx: RequestContext, from: string, to: string) {
    const f = dia(from);
    const t = new Date(dia(to).getTime() + DIA);
    const [veiculos, viagens, logs] = await Promise.all([
      ctx.db.vehicle.findMany({ select: { id: true, plate: true, model: true } }),
      ctx.db.transportTrip.findMany({ where: { date: { gte: f, lt: t }, status: 'CONCLUIDA' }, include: { passengers: { select: { status: true } } } }),
      ctx.db.vehicleLog.findMany({ where: { at: { gte: f, lt: t } } }),
    ]);
    const porVeiculo = veiculos.map((v) => {
      const vs = viagens.filter((x) => x.vehicleId === v.id);
      const ls = logs.filter((l) => l.vehicleId === v.id);
      const km = vs.reduce((s, x) => s + (x.odometerStart !== null && x.odometerEnd !== null ? Math.max(0, x.odometerEnd - x.odometerStart) : 0), 0);
      const combustivel = ls.filter((l) => l.kind === 'ABASTECIMENTO').reduce((s, l) => s + Number(l.cost), 0);
      const manutencao = ls.filter((l) => l.kind === 'MANUTENCAO').reduce((s, l) => s + Number(l.cost), 0);
      return {
        vehicleId: v.id,
        plate: v.plate,
        model: v.model,
        viagens: vs.length,
        km,
        passageiros: vs.reduce((s, x) => s + x.passengers.filter((p) => p.status === 'EMBARCOU').length, 0),
        faltas: vs.reduce((s, x) => s + x.passengers.filter((p) => p.status === 'FALTOU').length, 0),
        combustivel: Math.round(combustivel * 100) / 100,
        manutencao: Math.round(manutencao * 100) / 100,
        custoPorKm: km > 0 ? Math.round(((combustivel + manutencao) / km) * 100) / 100 : null,
      };
    });
    return {
      from,
      to,
      porVeiculo,
      totais: porVeiculo.reduce(
        (a, b) => ({ viagens: a.viagens + b.viagens, km: a.km + b.km, passageiros: a.passageiros + b.passageiros, faltas: a.faltas + b.faltas, custo: Math.round((a.custo + b.combustivel + b.manutencao) * 100) / 100 }),
        { viagens: 0, km: 0, passageiros: 0, faltas: 0, custo: 0 },
      ),
    };
  }

  hoje(ctx: RequestContext) {
    return localDateString(new Date(), ctx.tenant.timeZone);
  }
}
