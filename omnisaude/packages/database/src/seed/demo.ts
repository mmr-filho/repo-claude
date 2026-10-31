import { completeCpf, cnsFromBase, competencia, gs1HumanReadable, localDateString, personNameKey } from '@omnisaude/shared';
import type { PrismaClient as MasterClient } from '../generated/master/client';
import type { PrismaClient as TenantClient } from '../generated/tenant/client';
import { appendAudit } from '../audit';
import { hashPassword } from '../passwords';
import { provisionTenant } from '../provision';
import { connectionUrl, type CredentialsResolver } from '../tenancy';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/tenant/client';
import { DEMO_PASSWORD, DEMO_TENANT, PATIENTS, POPS, PRODUCTS, SIGTAP_SAMPLE, STAFF, UNITS, VACCINES, type UnitKey } from './fixtures';

export interface SeedOptions {
  master: MasterClient;
  credentials: CredentialsResolver;
  primaryHost: string;
  primaryPort: number;
  replicaHost?: string;
  replicaPort?: number;
  /** Habilita as integrações de demonstração (apontando para os mocks). */
  settings?: Record<string, unknown>;
  now?: Date;
  /** Slug do tenant (padrão "demo"); os testes usam outro para não tocar no banco de desenvolvimento. */
  slug?: string;
  /** false quando a conta da plataforma tem senha própria (PLATFORM_ADMIN_PASSWORD) em vez da senha pública. */
  platformUser?: boolean;
}

const DAY = 86_400_000;
export const DEMO_PLATFORM_EMAIL = 'plataforma@omnisaude.dev';

/**
 * Popula o master com um operador da plataforma e cria o tenant "demo" com uma rede completa:
 * unidades, equipe por papel, pacientes crônicos, agenda, estoque, leitos, SIGTAP, POPs e histórico.
 * Só roda em banco de tenant vazio.
 */
export async function seedDemo(opts: SeedOptions) {
  const now = opts.now ?? new Date();
  const daysAgo = (n: number, hour = 9) => {
    const d = new Date(now.getTime() - n * DAY);
    d.setUTCHours(hour + 3, 0, 0, 0); // horário de Brasília (UTC-3)
    return d;
  };
  const daysAhead = (n: number, hour = 9) => daysAgo(-n, hour);

  if (opts.platformUser !== false) {
    await opts.master.platformUser.upsert({
      where: { email: DEMO_PLATFORM_EMAIL },
      update: {},
      create: { email: DEMO_PLATFORM_EMAIL, name: 'Operação da Plataforma', passwordHash: await hashPassword(DEMO_PASSWORD) },
    });
  }

  const { tenantId, dbName } = await provisionTenant(opts.master, opts.credentials, {
    ...DEMO_TENANT,
    slug: opts.slug ?? DEMO_TENANT.slug,
    cnpj: opts.slug && opts.slug !== DEMO_TENANT.slug ? `${DEMO_TENANT.cnpj.slice(0, 8)}${String(opts.slug.length).padStart(4, '0')}91` : DEMO_TENANT.cnpj,
    primaryHost: opts.primaryHost,
    primaryPort: opts.primaryPort,
    replicaHost: opts.replicaHost,
    replicaPort: opts.replicaPort,
    settings: { aiEnabled: true, whatsappEnabled: true, rndsEnabled: true, ...opts.settings },
  });

  await opts.master.license.deleteMany({ where: { tenantId } });
  await opts.master.license.create({
    data: {
      tenantId,
      plan: 'demonstracao',
      modules: ['aps', 'urgencia', 'hospitalar', 'farmacia', 'faturamento', 'ia', 'whatsapp', 'libras', 'rnds'],
      seats: 200,
      validFrom: new Date('2026-01-01'),
    },
  });

  const cred = opts.credentials('default', 'oltp');
  const db: TenantClient = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionUrl(opts.primaryHost, opts.primaryPort, dbName, cred) }),
  });

  try {
    if ((await db.unit.count()) > 0) return { tenantId, dbName, skipped: true };

    // ── Unidades e equipe ──
    const unit = {} as Record<UnitKey, string>;
    for (const u of UNITS) {
      const row = await db.unit.create({ data: { cnes: u.cnes, name: u.name, type: u.type, ibgeCode: DEMO_TENANT.ibgeCode } });
      unit[u.key] = row.id;
    }
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const staff = {} as Record<string, string>;
    for (const s of STAFF) {
      const row = await db.user.create({
        data: {
          cpf: s.cpf,
          cns: s.cns,
          name: s.name,
          email: `${s.key}@demo.omnisaude.dev`,
          passwordHash,
          assignments: {
            create: s.assignments.map((a) => ({ unitId: unit[a.unit], role: a.role, cbo: a.cbo, council: s.council ?? null })),
          },
        },
      });
      staff[s.key] = row.id;
    }

    // ── Pacientes ──
    const patient = {} as Record<string, string>;
    for (const p of PATIENTS) {
      const row = await db.patient.create({
        data: {
          cpf: completeCpf(p.cpfBase),
          cns: cnsFromBase(p.cnsBase),
          name: p.name,
          nameKey: personNameKey(p.name),
          motherName: p.motherName,
          birthDate: new Date(p.birthDate),
          sex: p.sex,
          racaCor: '03',
          phone: p.phone ?? null,
          whatsappOptIn: p.whatsapp ?? false,
          bolsaFamilia: p.key === 'luana' || p.key === 'fernanda',
          district: p.district,
          ibgeCode: DEMO_TENANT.ibgeCode,
          cep: '01001000',
          street: 'Rua Exemplo',
          number: String(100 + PATIENTS.indexOf(p)),
          conditions: {
            create: (p.conditions ?? []).map((c) => ({
              system: c.system,
              code: c.code,
              description: c.description,
              lineOfCare: c.line ?? null,
              onsetAt: new Date('2018-01-01'),
            })),
          },
          allergies: { create: (p.allergies ?? []).map((substance) => ({ substance, reaction: 'Urticária', severity: 'MODERADA' })) },
        },
      });
      patient[p.key] = row.id;
    }

    // ── Equipes (INE) e domicílios vinculados: base dos indicadores do cofinanciamento da APS ──
    const esf = await db.team.create({
      data: {
        ine: '0000000101',
        name: 'ESF Centro I',
        typeCode: '70',
        unitId: unit.ubs,
        area: '01',
        modality: 'ESF_40H',
        members: {
          create: [
            { userId: staff.enfermeiro!, cbo: '223505', microArea: '01' },
            { userId: staff.medica!, cbo: '225125' },
          ],
        },
      },
    });
    await db.team.create({ data: { ine: '0000000102', name: 'Saúde Bucal Centro', typeCode: '71', unitId: unit.ubs, modality: 'ESB_I', members: { create: [{ userId: staff.dentista!, cbo: '223208' }] } } });
    await db.team.create({ data: { ine: '0000000103', name: 'eMulti Centro', typeCode: '72', unitId: unit.ubs, modality: 'EMULTI_ESTRATEGICA', members: { create: [{ userId: staff.social!, cbo: '251605' }] } } });
    for (const p of PATIENTS) {
      const household = await db.household.create({
        data: {
          cep: '01001000',
          street: 'Rua Exemplo',
          number: String(100 + PATIENTS.indexOf(p)),
          district: p.district,
          ibgeCode: DEMO_TENANT.ibgeCode,
          dwellingType: '01',
          tenure: '01',
          waterSupply: '01',
          sewage: '01',
          garbage: '01',
          electricity: true,
          rooms: 4,
          microArea: '01',
          unitId: unit.ubs,
          teamId: esf.id,
          families: { create: { responsibleId: patient[p.key]!, incomeBracket: '02' } },
        },
        include: { families: true },
      });
      await db.patient.update({ where: { id: patient[p.key]! }, data: { familyId: household.families[0]!.id, kinship: '00' } });
    }

    // ── Estoque ──
    const location = {
      alm: (await db.stockLocation.create({ data: { unitId: unit.alm, name: 'Almoxarifado Central', kind: 'ALMOXARIFADO_CENTRAL' } })).id,
      fc: (await db.stockLocation.create({ data: { unitId: unit.fc, name: 'Farmácia Central', kind: 'FARMACIA_CENTRAL' } })).id,
      ubs: (await db.stockLocation.create({ data: { unitId: unit.ubs, name: 'Farmácia da UBS Centro', kind: 'FARMACIA_SETORIAL' } })).id,
      upa: (await db.stockLocation.create({ data: { unitId: unit.upa, name: 'Farmácia da UPA', kind: 'FARMACIA_SETORIAL' } })).id,
      hosp: (await db.stockLocation.create({ data: { unitId: unit.hosp, name: 'Farmácia Hospitalar', kind: 'FARMACIA_SETORIAL' } })).id,
      posto: (await db.stockLocation.create({ data: { unitId: unit.hosp, name: 'Posto de Enfermagem - Clínica Médica', kind: 'POSTO_ENFERMAGEM' } })).id,
    };
    const product = {} as Record<string, string>;
    const lot = {} as Record<string, string>;
    for (const [i, p] of PRODUCTS.entries()) {
      const row = await db.product.create({
        data: {
          code: p.code,
          description: p.description,
          activeIngredient: p.activeIngredient,
          unit: p.unit,
          gtin: p.gtin,
          controlledList: 'controlledList' in p ? p.controlledList : null,
          highAlert: 'highAlert' in p ? p.highAlert : false,
          antimicrobialRestricted: 'antimicrobialRestricted' in p ? p.antimicrobialRestricted : false,
          mappings: { create: { supplierCnpj: '11111111000191', supplierCode: `FORN-${p.code}`, gtin: p.gtin, conversionFactor: 1 } },
        },
      });
      product[p.code] = row.id;
      const l = await db.stockLot.create({
        data: {
          productId: row.id,
          lotNumber: `L26${String(i + 1).padStart(3, '0')}`,
          expiry: new Date(`2027-${String((i % 12) + 1).padStart(2, '0')}-28`),
          manufacturer: 'Laboratório Exemplo S.A.',
        },
      });
      lot[p.code] = l.id;
      for (const [loc, qty] of [
        [location.alm, 5000],
        [location.fc, 1200],
        [location.ubs, 300],
        [location.upa, 200],
        [location.hosp, 400],
      ] as const) {
        await db.stockBalance.create({ data: { locationId: loc, lotId: l.id, quantity: qty } });
        await db.stockMovement.create({
          data: { kind: 'AJUSTE', locationId: loc, lotId: l.id, quantity: qty, refType: 'CARGA_INICIAL', userId: staff.farmaceutica! },
        });
      }
    }

    // ── Sala de vacina da UBS Centro: produtos (imunobiológicos), lotes e saldos ──
    const salaVacina = (await db.stockLocation.create({ data: { unitId: unit.ubs, name: 'Sala de Vacina - UBS Centro', kind: 'SALA_DE_VACINA' } })).id;
    for (const [i, v] of VACCINES.entries()) {
      const row = await db.product.create({ data: { code: v.code, description: v.description, unit: v.unit, vaccineCode: v.vaccineCode, pharmaceuticalForm: 'Suspensão injetável' } });
      const l = await db.stockLot.create({ data: { productId: row.id, lotNumber: `V26${String(i + 1).padStart(3, '0')}`, expiry: new Date(now.getTime() + (180 + i * 15) * DAY), manufacturer: v.manufacturer } });
      await db.stockBalance.create({ data: { locationId: salaVacina, lotId: l.id, quantity: 50 } });
      await db.stockMovement.create({ data: { kind: 'AJUSTE', locationId: salaVacina, lotId: l.id, quantity: 50, refType: 'CARGA_INICIAL', userId: staff.enfermeiro! } });
    }

    // ── Leitos ──
    const wards = [
      { unit: unit.hosp, name: 'Clínica Médica', kind: 'CLINICA_MEDICA', prefix: 'CM', beds: 10 },
      { unit: unit.hosp, name: 'Clínica Cirúrgica', kind: 'CIRURGICA', prefix: 'CC', beds: 6 },
      { unit: unit.hosp, name: 'UTI Adulto', kind: 'UTI_ADULTO', prefix: 'UTI', beds: 5 },
      { unit: unit.hosp, name: 'Pediatria', kind: 'PEDIATRIA', prefix: 'PED', beds: 4 },
      { unit: unit.upa, name: 'Observação UPA', kind: 'OBSERVACAO', prefix: 'OBS', beds: 6 },
    ] as const;
    const bedIds: Record<string, string> = {};
    for (const w of wards) {
      const ward = await db.ward.create({ data: { unitId: w.unit, name: w.name, kind: w.kind } });
      for (let i = 1; i <= w.beds; i++) {
        const code = `${w.prefix}-${String(i).padStart(2, '0')}`;
        const status = code === 'CM-05' || code === 'UTI-02' ? 'HIGIENIZACAO' : code === 'CC-06' ? 'BLOQUEADO' : 'VAGO';
        const isolation = code === 'CM-08' ? 'CONTATO' : 'NENHUM';
        bedIds[code] = (await db.bed.create({ data: { wardId: ward.id, code, status, isolation } })).id;
      }
    }

    // ── SIGTAP (amostra) e POPs ──
    const comp = competencia(now);
    for (const s of SIGTAP_SAMPLE) {
      await db.sigtapProcedure.create({
        data: {
          code: s.code,
          name: s.name,
          sex: s.sex,
          minAgeMonths: s.minAgeMonths,
          maxAgeMonths: s.maxAgeMonths,
          maxQuantity: s.maxQuantity,
          valueSa: s.valueSa,
          instruments: [...s.instruments],
          competencia: comp,
        },
      });
      await db.sigtapProcedureCbo.createMany({ data: s.cbos.map((cbo) => ({ procedureCode: s.code, cbo })) });
      if (s.cids.length) await db.sigtapProcedureCid.createMany({ data: s.cids.map((cid) => ({ procedureCode: s.code, cid })) });
    }
    await db.sigtapSync.create({ data: { competencia: comp, source: 'AMOSTRA_DEMONSTRACAO', status: 'CONCLUIDA', procedures: SIGTAP_SAMPLE.length, finishedAt: now } });
    for (const p of POPS) {
      await db.pop.create({
        data: { code: p.code, title: p.title, kind: p.kind, trigger: p.trigger, content: p.content, checklist: p.checklist as unknown as object, requiresDoubleCheck: p.requiresDoubleCheck },
      });
    }

    // ── Histórico clínico ──
    const medica = staff.medica!;
    const pastVisit = async (key: string, when: Date, unitId: string, cid: string, soap: { s: string; o: string; a: string; p: string }) => {
      const enc = await db.encounter.create({
        data: {
          unitId,
          patientId: patient[key]!,
          kind: 'AMBULATORIAL',
          status: 'ENCERRADO',
          responsibleId: medica,
          mainCid: cid,
          outcome: 'ALTA',
          startedAt: when,
          endedAt: new Date(when.getTime() + 25 * 60_000),
          createdBy: staff.recepcao!,
        },
      });
      await db.$transaction(async (tx) => {
        const note = await tx.clinicalNote.create({
          data: {
            encounterId: enc.id,
            authorId: medica,
            role: 'MEDICO',
            cbo: '225125',
            kind: 'SOAP',
            subjective: soap.s,
            objective: soap.o,
            assessment: soap.a,
            plan: soap.p,
            codes: [cid],
          },
        });
        const { hash } = await appendAudit(tx, {
          userId: medica,
          unitId,
          role: 'MEDICO',
          ip: '10.0.0.10',
          mfa: true,
          action: 'prontuario.assinar',
          entityType: 'ClinicalNote',
          entityId: note.id,
          payload: { encounterId: enc.id, soap },
        });
        await tx.clinicalNote.update({ where: { id: note.id }, data: { status: 'ASSINADO', signedAt: when, auditHash: hash } });
      });
      return enc.id;
    };

    const hasSoap = {
      s: 'Retorno de hipertensão. Nega cefaleia ou dor torácica. Refere boa adesão à medicação.',
      o: 'PA 138 x 88 mmHg, FC 76 bpm. Ausculta cardíaca e pulmonar sem alterações.',
      a: 'Hipertensão arterial sistêmica controlada.',
      p: 'Manter hidroclorotiazida 25 mg 1x ao dia. Retorno em 3 meses com exames.',
    };
    await pastVisit('maria', new Date('2026-01-20T12:00:00Z'), unit.ubs, 'I10', hasSoap);
    await pastVisit('jose', new Date('2025-12-10T13:00:00Z'), unit.ubs, 'I10', hasSoap);
    await pastVisit('antonia', daysAgo(75), unit.ubs, 'I10', hasSoap);
    await pastVisit('francisco', new Date('2026-01-08T12:30:00Z'), unit.ubs2, 'I10', hasSoap);
    await pastVisit('fernanda', daysAgo(260), unit.ubs, 'E11', {
      s: 'Acompanhamento de diabetes e hipertensão.',
      o: 'PA 150 x 95 mmHg. Glicemia capilar 210 mg/dL.',
      a: 'DM2 e HAS descompensados.',
      p: 'Ajuste de metformina; solicitar HbA1c. Retorno em 30 dias.',
    });
    await pastVisit('sebastiao', daysAgo(150), unit.poli, 'C61', {
      s: 'Seguimento oncológico.',
      o: 'Bom estado geral.',
      a: 'Neoplasia de próstata em seguimento.',
      p: 'Retorno em 60 dias com PSA.',
    });
    await pastVisit('luana', daysAgo(45), unit.ubs, 'Z34', {
      s: 'Pré-natal, 20 semanas. Sem queixas.',
      o: 'PA 110 x 70 mmHg. Altura uterina compatível. BCF 140 bpm.',
      a: 'Gestação de baixo risco.',
      p: 'Retorno em 30 dias. Sulfato ferroso e ácido fólico.',
    });

    // Dispensações de hidroclorotiazida na Farmácia Central (casam com o exemplo de BI da especificação).
    for (const [key, date] of [
      ['maria', '2026-02-10T13:00:00Z'],
      ['jose', '2026-03-05T14:00:00Z'],
      ['antonia', '2026-02-18T15:00:00Z'],
      ['francisco', '2026-01-22T13:30:00Z'],
      ['maria', '2026-03-12T13:00:00Z'],
    ] as const) {
      await db.dispensation.create({
        data: {
          unitId: unit.fc,
          locationId: location.fc,
          patientId: patient[key]!,
          dispensedBy: staff.farmaceutica!,
          dispensedAt: new Date(date),
          items: { create: { productId: product.MED004!, lotId: lot.MED004!, quantity: 30 } },
        },
      });
    }

    // Exames: creatinina alterada da Raimunda (copiloto: metformina x função renal).
    await db.examRequest.create({
      data: {
        patientId: patient.raimunda!,
        requesterId: medica,
        sigtapCode: '0202010317',
        name: 'Dosagem de creatinina',
        analyte: 'CREATININA',
        status: 'RESULTADO',
        resultValue: 2.1,
        resultUnit: 'mg/dL',
        requestedAt: daysAgo(20),
        resultAt: daysAgo(15),
      },
    });

    // Prescrição em uso do Carlos (varfarina): o copiloto alerta ao prescrever AAS ou AINE.
    const carlosVisit = await pastVisit('carlos', daysAgo(30), unit.ubs, 'I48', {
      s: 'Fibrilação atrial em anticoagulação.',
      o: 'FC 82 bpm irregular. PA 130 x 80 mmHg.',
      a: 'FA permanente anticoagulada.',
      p: 'Manter varfarina 5 mg/dia; controle de INR.',
    });
    await db.prescription.create({
      data: {
        encounterId: carlosVisit,
        patientId: patient.carlos!,
        prescriberId: medica,
        kind: 'AMBULATORIAL',
        signedAt: daysAgo(30),
        items: { create: { productId: product.MED011!, description: 'Varfarina sódica 5 mg', activeIngredient: 'varfarina', dose: 5, doseUnit: 'mg', route: 'ORAL', frequencyHours: 24, durationDays: 90 } },
      },
    });

    // ── Agenda ──
    const schedule = await db.schedule.create({
      data: {
        unitId: unit.ubs,
        professionalId: medica,
        name: 'Clínica médica - Dra. Carla',
        cbo: '225125',
        slotMinutes: 20,
        rules: {
          create: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '07:00', endTime: '11:00', firstVisitQuota: 6, returnQuota: 6 })),
        },
      },
    });
    for (const [key, when, status] of [
      ['juliana', daysAhead(2, 8), 'AGENDADO'],
      ['maria', daysAhead(3, 9), 'AGENDADO'],
      ['jose', daysAhead(1, 7), 'CONFIRMADO'],
      ['fernanda', daysAgo(10, 8), 'FALTOU'],
    ] as const) {
      await db.appointment.create({
        data: {
          scheduleId: schedule.id,
          unitId: unit.ubs,
          patientId: patient[key]!,
          professionalId: medica,
          startsAt: when,
          endsAt: new Date(when.getTime() + 20 * 60_000),
          kind: key === 'juliana' ? 'PRIMEIRA_CONSULTA' : 'RETORNO',
          status,
          createdBy: staff.recepcao!,
        },
      });
    }

    // ── UPA hoje: fila classificada ──
    const today = localDateString(now);
    const upaArrival = async (key: string, seq: number, minutesAgo: number, triage?: Record<string, unknown>) => {
      const startedAt = new Date(now.getTime() - minutesAgo * 60_000);
      const ticket = await db.ticket.create({
        data: { unitId: unit.upa, day: today, sequence: seq, code: `N${String(seq).padStart(3, '0')}`, kind: 'NORMAL', patientId: patient[key]!, status: 'FINALIZADA', createdAt: startedAt },
      });
      const enc = await db.encounter.create({
        data: {
          unitId: unit.upa,
          patientId: patient[key]!,
          kind: 'URGENCIA',
          status: triage ? 'TRIADO' : 'ABERTO',
          ticketId: ticket.id,
          startedAt,
          createdBy: staff.recepcao!,
        },
      });
      await db.ticket.update({ where: { id: ticket.id }, data: { encounterId: enc.id } });
      if (triage) {
        await db.triage.create({
          data: {
            encounterId: enc.id,
            nurseId: staff.enfermeiro!,
            classifiedAt: new Date(startedAt.getTime() + 5 * 60_000),
            ...(triage as object),
          } as never,
        });
      }
    };
    await upaArrival('raimunda', 1, 50, {
      complaint: 'Tontura e mal-estar desde ontem',
      systolic: 150,
      diastolic: 90,
      heartRate: 96,
      spo2: 96,
      temperature: 36.8,
      glucose: 320,
      painScore: 2,
      suggestedColor: 'AMARELO',
      riskColor: 'AMARELO',
      painMap: [{ view: 'FRENTE', region: 'cabeca', x: 0.5, y: 0.08, intensity: 2 }],
      flags: [],
    });
    await upaArrival('carlos', 2, 30, {
      complaint: 'Dor no peito em aperto há 1 hora',
      systolic: 165,
      diastolic: 100,
      heartRate: 112,
      spo2: 95,
      temperature: 36.5,
      painScore: 7,
      suggestedColor: 'LARANJA',
      riskColor: 'LARANJA',
      painMap: [{ view: 'FRENTE', region: 'torax', x: 0.5, y: 0.3, intensity: 7 }],
      flags: ['dor_toracica'],
    });
    await upaArrival('thiago', 3, 10);

    // ── Internação: Francisco na Clínica Médica, com prescrição hospitalar e doses unitárias no posto ──
    const admEnc = await db.encounter.create({
      data: { unitId: unit.hosp, patientId: patient.francisco!, kind: 'INTERNACAO', status: 'EM_ATENDIMENTO', responsibleId: medica, mainCid: 'J18', startedAt: daysAgo(2), createdBy: staff.nir! },
    });
    await db.admission.create({ data: { encounterId: admEnc.id, patientId: patient.francisco!, bedId: bedIds['CM-03']!, mainCid: 'J18', admittedAt: daysAgo(2) } });
    await db.bed.update({ where: { id: bedIds['CM-03']! }, data: { status: 'OCUPADO' } });

    const hospRx = await db.prescription.create({
      data: {
        encounterId: admEnc.id,
        patientId: patient.francisco!,
        prescriberId: medica,
        kind: 'HOSPITALAR',
        signedAt: daysAgo(2),
        items: {
          create: [
            { productId: product.MED013!, description: 'Ceftriaxona 1 g IV', activeIngredient: 'ceftriaxona', dose: 1, doseUnit: 'g', route: 'IV', frequencyHours: 12, durationDays: 7 },
            { productId: product.MED017!, description: 'Heparina 5.000 UI SC', activeIngredient: 'heparina', dose: 5000, doseUnit: 'UI', route: 'SC', frequencyHours: 12, durationDays: 7 },
            { productId: product.MED019!, description: 'Dipirona 1 g IV se dor ou febre', activeIngredient: 'dipirona', dose: 1, doseUnit: 'g', route: 'IV', frequencyHours: 6, durationDays: 7 },
          ],
        },
      },
      include: { items: true },
    });
    let serial = 1;
    for (const item of hospRx.items) {
      const prod = PRODUCTS.find((p) => product[p.code] === item.productId)!;
      const lotRow = await db.stockLot.findUniqueOrThrow({ where: { id: lot[prod.code]! } });
      for (let i = 0; i < 4; i++) {
        const s = `DEMO${String(serial++).padStart(6, '0')}`;
        const expiry = lotRow.expiry.toISOString().slice(0, 10);
        await db.unitDose.create({
          data: {
            serial: s,
            productId: item.productId!,
            lotId: lotRow.id,
            gtin: prod.gtin,
            expiry: lotRow.expiry,
            locationId: location.posto,
            gs1: gs1HumanReadable({ gtin: prod.gtin, expiry, lot: lotRow.lotNumber, serial: s }),
            createdBy: staff.farmaceutica!,
          },
        });
      }
      await db.stockBalance.upsert({
        where: { locationId_lotId: { locationId: location.posto, lotId: lotRow.id } },
        update: { quantity: { increment: 4 } },
        create: { locationId: location.posto, lotId: lotRow.id, quantity: 4 },
      });
    }

    // ── Produção para faturamento (inclui inconsistências para a crítica pré-glosa) ──
    const prod = (data: { procedureCode: string; cbo: string; cid?: string; patientKey: string; professional: string; unitId: string; instrument: 'BPA_I' | 'BPA_C' }) =>
      db.productionRecord.create({
        data: {
          unitId: data.unitId,
          competencia: comp,
          patientId: patient[data.patientKey]!,
          professionalId: data.professional,
          cbo: data.cbo,
          procedureCode: data.procedureCode,
          cid: data.cid ?? null,
          performedAt: daysAgo(1),
          instrument: data.instrument,
        },
      });
    await prod({ procedureCode: '0301060061', cbo: '225125', cid: 'I10', patientKey: 'carlos', professional: medica, unitId: unit.upa, instrument: 'BPA_I' });
    await prod({ procedureCode: '0301060061', cbo: '225125', cid: 'R51', patientKey: 'raimunda', professional: medica, unitId: unit.upa, instrument: 'BPA_I' });
    await prod({ procedureCode: '0301060118', cbo: '223505', patientKey: 'raimunda', professional: staff.enfermeiro!, unitId: unit.upa, instrument: 'BPA_C' });
    // CBO incompatível: recepcionista lançando atendimento de urgência.
    await prod({ procedureCode: '0301060061', cbo: '422105', cid: 'R50', patientKey: 'thiago', professional: staff.recepcao!, unitId: unit.upa, instrument: 'BPA_I' });
    // CID incompatível com o procedimento.
    await prod({ procedureCode: '0301060061', cbo: '225125', cid: 'S82', patientKey: 'pedro', professional: medica, unitId: unit.upa, instrument: 'BPA_I' });
    // Sexo incompatível (coleta de citopatológico em paciente masculino).
    await prod({ procedureCode: '0201020033', cbo: '223505', patientKey: 'jose', professional: staff.enfermeiro!, unitId: unit.ubs, instrument: 'BPA_C' });

    // ── Busca ativa em andamento ──
    const sCase = await db.activeSearchCase.create({
      data: { patientId: patient.fernanda!, lineOfCare: 'DIABETES', status: 'EM_CONTATO', assignedTo: staff.social!, lastVisitAt: daysAgo(260), openedAt: daysAgo(5) },
    });
    await db.activeSearchContact.create({
      data: {
        caseId: sCase.id,
        channel: 'TELEFONE',
        outcome: 'Contato realizado',
        vulnerabilities: ['TRANSPORTE'],
        actions: [],
        notes: 'Paciente relata dificuldade de transporte até a UBS.',
        userId: staff.social!,
        at: daysAgo(4),
      },
    });

    return { tenantId, dbName, skipped: false };
  } finally {
    await db.$disconnect();
  }
}
