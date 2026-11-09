import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, cnsFromBase, completeCpf, localDateString, metrosPorGrau, normalizarArea, type Posicao } from '@omnisaude/shared';
import { Client } from 'pg';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { RealtimeService } from '../src/core/realtime.service';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * Ordem de bloqueio (VIG-3a): regressões dos achados da revisão da semana 26. Cada cenário usa uma grade própria de
 * 5 x 5 quarteirões de 80 m (ruas de 20 m), a 5 km das outras, para os casos de um não agruparem com os de outro.
 */
const enabled = await pgAvailable();

const DIA = 86_400_000;
const NOMES = ['Alice', 'Bernardo', 'Cecilia', 'Davi', 'Elisa', 'Fabio', 'Gabriela', 'Heitor', 'Iara', 'Joaquim', 'Laura', 'Murilo'];
const SOBRENOMES = ['Andrade', 'Barbosa', 'Cardoso', 'Duarte', 'Esteves', 'Ferraz'];
const GRADES = [
  'v9',
  'r4a',
  'r4b',
  'r4c',
  'u1a',
  'u1b',
  'u1c',
  'u1d',
  'r2a',
  'r2b',
  'u3',
  'cad',
  'cadc',
  'ini',
  'id7a',
  'id7b',
  'id7bn',
  'gps8',
  'prog',
  'des',
  'seg1',
  'seg3',
  'lat11',
  'ws7',
  'var5',
  'var5b',
  'cadv',
  'sim',
  'dat',
  'datc',
  'datv',
  'acs8',
  'acs8b',
  'acs8c',
  'dom8',
  'dom8n',
  'datd',
  'id7c',
  'rcamp',
  'ucamp',
  'ucamp2',
  'tcan',
  'tcon',
  'treab',
  'tvreab',
  'tvcon',
  'tvcan',
  'pdant',
  'pdinf',
  'pddia',
  'tvuni',
];
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const letras = (n: number) => {
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return s[0]!.toUpperCase() + s.slice(1) + 'son';
};

describe.runIf(enabled)('VIG-3a: ordem de bloqueio (correções da revisão)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let tenantDb = '';
  let tenantId = '';
  let tz = 'America/Sao_Paulo';
  let recepcao = '';
  let medica = '';
  let vig = '';
  let gestora = '';
  let ace = '';
  let supervisora = '';
  let coordenador = '';
  let acs = '';
  let aceId = '';
  let supId = '';
  let ace2Id = '';
  const casa: Record<string, string> = {};
  const familia: Record<string, string> = {};
  const paciente: Record<string, string> = {};
  const notificacao: Record<string, string> = {};
  const origem: Record<string, Posicao> = {};
  const blocos: Record<string, string[]> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  let seq = 0;

  const dia = (n: number) => localDateString(new Date(Date.now() + n * DIA), tz);
  const ponto = (g: string, x: number, y: number): Posicao => {
    const O = origem[g]!;
    const m = metrosPorGrau(O[1]);
    return [O[0] + x / m.lng, O[1] + y / m.lat];
  };
  const bloco = (g: string, col: number, lin: number) => blocos[g]![lin * 5 + col]!;
  const pgc = async () => {
    const c = new Client({ connectionString: TEST_PG.replace(/\/[^/]*$/, `/${tenantDb}`) });
    await c.connect();
    return c;
  };
  const consultar = async <T>(sql: string, params: unknown[] = []) => {
    const c = await pgc();
    try {
      return (await c.query(sql, params)).rows as T[];
    } finally {
      await c.end();
    }
  };
  /** Consultas deste banco paradas esperando uma trava na tabela (ou, com `fora`, em qualquer outra coisa). */
  const esperas = async (tabela: string, fora = false) =>
    (
      await consultar<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE NOT l.granted AND a.datname = current_database() AND ${fora ? '(l.relation IS NULL OR l.relation <> $1::regclass)' : 'l.relation = $1::regclass'}`,
        [tabela],
      )
    )[0]!.n;
  const esperar = async (cond: () => Promise<boolean> | boolean, ms = 8000) => {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      if (await cond()) return true;
      await espera(40);
    }
    return false;
  };

  async function novoPaciente(chave: string) {
    seq++;
    paciente[chave] = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({
          name: `Pessoa ${NOMES[seq % NOMES.length]} ${SOBRENOMES[Math.floor(seq / NOMES.length) % SOBRENOMES.length]} ${letras(seq + 300)}`,
          birthDate: `${1950 + (seq % 40)}-0${(seq % 9) + 1}-1${seq % 9}`,
          sex: seq % 2 ? 'F' : 'M',
          cpf: completeCpf(String(495000000 + seq)),
          cns: cnsFromBase(String(29500000000 + seq)),
          motherName: `Mae ${chave}`,
          phone: '(63) 97777-0000',
          address: { cep: '01001000', street: 'Rua do Caso', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
        })
        .expect(201)
    ).body.id;
    return paciente[chave]!;
  }

  async function novaCasa(chave: string, onde: Posicao | null, responsavel: string) {
    const r = await t
      .http()
      .post('/api/households')
      .set(auth(recepcao))
      .send({ street: 'Rua do Caso', number: String(1000 + seq), ...(onde ? { latitude: onde[1], longitude: onde[0] } : {}), family: { responsibleId: responsavel } })
      .expect(201);
    casa[chave] = r.body.id;
    familia[chave] = r.body.families[0].id;
    return r.body.id as string;
  }

  async function notificar(chave: string, patientId: string, conditionKey = 'dengue', symptomsOnset?: string) {
    const r = await t
      .http()
      .post('/api/vigilancia/notificacoes')
      .set(auth(medica))
      .send({ patientId, conditionKey, ...(symptomsOnset ? { symptomsOnset } : {}) });
    if (r.status !== 201) throw new Error(`notificar ${chave}: ${r.status} ${JSON.stringify(r.body)}`);
    notificacao[chave] = r.body.id;
    return r.body.id as string;
  }

  async function caso(chave: string, onde: Posicao | null, conditionKey = 'dengue', symptomsOnset?: string) {
    await novoPaciente(chave);
    await novaCasa(chave, onde, paciente[chave]!);
    return notificar(chave, paciente[chave]!, conditionKey, symptomsOnset);
  }

  const membro = (familyId: string, patientId: string) =>
    t
      .http()
      .post(`/api/families/${familyId}/members`)
      .set(auth(recepcao))
      .send({ patientId, kinship: '03' })
      .expect((r) => {
        if (r.status >= 300) throw new Error(`membro ${r.status} ${JSON.stringify(r.body)}`);
      });
  const ligacao = (chave: string) => db.blockingOrderCase.findUnique({ where: { notificationId: notificacao[chave]! } });
  const ordemDe = async (chave: string) => (await ligacao(chave))!.orderId;
  const ordem = (id: string) => db.blockingOrder.findUniqueOrThrow({ where: { id }, include: { blocks: true, assignees: true, cases: true } });
  const varredura = async () => (await t.http().post('/api/endemias/bloqueios/varredura').set(auth(coordenador)).expect(200)).body as { avaliadas: number; erros: number };
  const config = (body: Record<string, unknown>) => t.http().put('/api/endemias/configuracao').set(auth(coordenador)).send(body).expect(200);
  const posicionar = (householdId: string, onde: Posicao) => t.http().post(`/api/territorio/imoveis/${householdId}/posicao`).set(auth(vig)).send({ lat: onde[1], lng: onde[0], origem: 'MAPA' }).expect(200);
  // A hora do aparelho é a do envio: as ordens dos testes acabam de ser abertas, e a visita de antes da abertura ganha o
  // aviso do relógio atrasado.
  const visitar = async (householdId: string, ordemId: string | null, extra: Record<string, unknown> = {}, registradoEm = new Date().toISOString()) => {
    const op = {
      clientId: randomUUID(),
      tipo: 'VISITA_VETORIAL',
      registradoEm,
      householdId,
      visita: { atividade: 'BLOQUEIO', situacao: 'TRABALHADO', ...(ordemId ? { ordemId } : {}), depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } }, acaoEducativa: true, ...extra },
    };
    const r = (
      await t
        .http()
        .post('/api/endemias/campo/sync')
        .set(auth(ace))
        .send({ operacoes: [op] })
        .expect(200)
    ).body;
    return r.resultados[0] as { status: string; id: string; avisos?: string[]; erro?: string };
  };
  const ativas = (o: { cases: { active: boolean }[] }) => o.cases.filter((c) => c.active).length;

  let localidade = '';
  let numeroQuarteirao = 0;
  /** Grade de 5 x 5 quarteirões de 80 m (ruas de 20 m) a partir da origem da grade. */
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

  beforeAll(async () => {
    t = await startTestApp('endbloqueio');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    coordenador = await t.login('coordenador', 'Vigilância em Saúde', 'COORDENADOR_ENDEMIAS');
    acs = await t.login('acs', 'UBS Centro', 'ACS');
    const tenants = t.app.get(TenantsService);
    const info = await tenants.resolve(t.slug);
    tenantId = info.id;
    tz = info.timeZone;
    tenantDb = info.db.name;
    db = await tenants.client(info.id);
    localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '6', name: 'Bloqueio Correcoes' }).expect(201)).body.id;
    GRADES.forEach((g, i) => (origem[g] = [-47.3 + i * 0.05, -12.9]));
    for (const g of GRADES) await criarGrade(g);
    aceId = (await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000016') } })).id;
    supId = (await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000017') } })).id;
    const vigUnit = await db.unit.findFirstOrThrow({ where: { name: 'Vigilância em Saúde' } });
    ace2Id = (await db.user.create({ data: { cpf: completeCpf('495999001'), name: 'Agente Dois de Endemias', passwordHash: 'sem-login' } })).id;
    await db.userAssignment.create({ data: { userId: ace2Id, unitId: vigUnit.id, role: 'ACE', cbo: '515140' } });
    await t
      .http()
      .post('/api/endemias/zonas')
      .set(auth(supervisora))
      .send({ nome: 'Zona Bloqueio', aceId, quarteiroes: GRADES.filter((g) => g !== 'des').flatMap((g) => blocos[g]!) })
      .expect(201);
    await t.http().post('/api/endemias/zonas').set(auth(supervisora)).send({ nome: 'Zona Dois', aceId: ace2Id, quarteiroes: blocos.des }).expect(201);
  }, 240_000);

  afterAll(async () => {
    await t?.close();
  });

  // ─── bloqueio#9 ─────────────────────────────────────────────────────────────
  it('bloqueio#9: a decisão relê a notificação dentro da trava; o descarte que entra no meio não vira ordem nova', async () => {
    await caso('w1', ponto('v9', 200, 200), 'dengue', dia(-1));
    const ow = await ordemDe('w1');
    expect((await ordem(ow)).status).toBe('ABERTA');
    // O imóvel do caso fica a 150 m do retrato da ficha: o próximo cálculo vê um retrato novo (sem o imóvel).
    const longe = ponto('v9', 200, 350);
    await db.household.update({ where: { id: casa.w1! }, data: { latitude: longe[1], longitude: longe[0], geoAt: new Date() } });
    const antes = await db.blockingOrder.count();
    const c = await pgc();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE families IN ACCESS EXCLUSIVE MODE');
      // O recálculo pela supervisão lê a notificação (ainda elegível) e para na residência do caso.
      const recalculo = t
        .http()
        .post(`/api/endemias/bloqueios/${ow}/recalcular`)
        .set(auth(supervisora))
        .then((r) => r);
      expect(await esperar(async () => (await esperas('families')) > 0)).toBe(true);
      // Nesse intervalo, a vigilância descarta: o ouvinte desliga o caso e cancela a ordem.
      const descarte = t
        .http()
        .post(`/api/vigilancia/notificacoes/${notificacao.w1}/descartar`)
        .set(auth(vig))
        .send({ reason: 'Descartado após investigação clínica' })
        .then((r) => r);
      expect(await esperar(async () => (await ligacao('w1'))?.active === false)).toBe(true);
      await c.query('COMMIT');
      expect((await recalculo).status).toBe(200);
      expect((await descarte).status).toBe(200);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await ligacao('w1')).toMatchObject({ active: false, orderId: ow });
    expect((await ordem(ow)).status).toBe('CANCELADA');
    expect(await db.blockingOrder.count()).toBe(antes);
  });

  // ─── bloqueio#4 ─────────────────────────────────────────────────────────────
  /** Recálculo parado no meio (a tabela dos agentes travada por fora) enquanto a ação muda a situação da ordem. */
  async function corrida(chave: string, g: string, acao: (orderId: string) => Promise<unknown>) {
    await caso(chave, ponto(g, 200, 200), 'dengue', dia(-1));
    const o = await ordemDe(chave);
    expect((await ordem(o)).status).toBe('ABERTA');
    const c = await pgc();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE blocking_order_assignees IN ACCESS EXCLUSIVE MODE');
      const edicao = t
        .http()
        .patch(`/api/vigilancia/notificacoes/${notificacao[chave]}`)
        .set(auth(vig))
        .send({ symptomsOnset: dia(-2) })
        .then((r) => r);
      expect(await esperar(async () => (await esperas('blocking_order_assignees')) > 0)).toBe(true);
      let terminou = false;
      // O supertest devolve um "thenable" sem finally: vira promessa de verdade.
      const feita = Promise.resolve(acao(o)).finally(() => (terminou = true));
      // Sem a trava da linha a ação termina no meio do recálculo; com ela, espera o recálculo acabar.
      await esperar(async () => terminou || (await esperas('blocking_order_assignees', true)) > 0, 5000);
      await c.query('COMMIT');
      expect((await edicao).status).toBe(200);
      await feita;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    return { o, fim: await ordem(o) };
  }

  it('bloqueio#4: a primeira visita que chega durante o recálculo deixa a ordem em campo', async () => {
    const { o, fim } = await corrida('u4a', 'r4a', async (id) => expect((await visitar(casa.u4a!, id)).status).toBe('OK'));
    expect(fim.status).toBe('EM_CAMPO');
    expect(fim.startedAt).not.toBeNull();
    expect(await db.vectorVisit.count({ where: { orderId: o } })).toBe(1);
  });

  it('bloqueio#4: a conclusão durante o recálculo não é desfeita', async () => {
    const { fim } = await corrida('u4b', 'r4b', (id) => t.http().post(`/api/endemias/bloqueios/${id}/concluir`).set(auth(supervisora)).send({ nota: 'Concluída pela supervisão nesta data' }).expect(200));
    expect(fim.status).toBe('CONCLUIDA');
    expect(fim.concludedAt).not.toBeNull();
  });

  it('bloqueio#4: o cancelamento durante o recálculo não é desfeito, e a ordem não volta ao pacote do ACE', async () => {
    const { o, fim } = await corrida('u4c', 'r4c', (id) => t.http().post(`/api/endemias/bloqueios/${id}/cancelar`).set(auth(coordenador)).send({ motivo: 'Epidemia: a ação passa a ser por área' }).expect(200));
    expect(fim.status).toBe('CANCELADA');
    const pacote = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    expect(pacote.ordens.map((x: { id: string }) => x.id)).not.toContain(o);
  });

  // ─── bloqueio#4, terceira rodada: conclusão, reabertura e cancelamento travam a linha da ordem ─────
  /**
   * A ação parada no meio, depois de gravar a situação e antes do COMMIT (a trilha de auditoria travada por fora),
   * enquanto a visita do ACE chega. Sem a trava da linha, a visita lia a situação de antes e entrava na ordem sem aviso
   * (a visita só parava depois, ao gravar o início do campo); com ela, espera a ação terminar e vê a situação final.
   */
  async function visitaNoMeio(acao: () => PromiseLike<unknown>, visita: () => ReturnType<typeof visitar>) {
    const c = await pgc();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE audit_entries IN ACCESS EXCLUSIVE MODE');
      // O supertest devolve um "thenable" sem finally: vira promessa de verdade.
      const feita = Promise.resolve(acao());
      expect(await esperar(async () => (await esperas('audit_entries')) > 0)).toBe(true);
      let terminou = false;
      const enviada = visita().finally(() => (terminou = true));
      await esperar(async () => terminou || (await esperas('audit_entries', true)) > 0, 5000);
      await c.query('COMMIT');
      await feita;
      return await enviada;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  it('bloqueio#4: a visita que chega no meio do cancelamento espera e fica sem a ordem cancelada, com o aviso', async () => {
    await caso('tc1', ponto('tcan', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('tc1');
    expect((await ordem(o)).status).toBe('ABERTA');
    const r = await visitaNoMeio(
      () => t.http().post(`/api/endemias/bloqueios/${o}/cancelar`).set(auth(coordenador)).send({ motivo: 'Epidemia: a ação passa a ser por área' }).expect(200),
      () => visitar(casa.tc1!, o),
    );
    const fim = await ordem(o);
    expect(fim).toMatchObject({ status: 'CANCELADA', startedAt: null });
    expect(r).toMatchObject({ status: 'OK', avisos: [`A ordem ${fim.seq}/${fim.year} foi cancelada: visita gravada sem a ordem`] });
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { id: r.id } })).orderId).toBeNull();
    expect(await db.vectorVisit.count({ where: { orderId: o } })).toBe(0);
  });

  it('bloqueio#4: a visita de bloqueio sem ordem informada que chega no meio da conclusão não entra na ordem concluída', async () => {
    await caso('tk1', ponto('tcon', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('tk1');
    expect((await db.household.findUniqueOrThrow({ where: { id: casa.tk1! } })).blockId).toBe(bloco('tcon', 2, 2));
    const r = await visitaNoMeio(
      () => t.http().post(`/api/endemias/bloqueios/${o}/concluir`).set(auth(supervisora)).send({ nota: 'Concluída pela supervisão nesta data' }).expect(200),
      () => visitar(casa.tk1!, null),
    );
    expect(r).toMatchObject({ status: 'OK', avisos: ['Nenhuma ordem de bloqueio ativa neste quarteirão: visita gravada como bloqueio sem ordem'] });
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { id: r.id } })).orderId).toBeNull();
    expect(await ordem(o)).toMatchObject({ status: 'CONCLUIDA', startedAt: null });
  });

  it('bloqueio#4: a visita que chega no meio da reabertura entra na ordem reaberta, sem o aviso de concluída, e a põe em campo', async () => {
    await caso('tr1', ponto('treab', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('tr1');
    await t.http().post(`/api/endemias/bloqueios/${o}/concluir`).set(auth(supervisora)).send({ nota: 'Concluída pela supervisão nesta data' }).expect(200);
    const r = await visitaNoMeio(
      () => t.http().post(`/api/endemias/bloqueios/${o}/reabrir`).set(auth(supervisora)).send({ motivo: 'Novo caso confirmado na área' }).expect(200),
      () => visitar(casa.tr1!, o),
    );
    expect(r.status).toBe('OK');
    expect(r.avisos).toBeUndefined();
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { id: r.id } })).orderId).toBe(o);
    const fim = await ordem(o);
    expect(fim.status).toBe('EM_CAMPO');
    expect(fim.startedAt).not.toBeNull();
  });

  // ─── bloqueio#1 ─────────────────────────────────────────────────────────────
  it('bloqueio#1: ordem sem posição com dois casos, localizada perto de outra, vai inteira para ela (na hora, sem varredura)', async () => {
    await caso('q1', ponto('u1a', 200, 200), 'dengue', dia(-1));
    const oq = await ordemDe('q1');
    await caso('p1', null, 'dengue', dia(-1));
    await notificar('p1b', paciente.p1!, 'chikungunya', dia(-1));
    const op = await ordemDe('p1');
    expect(await ordemDe('p1b')).toBe(op);
    expect((await ordem(op)).status).toBe('AGUARDANDO_LOCALIZACAO');
    // A supervisão já tinha designado alguém à mão na ordem que aguardava: vai junto.
    await t
      .http()
      .post(`/api/endemias/bloqueios/${op}/agentes`)
      .set(auth(supervisora))
      .send({ agentes: [supId] })
      .expect(200);
    await posicionar(casa.p1!, ponto('u1a', 260, 200));
    expect(await ordemDe('p1')).toBe(oq);
    expect(await ordemDe('p1b')).toBe(oq);
    expect(await ordem(op)).toMatchObject({ status: 'CANCELADA', mergedIntoId: oq });
    const q = await ordem(oq);
    expect(q.status).toBe('ABERTA');
    expect(ativas(q)).toBe(3);
    expect(q.groups).toEqual(['chikungunya', 'dengue']);
    expect(q.assignees.map((a) => a.userId).sort()).toEqual([aceId, supId].sort());
    await varredura();
    expect(await db.blockingOrder.count({ where: { id: { in: [op, oq] }, status: { in: ['AGUARDANDO_LOCALIZACAO', 'ABERTA', 'EM_CAMPO'] } } })).toBe(1);
  });

  it('bloqueio#1: a ordem sem visitas vai para a que tem trabalho de campo, mesmo sendo a mais antiga', async () => {
    await caso('p2', null, 'dengue', dia(-1));
    const op = await ordemDe('p2');
    await caso('q2', ponto('u1b', 200, 200), 'dengue', dia(-1));
    const oq = await ordemDe('q2');
    expect(oq).not.toBe(op);
    expect((await visitar(casa.q2!, oq)).status).toBe('OK');
    await posicionar(casa.p2!, ponto('u1b', 260, 200));
    expect(await ordemDe('p2')).toBe(oq);
    expect(await ordem(op)).toMatchObject({ status: 'CANCELADA', mergedIntoId: oq });
    expect((await ordem(oq)).status).toBe('EM_CAMPO');
  });

  it('bloqueio#1: dois moradores de imóvel com posição fraca ficam numa ordem só; localizados, ela se une à vizinha', async () => {
    await caso('q3', ponto('u1c', 200, 200), 'dengue', dia(-1));
    const oq = await ordemDe('q3');
    await novoPaciente('r1');
    const h = await novaCasa('r1', null, paciente.r1!);
    // Geocodificação pelo logradouro (sem número): posição que não define o raio.
    const fraco = ponto('u1c', 250, 260);
    await db.household.update({ where: { id: h }, data: { latitude: fraco[1], longitude: fraco[0], geoPrecision: 'LOGRADOURO', geoSource: 'ibge-logradouro', geoAt: new Date() } });
    await novoPaciente('r2');
    await membro(familia.r1!, paciente.r2!);
    await notificar('r1', paciente.r1!, 'dengue', dia(-1));
    await notificar('r2', paciente.r2!, 'dengue', dia(-1));
    const or = await ordemDe('r1');
    expect(await ordemDe('r2')).toBe(or);
    expect((await ordem(or)).status).toBe('AGUARDANDO_LOCALIZACAO');
    await posicionar(h, ponto('u1c', 260, 200));
    expect(await ordemDe('r1')).toBe(oq);
    expect(await ordemDe('r2')).toBe(oq);
    expect(await ordem(or)).toMatchObject({ status: 'CANCELADA', mergedIntoId: oq });
  });

  it('bloqueio#1 e #3: o caso da ordem em campo que passa a agrupar com uma ordem sem visitas traz essa ordem para a sua', async () => {
    // A: imóvel sem posição na notificação (o caso segue o cadastro), localizado e já trabalhado em campo.
    await novoPaciente('sa');
    await novaCasa('sa', null, paciente.sa!);
    await notificar('sa', paciente.sa!, 'dengue', dia(-1));
    const oa = await ordemDe('sa');
    await posicionar(casa.sa!, ponto('sim', 0, 0));
    expect((await visitar(casa.sa!, oa)).status).toBe('OK');
    expect((await ordem(oa)).status).toBe('EM_CAMPO');
    // B: a 400 m, no mesmo período, numa ordem própria ainda sem visitas.
    await caso('sb', ponto('sim', 400, 0), 'dengue', dia(-1));
    const ob = await ordemDe('sb');
    expect(ob).not.toBe(oa);
    // A posição de A é corrigida no mapa: a 250 m de B, as duas ordens viram uma só, a que já está em campo.
    await posicionar(casa.sa!, ponto('sim', 150, 0));
    expect(await ordemDe('sb')).toBe(oa);
    expect(await ordem(ob)).toMatchObject({ status: 'CANCELADA', mergedIntoId: oa });
    const a = await ordem(oa);
    expect(a.status).toBe('EM_CAMPO');
    expect(ativas(a)).toBe(2);
    expect(a.blocks.map((b) => b.blockId)).toContain(bloco('sim', 4, 0));
  });

  it('bloqueio#1: dois moradores do mesmo imóvel sem posição nenhuma ficam numa ordem só, pelo imóvel', async () => {
    await novoPaciente('m1');
    const h = await novaCasa('m1', null, paciente.m1!);
    await novoPaciente('m2');
    await membro(familia.m1!, paciente.m2!);
    await notificar('m1', paciente.m1!, 'dengue', dia(-1));
    await notificar('m2', paciente.m2!, 'dengue', dia(-1));
    const a = await ordemDe('m1');
    expect(await ordemDe('m2')).toBe(a);
    expect((await ligacao('m1'))!.householdId).toBe(h);
    expect((await ordem(a)).status).toBe('AGUARDANDO_LOCALIZACAO');
    await posicionar(h, ponto('u1d', 200, 200));
    const o = await ordem(a);
    expect(o.status).toBe('ABERTA');
    expect(o.blocks.length).toBeGreaterThan(0);
  });

  // ─── bloqueio#2 ─────────────────────────────────────────────────────────────
  it('bloqueio#2: o caso encerrado como descartado e reaberto volta à própria ordem em campo', async () => {
    await caso('x1', ponto('r2a', 200, 200), 'dengue', dia(-1));
    const ox = await ordemDe('x1');
    expect((await visitar(casa.x1!, ox)).status).toBe('OK');
    await t.http().post(`/api/vigilancia/notificacoes/${notificacao.x1}/confirmar`).set(auth(vig)).expect(200);
    await t
      .http()
      .post(`/api/vigilancia/notificacoes/${notificacao.x1}/encerrar`)
      .set(auth(vig))
      .send({ investigadaEm: dia(0), classificacao: '2', encerradaEm: dia(0) })
      .expect(200);
    expect(await ligacao('x1')).toMatchObject({ active: false, orderId: ox });
    expect((await ordem(ox)).status).toBe('EM_CAMPO');
    const antes = await db.blockingOrder.count();
    await t.http().post(`/api/vigilancia/notificacoes/${notificacao.x1}/reabrir`).set(auth(vig)).send({ reason: 'Novo resultado do LACEN positivo.' }).expect(200);
    expect(await ligacao('x1')).toMatchObject({ active: true, orderId: ox });
    expect(await db.blockingOrder.count()).toBe(antes);
  });

  it('bloqueio#2: a reclassificação (descarta a dengue e notifica chikungunya da mesma pessoa) entra na ordem em campo', async () => {
    await caso('x2', ponto('r2b', 200, 200), 'dengue', dia(-2));
    const ox = await ordemDe('x2');
    expect((await visitar(casa.x2!, ox)).status).toBe('OK');
    await t.http().post(`/api/vigilancia/notificacoes/${notificacao.x2}/descartar`).set(auth(vig)).send({ reason: 'Laboratório: chikungunya, não dengue' }).expect(200);
    expect(await ordem(ox)).toMatchObject({ status: 'EM_CAMPO' });
    const antes = await db.blockingOrder.count();
    await notificar('x2c', paciente.x2!, 'chikungunya', dia(-2));
    expect(await ordemDe('x2c')).toBe(ox);
    expect(await db.blockingOrder.count()).toBe(antes);
  });

  // ─── bloqueio#3 ─────────────────────────────────────────────────────────────
  it('bloqueio#3: a data dos sintomas preenchida depois põe duas ordens abertas vizinhas na mesma janela: viram uma só', async () => {
    await caso('a1', ponto('u3', 200, 200), 'dengue', dia(-9));
    // Rascunho do gatilho do atendimento, sem a data dos sintomas: referência é o dia do conhecimento.
    await caso('b1', ponto('u3', 300, 200), 'dengue');
    const oa = await ordemDe('a1');
    const ob = await ordemDe('b1');
    expect(ob).not.toBe(oa);
    await t
      .http()
      .patch(`/api/vigilancia/notificacoes/${notificacao.b1}`)
      .set(auth(vig))
      .send({ symptomsOnset: dia(-6) })
      .expect(200);
    expect(await ordemDe('b1')).toBe(oa);
    expect(await ordem(ob)).toMatchObject({ status: 'CANCELADA', mergedIntoId: oa });
    expect(ativas(await ordem(oa))).toBe(2);
  });

  // ─── dados-docs#4 ───────────────────────────────────────────────────────────
  it('dados-docs#4: sem agrupamento em cadeia, o caso novo fica na janela da primeira data da ordem', async () => {
    await caso('k1', ponto('cad', 0, 0), 'dengue', dia(-12));
    await caso('k2', ponto('cad', 250, 0), 'dengue', dia(-6));
    await caso('k3', ponto('cad', 500, 0), 'dengue', dia(0));
    const ok = await ordemDe('k1');
    expect(await ordemDe('k2')).toBe(ok);
    expect(await ordemDe('k3')).not.toBe(ok);
    // Com o campo iniciado, a âncora passa a ser o início do campo (terceira rodada), e não o período dos casos: a ordem
    // é a ação que começou hoje e serve a quem começou até 7 dias depois dela (e aos mais antigos, que o trabalho veio
    // depois). O caso de hoje a 100 m do primeiro entra nela; antes, abria outra ordem e o quarteirão era trabalhado de novo.
    await caso('m3a', ponto('cadc', 0, 0), 'dengue', dia(-12));
    const om = await ordemDe('m3a');
    expect((await visitar(casa.m3a!, om)).status).toBe('OK');
    await caso('m3b', ponto('cadc', 250, 0), 'dengue', dia(-6));
    expect(await ordemDe('m3b')).toBe(om);
    const total = await db.blockingOrder.count();
    await caso('m3c', ponto('cadc', 100, 0), 'dengue', dia(0));
    expect(await ordemDe('m3c')).toBe(om);
    expect(await db.blockingOrder.count()).toBe(total);
    expect(datasAtivas(await ordem(om))).toEqual([dia(-12), dia(-6), dia(0)]);
  });

  it('dados-docs#4: o caso mais antigo que a primeira data da ordem também não estica o período além da janela', async () => {
    await caso('v1', ponto('cadv', 0, 0), 'dengue', dia(-2));
    const ov = await ordemDe('v1');
    // 6 dias antes do primeiro: a ordem passa a ir de D-8 a D-2.
    await caso('v2', ponto('cadv', 100, 0), 'dengue', dia(-8));
    expect(await ordemDe('v2')).toBe(ov);
    // 2 dias antes do segundo, mas 8 antes do primeiro: com ele a ordem teria 8 dias (cadeia pelo começo).
    await caso('v3', ponto('cadv', 50, 0), 'dengue', dia(-10));
    expect(await ordemDe('v3')).not.toBe(ov);
    expect(ativas(await ordem(ov))).toBe(2);
  });

  it('dados-docs#4 e bloqueio#2: a ordem em campo sem caso ativo recebe pelo quarteirão, dentro da janela do início do campo', async () => {
    await caso('n1', ponto('ini', 200, 200), 'dengue', dia(-12));
    const on = await ordemDe('n1');
    expect((await visitar(casa.n1!, on)).status).toBe('OK');
    // A ordem foi aberta há 12 dias e o campo começou há 10.
    await db.blockingOrder.update({ where: { id: on }, data: { openedAt: new Date(Date.now() - 12 * DIA), startedAt: new Date(Date.now() - 10 * DIA) } });
    await t.http().post(`/api/vigilancia/notificacoes/${notificacao.n1}/descartar`).set(auth(vig)).send({ reason: 'Descartado após investigação clínica' }).expect(200);
    expect(await ordem(on)).toMatchObject({ status: 'EM_CAMPO' });
    // Outra pessoa do mesmo quarteirão, com sintomas hoje: o trabalho de 10 dias atrás não serve a ela.
    await caso('n2', ponto('ini', 210, 190), 'dengue', dia(0));
    expect(await ordemDe('n2')).not.toBe(on);
    // Com sintomas há 4 dias (até 7 dias depois do início do campo), entra na ordem em campo pelo quarteirão.
    await caso('n3', ponto('ini', 190, 210), 'dengue', dia(-4));
    expect(await ordemDe('n3')).toBe(on);
  });

  // ─── dados-docs#4, segunda rodada: a data corrigida de um caso já ligado ─────
  const datasAtivas = (o: { cases: { active: boolean; referenceDate: Date }[] }) =>
    o.cases
      .filter((c) => c.active)
      .map((c) => localDateString(c.referenceDate, 'UTC'))
      .sort();
  const corrigirSintomas = (chave: string, data: string) => t.http().patch(`/api/vigilancia/notificacoes/${notificacao[chave]}`).set(auth(vig)).send({ symptomsOnset: data }).expect(200);

  it('dados-docs#4: a data corrigida que esticaria a ordem ainda sem campo tira o caso dela, e o vizinho novo entra na ordem', async () => {
    await caso('dt1', ponto('dat', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('dt1');
    await caso('dt2', ponto('dat', 250, 200), 'dengue', dia(-2));
    expect(await ordemDe('dt2')).toBe(o);
    const antes = await ordem(o);
    // A vigilância corrige os sintomas do segundo para 15 dias atrás: com ele, a ordem iria de D-15 a D-1.
    await corrigirSintomas('dt2', dia(-15));
    const dt2 = (await ligacao('dt2'))!;
    expect(dt2.active).toBe(true);
    expect(dt2.orderId).not.toBe(o);
    expect(localDateString(dt2.referenceDate, 'UTC')).toBe(dia(-15));
    // Entrou como caso novo: nenhuma ordem agrupa com ele, então abriu a sua.
    const nova = await ordem(dt2.orderId);
    expect(nova).toMatchObject({ status: 'ABERTA', mergedIntoId: null });
    expect(datasAtivas(nova)).toEqual([dia(-15)]);
    // A ordem de origem foi refeita sem ele: fica no período do primeiro caso, com os quarteirões só do raio dele.
    const depois = await ordem(o);
    expect(depois.status).toBe('ABERTA');
    expect(datasAtivas(depois)).toEqual([dia(-1)]);
    expect(depois.blocks.length).toBeLessThan(antes.blocks.length);
    // Caso novo a 10 m do primeiro, um dia depois dele: entra na ordem (antes abria outra sobre os mesmos quarteirões).
    const total = await db.blockingOrder.count();
    await caso('dt3', ponto('dat', 210, 200), 'dengue', dia(0));
    expect(await ordemDe('dt3')).toBe(o);
    expect(await db.blockingOrder.count()).toBe(total);
    expect(datasAtivas(await ordem(o))).toEqual([dia(-1), dia(0)]);
  });

  it('dados-docs#4: o caso aguardando a localização com a data corrigida também sai da ordem sem campo', async () => {
    // Dois moradores do mesmo imóvel, sem posição nenhuma: uma ordem só, pelo imóvel.
    await novoPaciente('da1');
    await novaCasa('da1', null, paciente.da1!);
    await notificar('da1', paciente.da1!, 'dengue', dia(-1));
    const o = await ordemDe('da1');
    await novoPaciente('da2');
    await membro(familia.da1!, paciente.da2!);
    await notificar('da2', paciente.da2!, 'dengue', dia(-3));
    expect(await ordemDe('da2')).toBe(o);
    expect((await ordem(o)).status).toBe('AGUARDANDO_LOCALIZACAO');
    await corrigirSintomas('da2', dia(-14));
    const da2 = (await ligacao('da2'))!;
    expect(da2.orderId).not.toBe(o);
    expect((await ordem(da2.orderId)).status).toBe('AGUARDANDO_LOCALIZACAO');
    expect(datasAtivas(await ordem(o))).toEqual([dia(-1)]);
  });

  it('dados-docs#4: o caso que volta (encerramento reaberto) com a data corrigida não estica a ordem ainda sem campo', async () => {
    await caso('dv1', ponto('datv', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('dv1');
    await caso('dv2', ponto('datv', 250, 200), 'dengue', dia(-2));
    expect(await ordemDe('dv2')).toBe(o);
    await t.http().post(`/api/vigilancia/notificacoes/${notificacao.dv2}/confirmar`).set(auth(vig)).expect(200);
    await t
      .http()
      .post(`/api/vigilancia/notificacoes/${notificacao.dv2}/encerrar`)
      .set(auth(vig))
      .send({ investigadaEm: dia(0), classificacao: '2', encerradaEm: dia(0) })
      .expect(200);
    expect(await ligacao('dv2')).toMatchObject({ active: false, orderId: o });
    // Os sintomas corrigidos enquanto o caso estava encerrado (direto no banco: a ficha encerrada não é editada).
    await db.notification.update({ where: { id: notificacao.dv2! }, data: { symptomsOnset: new Date(`${dia(-15)}T00:00:00Z`) } });
    await t.http().post(`/api/vigilancia/notificacoes/${notificacao.dv2}/reabrir`).set(auth(vig)).send({ reason: 'Novo resultado do LACEN positivo.' }).expect(200);
    const dv2 = (await ligacao('dv2'))!;
    expect(dv2.active).toBe(true);
    expect(dv2.orderId).not.toBe(o);
    expect(datasAtivas(await ordem(o))).toEqual([dia(-1)]);
    expect(datasAtivas(await ordem(dv2.orderId))).toEqual([dia(-15)]);
  });

  it('dados-docs#4: com a ordem já em campo, o caso com a data corrigida fica nela (o trabalho feito vale)', async () => {
    await caso('dc1', ponto('datc', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('dc1');
    await caso('dc2', ponto('datc', 250, 200), 'dengue', dia(-2));
    expect(await ordemDe('dc2')).toBe(o);
    expect((await visitar(casa.dc1!, o)).status).toBe('OK');
    const antes = await ordem(o);
    expect(antes.status).toBe('EM_CAMPO');
    const total = await db.blockingOrder.count();
    await corrigirSintomas('dc2', dia(-15));
    const dc2 = (await ligacao('dc2'))!;
    expect(dc2).toMatchObject({ orderId: o, active: true });
    expect(localDateString(dc2.referenceDate, 'UTC')).toBe(dia(-15));
    const depois = await ordem(o);
    expect(depois.status).toBe('EM_CAMPO');
    expect(datasAtivas(depois)).toEqual([dia(-15), dia(-1)]);
    expect(await db.blockingOrder.count()).toBe(total);
    // Em campo a lista só cresce: os quarteirões de antes continuam.
    expect(antes.blocks.every((b) => depois.blocks.some((x) => x.blockId === b.blockId))).toBe(true);
  });

  // ─── dados-docs#4, terceira rodada: em campo, a âncora é o início do campo ──
  it('dados-docs#4: com a ordem em campo, a data corrigida para trás fica nela e não fecha a ordem ao vizinho novo', async () => {
    await caso('ec1', ponto('rcamp', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('ec1');
    await caso('ec2', ponto('rcamp', 250, 200), 'dengue', dia(-2));
    expect(await ordemDe('ec2')).toBe(o);
    expect((await visitar(casa.ec1!, o)).status).toBe('OK');
    expect((await ordem(o)).status).toBe('EM_CAMPO');
    // A vigilância corrige os sintomas do segundo para 15 dias atrás: ele fica na ordem (o trabalho feito vale).
    await corrigirSintomas('ec2', dia(-15));
    expect(await ligacao('ec2')).toMatchObject({ orderId: o, active: true });
    expect(datasAtivas(await ordem(o))).toEqual([dia(-15), dia(-1)]);
    // Caso novo hoje, a 10 m do primeiro. Em campo o período dos casos (D-15 a D-1) não conta: o campo começou hoje e
    // serve a ele. Entra na ordem; antes, abria outra sobre os mesmos quarteirões (trabalho de campo em dobro).
    const total = await db.blockingOrder.count();
    await caso('ec3', ponto('rcamp', 210, 200), 'dengue', dia(0));
    expect(await ordemDe('ec3')).toBe(o);
    expect(await db.blockingOrder.count()).toBe(total);
    const depois = await ordem(o);
    expect(depois.status).toBe('EM_CAMPO');
    expect(datasAtivas(depois)).toEqual([dia(-15), dia(-1), dia(0)]);
  });

  it('dados-docs#4: a ordem sem campo vai para a ordem em campo se os casos dela começaram até 7 dias depois do início do campo', async () => {
    // D: caso de 10 dias atrás, com o campo começando hoje.
    await caso('ud1', ponto('ucamp', 200, 200), 'dengue', dia(-10));
    const d = await ordemDe('ud1');
    expect((await visitar(casa.ud1!, d)).status).toBe('OK');
    // G: caso de ontem sem posição na notificação (segue o cadastro do imóvel), aguardando a localização numa ordem própria.
    await novoPaciente('ug1');
    await novaCasa('ug1', null, paciente.ug1!);
    await notificar('ug1', paciente.ug1!, 'dengue', dia(-1));
    const g = await ordemDe('ug1');
    expect(g).not.toBe(d);
    // Localizado num quarteirão que D cobre, a 100 m do caso dela: com G, o período dos casos iria de D-10 a D-1 (9 dias),
    // mas o caso de G começou depois do início do campo de D, dentro da janela. G vai inteira para D (antes, as duas
    // ficavam abertas sobre os mesmos quarteirões).
    await posicionar(casa.ug1!, ponto('ucamp', 300, 200));
    expect(await ordemDe('ug1')).toBe(d);
    expect(await ordem(g)).toMatchObject({ status: 'CANCELADA', mergedIntoId: d });
    const depois = await ordem(d);
    expect(depois.status).toBe('EM_CAMPO');
    expect(datasAtivas(depois)).toEqual([dia(-10), dia(-1)]);
    // Com o campo de 10 dias atrás, a ordem de dois moradores (sintomas há 4 dias e ontem) não vai: o de ontem começou
    // mais de 7 dias depois do início do campo, e cada caso da origem precisa caber nele. As duas ordens ficam.
    await caso('ud2', ponto('ucamp2', 200, 200), 'dengue', dia(-12));
    const d2 = await ordemDe('ud2');
    expect((await visitar(casa.ud2!, d2)).status).toBe('OK');
    await db.blockingOrder.update({ where: { id: d2 }, data: { startedAt: new Date(Date.now() - 10 * DIA) } });
    await novoPaciente('ug2');
    await novaCasa('ug2', null, paciente.ug2!);
    await novoPaciente('ug3');
    await membro(familia.ug2!, paciente.ug3!);
    await notificar('ug2', paciente.ug2!, 'dengue', dia(-4));
    await notificar('ug3', paciente.ug3!, 'dengue', dia(-1));
    const g2 = await ordemDe('ug2');
    expect(await ordemDe('ug3')).toBe(g2);
    await posicionar(casa.ug2!, ponto('ucamp2', 300, 200));
    expect(await ordem(g2)).toMatchObject({ status: 'ABERTA', mergedIntoId: null });
    expect(datasAtivas(await ordem(g2))).toEqual([dia(-4), dia(-1)]);
    expect(datasAtivas(await ordem(d2))).toEqual([dia(-12)]);
  });

  it('dados-docs#4: a data corrigida para mais de 30 dias, ou com a abertura automática desligada, só tira o caso da ordem sem campo', async () => {
    await caso('dd1', ponto('datd', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('dd1');
    await caso('dd2', ponto('datd', 250, 200), 'dengue', dia(-2));
    await caso('dd3', ponto('datd', 150, 200), 'dengue', dia(-3));
    expect(await ordemDe('dd2')).toBe(o);
    expect(await ordemDe('dd3')).toBe(o);
    const total = await db.blockingOrder.count();
    // Sintomas de 40 dias atrás: como caso novo, não abriria ordem (mais de 30 dias). Antes, abria uma ordem nova para ele.
    await corrigirSintomas('dd2', dia(-40));
    expect(await ligacao('dd2')).toMatchObject({ orderId: o, active: false, unlinkReason: 'Data corrigida para fora do período da ordem (início dos sintomas há mais de 30 dias)' });
    // Com a abertura automática desligada (epidemia: a ação é por área), o caso novo também não abriria ordem.
    await config({ bloqueioAutomatico: false });
    try {
      await corrigirSintomas('dd3', dia(-15));
    } finally {
      await config({ bloqueioAutomatico: true });
    }
    expect(await ligacao('dd3')).toMatchObject({ orderId: o, active: false, unlinkReason: 'Data corrigida para fora do período da ordem (abertura automática desligada)' });
    expect(await db.blockingOrder.count()).toBe(total);
    const depois = await ordem(o);
    expect(depois.status).toBe('ABERTA');
    expect(datasAtivas(depois)).toEqual([dia(-1)]);
    // Com a abertura automática de volta, a varredura trata o de 15 dias atrás como caso novo: abre a ordem dele.
    expect((await varredura()).erros).toBe(0);
    const dd3 = (await ligacao('dd3'))!;
    expect(dd3.active).toBe(true);
    expect(dd3.orderId).not.toBe(o);
    expect(datasAtivas(await ordem(dd3.orderId))).toEqual([dia(-15)]);
    expect(await ligacao('dd2')).toMatchObject({ orderId: o, active: false });
    expect(datasAtivas(await ordem(o))).toEqual([dia(-1)]);
  });

  // ─── bloqueio#7 ─────────────────────────────────────────────────────────────
  it('bloqueio#7: outro morador do mesmo imóvel, semanas depois, abre outra ordem (a identidade respeita a janela)', async () => {
    await caso('h1', ponto('id7a', 200, 200), 'dengue', dia(-25));
    const oh = await ordemDe('h1');
    expect((await visitar(casa.h1!, oh)).status).toBe('OK');
    // Campo iniciado há 10 dias: o trabalho feito não serve ao morador doente hoje, e o mesmo imóvel não passa por cima
    // da janela. (Com o campo começando hoje, ele entra pelo quarteirão: ver o teste seguinte.)
    await db.blockingOrder.update({ where: { id: oh }, data: { startedAt: new Date(Date.now() - 10 * DIA) } });
    await novoPaciente('h2');
    await membro(familia.h1!, paciente.h2!);
    await notificar('h2', paciente.h2!, 'dengue', dia(0));
    expect(await ordemDe('h2')).not.toBe(oh);
    expect(ativas(await ordem(oh))).toBe(1);
  });

  it('dados-docs#4 e bloqueio#7: com o campo começando hoje, o morador doente hoje entra na ordem do caso de semanas atrás', async () => {
    // O cenário que o teste anterior fixava até a segunda rodada (campo de hoje, caso de 25 dias atrás): em campo, a âncora
    // passou a ser o início do campo (terceira rodada), e o trabalho que começa agora serve a quem adoeceu hoje. Ele entra
    // pelo quarteirão que a ordem cobre, e não pela identidade (o caso de 25 dias atrás continua fora da janela dele).
    await caso('h3', ponto('id7c', 200, 200), 'dengue', dia(-25));
    const oh = await ordemDe('h3');
    expect((await visitar(casa.h3!, oh)).status).toBe('OK');
    await novoPaciente('h4');
    await membro(familia.h3!, paciente.h4!);
    const total = await db.blockingOrder.count();
    await notificar('h4', paciente.h4!, 'dengue', dia(0));
    expect(await ordemDe('h4')).toBe(oh);
    expect(await db.blockingOrder.count()).toBe(total);
    expect(ativas(await ordem(oh))).toBe(2);
  });

  it('bloqueio#7: o caso de quem mudou de casa guarda a residência notificada, sem o imóvel novo', async () => {
    await caso('mv', ponto('id7b', 200, 200), 'dengue', dia(-3));
    const om = await ordemDe('mv');
    await novoPaciente('vz');
    await novaCasa('vz', ponto('id7bn', 200, 200), paciente.vz!);
    // A pessoa do caso passa a morar no imóvel novo, a 5 km.
    await membro(familia.vz!, paciente.mv!);
    await varredura();
    const c = (await ligacao('mv'))!;
    expect(c.orderId).toBe(om);
    expect(c.householdId).toBeNull();
    // O morador do imóvel novo, no mesmo período, não cai na ordem da residência antiga.
    await notificar('vz', paciente.vz!, 'dengue', dia(0));
    expect(await ordemDe('vz')).not.toBe(om);
  });

  // ─── bloqueio#8 ─────────────────────────────────────────────────────────────
  it('bloqueio#8: o GPS confirmado na visita refaz o caso da ordem em campo na hora (sem varredura nem recálculo manual)', async () => {
    const centro = await db.block.findUniqueOrThrow({ where: { id: bloco('gps8', 2, 2) } });
    await novoPaciente('c1');
    const h = await novaCasa('c1', null, paciente.c1!);
    await db.household.update({
      where: { id: h },
      data: { latitude: centro.centerLat, longitude: centro.centerLng, geoPrecision: 'QUARTEIRAO', geoSource: 'centro-do-quarteirao', blockId: centro.id, geoAt: new Date() },
    });
    await notificar('c1', paciente.c1!, 'dengue', dia(-1));
    const oc = await ordemDe('c1');
    const antes = await ordem(oc);
    expect(antes.needsCheck).toBe(true);
    const gps = ponto('gps8', 235, 230);
    expect((await visitar(h, oc, { latitude: gps[1], longitude: gps[0], precisaoGps: 8 })).status).toBe('OK');
    const o = await ordem(oc);
    expect(o.status).toBe('EM_CAMPO');
    expect(o.needsCheck).toBe(false);
    expect((await ligacao('c1'))!.precision).toBe('GPS_CAMPO');
    expect(o.blocks.length).toBeGreaterThan(antes.blocks.length);
    // Em campo a lista só cresce: os quarteirões de antes continuam.
    expect(antes.blocks.every((b) => o.blocks.some((x) => x.blockId === b.blockId))).toBe(true);
  });

  // ─── bloqueio#8, segunda rodada: GPS do ACS e posição do cadastro do domicílio ───
  /** Imóvel no centro do quarteirão (precisão QUARTEIRAO), caso de ontem e ordem em campo (visita do ACE sem GPS). */
  async function casoNoCentroEmCampo(chave: string, g: string) {
    const centro = await db.block.findUniqueOrThrow({ where: { id: bloco(g, 2, 2) } });
    await novoPaciente(chave);
    const h = await novaCasa(chave, null, paciente[chave]!);
    await db.household.update({
      where: { id: h },
      data: { latitude: centro.centerLat, longitude: centro.centerLng, geoPrecision: 'QUARTEIRAO', geoSource: 'centro-do-quarteirao', blockId: centro.id, geoAt: new Date() },
    });
    await notificar(chave, paciente[chave]!, 'dengue', dia(-1));
    const o = await ordemDe(chave);
    expect((await ordem(o)).needsCheck).toBe(true);
    expect((await visitar(h, o)).status).toBe('OK');
    const antes = await ordem(o);
    expect(antes.status).toBe('EM_CAMPO');
    return { h, o, antes, ligacao: (await ligacao(chave))! };
  }
  /** Visita do ACS feita sem rede uma hora antes da ligação do caso e enviada agora, com o GPS do aparelho. */
  const visitaAcs = async (householdId: string, gps: Posicao, antesDe: Date) => {
    const op = {
      tipo: 'VISITA',
      clientId: randomUUID(),
      registradoEm: new Date(antesDe.getTime() - 3_600_000).toISOString(),
      householdId,
      visita: { motivos: ['29'], desfecho: '3', latitude: gps[1], longitude: gps[0], precisaoGps: 8 },
    };
    return (
      await t
        .http()
        .post('/api/acs/sync')
        .set(auth(acs))
        .send({ operacoes: [op] })
        .expect(200)
    ).body.resultados[0] as { status: string; erro: string | null };
  };
  const conferirCorrigido = async (chave: string, o: string, antes: { blocks: { blockId: string }[] }, gps: Posicao) => {
    const c = (await ligacao(chave))!;
    expect(c.precision).toBe('GPS_CAMPO');
    expect(c.lat).toBeCloseTo(gps[1], 6);
    expect(c.lng).toBeCloseTo(gps[0], 6);
    const depois = await ordem(o);
    expect(depois.status).toBe('EM_CAMPO');
    expect(depois.needsCheck).toBe(false);
    expect(antes.blocks.every((b) => depois.blocks.some((x) => x.blockId === b.blockId))).toBe(true);
  };

  it('bloqueio#8: o GPS da visita do ACS feita sem rede antes da notificação refaz na hora o caso da ordem em campo', async () => {
    const { h, o, antes, ligacao: l } = await casoNoCentroEmCampo('ga1', 'acs8');
    const gps = ponto('acs8', 225, 230);
    expect((await visitaAcs(h, gps, l.linkedAt)).status).toBe('OK');
    // A posição do imóvel guarda a hora da visita no aparelho, anterior à ligação.
    const imovel = await db.household.findUniqueOrThrow({ where: { id: h } });
    expect(imovel).toMatchObject({ geoPrecision: 'GPS_CAMPO', geoSource: 'visita' });
    expect(imovel.geoAt!.getTime()).toBeLessThan(l.linkedAt.getTime());
    // Sem varredura nem recálculo manual.
    await conferirCorrigido('ga1', o, antes, gps);
  });

  it('bloqueio#8: sem o gancho, a varredura refaz o caso pela posição do imóvel, mesmo com a hora do GPS anterior à ligação', async () => {
    // Com a trava das ordens ocupada, o gancho da sincronização do ACS falha, e a visita é gravada mesmo assim.
    const a = await casoNoCentroEmCampo('gb1', 'acs8b');
    const gpsA = ponto('acs8b', 225, 230);
    const c = await pgc();
    try {
      await c.query(`SELECT pg_advisory_lock(hashtext('endemias:bloqueio'))`);
      expect((await visitaAcs(a.h, gpsA, a.ligacao.linkedAt)).status).toBe('OK');
    } finally {
      await c.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      await c.end();
    }
    expect((await db.household.findUniqueOrThrow({ where: { id: a.h } })).geoPrecision).toBe('GPS_CAMPO');
    expect((await ligacao('gb1'))!.precision).toBe('QUARTEIRAO');
    // A posição gravada por outro caminho, sem gancho nenhum (SQL direto, sem mexer em updated_at), com a hora antiga.
    const b = await casoNoCentroEmCampo('gc1', 'acs8c');
    const gpsB = ponto('acs8c', 225, 230);
    await db.$executeRaw`UPDATE households SET latitude = ${gpsB[1]}, longitude = ${gpsB[0]}, geo_precision = 'GPS_CAMPO', geo_source = 'visita', geo_at = ${new Date(b.ligacao.linkedAt.getTime() - 3_600_000)} WHERE id = ${b.h}::uuid`;
    expect((await varredura()).erros).toBe(0);
    await conferirCorrigido('gb1', a.o, a.antes, gpsA);
    await conferirCorrigido('gc1', b.o, b.antes, gpsB);
  });

  it('bloqueio#8: a posição nova no cadastro do domicílio refaz o caso na hora (edição e criação)', async () => {
    // Edição: o GPS lido no cadastro substitui o centro do quarteirão.
    const { h, o, antes } = await casoNoCentroEmCampo('gd1', 'dom8');
    const gps = ponto('dom8', 215, 185);
    await t.http().patch(`/api/households/${h}`).set(auth(recepcao)).send({ latitude: gps[1], longitude: gps[0] }).expect(200);
    await conferirCorrigido('gd1', o, antes, gps);
    // Criação: a pessoa do caso sem imóvel nenhum (aguardando a localização) passa a ser responsável por um domicílio
    // cadastrado com posição: a ordem abre na hora, sem varredura.
    await novoPaciente('ge1');
    await notificar('ge1', paciente.ge1!, 'dengue', dia(-1));
    const oe = await ordemDe('ge1');
    expect((await ordem(oe)).status).toBe('AGUARDANDO_LOCALIZACAO');
    await novaCasa('ge1', ponto('dom8n', 200, 200), paciente.ge1!);
    const aberta = await ordem(oe);
    expect(aberta.status).toBe('ABERTA');
    expect(aberta.blocks.map((b) => b.blockId)).toContain(bloco('dom8n', 2, 2));
    expect((await ligacao('ge1'))!.householdId).toBe(casa.ge1);
  });

  // ─── bloqueio#10 ────────────────────────────────────────────────────────────
  it('bloqueio#10: o progresso conta os imóveis ativos que estão no quarteirão e a última visita de cada um', async () => {
    await caso('i1', ponto('prog', 200, 200), 'dengue', dia(-1));
    const oi = await ordemDe('i1');
    const quarteirao = (await db.household.findUniqueOrThrow({ where: { id: casa.i1! } })).blockId!;
    await novoPaciente('i2');
    const vizinha = await novaCasa('i2', ponto('prog', 215, 185), paciente.i2!);
    await novoPaciente('i3');
    const outra = await novaCasa('i3', ponto('prog', 185, 215), paciente.i3!);
    await novoPaciente('i4');
    const demolida = await novaCasa('i4', ponto('prog', 220, 220), paciente.i4!);
    const mesmos = await db.household.findMany({ where: { id: { in: [vizinha, outra, demolida] } }, select: { blockId: true } });
    expect(mesmos.every((x) => x.blockId === quarteirao)).toBe(true);
    for (const h of [casa.i1!, outra, demolida]) expect((await visitar(h, oi)).status).toBe('OK');
    // A posição da 'outra' é corrigida a 1 km (sai do quarteirão); a 'demolida' sai do cadastro.
    await posicionar(outra, ponto('prog', 1200, 200));
    await db.household.update({ where: { id: demolida }, data: { active: false } });
    const d = (await t.http().get(`/api/endemias/bloqueios/${oi}`).set(auth(supervisora)).expect(200)).body;
    const q = d.quarteiroes.find((x: { id: string }) => x.id === quarteirao);
    expect(q.progresso).toMatchObject({ imoveis: 2, trabalhados: 1, pendentes: 0, semVisita: 1, cobertura: 50 });
    const r = await t.http().post(`/api/endemias/bloqueios/${oi}/concluir`).set(auth(supervisora)).send({}).expect(422);
    expect(r.body.message).toMatch(/justifique/);
  });

  // ─── bloqueio#6, seguranca#4, web-offline#9 ─────────────────────────────────
  it('bloqueio#6 e seguranca#4: a designação automática só traz o titular elegível dos quarteirões que entraram, com registro na trilha', async () => {
    const auto = (orderId: string) => db.auditEntry.count({ where: { entityId: orderId, action: 'endemias.ordem_designar_auto' } });
    await caso('d1', ponto('des', 0, 0), 'dengue', dia(-1));
    const od = await ordemDe('d1');
    let o = await ordem(od);
    expect(o.assignees.map((a) => a.userId)).toEqual([ace2Id]);
    expect(await auto(od)).toBe(1);
    // A supervisão troca o titular por ela mesma.
    await t
      .http()
      .post(`/api/endemias/bloqueios/${od}/agentes`)
      .set(auth(supervisora))
      .send({ agentes: [supId] })
      .expect(200);
    // Caso novo no mesmo quarteirão (nenhum quarteirão novo) e o recálculo pela supervisão: o titular retirado não volta.
    await caso('d2', ponto('des', -10, -10), 'dengue', dia(-1));
    expect(await ordemDe('d2')).toBe(od);
    await t.http().post(`/api/endemias/bloqueios/${od}/recalcular`).set(auth(supervisora)).expect(200);
    o = await ordem(od);
    expect(o.assignees.map((a) => a.userId)).toEqual([supId]);
    expect(await auto(od)).toBe(1);
    // Caso que estende a ordem a quarteirões novos da zona: o titular é designado de novo, sem autor e na trilha.
    const antes = o.blocks.length;
    await caso('d3', ponto('des', 100, 0), 'dengue', dia(-1));
    expect(await ordemDe('d3')).toBe(od);
    o = await ordem(od);
    expect(o.blocks.length).toBeGreaterThan(antes);
    expect(o.assignees.map((a) => a.userId).sort()).toEqual([ace2Id, supId].sort());
    expect(o.assignees.find((a) => a.userId === ace2Id)!.assignedBy).toBeNull();
    expect(await auto(od)).toBe(2);
    // Titular que perdeu a lotação não é designado sozinho (travaria a redesignação pela tela).
    await t
      .http()
      .post(`/api/endemias/bloqueios/${od}/agentes`)
      .set(auth(supervisora))
      .send({ agentes: [supId] })
      .expect(200);
    await db.userAssignment.updateMany({ where: { userId: ace2Id }, data: { active: false } });
    await caso('d4', ponto('des', 200, 0), 'dengue', dia(-1));
    expect(await ordemDe('d4')).toBe(od);
    o = await ordem(od);
    expect(o.assignees.map((a) => a.userId)).toEqual([supId]);
    expect(await auto(od)).toBe(2);
    await db.userAssignment.updateMany({ where: { userId: ace2Id }, data: { active: true } });
  });

  it('web-offline#9: ao designar, só quem entra é validado; o já designado sem lotação ativa pode ficar ou sair', async () => {
    const od = await ordemDe('d1');
    await t
      .http()
      .post(`/api/endemias/bloqueios/${od}/agentes`)
      .set(auth(supervisora))
      .send({ agentes: [supId, ace2Id] })
      .expect(200);
    await db.userAssignment.updateMany({ where: { userId: ace2Id }, data: { active: false } });
    // A tela reenvia a lista com o agente que perdeu a lotação e acrescenta outro: aceito.
    await t
      .http()
      .post(`/api/endemias/bloqueios/${od}/agentes`)
      .set(auth(supervisora))
      .send({ agentes: [supId, ace2Id, aceId] })
      .expect(200);
    // Tirar o inelegível: aceito.
    await t
      .http()
      .post(`/api/endemias/bloqueios/${od}/agentes`)
      .set(auth(supervisora))
      .send({ agentes: [supId, aceId] })
      .expect(200);
    expect((await ordem(od)).assignees.map((a) => a.userId).sort()).toEqual([aceId, supId].sort());
    // Acrescentar quem não é elegível: recusado (lotação encerrada, ou usuário desativado com a lotação ativa).
    const r = await t
      .http()
      .post(`/api/endemias/bloqueios/${od}/agentes`)
      .set(auth(supervisora))
      .send({ agentes: [supId, aceId, ace2Id] })
      .expect(400);
    expect(r.body.code).toBe('AGENTE_INVALIDO');
    await db.userAssignment.updateMany({ where: { userId: ace2Id }, data: { active: true } });
    await db.user.update({ where: { id: ace2Id }, data: { active: false } });
    await t
      .http()
      .post(`/api/endemias/bloqueios/${od}/agentes`)
      .set(auth(supervisora))
      .send({ agentes: [supId, aceId, ace2Id] })
      .expect(400);
    await db.user.update({ where: { id: ace2Id }, data: { active: true } });
  });

  // ─── seguranca#1 ────────────────────────────────────────────────────────────
  it('seguranca#1: sem o mapa de casos, o detalhe não traz a distância nem o agravo, não segue a distância e fica na trilha', async () => {
    await caso('s1', ponto('seg1', 213.7, 287.3), 'dengue', dia(-1));
    const os = await ordemDe('s1');
    for (const quem of [gestora, supervisora]) {
      const lista = (await t.http().get('/api/endemias/bloqueios').set(auth(quem)).expect(200)).body as { id: string; grupos: string[] }[];
      expect(lista.find((x) => x.id === os)!.grupos).toEqual([]);
      const d = (await t.http().get(`/api/endemias/bloqueios/${os}`).set(auth(quem)).expect(200)).body as { grupos: string[]; quarteiroes: { numero: string; distanciaM: number | null; ocorrencia: boolean }[] };
      expect(d.grupos).toEqual([]);
      expect(d.quarteiroes.length).toBeGreaterThan(4);
      expect(d.quarteiroes.every((q) => q.distanciaM === null)).toBe(true);
      // O quarteirão de ocorrência primeiro e depois pelo número (nunca pela distância).
      const n = d.quarteiroes.filter((q) => q.ocorrencia).length;
      expect(n).toBe(1);
      expect(d.quarteiroes[0]!.ocorrencia).toBe(true);
      const numeros = d.quarteiroes.slice(n).map((q) => Number(q.numero));
      expect(numeros).toEqual([...numeros].sort((a, b) => a - b));
      expect(JSON.stringify(d)).not.toMatch(/dengue/i);
    }
    // A vigilância (mapa de casos) vê a distância e o agravo.
    const dv = (await t.http().get(`/api/endemias/bloqueios/${os}`).set(auth(vig)).expect(200)).body as { grupos: string[]; quarteiroes: { distanciaM: number | null }[] };
    expect(dv.grupos).toEqual(['dengue']);
    expect(dv.quarteiroes.every((q) => typeof q.distanciaM === 'number')).toBe(true);
    // O cartão da ficha só para quem abre a notificação.
    await t.http().get(`/api/endemias/bloqueios/da-notificacao/${notificacao.s1}`).set(auth(gestora)).expect(403);
    await t.http().get(`/api/endemias/bloqueios/da-notificacao/${notificacao.s1}`).set(auth(supervisora)).expect(403);
    expect((await t.http().get(`/api/endemias/bloqueios/da-notificacao/${notificacao.s1}`).set(auth(vig)).expect(200)).body.ordem.id).toBe(os);
    // Trilha: as leituras do detalhe pela gestão e pela supervisão (não as da vigilância).
    const lidas = await db.auditEntry.findMany({ where: { entityId: os, action: 'endemias.ordem_ler' }, select: { role: true } });
    expect(lidas.map((l) => l.role).sort()).toEqual(['GESTOR', 'SUPERVISOR_ENDEMIAS']);
  });

  // ─── seguranca#3 ────────────────────────────────────────────────────────────
  it('seguranca#3: a supervisão de campo só posiciona imóvel das zonas e ordens ativas, e ninguém de campo grava a sequência do RG', async () => {
    await novoPaciente('sz');
    const dentro = await novaCasa('sz', ponto('seg3', 200, 200), paciente.sz!);
    await novoPaciente('sf');
    const fora = await novaCasa('sf', ponto('seg3', 3000, 3000), paciente.sf!);
    expect((await db.household.findUniqueOrThrow({ where: { id: fora } })).blockId).toBeNull();
    const perto = ponto('seg3', 205, 205);
    for (const quem of [supervisora, ace]) {
      const r = await t.http().post(`/api/territorio/imoveis/${fora}/posicao`).set(auth(quem)).send({ lat: perto[1], lng: perto[0], origem: 'MAPA' }).expect(403);
      expect(r.body.message).toMatch(/fora da sua área/);
      const s = await t.http().post(`/api/territorio/imoveis/${dentro}/posicao`).set(auth(quem)).send({ lat: perto[1], lng: perto[0], origem: 'MAPA', sequencia: 'Z9' }).expect(403);
      expect(s.body.message).toMatch(/sequência/);
      await t.http().post(`/api/territorio/imoveis/${dentro}/posicao`).set(auth(quem)).send({ lat: perto[1], lng: perto[0], origem: 'MAPA' }).expect(200);
    }
    const h = await db.household.findUniqueOrThrow({ where: { id: fora } });
    expect(h).toMatchObject({ rgSequence: null, geoPrecision: 'GPS_CAMPO' });
    expect((await db.household.findUniqueOrThrow({ where: { id: dentro } })).rgSequence).toBeNull();
    // O mapa da supervisão oferece a ação só no imóvel da zona.
    const caixa = (p: Posicao) => `${p[0] - 0.0005},${p[1] - 0.0005},${p[0] + 0.0005},${p[1] + 0.0005}`;
    const m1 = (
      await t
        .http()
        .get(`/api/territorio/mapa?bbox=${caixa(perto)}`)
        .set(auth(supervisora))
        .expect(200)
    ).body;
    expect(m1.imoveis.find((i: { id: string }) => i.id === dentro).campo).toBe(true);
    const m2 = (
      await t
        .http()
        .get(`/api/territorio/mapa?bbox=${caixa(ponto('seg3', 3000, 3000))}`)
        .set(auth(supervisora))
        .expect(200)
    ).body;
    expect(m2.imoveis.find((i: { id: string }) => i.id === fora).campo).toBe(false);
  });

  // ─── bloqueio#11 ────────────────────────────────────────────────────────────
  it('bloqueio#11: mutação que não muda a ordem não espera a trava; com a trava ocupada, a notificação nova não espera 5 s', async () => {
    await caso('l1', ponto('lat11', 200, 200), 'dengue', dia(-1));
    await t.http().post(`/api/vigilancia/notificacoes/${notificacao.l1}/confirmar`).set(auth(vig)).expect(200);
    await novoPaciente('l2');
    await novaCasa('l2', ponto('lat11', 260, 200), paciente.l2!);
    const c = await pgc();
    try {
      await c.query(`SELECT pg_advisory_lock(hashtext('endemias:bloqueio'))`);
      let t0 = Date.now();
      await t.http().post(`/api/vigilancia/notificacoes/${notificacao.l1}/ciencia`).set(auth(vig)).expect(200);
      expect(Date.now() - t0).toBeLessThan(1500);
      // Edição sem efeito na ordem: o retrato é comparado fora da trava, e nada muda.
      t0 = Date.now();
      await t
        .http()
        .patch(`/api/vigilancia/notificacoes/${notificacao.l1}`)
        .set(auth(vig))
        .send({ ficha: { NM_REFEREN: 'Perto da praça central' } })
        .expect(200);
      expect(Date.now() - t0).toBeLessThan(1500);
      // Notificação nova com a trava ocupada: poucas tentativas curtas, e a varredura liga depois.
      t0 = Date.now();
      await notificar('l2', paciente.l2!, 'dengue', dia(-1));
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(await ligacao('l2')).toBeNull();
    } finally {
      await c.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      await c.end();
    }
    await varredura();
    expect(await ordemDe('l2')).toBe(await ordemDe('l1'));
  });

  // ─── seguranca#7 ────────────────────────────────────────────────────────────
  it('seguranca#7: o aviso da ordem vai só para a sala das endemias (a recepção não recebe; a supervisão recebe)', async () => {
    const base = t.baseUrl.replace('[::1]', '127.0.0.1');
    const conectar = async (token: string) => {
      const s = io(`${base}/rt`, { auth: { token }, transports: ['websocket'], forceNew: true });
      const eventos: string[] = [];
      s.onAny((e: string) => eventos.push(e));
      await new Promise<void>((ok, falha) => {
        s.on('conectado', () => ok());
        s.on('connect_error', (e: Error) => falha(e));
        setTimeout(() => falha(new Error('sem conexão')), 5000);
      });
      return { s, eventos };
    };
    const rec = await conectar(recepcao);
    const sup = await conectar(supervisora);
    try {
      await caso('ws1', ponto('ws7', 200, 200), 'zika', dia(-1));
      expect(await esperar(() => sup.eventos.includes('endemias:ordem'))).toBe(true);
      await espera(300);
      expect(rec.eventos).toContain('vigilancia:notificacao');
      expect(rec.eventos).not.toContain('endemias:ordem');
    } finally {
      rec.s.close();
      sup.s.close();
    }
    const recentes = t.app.get(RealtimeService).recent.filter((e) => e.event === 'endemias:ordem');
    expect(recentes.length).toBeGreaterThan(0);
    expect(recentes.every((e) => e.room === RealtimeService.endemiasRoom(tenantId))).toBe(true);
  });

  // ─── bloqueio#12 ────────────────────────────────────────────────────────────
  it('bloqueio#12: ativas com as atrasadas primeiro e depois da mais antiga para a mais nova, até 500', async () => {
    const agora = Date.now();
    const ano = 2090;
    await db.blockingOrder.createMany({
      data: Array.from({ length: 505 }, (_, i) => ({ year: ano, seq: i + 1, status: 'ABERTA' as const, radiusM: 150, groups: ['dengue'], openedAt: new Date(i < 5 ? agora - (10 + i) * DIA : agora - DIA + i * 1000) })),
    });
    try {
      const lista = (await t.http().get('/api/endemias/bloqueios').set(auth(supervisora)).expect(200)).body as { numero: string; abertaEm: string; atrasada: boolean }[];
      expect(lista).toHaveLength(500);
      const n = lista.filter((o) => o.atrasada).length;
      expect(n).toBe(5);
      expect(lista.slice(0, n).every((o) => o.atrasada)).toBe(true);
      expect(lista[0]!.numero).toBe(`5/${ano}`);
      const datas = (xs: { abertaEm: string }[]) => xs.map((o) => o.abertaEm);
      expect(datas(lista.slice(0, n))).toEqual([...datas(lista.slice(0, n))].sort());
      expect(datas(lista.slice(n))).toEqual([...datas(lista.slice(n))].sort());
    } finally {
      await db.blockingOrder.deleteMany({ where: { year: ano } });
    }
  }, 60_000);

  // ─── bloqueio#5 ─────────────────────────────────────────────────────────────
  /** Cópias de uma notificação (mesmas colunas), com as trocas dadas em SQL; `base` separa a numeração de cada lote. */
  async function copiar(c: Client, molde: string, quantas: number, prefixo: string, sobre: Record<string, string>, base: number) {
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications' AND table_schema = 'public' ORDER BY ordinal_position`)).rows.map((r) => r.column_name as string);
    const expr = cols.map((col) => (col === 'id' ? 'gen_random_uuid()' : col === 'seq' ? `${base} + g` : col === 'number' ? `'${prefixo}/' || (${base} + g)` : col in sobre ? sobre[col] : `t."${col}"`));
    await c.query(`INSERT INTO notifications (${cols.map((x) => `"${x}"`).join(', ')}) SELECT ${expr.join(', ')} FROM notifications t, generate_series(1, ${quantas}) g WHERE t.id = $1`, [molde]);
  }

  it('bloqueio#5: a varredura aplica as regras de avaliar, e as notificações que ele recusaria não ocupam o lote', async () => {
    await caso('y0', ponto('var5', 0, 0), 'dengue', dia(-1));
    const c = await pgc();
    try {
      // 500 notificações conhecidas há 40 dias, sem ordem: avaliar recusa (mais de 30 dias).
      await copiar(c, notificacao.y0!, 500, 'VELHA', { known_at: `now() - interval '40 days'`, symptoms_onset: 'NULL', created_at: `now() - interval '40 days'` }, 800000);
    } finally {
      await c.end();
    }
    await config({ bloqueioAutomatico: false });
    await caso('y1', ponto('var5', 0, 300), 'dengue', dia(0));
    expect(await ligacao('y1')).toBeNull();
    await config({ bloqueioAutomatico: true });
    const r = await varredura();
    expect(r.erros).toBe(0);
    expect(r.avaliadas).toBeLessThan(500);
    expect(await ligacao('y1')).not.toBeNull();
  }, 60_000);

  it('bloqueio#5: com mais de 1.000 casos ativos, a reavaliação põe primeiro quem aguarda a localização', async () => {
    // Molde sem domicílio: caso sem posição nem imóvel, igual ao que a análise calcula (não muda nada ao reavaliar).
    await novoPaciente('molde');
    const molde = await notificar('molde', paciente.molde!, 'dengue', dia(-1));
    const ref = localDateString((await ligacao('molde'))!.referenceDate, 'UTC');
    const enchimento = (await db.blockingOrder.create({ data: { year: 2091, seq: 1, status: 'ABERTA', radiusM: 150, groups: ['dengue'] } })).id;
    const c = await pgc();
    try {
      await copiar(c, molde, 1000, 'ENCH', {}, 810000);
      // Casos com ids menores que qualquer uuid v7: são os primeiros na ordem do id.
      await c.query(
        `INSERT INTO blocking_order_cases (id, order_id, notification_id, patient_id, household_id, group_key, condition_key, lat, lng, precision, block_id, reference_date, active, linked_at)
         SELECT ('00000000-0000-4000-8000-' || lpad(n.g::text, 12, '0'))::uuid, $1::uuid, n.id, n.patient_id, NULL, n.group_key, n.condition_key, NULL, NULL, NULL, NULL, $2::date, true, now()
         FROM (SELECT id, patient_id, group_key, condition_key, row_number() OVER (ORDER BY id) AS g FROM notifications WHERE number LIKE 'ENCH/%') n`,
        [enchimento, ref],
      );
    } finally {
      await c.end();
    }
    try {
      await novoPaciente('loc');
      const h = await novaCasa('loc', null, paciente.loc!);
      await notificar('loc', paciente.loc!, 'dengue', dia(-1));
      const ol = await ordemDe('loc');
      expect((await ordem(ol)).status).toBe('AGUARDANDO_LOCALIZACAO');
      // A posição chega por um caminho sem o gancho (outro cadastro): só a varredura a vê.
      const p = ponto('var5b', 200, 200);
      await db.household.update({ where: { id: h }, data: { latitude: p[1], longitude: p[0], geoPrecision: 'MAPA', geoSource: 'mapa', geoAt: new Date() } });
      await varredura();
      const o = await ordem(ol);
      expect(o.status).toBe('ABERTA');
      expect(o.blocks.length).toBeGreaterThan(0);
    } finally {
      await db.blockingOrderCase.deleteMany({ where: { orderId: enchimento } });
      await db.notification.deleteMany({ where: { number: { startsWith: 'ENCH/' } } });
      await db.blockingOrder.delete({ where: { id: enchimento } });
    }
  }, 180_000);

  // ─── contrato 13 (bloqueio#5 e bloqueio#8): religar os imóveis à malha ───────
  it('a malha que chega depois (religação dos imóveis) refaz na hora a ordem em campo, que a varredura não revisita', async () => {
    // Um lugar sem malha nenhuma, longe das outras grades.
    origem.mal = [-47.3 + (GRADES.length + 2) * 0.05, -12.9];
    await caso('ml', ponto('mal', 200, 200), 'dengue', dia(-1));
    const om = await ordemDe('ml');
    expect(await ordem(om)).toMatchObject({ status: 'ABERTA', blocks: [] });
    expect((await ligacao('ml'))!.blockId).toBeNull();
    // A ordem já está em campo: a varredura só revisita caso de ordem em campo cujo imóvel mudou de posição.
    await db.blockingOrder.update({ where: { id: om }, data: { status: 'EM_CAMPO', startedAt: new Date() } });
    await criarGrade('mal');
    await t.http().post('/api/territorio/imoveis/vincular').set(auth(gestora)).expect(200);
    expect((await db.household.findUniqueOrThrow({ where: { id: casa.ml! } })).blockId).toBe(bloco('mal', 2, 2));
    const o = await ordem(om);
    expect(o.status).toBe('EM_CAMPO');
    expect(o.blocks.map((b) => b.blockId)).toContain(bloco('mal', 2, 2));
    expect((await ligacao('ml'))!.blockId).toBe(bloco('mal', 2, 2));
  });

  // ─── bloqueio#4, terceira rodada: a ação que chega no meio da visita (no fim do arquivo: não muda os pacientes de antes) ─
  /**
   * A visita parada no fim, já dentro da ordem e antes do COMMIT (a trilha de auditoria travada por fora), e a ação da
   * supervisão disparada nesse instante. Com a trava da linha, a ação espera a visita terminar e confere a situação, o
   * progresso e as visitas depois dela; antes, lia tudo sem a visita e só esperava ao gravar a situação.
   */
  async function acaoNoMeioDaVisita(visita: () => ReturnType<typeof visitar>, acao: () => PromiseLike<{ status: number; body: unknown }>) {
    const c = await pgc();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE audit_entries IN ACCESS EXCLUSIVE MODE');
      const enviada = visita();
      expect(await esperar(async () => (await esperas('audit_entries')) > 0)).toBe(true);
      // O supertest devolve um "thenable" sem finally: vira promessa de verdade.
      const feita = Promise.resolve(acao());
      const parou = await esperar(async () => (await esperas('audit_entries', true)) > 0, 5000);
      await c.query('COMMIT');
      return { visita: await enviada, acao: await feita, parou };
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  it('bloqueio#4: a reabertura que chega no meio da visita à ordem concluída conta essa visita e põe a ordem em campo', async () => {
    await caso('tv1', ponto('tvreab', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('tv1');
    await t.http().post(`/api/endemias/bloqueios/${o}/concluir`).set(auth(supervisora)).send({ nota: 'Concluída pela supervisão nesta data' }).expect(200);
    const r = await acaoNoMeioDaVisita(
      () => visitar(casa.tv1!, o),
      () => t.http().post(`/api/endemias/bloqueios/${o}/reabrir`).set(auth(supervisora)).send({ motivo: 'Novo caso confirmado na área' }),
    );
    expect(r.parou).toBe(true);
    expect(r.acao.status).toBe(200);
    const fim = await ordem(o);
    expect(r.visita).toMatchObject({ status: 'OK', avisos: [`A ordem ${fim.seq}/${fim.year} já estava concluída: a visita entrou nela`] });
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { id: r.visita.id } })).orderId).toBe(o);
    // A visita entrou antes da reabertura: a ordem volta em campo (antes, voltava aberta com a visita dentro).
    expect(fim.status).toBe('EM_CAMPO');
    expect(fim.startedAt).not.toBeNull();
  });

  it('bloqueio#4: a conclusão sem nota que chega no meio da visita ao último imóvel vê o progresso completo', async () => {
    await caso('tv2', ponto('tvcon', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('tv2');
    const r = await acaoNoMeioDaVisita(
      () => visitar(casa.tv2!, o),
      () => t.http().post(`/api/endemias/bloqueios/${o}/concluir`).set(auth(supervisora)).send({}),
    );
    // O único imóvel da ordem foi trabalhado pela visita que entrou antes: sem justificativa (antes, 422 JUSTIFICATIVA).
    expect(r.acao.status).toBe(200);
    expect(r.parou).toBe(true);
    expect(r.visita.status).toBe('OK');
    expect(r.visita.avisos).toBeUndefined();
    expect(await ordem(o)).toMatchObject({ status: 'CONCLUIDA', conclusionNote: null });
    expect(await db.vectorVisit.count({ where: { orderId: o } })).toBe(1);
  });

  it('bloqueio#4: a conclusão sem nota que espera o cancelamento em curso diz que a ordem mudou, sem pedir justificativa', async () => {
    await caso('tv3', ponto('tvcan', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('tv3');
    const c = await pgc();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE audit_entries IN ACCESS EXCLUSIVE MODE');
      // O cancelamento para na trilha, com a linha da ordem travada e a situação já gravada.
      const cancelamento = Promise.resolve(t.http().post(`/api/endemias/bloqueios/${o}/cancelar`).set(auth(coordenador)).send({ motivo: 'Epidemia: a ação passa a ser por área' }));
      expect(await esperar(async () => (await esperas('audit_entries')) > 0)).toBe(true);
      // A conclusão lê a ordem ainda aberta, com o imóvel sem visita, e espera a linha.
      const conclusao = Promise.resolve(t.http().post(`/api/endemias/bloqueios/${o}/concluir`).set(auth(supervisora)).send({}));
      expect(await esperar(async () => (await esperas('audit_entries', true)) > 0, 5000)).toBe(true);
      await c.query('COMMIT');
      expect((await cancelamento).status).toBe(200);
      // Com a linha, vê a ordem cancelada: conflito, e não o pedido de justificativa (422) para uma ordem que já acabou.
      const r = await conclusao;
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'CONFLITO', message: 'A ordem mudou enquanto você concluía; abra de novo' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await ordem(o)).toMatchObject({ status: 'CANCELADA', concludedAt: null });
  });

  it('dados-docs#4: a visita de bloqueio sem ordem feita antes do dia da abertura não entra na ordem nem vira o início do campo', async () => {
    await caso('pa1', ponto('pdant', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('pa1');
    // O aparelho ficou sem rede (ou com o relógio atrasado): a visita de bloqueio sem ordem é de 9 dias antes da abertura.
    const r = await visitar(casa.pa1!, null, {}, new Date(Date.now() - 9 * DIA).toISOString());
    expect(r.status).toBe('OK');
    expect(r.avisos).toEqual(['A ordem de bloqueio deste quarteirão foi aberta depois do dia da visita: visita gravada como bloqueio sem ordem']);
    expect(await db.vectorVisit.findUniqueOrThrow({ where: { id: r.id }, select: { orderId: true } })).toEqual({ orderId: null });
    // Antes, a visita entrava na ordem com o início do campo 9 dias antes da abertura: o próprio caso ficava fora da janela.
    expect(await ordem(o)).toMatchObject({ status: 'ABERTA', startedAt: null });
    // O vizinho de hoje, a 10 m, entra na mesma ordem (antes, abria outra sobre os mesmos quarteirões).
    await caso('pa2', ponto('pdant', 210, 200), 'dengue', dia(0));
    expect(await ordemDe('pa2')).toBe(o);
  });

  it('dados-docs#4: com a ordem informada, a visita de dia anterior ao da abertura fica sem a ordem; a do dia, antes da hora, entra e o início do campo fica na abertura', async () => {
    await caso('pi1', ponto('pdinf', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('pi1');
    const { openedAt: aberta, seq, year } = await ordem(o);
    // O aparelho ficou sem rede com o relógio atrasado (ou a data foi digitada): a visita informada é de 9 dias antes da
    // abertura. Antes, ela entrava na ordem, com o início do campo na abertura; agora fica sem a ordem, com o aviso.
    const r = await visitar(casa.pi1!, o, {}, new Date(Date.now() - 9 * DIA).toISOString());
    expect(r.status).toBe('OK');
    expect(r.avisos).toEqual([`A data da visita é anterior à abertura da ordem ${seq}/${year}: visita gravada sem a ordem (confira a data da visita e o relógio do aparelho)`]);
    expect(await db.vectorVisit.findUniqueOrThrow({ where: { id: r.id }, select: { orderId: true } })).toEqual({ orderId: null });
    expect(await ordem(o)).toMatchObject({ status: 'ABERTA', startedAt: null });
    // A do começo do dia da abertura (no fuso da prefeitura), antes da hora dela, entra na ordem.
    const [inicio] = await consultar<{ t: Date }>(`SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) + interval '1 second' AS t`, [tz]);
    expect(localDateString(inicio!.t, tz)).toBe(localDateString(aberta, tz));
    const r2 = await visitar(casa.pi1!, o, {}, inicio!.t.toISOString());
    expect(r2.status).toBe('OK');
    expect(r2.avisos).toEqual([`A hora da visita é anterior à abertura da ordem ${seq}/${year}: confira a hora da visita e o relógio do aparelho`]);
    expect(await db.vectorVisit.findUniqueOrThrow({ where: { id: r2.id }, select: { orderId: true } })).toEqual({ orderId: o });
    const oo = await ordem(o);
    expect(oo.status).toBe('EM_CAMPO');
    // O início do campo não fica antes da abertura (antes da regra do relógio, era a hora da visita).
    expect(oo.startedAt?.getTime()).toBe(aberta.getTime());
    await caso('pi2', ponto('pdinf', 210, 200), 'dengue', dia(0));
    expect(await ordemDe('pi2')).toBe(o);
  });

  it('dados-docs#4: a visita de bloqueio sem ordem do mesmo dia da abertura, feita antes da hora dela, entra na ordem', async () => {
    await caso('pm1', ponto('pddia', 200, 200), 'dengue', dia(-1));
    const o = await ordemDe('pm1');
    const aberta = (await ordem(o)).openedAt;
    // A visita foi feita no começo do dia de hoje (no fuso da prefeitura), antes da abertura da ordem, agora há pouco.
    const [inicio] = await consultar<{ t: Date }>(`SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) + interval '1 second' AS t`, [tz]);
    expect(localDateString(inicio!.t, tz)).toBe(localDateString(aberta, tz));
    const r = await visitar(casa.pm1!, null, {}, inicio!.t.toISOString());
    expect(r.status).toBe('OK');
    expect(r.avisos).toBeUndefined();
    expect(await db.vectorVisit.findUniqueOrThrow({ where: { id: r.id }, select: { orderId: true, visitedAt: true } })).toEqual({ orderId: o, visitedAt: inicio!.t });
    const oo = await ordem(o);
    expect(oo.status).toBe('EM_CAMPO');
    // O início do campo não fica antes da abertura.
    expect(oo.startedAt?.getTime()).toBe(aberta.getTime());
  });

  it('bloqueio#4: a conclusão sem nota que espera a união em curso diz que a ordem mudou, sem pedir justificativa', async () => {
    await caso('tu1', ponto('tvuni', 200, 200), 'dengue', dia(-9));
    // Rascunho sem a data dos sintomas (referência hoje), a 100 m: abre outra ordem.
    await caso('tu2', ponto('tvuni', 300, 200), 'dengue');
    const fica = await ordemDe('tu1');
    const vai = await ordemDe('tu2');
    expect(vai).not.toBe(fica);
    const c = await pgc();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE blocking_order_assignees IN ACCESS EXCLUSIVE MODE');
      // A data dos sintomas põe as duas ordens na mesma janela: a união para nos agentes, com as duas linhas travadas.
      const edicao = Promise.resolve(
        t
          .http()
          .patch(`/api/vigilancia/notificacoes/${notificacao.tu2}`)
          .set(auth(vig))
          .send({ symptomsOnset: dia(-6) }),
      );
      expect(await esperar(async () => (await esperas('blocking_order_assignees')) > 0)).toBe(true);
      // A conclusão da ordem que vai ser unificada lê a ordem ainda aberta, com o imóvel sem visita, e espera a linha.
      const conclusao = Promise.resolve(t.http().post(`/api/endemias/bloqueios/${vai}/concluir`).set(auth(supervisora)).send({}));
      expect(await esperar(async () => (await esperas('blocking_order_assignees', true)) > 0, 4000)).toBe(true);
      await c.query('COMMIT');
      expect((await edicao).status).toBe(200);
      // Com a linha, vê a ordem unificada: conflito, e não o pedido de justificativa (422) para uma ordem que já acabou.
      const r = await conclusao;
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'CONFLITO', message: 'A ordem mudou enquanto você concluía; abra de novo' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await ordem(vai)).toMatchObject({ status: 'CANCELADA', mergedIntoId: fica, concludedAt: null });
    expect(await ordemDe('tu2')).toBe(fica);
    expect(ativas(await ordem(fica))).toBe(2);
  });
});
