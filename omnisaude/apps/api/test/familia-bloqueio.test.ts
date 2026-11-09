import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, cnsFromBase, completeCpf, localDateString, metrosPorGrau, normalizarArea, type Posicao } from '@omnisaude/shared';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/core/audit.service';
import { TenantsService } from '../src/core/database';
import { TerritorioService } from '../src/modules/territorio/territorio.service';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * A mudança de família (incluir ou tirar a pessoa, pela recepção ou pela sincronização do ACS) refaz na hora o caso da
 * pessoa na ordem de bloqueio, sem esperar a varredura de 5 minutos. Cada cenário usa uma grade própria de 5 x 5
 * quarteirões de 80 m, a 5 km das outras, para os casos de um não agruparem com os de outro.
 */
const enabled = await pgAvailable();

const DIA = 86_400_000;
const GRADES = ['inc', 'acs', 'nova', 'falha', 'unif', 'unif2', 'cadeia', 'relida', 'relida2'];

describe.runIf(enabled)('VIG-3a: a mudança de família refaz na hora o caso da pessoa na ordem de bloqueio', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let territorio: TerritorioService;
  let recepcao = '';
  let medica = '';
  let acs = '';
  let coordenador = '';
  let tz = 'America/Sao_Paulo';
  let tenantDb = '';
  let localidade = '';
  let numeroQuarteirao = 0;
  let seq = 0;
  const origem: Record<string, Posicao> = {};
  const blocos: Record<string, string[]> = {};
  const pessoa: Record<string, { id: string; dados: Record<string, unknown> }> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const dia = (n: number) => localDateString(new Date(Date.now() + n * DIA), tz);
  const ponto = (g: string, x: number, y: number): Posicao => {
    const O = origem[g]!;
    const m = metrosPorGrau(O[1]);
    return [O[0] + x / m.lng, O[1] + y / m.lat];
  };
  const bloco = (g: string, col: number, lin: number) => blocos[g]![lin * 5 + col]!;

  async function criarGrade(g: string) {
    blocos[g] = [];
    for (let lin = 0; lin < 5; lin++)
      for (let col = 0; col < 5; col++) {
        const c = ponto(g, col * 100, lin * 100);
        const m = metrosPorGrau(c[1]);
        const a: Posicao = [c[0] - 40 / m.lng, c[1] - 40 / m.lat];
        const b: Posicao = [c[0] + 40 / m.lng, c[1] + 40 / m.lat];
        const area = normalizarArea({ type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] });
        const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
        const [centerLng, centerLat] = centroDe(area);
        numeroQuarteirao++;
        blocos[g]!.push(
          (
            await db.block.create({
              data: { localityId: localidade, number: String(numeroQuarteirao), geometry: area as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng, areaM2: areaM2(area), source: 'EDITOR' },
            })
          ).id,
        );
      }
  }

  async function novoPaciente(chave: string, extra: Record<string, unknown> = {}) {
    seq++;
    const dados = {
      name: `Pessoa Familia ${chave.toUpperCase()} ${['Andrade', 'Barbosa', 'Cardoso', 'Duarte', 'Esteves', 'Ferraz', 'Gomes', 'Holanda'][seq % 8]} ${'abcdefghij'[seq % 10]}son`,
      birthDate: `${1960 + seq}-0${(seq % 9) + 1}-1${seq % 9}`,
      sex: seq % 2 ? 'F' : 'M',
      cpf: completeCpf(String(496000000 + seq)),
      cns: cnsFromBase(String(29600000000 + seq)),
      motherName: `Mae Familia ${chave}`,
      ...extra,
    };
    const id = (await t.http().post('/api/patients').set(auth(recepcao)).send(dados).expect(201)).body.id as string;
    pessoa[chave] = { id, dados };
    return id;
  }

  /** Domicílio com posição (GPS do cadastro) e a família com o responsável; devolve o imóvel e a família. */
  async function novaCasa(onde: Posicao, responsavel: string) {
    const r = await t
      .http()
      .post('/api/households')
      .set(auth(recepcao))
      .send({ street: 'Rua da Familia', number: String(2000 + seq), latitude: onde[1], longitude: onde[0], family: { responsibleId: responsavel } })
      .expect(201);
    return { casa: r.body.id as string, familia: r.body.families[0].id as string };
  }

  async function notificar(patientId: string) {
    const r = await t
      .http()
      .post('/api/vigilancia/notificacoes')
      .set(auth(medica))
      .send({ patientId, conditionKey: 'dengue', symptomsOnset: dia(-1) });
    if (r.status !== 201) throw new Error(`notificar: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  }

  const ligacao = (notificationId: string) => db.blockingOrderCase.findUniqueOrThrow({ where: { notificationId } });
  const ordemDoCaso = async (notificationId: string) => db.blockingOrder.findUniqueOrThrow({ where: { id: (await ligacao(notificationId)).orderId }, include: { blocks: true } });
  const varredura = () => t.http().post('/api/endemias/bloqueios/varredura').set(auth(coordenador)).expect(200);
  const naoPassou = (r: { status: number; body: unknown }) => {
    if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  };

  /** Pessoa sem domicílio com caso de dengue: a ordem aguarda a localização. */
  async function casoSemDomicilio(chave: string, extra: Record<string, unknown> = {}) {
    await novoPaciente(chave, extra);
    const n = await notificar(pessoa[chave]!.id);
    expect((await ordemDoCaso(n)).status).toBe('AGUARDANDO_LOCALIZACAO');
    return n;
  }

  beforeAll(async () => {
    t = await startTestApp('familiabloq');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    acs = await t.login('acs', 'UBS Centro', 'ACS');
    coordenador = await t.login('coordenador', 'Vigilância em Saúde', 'COORDENADOR_ENDEMIAS');
    const gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    const tenants = t.app.get(TenantsService);
    const info = await tenants.resolve(t.slug);
    tz = info.timeZone;
    tenantDb = info.db.name;
    db = await tenants.client(info.id);
    territorio = t.app.get(TerritorioService);
    localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '51', name: 'Familia e Bloqueio' }).expect(201)).body.id;
    GRADES.forEach((g, i) => (origem[g] = [-46.9 + i * 0.05, -13.4]));
    for (const g of GRADES) await criarGrade(g);
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await t?.close();
  });

  it('a recepção inclui na família de um imóvel posicionado: a ordem abre na hora, com o quarteirão; tirada da família, volta a aguardar', async () => {
    await novoPaciente('ra');
    const { casa, familia } = await novaCasa(ponto('inc', 200, 200), pessoa.ra!.id);
    const n = await casoSemDomicilio('pa');
    await t.http().post(`/api/families/${familia}/members`).set(auth(recepcao)).send({ patientId: pessoa.pa!.id, kinship: '03' }).expect(naoPassou);
    // Na hora, sem varredura: antes, a ordem só abria na varredura seguinte (até 5 min).
    const aberta = await ordemDoCaso(n);
    expect(aberta.status).toBe('ABERTA');
    expect(aberta.blocks.map((b) => b.blockId)).toContain(bloco('inc', 2, 2));
    expect(await ligacao(n)).toMatchObject({ householdId: casa, blockId: bloco('inc', 2, 2), active: true });

    // Tirada da família, a pessoa fica sem domicílio: o caso perde a posição na hora, e a varredura não tem o que refazer.
    await t.http().delete(`/api/families/${familia}/members/${pessoa.pa!.id}`).set(auth(recepcao)).expect(naoPassou);
    const depois = await ordemDoCaso(n);
    expect(depois.id).toBe(aberta.id);
    expect(depois.status).toBe('AGUARDANDO_LOCALIZACAO');
    expect(await ligacao(n)).toMatchObject({ householdId: null, blockId: null, lat: null, active: true });
    await varredura();
    expect((await ordemDoCaso(n)).status).toBe('AGUARDANDO_LOCALIZACAO');
  });

  it('a sincronização do ACS inclui duas pessoas na família: as duas ordens abrem na hora, com um aviso só no fim do lote', async () => {
    await novoPaciente('rb');
    const { casa, familia } = await novaCasa(ponto('acs', 200, 200), pessoa.rb!.id);
    const n1 = await casoSemDomicilio('pb1');
    const n2 = await casoSemDomicilio('pb2');
    const aviso = vi.spyOn(territorio, 'imoveisPosicionados');
    const op = (chave: string) => ({
      tipo: 'PESSOA',
      clientId: randomUUID(),
      registradoEm: new Date(Date.now() - 60_000).toISOString(),
      patientId: pessoa[chave]!.id,
      familyId: familia,
      kinship: '03',
      dados: pessoa[chave]!.dados,
    });
    const r = (
      await t
        .http()
        .post('/api/acs/sync')
        .set(auth(acs))
        .send({ operacoes: [op('pb1'), op('pb2')] })
        .expect(200)
    ).body;
    for (const x of r.resultados) expect(x, JSON.stringify(x)).toMatchObject({ status: 'OK' });
    expect((await db.patient.findUniqueOrThrow({ where: { id: pessoa.pb1!.id } })).familyId).toBe(familia);
    // Um aviso só, no fim do lote, com o domicílio (e não um por pessoa incluída).
    expect(aviso).toHaveBeenCalledTimes(1);
    expect([...new Set(aviso.mock.calls[0]![1])]).toEqual([casa]);
    for (const n of [n1, n2]) {
      const o = await ordemDoCaso(n);
      expect(o.status).toBe('ABERTA');
      expect(o.blocks.map((b) => b.blockId)).toContain(bloco('acs', 2, 2));
    }
  });

  it('a família nova de um imóvel posicionado, com a pessoa do caso como responsável, abre a ordem na hora', async () => {
    await novoPaciente('rc');
    const { casa } = await novaCasa(ponto('nova', 200, 200), pessoa.rc!.id);
    const n = await casoSemDomicilio('pc');
    await t.http().post(`/api/households/${casa}/families`).set(auth(recepcao)).send({ responsibleId: pessoa.pc!.id }).expect(naoPassou);
    const o = await ordemDoCaso(n);
    expect(o.status).toBe('ABERTA');
    expect(o.blocks.map((b) => b.blockId)).toContain(bloco('nova', 2, 2));
  });

  it('a falha do aviso não derruba a inclusão na família; a varredura abre a ordem depois', async () => {
    await novoPaciente('rd');
    const { familia } = await novaCasa(ponto('falha', 200, 200), pessoa.rd!.id);
    const n = await casoSemDomicilio('pd');
    vi.spyOn(territorio, 'imoveisPosicionados').mockRejectedValueOnce(new Error('falha simulada do ouvinte'));
    await t.http().post(`/api/families/${familia}/members`).set(auth(recepcao)).send({ patientId: pessoa.pd!.id, kinship: '03' }).expect(naoPassou);
    expect((await db.patient.findUniqueOrThrow({ where: { id: pessoa.pd!.id } })).familyId).toBe(familia);
    expect((await ordemDoCaso(n)).status).toBe('AGUARDANDO_LOCALIZACAO');
    await varredura();
    expect((await ordemDoCaso(n)).status).toBe('ABERTA');
  });
  it('a unificação de cadastros põe o caso do duplicado no domicílio do cadastro que fica: a ordem abre na hora', async () => {
    // O cadastro que fica mora num imóvel posicionado; o duplicado, sem domicílio, tem o caso de dengue.
    await novoPaciente('uf');
    const { casa } = await novaCasa(ponto('unif', 200, 200), pessoa.uf!.id);
    const n = await casoSemDomicilio('ud');
    await t.http().post(`/api/patients/${pessoa.uf!.id}/merge`).set(auth(recepcao)).send({ duplicateId: pessoa.ud!.id }).expect(naoPassou);
    // Na hora, sem varredura: antes, a ordem só abria na varredura seguinte (até 5 min).
    const aberta = await ordemDoCaso(n);
    expect(aberta.status).toBe('ABERTA');
    expect(aberta.blocks.map((b) => b.blockId)).toContain(bloco('unif', 2, 2));
    expect(await ligacao(n)).toMatchObject({ householdId: casa, blockId: bloco('unif', 2, 2), active: true });
  });
  it('o cadastro que fica, sem família, herda a do duplicado: o caso dele também abre a ordem na hora', async () => {
    // Agora o caso é do que fica, sem domicílio; o duplicado é o responsável de uma família num imóvel posicionado.
    const n = await casoSemDomicilio('uf2');
    await novoPaciente('ud2');
    const { casa, familia } = await novaCasa(ponto('unif2', 200, 200), pessoa.ud2!.id);
    await t.http().post(`/api/patients/${pessoa.uf2!.id}/merge`).set(auth(recepcao)).send({ duplicateId: pessoa.ud2!.id }).expect(naoPassou);
    expect(await db.patient.findUniqueOrThrow({ where: { id: pessoa.uf2!.id } })).toMatchObject({ familyId: familia, kinship: '00' });
    const aberta = await ordemDoCaso(n);
    expect(aberta.status).toBe('ABERTA');
    expect(aberta.blocks.map((b) => b.blockId)).toContain(bloco('unif2', 2, 2));
    expect(await ligacao(n)).toMatchObject({ householdId: casa, blockId: bloco('unif2', 2, 2), active: true });
  });
  it('cadeia de unificações (x em d, depois d em s): x passa a apontar para s, e o caso de x abre a ordem na hora no domicílio de s', async () => {
    // x, sem domicílio, tem o caso de dengue; d, também sem domicílio, fica com x.
    const n = await casoSemDomicilio('cx');
    await novoPaciente('cd');
    await t.http().post(`/api/patients/${pessoa.cd!.id}/merge`).set(auth(recepcao)).send({ duplicateId: pessoa.cx!.id }).expect(naoPassou);
    expect((await ordemDoCaso(n)).status).toBe('AGUARDANDO_LOCALIZACAO');
    // s mora num imóvel posicionado e fica com d.
    await novoPaciente('cs');
    const { casa } = await novaCasa(ponto('cadeia', 200, 200), pessoa.cs!.id);
    const r = await t.http().post(`/api/patients/${pessoa.cs!.id}/merge`).set(auth(recepcao)).send({ duplicateId: pessoa.cd!.id });
    naoPassou(r);
    // Na hora, sem varredura: antes, x continuava unificado em d (sem família) e os joins do bloqueio, de um salto só, não
    // chegavam ao domicílio de s; a ordem ficava aguardando a localização.
    const aberta = await ordemDoCaso(n);
    expect(aberta.status).toBe('ABERTA');
    expect(aberta.blocks.map((b) => b.blockId)).toContain(bloco('cadeia', 2, 2));
    expect(await ligacao(n)).toMatchObject({ householdId: casa, blockId: bloco('cadeia', 2, 2), active: true });
    // Um salto só: x aponta direto para s, e o cadastro de x redireciona para s (antes, para d, já unificado).
    expect(await db.patient.findUniqueOrThrow({ where: { id: pessoa.cx!.id } })).toMatchObject({ mergedIntoId: pessoa.cs!.id });
    expect((await t.http().get(`/api/patients/${pessoa.cx!.id}`).set(auth(recepcao)).expect(200)).body).toMatchObject({ id: pessoa.cs!.id, redirectedFromId: pessoa.cx!.id });
    expect(r.body.moved).toMatchObject({ mergedPatients: 1 });
  });
  it('duas unificações simultâneas em sentido contrário não deixam ciclo: uma passa, a outra recebe 409', async () => {
    const a = await novoPaciente('sa');
    const b = await novoPaciente('sb');
    // A primeira unificação (b em a) para na auditoria, dentro da transação, com os dois cadastros já gravados; a segunda
    // (a em b) leu os dois cadastros ainda sem unificação e espera a primeira terminar.
    const audit = t.app.get(AuditService);
    const record = audit.record.bind(audit);
    let chegou!: () => void;
    const naAuditoria = new Promise<void>((ok) => (chegou = ok));
    let liberar!: () => void;
    const segura = new Promise<void>((ok) => (liberar = ok));
    let primeira = true;
    vi.spyOn(audit, 'record').mockImplementation(async (ctx, tx, entrada) => {
      if (entrada.action === 'paciente.unificar' && primeira) {
        primeira = false;
        chegou();
        await segura;
      }
      return record(ctx, tx, entrada);
    });
    const unificar = (fica: string, sai: string) =>
      t
        .http()
        .post(`/api/patients/${fica}/merge`)
        .set(auth(recepcao))
        .send({ duplicateId: sai })
        .then((r) => r);
    const ra = unificar(a, b);
    await Promise.race([naAuditoria, ra]);
    const rb = unificar(b, a);
    // A segunda espera a trava da primeira no banco.
    let esperando = false;
    for (let i = 0; i < 60 && !esperando; i++) {
      const [x] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      esperando = x!.n > 0;
      if (!esperando) await new Promise((ok) => setTimeout(ok, 50));
    }
    liberar();
    const [primeiraR, segundaR] = await Promise.all([ra, rb]);
    expect(esperando).toBe(true);
    // Antes: as duas passavam (cada uma com a leitura de antes da outra) e ficava o ciclo a → b → a.
    expect([primeiraR.status, segundaR.status]).toEqual([201, 409]);
    expect(segundaR.body).toMatchObject({ code: 'PACIENTE_UNIFICADO' });
    expect(await db.patient.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ mergedIntoId: null });
    expect(await db.patient.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ mergedIntoId: a });
  });
  it('três unificações simultâneas: a que trava um cadastro já unificado no duplicado e espera o que fica não forma impasse', async () => {
    // x (o menor id dos três) já foi unificado em d. A terceira unificação, por fora, faz como a unificação de verdade:
    // trava x e depois s, na ordem dos ids (ela leu x antes de x ser unificado e vai desistir ao conferir de novo).
    const [x, d, s] = [await novoPaciente('tx'), await novoPaciente('td'), await novoPaciente('ts')].sort();
    await t.http().post(`/api/patients/${d}/merge`).set(auth(recepcao)).send({ duplicateId: x }).expect(naoPassou);
    const c = new Client({ connectionString: TEST_PG.replace(/\/[^/]*$/, `/${tenantDb}`) });
    await c.connect();
    try {
      // No impasse, o banco desfaz a transação que confere primeiro: a de fora só confere depois de 30 s, e a desfeita é a
      // unificação (que não repete).
      await c.query(`SET deadlock_timeout = '30s'`);
      const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await c.query('BEGIN');
      await c.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [x]);
      // d em s: com x travado por fora.
      const unificacao = t
        .http()
        .post(`/api/patients/${s}/merge`)
        .set(auth(recepcao))
        .send({ duplicateId: d })
        .then((r) => r);
      const presos = async () => (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))`)[0]!.n;
      let esperando = false;
      for (let i = 0; i < 100 && !esperando; i++) {
        esperando = (await presos()) > 0;
        if (!esperando) await new Promise((ok) => setTimeout(ok, 30));
      }
      expect(esperando).toBe(true);
      // A terceira pede s. Antes: a unificação já tinha s e d e esperava x (ao repor os unificados em d); a terceira
      // esperava s; o banco desfazia a unificação (40P01) e a resposta era 500. Agora a unificação espera x sem ter s.
      await c.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [s]);
      await c.query('ROLLBACK');
      const r = await unificacao;
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.moved).toMatchObject({ mergedPatients: 1 });
    } finally {
      await c.end();
    }
    for (const id of [x, d]) expect(await db.patient.findUniqueOrThrow({ where: { id } })).toMatchObject({ mergedIntoId: s });
  });
  it('três unificações simultâneas, com o cadastro unificado no duplicado enquanto a unificação espera: a que o banco desfaz é repetida, sem 500', async () => {
    // Ids ordenados: s < y < d. A primeira unificação (y em d), por fora para controlar o tempo, trava y e d e unifica y
    // em d sem confirmar. A segunda (d em s) lê d antes disso: trava s e espera d. A terceira (d em y) leu y antes de y
    // ser unificado: trava y primeiro e espera.
    const [s, y, d] = [await novoPaciente('ws'), await novoPaciente('wy'), await novoPaciente('wd')].sort();
    const c = new Client({ connectionString: TEST_PG.replace(/\/[^/]*$/, `/${tenantDb}`) });
    await c.connect();
    try {
      const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await c.query('BEGIN');
      await c.query('SELECT id FROM patients WHERE id IN ($1, $2) ORDER BY id FOR UPDATE', [y, d]);
      await c.query('UPDATE patients SET merged_into_id = $2, merged_at = now(), cpf = NULL, cns = NULL WHERE id = $1', [y, d]);
      const unificar = (fica: string, sai: string) =>
        t
          .http()
          .post(`/api/patients/${fica}/merge`)
          .set(auth(recepcao))
          .send({ duplicateId: sai })
          .then((r) => r);
      const segunda = unificar(s, d);
      const terceira = unificar(y, d);
      const presos = async () => (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))`)[0]!.n;
      let n = 0;
      for (let i = 0; i < 200 && n < 2; i++) {
        n = await presos();
        if (n < 2) await new Promise((ok) => setTimeout(ok, 30));
      }
      expect(n).toBe(2);
      // A primeira confirma: a terceira fica com y e espera d; a segunda fica com d e, ao repor em s os unificados em d,
      // espera y (unificado depois da leitura da trava dela). Antes: o banco desfazia uma das duas (40P01) e a resposta
      // era 500. Agora a desfeita é repetida: a segunda passa, e a terceira recebe 404 ou 409 (y já foi unificado).
      await c.query('COMMIT');
      const [r2, r3] = await Promise.all([segunda, terceira]);
      expect(r2.status, JSON.stringify(r2.body)).toBe(201);
      expect([404, 409], JSON.stringify(r3.body)).toContain(r3.status);
    } finally {
      await c.end();
    }
    for (const id of [y, d]) expect(await db.patient.findUniqueOrThrow({ where: { id } })).toMatchObject({ mergedIntoId: s });
    expect(await db.patient.findUniqueOrThrow({ where: { id: s } })).toMatchObject({ mergedIntoId: null });
  });
  it('duas unificações no mesmo cadastro que fica, a segunda esperando a primeira: a segunda combina com o cadastro já completado', async () => {
    // s, sem CPF, CNS, raça/cor e família. d1 traz CPF, CNS, raça/cor, WhatsApp, CADSUS e a família de um imóvel
    // posicionado. d2, sem domicílio, traz outro CPF, outro CNS, outra raça/cor e o caso de dengue.
    const s = await novoPaciente('rs', { cpf: null, cns: null });
    const d1 = await novoPaciente('r1', { racaCor: '01', whatsappOptIn: true, cadsusValidated: true });
    const { casa, familia } = await novaCasa(ponto('relida', 200, 200), d1);
    const n = await casoSemDomicilio('r2', { racaCor: '03' });
    const d2 = pessoa.r2!.id;
    const aviso = vi.spyOn(territorio, 'imoveisPosicionados');
    const unificar = (sai: string) =>
      t
        .http()
        .post(`/api/patients/${s}/merge`)
        .set(auth(recepcao))
        .send({ duplicateId: sai })
        .then((r) => r);
    const esperando = async (quantas: number) => {
      for (let i = 0; i < 200; i++) {
        const [x] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (x!.n >= quantas) return true;
        await new Promise((ok) => setTimeout(ok, 30));
      }
      return false;
    };
    const c = new Client({ connectionString: TEST_PG.replace(/\/[^/]*$/, `/${tenantDb}`) });
    await c.connect();
    try {
      // Uma transação por fora segura s. As duas unificações leem s sem nada e esperam a trava: d1 chega primeiro e passa
      // primeiro, e d2 só passa depois do commit da de d1.
      await c.query('BEGIN');
      await c.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [s]);
      const primeira = unificar(d1);
      expect(await esperando(1)).toBe(true);
      const segunda = unificar(d2);
      expect(await esperando(2)).toBe(true);
      await c.query('COMMIT');
      const [r1, r2] = await Promise.all([primeira, segunda]);
      expect(r1.status, JSON.stringify(r1.body)).toBe(201);
      expect(r2.status, JSON.stringify(r2.body)).toBe(201);
      expect(r1.body.filled).toEqual(expect.arrayContaining(['cpf', 'cns', 'racaCor']));
      // Antes: a segunda completava s com a leitura de antes da trava (s sem nada). O CPF e o CNS de d1 sumiam (os de d2
      // ficavam no lugar), a raça/cor virava a de d2, e s perdia o WhatsApp, o CADSUS e a família que tinha acabado de ganhar.
      for (const f of ['cpf', 'cns', 'racaCor']) expect(r2.body.filled).not.toContain(f);
    } finally {
      await c.end();
    }
    const fica = await db.patient.findUniqueOrThrow({ where: { id: s } });
    expect(fica).toMatchObject({ cpf: pessoa.r1!.dados.cpf, cns: pessoa.r1!.dados.cns, racaCor: '01', whatsappOptIn: true, familyId: familia, kinship: '00', mergedIntoId: null });
    expect(fica.cadsusSyncedAt).not.toBeNull();
    // O CPF e o CNS de d2 são descartados, como numa unificação depois da outra.
    for (const id of [d1, d2]) expect(await db.patient.findUniqueOrThrow({ where: { id } })).toMatchObject({ mergedIntoId: s, cpf: null, cns: null });
    // O aviso da segunda leva o domicílio da família que s ganhou na primeira: o caso de d2 abre a ordem na hora.
    expect(aviso.mock.calls.filter(([, ids]) => ids.includes(casa))).toHaveLength(2);
    const aberta = await ordemDoCaso(n);
    expect(aberta.status).toBe('ABERTA');
    expect(aberta.blocks.map((b) => b.blockId)).toContain(bloco('relida', 2, 2));
    expect(await ligacao(n)).toMatchObject({ householdId: casa, blockId: bloco('relida', 2, 2), active: true });
  });
  it('o duplicado entra numa família enquanto a unificação espera a trava: o que fica combina com o duplicado relido', async () => {
    // s, sem domicílio, tem o caso de dengue; d, também sem domicílio, entra na família de um imóvel posicionado depois
    // da leitura de antes da trava (uma transação por fora segura os dois e grava a família de d).
    const n = await casoSemDomicilio('rs2');
    const s = pessoa.rs2!.id;
    const d = await novoPaciente('rd2');
    const { casa, familia } = await novaCasa(ponto('relida2', 200, 200), await novoPaciente('rr2'));
    const aviso = vi.spyOn(territorio, 'imoveisPosicionados');
    const c = new Client({ connectionString: TEST_PG.replace(/\/[^/]*$/, `/${tenantDb}`) });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM patients WHERE id IN ($1, $2) ORDER BY id FOR UPDATE', [s, d]);
      const unificacao = t
        .http()
        .post(`/api/patients/${s}/merge`)
        .set(auth(recepcao))
        .send({ duplicateId: d })
        .then((r) => r);
      let esperando = false;
      for (let i = 0; i < 200 && !esperando; i++) {
        const [x] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        esperando = x!.n > 0;
        if (!esperando) await new Promise((ok) => setTimeout(ok, 30));
      }
      expect(esperando).toBe(true);
      await c.query(`UPDATE patients SET family_id = $2, kinship = '03' WHERE id = $1`, [d, familia]);
      await c.query('COMMIT');
      const r = await unificacao;
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    } finally {
      await c.end();
    }
    // Antes: a unificação combinava com d lido antes da trava (sem família). s ficava sem família, d saía da dele, e o caso
    // de s seguia aguardando a localização.
    expect(await db.patient.findUniqueOrThrow({ where: { id: s } })).toMatchObject({ familyId: familia, kinship: '03', mergedIntoId: null });
    expect(await db.patient.findUniqueOrThrow({ where: { id: d } })).toMatchObject({ familyId: null, mergedIntoId: s });
    expect(aviso.mock.calls.filter(([, ids]) => ids.includes(casa))).toHaveLength(1);
    const aberta = await ordemDoCaso(n);
    expect(aberta.status).toBe('ABERTA');
    expect(aberta.blocks.map((b) => b.blockId)).toContain(bloco('relida2', 2, 2));
    expect(await ligacao(n)).toMatchObject({ householdId: casa, blockId: bloco('relida2', 2, 2), active: true });
  });
});
