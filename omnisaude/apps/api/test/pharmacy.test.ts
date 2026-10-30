import { demoFixtures, hashPassword, type TenantClient } from '@omnisaude/database';
import { completeCpf, gs1ElementString, parseGs1 } from '@omnisaude/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { PharmacyClock } from '../src/modules/pharmacy/clock';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();
const FIXTURES = join(__dirname, '../../../infra/mocks/fixtures');
const NFE_GO = readFileSync(join(FIXTURES, 'nfe-distribuidora-goias-1523.xml'), 'utf8');
const NFE_SP = readFileSync(join(FIXTURES, 'nfe-farmaco-sp-88017.xml'), 'utf8');
const DEST_CNPJ = '04512345000185';
const EXTRA_PHARMACIST_CPF = completeCpf('100000077');

describe.runIf(enabled)('farmácia e cadeia de medicamentos', () => {
  let t: TestApp;
  let db: TenantClient;
  let tok: Record<string, string>;
  const auth = (k: string) => ({ authorization: `Bearer ${tok[k]}` });

  async function loginCpf(cpf: string, unitName: string, role: string) {
    const res = await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf, password: demoFixtures.DEMO_PASSWORD }).expect(200);
    const a = res.body.assignments.find((x: { unitName: string; role: string }) => x.unitName === unitName && x.role === role);
    const ctx = await t.http().post('/api/auth/context').set('authorization', `Bearer ${res.body.token}`).send({ unitId: a.unitId, role }).expect(200);
    return ctx.body.token as string;
  }
  const location = async (k: string, name: string) => {
    const res = await t.http().get('/api/pharmacy/locations').set(auth(k)).expect(200);
    return res.body.find((l: { name: string }) => l.name === name).id as string;
  };
  const product = (code: string) => db.product.findUniqueOrThrow({ where: { code } });

  beforeAll(async () => {
    t = await startTestApp('pharmacy');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    // Segundo farmacêutico no hospital, para a dupla conferência das transferências.
    const hosp = await db.unit.findFirstOrThrow({ where: { name: 'Hospital Municipal São Lucas' } });
    await db.user.create({
      data: {
        cpf: EXTRA_PHARMACIST_CPF,
        name: 'Rafael Conferente Farmacêutico',
        passwordHash: await hashPassword(demoFixtures.DEMO_PASSWORD),
        assignments: { create: { unitId: hosp.id, role: 'FARMACIA', cbo: '223405' } },
      },
    });
    tok = {
      alm: await t.login('farmaceutica', 'Almoxarifado Central', 'FARMACIA'),
      hosp: await t.login('farmaceutica', 'Hospital Municipal São Lucas', 'FARMACIA'),
      fc: await t.login('farmaceutica', 'Farmácia Central', 'FARMACIA'),
      hosp2: await loginCpf(EXTRA_PHARMACIST_CPF, 'Hospital Municipal São Lucas', 'FARMACIA'),
      enf: await t.login('enfermeiro', 'Hospital Municipal São Lucas', 'ENFERMAGEM'),
      tec: await t.login('tecnica', 'Hospital Municipal São Lucas', 'ENFERMAGEM'),
      recepcao: await t.login('recepcao', 'UBS Centro', 'RECEPCAO'),
    };
  });
  afterAll(async () => {
    t?.app.get(PharmacyClock).set(undefined);
    await t?.close();
  });

  describe('entrada de NF-e', () => {
    it('recusa nota de outro destinatário, exige De-Para e importa com rastro', async () => {
      const alm = await location('alm', 'Almoxarifado Central');
      const other = await t.http().post('/api/pharmacy/nfe/import').set(auth('alm')).send({ xml: NFE_GO, locationId: alm }).expect(422);
      expect(other.body.code).toBe('NFE_OUTRO_DESTINATARIO');

      const tenants = t.app.get(TenantsService);
      await tenants.master.tenant.update({ where: { slug: t.slug }, data: { cnpj: DEST_CNPJ } });

      const unmapped = await t.http().post('/api/pharmacy/nfe/import').set(auth('alm')).send({ xml: NFE_GO, locationId: alm }).expect(422);
      expect(unmapped.body.code).toBe('NFE_SEM_DE_PARA');
      expect(unmapped.body.details.unmapped).toHaveLength(3);
      const dip = unmapped.body.details.unmapped.find((u: { supplierCode: string }) => u.supplierCode === 'DIP500');
      expect(dip.suggestions.map((s: { description: string }) => s.description)).toContain('Dipirona sódica 500 mg comprimido');

      const map = (supplierCode: string, code: string, factor: number) =>
        product(code).then((p) =>
          t.http().post('/api/pharmacy/mappings').set(auth('alm')).send({ productId: p.id, supplierCnpj: '11222333000181', supplierCode, conversionFactor: factor }).expect(201),
        );
      await map('DIP500', 'MED001', 100);
      await map('AMX500', 'MED009', 21);
      await map('LOS50', 'MED003', 30);

      // XML puro também é aceito (Content-Type application/xml).
      const ok = await t.http().post(`/api/pharmacy/nfe/import?locationId=${alm}`).set(auth('alm')).set('content-type', 'application/xml').send(NFE_GO).expect(201);
      expect(ok.body.accessKey).toBe('52260311222333000181550010000015231482139773');
      const amox = ok.body.entries.filter((e: { lot: string }) => e.lot.startsWith('AM26'));
      expect(amox.map((e: { quantity: number }) => e.quantity).sort()).toEqual([420, 630]);

      const stock = await t.http().get(`/api/pharmacy/stock?locationId=${alm}`).set(auth('alm')).expect(200);
      expect(stock.body.items.find((i: { lot: string }) => i.lot === 'DP26A01').quantity).toBe(1000);

      const again = await t.http().post('/api/pharmacy/nfe/import').set(auth('alm')).send({ xml: NFE_GO, locationId: alm }).expect(409);
      expect(again.body.code).toBe('CONFLITO');
      const audit = await db.auditEntry.count({ where: { action: 'estoque.nfe.importar' } });
      expect(audit).toBe(1);
    });

    it('bloqueia medicamento sem bloco <rastro>', async () => {
      const alm = await location('alm', 'Almoxarifado Central');
      const firstRastro = /<rastro>[\s\S]*?<\/rastro>/;
      const xml = NFE_SP.replace(firstRastro, '');
      const res = await t.http().post('/api/pharmacy/nfe/import').set(auth('alm')).send({ xml, locationId: alm }).expect(422);
      expect(res.body.code).toBe('NFE_RASTREABILIDADE');
      expect(res.body.details.problems[0].problem).toMatch(/rastro/);
      expect(await db.invoice.count()).toBe(1);
    });

    it('não importa em local de outra unidade', async () => {
      const fc = await location('fc', 'Farmácia Central');
      await t.http().post('/api/pharmacy/nfe/import').set(auth('alm')).send({ xml: NFE_SP, locationId: fc }).expect(403);
    });
  });

  describe('transferência com dupla conferência', () => {
    it('expede na origem e registra divergência no destino', async () => {
      const alm = await location('alm', 'Almoxarifado Central');
      const hosp = await location('hosp', 'Farmácia Hospitalar');
      const hctz = await product('MED004');
      const lot = await db.stockLot.findFirstOrThrow({ where: { productId: hctz.id, lotNumber: 'L26004' } });
      const before = Number((await db.stockBalance.findUniqueOrThrow({ where: { locationId_lotId: { locationId: alm, lotId: lot.id } } })).quantity);

      const created = await t.http().post('/api/pharmacy/transfers').set(auth('alm')).send({ fromLocationId: alm, toLocationId: hosp, items: [{ lotId: lot.id, quantity: 100 }] }).expect(201);
      expect(created.body.status).toBe('SEPARACAO');
      const dispatched = await t.http().post(`/api/pharmacy/transfers/${created.body.id}/dispatch`).set(auth('alm')).expect(200);
      expect(dispatched.body.status).toBe('EXPEDIDA');
      const after = Number((await db.stockBalance.findUniqueOrThrow({ where: { locationId_lotId: { locationId: alm, lotId: lot.id } } })).quantity);
      expect(before - after).toBe(100);

      // Quem expediu não pode conferir o recebimento.
      await t.http().post(`/api/pharmacy/transfers/${created.body.id}/receive`).set(auth('hosp')).send({ items: [{ lotId: lot.id, receivedQuantity: 100 }] }).expect(403);
      const hospBefore = Number((await db.stockBalance.findUniqueOrThrow({ where: { locationId_lotId: { locationId: hosp, lotId: lot.id } } })).quantity);
      const received = await t.http().post(`/api/pharmacy/transfers/${created.body.id}/receive`).set(auth('hosp2')).send({ items: [{ lotId: lot.id, receivedQuantity: 90 }] }).expect(200);
      expect(received.body.status).toBe('DIVERGENTE');
      const hospAfter = Number((await db.stockBalance.findUniqueOrThrow({ where: { locationId_lotId: { locationId: hosp, lotId: lot.id } } })).quantity);
      expect(hospAfter - hospBefore).toBe(90);
      await t.http().post(`/api/pharmacy/transfers/${created.body.id}/dispatch`).set(auth('alm')).expect(422);
    });

    it('não deixa expedir mais que o saldo', async () => {
      const alm = await location('alm', 'Almoxarifado Central');
      const hosp = await location('hosp', 'Farmácia Hospitalar');
      const lot = await db.stockLot.findFirstOrThrow({ where: { lotNumber: 'L26004' } });
      const res = await t.http().post('/api/pharmacy/transfers').set(auth('alm')).send({ fromLocationId: alm, toLocationId: hosp, items: [{ lotId: lot.id, quantity: 999999 }] }).expect(422);
      expect(res.body.code).toBe('SALDO_INSUFICIENTE');
    });
  });

  describe('unitarização', () => {
    it('gera doses serializadas com Datamatrix GS1 e recusa validade maior que a do lote', async () => {
      const hosp = await location('hosp', 'Farmácia Hospitalar');
      const posto = await location('hosp', 'Posto de Enfermagem - Clínica Médica');
      const cef = await product('MED013');
      const lot = await db.stockLot.findFirstOrThrow({ where: { productId: cef.id } });
      const res = await t.http().post('/api/pharmacy/unitize').set(auth('hosp')).send({ lotId: lot.id, fromLocationId: hosp, toLocationId: posto, quantity: 3 }).expect(201);
      expect(res.body.labels).toHaveLength(3);
      const label = res.body.labels[0];
      const parsed = parseGs1(label.gs1);
      expect(parsed.serial).toBe(label.serial);
      expect(parsed.lot).toBe(lot.lotNumber);
      expect(new Set(res.body.labels.map((l: { serial: string }) => l.serial)).size).toBe(3);

      const late = await t.http().post('/api/pharmacy/unitize').set(auth('hosp')).send({ lotId: lot.id, fromLocationId: hosp, toLocationId: posto, quantity: 1, expiry: '2099-01-01' }).expect(422);
      expect(late.body.code).toBe('VALIDADE_INVALIDA');
      await t.http().post('/api/pharmacy/unitize').set(auth('enf')).send({ lotId: lot.id, fromLocationId: hosp, toLocationId: posto, quantity: 1 }).expect(403);
    });
  });

  describe('dispensação ambulatorial', () => {
    it('usa FEFO entre lotes e gera outbox para a RNDS', async () => {
      const fc = await location('fc', 'Farmácia Central');
      const hctz = await product('MED004');
      const early = await db.stockLot.create({ data: { productId: hctz.id, lotNumber: 'HCTZ-CEDO', expiry: new Date('2027-01-15') } });
      await db.stockBalance.create({ data: { locationId: fc, lotId: early.id, quantity: 10 } });
      const maria = await db.patient.findFirstOrThrow({ where: { name: 'Maria Aparecida da Silva' } });
      const outboxBefore = await db.outboxMessage.count({ where: { kind: 'RNDS_DISPENSACAO' } });

      const res = await t.http().post('/api/pharmacy/dispensations').set(auth('fc')).send({ patientId: maria.id, items: [{ productId: hctz.id, quantity: 15 }] }).expect(201);
      expect(res.body.items).toEqual([
        expect.objectContaining({ lot: 'HCTZ-CEDO', quantity: 10 }),
        expect.objectContaining({ lot: 'L26004', quantity: 5 }),
      ]);
      expect(await db.outboxMessage.count({ where: { kind: 'RNDS_DISPENSACAO' } })).toBe(outboxBefore + 1);
      const tl = await db.dispensation.findMany({ where: { patientId: maria.id } });
      expect(tl.length).toBeGreaterThan(2);
    });

    it('exige receita para controlado da Portaria 344 e entra no relatório', async () => {
      const diazepam = await product('MED015');
      const jose = await db.patient.findFirstOrThrow({ where: { name: 'José Carlos Pereira' } });
      const blocked = await t.http().post('/api/pharmacy/dispensations').set(auth('fc')).send({ patientId: jose.id, items: [{ productId: diazepam.id, quantity: 10 }] }).expect(422);
      expect(blocked.body.code).toBe('CONTROLADO_SEM_RECEITA');
      const ok = await t.http()
        .post('/api/pharmacy/dispensations')
        .set(auth('fc'))
        .send({
          patientId: jose.id,
          externalPrescription: { number: 'B1-2026-000123', prescriberName: 'Dr. Paulo Prescritor', prescriberCouncil: 'CRM-SP 999999', date: '2026-10-20' },
          items: [{ productId: diazepam.id, quantity: 10 }],
        })
        .expect(201);
      expect(ok.body.controlled).toBe(true);
      const today = new Date().toISOString().slice(0, 10);
      const report = await t.http().get(`/api/pharmacy/controlled-report?from=2026-01-01&to=${today}`).set(auth('fc')).expect(200);
      const row = report.body.products.find((p: { product: string }) => p.product.startsWith('Diazepam'));
      expect(row.list).toBe('B1');
      expect(row.exits).toBe(10);
      expect(row.balance).toBe(1190);
      await t.http().post('/api/pharmacy/dispensations').set(auth('recepcao')).send({ patientId: jose.id, items: [{ productId: diazepam.id, quantity: 1 }] }).expect(403);
    });
  });

  describe('administração beira-leito (5 certos)', () => {
    let francisco: { id: string };
    let maria: { id: string };
    let items: Record<string, { id: string; signedAt: Date }>;
    let slot: Date;
    const clock = () => t.app.get(PharmacyClock);
    const availableDose = async (code: string) => {
      const p = await product(code);
      const posto = await db.stockLocation.findFirstOrThrow({ where: { kind: 'POSTO_ENFERMAGEM' } });
      return db.unitDose.findFirstOrThrow({ where: { productId: p.id, status: 'DISPONIVEL', locationId: posto.id }, orderBy: { serial: 'asc' } });
    };
    const administer = (k: string, body: Record<string, unknown>) => t.http().post('/api/pharmacy/administrations').set(auth(k)).send(body);

    beforeAll(async () => {
      francisco = await db.patient.findFirstOrThrow({ where: { name: 'Francisco Souza Santos' } });
      maria = await db.patient.findFirstOrThrow({ where: { name: 'Maria Aparecida da Silva' } });
      const rx = await db.prescription.findFirstOrThrow({ where: { patientId: francisco.id, kind: 'HOSPITALAR' }, include: { items: true } });
      items = Object.fromEntries(rx.items.map((i) => [i.activeIngredient!, { id: i.id, signedAt: rx.signedAt }]));
      // Dois dias depois da prescrição: horário aprazado de todos os itens (12/12 h e 6/6 h), 5 minutos depois.
      slot = new Date(rx.signedAt.getTime() + 48 * 3_600_000);
      clock().set(new Date(slot.getTime() + 5 * 60_000));
    });

    it('mostra o aprazamento com o que está devido agora e os POPs exigidos', async () => {
      const res = await t.http().get(`/api/pharmacy/administrations/schedule?patientId=${francisco.id}`).set(auth('enf')).expect(200);
      expect(res.body.items).toHaveLength(3);
      for (const i of res.body.items) expect(i.dueNow).toBe(true);
      const hep = res.body.items.find((i: { description: string }) => i.description.startsWith('Heparina'));
      expect(hep.requiredPops).toEqual(['administracao.alta_vigilancia']);
    });

    it('bloqueia cada um dos 5 certos', async () => {
      const dose = await availableDose('MED019');
      const base = { patientCode: `PAC:${francisco.id}`, doseCode: dose.gs1, prescriptionItemId: items.dipirona!.id, route: 'IV' };
      const failed = async (body: Record<string, unknown>, check: string) => {
        const res = await administer('enf', body).expect(422);
        expect(res.body.status).toBe('BLOQUEADO');
        expect(res.body.sound).toBe('BLOQUEIO');
        expect(res.body.checks.find((c: { check: string }) => c.check === check).ok).toBe(false);
        return res;
      };
      await failed({ ...base, patientCode: `PAC:${maria.id}` }, 'PACIENTE');
      await failed({ ...base, route: 'IM' }, 'VIA');
      const heparinDose = await availableDose('MED017');
      await failed({ ...base, doseCode: heparinDose.gs1 }, 'MEDICAMENTO');
      // Dose que ainda está na farmácia (não chegou ao posto).
      const hosp = await location('hosp', 'Farmácia Hospitalar');
      const dip = await product('MED019');
      const dipLot = await db.stockLot.findFirstOrThrow({ where: { productId: dip.id } });
      const pharmacyDose = await t.http().post('/api/pharmacy/unitize').set(auth('hosp')).send({ lotId: dipLot.id, fromLocationId: hosp, toLocationId: hosp, quantity: 1 }).expect(201);
      await failed({ ...base, doseCode: pharmacyDose.body.labels[0].gs1 }, 'DOSE');
      clock().set(new Date(slot.getTime() + 2 * 3_600_000));
      await failed(base, 'HORARIO');
      clock().set(new Date(slot.getTime() + 5 * 60_000));
      expect(await db.administration.count({ where: { status: 'BLOQUEADO' } })).toBe(5);
      expect((await db.unitDose.findUniqueOrThrow({ where: { id: dose.id } })).status).toBe('DISPONIVEL');
    });

    it('administra, baixa o estoque do posto e não repete o mesmo horário', async () => {
      const dose = await availableDose('MED019');
      const before = Number((await db.stockBalance.findUniqueOrThrow({ where: { locationId_lotId: { locationId: dose.locationId, lotId: dose.lotId } } })).quantity);
      // Leitura crua do scanner (com separador GS), como chega do leitor Datamatrix.
      const raw = gs1ElementString(parseGs1(dose.gs1));
      const res = await administer('enf', { patientCode: `PAC:${francisco.id}`, doseCode: raw, prescriptionItemId: items.dipirona!.id, route: 'IV' }).expect(201);
      expect(res.body).toMatchObject({ status: 'ADMINISTRADO', sound: 'APROVADO' });
      expect(new Date(res.body.scheduledFor).getTime()).toBe(slot.getTime());
      expect((await db.unitDose.findUniqueOrThrow({ where: { id: dose.id } })).status).toBe('ADMINISTRADA');
      const after = Number((await db.stockBalance.findUniqueOrThrow({ where: { locationId_lotId: { locationId: dose.locationId, lotId: dose.lotId } } })).quantity);
      expect(before - after).toBe(1);
      expect(await db.stockMovement.count({ where: { kind: 'ADMINISTRACAO', refId: dose.id } })).toBe(1);

      const next = await availableDose('MED019');
      const again = await administer('enf', { patientCode: `PAC:${francisco.id}`, doseCode: next.gs1, prescriptionItemId: items.dipirona!.id, route: 'IV' }).expect(422);
      expect(again.body.checks.find((c: { check: string }) => c.check === 'HORARIO').detail).toMatch(/já administrada/);
    });

    it('exige POP com dupla checagem para alta vigilância e não reaproveita a execução', async () => {
      const dose = await availableDose('MED017');
      const body = { patientCode: `PAC:${francisco.id}`, doseCode: dose.gs1, prescriptionItemId: items.heparina!.id, route: 'SC' };
      const noPop = await administer('enf', body).expect(422);
      expect(noPop.body.checks.find((c: { check: string }) => c.check === 'POP').ok).toBe(false);

      const pop = await db.pop.findUniqueOrThrow({ where: { code: 'POP-ENF-001' } });
      const tecnica = demoFixtures.STAFF.find((s) => s.key === 'tecnica')!;
      const exec = await t.http()
        .post(`/api/pops/${pop.id}/executions`)
        .set(auth('enf'))
        .send({ answers: { identificacao: true, prescricao: true, calculo: true }, patientId: francisco.id, doubleCheck: { cpf: tecnica.cpf, password: demoFixtures.DEMO_PASSWORD } })
        .expect(201);
      // Execução de outro profissional não vale para este.
      await administer('tec', { ...body, popExecutionId: exec.body.id }).expect(422);
      const ok = await administer('enf', { ...body, popExecutionId: exec.body.id }).expect(201);
      expect(ok.body.status).toBe('ADMINISTRADO');
      const adm = await db.administration.findUniqueOrThrow({ where: { id: ok.body.administrationId } });
      expect(adm.doubleCheckBy).toBeTruthy();

      // Próximo horário (12 h depois) com a mesma execução de POP: já consumida.
      clock().set(new Date(slot.getTime() + 12 * 3_600_000));
      const dose2 = await availableDose('MED017');
      const reuse = await administer('enf', { ...body, doseCode: dose2.gs1, popExecutionId: exec.body.id }).expect(422);
      expect(reuse.body.checks.find((c: { check: string }) => c.check === 'POP').ok).toBe(false);
      clock().set(new Date(slot.getTime() + 5 * 60_000));
    });

    it('exige o POP de antimicrobiano restrito', async () => {
      const dose = await availableDose('MED013');
      const body = { patientCode: `PAC:${francisco.id}`, doseCode: dose.gs1, prescriptionItemId: items.ceftriaxona!.id, route: 'IV' };
      await administer('enf', body).expect(422);
      const pop = await db.pop.findUniqueOrThrow({ where: { code: 'POP-ENF-002' } });
      const exec = await t.http().post(`/api/pops/${pop.id}/executions`).set(auth('enf')).send({ answers: { ccih: true, horario: true } }).expect(201);
      await administer('enf', { ...body, popExecutionIds: [exec.body.id] }).expect(201);
    });

    it('bloqueia item suspenso e devolve doses não administradas', async () => {
      await db.prescriptionItem.update({ where: { id: items.dipirona!.id }, data: { suspendedAt: new Date() } });
      clock().set(new Date(slot.getTime() + 6 * 3_600_000));
      const dose = await availableDose('MED019');
      const res = await administer('enf', { patientCode: `PAC:${francisco.id}`, doseCode: dose.gs1, prescriptionItemId: items.dipirona!.id, route: 'IV' }).expect(422);
      expect(res.body.checks.find((c: { check: string }) => c.check === 'PRESCRICAO').ok).toBe(false);

      const hosp = await location('hosp', 'Farmácia Hospitalar');
      const balance = () => db.stockBalance.findUnique({ where: { locationId_lotId: { locationId: hosp, lotId: dose.lotId } } }).then((b) => Number(b?.quantity ?? 0));
      const before = await balance();
      const ret = await t.http().post('/api/pharmacy/returns').set(auth('enf')).send({ unitDoseId: dose.id, reason: 'Medicação suspensa' }).expect(201);
      expect(ret.body.toLocationId).toBe(hosp);
      expect(await balance()).toBe(before + 1);
      expect((await db.unitDose.findUniqueOrThrow({ where: { id: dose.id } })).status).toBe('DEVOLVIDA');
      const administered = await db.unitDose.findFirstOrThrow({ where: { status: 'ADMINISTRADA' } });
      const bad = await t.http().post('/api/pharmacy/returns').set(auth('enf')).send({ unitDoseId: administered.id, reason: 'Teste' }).expect(422);
      expect(bad.body.code).toBe('DOSE_INDISPONIVEL');
    });

    it('lê o código de uma dose', async () => {
      const dose = await availableDose('MED013');
      const res = await t.http().get(`/api/pharmacy/lookup?code=${encodeURIComponent(dose.gs1)}`).set(auth('enf')).expect(200);
      expect(res.body.product.antimicrobialRestricted).toBe(true);
      expect(res.body.unitDose.serial).toBe(dose.serial);
    });
  });
});
