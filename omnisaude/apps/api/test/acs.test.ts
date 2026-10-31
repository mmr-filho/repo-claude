import { TIPO_DADO } from '@omnisaude/esus';
import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const agora = (minutosAtras: number) => new Date(Date.now() - minutosAtras * 60_000).toISOString();

describe.runIf(enabled)('App do ACS: território, sincronização sem internet, visitas, e-SUS e produtividade', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let enfermeira: string;
  let acs: string;
  let ubsId = '';
  let teamId = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const endereco = { cep: '77405070', street: 'Rua das Visitas', number: '7', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  const ids = { pessoa: randomUUID(), filha: randomUUID(), domicilio: randomUUID(), visita: randomUUID(), visitaImovel: randomUUID() };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('acs', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    enfermeira = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
    acs = await t.login('acs', 'UBS Centro', 'ACS');
    const me = (await t.http().get('/api/auth/me').set(auth(gestora)).expect(200)).body;
    ubsId = me.context.unitId;
    const equipes = (await t.http().get('/api/programas/equipes').set(auth(gestora)).expect(200)).body;
    teamId = equipes.equipes.find((e: { name: string }) => e.name === 'ESF Centro I').id;
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('mostra ao agente o território da sua microárea, com famílias, pessoas, prioridades e última visita', async () => {
    const me = (await t.http().get('/api/auth/me').set(auth(acs)).expect(200)).body;
    expect(me.context.role).toBe('ACS');
    expect(me.permissions).toEqual(expect.arrayContaining(['acs.campo', 'acs.territorio', 'paciente.cadastrar']));
    expect(me.permissions).not.toContain('prontuario.evoluir');

    const terr = (await t.http().get('/api/acs/territorio').set(auth(acs)).expect(200)).body;
    expect(terr.agente).toMatchObject({ microArea: '01', ine: '0000000101' });
    expect(terr.domicilios.length).toBeGreaterThan(3);
    expect(terr.resumo.pessoas).toBeGreaterThan(3);
    expect(terr.resumo.visitados30d).toBeGreaterThanOrEqual(1);
    const comVisita = terr.domicilios.find((d: { ultimaVisita: unknown }) => d.ultimaVisita);
    expect(comVisita.ultimaVisita).toMatchObject({ desfecho: '1', desfechoLabel: 'Visita realizada' });
    const membro = terr.domicilios.flatMap((d: { familias: { membros: { prioridades: string[] }[] }[] }) => d.familias.flatMap((f) => f.membros)).find((m: { prioridades: string[] }) => m.prioridades.length);
    expect(membro).toBeDefined();
    expect(terr.domicilios.every((d: { latitude: number | null }) => typeof d.latitude === 'number')).toBe(true);

    await t.http().get('/api/acs/territorio').set(auth(recepcao)).expect(403);
    const daEquipe = (await t.http().get(`/api/acs/territorio?teamId=${teamId}&microArea=01`).set(auth(enfermeira)).expect(200)).body;
    expect(daEquipe.domicilios.length).toBe(terr.domicilios.length);
    expect(daEquipe.escopo).toContain('ESF Centro I');
  });

  it('sincroniza o que foi registrado no aparelho (pessoa, domicílio, visita) e reconhece o reenvio como duplicado', async () => {
    const operacoes = [
      {
        tipo: 'VISITA',
        clientId: ids.visita,
        registradoEm: agora(20),
        householdClientId: ids.domicilio,
        patientClientId: ids.pessoa,
        visita: { motivos: ['1', '29', '11'], desfecho: '1', sistolica: 128, diastolica: 84, pesoKg: 71.4, latitude: -11.7301, longitude: -49.0702, observacoes: 'Orientada sobre a medicação.' },
      },
      {
        tipo: 'DOMICILIO',
        clientId: ids.domicilio,
        registradoEm: agora(40),
        dados: { ...endereco, dwellingType: '01', tenure: '01', waterSupply: '01', sewage: '01', garbage: '01', electricity: true, rooms: 3, latitude: -11.7301, longitude: -49.0702 },
        familia: { responsavelClientId: ids.pessoa, incomeBracket: '02' },
      },
      {
        tipo: 'PESSOA',
        clientId: ids.filha,
        registradoEm: agora(30),
        dados: { name: 'Lívia Campo Teste', birthDate: day(-400), sex: 'F', motherName: 'Rosa Campo Teste', endereco },
        familiaClientId: ids.domicilio,
        kinship: '03',
      },
      {
        tipo: 'PESSOA',
        clientId: ids.pessoa,
        registradoEm: agora(45),
        dados: { name: 'Rosa Campo Teste', birthDate: '1979-03-09', sex: 'F', cpf: completeCpf('477000101'), cns: cnsFromBase('27700000101'), motherName: 'Ana Campo Teste', phone: '(63) 99999-0101', endereco },
      },
    ];
    await t.http().post('/api/acs/sync').set(auth(recepcao)).send({ operacoes }).expect(403);
    await t.http().post('/api/acs/sync').set(auth(enfermeira)).send({ operacoes }).expect(403);
    const r1 = (await t.http().post('/api/acs/sync').set(auth(acs)).send({ operacoes }).expect(200)).body;
    const por = (clientId: string, body = r1) => body.resultados.find((r: { clientId: string }) => r.clientId === clientId);
    expect(r1.resultados.map((r: { tipo: string }) => r.tipo)).toEqual(['PESSOA', 'PESSOA', 'DOMICILIO', 'VISITA']);
    for (const r of r1.resultados) expect(r, JSON.stringify(r)).toMatchObject({ status: 'OK' });
    expect(por(ids.pessoa).id).toBeDefined();

    // Reenvio (o aparelho não recebeu a resposta): nada duplica e os ids são os mesmos.
    const r2 = (await t.http().post('/api/acs/sync').set(auth(acs)).send({ operacoes }).expect(200)).body;
    for (const r of r2.resultados) expect(r.status).toBe('DUPLICADA');
    expect(por(ids.visita, r2).id).toBe(por(ids.visita).id);
    expect(por(ids.domicilio, r2).id).toBe(por(ids.domicilio).id);

    const terr = (await t.http().get('/api/acs/territorio').set(auth(acs)).expect(200)).body;
    const dom = terr.domicilios.find((d: { id: string }) => d.id === por(ids.domicilio).id);
    expect(dom).toMatchObject({ addressLine: 'Rua das Visitas, 7, Setor Central', microArea: '01', latitude: -11.7301, teamId });
    expect(dom.familias).toHaveLength(1);
    expect(dom.familias[0].responsibleId).toBe(por(ids.pessoa).id);
    expect(dom.familias[0].membros.map((m: { name: string; kinship: string }) => `${m.name}:${m.kinship}`).sort()).toEqual(['Lívia Campo Teste:03', 'Rosa Campo Teste:00']);
    expect(dom.ultimaVisita).toMatchObject({ desfecho: '1', dias: 0 });
    const rosa = dom.familias[0].membros.find((m: { name: string }) => m.name === 'Rosa Campo Teste');
    expect(rosa.ultimaVisita).not.toBeNull();
    const livia = dom.familias[0].membros.find((m: { name: string }) => m.name === 'Lívia Campo Teste');
    expect(livia.prioridades).toContain('CRIANCA');

    const visitas = (await t.http().get('/api/acs/visitas').set(auth(acs)).expect(200)).body;
    const v = visitas.find((x: { clientId: string }) => x.clientId === ids.visita);
    expect(v).toMatchObject({ desfecho: '1', desfechoLabel: 'Visita realizada', medicoes: { sistolica: 128, pesoKg: 71.4 }, pessoa: { name: 'Rosa Campo Teste' }, profissional: { cbo: '515105' } });
    expect(v.motivos.map((m: { descricao: string }) => m.descricao)).toEqual(['Cadastramento / atualização', 'Visita periódica', 'Pessoa com hipertensão']);
    expect(visitas.every((x: { profissional: { nome: string } }) => x.profissional.nome === 'Joaquim Pereira Agente Comunitário')).toBe(true);

    // Visita realizada a um domicílio sem informar a pessoa: erro de negócio, sem travar o resto do lote.
    const r3 = (
      await t
        .http()
        .post('/api/acs/sync')
        .set(auth(acs))
        .send({
          operacoes: [
            { tipo: 'VISITA', clientId: ids.visitaImovel, registradoEm: agora(5), householdId: dom.id, visita: { motivos: ['29'], desfecho: '1' } },
            { tipo: 'VISITA', clientId: randomUUID(), registradoEm: agora(4), householdId: dom.id, visita: { motivos: ['29'], desfecho: '3' } },
          ],
        })
        .expect(200)
    ).body;
    expect(r3.resultados[0]).toMatchObject({ status: 'ERRO' });
    expect(r3.resultados[0].erro).toContain('pessoa visitada');
    expect(r3.resultados[1]).toMatchObject({ status: 'OK' });
    await t
      .http()
      .post('/api/acs/sync')
      .set(auth(acs))
      .send({ operacoes: [{ tipo: 'VISITA', clientId: 'x', registradoEm: agora(1), visita: { motivos: [], desfecho: '9' } }] })
      .expect(400);
  });

  it('gera a ficha de visita domiciliar no lote do e-SUS e o simulador do PEC a recebe', async () => {
    const batch = (
      await t
        .http()
        .post('/api/esus/batches')
        .set(auth(gestora))
        .send({ unitId: ubsId, from: day(-1), to: day(0) })
        .expect(201)
    ).body;
    const fichas = batch.records.filter((r: { kind: number }) => r.kind === TIPO_DADO.VISITA_DOMICILIAR);
    expect(fichas.length).toBeGreaterThanOrEqual(1);
    for (const f of fichas) expect(f.status, JSON.stringify(f.issues)).toBe('GERADA');
    expect(fichas[0].summary).toMatchObject({ profissional: 'Joaquim Pereira Agente Comunitário' });
    expect(fichas.reduce((s: number, f: { summary: { visitas: number } }) => s + f.summary.visitas, 0)).toBeGreaterThanOrEqual(2);
    await fetch(`${mocks.url}/pec/_received`, { method: 'DELETE' });
    const sent = (await t.http().post(`/api/esus/batches/${batch.id}/send`).set(auth(gestora)).expect(200)).body;
    expect(sent.error).toBeNull();
    expect(sent.rejected).toBe(0);
    expect(sent.accepted).toBeGreaterThan(0);
    const recebidas = (await (await fetch(`${mocks.url}/pec/_received`)).json()) as { tipo: number; ine: string | null }[];
    expect(recebidas.length).toBe(sent.accepted);
    expect(recebidas.filter((r) => r.tipo === TIPO_DADO.VISITA_DOMICILIAR)).toEqual(expect.arrayContaining([expect.objectContaining({ ine: '0000000101' })]));
  });

  it('resume a produtividade por agente para a gestão e só a própria para o agente', async () => {
    const prod = (
      await t
        .http()
        .get(`/api/acs/produtividade?teamId=${teamId}&from=${day(-40)}&to=${day(0)}`)
        .set(auth(gestora))
        .expect(200)
    ).body;
    const joaquim = prod.agentes.find((a: { nome: string }) => a.nome === 'Joaquim Pereira Agente Comunitário');
    expect(joaquim).toMatchObject({ cbo: '515105', microArea: '01', cadastros: { pessoas: 2, domicilios: 1 } });
    expect(joaquim.realizadas).toBeGreaterThanOrEqual(2);
    expect(joaquim.ausentes).toBeGreaterThanOrEqual(2);
    expect(joaquim.domiciliosTerritorio).toBeGreaterThan(3);
    expect(joaquim.cobertura).toBeGreaterThan(0);
    expect(joaquim.motivosFrequentes[0].codigo).toBe('29');
    expect(joaquim.ultimaSincronizacao).not.toBeNull();
    expect(prod.totais.cadastrosPessoas).toBe(2);

    const propria = (
      await t
        .http()
        .get(`/api/acs/produtividade?from=${day(-40)}&to=${day(0)}`)
        .set(auth(acs))
        .expect(200)
    ).body;
    expect(propria.agentes).toHaveLength(1);
    expect(propria.agentes[0].nome).toBe('Joaquim Pereira Agente Comunitário');
    await t.http().get('/api/acs/produtividade').set(auth(recepcao)).expect(403);
  });

  it('as visitas realizadas alimentam os programas e os indicadores (boa prática de visita do ACS)', async () => {
    // Pessoa com hipertensão do seed (ESF Centro I): a lista de HAS/DM passa a cobrar a visita (boa prática D) de quem não a tem.
    const lista = (await t.http().get(`/api/programas/HAS_DM?teamId=${teamId}&faltosos=false`).set(auth(enfermeira)).expect(200)).body;
    expect(lista.pessoas.length).toBeGreaterThan(0);
    const codigos = new Set(lista.pessoas.flatMap((p: { faltas: { codigo: string }[] }) => p.faltas.map((f) => f.codigo)));
    expect(codigos.has('D')).toBe(true);
    const def = (await t.http().get('/api/indicadores-aps/fichas').set(auth(gestora)).expect(200)).body.indicadores;
    const c4 = def.find((d: { codigo: string }) => d.codigo === 'C4');
    expect(c4.boasPraticas.find((b: { letra: string }) => b.letra === 'D').fonte).toBe('DISPONIVEL');
    expect(c4.fonteApp.situacao).toBe('DISPONIVEL');
  });
});
