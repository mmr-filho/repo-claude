import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, cnsFromBase, completeCpf, localDateString, metrosPorGrau, normalizarArea, type Posicao } from '@omnisaude/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { TerritorioService } from '../src/modules/territorio/territorio.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * A mudança de família (incluir ou tirar a pessoa, pela recepção ou pela sincronização do ACS) refaz na hora o caso da
 * pessoa na ordem de bloqueio, sem esperar a varredura de 5 minutos. Cada cenário usa uma grade própria de 5 x 5
 * quarteirões de 80 m, a 5 km das outras, para os casos de um não agruparem com os de outro.
 */
const enabled = await pgAvailable();

const DIA = 86_400_000;
const GRADES = ['inc', 'acs', 'nova', 'falha'];

describe.runIf(enabled)('VIG-3a: a mudança de família refaz na hora o caso da pessoa na ordem de bloqueio', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let territorio: TerritorioService;
  let recepcao = '';
  let medica = '';
  let acs = '';
  let coordenador = '';
  let tz = 'America/Sao_Paulo';
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

  async function novoPaciente(chave: string) {
    seq++;
    const dados = {
      name: `Pessoa Familia ${chave.toUpperCase()} ${['Andrade', 'Barbosa', 'Cardoso', 'Duarte', 'Esteves', 'Ferraz', 'Gomes', 'Holanda'][seq % 8]} ${'abcdefghij'[seq % 10]}son`,
      birthDate: `${1960 + seq}-0${(seq % 9) + 1}-1${seq % 9}`,
      sex: seq % 2 ? 'F' : 'M',
      cpf: completeCpf(String(496000000 + seq)),
      cns: cnsFromBase(String(29600000000 + seq)),
      motherName: `Mae Familia ${chave}`,
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
  async function casoSemDomicilio(chave: string) {
    await novoPaciente(chave);
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
});
