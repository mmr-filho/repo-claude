import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, conferirImovelCampo, conferirVisitaVetorial, metrosPorGrau, normalizarArea, ordenarOperacoesAce, type Posicao } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CampoAceService } from '../src/modules/endemias/campo.service';
import { ehConflitoPassageiro, restricaoCheckViolada } from '../src/modules/endemias/erros-banco';
import { pgAvailable, startTestApp, type TestApp } from './harness';

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
const em = (minAtras: number) => new Date(Date.now() - minAtras * 60_000).toISOString();
const A1_TRATADO = { A1: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 } };

type Resultado = { clientId: string; tipo: string; status: string; id: string | null; erro: string | null; avisos?: string[] };

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

  beforeAll(async () => {
    t = await startTestApp('endemiascampo');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    coordenador = await t.login('coordenador', 'Vigilância em Saúde', 'COORDENADOR_ENDEMIAS');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
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

  it('o GPS da visita não troca o quarteirão do imóvel; longe dele, a posição fica só na visita, com aviso', async () => {
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
    expect(r2!.avisos?.join(' ')).toMatch(/22 m do quarteirão 13/);
    expect(await db.household.findUniqueOrThrow({ where: { id: casa13 } })).toMatchObject({ blockId: bloco['13'], latitude: null });

    // Agente na rua, 12 m do 13 e 8 m do 14: dentro da tolerância do 13, a posição é gravada e o quarteirão continua o 13.
    const outra13 = await novoImovel(bloco['13']!);
    const g3 = ponto(252, 200);
    const [r3] = await resultados(ace, [visita(outra13, { situacao: 'FECHADO', latitude: g3[1], longitude: g3[0], precisaoGps: 12 }, 18)]);
    expect(r3!.avisos).toBeUndefined();
    expect(await db.household.findUniqueOrThrow({ where: { id: outra13 } })).toMatchObject({ blockId: bloco['13'], latitude: g3[1], longitude: g3[0], geoPrecision: 'GPS_CAMPO', geoSource: 'visita-ace' });
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
    // Saldos travados na ordem dos lotes: nenhuma transação foi desfeita para repetir.
    expect(espiao).toHaveBeenCalledTimes(12);
    espiao.mockRestore();
    expect(await saldoNo(A.loteId, depositoVig)).toBe(antes.A - 6);
    expect(await saldoNo(B.loteId, depositoVig)).toBe(antes.B - 6);
    // As linhas mantêm a ordem em que vieram do aparelho.
    const ultima = await db.vectorVisit.findFirstOrThrow({ where: { householdId: casas[1]! }, orderBy: { syncedAt: 'desc' }, include: { treatments: { orderBy: { seq: 'asc' } } } });
    expect(ultima.treatments.map((x) => x.lotNumber)).toEqual(['BTI2509', 'BTI2601']);
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
    // O imóvel nunca chegou (descartado no aparelho): a visita volta ERRO, visível na fila.
    const orfa = { clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(5), householdClientId: randomUUID(), visita: { atividade: 'LI', situacao: 'FECHADO' } };
    expect((await resultados(ace, [orfa]))[0]).toMatchObject({ status: 'ERRO', erro: 'O imóvel desta visita não foi cadastrado (a operação do imóvel deu erro)' });
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

  it('recuperação e início da ordem não dependem da ordem de chegada das visitas', async () => {
    // O retorno (14 h) chega antes do fechado de outro agente (8 h): o retorno é recuperação.
    const casa = await novoImovel(bloco['9']!);
    const trab = visita(casa, { situacao: 'TRABALHADO', atividade: 'LI', depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } } }, 60);
    const fech = visita(casa, { situacao: 'FECHADO', atividade: 'LI' }, 420);
    await resultados(ace, [trab]);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: trab.clientId } })).recovery).toBe(false);
    await resultados(supervisora, [fech]);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: trab.clientId } })).recovery).toBe(true);

    // Trabalhado de outro agente no meio, chegando por último: ele é a recuperação, e o retorno seguinte deixa de ser.
    const casa2 = await novoImovel(bloco['10']!);
    const fechado = visita(casa2, { situacao: 'FECHADO', atividade: 'LI' }, 480);
    const retorno = visita(casa2, { situacao: 'TRABALHADO', atividade: 'LI', depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } } }, 120);
    await resultados(ace, [fechado, retorno]);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: retorno.clientId } })).recovery).toBe(true);
    const meio = visita(casa2, { situacao: 'TRABALHADO', atividade: 'LI', depositos: { E: { inspecionados: 1, comFoco: 0, eliminados: 1, tratados: 0 } } }, 300);
    await resultados(supervisora, [meio]);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: meio.clientId } })).recovery).toBe(true);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: retorno.clientId } })).recovery).toBe(false);

    // Mesmo envio com fuso no registradoEm: a ordem é pelo instante, não pelo texto.
    const f = new Date(Date.now() - 3 * 3600_000);
    const local = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 19) + '-03:00'; // 1 h atrás
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

    // Início em campo: a visita mais antiga, mesmo chegando depois; vale também com a ordem em campo ou concluída.
    const ordem = await novaOrdem(bloco['22']!, 'ABERTA');
    const casa4 = await novoImovel(bloco['22']!);
    const bloqueio = (minAtras: number) => visita(casa4, { atividade: 'BLOQUEIO', situacao: 'FECHADO', ordemId: ordem }, minAtras);
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
  });

  it('visita de bloqueio sem a ordem informada vai para a ordem ativa mais recente do quarteirão', async () => {
    const antiga = await novaOrdem(bloco['23']!, 'EM_CAMPO', new Date(Date.now() - 20 * 86_400_000));
    const recente = await novaOrdem(bloco['23']!, 'ABERTA', new Date(Date.now() - 3600_000));
    const casa = await novoImovel(bloco['23']!);
    const op = visita(casa, { atividade: 'BLOQUEIO', situacao: 'RECUSADO' }, 10);
    expect((await resultados(ace, [op]))[0]).toMatchObject({ status: 'OK' });
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: op.clientId } })).orderId).toBe(recente);
    expect((await db.blockingOrder.findUniqueOrThrow({ where: { id: recente } })).status).toBe('EM_CAMPO');
    expect(await db.vectorVisit.count({ where: { orderId: antiga } })).toBe(0);
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
});
