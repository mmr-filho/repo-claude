import { randomUUID } from 'node:crypto';
import {
  areaM2,
  caixaDe,
  centroDe,
  cicloBimestral,
  cnsFromBase,
  completeCpf,
  conferirImovelCampo,
  conferirVisitaVetorial,
  localDateString,
  metrosPorGrau,
  normalizarArea,
  ordenarOperacoesAce,
  type Posicao,
} from '@omnisaude/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CampoAceService } from '../src/modules/endemias/campo.service';
import { ehConflitoPassageiro, restricaoCheckViolada } from '../src/modules/endemias/erros-banco';
import { LocalizadorService } from '../src/modules/territorio/localizador.service';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

const enabled = await pgAvailable();

// Grade 5 x 5 de quarteirões de 80 m (ruas de 20 m, passo de 100 m), como em endemias.test.ts: o quarteirão n fica na
// linha floor((n-1)/5) e na coluna (n-1)%5, com centro em (coluna × 100, linha × 100) metros a partir de O.
const O: Posicao = [-49.05, -11.71];
const mpg = metrosPorGrau(O[1]);
const desloca = (p: Posicao, lesteM: number, norteM: number): Posicao => [p[0] + lesteM / mpg.lng, p[1] + norteM / mpg.lat];
const quadrado = (centro: Posicao, lado = 80) => {
  const a = desloca(centro, -lado / 2, -lado / 2);
  const b = desloca(centro, lado / 2, lado / 2);
  return { type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] };
};
const ponto = (x: number, y: number) => desloca(O, x, y);
const em = (minAtras: number, base = Date.now()) => new Date(base - minAtras * 60_000).toISOString();
const A1_TRATADO = { A1: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 } };

type Resultado = { clientId: string; tipo: string; status: string; id: string | null; erro: string | null; avisos?: string[]; ordemId?: string | null };

describe.runIf(enabled)('VIG-3a: campo do ACE e estoque de larvicida (correções da revisão da semana 26)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let campo: CampoAceService;
  let ace = '';
  let supervisora = '';
  let coordenador = '';
  let gestora = '';
  let aceId = '';
  let coordId = '';
  let vigUnit = '';
  let ubsUnit = '';
  let upaUnit = '';
  let depositoVig = '';
  let recepcao = '';
  let medica = '';
  let vig = '';
  let tz = 'America/Sao_Paulo';
  let tenantDb = '';
  const bloco: Record<string, string> = {};
  const lote: Record<string, { produtoId: string; loteId: string; validade: string }> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const sync = (tk: string, operacoes: unknown[]) => t.http().post('/api/endemias/campo/sync').set(auth(tk)).send({ operacoes });
  const resultados = async (tk: string, operacoes: unknown[]) => (await sync(tk, operacoes).expect(200)).body.resultados as Resultado[];
  const saldoNo = async (lotId: string, locationId: string) => Number((await db.stockBalance.findUnique({ where: { locationId_lotId: { locationId, lotId } } }))?.quantity ?? 0);
  const imovelOp = (blockId: string, extra: Record<string, unknown> = {}, minAtras = 600) => ({
    clientId: randomUUID(),
    tipo: 'IMOVEL',
    registradoEm: em(minAtras),
    dados: { blockId, propertyType: '01', street: 'Rua do Campo', number: randomUUID().slice(0, 6), ...extra },
  });
  async function novoImovel(blockId: string, extra: Record<string, unknown> = {}, tk = ace) {
    const [r] = await resultados(tk, [imovelOp(blockId, extra)]);
    expect(r!.status, JSON.stringify(r)).toBe('OK');
    return r!.id!;
  }
  const visita = (householdId: string, v: Record<string, unknown>, minAtras = 30, extra: Record<string, unknown> = {}) => ({
    clientId: randomUUID(),
    tipo: 'VISITA_VETORIAL',
    registradoEm: em(minAtras),
    householdId,
    ...extra,
    visita: { atividade: 'LI_T', situacao: 'TRABALHADO', ...v },
  });
  const bti = (quantidade: number, extra: Record<string, unknown> = {}) => ({ produtoId: lote.BTI2601!.produtoId, loteId: lote.BTI2601!.loteId, quantidade, depositos: 1, ...extra });
  /** Ordem de bloqueio direto no banco: o teste não depende das regras de agrupamento (frente do bloqueio). */
  let seqOrdem = 9000;
  const novaOrdem = async (blockId: string, status: 'ABERTA' | 'EM_CAMPO', openedAt = new Date()) =>
    (
      await db.blockingOrder.create({
        data: { year: 2026, seq: ++seqOrdem, status, radiusM: 150, groups: ['dengue'], openedAt, blocks: { create: [{ blockId, distanceM: 0 }] }, assignees: { create: [{ userId: aceId }] } },
      })
    ).id;
  /** Como a união do bloqueio grava a ordem de origem: cancelada, com a referência da que ficou. */
  const unir = (origem: string, destino: string) =>
    db.blockingOrder.update({
      where: { id: origem },
      data: { status: 'CANCELADA', cancelledAt: new Date(), cancelReason: 'Unificada a outra ordem: os casos ficaram na mesma área e no mesmo período', mergedIntoId: destino },
    });
  const numeroDa = async (id: string) => {
    const o = await db.blockingOrder.findUniqueOrThrow({ where: { id } });
    return `${o.seq}/${o.year}`;
  };
  /**
   * Instante de referência de um cenário cujas visitas sem ordem dependem do ciclo bimestral (recuperação): agora ou, se
   * as visitas de até `janelaMin` minutos atrás cruzariam a virada do ciclo (madrugada de 1º de jan, mar, mai, jul, set
   * ou nov), um instante antes da virada. Assim o cenário fica num ciclo só, a qualquer hora em que a suíte rode.
   */
  const ancoraNoCiclo = (janelaMin: number, agora = Date.now()) => {
    const ciclo = (ms: number) => cicloBimestral(localDateString(new Date(ms), tz)).chave;
    return ciclo(agora - janelaMin * 60_000) === ciclo(agora) ? agora : agora - (janelaMin + 1) * 60_000;
  };
  /** Conexão direta ao banco do município (trava de linha por fora, como a da união do bloqueio). */
  const pgc = async () => {
    const c = new Client({ connectionString: TEST_PG.replace(/\/[^/]*$/, `/${tenantDb}`) });
    await c.connect();
    return c;
  };

  beforeAll(async () => {
    t = await startTestApp('endemiascampo');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    coordenador = await t.login('coordenador', 'Vigilância em Saúde', 'COORDENADOR_ENDEMIAS');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    const info = await tenants.resolve(t.slug);
    tz = info.timeZone;
    tenantDb = info.db.name;
    db = await tenants.client(info.id);
    campo = t.app.get(CampoAceService);
    vigUnit = (await db.unit.findFirstOrThrow({ where: { name: 'Vigilância em Saúde' } })).id;
    ubsUnit = (await db.unit.findFirstOrThrow({ where: { name: 'UBS Centro' } })).id;
    upaUnit = (await db.unit.findFirstOrThrow({ where: { name: 'UPA 24h Norte' } })).id;
    depositoVig = (await db.stockLocation.findFirstOrThrow({ where: { unitId: vigUnit, kind: 'ENDEMIAS' } })).id;
    const localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '8', name: 'Campo Teste' }).expect(201)).body.id;
    for (let lin = 0; lin < 5; lin++)
      for (let col = 0; col < 5; col++) {
        const area = normalizarArea(quadrado(ponto(col * 100, lin * 100)));
        const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
        const [centerLng, centerLat] = centroDe(area);
        const numero = String(lin * 5 + col + 1);
        bloco[numero] = (
          await db.block.create({ data: { localityId: localidade, number: numero, geometry: area as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng, areaM2: areaM2(area), source: 'EDITOR' } })
        ).id;
      }
    aceId = (await db.user.findFirstOrThrow({ where: { name: { contains: 'Agente de Endemias' } } })).id;
    coordId = (await db.user.findFirstOrThrow({ where: { name: { contains: 'Coordenador de Endemias' } } })).id;
    await t
      .http()
      .post('/api/endemias/zonas')
      .set(auth(supervisora))
      .send({ nome: 'Zona Campo', aceId, quarteiroes: Object.values(bloco) })
      .expect(201);
    const p = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    for (const e of p.estoque) lote[e.lote] = { produtoId: e.produtoId, loteId: e.loteId, validade: e.validade };
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close();
  });

  it('pacote: catálogo dos insumos com ou sem saldo; produto sem lote no pacote vira baixa pendente e é resolvido', async () => {
    const novo = (await t.http().post('/api/endemias/estoque/produtos').set(auth(coordenador)).send({ code: 'LAR900', description: 'Espinosade 7,48% (teste)', unit: 'G', tipo: 'LARVICIDA' }).expect(201)).body;
    await db.product.create({ data: { code: 'LAR901', description: 'Larvicida fora de uso', unit: 'G', vectorControl: 'LARVICIDA', active: false } });
    const p = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    expect(p.produtos).toContainEqual({ id: novo.id, codigo: 'LAR900', descricao: 'Espinosade 7,48% (teste)', unidade: 'G', tipo: 'LARVICIDA' });
    expect(p.produtos.map((x: { codigo: string }) => x.codigo)).toEqual(expect.arrayContaining(['LAR001', 'LAR002', 'LAR900']));
    expect(p.produtos.map((x: { codigo: string }) => x.codigo)).not.toContain('LAR901');
    // O estoque continua só com os lotes com saldo; o produto novo não tem lote.
    expect(p.estoque.every((e: { saldo: number }) => e.saldo > 0)).toBe(true);
    expect(p.estoque.map((e: { produtoId: string }) => e.produtoId)).not.toContain(novo.id);

    // O agente usou o produto sem lote no pacote e digitou o número do lote: a visita entra, a baixa fica pendente.
    const casa = await novoImovel(bloco['1']!);
    const op = visita(casa, { depositos: A1_TRATADO, tratamentos: [{ produtoId: novo.id, loteId: null, loteNumero: 'esp2611', quantidade: 2.5, depositos: 1 }] });
    const [r] = await resultados(ace, [op]);
    expect(r).toMatchObject({ status: 'OK' });
    expect(r!.avisos!.join(' ')).toMatch(/Espinosade 7,48% \(teste\): baixa pendente \(lote não cadastrado no depósito\)/);
    const linha = (await db.vectorVisit.findUniqueOrThrow({ where: { clientId: op.clientId }, include: { treatments: true } })).treatments[0]!;
    expect(linha).toMatchObject({ productId: novo.id, lotId: null, lotNumber: 'ESP2611', stockStatus: 'PENDENTE', pendingReason: 'LOTE_DESCONHECIDO', locationId: depositoVig });
    // A remessa é lançada depois e a supervisão baixa no lote certo.
    const entrada = (
      await t
        .http()
        .post('/api/endemias/estoque/entradas')
        .set(auth(coordenador))
        .send({ productId: novo.id, lotNumber: 'ESP2611', expiry: '2027-11-30', quantity: 100, document: 'SIES-ESP-1', origin: 'SIES' })
        .expect(201)
    ).body;
    await t.http().post(`/api/endemias/estoque/pendentes/${linha.id}/resolver`).set(auth(supervisora)).send({ acao: 'BAIXAR', loteId: entrada.loteId, nota: 'Remessa lançada depois da visita' }).expect(200);
    expect(await saldoNo(entrada.loteId, depositoVig)).toBe(97.5);
  });

  it('a observação do imóvel no pacote é só a do controle vetorial (nunca a do cadastro da APS)', async () => {
    const aps = await db.household.create({ data: { street: 'Rua da APS', number: '10', notes: 'Morador acamado, em tratamento de tuberculose', blockId: bloco['2']! } });
    const [r] = await resultados(ace, [imovelOp(bloco['2']!, { observacoes: '  Cachorro bravo no quintal ' })]);
    expect(r!.status).toBe('OK');
    expect(await db.household.findUniqueOrThrow({ where: { id: r!.id! } })).toMatchObject({ vectorNotes: 'Cachorro bravo no quintal', notes: null });
    const p = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    const doPacote = (id: string) => p.imoveis.find((i: { id: string }) => i.id === id);
    expect(doPacote(aps.id).observacao).toBeNull();
    expect(doPacote(r!.id!).observacao).toBe('Cachorro bravo no quintal');
    expect(JSON.stringify(p)).not.toMatch(/tuberculose/);
  });

  it('o GPS da visita não troca o quarteirão do imóvel, nem na religação da malha; fora dele, a posição fica só na visita, com aviso', async () => {
    // 22 m ao sul do quarteirão 3 (borda sul da grade): antes desligava o imóvel do quarteirão (block_id nulo).
    const casa3 = await novoImovel(bloco['3']!);
    const g = ponto(200, -62);
    const op = visita(casa3, { situacao: 'FECHADO', latitude: g[1], longitude: g[0], precisaoGps: 10 }, 20);
    const [r] = await resultados(ace, [op]);
    expect(r!.status).toBe('OK');
    expect(r!.avisos).toEqual(['O GPS da visita ficou a 22 m do quarteirão 3: a posição do imóvel não foi alterada (a supervisão confere)']);
    expect(await db.household.findUniqueOrThrow({ where: { id: casa3 } })).toMatchObject({ blockId: bloco['3'], latitude: null, geoPrecision: null });
    expect(await db.vectorVisit.findUniqueOrThrow({ where: { clientId: op.clientId } })).toMatchObject({ latitude: g[1], longitude: g[0], accuracyM: 10 });
    const p = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    expect(p.imoveis.some((i: { id: string }) => i.id === casa3)).toBe(true);

    // 2 m dentro do quarteirão 14, do outro lado da rua (22 m do 13): antes movia o imóvel para o 14.
    const casa13 = await novoImovel(bloco['13']!);
    const g2 = ponto(262, 200);
    const [r2] = await resultados(ace, [visita(casa13, { situacao: 'FECHADO', latitude: g2[1], longitude: g2[0], precisaoGps: 15 }, 19)]);
    expect(r2!.avisos).toEqual(['O GPS da visita ficou mais perto do quarteirão 14 que do 13, o do imóvel (a 22 m dele): a posição do imóvel não foi alterada (a supervisão confere)']);
    expect(await db.household.findUniqueOrThrow({ where: { id: casa13 } })).toMatchObject({ blockId: bloco['13'], latitude: null });

    // Agente na rua, 12 m do 13 e 8 m do 14: dentro da tolerância do 13, mas a malha ligaria o ponto ao 14 (o mais
    // perto); gravado no imóvel, a próxima religação da malha o moveria. A posição fica só na visita.
    const localizador = t.app.get(LocalizadorService);
    const outra13 = await novoImovel(bloco['13']!);
    const g3 = ponto(252, 200);
    expect((await localizador.quarteiraoDoPonto(db, g3[1], g3[0]))?.id).toBe(bloco['14']);
    const [r3] = await resultados(ace, [visita(outra13, { situacao: 'FECHADO', latitude: g3[1], longitude: g3[0], precisaoGps: 12 }, 18)]);
    expect(r3!.avisos).toEqual(['O GPS da visita ficou mais perto do quarteirão 14 que do 13, o do imóvel (a 12 m dele): a posição do imóvel não foi alterada (a supervisão confere)']);
    expect(await db.household.findUniqueOrThrow({ where: { id: outra13 } })).toMatchObject({ blockId: bloco['13'], latitude: null });

    // Na rua, 5 m do 13 (15 m do 14): a posição é gravada, o quarteirão continua o 13 e a religação não o move.
    const mais13 = await novoImovel(bloco['13']!);
    const g4 = ponto(245, 200);
    const [r4] = await resultados(ace, [visita(mais13, { situacao: 'FECHADO', latitude: g4[1], longitude: g4[0], precisaoGps: 12 }, 17)]);
    expect(r4!.avisos).toBeUndefined();
    expect(await db.household.findUniqueOrThrow({ where: { id: mais13 } })).toMatchObject({ blockId: bloco['13'], latitude: g4[1], longitude: g4[0], geoPrecision: 'GPS_CAMPO', geoSource: 'visita-ace' });
    expect(await localizador.vincularImovel(db, mais13)).toBe(bloco['13']);

    // Quarteirão do imóvel desativado na malha: a visita não posiciona (a supervisão confere o quarteirão).
    const casa18 = await novoImovel(bloco['18']!);
    await db.block.update({ where: { id: bloco['18']! }, data: { active: false } });
    try {
      const g5 = ponto(200, 300);
      const [r5] = await resultados(ace, [visita(casa18, { situacao: 'FECHADO', latitude: g5[1], longitude: g5[0], precisaoGps: 8 }, 16)]);
      expect(r5!.avisos).toEqual(['O quarteirão 18 do imóvel foi desativado na malha: a posição do imóvel não foi alterada (a supervisão confere)']);
      expect(await db.household.findUniqueOrThrow({ where: { id: casa18 } })).toMatchObject({ blockId: bloco['18'], latitude: null });
    } finally {
      await db.block.update({ where: { id: bloco['18']! }, data: { active: true } });
    }
  });

  it('imóvel novo: o quarteirão escolhido manda; o GPS fora dele não vira posição, e a religação da malha não o move nem o desliga', async () => {
    const localizador = t.app.get(LocalizadorService);
    const imovel = async (id: string) => db.household.findUniqueOrThrow({ where: { id } });
    // 22 m ao sul do quarteirão 3, na borda da grade: antes era gravado como GPS_CAMPO e a religação o deixava sem quarteirão.
    const g = ponto(200, -62);
    const [r] = await resultados(ace, [imovelOp(bloco['3']!, { latitude: g[1], longitude: g[0], precisaoGps: 10 })]);
    expect(r).toMatchObject({ status: 'OK', avisos: ['O GPS ficou a 22 m do quarteirão 3: o imóvel entrou no quarteirão 3 sem a posição do GPS (a supervisão confere)'] });
    expect(await imovel(r!.id!)).toMatchObject({ blockId: bloco['3'], latitude: null, longitude: null, geoPrecision: null });
    // Na rua, 12 m do 13 e 8 m do 14: dentro da tolerância do 13, mas a malha liga o ponto ao 14, e a religação o moveria.
    const g2 = ponto(252, 200);
    expect((await localizador.quarteiraoDoPonto(db, g2[1], g2[0]))?.id).toBe(bloco['14']);
    const [r2] = await resultados(ace, [imovelOp(bloco['13']!, { latitude: g2[1], longitude: g2[0], precisaoGps: 12 })]);
    expect(r2).toMatchObject({
      status: 'OK',
      avisos: ['O GPS ficou mais perto do quarteirão 14 que do 13, o escolhido (a 12 m dele): o imóvel entrou no quarteirão 13 sem a posição do GPS (a supervisão confere)'],
    });
    expect(await imovel(r2!.id!)).toMatchObject({ blockId: bloco['13'], latitude: null, geoPrecision: null });
    // Dentro do quarteirão escolhido, ou na rua mais perto dele (5 m do 13, 15 m do 14): a posição é gravada, sem aviso.
    const dentro = ponto(210, 215);
    const rua = ponto(245, 200);
    const noQuarteirao = [imovelOp(bloco['13']!, { latitude: dentro[1], longitude: dentro[0], precisaoGps: 8 }), imovelOp(bloco['13']!, { latitude: rua[1], longitude: rua[0], precisaoGps: 12 })];
    const rs = await resultados(ace, noQuarteirao);
    const [r3, r4] = noQuarteirao.map((op) => rs.find((x) => x.clientId === op.clientId));
    for (const [x, p] of [
      [r3!, dentro],
      [r4!, rua],
    ] as const) {
      expect(x.avisos).toBeUndefined();
      expect(await imovel(x.id!)).toMatchObject({ blockId: bloco['13'], latitude: p[1], longitude: p[0], geoPrecision: 'GPS_CAMPO', geoSource: 'ace' });
    }
    // A religação da malha (importar ou editar quarteirões) não move nem desliga nenhum deles, e todos seguem no pacote.
    await localizador.vincularTodos(db);
    for (const [x, numero] of [
      [r!, '3'],
      [r2!, '13'],
      [r3!, '13'],
      [r4!, '13'],
    ] as const)
      expect((await imovel(x.id!)).blockId).toBe(bloco[numero]);
    const p = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    expect(p.imoveis.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([r!.id, r2!.id, r3!.id, r4!.id]));
    // A visita seguinte com o GPS dentro do quarteirão posiciona o imóvel que ficou sem posição.
    const [v] = await resultados(ace, [visita(r2!.id!, { situacao: 'FECHADO', latitude: dentro[1], longitude: dentro[0], precisaoGps: 8 }, 5)]);
    expect(v).toMatchObject({ status: 'OK' });
    expect(await imovel(r2!.id!)).toMatchObject({ blockId: bloco['13'], latitude: dentro[1], geoPrecision: 'GPS_CAMPO', geoSource: 'visita-ace' });
    // Quarteirão desativado na malha: a malha não liga ponto nenhum a ele, e o GPS também não vira posição.
    await db.block.update({ where: { id: bloco['18']! }, data: { active: false } });
    try {
      const g5 = ponto(200, 300);
      const [r5] = await resultados(ace, [imovelOp(bloco['18']!, { latitude: g5[1], longitude: g5[0], precisaoGps: 8 })]);
      expect(r5).toMatchObject({ status: 'OK', avisos: ['O quarteirão 18 foi desativado na malha: a supervisão confere o quarteirão do imóvel (a posição do GPS não foi gravada)'] });
      expect(await imovel(r5!.id!)).toMatchObject({ blockId: bloco['18'], latitude: null, geoPrecision: null });
    } finally {
      await db.block.update({ where: { id: bloco['18']! }, data: { active: true } });
    }
  });

  it('baixas com os mesmos lotes em ordem inversa, ao mesmo tempo, não se travam (deadlock) nem voltam ERRO', async () => {
    const A = lote.BTI2601!;
    const B = lote.BTI2509!;
    const dep = { A1: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 }, C: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 } };
    const linhas = (x: typeof A, y: typeof A) => [
      { produtoId: x.produtoId, loteId: x.loteId, quantidade: 0.5, depositos: 1 },
      { produtoId: y.produtoId, loteId: y.loteId, quantidade: 0.5, depositos: 1 },
    ];
    const casas = [await novoImovel(bloco['15']!), await novoImovel(bloco['15']!)];
    const antes = { A: await saldoNo(A.loteId, depositoVig), B: await saldoNo(B.loteId, depositoVig) };
    const espiao = vi.spyOn(campo as unknown as { aplicarVisita: (...a: unknown[]) => Promise<unknown> }, 'aplicarVisita');
    const status: string[] = [];
    for (let i = 0; i < 6; i++) {
      const v1 = visita(casas[0]!, { depositos: dep, tratamentos: linhas(A, B) }, 10);
      const v2 = visita(casas[1]!, { depositos: dep, tratamentos: linhas(B, A) }, 10);
      const rs = await Promise.all([sync(ace, [v1]), sync(supervisora, [v2])]);
      for (const r of rs) status.push(`${r.status}:${r.body.resultados?.[0]?.status}:${r.body.resultados?.[0]?.erro ?? ''}`);
    }
    expect(status.filter((s) => s !== '200:OK:')).toEqual([]);
    // As linhas mantêm a ordem em que vieram do aparelho.
    const ultima = await db.vectorVisit.findFirstOrThrow({ where: { householdId: casas[1]! }, orderBy: { syncedAt: 'desc' }, include: { treatments: { orderBy: { seq: 'asc' } } } });
    expect(ultima.treatments.map((x) => x.lotNumber)).toEqual(['BTI2509', 'BTI2601']);
    // Fim de expediente: dois aparelhos com 30 visitas cada, a ordem dos lotes alternada de visita em visita.
    const lote30 = (casa: string, k: number) => Array.from({ length: 30 }, (_, i) => visita(casa, { depositos: dep, tratamentos: (i + k) % 2 ? linhas(B, A) : linhas(A, B) }, 300 - i));
    const [d1, d2] = await Promise.all([resultados(ace, lote30(casas[0]!, 0)), resultados(supervisora, lote30(casas[1]!, 1))]);
    expect([...d1, ...d2].filter((x) => x.status !== 'OK')).toEqual([]);
    // Saldos travados na ordem dos lotes: nenhuma transação foi desfeita para repetir.
    expect(espiao).toHaveBeenCalledTimes(72);
    espiao.mockRestore();
    expect(await saldoNo(A.loteId, depositoVig)).toBe(antes.A - 36);
    expect(await saldoNo(B.loteId, depositoVig)).toBe(antes.B - 36);
  });

  it('conflito entre transações é repetido no servidor; o que sobra volta TENTAR_DE_NOVO, sem detalhe técnico, e o imóvel leva junto as visitas', async () => {
    const espiao = vi.spyOn(campo as unknown as { aplicarVisita: (...a: unknown[]) => Promise<unknown> }, 'aplicarVisita');
    const deadlock = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), { code: 'P2034' });
    expect(ehConflitoPassageiro(deadlock())).toBe(true);
    const casa = await novoImovel(bloco['16']!);
    espiao.mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock());
    const op = visita(casa, { situacao: 'FECHADO' }, 15);
    expect((await resultados(ace, [op]))[0]).toMatchObject({ status: 'OK' });
    expect(espiao).toHaveBeenCalledTimes(3);

    // Erro inesperado (ou o banco fora do ar): fica pendente no aparelho, com texto em português e sem caminho de arquivo.
    espiao.mockClear();
    espiao.mockRejectedValueOnce(new Error('Invalid `tx.stockBalance.updateMany()` invocation in /home/user/repo/apps/api/src/modules/pharmacy/stock.ts:53:43'));
    const op2 = visita(casa, { situacao: 'RECUSADO' }, 14);
    const [r2] = await resultados(ace, [op2]);
    expect(r2).toMatchObject({ status: 'TENTAR_DE_NOVO', id: null, erro: 'Falha passageira no servidor: o registro continua no aparelho e vai no próximo envio' });
    expect(espiao).toHaveBeenCalledTimes(1);
    expect(await db.vectorVisit.count({ where: { clientId: op2.clientId } })).toBe(0);
    // O próximo envio grava.
    expect((await resultados(ace, [op2]))[0]).toMatchObject({ status: 'OK' });
    espiao.mockRestore();

    // Imóvel novo adiado por falha passageira: a visita dele no mesmo lote também fica (e não vira ERRO permanente).
    const espiaoImovel = vi.spyOn(campo as unknown as { aplicarImovel: (...a: unknown[]) => Promise<unknown> }, 'aplicarImovel').mockRejectedValueOnce(new Error('conexão perdida'));
    const novo = imovelOp(bloco['16']!);
    const dele = { clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(5), householdClientId: novo.clientId, visita: { atividade: 'LI', situacao: 'FECHADO' } };
    const rs = await resultados(ace, [dele, novo]);
    expect(rs.map((x) => `${x.tipo}:${x.status}`).sort()).toEqual(['IMOVEL:TENTAR_DE_NOVO', 'VISITA_VETORIAL:TENTAR_DE_NOVO']);
    expect(rs.find((x) => x.tipo === 'VISITA_VETORIAL')!.erro).toMatch(/imóvel novo desta visita ficou para o próximo envio/);
    espiaoImovel.mockRestore();
    expect((await resultados(ace, [dele, novo])).map((x) => x.status)).toEqual(['OK', 'OK']);
  });

  it('visita de imóvel novo gravado ao mesmo tempo por outra requisição (outra aba) espera o imóvel; sem ele, volta ERRO', async () => {
    for (let i = 0; i < 3; i++) {
      const novo = imovelOp(bloco['17']!);
      const dele = { clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(5), householdClientId: novo.clientId, visita: { atividade: 'LI', situacao: 'FECHADO' } };
      const [a, b] = await Promise.all([resultados(ace, [novo]), resultados(ace, [dele])]);
      expect([a[0]!.status, b[0]!.status]).toEqual(['OK', 'OK']);
      expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: dele.clientId } })).householdId).toBe(a[0]!.id);
    }
    // O imóvel nunca chegou (descartado no aparelho, ou ainda na fila): a visita volta ERRO, visível na fila. O texto
    // não diz que o imóvel deu erro: ele não estava neste envio (antes, 'a operação do imóvel deu erro').
    const AINDA_NAO_ACEITO = 'O imóvel novo desta visita ainda não foi aceito pelo servidor: a visita vai de novo quando ele for aceito (se ele foi descartado, descarte também a visita)';
    const orfa = () => ({ clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(5), householdClientId: randomUUID(), visita: { atividade: 'LI', situacao: 'FECHADO' } });
    expect((await resultados(ace, [orfa()]))[0]).toMatchObject({ status: 'ERRO', erro: AINDA_NAO_ACEITO });
    // A espera pelo imóvel de outro envio é uma só por lote (antes, ~0,5 s por visita: 30 visitas levavam 15 s).
    const inicio = Date.now();
    const rs = await resultados(ace, Array.from({ length: 30 }, orfa));
    expect(rs.every((x) => x.status === 'ERRO' && x.erro === AINDA_NAO_ACEITO)).toBe(true);
    expect(Date.now() - inicio).toBeLessThan(6000);

    // O aparelho manda a fila de 100 em 100, os imóveis primeiro: o imóvel recusado no primeiro lote fica com erro no
    // aparelho, e a visita dele, no segundo, não pode dizer que ele vai no próximo envio (só vai depois de corrigido).
    const recusadoAntes = imovelOp(randomUUID());
    expect((await resultados(ace, [recusadoAntes]))[0]).toMatchObject({ status: 'ERRO', erro: 'O quarteirão do imóvel não existe na malha: escolha outro' });
    const [daRecusadaAntes] = await resultados(ace, [
      { clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(5), householdClientId: recusadoAntes.clientId, visita: { atividade: 'LI', situacao: 'FECHADO' } },
    ]);
    expect(daRecusadaAntes).toMatchObject({ status: 'ERRO', erro: AINDA_NAO_ACEITO });
    expect(daRecusadaAntes!.erro).not.toMatch(/próximo envio/);

    // Imóvel lento noutra requisição (mais que a espera de ~0,5 s): a visita volta ERRO com o texto de que ele ainda não
    // foi aceito, e o imóvel volta OK na dele (o aparelho devolve a visita à fila, com o id do servidor).
    const original = (campo as unknown as { aplicarImovel: (...a: unknown[]) => Promise<unknown> }).aplicarImovel.bind(campo);
    const lento = vi.spyOn(campo as unknown as { aplicarImovel: (...a: unknown[]) => Promise<unknown> }, 'aplicarImovel').mockImplementationOnce(async (...a: unknown[]) => {
      await new Promise((r) => setTimeout(r, 1200));
      return original(...a);
    });
    try {
      const novo = imovelOp(bloco['17']!);
      const dele = { clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(5), householdClientId: novo.clientId, visita: { atividade: 'LI', situacao: 'FECHADO' } };
      const doImovel = resultados(ace, [novo]);
      await new Promise((r) => setTimeout(r, 50));
      const [b] = await resultados(ace, [dele]);
      const [a] = await doImovel;
      expect(a).toMatchObject({ status: 'OK' });
      expect(b).toMatchObject({ status: 'ERRO', erro: AINDA_NAO_ACEITO });
      const [denovo] = await resultados(ace, [{ ...dele, householdClientId: null, householdId: a!.id }]);
      expect(denovo).toMatchObject({ status: 'OK' });
    } finally {
      lento.mockRestore();
    }

    // O imóvel estava neste envio e deu erro: o texto continua dizendo isso.
    const recusado = imovelOp(randomUUID());
    const daRecusada = { clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(5), householdClientId: recusado.clientId, visita: { atividade: 'LI', situacao: 'FECHADO' } };
    const rs2 = await resultados(ace, [daRecusada, recusado]);
    expect(rs2.find((x) => x.tipo === 'IMOVEL')).toMatchObject({ status: 'ERRO', erro: 'O quarteirão do imóvel não existe na malha: escolha outro' });
    expect(rs2.find((x) => x.tipo === 'VISITA_VETORIAL')).toMatchObject({ status: 'ERRO', erro: 'O imóvel desta visita não foi cadastrado (a operação do imóvel deu erro)' });
  });

  it('operação fora do formato volta ERRO sozinha, com o campo e o motivo em português; as outras do lote são gravadas', async () => {
    const casa = await novoImovel(bloco['12']!);
    const boa = visita(casa, { situacao: 'FECHADO' }, 50);
    const larvas = visita(casa, { depositos: { C: { inspecionados: 1, comFoco: 1, eliminados: 1, tratados: 0 } }, amostras: [{ numero: 5, deposito: 'C', larvas: 1200 }] }, 40);
    const loteLongo = visita(casa, { depositos: A1_TRATADO, tratamentos: [{ produtoId: lote.BTI2601!.produtoId, loteNumero: 'X'.repeat(41), quantidade: 1, depositos: 1 }] }, 39);
    const obsLonga = visita(casa, { situacao: 'FECHADO', observacoes: 'a'.repeat(1001) }, 38);
    const obsImovel = imovelOp(bloco['12']!, { observacoes: 'b'.repeat(501) });
    const semVisita = { clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(37), householdId: casa };
    const tipoErrado = { clientId: randomUUID(), tipo: 'VISITA', registradoEm: em(36) };
    const dataErrada = { ...visita(casa, { situacao: 'FECHADO' }), registradoEm: 'ontem à tarde' };
    const rs = await resultados(ace, [boa, larvas, loteLongo, obsLonga, obsImovel, semVisita, tipoErrado, dataErrada]);
    const de = (op: { clientId: string }) => rs.find((x) => x.clientId === op.clientId)!;
    expect(de(boa)).toMatchObject({ status: 'OK' });
    expect(await db.vectorVisit.count({ where: { clientId: boa.clientId } })).toBe(1);
    expect(de(larvas)).toMatchObject({ status: 'ERRO', erro: 'Dados inválidos: amostra 1, larvas — no máximo 999' });
    expect(de(loteLongo).erro).toBe('Dados inválidos: produto 1, número do lote — no máximo 40 caracteres');
    expect(de(obsLonga).erro).toBe('Dados inválidos: observação — no máximo 1.000 caracteres');
    expect(de(obsImovel)).toMatchObject({ tipo: 'IMOVEL', status: 'ERRO', erro: 'Dados inválidos: observação — no máximo 500 caracteres' });
    expect(de(semVisita).erro).toBe('Dados inválidos: dados da visita — obrigatório');
    expect(de(tipoErrado)).toMatchObject({ status: 'ERRO', erro: 'Dados inválidos: tipo da operação — tipo de operação desconhecido (use IMOVEL ou VISITA_VETORIAL)' });
    expect(de(dataErrada).erro).toBe('Dados inválidos: data do registro — data e hora inválida (formato ISO 8601, com o fuso)');
    // O envelope: de 1 a 100 operações.
    await sync(ace, []).expect(400);
    await sync(
      ace,
      Array.from({ length: 101 }, () => visita(casa, { situacao: 'FECHADO' })),
    ).expect(400);
    // Imóvel novo sem logradouro nem referência: a mesma conferência do aparelho.
    const [semRua] = await resultados(ace, [imovelOp(bloco['12']!, { street: null })]);
    expect(semRua).toMatchObject({ status: 'ERRO', erro: 'Informe o logradouro ou uma referência do imóvel' });
    // Já gravada antes (a resposta se perdeu) e reenviada num formato que a validação de hoje recusa: sai da fila.
    const [reenvio] = await resultados(ace, [{ ...boa, visita: { ...boa.visita, observacoes: 'a'.repeat(1001) } }]);
    expect(reenvio).toMatchObject({ clientId: boa.clientId, status: 'DUPLICADA', id: de(boa).id });
  });

  it('a conferência compartilhada (aparelho e API) cobre os mesmos limites, com as mensagens que o app mostra', () => {
    const base = { atividade: 'LI_T' as const, situacao: 'TRABALHADO' as const };
    expect(conferirVisitaVetorial({ ...base, depositos: { C: { inspecionados: 1, comFoco: 1, eliminados: 1, tratados: 0 } }, amostras: [{ numero: 5, deposito: 'C', larvas: 1200, pupas: 2 }] })).toEqual([
      'Tubito 5: larvas e pupas de 0 a 999',
    ]);
    expect(
      conferirVisitaVetorial({ ...base, depositos: { A2: { inspecionados: 999, comFoco: 0, eliminados: 0, tratados: 999 } }, tratamentos: [{ produtoId: 'p', loteId: 'l', quantidade: 1, depositos: 1000 }] }),
    ).toContain('Depósitos tratados com cada produto: no máximo 999');
    expect(conferirVisitaVetorial({ ...base, depositos: A1_TRATADO, tratamentos: [{ produtoId: 'p', loteNumero: 'X'.repeat(41), quantidade: 1, depositos: 1 }] })).toEqual(['Número do lote com no máximo 40 caracteres']);
    expect(conferirVisitaVetorial({ ...base, depositos: A1_TRATADO, tratamentos: [{ produtoId: 'p', loteId: 'l', quantidade: 0.0004, depositos: 1 }] })).toEqual(['Quantidade de larvicida de pelo menos 0,001']);
    expect(conferirVisitaVetorial({ ...base, depositos: A1_TRATADO, tratamentos: [{ produtoId: 'p', loteId: 'l', quantidade: 0.0005, depositos: 1 }] })).toEqual([]);
    expect(conferirVisitaVetorial({ atividade: 'LI', situacao: 'FECHADO', observacoes: 'a'.repeat(1001), latitude: -11.7, longitude: -49, precisaoGps: 200_000 })).toEqual([
      'Observação com no máximo 1000 caracteres',
      'Leitura do GPS sem precisão válida (acima de 100 km): faça nova leitura',
    ]);
    // Pendência não leva contagem nenhuma (nem foco sem inspecionado).
    expect(conferirVisitaVetorial({ atividade: 'LI', situacao: 'FECHADO', depositos: { A1: { inspecionados: 0, comFoco: 2, eliminados: 0, tratados: 0 } } })).toEqual([
      'Imóvel fechado, recusado ou abandonado não tem depósitos, amostras nem tratamento: registre só a pendência',
    ]);
    expect(conferirImovelCampo({ blockId: 'b', propertyType: '01', street: 'R', observacoes: 'o'.repeat(501), number: '1'.repeat(21) })).toEqual([
      'Número com no máximo 20 caracteres',
      'Observação com no máximo 500 caracteres',
    ]);
    expect(conferirImovelCampo({ blockId: 'b', propertyType: '01', street: ' ', observacoes: null })).toEqual(['Informe o logradouro ou uma referência do imóvel']);
    expect(conferirImovelCampo({ blockId: 'b', propertyType: '01', observacoes: 'Casa azul ao lado da escola' })).toEqual([]);
  });

  it('quantidade que arredonda para zero e pendência com contagem voltam ERRO; restrição do banco vira mensagem própria', async () => {
    const casa = await novoImovel(bloco['11']!);
    const [r] = await resultados(ace, [visita(casa, { depositos: A1_TRATADO, tratamentos: [bti(0.0004)] })]);
    expect(r).toMatchObject({ status: 'ERRO', erro: 'Dados inválidos: produto 1, quantidade — use pelo menos 0,001' });
    const [r2] = await resultados(ace, [visita(casa, { situacao: 'FECHADO', depositos: { A1: { inspecionados: 0, comFoco: 2, eliminados: 0, tratados: 0 } } })]);
    expect(r2!.status).toBe('ERRO');
    expect(r2!.erro).toMatch(/registre só a pendência/);
    // Uma violação de CHECK que escape da conferência (erro real do banco) volta em português, sem o texto do PostgreSQL.
    const valida = visita(casa, { situacao: 'FECHADO' }, 25);
    expect((await resultados(ace, [valida]))[0]!.status).toBe('OK');
    const v = await db.vectorVisit.findUniqueOrThrow({ where: { clientId: valida.clientId } });
    let erroCheck: unknown;
    try {
      await db.$executeRaw`UPDATE vector_visits SET deposits_positive = deposits_inspected + 1 WHERE id = ${v.id}::uuid`;
    } catch (e) {
      erroCheck = e;
    }
    expect(restricaoCheckViolada(erroCheck)).toBe('vector_visits_contagens');
    const espiao = vi.spyOn(campo as unknown as { aplicarVisita: (...a: unknown[]) => Promise<unknown> }, 'aplicarVisita').mockRejectedValueOnce(erroCheck);
    const [r3] = await resultados(ace, [visita(casa, { situacao: 'FECHADO' })]);
    espiao.mockRestore();
    expect(r3).toMatchObject({ status: 'ERRO', erro: 'As contagens de depósitos não fecham: com foco, eliminados e tratados não podem passar dos inspecionados' });
  });

  it('imóvel novo em quarteirão desativado e relógio do aparelho atrasado: o imóvel entra, com aviso, e a visita dele também', async () => {
    const bid = bloco['19']!;
    const novo = imovelOp(bid, {}, 300);
    const dele = { clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(290), householdClientId: novo.clientId, visita: { atividade: 'LI', situacao: 'FECHADO' } };
    await db.block.update({ where: { id: bid }, data: { active: false } });
    try {
      const rs = await resultados(ace, [dele, novo]);
      const doImovel = rs.find((x) => x.tipo === 'IMOVEL')!;
      expect(doImovel).toMatchObject({ status: 'OK', avisos: ['O quarteirão 19 foi desativado na malha: a supervisão confere o quarteirão do imóvel'] });
      expect(rs.find((x) => x.tipo === 'VISITA_VETORIAL')).toMatchObject({ status: 'OK' });
      expect((await db.household.findUniqueOrThrow({ where: { id: doImovel.id! } })).blockId).toBe(bid);
    } finally {
      await db.block.update({ where: { id: bid }, data: { active: true } });
    }
    // Relógio do aparelho mais de um ano atrás: o imóvel fica com a data do envio (a visita, que conta no ciclo, não).
    const velho = { ...imovelOp(bid), registradoEm: '2025-06-01T12:00:00.000Z' };
    const [r] = await resultados(ace, [velho]);
    expect(r).toMatchObject({ status: 'OK', avisos: ['A data do aparelho tinha mais de um ano: o imóvel ficou com a data do envio (confira o relógio do aparelho)'] });
    const op = await db.fieldSyncOp.findUniqueOrThrow({ where: { clientId: velho.clientId } });
    expect(Date.now() - op.recordedAt.getTime()).toBeLessThan(60_000);
    const [rv] = await resultados(ace, [{ ...visita(r!.id!, { situacao: 'FECHADO' }), registradoEm: '2025-06-01T12:00:00.000Z' }]);
    expect(rv).toMatchObject({ status: 'ERRO', erro: 'Registro com mais de um ano: confira a data do aparelho' });
  });

  it('o relógio dos cenários de recuperação fica num ciclo só, também na madrugada do primeiro dia do ciclo', () => {
    const ciclo = (iso: string) => cicloBimestral(localDateString(new Date(iso), tz)).chave;
    // 1º de janeiro, 6 h: as visitas de 7 e 8 h antes ficariam no ciclo 6 do ano anterior, e as outras no ciclo 1.
    const madrugada = Date.parse('2027-01-01T06:00:00-03:00');
    expect(ciclo(em(480, madrugada))).toBe('2026-6');
    expect(ciclo(em(60, madrugada))).toBe('2027-1');
    const base = ancoraNoCiclo(8 * 60, madrugada);
    expect(base).toBeLessThan(madrugada);
    expect(new Set([480, 420, 300, 240, 200, 180, 120, 60, 0].map((m) => ciclo(em(m, base))))).toEqual(new Set(['2026-6']));
    // 1º de março às 7h59 (a virada a 1 minuto da janela) e às 8h01 (a janela já não a cruza).
    const virada = Date.parse('2027-03-01T07:59:00-03:00');
    expect(new Set([480, 0].map((m) => ciclo(em(m, ancoraNoCiclo(8 * 60, virada)))))).toEqual(new Set(['2027-1']));
    expect(ancoraNoCiclo(8 * 60, Date.parse('2027-03-01T08:01:00-03:00'))).toBe(Date.parse('2027-03-01T08:01:00-03:00'));
    // No meio do ciclo, a base é o próprio agora.
    const meio = Date.parse('2026-11-07T06:00:00-03:00');
    expect(ancoraNoCiclo(8 * 60, meio)).toBe(meio);
  });

  it('recuperação e início da ordem não dependem da ordem de chegada das visitas', async () => {
    // Visitas de até 8 h atrás, todas no mesmo ciclo (a recuperação sem ordem é do ciclo), a qualquer hora da suíte.
    const base = ancoraNoCiclo(8 * 60);
    const visitaAs = (householdId: string, v: Record<string, unknown>, minAtras: number) => ({ ...visita(householdId, v), registradoEm: em(minAtras, base) });
    // O retorno (14 h) chega antes do fechado de outro agente (8 h): o retorno é recuperação.
    const casa = await novoImovel(bloco['9']!);
    const trab = visitaAs(casa, { situacao: 'TRABALHADO', atividade: 'LI', depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } } }, 60);
    const fech = visitaAs(casa, { situacao: 'FECHADO', atividade: 'LI' }, 420);
    await resultados(ace, [trab]);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: trab.clientId } })).recovery).toBe(false);
    await resultados(supervisora, [fech]);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: trab.clientId } })).recovery).toBe(true);

    // Trabalhado de outro agente no meio, chegando por último: ele é a recuperação, e o retorno seguinte deixa de ser.
    const casa2 = await novoImovel(bloco['10']!);
    const fechado = visitaAs(casa2, { situacao: 'FECHADO', atividade: 'LI' }, 480);
    const retorno = visitaAs(casa2, { situacao: 'TRABALHADO', atividade: 'LI', depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } } }, 120);
    await resultados(ace, [fechado, retorno]);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: retorno.clientId } })).recovery).toBe(true);
    const meio = visitaAs(casa2, { situacao: 'TRABALHADO', atividade: 'LI', depositos: { E: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } } }, 300);
    await resultados(supervisora, [meio]);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: meio.clientId } })).recovery).toBe(true);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: retorno.clientId } })).recovery).toBe(false);

    // Mesmo envio com fuso no registradoEm: a ordem é pelo instante, não pelo texto.
    const f = new Date(base - 3 * 3600_000);
    const local = new Date(base - 4 * 3600_000).toISOString().slice(0, 19) + '-03:00'; // 1 h antes da base
    expect(local < f.toISOString()).toBe(true);
    expect(
      ordenarOperacoesAce([
        { tipo: 'VISITA_VETORIAL' as const, registradoEm: local },
        { tipo: 'VISITA_VETORIAL' as const, registradoEm: f.toISOString() },
      ]).map((o) => o.registradoEm),
    ).toEqual([f.toISOString(), local]);
    const casa3 = await novoImovel(bloco['10']!);
    const fech3 = { ...visita(casa3, { situacao: 'FECHADO', atividade: 'LI' }), registradoEm: f.toISOString() };
    const trab3 = { ...visita(casa3, { situacao: 'TRABALHADO', atividade: 'LI', depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } } }), registradoEm: local };
    await resultados(ace, [trab3, fech3]);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: trab3.clientId } })).recovery).toBe(true);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: fech3.clientId } })).recovery).toBe(false);

    // Início em campo: a visita mais antiga, mesmo chegando depois; vale também com a ordem em campo ou concluída. A ordem
    // foi aberta antes de todas as visitas (o início do campo nunca fica antes da abertura).
    const ordem = await novaOrdem(bloco['22']!, 'ABERTA', new Date(base - 300 * 60_000));
    const casa4 = await novoImovel(bloco['22']!);
    const bloqueio = (minAtras: number) => visitaAs(casa4, { atividade: 'BLOQUEIO', situacao: 'FECHADO', ordemId: ordem }, minAtras);
    const v30 = bloqueio(30);
    await resultados(ace, [v30]);
    const visitedAt = async (op: { clientId: string }) => (await db.vectorVisit.findUniqueOrThrow({ where: { clientId: op.clientId } })).visitedAt.getTime();
    expect(await db.blockingOrder.findUniqueOrThrow({ where: { id: ordem } })).toMatchObject({ status: 'EM_CAMPO', startedAt: new Date(await visitedAt(v30)) });
    const v120 = bloqueio(120);
    await resultados(supervisora, [v120]);
    expect((await db.blockingOrder.findUniqueOrThrow({ where: { id: ordem } })).startedAt!.getTime()).toBe(await visitedAt(v120));
    const v60 = bloqueio(60);
    await resultados(ace, [v60]);
    expect((await db.blockingOrder.findUniqueOrThrow({ where: { id: ordem } })).startedAt!.getTime()).toBe(await visitedAt(v120));
    await db.blockingOrder.update({ where: { id: ordem }, data: { status: 'CONCLUIDA', concludedAt: new Date() } });
    const v240 = bloqueio(240);
    const [r240] = await resultados(ace, [v240]);
    expect(r240!.avisos?.join(' ')).toMatch(/já estava concluída/);
    expect(await db.blockingOrder.findUniqueOrThrow({ where: { id: ordem } })).toMatchObject({ status: 'CONCLUIDA', startedAt: new Date(await visitedAt(v240)) });
    // A de antes da abertura (relógio do aparelho atrasado) entra na ordem, com a hora do aparelho e o aviso para conferir
    // o relógio, mas o início fica na abertura.
    const v360 = bloqueio(360);
    expect((await resultados(ace, [v360]))[0]).toMatchObject({
      status: 'OK',
      avisos: [`A hora do aparelho é anterior à abertura da ordem ${await numeroDa(ordem)}: confira a data e a hora do aparelho`, `A ordem ${await numeroDa(ordem)} já estava concluída: a visita entrou nela`],
    });
    expect(await db.vectorVisit.findUniqueOrThrow({ where: { clientId: v360.clientId } })).toMatchObject({ orderId: ordem, visitedAt: new Date(v360.registradoEm) });
    expect(await db.blockingOrder.findUniqueOrThrow({ where: { id: ordem } })).toMatchObject({ status: 'CONCLUIDA', startedAt: new Date(base - 300 * 60_000) });
  });

  it('a recuperação da visita seguinte é refeita pelo escopo dela: o bloqueio trabalhado no meio do ciclo é a anterior da rotina', async () => {
    // As visitas do cenário (até 8 h atrás) no mesmo ciclo, a qualquer hora da suíte.
    const base = ancoraNoCiclo(8 * 60);
    const visitaAs = (householdId: string, v: Record<string, unknown>, minAtras: number) => ({ ...visita(householdId, v), registradoEm: em(minAtras, base) });
    const ordem = await novaOrdem(bloco['21']!, 'EM_CAMPO');
    const casa = await novoImovel(bloco['21']!);
    const trabalhado = { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } };
    const fechado = visitaAs(casa, { atividade: 'LI', situacao: 'FECHADO' }, 480);
    const bloqueio = visitaAs(casa, { atividade: 'BLOQUEIO', situacao: 'TRABALHADO', ordemId: ordem, depositos: trabalhado }, 300);
    const rotina = visitaAs(casa, { atividade: 'LI', situacao: 'TRABALHADO', depositos: trabalhado }, 120);
    for (const [tk, op] of [
      [ace, bloqueio],
      [ace, rotina],
      [supervisora, fechado],
    ] as const)
      expect((await resultados(tk, [op]))[0]!.status).toBe('OK');
    const recuperacao = async (op: { clientId: string }) => (await db.vectorVisit.findUniqueOrThrow({ where: { clientId: op.clientId } })).recovery;
    // O fechado das 8 h chegou por último, mas a anterior da rotina das 14 h no ciclo é o bloqueio trabalhado das 11 h.
    expect(await recuperacao(rotina)).toBe(false);
    expect(await recuperacao(bloqueio)).toBe(false);
    expect(await recuperacao(fechado)).toBe(false);
    // Um fechado entre o bloqueio e a rotina faz da rotina uma recuperação.
    const fechadoDepois = visitaAs(casa, { atividade: 'LI', situacao: 'FECHADO' }, 200);
    expect((await resultados(supervisora, [fechadoDepois]))[0]!.status).toBe('OK');
    expect(await recuperacao(rotina)).toBe(true);
  });

  it('visita de bloqueio sem a ordem informada vai para a ordem ativa mais recente do quarteirão aberta até o dia dela', async () => {
    const antiga = await novaOrdem(bloco['23']!, 'EM_CAMPO', new Date(Date.now() - 20 * 86_400_000));
    const recente = await novaOrdem(bloco['23']!, 'ABERTA', new Date(Date.now() - 3600_000));
    const casa = await novoImovel(bloco['23']!);
    const op = visita(casa, { atividade: 'BLOQUEIO', situacao: 'RECUSADO' }, 10);
    expect((await resultados(ace, [op]))[0]).toMatchObject({ status: 'OK' });
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: op.clientId } })).orderId).toBe(recente);
    expect((await db.blockingOrder.findUniqueOrThrow({ where: { id: recente } })).status).toBe('EM_CAMPO');
    expect(await db.vectorVisit.count({ where: { orderId: antiga } })).toBe(0);
    // A visita de 5 dias atrás (aparelho sem rede) é de antes do dia da abertura da recente: vai para a antiga, que já
    // existia, e é o início do campo dela.
    const cinco = visita(casa, { atividade: 'BLOQUEIO', situacao: 'TRABALHADO', depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } } }, 5 * 24 * 60);
    const [r5] = await resultados(ace, [cinco]);
    expect(r5).toMatchObject({ status: 'OK' });
    expect(r5!.avisos).toBeUndefined();
    const v5 = await db.vectorVisit.findUniqueOrThrow({ where: { clientId: cinco.clientId } });
    expect(v5.orderId).toBe(antiga);
    expect(await db.blockingOrder.findUniqueOrThrow({ where: { id: antiga } })).toMatchObject({ status: 'EM_CAMPO', startedAt: v5.visitedAt });
    // A de 25 dias atrás é de antes das duas: fica como bloqueio sem ordem, com o aviso.
    const vinteCinco = visita(casa, { atividade: 'BLOQUEIO', situacao: 'FECHADO' }, 25 * 24 * 60);
    expect((await resultados(ace, [vinteCinco]))[0]).toMatchObject({
      status: 'OK',
      avisos: ['A ordem de bloqueio deste quarteirão foi aberta depois do dia da visita: visita gravada como bloqueio sem ordem'],
    });
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: vinteCinco.clientId } })).orderId).toBeNull();
    expect(await db.vectorVisit.count({ where: { orderId: recente } })).toBe(1);
    expect(await db.vectorVisit.count({ where: { orderId: antiga } })).toBe(1);
  });

  it('o dia da visita de bloqueio sem ordem é o do fuso da prefeitura, não o do UTC', async () => {
    // A ordem aberta ontem às 0h30 e as visitas das 23h30 da véspera e das 0h10 de ontem, na hora da prefeitura. No UTC, a
    // abertura e a visita da véspera caem no mesmo dia.
    const c = await pgc();
    const [h] = await c
      .query<{ aberta: Date; vespera: Date; mesmoDia: Date }>(
        `SELECT (d + interval '30 minutes') AT TIME ZONE $1 AS aberta, (d - interval '30 minutes') AT TIME ZONE $1 AS vespera, (d + interval '10 minutes') AT TIME ZONE $1 AS "mesmoDia"
         FROM (SELECT date_trunc('day', now() AT TIME ZONE $1) - interval '1 day' AS d) x`,
        [tz],
      )
      .then((r) => r.rows)
      .finally(() => c.end());
    expect(localDateString(h!.vespera, tz)).not.toBe(localDateString(h!.aberta, tz));
    expect(h!.vespera.toISOString().slice(0, 10)).toBe(h!.aberta.toISOString().slice(0, 10));
    const ordem = await novaOrdem(bloco['24']!, 'ABERTA', h!.aberta);
    const casa = await novoImovel(bloco['24']!);
    const vespera = { ...visita(casa, { atividade: 'BLOQUEIO', situacao: 'FECHADO' }), registradoEm: h!.vespera.toISOString() };
    expect((await resultados(ace, [vespera]))[0]).toMatchObject({ status: 'OK', avisos: ['A ordem de bloqueio deste quarteirão foi aberta depois do dia da visita: visita gravada como bloqueio sem ordem'] });
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: vespera.clientId } })).orderId).toBeNull();
    // A das 0h10, antes da abertura e no mesmo dia, entra na ordem; o início do campo fica na abertura.
    const mesmoDia = { ...visita(casa, { atividade: 'BLOQUEIO', situacao: 'FECHADO' }), registradoEm: h!.mesmoDia.toISOString() };
    const [r] = await resultados(ace, [mesmoDia]);
    expect(r).toMatchObject({ status: 'OK' });
    expect(r!.avisos).toBeUndefined();
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: mesmoDia.clientId } })).orderId).toBe(ordem);
    expect(await db.blockingOrder.findUniqueOrThrow({ where: { id: ordem } })).toMatchObject({ status: 'EM_CAMPO', startedAt: h!.aberta });
  });

  it('ordem unificada a outra: a visita segue a cadeia de uniões até a ordem que ficou, se o quarteirão do imóvel está nela', async () => {
    const casa = await novoImovel(bloco['25']!);
    const trabalhado = { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } };
    const bloqueio = (ordemId: string, minAtras: number) => visita(casa, { atividade: 'BLOQUEIO', situacao: 'TRABALHADO', ordemId, depositos: trabalhado }, minAtras);
    const daVisita = (op: { clientId: string }) => db.vectorVisit.findUniqueOrThrow({ where: { clientId: op.clientId } });
    const ordem = (id: string) => db.blockingOrder.findUniqueOrThrow({ where: { id } });
    // Duas uniões seguidas (a 3 foi para a 2, e a 2 depois para a 1): a visita feita na 3 entra na 1, com o início em campo.
    // As ordens foram abertas antes das visitas (o início do campo nunca fica antes da abertura).
    const abertas = new Date(Date.now() - 3 * 3600_000);
    const o1 = await novaOrdem(bloco['25']!, 'ABERTA', abertas);
    const o2 = await novaOrdem(bloco['25']!, 'ABERTA', abertas);
    const o3 = await novaOrdem(bloco['25']!, 'ABERTA', abertas);
    await unir(o3, o2);
    await unir(o2, o1);
    const v1 = bloqueio(o3, 30);
    expect((await resultados(ace, [v1]))[0]).toMatchObject({ status: 'OK', avisos: [`A ordem ${await numeroDa(o3)} foi unificada à ordem ${await numeroDa(o1)}: visita gravada nela`] });
    expect((await daVisita(v1)).orderId).toBe(o1);
    expect(await ordem(o1)).toMatchObject({ status: 'EM_CAMPO', startedAt: (await daVisita(v1)).visitedAt });
    expect(await ordem(o3)).toMatchObject({ status: 'CANCELADA', startedAt: null });
    // A que ficou já concluída recebe a visita, como a ordem concluída informada pelo aparelho (o início em campo recua).
    await db.blockingOrder.update({ where: { id: o1 }, data: { status: 'CONCLUIDA', concludedAt: new Date() } });
    const v2 = bloqueio(o2, 60);
    expect((await resultados(ace, [v2]))[0]).toMatchObject({ status: 'OK', avisos: [`A ordem ${await numeroDa(o2)} foi unificada à ordem ${await numeroDa(o1)}, que já estava concluída: visita gravada nela`] });
    expect((await daVisita(v2)).orderId).toBe(o1);
    expect(await ordem(o1)).toMatchObject({ status: 'CONCLUIDA', startedAt: (await daVisita(v2)).visitedAt });
    // A que ficou não tem o quarteirão do imóvel: como antes, a visita fica sem ordem. As ordens também foram abertas
    // antes das visitas (a visita de antes da abertura da informada ganha o aviso do relógio do aparelho).
    const outra = await novaOrdem(bloco['5']!, 'ABERTA', abertas);
    const o4 = await novaOrdem(bloco['25']!, 'ABERTA', abertas);
    await unir(o4, outra);
    const v3 = bloqueio(o4, 20);
    expect((await resultados(ace, [v3]))[0]).toMatchObject({ status: 'OK', avisos: [`A ordem ${await numeroDa(o4)} foi cancelada: visita gravada sem a ordem`] });
    expect((await daVisita(v3)).orderId).toBeNull();
    expect((await ordem(outra)).status).toBe('ABERTA');
    // Cadeia que não termina (dado inconsistente): a visita para no limite de passos e fica sem ordem.
    const o5 = await novaOrdem(bloco['25']!, 'ABERTA', abertas);
    await unir(o5, o5);
    const v4 = bloqueio(o5, 10);
    expect((await resultados(ace, [v4]))[0]).toMatchObject({ status: 'OK', avisos: [`A ordem ${await numeroDa(o5)} foi cancelada: visita gravada sem a ordem`] });
    expect((await daVisita(v4)).orderId).toBeNull();
    // A sem campo (aberta há 5 h) foi para a que já tinha campo, aberta há 1 h: a visita feita nela há 3 h entra na que
    // ficou, e o início do campo não fica antes da abertura da que ficou (o caso dela continua dentro da janela).
    const semCampo = await novaOrdem(bloco['25']!, 'ABERTA', new Date(Date.now() - 5 * 3600_000));
    const abertaComCampo = new Date(Date.now() - 3600_000);
    const comCampo = await novaOrdem(bloco['25']!, 'EM_CAMPO', abertaComCampo);
    await db.blockingOrder.update({ where: { id: comCampo }, data: { startedAt: new Date(Date.now() - 30 * 60_000) } });
    await unir(semCampo, comCampo);
    const v5 = bloqueio(semCampo, 180);
    expect((await resultados(ace, [v5]))[0]).toMatchObject({ status: 'OK', avisos: [`A ordem ${await numeroDa(semCampo)} foi unificada à ordem ${await numeroDa(comCampo)}: visita gravada nela`] });
    expect((await daVisita(v5)).orderId).toBe(comCampo);
    expect(await ordem(comCampo)).toMatchObject({ status: 'EM_CAMPO', startedAt: abertaComCampo });
  });

  it('a visita que chega durante a união espera a trava da ordem e entra na ordem que ficou', async () => {
    const casa = await novoImovel(bloco['25']!);
    // Abertas antes da visita, que é de 5 min atrás (a de antes da abertura ganharia o aviso do relógio do aparelho).
    const abertas = new Date(Date.now() - 3600_000);
    const ficou = await novaOrdem(bloco['25']!, 'ABERTA', abertas);
    const levada = await novaOrdem(bloco['25']!, 'ABERTA', abertas);
    const c = await pgc();
    try {
      await c.query('BEGIN');
      // Como a união do bloqueio: a linha da ordem travada FOR UPDATE até o fim da transação.
      await c.query('SELECT id FROM blocking_orders WHERE id = $1 FOR UPDATE', [levada]);
      const op = visita(casa, { atividade: 'BLOQUEIO', situacao: 'FECHADO', ordemId: levada }, 5);
      const envio = resultados(ace, [op]);
      const esperando = async () => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()')).rows[0]!.n;
      let esperas = 0;
      for (let i = 0; i < 200 && !esperas; i++) {
        await new Promise((r) => setTimeout(r, 40));
        esperas = await esperando();
      }
      expect(esperas).toBeGreaterThan(0);
      await c.query(`UPDATE blocking_orders SET status = 'CANCELADA', cancelled_at = now(), merged_into_id = $2 WHERE id = $1`, [levada, ficou]);
      await c.query('COMMIT');
      const [r] = await envio;
      // Antes, a visita lia a ordem fora da transação, esperava só na chave estrangeira e entrava na cancelada.
      expect(r).toMatchObject({ status: 'OK', avisos: [`A ordem ${await numeroDa(levada)} foi unificada à ordem ${await numeroDa(ficou)}: visita gravada nela`] });
      expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: op.clientId } })).orderId).toBe(ficou);
      expect(await db.vectorVisit.count({ where: { orderId: levada } })).toBe(0);
      expect((await db.blockingOrder.findUniqueOrThrow({ where: { id: ficou } })).status).toBe('EM_CAMPO');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });

  it('a visita aceita diz em que ordem ficou, no OK e no DUPLICADA: o aparelho marca essa no pacote, não a mais recente', async () => {
    const de = (rs: Resultado[], op: { clientId: string }) => rs.find((r) => r.clientId === op.clientId);
    // Quarteirão 20, com duas ordens ativas: a antiga, aberta há 10 dias, e a recente, há 2 dias. O ACE ficou sem rede e
    // fez visitas de bloqueio sem ordem; o pacote baixado agora já traz a recente.
    const antiga = await novaOrdem(bloco['20']!, 'EM_CAMPO', new Date(Date.now() - 10 * 86_400_000));
    const recente = await novaOrdem(bloco['20']!, 'ABERTA', new Date(Date.now() - 2 * 86_400_000));
    const casa = await novoImovel(bloco['20']!);
    const semOrdem = (minAtras: number) => visita(casa, { atividade: 'BLOQUEIO', situacao: 'FECHADO' }, minAtras);
    const cinco = semOrdem(5 * 24 * 60);
    const vinte = semOrdem(20 * 24 * 60);
    const hoje = semOrdem(10);
    const rotina = visita(casa, { atividade: 'LI', situacao: 'FECHADO' }, 5);
    const ok = await resultados(ace, [cinco, vinte, hoje, rotina]);
    // A de 5 dias é da antiga (a recente não existia); a de 20 dias, de nenhuma; a de hoje, da recente; a rotina, de nenhuma.
    expect(de(ok, cinco)).toMatchObject({ status: 'OK', ordemId: antiga });
    expect(de(ok, vinte)).toMatchObject({ status: 'OK', ordemId: null, avisos: ['A ordem de bloqueio deste quarteirão foi aberta depois do dia da visita: visita gravada como bloqueio sem ordem'] });
    expect(de(ok, hoje)).toMatchObject({ status: 'OK', ordemId: recente });
    expect(de(ok, rotina)).toMatchObject({ status: 'OK', ordemId: null });
    // O reenvio (resposta perdida) diz a ordem da visita já gravada.
    const dup = await resultados(ace, [cinco, vinte, hoje, rotina]);
    for (const [op, ordemId] of [
      [cinco, antiga],
      [vinte, null],
      [hoje, recente],
      [rotina, null],
    ] as const)
      expect(de(dup, op)).toMatchObject({ status: 'DUPLICADA', ordemId });

    // Quarteirão 15: a ordem informada foi unificada à que ficou, ou cancelada, depois que o aparelho a levou.
    const abertas = new Date(Date.now() - 3 * 3600_000);
    const ficou = await novaOrdem(bloco['15']!, 'ABERTA', abertas);
    const levada = await novaOrdem(bloco['15']!, 'ABERTA', abertas);
    const cancelada = await novaOrdem(bloco['15']!, 'ABERTA', abertas);
    await unir(levada, ficou);
    await db.blockingOrder.update({ where: { id: cancelada }, data: { status: 'CANCELADA', cancelledAt: new Date(), cancelReason: 'Epidemia: a ação passa a ser por área' } });
    const casa15 = await novoImovel(bloco['15']!);
    const naOrdem = (ordemId: string, minAtras: number) => visita(casa15, { atividade: 'BLOQUEIO', situacao: 'FECHADO', ordemId }, minAtras);
    const naLevada = naOrdem(levada, 30);
    const naCancelada = naOrdem(cancelada, 20);
    const naQueFicou = naOrdem(ficou, 10);
    const informadas = await resultados(ace, [naLevada, naCancelada, naQueFicou]);
    expect(de(informadas, naLevada)).toMatchObject({ status: 'OK', ordemId: ficou });
    expect(de(informadas, naCancelada)).toMatchObject({ status: 'OK', ordemId: null, avisos: [`A ordem ${await numeroDa(cancelada)} foi cancelada: visita gravada sem a ordem`] });
    expect(de(informadas, naQueFicou)).toMatchObject({ status: 'OK', ordemId: ficou });
    const reenvio = await resultados(ace, [naLevada, naCancelada, naQueFicou]);
    for (const [op, ordemId] of [
      [naLevada, ficou],
      [naCancelada, null],
      [naQueFicou, ficou],
    ] as const)
      expect(de(reenvio, op)).toMatchObject({ status: 'DUPLICADA', ordemId });
    // Reenvio ao mesmo tempo (outra aba) e reenvio que não passa mais na conferência: também dizem a ordem da gravada.
    const outraAba = naOrdem(levada, 8);
    const juntos = await Promise.all([resultados(ace, [outraAba]), resultados(ace, [outraAba])]);
    expect(juntos.map(([r]) => r!.status).sort()).toEqual(['DUPLICADA', 'OK']);
    expect(juntos.map(([r]) => r!.ordemId)).toEqual([ficou, ficou]);
    const invalida = { ...naLevada, visita: { ...naLevada.visita, observacoes: 'x'.repeat(1001) } };
    expect((await resultados(ace, [invalida]))[0]).toMatchObject({ status: 'DUPLICADA', ordemId: ficou });
    // O imóvel novo não tem ordem: o campo não vem.
    const [doImovel] = await resultados(ace, [imovelOp(bloco['15']!)]);
    expect(doImovel!.status).toBe('OK');
    expect(doImovel).not.toHaveProperty('ordemId');
  });

  it('visita informada com a hora do aparelho antes da abertura da informada: fica com a hora do aparelho e ganha o aviso do relógio', async () => {
    // A que ficou foi aberta há 6 h; a informada, há 3 h, foi unificada a ela. O aviso é pela abertura da informada, que o
    // aparelho levou no pacote, e leva o número dela.
    const ficou = await novaOrdem(bloco['11']!, 'ABERTA', new Date(Date.now() - 6 * 3600_000));
    const levada = await novaOrdem(bloco['11']!, 'ABERTA', new Date(Date.now() - 3 * 3600_000));
    const cancelada = await novaOrdem(bloco['11']!, 'ABERTA', new Date(Date.now() - 3 * 3600_000));
    await unir(levada, ficou);
    await db.blockingOrder.update({ where: { id: cancelada }, data: { status: 'CANCELADA', cancelledAt: new Date(), cancelReason: 'Epidemia: a ação passa a ser por área' } });
    const casa = await novoImovel(bloco['11']!);
    const relogio = (n: string) => `A hora do aparelho é anterior à abertura da ordem ${n}: confira a data e a hora do aparelho`;
    // 4 h atrás: antes da abertura da informada (3 h), depois da abertura da que ficou (6 h).
    const atrasada = visita(casa, { atividade: 'BLOQUEIO', situacao: 'FECHADO', ordemId: levada }, 4 * 60);
    expect((await resultados(ace, [atrasada]))[0]).toMatchObject({
      status: 'OK',
      ordemId: ficou,
      avisos: [relogio(await numeroDa(levada)), `A ordem ${await numeroDa(levada)} foi unificada à ordem ${await numeroDa(ficou)}: visita gravada nela`],
    });
    expect(await db.vectorVisit.findUniqueOrThrow({ where: { clientId: atrasada.clientId } })).toMatchObject({ orderId: ficou, visitedAt: new Date(atrasada.registradoEm) });
    // Na cancelada, a visita fica sem ordem e o aviso do relógio vem do mesmo jeito.
    const naCancelada = visita(casa, { atividade: 'BLOQUEIO', situacao: 'FECHADO', ordemId: cancelada }, 5 * 60);
    expect((await resultados(ace, [naCancelada]))[0]).toMatchObject({
      status: 'OK',
      ordemId: null,
      avisos: [relogio(await numeroDa(cancelada)), `A ordem ${await numeroDa(cancelada)} foi cancelada: visita gravada sem a ordem`],
    });
    expect(await db.vectorVisit.findUniqueOrThrow({ where: { clientId: naCancelada.clientId } })).toMatchObject({ orderId: null, visitedAt: new Date(naCancelada.registradoEm) });
    // Depois da abertura da informada: sem o aviso.
    const emDia = visita(casa, { atividade: 'BLOQUEIO', situacao: 'FECHADO', ordemId: levada }, 60);
    expect((await resultados(ace, [emDia]))[0]).toMatchObject({ status: 'OK', ordemId: ficou, avisos: [`A ordem ${await numeroDa(levada)} foi unificada à ordem ${await numeroDa(ficou)}: visita gravada nela`] });
  });

  it('remessas ao mesmo tempo: lote novo em duas guias entra pelas duas; a mesma guia duas vezes, uma só', async () => {
    const produtoId = lote.BTI2601!.produtoId;
    const corpo = (document: string, lotNumber: string) => ({ productId: produtoId, lotNumber, expiry: '2027-10-31', quantity: 100, document, origin: 'SIES' });
    for (let k = 0; k < 3; k++) {
      const rs = await Promise.all(
        ['A', 'B'].map((g) =>
          t
            .http()
            .post('/api/endemias/estoque/entradas')
            .set(auth(coordenador))
            .send(corpo(`GUIA-${g}${k}`, `BTINOVO${k}`)),
        ),
      );
      expect(rs.map((r) => r.status)).toEqual([201, 201]);
      const novo = await db.stockLot.findUniqueOrThrow({ where: { productId_lotNumber: { productId: produtoId, lotNumber: `BTINOVO${k}` } } });
      expect(await db.vectorStockReceipt.count({ where: { lotId: novo.id } })).toBe(2);
      expect(await saldoNo(novo.id, depositoVig)).toBe(200);
    }
    // Quantidade que o estoque (três casas) gravaria como zero: recusada na validação, não no banco.
    await t
      .http()
      .post('/api/endemias/estoque/entradas')
      .set(auth(coordenador))
      .send({ ...corpo('GUIA-ZERO', 'BTINOVO8'), quantity: 0.0004 })
      .expect(400);
    const dupla = await Promise.all([0, 1].map(() => t.http().post('/api/endemias/estoque/entradas').set(auth(coordenador)).send(corpo('GUIA-DUPLA', 'BTINOVO9'))));
    expect(dupla.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(dupla.find((r) => r.status === 409)!.body.message).toBe('A guia GUIA-DUPLA já foi lançada para o lote BTINOVO9');
  });

  it('primeiras entradas ao mesmo tempo numa unidade sem depósito criam um depósito só, de onde sai a baixa', async () => {
    await db.userAssignment.create({ data: { userId: coordId, unitId: upaUnit, role: 'COORDENADOR_ENDEMIAS', cbo: '131205' } });
    await db.userAssignment.create({ data: { userId: aceId, unitId: upaUnit, role: 'ACE', cbo: '515140' } });
    const coordUpa = await t.login('coordenador', 'UPA 24h Norte', 'COORDENADOR_ENDEMIAS');
    const aceUpa = await t.login('ace', 'UPA 24h Norte', 'ACE');
    const rs = await Promise.all(
      ['G-1', 'G-2', 'G-3'].map((document) =>
        t.http().post('/api/endemias/estoque/entradas').set(auth(coordUpa)).send({ productId: lote.BTI2601!.produtoId, lotNumber: 'BTI2601', expiry: lote.BTI2601!.validade, quantity: 10, document, origin: 'SIES' }),
      ),
    );
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
    const depositos = await db.stockLocation.findMany({ where: { unitId: upaUnit, kind: 'ENDEMIAS' } });
    expect(depositos).toHaveLength(1);
    expect(await saldoNo(lote.BTI2601!.loteId, depositos[0]!.id)).toBe(30);
    const p = (await t.http().get('/api/endemias/campo/pacote').set(auth(aceUpa)).expect(200)).body;
    expect(p.estoque.map((e: { lote: string; saldo: number }) => `${e.lote}:${e.saldo}`)).toEqual(['BTI2601:30']);
    const casa = await novoImovel(bloco['20']!, {}, aceUpa);
    const op = visita(casa, { depositos: A1_TRATADO, tratamentos: [bti(15)] });
    const [r] = await resultados(aceUpa, [op]);
    expect(r).toMatchObject({ status: 'OK' });
    expect(r!.avisos).toBeUndefined();
    expect(await saldoNo(lote.BTI2601!.loteId, depositos[0]!.id)).toBe(15);
  });

  it('operação registrada noutra lotação volta ERRO; pendência sem depósito é baixada no depósito escolhido pela supervisão', async () => {
    await db.userAssignment.create({ data: { userId: aceId, unitId: ubsUnit, role: 'ACE', cbo: '515140' } });
    const aceUbs = await t.login('ace', 'UBS Centro', 'ACE');
    const casa = await novoImovel(bloco['14']!);
    const daVigilancia = visita(casa, { depositos: A1_TRATADO, tratamentos: [bti(3)] }, 30, { unitId: vigUnit });
    expect((await resultados(aceUbs, [daVigilancia]))[0]).toMatchObject({
      status: 'ERRO',
      erro: 'Registrado em outra lotação: entre pela unidade da lotação em que registrou para enviar',
    });
    expect(await db.vectorVisit.count({ where: { clientId: daVigilancia.clientId } })).toBe(0);
    // Na lotação certa, grava normalmente.
    expect((await resultados(ace, [daVigilancia]))[0]).toMatchObject({ status: 'OK' });
    // Já gravada, a mesma operação reenviada de qualquer lotação é DUPLICADA (sai da fila).
    expect((await resultados(aceUbs, [daVigilancia]))[0]).toMatchObject({ status: 'DUPLICADA' });

    // Item antigo da fila, sem a unidade: vai na sessão; a UBS não tem depósito e a baixa fica pendente.
    const daUbs = visita(casa, { depositos: A1_TRATADO, tratamentos: [bti(3)] }, 20);
    expect((await resultados(aceUbs, [daUbs]))[0]).toMatchObject({ status: 'OK' });
    const v = await db.vectorVisit.findUniqueOrThrow({ where: { clientId: daUbs.clientId }, include: { treatments: true } });
    expect(v.unitId).toBe(ubsUnit);
    const linha = v.treatments[0]!;
    expect(linha).toMatchObject({ stockStatus: 'PENDENTE', pendingReason: 'SEM_DEPOSITO', locationId: null });
    const pend = (await t.http().get('/api/endemias/estoque/pendentes').set(auth(supervisora)).expect(200)).body.find((x: { id: string }) => x.id === linha.id);
    expect(pend).toMatchObject({ unidadeVisita: 'UBS Centro', depositoId: null, deposito: null, motivo: 'SEM_DEPOSITO' });
    const resolver = (corpo: Record<string, unknown>) => t.http().post(`/api/endemias/estoque/pendentes/${linha.id}/resolver`).set(auth(supervisora)).send(corpo);
    const sem = await resolver({ acao: 'BAIXAR', loteId: lote.BTI2601!.loteId, nota: 'Baixa do larvicida usado' }).expect(422);
    expect(sem.body.message).toBe('A unidade da visita não tem depósito de endemias: escolha o depósito de onde saiu o larvicida');
    const farmacia = await db.stockLocation.findFirstOrThrow({ where: { kind: { not: 'ENDEMIAS' } } });
    await resolver({ acao: 'BAIXAR', loteId: lote.BTI2601!.loteId, depositoId: farmacia.id, nota: 'Baixa do larvicida usado' }).expect(400);
    const antes = await saldoNo(lote.BTI2601!.loteId, depositoVig);
    await resolver({ acao: 'BAIXAR', loteId: lote.BTI2601!.loteId, depositoId: depositoVig, nota: 'Saiu do depósito da Vigilância' }).expect(200);
    expect(await saldoNo(lote.BTI2601!.loteId, depositoVig)).toBe(antes - 3);
    expect(await db.vectorTreatment.findUniqueOrThrow({ where: { id: linha.id } })).toMatchObject({ stockStatus: 'BAIXADO', locationId: depositoVig });
  });

  it('estorno da entrada lançada errada: devolve o saldo, libera a mesma guia e aparece na lista das entradas', async () => {
    const produtoId = lote.BTI2601!.produtoId;
    const corpo = (quantity: number) => ({ productId: produtoId, lotNumber: 'BTIEST1', expiry: '2027-12-31', quantity, document: 'SIES-EST-1', origin: 'SIES' });
    // "25.000" lido como 25.
    const errada = (await t.http().post('/api/endemias/estoque/entradas').set(auth(coordenador)).send(corpo(25)).expect(201)).body;
    const lista = async () => (await t.http().get('/api/endemias/estoque/entradas').set(auth(supervisora)).expect(200)).body as Record<string, unknown>[];
    expect((await lista()).find((e) => e.id === errada.id)).toMatchObject({
      documento: 'SIES-EST-1',
      origem: 'SIES',
      produto: 'Larvicida biológico Bti WG 37,4% (Bacillus thuringiensis israelensis, cepa AM65-52)',
      unidade: 'G',
      lote: 'BTIEST1',
      loteId: errada.loteId,
      quantidade: 25,
      deposito: 'Depósito de Endemias',
      unidadeDeposito: 'Vigilância em Saúde',
      recebidaPor: expect.stringContaining('Coordenador de Endemias'),
      estornadaEm: null,
      estornadaPor: null,
      motivoEstorno: null,
    });
    await t.http().get('/api/endemias/estoque/entradas').set(auth(ace)).expect(403);
    const estorno = (id: string, motivo: string, tk = coordenador) => t.http().post(`/api/endemias/estoque/entradas/${id}/estorno`).set(auth(tk)).send({ motivo });
    await estorno(errada.id, 'Digitado 25 em vez de 25.000', supervisora).expect(403);
    await estorno(errada.id, 'abc').expect(400);
    await estorno(randomUUID(), 'Entrada que não existe').expect(404);
    await estorno(errada.id, 'Digitado 25 em vez de 25.000').expect(200);
    expect(await saldoNo(errada.loteId, depositoVig)).toBe(0);
    const mov = await db.stockMovement.findFirstOrThrow({ where: { refType: 'RemessaEndemias', refId: errada.id, kind: 'ESTORNO_REMESSA' } });
    expect(Number(mov.quantity)).toBe(-25);
    expect(await db.auditEntry.count({ where: { action: 'endemias.estorno_remessa', entityId: errada.id } })).toBe(1);
    expect((await estorno(errada.id, 'Segundo clique no estorno').expect(422)).body.message).toBe('Esta entrada já foi estornada');
    // A mesma guia entra de novo, com a quantidade certa; e só uma vez.
    const certa = (await t.http().post('/api/endemias/estoque/entradas').set(auth(coordenador)).send(corpo(25000)).expect(201)).body;
    await t.http().post('/api/endemias/estoque/entradas').set(auth(coordenador)).send(corpo(25000)).expect(409);
    expect(await saldoNo(certa.loteId, depositoVig)).toBe(25000);
    expect((await lista()).find((e) => e.id === errada.id)).toMatchObject({
      estornadaEm: expect.any(String),
      estornadaPor: expect.stringContaining('Coordenador de Endemias'),
      motivoEstorno: 'Digitado 25 em vez de 25.000',
    });
    // Depois de usado em campo, o estorno da entrada inteira é recusado (o que saiu não volta).
    const casa = await novoImovel(bloco['24']!);
    expect((await resultados(ace, [visita(casa, { depositos: A1_TRATADO, tratamentos: [{ produtoId, loteId: certa.loteId, quantidade: 10, depositos: 1 }] })]))[0]!.status).toBe('OK');
    const recusa = await estorno(certa.id, 'Tentativa depois do uso em campo').expect(422);
    expect(recusa.body.message).toBe('O lote BTIEST1 tem 24.990 G no depósito, menos que os 25.000 G da entrada: o que já foi usado não pode ser estornado');
    expect(await saldoNo(certa.loteId, depositoVig)).toBe(24990);
  });

  // Por último: as ordens abertas pelas notificações (ano corrente, sequência seguinte) não esbarram nas de `novaOrdem`.
  it('ADV6: a ordem que o ACE levou no pacote e foi unificada (data do caso preenchida) leva a visita feita sem rede para a ordem que ficou', async () => {
    const dia = (n: number) => localDateString(new Date(Date.now() + n * 86_400_000), tz);
    let n = 0;
    const caso = async (onde: Posicao, symptomsOnset?: string) => {
      n++;
      const patientId = (
        await t
          .http()
          .post('/api/patients')
          .set(auth(recepcao))
          .send({
            name: `Pessoa Campo ${['Alice', 'Bernardo'][n - 1]} Unificada`,
            birthDate: `198${n}-0${n}-1${n}`,
            sex: n % 2 ? 'F' : 'M',
            cpf: completeCpf(String(497000000 + n)),
            cns: cnsFromBase(String(29700000000 + n)),
            motherName: `Mae Campo ${n}`,
            phone: '(63) 97777-0000',
            address: { cep: '01001000', street: 'Rua do Caso', number: String(n), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
          })
          .expect(201)
      ).body.id as string;
      const householdId = (
        await t
          .http()
          .post('/api/households')
          .set(auth(recepcao))
          .send({ street: 'Rua do Caso', number: String(700 + n), latitude: onde[1], longitude: onde[0], family: { responsibleId: patientId } })
          .expect(201)
      ).body.id as string;
      const notificationId = (
        await t
          .http()
          .post('/api/vigilancia/notificacoes')
          .set(auth(medica))
          .send({ patientId, conditionKey: 'dengue', ...(symptomsOnset ? { symptomsOnset } : {}) })
          .expect(201)
      ).body.id as string;
      return { householdId, notificationId, ordem: async () => (await db.blockingOrderCase.findUniqueOrThrow({ where: { notificationId } })).orderId };
    };
    // Q, com sintomas há nove dias, abre a ordem que vai ficar; P, a 100 m, rascunho sem a data (referência hoje), abre outra.
    const q = await caso(ponto(100, 0), dia(-9));
    const p = await caso(ponto(200, 0));
    const ficou = await q.ordem();
    const levada = await p.ordem();
    expect(levada).not.toBe(ficou);
    const pacote = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    expect(pacote.ordens.map((o: { id: string }) => o.id)).toContain(levada);
    // O ACE, sem rede, trabalha o imóvel de P pela ordem do pacote: depois da abertura das duas ordens e antes da união.
    const feitaEm = new Date().toISOString();
    // A vigilância preenche os sintomas de P (seis dias atrás): as duas ordens viram uma só, a mais nova vai para a mais antiga.
    await t
      .http()
      .patch(`/api/vigilancia/notificacoes/${p.notificationId}`)
      .set(auth(vig))
      .send({ symptomsOnset: dia(-6) })
      .expect(200);
    expect(await db.blockingOrder.findUniqueOrThrow({ where: { id: levada } })).toMatchObject({ status: 'CANCELADA', mergedIntoId: ficou });
    // O ACE envia agora a visita feita antes da união: ela entra na ordem que ficou.
    const op = visita(p.householdId, { atividade: 'BLOQUEIO', situacao: 'TRABALHADO', ordemId: levada, depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } } }, 0, { registradoEm: feitaEm });
    const [r] = await resultados(ace, [op]);
    expect(r).toMatchObject({ status: 'OK', avisos: [`A ordem ${await numeroDa(levada)} foi unificada à ordem ${await numeroDa(ficou)}: visita gravada nela`] });
    const gravada = await db.vectorVisit.findUniqueOrThrow({ where: { clientId: op.clientId } });
    expect(gravada).toMatchObject({ orderId: ficou, visitedAt: new Date(feitaEm) });
    expect(await db.blockingOrder.findUniqueOrThrow({ where: { id: ficou } })).toMatchObject({ status: 'EM_CAMPO', startedAt: gravada.visitedAt });
    const d = (await t.http().get(`/api/endemias/bloqueios/${ficou}`).set(auth(supervisora)).expect(200)).body;
    expect(d).toMatchObject({ status: 'EM_CAMPO', progresso: { trabalhados: 1 } });
  });
});
