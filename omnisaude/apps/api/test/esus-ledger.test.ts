import { randomUUID } from 'node:crypto';
import { decodeLedi, TIPO_DADO, type LediObject } from '@omnisaude/esus';
import { completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { FONTES_ESUS } from '../src/modules/esus/esus.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const TZ = 'America/Sao_Paulo';
/** Data local (fuso da instituição) de k dias atrás. */
const D = (k: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - k * 86_400_000));
/** Instante ISO do dia local D(k) às hh:mm (UTC-3). */
const at = (k: number, hh: number, mm = 0) => new Date(`${D(k)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000-03:00`).toISOString();

type Rec = {
  id: string;
  kind: number;
  uuid: string;
  sourceType: string;
  sourceId: string;
  status: string;
  ine: string | null;
  issues: { path: string; message: string }[];
  summary: { registros?: string[]; visitas?: number };
};

describe.runIf(enabled)('e-SUS: registro do que já foi exportado, reprocessamento exato, cabeçalho da visita e fontes isoladas', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let gestora = '';
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  let ubs: { id: string };
  let vig: { id: string };
  let acsUser: { id: string };
  let aceUser: { id: string };

  const visitaAce = (householdId: string, quando: string) => ({
    tipo: 'VISITA_VETORIAL',
    clientId: randomUUID(),
    registradoEm: quando,
    householdId,
    visita: { atividade: 'LI_T', situacao: 'TRABALHADO', acaoEducativa: true, depositos: { B: { inspecionados: 2, comFoco: 0, eliminados: 1, tratados: 0 } } },
  });
  const syncAce = async (token: string, ops: unknown[]) => {
    const r = (await t.http().post('/api/endemias/campo/sync').set(auth(token)).send({ operacoes: ops }).expect(200)).body as { resultados: { status: string; id: string; erro?: string }[] };
    for (const x of r.resultados) expect(x.status, JSON.stringify(x)).toBe('OK');
    return r.resultados.map((x) => x.id);
  };
  const gerar = (unitId: string, from: string, to = from) => t.http().post('/api/esus/batches').set(auth(gestora)).send({ unitId, from, to });
  const fichaDe = async (recordId: string) => {
    const r = await db.esusRecord.findUniqueOrThrow({ where: { id: recordId } });
    const dado = decodeLedi('DadoTransporteThrift', r.payload);
    return { dado, ficha: decodeLedi('FichaVisitaDomiciliarMasterThrift', dado.dadoSerializado as Uint8Array) as LediObject };
  };
  const itensDe = async (recordId: string) => (await db.esusRecordItem.findMany({ where: { recordId }, select: { sourceId: true } })).map((i: { sourceId: string }) => i.sourceId).sort();
  const casas = async (n: number, skip = 0) => (await db.household.findMany({ where: { active: true }, skip, take: n, orderBy: { createdAt: 'asc' }, select: { id: true } })).map((h: { id: string }) => h.id) as string[];

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('esusledger', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    ubs = await db.unit.findFirstOrThrow({ where: { name: 'UBS Centro' } });
    vig = await db.unit.findFirstOrThrow({ where: { name: 'Vigilância em Saúde' } });
    acsUser = await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000011') } });
    aceUser = await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000016') } });
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('visita do ACE sincronizada depois do envio entra sozinha no lote seguinte do mesmo dia, sem repetir a já aceita', async () => {
    const ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    const [c1, c2] = await casas(2);
    const [v1] = await syncAce(ace, [visitaAce(c1!, at(1, 9))]);
    const b1 = (await gerar(vig.id, D(1)).expect(201)).body;
    const f1 = (b1.records as Rec[]).filter((r) => r.sourceType === 'VectorVisit');
    expect(f1.flatMap((r) => r.summary.registros)).toEqual([v1]);
    await fetch(`${mocks.url}/pec/_received`, { method: 'DELETE' });
    const e1 = (await t.http().post(`/api/esus/batches/${b1.id}/send`).set(auth(gestora)).expect(200)).body;
    expect(e1.rejected).toBe(0);

    // Visita das 10h do mesmo dia, sincronizada só agora (aparelho sem rede): vai sozinha numa ficha nova.
    const [v2] = await syncAce(ace, [visitaAce(c2!, at(1, 10))]);
    const b2 = (await gerar(vig.id, D(1)).expect(201)).body;
    const f2 = (b2.records as Rec[]).filter((r) => r.sourceType === 'VectorVisit');
    expect(f2).toHaveLength(1);
    expect(f2[0]!.summary.registros).toEqual([v2]);
    expect(f2[0]!.status, JSON.stringify(f2[0]!.issues)).toBe('GERADA');
    const e2 = (await t.http().post(`/api/esus/batches/${b2.id}/send`).set(auth(gestora)).expect(200)).body;
    expect(e2.rejected).toBe(0);
    // O PEC recebeu cada visita uma vez: as fichas aceitas somam as 2 visitas do banco.
    let visitasNoPec = 0;
    for (const r of [...f1, ...f2]) visitasNoPec += ((await fichaDe(r.id)).ficha.visitasDomiciliares as unknown[]).length;
    expect(visitasNoPec).toBe(2);
    expect(await itensDe(f1[0]!.id)).toEqual([v1]);
    expect(await itensDe(f2[0]!.id)).toEqual([v2]);

    // Tudo do dia já exportado: o aviso diz isso, em vez de "nenhum registro".
    const b3 = await gerar(vig.id, D(1)).expect(422);
    expect(b3.body.code).toBe('SEM_FICHAS');
    expect(b3.body.message).toMatch(/já foram exportados em lotes anteriores/);
  });

  it('reprocessar regera a ficha só com os registros dela e pega a CBO corrigida na lotação do ACE', async () => {
    await db.userAssignment.updateMany({ where: { userId: aceUser.id, role: 'ACE', unitId: vig.id }, data: { cbo: '352210' } });
    const ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    const [c3, c4, c5] = await casas(3, 2);
    const [v3, v4] = await syncAce(ace, [visitaAce(c3!, at(2, 9)), visitaAce(c4!, at(2, 10))]);
    const b = (await gerar(vig.id, D(2)).expect(201)).body;
    const r = (b.records as Rec[]).find((x) => x.sourceType === 'VectorVisit')!;
    expect(r.status).toBe('INVALIDA');
    expect(JSON.stringify(r.issues)).toMatch(/352210/);
    expect(r.summary.registros).toEqual([v3, v4]);

    // Depois do lote: uma visita do mesmo dia chega atrasada e a primeira da ficha sai da unidade.
    const [v5] = await syncAce(ace, [visitaAce(c5!, at(2, 8))]);
    await db.vectorVisit.update({ where: { id: v3 }, data: { unitId: ubs.id } });
    await db.userAssignment.updateMany({ where: { userId: aceUser.id, role: 'ACE', unitId: vig.id }, data: { cbo: '515140' } });

    const rep = (await t.http().post(`/api/esus/batches/${b.id}/reprocess`).set(auth(gestora)).expect(200)).body;
    expect(rep).toMatchObject({ regenerated: 1, stillInvalid: 0, released: 1 });
    const depois = (rep.batch.records as Rec[]).find((x) => x.id === r.id)!;
    expect(depois.status, JSON.stringify(depois.issues)).toBe('GERADA');
    expect(depois.uuid).toBe(r.uuid);
    // A ficha antiga foi achada pelos itens (a primeira visita saiu): fica só com v4, sem a atrasada v5.
    expect(depois.summary.registros).toEqual([v4]);
    expect(depois.sourceId).toBe(v4);
    expect(await itensDe(r.id)).toEqual([v4]);
    const { dado, ficha } = await fichaDe(r.id);
    expect(dado.uuidDadoSerializado).toBe(r.uuid);
    expect(ficha.uuidFicha).toBe(r.uuid);
    expect((ficha.headerTransport as LediObject).cboCodigo_2002).toBe('515140');
    expect(ficha.visitasDomiciliares as unknown[]).toHaveLength(1);

    // A atrasada vai no lote seguinte do dia, sozinha (a que saiu da unidade foi liberada e não é mais desta unidade).
    const b2 = (await gerar(vig.id, D(2)).expect(201)).body;
    const f2 = (b2.records as Rec[]).filter((x) => x.sourceType === 'VectorVisit');
    expect(f2.flatMap((x) => x.summary.registros)).toEqual([v5]);
    expect(f2[0]!.status, JSON.stringify(f2[0]!.issues)).toBe('GERADA');
    expect(await db.esusRecordItem.count({ where: { sourceType: 'VectorVisit', sourceId: v3 } })).toBe(0);
  });

  it('CBO errada na lotação do ACS: corrigir a lotação e reprocessar conserta a ficha (cabeçalho resolvido na exportação)', async () => {
    await db.userAssignment.updateMany({ where: { userId: acsUser.id, role: 'ACS', unitId: ubs.id }, data: { cbo: '515150' } });
    const acs = await t.login('acs', 'UBS Centro', 'ACS');
    const terr = (await t.http().get('/api/acs/territorio').set(auth(acs)).expect(200)).body;
    const dom = terr.domicilios[0];
    const pessoa = dom.familias[0].membros[0];
    const s = (
      await t
        .http()
        .post('/api/acs/sync')
        .set(auth(acs))
        .send({ operacoes: [{ tipo: 'VISITA', clientId: randomUUID(), registradoEm: at(4, 9), householdId: dom.id, patientId: pessoa.id, visita: { motivos: ['29'], desfecho: '1' } }] })
        .expect(200)
    ).body;
    expect(s.resultados[0].status).toBe('OK');
    const b = (await gerar(ubs.id, D(4)).expect(201)).body;
    const f = (b.records as Rec[]).find((x) => x.sourceType === 'HomeVisit')!;
    expect(f.status).toBe('INVALIDA');
    expect(JSON.stringify(f.issues)).toMatch(/515150/);
    await db.userAssignment.updateMany({ where: { userId: acsUser.id, role: 'ACS', unitId: ubs.id }, data: { cbo: '515105' } });
    const rep = (await t.http().post(`/api/esus/batches/${b.id}/reprocess`).set(auth(gestora)).expect(200)).body;
    const f2 = (rep.batch.records as Rec[]).find((x) => x.id === f.id)!;
    expect(f2.status, JSON.stringify(f2.issues)).toBe('GERADA');
    const h = (await fichaDe(f.id)).ficha.headerTransport as LediObject;
    expect(h).toMatchObject({ cboCodigo_2002: '515105', ine: '0000000101' });
  });

  it('entrada da visita do ACS: abrigo e outros sem pessoa geram ficha válida; o que o lote recusaria volta erro no sync', async () => {
    const acs = await t.login('acs', 'UBS Centro', 'ACS');
    const terr = (await t.http().get('/api/acs/territorio').set(auth(acs)).expect(200)).body;
    const dom = terr.domicilios[0];
    const pessoa = dom.familias[0].membros[0];
    const op = (hora: number, visita: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ tipo: 'VISITA', clientId: randomUUID(), registradoEm: at(3, hora), householdId: dom.id, ...extra, visita });
    const r = (
      await t
        .http()
        .post('/api/acs/sync')
        .set(auth(acs))
        .send({
          operacoes: [
            op(8, { motivos: ['29', '11'], desfecho: '1' }, { patientId: pessoa.id }),
            op(9, { motivos: ['29'], desfecho: '1', tipoImovel: '07' }),
            op(10, { motivos: ['1'], desfecho: '1', tipoImovel: '99' }),
            op(11, { motivos: ['11'], desfecho: '1', tipoImovel: '07' }),
            op(12, { motivos: ['29'], desfecho: '1', tipoImovel: '02' }),
            op(13, { motivos: ['34'], desfecho: '1', tipoImovel: '05' }),
            op(14, { motivos: ['31'], desfecho: '1', tipoImovel: '13' }, { patientId: pessoa.id }),
            op(15, { motivos: ['27'], desfecho: '1', tipoImovel: '12', sistolica: 120, diastolica: 80 }),
          ],
        })
        .expect(200)
    ).body;
    const st = r.resultados.map((x: { status: string; erro?: string }) => `${x.status}${x.erro ? `: ${x.erro}` : ''}`);
    expect(st.slice(0, 3)).toEqual(['OK', 'OK', 'OK']);
    expect(st[3]).toMatch(/^ERRO: Visita com motivo de busca ativa, acompanhamento.*precisa informar a pessoa visitada/);
    expect(st[4]).toMatch(/^ERRO: Em imóvel que não é domicílio a visita só aceita os motivos/);
    expect(st[5]).toBe('OK');
    expect(st[6]).toMatch(/^ERRO: Em imóvel que não é domicílio .* não identifica pessoa/);
    expect(st[7]).toMatch(/^ERRO: Em imóvel que não é domicílio a visita não leva medições/);
    const b = (await gerar(ubs.id, D(3)).expect(201)).body;
    const fv = (b.records as Rec[]).filter((x) => x.sourceType === 'HomeVisit');
    expect(fv).toHaveLength(1);
    expect(fv[0]!.status, JSON.stringify(fv[0]!.issues)).toBe('GERADA');
    expect(fv[0]!.summary.visitas).toBe(4);

    // Visita gravada antes da regra de entrada (comércio com visita periódica): a ficha aponta o motivo, não "sem motivo".
    await db.homeVisit.create({
      data: {
        clientId: randomUUID(),
        unitId: ubs.id,
        professionalId: acsUser.id,
        cbo: '515105',
        visitedAt: new Date(at(8, 9)),
        recordedAt: new Date(at(8, 9)),
        turno: 1,
        outcome: '1',
        reasons: ['29'],
        propertyType: '02',
        microArea: '01',
      },
    });
    const bl = (await gerar(ubs.id, D(8)).expect(201)).body;
    const fl = (bl.records as Rec[]).find((x) => x.sourceType === 'HomeVisit')!;
    expect(fl.status).toBe('INVALIDA');
    expect(fl.issues.map((i) => i.message)).toContain('motivo 29 não é aceito em imóvel que não é domicílio');
    expect(fl.issues.some((i) => /informe ao menos um motivo/.test(i.message))).toBe(false);
  });

  it('uma fonte que falha não derruba o lote: o aviso fica no lote e na trilha, e as fichas dela vão no lote seguinte; ACS que também é ACE não leva o INE da eSF', async () => {
    // O ACS da eSF Centro I (INE 0000000101) também é ACE na UBS, sem equipe nessa ocupação.
    await db.userAssignment.create({ data: { userId: acsUser.id, unitId: ubs.id, role: 'ACE', cbo: '515140', active: true } });
    const aceNaUbs = await t.login('acs', 'UBS Centro', 'ACE');
    const acs = await t.login('acs', 'UBS Centro', 'ACS');
    const terr = (await t.http().get('/api/acs/territorio').set(auth(acs)).expect(200)).body;
    const dom = terr.domicilios[1] ?? terr.domicilios[0];
    const [vv] = await syncAce(aceNaUbs, [visitaAce(dom.id, at(6, 9))]);
    const s = (
      await t
        .http()
        .post('/api/acs/sync')
        .set(auth(acs))
        .send({
          operacoes: [
            { tipo: 'VISITA', clientId: randomUUID(), registradoEm: at(6, 10), householdId: terr.domicilios[0].id, patientId: terr.domicilios[0].familias[0].membros[0].id, visita: { motivos: ['29'], desfecho: '1' } },
          ],
        })
        .expect(200)
    ).body;
    expect(s.resultados[0].status).toBe('OK');

    // A leitura das visitas do ACE falha na geração (banco fora, limite de parâmetros...).
    const fonte = FONTES_ESUS.find((f) => f.origens.includes('VectorVisit'))!;
    const original = fonte.gerar;
    fonte.gerar = async () => {
      throw new Error('falha simulada na leitura');
    };
    let b1: { id: string; lastError: string | null; records: Rec[] };
    try {
      b1 = (await gerar(ubs.id, D(6)).expect(201)).body;
    } finally {
      fonte.gerar = original;
    }
    expect(b1.lastError).toMatch(/^Fichas não geradas neste lote \(falha ao ler visita do agente de endemias\)/);
    expect((b1.records as Rec[]).some((x) => x.sourceType === 'VectorVisit')).toBe(false);
    const hv = (b1.records as Rec[]).find((x) => x.sourceType === 'HomeVisit')!;
    expect(hv.status, JSON.stringify(hv.issues)).toBe('GERADA');
    expect(hv.ine).toBe('0000000101');
    expect(await db.auditEntry.count({ where: { action: 'esus.lote.fonte_com_falha', entityId: b1.id } })).toBe(1);
    // O envio não apaga o aviso: as fichas da fonte que falhou continuam faltando neste lote.
    await t.http().post(`/api/esus/batches/${b1.id}/send`).set(auth(gestora)).expect(200);
    expect((await t.http().get(`/api/esus/batches/${b1.id}`).set(auth(gestora)).expect(200)).body.lastError).toMatch(/^Fichas não geradas neste lote/);

    // Lote seguinte do mesmo dia: só a visita do ACE, que não tinha ido; a do ACS não se repete.
    const b2 = (await gerar(ubs.id, D(6)).expect(201)).body;
    expect(b2.lastError).toBeNull();
    const kind8 = (b2.records as Rec[]).filter((x) => x.kind === TIPO_DADO.VISITA_DOMICILIAR);
    expect(kind8.map((x) => x.sourceType)).toEqual(['VectorVisit']);
    expect(kind8[0]!.summary.registros).toEqual([vv]);
    expect(kind8[0]!.status, JSON.stringify(kind8[0]!.issues)).toBe('GERADA');
    // Sem equipe com a CBO 515140: a ficha do ACE vai sem INE (não credita a produção à eSF do ACS).
    expect(kind8[0]!.ine).toBeNull();
    const { dado, ficha } = await fichaDe(kind8[0]!.id);
    expect((ficha.headerTransport as LediObject).cboCodigo_2002).toBe('515140');
    expect((ficha.headerTransport as LediObject).ine).toBeUndefined();
    expect(dado.ineDadoSerializado).toBeUndefined();
  });

  it('ficha cujos registros saíram num reprocessamento: reprocessar de novo não diz que estão em outra ficha', async () => {
    await db.userAssignment.updateMany({ where: { userId: aceUser.id, role: 'ACE', unitId: vig.id }, data: { cbo: '352210' } });
    const ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    const [c] = await casas(1, 6);
    const [v] = await syncAce(ace, [visitaAce(c!, at(10, 9))]);
    const b = (await gerar(vig.id, D(10)).expect(201)).body;
    const r = (b.records as Rec[]).find((x) => x.sourceType === 'VectorVisit')!;
    expect(r.status).toBe('INVALIDA');
    // A visita sai da unidade: o primeiro reprocessamento a libera.
    await db.vectorVisit.update({ where: { id: v }, data: { unitId: ubs.id } });
    await db.userAssignment.updateMany({ where: { userId: aceUser.id, role: 'ACE', unitId: vig.id }, data: { cbo: '515140' } });
    const rep1 = (await t.http().post(`/api/esus/batches/${b.id}/reprocess`).set(auth(gestora)).expect(200)).body;
    expect(rep1).toMatchObject({ regenerated: 0, stillInvalid: 1, released: 1 });
    expect((rep1.batch.records as Rec[]).find((x) => x.id === r.id)!.issues.map((i) => i.message)).toEqual(['O registro de origem não gera mais ficha (excluído, não encerrado ou fora da unidade)']);
    expect(await itensDe(r.id)).toEqual([]);
    // De novo: a ficha está vazia; a mensagem não afirma que a visita está em outra ficha (ela não está em nenhuma).
    const rep2 = (await t.http().post(`/api/esus/batches/${b.id}/reprocess`).set(auth(gestora)).expect(200)).body;
    expect(rep2).toMatchObject({ regenerated: 0, stillInvalid: 1, released: 0 });
    expect((rep2.batch.records as Rec[]).find((x) => x.id === r.id)!.issues.map((i) => i.message)).toEqual([
      'A ficha ficou sem registros: eles saíram dela num reprocessamento anterior ou já estão em outra ficha do e-SUS',
    ]);
    expect(await db.esusRecordItem.count({ where: { sourceType: 'VectorVisit', sourceId: v } })).toBe(0);
  });

  it('mais de 32.767 domicílios trabalhados no período: o lote sai, com as consultas por ids em lotes', { timeout: 180_000 }, async () => {
    const N = 33_000;
    const dia = at(9, 9);
    // Carga direta no banco: domicílios antigos (fora do período, sem cadastro no lote) e uma visita trabalhada em cada.
    await db.$executeRawUnsafe(`INSERT INTO households (id, active, created_at, updated_at) SELECT gen_random_uuid(), true, now() - interval '400 days', now() - interval '400 days' FROM generate_series(1, ${N})`);
    await db.$executeRawUnsafe(
      `INSERT INTO vector_visits (id, client_id, user_id, unit_id, cbo, household_id, property_type, activity, situation, cycle, visited_at, turno)
       SELECT gen_random_uuid(), gen_random_uuid(), $1::uuid, $2::uuid, '515140', h.id, '01', 'LI_T', 'TRABALHADO', '2026-6', $3::timestamp, 1
       FROM households h WHERE h.updated_at < now() - interval '399 days'`,
      aceUser.id,
      vig.id,
      new Date(dia),
    );
    const res = await gerar(vig.id, D(9));
    expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBe(201);
    const fichas = (res.body.records as Rec[]).filter((x) => x.sourceType === 'VectorVisit');
    expect(fichas.reduce((s, f) => s + (f.summary.visitas ?? 0), 0)).toBe(N);
    expect(fichas.every((f) => f.status === 'GERADA')).toBe(true);
    expect(await db.esusRecordItem.count({ where: { sourceType: 'VectorVisit', record: { batchId: res.body.id } } })).toBe(N);
    // De novo no mesmo período: tudo já exportado (o filtro também consulta em lotes).
    const de = await gerar(vig.id, D(9)).expect(422);
    expect(de.body.message).toMatch(/já foram exportados/);
    // Lote excluído (não há rota; só direto no banco): as fichas e o registro do que foi exportado saem juntos.
    await db.esusBatch.delete({ where: { id: res.body.id } });
    expect(await db.esusRecordItem.count({ where: { sourceType: 'VectorVisit', record: { batchId: res.body.id } } })).toBe(0);
    expect(await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM esus_record_items i JOIN vector_visits v ON v.id = i.source_id WHERE v.visited_at = $1::timestamp`, new Date(dia))).toEqual([{ n: 0 }]);
  });
});
