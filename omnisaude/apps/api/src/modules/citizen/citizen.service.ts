import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ageInYears,
  aprazar,
  componentesDaVacina,
  localDateString,
  mascararTelefone,
  podeCancelarAgendamento,
  podeConfirmarAgendamento,
  posologia,
  PRIORIDADES,
  PRIORIDADE_LEITO,
  proximasDoses,
  STATUS_AGENDAMENTO_CIDADAO,
  STATUS_EXAME_CIDADAO,
  STATUS_NA_FILA,
  STATUS_SENHA_CIDADAO,
  STATUS_SOLICITACAO,
  STATUS_SOLICITACAO_LEITO,
  STATUS_TFD,
  TIPO_LEITO,
  TRANSPORTE_TFD,
  UNIT_TYPE_LABELS,
  usoContinuo,
  type DoseAplicada,
  type TipoLeito,
  type TransporteTfd,
} from '@omnisaude/shared';
import type { CitizenContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { SchedulingService } from '../scheduling/scheduling.service';
import { renderDocument } from '../signatures/pdf';
import { certificadoVacinacaoModel } from '../vaccines/certificate';

const DIA = 86_400_000;
/** Como o cidadão lê o código da dose (tabela do e-SUS: 1-4 doses, 6/7 reforços, 8 dose de campanha, 9 dose única). */
const DOSE_CIDADAO: Record<string, string> = { '6': 'Reforço', '7': '2º reforço', '8': 'Dose da campanha', '9': 'Dose única' };
/** Unidades que atendem o público (as demais são apoio: SAMU, almoxarifado, laboratório). */
const TIPOS_ABERTOS_AO_PUBLICO = ['UBS', 'UPA', 'POLICLINICA', 'HOSPITAL', 'CEO', 'CAPS', 'FARMACIA_CENTRAL'] as const;

/** O que o cidadão vê no app: agenda, exames, vacinas, medicamentos, regulação/TFD, senha do dia e unidades. */
@Injectable()
export class CitizenService {
  constructor(private readonly scheduling: SchedulingService) {}

  private async paciente(c: CitizenContext) {
    const p = await c.db.patient.findUnique({ where: { id: c.patientId }, include: { family: { include: { household: { select: { unitId: true } } } } } });
    if (!p) throw notFound('Cadastro');
    return p;
  }

  private async nomesUnidades(c: CitizenContext, ids: (string | null | undefined)[]) {
    const set = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = set.length ? await c.db.unit.findMany({ where: { id: { in: set } }, select: { id: true, name: true, address: true, phone: true } }) : [];
    return new Map(rows.map((u) => [u.id, u]));
  }

  private async nomesUsuarios(c: CitizenContext, ids: (string | null | undefined)[]) {
    const set = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = set.length ? await c.db.user.findMany({ where: { id: { in: set } }, select: { id: true, name: true, socialName: true } }) : [];
    return new Map(rows.map((u) => [u.id, u.socialName ?? u.name]));
  }

  /** Resumo da pessoa e o que precisa de atenção. */
  async eu(c: CitizenContext) {
    const p = await this.paciente(c);
    const agora = new Date();
    // Unidade de referência: a do domicílio; sem domicílio vinculado, a do último atendimento ou agendamento.
    let unitId = p.family?.household.unitId ?? null;
    if (!unitId) {
      // Prefere uma UBS (porta de entrada); UPA e hospital só se não houver outra passagem pela rede.
      const [encs, appts] = await Promise.all([
        c.db.encounter.findMany({ where: { patientId: p.id }, orderBy: { startedAt: 'desc' }, take: 10, select: { unit: { select: { id: true, type: true } } } }),
        c.db.appointment.findMany({ where: { patientId: p.id }, orderBy: { startsAt: 'desc' }, take: 10, select: { schedule: { select: { unit: { select: { id: true, type: true } } } } } }),
      ]);
      const vistas = [...encs.map((e) => e.unit), ...appts.map((a) => a.schedule.unit)];
      unitId = vistas.find((u) => u.type === 'UBS')?.id ?? vistas[0]?.id ?? null;
    }
    const [unidade, proximo, examesNovos, vacinas, regAbertas, leitosAbertos, tfdAbertos, senha] = await Promise.all([
      unitId ? c.db.unit.findUnique({ where: { id: unitId }, select: { id: true, name: true, address: true, phone: true, openingHours: true } }) : null,
      c.db.appointment.findFirst({
        where: { patientId: p.id, status: { in: ['AGENDADO', 'CONFIRMADO'] }, startsAt: { gte: agora } },
        orderBy: { startsAt: 'asc' },
        include: { schedule: { select: { name: true, unitId: true } } },
      }),
      c.db.examRequest.count({ where: { patientId: p.id, status: 'RESULTADO', resultAt: { gte: new Date(agora.getTime() - 30 * DIA) } } }),
      c.db.vaccination.findMany({ where: { patientId: p.id }, select: { vaccineCode: true, vaccineName: true, appliedAt: true } }),
      c.db.regulationRequest.count({ where: { patientId: p.id, status: { in: ['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'AGENDADA'] } } }),
      c.db.bedRequest.count({ where: { patientId: p.id, status: { in: ['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'EM_TRANSFERENCIA'] } } }),
      c.db.tfdProcess.count({ where: { patientId: p.id, status: { in: ['ABERTO', 'ENVIADO', 'DEFERIDO', 'AGENDADO'] } } }),
      this.senha(c),
    ]);
    const doses: DoseAplicada[] = vacinas.map((v) => ({ componentes: componentesDaVacina(v.vaccineCode, v.vaccineName), at: v.appliedAt }));
    const atrasadas = proximasDoses(aprazar({ birthDate: p.birthDate, sex: p.sex, gestacaoDum: null }, doses, agora)).filter((s) => s.situacao === 'ATRASADA').length;
    const unidadeProximo = proximo ? (await this.nomesUnidades(c, [proximo.schedule.unitId])).get(proximo.schedule.unitId) : null;
    return {
      cidadao: {
        id: p.id,
        nome: p.socialName ?? p.name,
        primeiroNome: (p.socialName ?? p.name).split(' ')[0],
        nascimento: localDateString(p.birthDate, 'UTC'),
        idade: ageInYears(p.birthDate, agora),
        cns: p.cns,
        cpf: p.cpf ? `***.${p.cpf.slice(3, 6)}.${p.cpf.slice(6, 9)}-**` : null,
        telefone: mascararTelefone(p.phone),
        whatsapp: p.whatsappOptIn,
      },
      unidadeReferencia: unidade,
      proximoAgendamento: proximo
        ? { id: proximo.id, servico: proximo.schedule.name, quando: proximo.startsAt.toISOString(), unidade: unidadeProximo?.name ?? null, status: proximo.status, statusLabel: STATUS_AGENDAMENTO_CIDADAO[proximo.status] }
        : null,
      pendencias: { examesNovos, vacinasAtrasadas: atrasadas, solicitacoesEmAndamento: regAbertas + leitosAbertos + tfdAbertos },
      senhaHoje: senha,
    };
  }

  /** Agendamentos futuros e dos últimos 12 meses, com o que o cidadão pode fazer em cada um. */
  async agenda(c: CitizenContext) {
    const agora = new Date();
    const rows = await c.db.appointment.findMany({
      where: { patientId: c.patientId, startsAt: { gte: new Date(agora.getTime() - 365 * DIA) } },
      orderBy: { startsAt: 'desc' },
      include: { schedule: { select: { name: true, unitId: true, cbo: true } } },
      take: 100,
    });
    const p = await c.db.patient.findUniqueOrThrow({ where: { id: c.patientId }, select: { phone: true, whatsappOptIn: true } });
    const [unidades, profissionais] = await Promise.all([
      this.nomesUnidades(
        c,
        rows.map((r) => r.schedule.unitId),
      ),
      this.nomesUsuarios(
        c,
        rows.map((r) => r.professionalId),
      ),
    ]);
    const itens = rows.map((r) => {
      const u = unidades.get(r.schedule.unitId);
      return {
        id: r.id,
        servico: r.schedule.name,
        tipo: r.kind,
        quando: r.startsAt.toISOString(),
        fim: r.endsAt.toISOString(),
        unidade: u ? { id: u.id, nome: u.name, endereco: u.address, telefone: u.phone } : null,
        profissional: profissionais.get(r.professionalId) ?? null,
        status: r.status,
        statusLabel: STATUS_AGENDAMENTO_CIDADAO[r.status] ?? r.status,
        confirmadoEm: r.confirmedAt?.toISOString() ?? null,
        podeCancelar: podeCancelarAgendamento(r.status, r.startsAt, agora),
        podeConfirmar: podeConfirmarAgendamento(r.status, r.startsAt, agora),
        futuro: r.startsAt.getTime() > agora.getTime(),
      };
    });
    return {
      proximos: itens.filter((i) => i.futuro && (i.status === 'AGENDADO' || i.status === 'CONFIRMADO')).reverse(),
      historico: itens.filter((i) => !(i.futuro && (i.status === 'AGENDADO' || i.status === 'CONFIRMADO'))),
      lembretes: { whatsapp: p.whatsappOptIn && !!p.phone, telefone: mascararTelefone(p.phone), horasAntes: c.tenant.settings.appointmentReminderHours },
    };
  }

  private async agendamentoDoCidadao(c: CitizenContext, id: string) {
    const a = await c.db.appointment.findUnique({ where: { id } });
    if (!a || a.patientId !== c.patientId) throw notFound('Agendamento');
    return a;
  }

  async confirmarAgendamento(c: CitizenContext, id: string) {
    const a = await this.agendamentoDoCidadao(c, id);
    if (!podeConfirmarAgendamento(a.status, a.startsAt)) throw new DomainError('NAO_CONFIRMAVEL', 'Este agendamento não pode mais ser confirmado', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.scheduling.confirm({ tenant: c.tenant, db: c.db }, id, 'APP');
    return this.agenda(c);
  }

  async cancelarAgendamento(c: CitizenContext, id: string, motivo?: string | null) {
    const a = await this.agendamentoDoCidadao(c, id);
    if (!podeCancelarAgendamento(a.status, a.startsAt)) throw new DomainError('NAO_CANCELAVEL', 'Este agendamento não pode mais ser cancelado pelo app; procure a unidade', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.scheduling.cancel({ tenant: c.tenant, db: c.db }, id, `Cancelado pelo cidadão no app${motivo?.trim() ? `: ${motivo.trim()}` : ''}`);
    return this.agenda(c);
  }

  async preferencias(c: CitizenContext, input: { whatsappOptIn?: boolean | null }) {
    const data: { whatsappOptIn?: boolean } = {};
    if (input.whatsappOptIn != null) data.whatsappOptIn = input.whatsappOptIn;
    const p = await c.db.patient.update({ where: { id: c.patientId }, data, select: { phone: true, whatsappOptIn: true } });
    return { whatsapp: p.whatsappOptIn && !!p.phone, telefone: mascararTelefone(p.phone) };
  }

  /** Exames solicitados e resultados liberados. */
  async exames(c: CitizenContext) {
    const rows = await c.db.examRequest.findMany({ where: { patientId: c.patientId }, orderBy: { requestedAt: 'desc' }, take: 100, include: { encounter: { select: { unitId: true } } } });
    const [unidades, usuarios] = await Promise.all([
      this.nomesUnidades(
        c,
        rows.map((r) => r.encounter?.unitId),
      ),
      this.nomesUsuarios(
        c,
        rows.map((r) => r.requesterId),
      ),
    ]);
    return rows.map((r) => ({
      id: r.id,
      nome: r.name,
      status: r.status,
      statusLabel: STATUS_EXAME_CIDADAO[r.status] ?? r.status,
      solicitadoEm: r.requestedAt.toISOString(),
      solicitante: usuarios.get(r.requesterId) ?? null,
      unidade: r.encounter ? (unidades.get(r.encounter.unitId)?.name ?? null) : null,
      resultado:
        r.status === 'RESULTADO'
          ? {
              valor: r.resultValue != null ? Number(r.resultValue) : null,
              unidade: r.resultUnit,
              texto: r.resultText,
              em: r.resultAt?.toISOString() ?? null,
              novo: !!r.resultAt && r.resultAt.getTime() > Date.now() - 30 * DIA,
            }
          : null,
    }));
  }

  /** Cartão de vacinas: doses aplicadas e o que falta pelo calendário nacional. */
  async vacinas(c: CitizenContext) {
    const p = await this.paciente(c);
    const agora = new Date();
    const rows = await c.db.vaccination.findMany({ where: { patientId: p.id }, orderBy: { appliedAt: 'desc' } });
    const unidades = await this.nomesUnidades(
      c,
      rows.map((r) => r.unitId),
    );
    const doses: DoseAplicada[] = rows.map((r) => ({ componentes: componentesDaVacina(r.vaccineCode, r.vaccineName), at: r.appliedAt }));
    const aprazamento = aprazar({ birthDate: p.birthDate, sex: p.sex, gestacaoDum: null }, doses, agora);
    const proximas = proximasDoses(aprazamento);
    return {
      doses: rows.map((r) => ({
        id: r.id,
        vacina: r.vaccineName,
        dose: r.dose,
        lote: r.lot,
        fabricante: r.manufacturer,
        aplicadaEm: r.appliedAt.toISOString(),
        proximaEm: r.nextDueAt ? localDateString(r.nextDueAt, 'UTC') : null,
        unidade: unidades.get(r.unitId)?.name ?? null,
        transcrita: r.transcription,
      })),
      proximas: proximas.map((s) => ({
        vacina: s.componente,
        nome: s.rotulo,
        dose: DOSE_CIDADAO[s.doseCodigo] ?? `${s.dose}ª dose`,
        previstaPara: s.prevista,
        situacao: s.situacao,
      })),
      atrasadas: proximas.filter((s) => s.situacao === 'ATRASADA').length,
      certificadoDisponivel: rows.length > 0,
    };
  }

  /** Certificado de vacinação sem assinatura digital, emitido pelo próprio cidadão (unidade e profissional da última dose). */
  async certificado(c: CitizenContext): Promise<{ data: Buffer; fileName: string }> {
    const ultima = await c.db.vaccination.findFirst({ where: { patientId: c.patientId }, orderBy: { appliedAt: 'desc' } });
    if (!ultima) throw new DomainError('SEM_DOSES', 'Ainda não há doses registradas para emitir o certificado', HttpStatus.UNPROCESSABLE_ENTITY);
    const assignment = await c.db.userAssignment.findFirst({ where: { userId: ultima.professionalId, unitId: ultima.unitId }, select: { role: true, cbo: true } });
    const model = await certificadoVacinacaoModel(c.db, {
      patientId: c.patientId,
      unitId: ultima.unitId,
      userId: ultima.professionalId,
      role: assignment?.role ?? 'ENFERMAGEM',
      cbo: assignment?.cbo ?? '223505',
      signer: { name: 'App do cidadão', cpf: '' },
      issuedAt: new Date(),
      timeZone: c.tenant.timeZone,
    });
    model.footer.push('Emitido pelo cidadão no app, sem assinatura digital. A versão assinada pode ser pedida na unidade de saúde.');
    const data = await renderDocument(model, { reason: 'Certificado de vacinação', location: model.unit.name, contactInfo: c.tenant.name });
    return { data, fileName: `certificado-vacinacao-${c.patientId.slice(0, 8)}.pdf` };
  }

  /** Medicamentos prescritos em uso (receitas ativas), últimas retiradas e onde há estoque na rede. */
  async medicamentos(c: CitizenContext) {
    const hoje = new Date();
    const [receitas, retiradas] = await Promise.all([
      c.db.prescription.findMany({ where: { patientId: c.patientId, kind: 'AMBULATORIAL', status: 'ATIVA' }, orderBy: { signedAt: 'desc' }, take: 20, include: { items: { where: { suspendedAt: null } } } }),
      c.db.dispensation.findMany({ where: { patientId: c.patientId, dispensedAt: { gte: new Date(hoje.getTime() - 180 * DIA) } }, orderBy: { dispensedAt: 'desc' }, include: { items: true } }),
    ]);
    const prescritores = await this.nomesUsuarios(
      c,
      receitas.map((r) => r.prescriberId),
    );
    const productIds = [...new Set([...receitas.flatMap((r) => r.items.map((i) => i.productId)), ...retiradas.flatMap((d) => d.items.map((i) => i.productId))].filter((x): x is string => !!x))];
    const [produtos, saldos] = await Promise.all([
      productIds.length ? c.db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, description: true, unit: true } }) : [],
      productIds.length
        ? c.db.stockBalance.findMany({
            where: { quantity: { gt: 0 }, lot: { productId: { in: productIds }, expiry: { gte: hoje } } },
            include: { lot: { select: { productId: true } }, location: { select: { unitId: true, kind: true } } },
          })
        : [],
    ]);
    const unidades = await this.nomesUnidades(
      c,
      saldos.map((s) => s.location.unitId),
    );
    const produtoNome = new Map(produtos.map((p) => [p.id, p]));
    const disponibilidade = new Map<string, Map<string, number>>();
    for (const s of saldos) {
      if (s.location.kind !== 'FARMACIA_CENTRAL' && s.location.kind !== 'FARMACIA_SETORIAL') continue;
      const porUnidade = disponibilidade.get(s.lot.productId) ?? new Map<string, number>();
      porUnidade.set(s.location.unitId, (porUnidade.get(s.location.unitId) ?? 0) + Number(s.quantity));
      disponibilidade.set(s.lot.productId, porUnidade);
    }
    const ultimaRetirada = new Map<string, Date>();
    for (const d of retiradas) for (const i of d.items) if (!ultimaRetirada.has(i.productId)) ultimaRetirada.set(i.productId, d.dispensedAt);
    const itens = receitas.flatMap((r) =>
      r.items.map((i) => ({
        id: i.id,
        medicamento: i.productId ? (produtoNome.get(i.productId)?.description ?? i.description) : i.description,
        posologia: posologia({ dose: i.dose?.toString() ?? null, doseUnit: i.doseUnit, frequencyHours: i.frequencyHours, durationDays: i.durationDays, instructions: i.instructions }),
        usoContinuo: usoContinuo(i),
        prescritoEm: r.signedAt.toISOString(),
        prescritor: prescritores.get(r.prescriberId) ?? null,
        ultimaRetirada: i.productId ? (ultimaRetirada.get(i.productId)?.toISOString() ?? null) : null,
        disponivelEm: i.productId ? [...(disponibilidade.get(i.productId)?.entries() ?? [])].map(([unitId, quantidade]) => ({ unidade: unidades.get(unitId)?.name ?? 'Unidade', quantidade })) : [],
        cadastradoNaFarmacia: !!i.productId,
      })),
    );
    return {
      itens,
      retiradas: retiradas.slice(0, 20).map((d) => ({
        id: d.id,
        em: d.dispensedAt.toISOString(),
        unidade: unidades.get(d.unitId)?.name ?? null,
        itens: d.items.map((i) => ({ medicamento: produtoNome.get(i.productId)?.description ?? '—', quantidade: Number(i.quantity), unidade: produtoNome.get(i.productId)?.unit ?? '' })),
      })),
    };
  }

  /** Situação na regulação (posição na fila), vagas de leito e TFD. */
  async regulacao(c: CitizenContext) {
    const [regs, leitos, tfds] = await Promise.all([
      c.db.regulationRequest.findMany({ where: { patientId: c.patientId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      c.db.bedRequest.findMany({ where: { patientId: c.patientId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      c.db.tfdProcess.findMany({ where: { patientId: c.patientId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    const unidades = await this.nomesUnidades(c, [...regs.map((r) => r.providerUnitId), ...regs.map((r) => r.unitId), ...leitos.map((l) => l.destinationUnitId), ...leitos.map((l) => l.originUnitId)]);
    const solicitacoes = [];
    for (const r of regs) {
      let posicao: number | null = null;
      if (STATUS_NA_FILA.includes(r.status)) {
        const frente = await c.db.regulationRequest.count({
          where: {
            kind: r.kind,
            specialty: r.specialty,
            status: { in: STATUS_NA_FILA },
            OR: [
              { priority: { in: (Object.keys(PRIORIDADES) as (keyof typeof PRIORIDADES)[]).filter((p) => PRIORIDADES[p].ordem < PRIORIDADES[r.priority].ordem) } },
              { priority: r.priority, createdAt: { lt: r.createdAt } },
            ],
          },
        });
        posicao = frente + 1;
      }
      solicitacoes.push({
        id: r.id,
        protocolo: r.protocol,
        procedimento: r.procedureName,
        prioridade: PRIORIDADES[r.priority].label,
        status: r.status,
        statusLabel: STATUS_SOLICITACAO[r.status],
        posicaoNaFila: posicao,
        unidadeSolicitante: unidades.get(r.unitId)?.name ?? null,
        unidadeExecutante: r.providerUnitId ? (unidades.get(r.providerUnitId)?.name ?? null) : null,
        agendadoPara: r.scheduledAt?.toISOString() ?? null,
        devolutiva: r.status === 'DEVOLVIDA' || r.status === 'NEGADA' ? r.decisionReason : null,
        em: r.createdAt.toISOString(),
      });
    }
    const viagens = new Map(
      (tfds.some((t) => t.tripId)
        ? await c.db.transportTrip.findMany({
            where: { id: { in: tfds.map((t) => t.tripId).filter((x): x is string => !!x) } },
            include: { vehicle: { select: { plate: true, model: true } }, driver: { select: { name: true, phone: true } } },
          })
        : []
      ).map((v) => [v.id, v]),
    );
    return {
      solicitacoes,
      leitos: leitos.map((l) => ({
        id: l.id,
        protocolo: l.protocol,
        tipo: TIPO_LEITO[l.bedKind as TipoLeito],
        especialidade: l.specialty,
        prioridade: PRIORIDADE_LEITO[l.priority].label,
        status: l.status,
        statusLabel: STATUS_SOLICITACAO_LEITO[l.status],
        origem: unidades.get(l.originUnitId)?.name ?? null,
        destino: l.destinationUnitId ? (unidades.get(l.destinationUnitId)?.name ?? null) : null,
        em: l.createdAt.toISOString(),
      })),
      tfd: tfds.map((t) => {
        const v = t.tripId ? viagens.get(t.tripId) : undefined;
        return {
          id: t.id,
          protocolo: t.protocol,
          procedimento: t.procedureName,
          destino: `${t.destinationCity}/${t.destinationUf}${t.destinationUnit ? ` · ${t.destinationUnit}` : ''}`,
          status: t.status,
          statusLabel: STATUS_TFD[t.status],
          transporte: TRANSPORTE_TFD[t.transport as TransporteTfd] ?? t.transport,
          atendimento: t.appointmentAt ? { em: t.appointmentAt.toISOString(), local: t.appointmentPlace } : null,
          ajudaCusto: Number(t.allowanceTotal) > 0 ? { total: Number(t.allowanceTotal), paga: !!t.allowancePaidAt } : null,
          viagem: v ? { data: localDateString(v.date, 'UTC'), saida: v.departureTime, veiculo: `${v.vehicle.model} (${v.vehicle.plate})`, motorista: v.driver.name, telefoneMotorista: v.driver.phone } : null,
          em: t.createdAt.toISOString(),
        };
      }),
    };
  }

  /** Senha do dia (fila de atendimento) e posição. */
  async senha(c: CitizenContext) {
    const day = localDateString(new Date(), c.tenant.timeZone);
    const t = await c.db.ticket.findFirst({
      where: { patientId: c.patientId, day, status: { in: ['AGUARDANDO', 'CHAMADA', 'EM_ATENDIMENTO'] } },
      orderBy: { createdAt: 'desc' },
      include: { unit: { select: { name: true } } },
    });
    if (!t) return null;
    const frente = t.status === 'AGUARDANDO' ? await c.db.ticket.count({ where: { unitId: t.unitId, day, sector: t.sector, status: 'AGUARDANDO', createdAt: { lt: t.createdAt } } }) : 0;
    return {
      id: t.id,
      senha: t.code,
      tipo: t.kind,
      setor: t.sector,
      unidade: t.unit.name,
      status: t.status,
      statusLabel: STATUS_SENHA_CIDADAO[t.status] ?? t.status,
      guiche: t.desk,
      posicao: t.status === 'AGUARDANDO' ? frente + 1 : null,
      chamadaEm: t.calledAt?.toISOString() ?? null,
    };
  }

  /** Unidades de saúde da rede com endereço, telefone e horários. */
  async unidades(c: CitizenContext) {
    const rows = await c.db.unit.findMany({
      where: { active: true, type: { in: [...TIPOS_ABERTOS_AO_PUBLICO] } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, type: true, address: true, phone: true, openingHours: true, latitude: true, longitude: true },
    });
    return rows.map((u) => ({ ...u, tipoLabel: UNIT_TYPE_LABELS[u.type] ?? u.type }));
  }
}
