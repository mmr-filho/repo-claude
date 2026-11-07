import { randomUUID } from 'node:crypto';
import { areaM2, caixaDe, centroDe, cnsFromBase, completeCpf, localDateString, metrosPorGrau, normalizarArea, type Posicao } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

// Grade 5 x 5 de quarteirões de 80 m (ruas de 20 m, passo de 100 m), longe dos domicílios da demonstração.
const O: Posicao = [-49.05, -11.71];
const mpg = metrosPorGrau(O[1]);
const desloca = (p: Posicao, lesteM: number, norteM: number): Posicao => [p[0] + lesteM / mpg.lng, p[1] + norteM / mpg.lat];
const quadrado = (centro: Posicao, lado = 80) => {
  const a = desloca(centro, -lado / 2, -lado / 2);
  const b = desloca(centro, lado / 2, lado / 2);
  return { type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] };
};
const ponto = (x: number, y: number) => desloca(O, x, y);
const NOMES = ['Alice', 'Bernardo', 'Cecilia', 'Davi', 'Elisa', 'Fabio', 'Gabriela', 'Heitor', 'Iara', 'Joaquim', 'Laura', 'Murilo'];
const SOBRENOMES = ['Andrade', 'Barbosa'];

describe.runIf(enabled)('VIG-3a: ACE em campo e ordem de bloqueio de transmissão', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let recepcao = '';
  let medica = '';
  let vig = '';
  let gestora = '';
  let ace = '';
  let supervisora = '';
  let coordenador = '';
  let localidade = '';
  let tz = 'America/Sao_Paulo';
  const bloco: Record<string, string> = {};
  let aceId = '';
  const casa: Record<string, string> = {};
  const paciente: Record<string, string> = {};
  const notificacao: Record<string, string> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  let seq = 0;

  /** Paciente com domicílio (com ou sem GPS) e uma notificação manual do agravo. */
  async function caso(chave: string, onde: Posicao | null, conditionKey = 'dengue', symptomsOnset?: string) {
    seq++;
    paciente[chave] = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({
          name: `Pessoa Endemias ${NOMES[seq % NOMES.length]} ${SOBRENOMES[Math.floor(seq / NOMES.length) % SOBRENOMES.length]}`,
          birthDate: `19${50 + seq}-0${(seq % 9) + 1}-1${seq % 9}`,
          sex: seq % 2 ? 'F' : 'M',
          cpf: completeCpf(String(493000000 + seq)),
          cns: cnsFromBase(String(29300000000 + seq)),
          motherName: `Mae ${chave}`,
          phone: '(63) 97777-0000',
          address: { cep: '01001000', street: 'Rua do Caso', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
        })
        .expect(201)
    ).body.id;
    casa[chave] = (
      await t
        .http()
        .post('/api/households')
        .set(auth(recepcao))
        .send({ street: 'Rua do Caso', number: String(seq), ...(onde ? { latitude: onde[1], longitude: onde[0] } : {}), family: { responsibleId: paciente[chave] } })
        .expect(201)
    ).body.id;
    notificacao[chave] = (
      await t
        .http()
        .post('/api/vigilancia/notificacoes')
        .set(auth(medica))
        .send({ patientId: paciente[chave], conditionKey, ...(symptomsOnset ? { symptomsOnset } : {}) })
        .expect(201)
    ).body.id;
    return notificacao[chave]!;
  }

  const ordens = async () =>
    (await t.http().get('/api/endemias/bloqueios?situacao=TODAS').set(auth(supervisora)).expect(200)).body as { id: string; status: string; casos: number; quarteiroes: number; agentes: { id: string }[] }[];
  const ordemDe = async (chave: string) => (await db.blockingOrderCase.findUniqueOrThrow({ where: { notificationId: notificacao[chave]! } })).orderId;
  const numerosDaOrdem = async (orderId: string) => {
    const bs = await db.blockingOrderBlock.findMany({ where: { orderId } });
    return (await db.block.findMany({ where: { id: { in: bs.map((b) => b.blockId) } }, select: { number: true } })).map((b) => b.number).sort((a, b) => Number(a) - Number(b));
  };

  beforeAll(async () => {
    t = await startTestApp('endemias');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    ace = await t.login('ace', 'Vigilância em Saúde', 'ACE');
    supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    coordenador = await t.login('coordenador', 'Vigilância em Saúde', 'COORDENADOR_ENDEMIAS');
    const tenants = t.app.get(TenantsService);
    const info = await tenants.resolve(t.slug);
    tz = info.timeZone;
    db = await tenants.client(info.id);
    localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '7', name: 'Endemias Teste' }).expect(201)).body.id;
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
    aceId = (await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000016') } })).id;
  });

  afterAll(async () => {
    await t?.close();
  });

  it('papéis: o ACE não lê prontuário nem a lista de ordens; a vigilância e a gestão acompanham sem alterar', async () => {
    const me = (await t.http().get('/api/auth/me').set(auth(ace)).expect(200)).body;
    expect(me.permissions).toEqual(expect.arrayContaining(['endemias.campo', 'territorio.ler']));
    expect(me.permissions).not.toContain('paciente.ler');
    await t.http().get('/api/patients?q=Maria').set(auth(ace)).expect(403);
    await t.http().get('/api/endemias/bloqueios').set(auth(ace)).expect(403);
    await t.http().get('/api/endemias/campo/pacote').set(auth(medica)).expect(403);
    await t.http().get('/api/endemias/bloqueios').set(auth(vig)).expect(200);
    await t.http().get('/api/endemias/bloqueios').set(auth(gestora)).expect(200);
    await t.http().post(`/api/endemias/bloqueios/${randomUUID()}/concluir`).set(auth(gestora)).send({}).expect(403);
    await t.http().put('/api/endemias/configuracao').set(auth(supervisora)).send({ bloqueioAutomatico: false }).expect(403);
  });

  it('a supervisão monta a zona do ACE com os quarteirões; um quarteirão não fica em duas zonas', async () => {
    const livres = (await t.http().get('/api/endemias/zonas/quarteiroes-livres').set(auth(supervisora)).expect(200)).body;
    expect(livres.filter((b: { localidade: string }) => b.localidade === 'Endemias Teste')).toHaveLength(25);
    const agentes = (await t.http().get('/api/endemias/agentes').set(auth(supervisora)).expect(200)).body;
    expect(agentes.map((a: { id: string }) => a.id)).toContain(aceId);
    const zona = (
      await t
        .http()
        .post('/api/endemias/zonas')
        .set(auth(supervisora))
        .send({ nome: 'Zona Teste', aceId, quarteiroes: Object.values(bloco) })
        .expect(201)
    ).body;
    expect(zona.id).toEqual(expect.any(String));
    const outra = await t
      .http()
      .post('/api/endemias/zonas')
      .set(auth(supervisora))
      .send({ nome: 'Zona Dupla', quarteiroes: [bloco['1']] })
      .expect(409);
    expect(outra.body.message).toMatch(/Zona Teste/);
    // Só agente de endemias (ou supervisor) é titular de zona.
    const medicaId = (await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000003') } })).id;
    await t.http().post('/api/endemias/zonas').set(auth(supervisora)).send({ nome: 'Zona Errada', aceId: medicaId, quarteiroes: [] }).expect(400);
  });

  it('duas notificações próximas geram uma única ordem de bloqueio, com a união dos quarteirões no raio', async () => {
    await caso('p1', ponto(200, 200));
    let lista = await ordens();
    expect(lista).toHaveLength(1);
    const o1 = lista[0]!;
    expect(o1).toMatchObject({ status: 'ABERTA', casos: 1 });
    expect(await numerosDaOrdem(o1.id)).toEqual(['7', '8', '9', '12', '13', '14', '17', '18', '19']);
    // Designada sozinha ao titular da zona atingida.
    expect(o1.agentes.map((a) => a.id)).toEqual([aceId]);
    // Chikungunya a 120 m, no mesmo período: mesma ordem, quarteirões somados.
    await caso('p2', ponto(320, 200), 'chikungunya');
    lista = await ordens();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ id: o1.id, casos: 2 });
    expect(await numerosDaOrdem(o1.id)).toEqual(['7', '8', '9', '10', '12', '13', '14', '15', '17', '18', '19', '20']);
    const detalhe = (await t.http().get(`/api/endemias/bloqueios/${o1.id}`).set(auth(vig)).expect(200)).body;
    expect(detalhe.grupos).toEqual(['chikungunya', 'dengue']);
    expect(
      detalhe.quarteiroes
        .filter((q: { ocorrencia: boolean }) => q.ocorrencia)
        .map((q: { numero: string }) => q.numero)
        .sort(),
    ).toEqual(['13', '14']);
    // Sem nome, documento nem endereço do caso (sigilo da notificação).
    expect(JSON.stringify(detalhe)).not.toMatch(/Pessoa Endemias|Rua do Caso|49300000/);
    // O cartão da ficha da notificação mostra a mesma ordem.
    const cartao = (await t.http().get(`/api/endemias/bloqueios/da-notificacao/${notificacao.p2}`).set(auth(vig)).expect(200)).body;
    expect(cartao.ordem.id).toBe(o1.id);
  });

  it('longe (1 km) ou fora da janela de 7 dias abre outra ordem; sem quarteirão no raio, a ordem fica aberta sem lista', async () => {
    await caso('p3', ponto(1200, 200));
    const o3 = await ordemDe('p3');
    expect(o3).not.toBe(await ordemDe('p1'));
    expect(await numerosDaOrdem(o3)).toEqual([]);
    const dezDias = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    await caso('p4', ponto(200, 300), 'dengue', dezDias);
    const o4 = await ordemDe('p4');
    expect(o4).not.toBe(await ordemDe('p1'));
    expect(o4).not.toBe(o3);
    expect((await db.blockingOrder.findUniqueOrThrow({ where: { id: o4 } })).status).toBe('ABERTA');
  });

  it('duas notificações simultâneas no mesmo lugar não abrem duas ordens', async () => {
    const antes = (await ordens()).length;
    const p6 = ponto(3000, 3000);
    const p7 = ponto(3060, 3000);
    await Promise.all([caso('p6', p6), caso('p7', p7)]);
    expect(await ordemDe('p6')).toBe(await ordemDe('p7'));
    expect((await ordens()).length).toBe(antes + 1);
  });

  it('caso descartado sai da ordem; ordem sem caso e sem trabalho de campo é cancelada', async () => {
    const o3 = await ordemDe('p3');
    await t.http().post(`/api/vigilancia/notificacoes/${notificacao.p3}/descartar`).set(auth(vig)).send({ reason: 'Descartado após investigação clínica' }).expect(200);
    const o = await db.blockingOrder.findUniqueOrThrow({ where: { id: o3 } });
    expect(o.status).toBe('CANCELADA');
    expect(o.cancelReason).toMatch(/Sem caso ativo/);
    expect((await db.blockingOrderCase.findUniqueOrThrow({ where: { notificationId: notificacao.p3! } })).active).toBe(false);
  });

  it('residência sem posição: a ordem aguarda a localização e, localizada perto de outra ordem, une-se a ela', async () => {
    await caso('p5', null);
    const o5 = await ordemDe('p5');
    expect((await db.blockingOrder.findUniqueOrThrow({ where: { id: o5 } })).status).toBe('AGUARDANDO_LOCALIZACAO');
    // A vigilância marca o imóvel no mapa; a varredura reavalia.
    const onde = ponto(100, 200);
    await t.http().post(`/api/territorio/imoveis/${casa.p5}/posicao`).set(auth(vig)).send({ lat: onde[1], lng: onde[0], origem: 'MAPA' }).expect(200);
    await t.http().post('/api/endemias/bloqueios/varredura').set(auth(coordenador)).expect(200);
    const o1 = await ordemDe('p1');
    expect(await ordemDe('p5')).toBe(o1);
    const antiga = await db.blockingOrder.findUniqueOrThrow({ where: { id: o5 } });
    expect(antiga).toMatchObject({ status: 'CANCELADA', mergedIntoId: o1 });
    expect(await numerosDaOrdem(o1)).toEqual(expect.arrayContaining(['6', '11', '16']));
  });

  let bti = { produtoId: '', loteId: '' };
  let ppf = { produtoId: '', loteId: '' };
  const ops: Record<string, Record<string, unknown>> = {};
  const em = (minAtras: number) => new Date(Date.now() - minAtras * 60_000).toISOString();

  it('o pacote do ACE leva a zona, a ordem (sem o ponto nem o agravo do caso) e os larvicidas com saldo', async () => {
    const p = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    expect(p.zonas).toHaveLength(1);
    const o1 = await ordemDe('p1');
    const ordem = p.ordens.find((o: { id: string }) => o.id === o1);
    expect(ordem.quarteiroes.length).toBeGreaterThanOrEqual(12);
    expect(ordem.quarteiroes.filter((q: { ocorrencia: boolean }) => q.ocorrencia).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(p)).not.toMatch(/dengue|chikungunya|Pessoa Endemias/i);
    expect(p.imoveis.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([casa.p1, casa.p2]));
    const lote = (n: string) => p.estoque.find((e: { lote: string }) => e.lote === n);
    expect(lote('BTI2509').saldo).toBe(600);
    // O que vence antes vem primeiro.
    expect(p.estoque[0].lote).toBe('BTI2509');
    bti = { produtoId: lote('BTI2601').produtoId, loteId: lote('BTI2601').loteId };
    ppf = { produtoId: lote('PPF2603').produtoId, loteId: lote('PPF2603').loteId };
  });

  it('o ACE trabalha sem rede e nada duplica ao sincronizar (reenvio em sequência e simultâneo)', async () => {
    const o1 = await ordemDe('p1');
    const terreno = randomUUID();
    const g = ponto(230, 230);
    ops.imovel = {
      clientId: terreno,
      tipo: 'IMOVEL',
      registradoEm: em(50),
      dados: { blockId: bloco['13'], sequencia: '9', propertyType: '03', street: 'Rua do Caso', number: 's/n', latitude: g[1], longitude: g[0], precisaoGps: 8 },
    };
    ops.terreno = {
      clientId: randomUUID(),
      tipo: 'VISITA_VETORIAL',
      registradoEm: em(45),
      householdClientId: terreno,
      visita: {
        atividade: 'BLOQUEIO',
        situacao: 'TRABALHADO',
        ordemId: o1,
        depositos: { C: { inspecionados: 2, comFoco: 1, eliminados: 1, tratados: 1 }, D2: { inspecionados: 3, comFoco: 0, eliminados: 3, tratados: 0 } },
        amostras: [{ numero: 1, deposito: 'C', larvas: 6 }],
        tratamentos: [{ produtoId: bti.produtoId, loteId: bti.loteId, quantidade: 2, depositos: 1 }],
        ubv: 'PERI',
        acaoEducativa: true,
        latitude: g[1],
        longitude: g[0],
        precisaoGps: 8,
      },
    };
    ops.fechado = { clientId: randomUUID(), tipo: 'VISITA_VETORIAL', registradoEm: em(40), householdId: casa.p1, visita: { atividade: 'BLOQUEIO', situacao: 'FECHADO', ordemId: o1, observacoes: 'Ninguém em casa' } };
    ops.semSaldo = {
      clientId: randomUUID(),
      tipo: 'VISITA_VETORIAL',
      registradoEm: em(35),
      householdId: casa.p2,
      visita: {
        atividade: 'BLOQUEIO',
        situacao: 'TRABALHADO',
        ordemId: o1,
        depositos: { A2: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 } },
        tratamentos: [{ produtoId: ppf.produtoId, loteId: ppf.loteId, quantidade: 5, depositos: 1 }],
        acaoEducativa: true,
      },
    };
    ops.invalida = {
      clientId: randomUUID(),
      tipo: 'VISITA_VETORIAL',
      registradoEm: em(30),
      householdId: casa.p2,
      visita: {
        atividade: 'BLOQUEIO',
        situacao: 'TRABALHADO',
        depositos: { B: { inspecionados: 1, comFoco: 1, eliminados: 0, tratados: 1 } },
        tratamentos: [{ produtoId: bti.produtoId, loteId: bti.loteId, quantidade: 1, depositos: 1 }],
      },
    };
    const saldoBti = async () => Number((await db.stockBalance.findFirstOrThrow({ where: { lotId: bti.loteId, location: { kind: 'ENDEMIAS' } } })).quantity);
    const antes = await saldoBti();
    const lote = [ops.invalida, ops.semSaldo, ops.fechado, ops.terreno, ops.imovel];
    const r = (await t.http().post('/api/endemias/campo/sync').set(auth(ace)).send({ operacoes: lote }).expect(200)).body;
    const por = (k: string) => r.resultados.find((x: { clientId: string }) => x.clientId === (ops[k]!.clientId as string));
    expect(por('imovel')).toMatchObject({ status: 'OK', tipo: 'IMOVEL' });
    expect(por('terreno')).toMatchObject({ status: 'OK' });
    expect(por('fechado')).toMatchObject({ status: 'OK' });
    expect(por('semSaldo').status).toBe('OK');
    expect(por('semSaldo').avisos.join(' ')).toMatch(/baixa pendente \(sem saldo suficiente no lote\)/);
    expect(por('invalida')).toMatchObject({ status: 'ERRO' });
    expect(por('invalida').erro).toMatch(/Depósito B não recebe larvicida/);
    expect(await saldoBti()).toBe(antes - 2);
    const imovelNovo = await db.household.findUniqueOrThrow({ where: { id: por('imovel').id } });
    expect(imovelNovo).toMatchObject({ blockId: bloco['13'], rgSequence: '9', propertyType: '03', geoPrecision: 'GPS_CAMPO', unitId: null });
    // A ordem começou em campo com a primeira visita.
    expect((await db.blockingOrder.findUniqueOrThrow({ where: { id: o1 } })).status).toBe('EM_CAMPO');
    const visita = await db.vectorVisit.findUniqueOrThrow({ where: { clientId: ops.terreno.clientId as string }, include: { treatments: true } });
    expect(visita).toMatchObject({ orderId: o1, activity: 'BLOQUEIO', depositsInspected: 5, depositsPositive: 1, depositsEliminated: 4, depositsTreated: 1, samplesCount: 1, ubv: 'PERI', education: true, cbo: '515140' });
    expect(visita.treatments[0]).toMatchObject({ stockStatus: 'BAIXADO', lotNumber: 'BTI2601' });

    // Reenvio do mesmo lote: tudo DUPLICADA, com os mesmos ids; estoque e visitas intactos.
    const visitas = await db.vectorVisit.count();
    const r2 = (
      await t
        .http()
        .post('/api/endemias/campo/sync')
        .set(auth(ace))
        .send({ operacoes: lote.filter((o) => o !== ops.invalida) })
        .expect(200)
    ).body;
    expect(r2.resultados.every((x: { status: string }) => x.status === 'DUPLICADA')).toBe(true);
    expect(r2.resultados.find((x: { clientId: string }) => x.clientId === ops.imovel!.clientId).id).toBe(por('imovel').id);
    expect(await db.vectorVisit.count()).toBe(visitas);
    expect(await saldoBti()).toBe(antes - 2);

    // Duas abas enviando juntas uma visita nova: uma grava, a outra volta DUPLICADA; uma baixa só.
    const nova = {
      clientId: randomUUID(),
      tipo: 'VISITA_VETORIAL',
      registradoEm: em(20),
      householdId: casa.p4,
      visita: {
        atividade: 'LI_T',
        situacao: 'TRABALHADO',
        depositos: { A1: { inspecionados: 1, comFoco: 1, eliminados: 0, tratados: 1 } },
        amostras: [{ numero: 2, deposito: 'A1' }],
        tratamentos: [{ produtoId: bti.produtoId, loteId: bti.loteId, quantidade: 1.5, depositos: 1 }],
      },
    };
    const [a, b] = await Promise.all(
      [1, 2].map(() =>
        t
          .http()
          .post('/api/endemias/campo/sync')
          .set(auth(ace))
          .send({ operacoes: [nova] }),
      ),
    );
    const status = [a!.body.resultados[0].status, b!.body.resultados[0].status].sort();
    expect(status).toEqual(['DUPLICADA', 'OK']);
    expect(await db.vectorVisit.count({ where: { clientId: nova.clientId } })).toBe(1);
    const v = await db.vectorVisit.findUniqueOrThrow({ where: { clientId: nova.clientId }, include: { treatments: true } });
    expect(await db.stockMovement.count({ where: { refType: 'TratamentoFocal', refId: v.treatments[0]!.id } })).toBe(1);
    expect(await saldoBti()).toBe(antes - 3.5);
  });

  it('retorno ao imóvel fechado é recuperação; a supervisão vê as pendências e regulariza a baixa sem saldo', async () => {
    const o1 = await ordemDe('p1');
    const pend = (await t.http().get('/api/endemias/pendencias').set(auth(supervisora)).expect(200)).body;
    expect(pend.find((p: { imovelId: string }) => p.imovelId === casa.p1)).toMatchObject({ situacao: 'FECHADO', tentativas: 1, naOrdem: true });
    const volta = {
      clientId: randomUUID(),
      tipo: 'VISITA_VETORIAL',
      registradoEm: em(5),
      householdId: casa.p1,
      visita: { atividade: 'BLOQUEIO', situacao: 'TRABALHADO', ordemId: o1, depositos: { B: { inspecionados: 4, comFoco: 0, eliminados: 2, tratados: 0 } }, acaoEducativa: true },
    };
    await t
      .http()
      .post('/api/endemias/campo/sync')
      .set(auth(ace))
      .send({ operacoes: [volta] })
      .expect(200);
    expect((await db.vectorVisit.findUniqueOrThrow({ where: { clientId: volta.clientId } })).recovery).toBe(true);
    const depois = (await t.http().get('/api/endemias/pendencias').set(auth(supervisora)).expect(200)).body;
    expect(depois.find((p: { imovelId: string }) => p.imovelId === casa.p1)).toBeUndefined();

    const baixas = (await t.http().get('/api/endemias/estoque/pendentes').set(auth(supervisora)).expect(200)).body;
    const linha = baixas.find((b: { lote: string }) => b.lote === 'PPF2603');
    expect(linha).toMatchObject({ quantidade: 5, motivo: 'SALDO_INSUFICIENTE' });
    await t.http().post(`/api/endemias/estoque/pendentes/${linha.id}/resolver`).set(auth(supervisora)).send({ acao: 'BAIXAR', nota: 'Tentativa de baixa' }).expect(422);
    await t.http().post(`/api/endemias/estoque/pendentes/${linha.id}/resolver`).set(auth(supervisora)).send({ acao: 'REGULARIZAR', nota: 'Contagem física tinha 5 discos' }).expect(200);
    await t.http().post(`/api/endemias/estoque/pendentes/${linha.id}/resolver`).set(auth(supervisora)).send({ acao: 'CANCELAR', nota: 'Segundo clique' }).expect(409);
    const saldo = await db.stockBalance.findFirstOrThrow({ where: { lotId: ppf.loteId, location: { kind: 'ENDEMIAS' } } });
    expect(Number(saldo.quantity)).toBe(0);
    expect(await db.vectorTreatment.findUniqueOrThrow({ where: { id: linha.id } })).toMatchObject({ stockStatus: 'REGULARIZADO' });
  });

  it('a coordenação lança a remessa do larvicida sem duplicar a guia e prorroga a validade de um lote', async () => {
    const corpo = { productId: bti.produtoId, lotNumber: 'BTI2611', expiry: '2027-11-30', quantity: 2500, document: 'SIES-2026-0042', origin: 'SIES' };
    await t.http().post('/api/endemias/estoque/entradas').set(auth(supervisora)).send(corpo).expect(403);
    await t.http().post('/api/endemias/estoque/entradas').set(auth(coordenador)).send(corpo).expect(201);
    await t.http().post('/api/endemias/estoque/entradas').set(auth(coordenador)).send(corpo).expect(409);
    const painel = (await t.http().get('/api/endemias/estoque').set(auth(coordenador)).expect(200)).body;
    const p = painel.produtos.find((x: { id: string }) => x.id === bti.produtoId);
    expect(p.lotes.find((l: { lote: string }) => l.lote === 'BTI2611').saldo).toBe(2500);
    expect(p.consumo30d).toBeGreaterThanOrEqual(3.5);
    const lote = p.lotes.find((l: { lote: string }) => l.lote === 'BTI2509');
    await t.http().post(`/api/endemias/estoque/lotes/${lote.loteId}/validade`).set(auth(coordenador)).send({ validade: '2027-07-31', documento: 'Nota Técnica nº 54/2025-CGARB/DEDT/SVSA/MS' }).expect(200);
    // O larvicida não sai pela dispensação da farmácia.
    expect(await db.auditEntry.count({ where: { action: 'endemias.prorrogar_validade' } })).toBe(1);
  });

  it('progresso por quarteirão; concluir com imóveis sem visita exige justificativa; a ordem sai do pacote do ACE', async () => {
    const o1 = await ordemDe('p1');
    const d = (await t.http().get(`/api/endemias/bloqueios/${o1}`).set(auth(supervisora)).expect(200)).body;
    expect(d.status).toBe('EM_CAMPO');
    expect(d.progresso.trabalhados).toBeGreaterThanOrEqual(3);
    const q13 = d.quarteiroes.find((q: { numero: string }) => q.numero === '13');
    expect(q13.progresso.trabalhados).toBeGreaterThanOrEqual(2);
    const semJustificativa = await t.http().post(`/api/endemias/bloqueios/${o1}/concluir`).set(auth(supervisora)).send({}).expect(422);
    expect(semJustificativa.body.message).toMatch(/justifique/);
    await t.http().post(`/api/endemias/bloqueios/${o1}/concluir`).set(auth(supervisora)).send({ nota: 'Quarteirões percorridos; imóveis restantes na rotina do ciclo' }).expect(200);
    const pacote = (await t.http().get('/api/endemias/campo/pacote').set(auth(ace)).expect(200)).body;
    expect(pacote.ordens.map((o: { id: string }) => o.id)).not.toContain(o1);
    // Notificação nova perto, depois de concluída: outra ordem (a concluída não recebe caso novo).
    await caso('p8', ponto(210, 210));
    expect(await ordemDe('p8')).not.toBe(o1);
  });

  it('produção do período por agente, com os índices larvários preliminares', async () => {
    // O período é de datas locais do município, como a API conta as visitas (antes, a data em UTC falhava das 21 h à
    // meia-noite de Brasília). De ontem a hoje: as visitas deste arquivo são da última hora, que pode começar no dia
    // anterior quando a suíte roda logo depois da meia-noite.
    const de = localDateString(new Date(Date.now() - 86_400_000), tz);
    const ate = localDateString(new Date(), tz);
    const p = (await t.http().get(`/api/endemias/producao?de=${de}&ate=${ate}`).set(auth(vig)).expect(200)).body;
    expect(p.total).toMatchObject({ trabalhados: 4, fechados: 1, recuperados: 1, amostras: 2 });
    expect(p.total.larvicida.find((l: { unidade: string }) => l.unidade === 'G').quantidade).toBe(3.5);
    // Imóveis com foco em qualquer atividade: o terreno (bloqueio) e a casa 4 (LI+T).
    expect(p.total.imoveisComFoco).toBe(2);
    // Os índices são só do levantamento (LI e LI+T): a casa 4, com foco no A1. O bloqueio fica na positividade à parte.
    expect(p.total.indices).toMatchObject({ imoveisInspecionados: 1, imoveisComFoco: 1, iip: 100, classe: 'RISCO' });
    expect(p.total.positividade).toEqual([{ atividade: 'BLOQUEIO', label: 'Bloqueio de transmissão', imoveisInspecionados: 3, imoveisComFoco: 1, percentual: 33.33 }]);
    expect(p.agentes[0].id).toBe(aceId);
  });

  it('as visitas do ACE viram fichas de visita domiciliar e territorial do e-SUS válidas (CBO 515140, sem equipe)', async () => {
    const vigUnit = await db.unit.findFirstOrThrow({ where: { name: 'Vigilância em Saúde' } });
    const hoje = new Date().toISOString().slice(0, 10);
    const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const batch = (await t.http().post('/api/esus/batches').set(auth(gestora)).send({ unitId: vigUnit.id, from: ontem, to: hoje }).expect(201)).body;
    const fichas = batch.records.filter((r: { kind: number; sourceType: string }) => r.kind === 8 && r.sourceType === 'VectorVisit');
    expect(fichas.length).toBeGreaterThanOrEqual(1);
    for (const f of fichas) expect(f.status, JSON.stringify(f.issues)).toBe('GERADA');
    expect(fichas.reduce((s: number, f: { summary: { visitas: number } }) => s + f.summary.visitas, 0)).toBe(await db.vectorVisit.count({ where: { unitId: vigUnit.id } }));
    expect(fichas[0].summary.profissional).toBe('Rafael Souza Agente de Endemias');
  });

  it('com o bloqueio automático desligado (epidemia), a notificação não abre ordem', async () => {
    await t.http().put('/api/endemias/configuracao').set(auth(coordenador)).send({ bloqueioAutomatico: false }).expect(200);
    await caso('p9', ponto(4000, 4000));
    expect(await db.blockingOrderCase.findUnique({ where: { notificationId: notificacao.p9! } })).toBeNull();
    await t.http().put('/api/endemias/configuracao').set(auth(coordenador)).send({ bloqueioAutomatico: true }).expect(200);
    await t.http().post('/api/endemias/bloqueios/varredura').set(auth(coordenador)).expect(200);
    expect(await db.blockingOrderCase.findUnique({ where: { notificationId: notificacao.p9! } })).not.toBeNull();
  });
});
