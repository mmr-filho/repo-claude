import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, deslocarSemana, intervaloDaSemana, localDateString, semanaDaData, semanaEpidemiologica } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { SurtoService } from '../src/modules/vigilancia/surto.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();
const H = 3_600_000;
const DIA = 24 * H;
const TZ = 'America/Sao_Paulo';
// Datas relativas ao relógio (o teste vale em qualquer dia); o relógio do serviço só é deslocado para o prazo de 24 h.
const hoje = () => localDateString(new Date(), TZ);
const diasAtras = (n: number) => localDateString(new Date(Date.now() - n * DIA), TZ);
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

type Sugestao = {
  assinatura: string;
  regra: string;
  grupo: string;
  vinculo: { tipo: string; id: string };
  vinculoNome: string;
  casos: string[];
  primeiroSintoma: string | null;
  casosDetalhe: { id: string; numero: string; unidade: string; bairro: string | null }[];
};
type Prazo = { esfera: string; venceEm: string; cumpridoEm: string | null; situacao: string };
type Caso = { id: string; numero: number; notificationId: string | null; notificacaoNumero: string | null; iniciais: string | null; idade: string | null; bairroNome: string | null; semNotificacaoIndividual: boolean };
type Detalhe = {
  id: string;
  numero: string;
  status: string;
  unidade: { id: string };
  prazos: Prazo[];
  avisos: string[];
  planilha: Caso[];
  eventos: { tipo: string; dados: Record<string, unknown> }[];
  pendencias: string[];
  sinal: Record<string, unknown> | null;
  numeroOficial: string | null;
  espelho: { campos: { variavel: string; valor: string | null }[]; planilha: Record<string, string | null>[]; dta: { variavel: string; rotulo: string; valor: string | null }[]; avisos: string[] };
  permissoes: Record<string, boolean>;
};

describe.runIf(enabled)('Vigilância: notificação de surto e sugestões (VIG-1c)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let surtos: SurtoService;
  const tk: Record<string, string> = {};
  const U: Record<string, { id: string; cnes: string }> = {};
  const usuario: Record<string, string> = {};
  const n: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const T: Record<string, { id: string; centerLat: number; centerLng: number }> = {};
  let seq = 0;
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const sugestoes = async (k = 'vig') => (await t.http().get('/api/vigilancia/surtos/sugestoes').set(auth(k)).expect(200)).body as { sugestoes: Sugestao[]; excessos: unknown[]; avisos: string[] };
  /** Sugestão da regra e do agravo; com o vínculo, só a desse quarteirão, bairro ou unidade (a semeadura pode ter outras). */
  const achar = (lista: Sugestao[], regra: string, grupo: string, vinculoId?: string) => lista.find((s) => s.regra === regra && s.grupo === grupo && (!vinculoId || s.vinculo.id === vinculoId));
  const criar = (k: string, corpo: Record<string, unknown>, status: number) => t.http().post('/api/vigilancia/surtos').set(auth(k)).send(corpo).expect(status);
  const detalhe = async (id: string, k = 'vig') => (await t.http().get(`/api/vigilancia/surtos/${id}`).set(auth(k)).expect(200)).body as Detalhe;
  const novoPaciente = async (nome: string, sex: 'M' | 'F' = 'M') => {
    seq++;
    const body = {
      name: nome,
      birthDate: `${1960 + seq}-0${1 + (seq % 9)}-2${seq % 8}`,
      sex,
      cpf: completeCpf(String(271000700 + seq)),
      cns: cnsFromBase(String(27100000700 + seq)),
      motherName: `Mae de ${nome}`,
      phone: '(11) 97777-2701',
      address: { cep: '01001000', street: 'Rua do Surto', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
      confirmNotDuplicate: true,
    };
    return (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
  };
  /** Domicílio no quarteirão (sem precisão de posição, a ficha não tira retrato e o quarteirão vem do cadastro). */
  const morarEm = async (patientId: string, q: { id: string; centerLat: number; centerLng: number }) => {
    const h = await db.household.create({
      data: { street: 'Rua do Surto', number: String(seq), ibgeCode: '3550308', latitude: q.centerLat, longitude: q.centerLng, blockId: q.id, families: { create: { responsibleId: patientId } } },
      include: { families: true },
    });
    await db.patient.update({ where: { id: patientId }, data: { familyId: h.families[0]!.id } });
  };
  const notificar = async (k: string, patientId: string, conditionKey: string, conhecidoHaDias: number, sintomasHaDias: number | null) => {
    const r = (
      await t
        .http()
        .post('/api/vigilancia/notificacoes')
        .set(auth(k))
        .send({ patientId, conditionKey, knownAt: new Date(Date.now() - conhecidoHaDias * DIA).toISOString(), ...(sintomasHaDias !== null ? { symptomsOnset: diasAtras(sintomasHaDias) } : {}) })
        .expect(201)
    ).body as { id: string };
    return r.id;
  };

  beforeAll(async () => {
    t = await startTestApp('vigsurto');
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.medicaHosp = await t.login('medica', 'Hospital Municipal São Lucas', 'MEDICO');
    tk.nucleo = await t.login('nucleo', 'Hospital Municipal São Lucas', 'NUCLEO_VIGILANCIA');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    tk.dentista = await t.login('dentista', 'CEO Sorriso', 'MULTIPROFISSIONAL');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    surtos = t.app.get(SurtoService);
    for (const u of demoFixtures.UNITS) U[u.key] = { id: (await db.unit.findUniqueOrThrow({ where: { cnes: u.cnes } })).id, cnes: u.cnes };
    for (const s of demoFixtures.STAFF) usuario[s.key] = (await db.user.findUniqueOrThrow({ where: { cpf: s.cpf } })).id;
    // Banco do teste: sem o que a semeadura da demonstração possa ter gravado nestas tabelas.
    for (const tabela of ['negative_reports', 'notifying_unit_responsibles', 'notifying_units', 'outbreak_cases', 'outbreak_events', 'outbreak_dismissals', 'outbreaks'])
      await db.$executeRawUnsafe(`DELETE FROM ${tabela}`);
    // Território: bairro Alfa (quarteirões 1 e 2) e bairro Beta (quarteirão 3).
    const loc = await db.locality.create({ data: { code: '977', name: 'Localidade Teste Surto', category: 'CIDADE', zone: 'URBANA', source: 'MANUAL' } });
    const alfa = await db.neighborhood.create({ data: { localityId: loc.id, name: 'Bairro Alfa' } });
    const beta = await db.neighborhood.create({ data: { localityId: loc.id, name: 'Bairro Beta' } });
    ids.alfa = alfa.id;
    ids.beta = beta.id;
    for (const [numero, bairro, lat, lng] of [
      ['1', alfa.id, -23.6, -46.7],
      ['2', alfa.id, -23.6, -46.699],
      ['3', beta.id, -23.59, -46.69],
    ] as const) {
      const b = await db.block.create({
        data: {
          localityId: loc.id,
          neighborhoodId: bairro,
          number: numero,
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [lng, lat],
                [lng + 0.0005, lat],
                [lng + 0.0005, lat + 0.0005],
                [lng, lat + 0.0005],
                [lng, lat],
              ],
            ],
          },
          minLng: lng,
          minLat: lat,
          maxLng: lng + 0.0005,
          maxLat: lat + 0.0005,
          centerLat: lat + 0.00025,
          centerLng: lng + 0.00025,
          areaM2: 3000,
          source: 'EDITOR',
        },
      });
      T[`q${numero}`] = { id: b.id, centerLat: b.centerLat, centerLng: b.centerLng };
    }
    // Histórico anterior à janela (sem ele, o evento inusitado não é avaliado).
    const antigo = await notificar('medica', await novoPaciente('Otavio Historico Coqueluche'), 'coqueluche', 0, null);
    await db.notification.update({ where: { id: antigo }, data: { knownAt: new Date(Date.now() - 60 * DIA) } });
    // Leptospirose: dois casos no quarteirão 1 e um no 2 (os três no bairro Alfa), em 7 dias.
    for (const [k, q, conhecido, sintomas] of [
      ['l1', 'q1', 3, 4],
      ['l2', 'q1', 2, 3],
      ['l3', 'q2', 1, 2],
    ] as const) {
      const p = await novoPaciente(`Lia Lepto ${k.toUpperCase()} Silva`, 'F');
      await morarEm(p, T[q]!);
      n[k] = await notificar('medica', p, 'leptospirose', conhecido, sintomas);
    }
    // Varicela: um caso atendido no hospital (sugere surto pela unidade) e um na UBS (não sugere).
    n.v1 = await notificar('medicaHosp', await novoPaciente('Vitor Varicela Hospital'), 'varicela', 1, 2);
    n.v2 = await notificar('medica', await novoPaciente('Vicente Varicela UBS'), 'varicela', 1, 2);
    // Febre tifoide nunca vista no município: evento inusitado.
    n.f1 = await notificar('medica', await novoPaciente('Fausto Febre Tifoide'), 'febre-tifoide', 1, 2);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close();
  });

  it('sugestões por quarteirão, bairro e unidade hospitalar; evento inusitado; excessos do diagrama isolados', async () => {
    const r = await sugestoes();
    const q = achar(r.sugestoes, 'quarteirao-7d', 'leptospirose', T.q1!.id)!;
    expect(q).toMatchObject({ vinculo: { tipo: 'QUARTEIRAO', id: T.q1!.id }, vinculoNome: 'Quarteirão 1 (Localidade Teste Surto)', assinatura: `quarteirao-7d|QUARTEIRAO:${T.q1!.id}|leptospirose` });
    expect([...q.casos].sort()).toEqual([n.l1, n.l2].sort());
    expect(q.casosDetalhe.map((c) => c.bairro)).toEqual(['Bairro Alfa', 'Bairro Alfa']);
    expect(q.casosDetalhe.every((c) => c.unidade === 'UBS Centro' && /^\d{4}\/\d{6}$/.test(c.numero))).toBe(true);
    const b = achar(r.sugestoes, 'bairro-7d', 'leptospirose', ids.alfa)!;
    expect(b).toMatchObject({ vinculo: { tipo: 'BAIRRO', id: ids.alfa }, vinculoNome: 'Bairro Alfa', primeiroSintoma: diasAtras(4) });
    expect([...b.casos].sort()).toEqual([n.l1, n.l2, n.l3].sort());
    const u = achar(r.sugestoes, 'varicela-hospitalar', 'varicela', U.hosp!.id)!;
    expect(u).toMatchObject({ vinculo: { tipo: 'UNIDADE', id: U.hosp!.id }, vinculoNome: 'Hospital Municipal São Lucas', casos: [n.v1] });
    expect(r.sugestoes.some((s) => s.regra === 'varicela-hospitalar' && s.casos.includes(n.v2!))).toBe(false);
    expect(achar(r.sugestoes, 'inusitado', 'febre-tifoide')).toMatchObject({ vinculo: { tipo: 'MUNICIPIO', id: 'municipio' }, vinculoNome: 'Município', casos: [n.f1] });
    expect(Array.isArray(r.excessos)).toBe(true);
    // O excesso do diagrama vem da frente F3 por uma função isolada: o resultado entra; a falha vira aviso.
    const diagramas = t.app.get(DiagramaService);
    const excesso = { grupo: 'dengue', nivel: 'BAIRRO', territorioId: ids.beta, territorioNome: 'Bairro Beta', semana: '202601', casos: 9, valor: 120.5, ls: 80 };
    const spy = vi.spyOn(diagramas, 'excessos').mockResolvedValueOnce([excesso as never]);
    expect((await sugestoes()).excessos).toEqual([excesso]);
    expect(spy).toHaveBeenCalledWith(expect.anything(), ['dengue', 'chikungunya', 'zika'], hoje());
    spy.mockRejectedValueOnce(new Error('falha simulada'));
    const comFalha = await sugestoes();
    expect(comFalha.excessos).toEqual([]);
    expect(comFalha.avisos.some((a) => a.includes('diagrama de controle por território'))).toBe(true);
    expect(comFalha.sugestoes.length).toBe(r.sugestoes.length);
    spy.mockRestore();
  });

  it('dispensa: a sugestão some até aparecer caso conhecido depois; motivo e assinatura são conferidos', async () => {
    const q = achar((await sugestoes()).sugestoes, 'quarteirao-7d', 'leptospirose', T.q1!.id)!;
    await t.http().post('/api/vigilancia/surtos/sugestoes/dispensar').set(auth('vig')).send({ assinatura: q.assinatura, motivo: 'curto' }).expect(400);
    await t.http().post('/api/vigilancia/surtos/sugestoes/dispensar').set(auth('vig')).send({ assinatura: 'regra|QUARTEIRAO:x|grupo', motivo: 'Mesma família, já investigado pela UBS.' }).expect(404);
    expect((await t.http().post('/api/vigilancia/surtos/sugestoes/dispensar').set(auth('vig')).send({ assinatura: q.assinatura, motivo: 'Mesma família, já investigado pela UBS.' }).expect(200)).body).toEqual({
      ok: true,
    });
    const depois = await sugestoes();
    expect(depois.sugestoes.find((s) => s.assinatura === q.assinatura)).toBeUndefined();
    expect(achar(depois.sugestoes, 'bairro-7d', 'leptospirose', ids.alfa)).toBeDefined();
    const d = await db.outbreakDismissal.findFirstOrThrow({ where: { signature: q.assinatura } });
    expect(d).toMatchObject({ ruleId: 'quarteirao-7d', groupKey: 'leptospirose', linkKind: 'QUARTEIRAO', linkId: T.q1!.id, dismissedBy: usuario.vigilancia });
    // Caso novo no mesmo quarteirão, conhecido depois da dispensa: a sugestão volta com ele.
    const p = await novoPaciente('Lauro Lepto Quatro Silva');
    await morarEm(p, T.q1!);
    n.l4 = await notificar('medica', p, 'leptospirose', 0, 1);
    const volta = (await sugestoes()).sugestoes.find((s) => s.assinatura === q.assinatura)!;
    expect([...volta.casos].sort()).toEqual([n.l1, n.l2, n.l4].sort());
  });

  it('surto a partir da sugestão: os casos entram na planilha, o sinal fica gravado e a sugestão some', async () => {
    const b = achar((await sugestoes()).sugestoes, 'bairro-7d', 'leptospirose', ids.alfa)!;
    expect(b.casos).toHaveLength(4);
    const s = (
      await criar(
        'vig',
        {
          assinatura: b.assinatura,
          casosIndicados: b.casos.map((id) => ({ notificationId: id })),
          categoria: 'DA_LISTA',
          grupo: 'leptospirose',
          notificadoEm: hoje(),
          conhecidoEm: new Date(Date.now() - H).toISOString(),
          unitId: U.ubs!.id,
          primeirosSintomasEm: b.primeiroSintoma,
          casos: 4,
          localInicial: '8',
          local: { bairroId: ids.alfa },
        },
        201,
      )
    ).body as Detalhe;
    ids.lepto = s.id;
    expect(s.numero).toMatch(/^\d{4}\/\d{4}$/);
    expect(s).toMatchObject({ status: 'ABERTO', sinal: { assinatura: b.assinatura, regra: 'bairro-7d' } });
    // Os avisos dos casos indicados voltam na criação (os quatro ainda são rascunho); nada de "10%": todos são individuais.
    expect(s.avisos).toHaveLength(4);
    expect(s.avisos.every((a) => a.includes('ainda é rascunho'))).toBe(true);
    expect(s.planilha.map((c) => c.numero)).toEqual([1, 2, 3, 4]);
    expect(s.planilha.every((c) => c.notificationId && c.notificacaoNumero && c.bairroNome === 'Bairro Alfa' && !c.semNotificacaoIndividual)).toBe(true);
    expect(s.planilha.find((c) => c.notificationId === n.l1)!.iniciais).toBe('LLLS');
    expect(s.eventos.map((e) => e.tipo)).toEqual(['CRIADO', 'CASO_VINCULADO', 'CASO_VINCULADO', 'CASO_VINCULADO', 'CASO_VINCULADO']);
    // Os casos agora estão num surto aberto: nenhuma sugestão os traz de volta.
    const meus = [n.l1, n.l2, n.l3, n.l4];
    expect((await sugestoes()).sugestoes.filter((x) => x.casos.some((c) => meus.includes(c)))).toEqual([]);
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.surto_criar', entityId: s.id } })).toBe(1);
  });

  it('surto manual e validação por etapa: sintomas depois da notificação, local 11 sem texto, agravo × categoria, encerramento antes da notificação', async () => {
    const base = {
      categoria: 'DTA',
      cid: 'A05.9',
      agente: 'Alimento servido na festa da escola',
      notificadoEm: diasAtras(1),
      conhecidoEm: new Date(Date.now() - 26 * H).toISOString(),
      unitId: U.ubs!.id,
      primeirosSintomasEm: diasAtras(2),
      casos: 12,
      localInicial: '3',
      local: { endereco: 'Escola Municipal Exemplo, 100', zona: '1', municipioIbge: '3550308', bairroId: ids.alfa },
    };
    const erro = async (corpo: Record<string, unknown>) => (await criar('vig', { ...base, ...corpo }, 400)).body as { code: string; message: string; details?: { erros: string[] } };
    expect((await erro({ notificadoEm: diasAtras(2), primeirosSintomasEm: diasAtras(1) })).details!.erros).toContain('Os primeiros sintomas não podem ser depois da notificação');
    expect((await erro({ localInicial: '11' })).details!.erros).toContain('Descreva o local inicial de ocorrência (Outros)');
    expect((await erro({ localInicial: '12' })).details!.erros).toContain('Informe o local inicial de ocorrência (1 a 11)');
    expect((await erro({ casos: 0 })).details!.erros).toContain('Informe o número de casos suspeitos (1 ou mais)');
    expect((await erro({ categoria: 'DA_LISTA', cid: null })).code).toBe('AGRAVO_OBRIGATORIO');
    expect((await erro({ categoria: 'FORA_DA_LISTA', grupo: 'leptospirose' })).code).toBe('AGRAVO_DA_LISTA');
    expect((await erro({ categoria: 'SINDROMICO', sindrome: 'INVENTADA' })).code).toBe('SINDROME_INVALIDA');
    expect((await erro({ grupo: 'agravo-que-nao-existe' })).code).toBe('AGRAVO_FORA_DO_CATALOGO');
    expect((await erro({ notificadoEm: localDateString(new Date(Date.now() + 2 * DIA), TZ) })).code).toBe('DATA_FUTURA');
    expect((await erro({ conhecidoEm: new Date(Date.now() + 2 * H).toISOString() })).code).toBe('DATA_FUTURA');
    const s = (await criar('vig', base, 201)).body as Detalhe & { cid: string; agravo: string; esp: boolean; casos: number; casosNaPlanilha: number };
    ids.dta = s.id;
    expect(s).toMatchObject({ status: 'ABERTO', categoria: 'DTA', cid: 'A059', agravo: 'Alimento servido na festa da escola (CID A05.9)', casos: 12, casosNaPlanilha: 0, esp: false });
    expect(s.pendencias).toEqual(['Informe a data da investigação']);
    // Investigação antes da notificação; sintomas depois dela; veículo "outro" sem texto.
    const patch = (corpo: Record<string, unknown>, status: number) => t.http().patch(`/api/vigilancia/surtos/${ids.dta}`).set(auth('vig')).send(corpo).expect(status);
    expect((await patch({ investigacao: { investigadoEm: diasAtras(2) } }, 400)).body.details.erros).toContain('A investigação não pode ser antes da notificação');
    expect((await patch({ primeirosSintomasEm: hoje() }, 400)).body.details.erros).toContain('Os primeiros sintomas não podem ser depois da notificação');
    expect((await patch({ investigacao: { veiculo: '6' } }, 400)).body.message).toContain('Outro');
    // Encerrar exige a investigação.
    expect((await t.http().post(`/api/vigilancia/surtos/${ids.dta}/encerrar`).set(auth('vig')).send({ delimitacao: '3', data: hoje() }).expect(400)).body.details.erros).toContain('Informe a data da investigação');
    const inv = (
      await patch(
        {
          investigacao: { investigadoEm: hoje(), modoTransmissao: '2', veiculo: '1', observacoes: 'Merenda escolar', investigadorNome: 'Vera Lúcia', investigadorFuncao: 'Enfermeira' },
          dta: { NU_ENTR: 40, NU_ENT_DOE: 12, DS_ALICAUS: 'Salada de maionese' },
        },
        200,
      )
    ).body as Detalhe;
    expect(inv.pendencias).toEqual([]);
    expect(inv.eventos.at(-1)).toMatchObject({ tipo: 'INVESTIGADO', dados: { investigadoEm: hoje() } });
    const encerrar = (corpo: Record<string, unknown>) => t.http().post(`/api/vigilancia/surtos/${ids.dta}/encerrar`).set(auth('vig')).send(corpo).expect(400);
    expect((await encerrar({ delimitacao: '3', data: diasAtras(3) })).body.details.erros).toContain('O encerramento não pode ser antes da notificação');
    expect((await encerrar({ delimitacao: '11', data: hoje() })).body.details.erros).toContain('Descreva a delimitação do surto (Outros)');
    expect((await encerrar({ delimitacao: '12', data: hoje() })).body.details.erros).toContain('Informe a delimitação do surto (1 a 11)');
    // Surto de DTA por agravo da lista (febre tifoide): usado na planilha e no número oficial.
    const outro = (await criar('vig', { ...base, grupo: 'febre-tifoide', cid: null, agente: null, localInicial: '1', notificadoEm: diasAtras(1) }, 201)).body as Detalhe & { agravo: string };
    expect(outro.agravo).toBe('Febre Tifóide');
    ids.tifoide = outro.id;
  });

  it('planilha: notificação e linha manual com NU_CASO sequencial; aviso de agravo da lista sem notificação individual; 10% no registro agregado', async () => {
    const caso = (id: string, corpo: Record<string, unknown>, status = 201) => t.http().post(`/api/vigilancia/surtos/${id}/casos`).set(auth('vig')).send(corpo).expect(status);
    const c1 = (await caso(ids.dta!, { linha: { iniciais: 'abc', sexo: 'F', idade: '7 anos', inicioSintomas: diasAtras(2), hospitalizado: false, obito: false, classificacao: '1', criterio: '1', cidFinal: 'A05.9' } }))
      .body;
    expect(c1).toMatchObject({ caso: { numero: 1, iniciais: 'ABC', idade: '7 anos', semNotificacaoIndividual: false }, avisos: [] });
    const c2 = (await caso(ids.dta!, { linha: { iniciais: 'DEF', idade: '35' } })).body;
    expect(c2.caso).toMatchObject({ numero: 2, idade: '35 anos' });
    const pm = await novoPaciente('Maria da Silva Souza', 'F');
    n.maria = await notificar('medica', pm, 'coqueluche', 1, 2);
    const c3 = (await caso(ids.dta!, { notificationId: n.maria })).body;
    expect(c3.caso).toMatchObject({ numero: 3, notificationId: n.maria, iniciais: 'MSS', sexo: 'F' });
    expect(c3.caso.notificacaoNumero).toMatch(/^\d{4}\/\d{6}$/);
    expect(c3.avisos.some((a: string) => a.includes('ainda é rascunho'))).toBe(true);
    expect((await caso(ids.dta!, { notificationId: n.maria }, 409)).body.code).toBe('CONFLITO');
    // Retirar não reaproveita o número.
    expect((await t.http().delete(`/api/vigilancia/surtos/${ids.dta}/casos/${c2.caso.id}`).set(auth('vig')).expect(200)).body).toEqual({ ok: true });
    const c4 = (await caso(ids.dta!, { linha: { iniciais: 'GHI', sexo: 'M', idade: '5 meses' } })).body;
    expect(c4.caso).toMatchObject({ numero: 4, idade: '5 meses' });
    expect((await caso(ids.dta!, { linha: { idade: 'sete anos' } }, 400)).body.code).toBe('IDADE_INVALIDA');
    // Notificação descartada não entra.
    const pd = await novoPaciente('Davi Descartado Teste');
    const descartada = await notificar('medica', pd, 'coqueluche', 1, 2);
    await t.http().post(`/api/vigilancia/notificacoes/${descartada}/descartar`).set(auth('vig')).send({ reason: 'Não preenche a definição de caso.' }).expect(200);
    expect((await caso(ids.dta!, { notificationId: descartada }, 422)).body.code).toBe('NOTIFICACAO_DESCARTADA');
    // Agravo da lista: a linha manual avisa que o surto não substitui a notificação individual.
    const t1 = (await caso(ids.tifoide!, { linha: { iniciais: 'JKL' } })).body;
    expect(t1.caso.semNotificacaoIndividual).toBe(true);
    expect(t1.avisos.some((a: string) => a.includes('sem notificação individual') && a.includes('notifique o caso'))).toBe(true);
    // Registro agregado de doença da lista: menos de 10% com notificação individual.
    const agregado = (
      await criar(
        'vig',
        { categoria: 'DA_LISTA', grupo: 'coqueluche', notificadoEm: hoje(), conhecidoEm: new Date(Date.now() - H).toISOString(), unitId: U.ubs!.id, primeirosSintomasEm: diasAtras(5), casos: 30, localInicial: '3' },
        201,
      )
    ).body as Detalhe;
    expect(agregado.avisos.some((a) => a.includes('10%') && a.includes('0 de 30'))).toBe(true);
    const a1 = (await caso(agregado.id, { linha: { iniciais: 'MNO' } })).body;
    expect(a1.avisos.some((a: string) => a.includes('10%'))).toBe(true);
    ids.agregado = agregado.id;
    // Bloco DTA fora de lugar: surto que não é de DTA e veículo que não é alimento/água.
    expect(
      (
        await t
          .http()
          .patch(`/api/vigilancia/surtos/${agregado.id}`)
          .set(auth('vig'))
          .send({ dta: { NU_ENTR: 3 } })
          .expect(422)
      ).body.code,
    ).toBe('DTA_FORA_DE_LUGAR');
  });

  it('comunicação e prazo de 24 h: SMS sempre, SES e MS com ESP; o núcleo comunica à SMS', async () => {
    const conhecido = new Date(Date.now() - 2 * H);
    const vence = new Date(conhecido.getTime() + 24 * H).toISOString();
    // O núcleo só notifica a própria unidade.
    await criar('nucleo', { categoria: 'DA_LISTA', grupo: 'varicela', notificadoEm: hoje(), conhecidoEm: conhecido.toISOString(), unitId: U.ubs!.id, primeirosSintomasEm: diasAtras(3), casos: 2, localInicial: '2' }, 403);
    const s = (
      await criar(
        'nucleo',
        { categoria: 'DA_LISTA', grupo: 'varicela', notificadoEm: hoje(), conhecidoEm: conhecido.toISOString(), esp: true, unitId: U.hosp!.id, primeirosSintomasEm: diasAtras(3), casos: 2, localInicial: '2' },
        201,
      )
    ).body as Detalhe;
    ids.hosp = s.id;
    expect(s.prazos).toEqual([
      { esfera: 'SMS', venceEm: vence, cumpridoEm: null, situacao: 'NO_PRAZO' },
      { esfera: 'SES', venceEm: vence, cumpridoEm: null, situacao: 'NO_PRAZO' },
      { esfera: 'MS', venceEm: vence, cumpridoEm: null, situacao: 'NO_PRAZO' },
    ]);
    const comunicar = (k: string, corpo: Record<string, unknown>, status: number) => t.http().post(`/api/vigilancia/surtos/${s.id}/comunicacoes`).set(auth(k)).send(corpo).expect(status);
    const corpo = { alvo: 'SMS', canal: 'TELEFONE', contraparte: 'Plantão da vigilância municipal', protocolo: 'P-123' };
    await comunicar('nucleo', { ...corpo, alvo: 'SES', em: new Date().toISOString() }, 403);
    expect((await comunicar('nucleo', { ...corpo, em: new Date(conhecido.getTime() - H).toISOString() }, 400)).body.message).toContain('anterior ao conhecimento');
    await comunicar('nucleo', { ...corpo, em: new Date(Date.now() + H).toISOString() }, 400);
    const em = new Date(Date.now() - H).toISOString();
    const c = (await comunicar('nucleo', { ...corpo, em }, 201)).body as Detalhe;
    expect(c.prazos[0]).toEqual({ esfera: 'SMS', venceEm: vence, cumpridoEm: em, situacao: 'CUMPRIDO' });
    expect(c.eventos.at(-1)).toMatchObject({ tipo: 'COMUNICADO', dados: { alvo: 'SMS', canal: 'TELEFONE', protocolo: 'P-123', em } });
    // 20 h depois: faltam 2 h para SES e MS (a vencer); 30 h depois, vencidos.
    surtos.agora = () => new Date(Date.now() + 20 * H);
    expect((await detalhe(s.id)).prazos.map((p) => p.situacao)).toEqual(['CUMPRIDO', 'A_VENCER', 'A_VENCER']);
    surtos.agora = () => new Date(Date.now() + 30 * H);
    expect((await detalhe(s.id)).prazos.map((p) => p.situacao)).toEqual(['CUMPRIDO', 'VENCIDO', 'VENCIDO']);
    const ses = (await comunicar('vig', { ...corpo, alvo: 'SES', contraparte: 'CIEVS estadual', em: new Date().toISOString() }, 201)).body as Detalhe;
    expect(ses.prazos.map((p) => p.situacao)).toEqual(['CUMPRIDO', 'CUMPRIDO', 'VENCIDO']);
    surtos.agora = () => new Date();
    // Surto registrado pela própria vigilância municipal: a SMS já está ciente.
    expect((await detalhe(ids.dta!)).prazos).toEqual([expect.objectContaining({ esfera: 'SMS', situacao: 'CUMPRIDO' })]);
  });

  it('número oficial: NU_NOTIFIC do Sinan Net com 1 a 7 dígitos', async () => {
    const numero = (id: string, valor: string, status: number) => t.http().post(`/api/vigilancia/surtos/${id}/numero-oficial`).set(auth('vig')).send({ numero: valor }).expect(status);
    expect((await numero(ids.dta!, '12345678', 400)).body.code).toBe('NUMERO_INVALIDO');
    expect((await numero(ids.dta!, '12a', 400)).body.code).toBe('NUMERO_INVALIDO');
    await numero(ids.dta!, '', 400);
    expect(((await numero(ids.dta!, '1234567', 200)).body as Detalhe).numeroOficial).toBe('1234567');
    const d = (await numero(ids.dta!, '42', 200)).body as Detalhe;
    expect(d.numeroOficial).toBe('42');
    expect(d.eventos.at(-1)).toMatchObject({ tipo: 'NUMERO_OFICIAL', dados: { numero: '42', anterior: '1234567' } });
    // O mesmo número na mesma unidade e data é a mesma notificação do Sinan.
    expect((await numero(ids.tifoide!, '42', 409)).body.message).toContain('42');
  });

  it('espelho com as variáveis do dicionário de dados do Sinan (notificação, investigação, encerramento, planilha e DTA)', async () => {
    const enc = (await t.http().post(`/api/vigilancia/surtos/${ids.dta}/encerrar`).set(auth('vig')).send({ delimitacao: '3', data: hoje(), notas: 'Surto controlado.' }).expect(200)).body as Detalhe;
    expect(enc).toMatchObject({ status: 'ENCERRADO', pendencias: [] });
    const e = (await t.http().get(`/api/vigilancia/surtos/${ids.dta}/espelho`).set(auth('vig')).expect(200)).body as Detalhe['espelho'];
    const v = Object.fromEntries(e.campos.map((c) => [c.variavel, c.valor]));
    const notificado = diasAtras(1);
    expect(v).toMatchObject({
      NU_NOTIFIC: '42',
      TP_NOT: '3 - Surto',
      DT_NOTIFIC: ddmm(notificado),
      SEM_NOT: semanaDaData(notificado).codigo,
      SG_UF_NOT: '35',
      ID_MUNICIP: '355030',
      ID_UNIDADE: '9000011 - UBS Centro',
      DT_SIN_PRI: ddmm(diasAtras(2)),
      QT_TOTAL_C: '12',
      CS_LOCAL: '3 - Creche/Escola',
      ID_MUNI_RE: '355030',
      NM_BAIRRO: 'Bairro Alfa',
      NM_LOGRADO: 'Escola Municipal Exemplo, 100',
      CS_ZONA: '1 - Urbana',
      DT_INVEST: ddmm(hoje()),
      CS_TRANS: '2 - Indireta',
      TP_INDIRET: '1 - Alimento/água',
      CS_VEICULO: null,
      DS_OBS: 'Merenda escolar',
      DELIMITA: '3 - Creche/Escola',
      DT_ENCERRA: ddmm(hoje()),
    });
    expect(v.ID_AGRAVO).toMatch(/^A059 - /);
    expect(e.planilha.map((l) => l.NU_CASO)).toEqual(['1', '3', '4']);
    expect(e.planilha[0]).toMatchObject({ NM_CASO: 'ABC', CS_SEXO: 'F', NU_IDADE_N: '4007', DT_SIN_PRI: ddmm(diasAtras(2)), ID_HOSP: '2', OBITO: '2', CLASSI_FIN: '1', CRITERIO: '1', DIAG_FINAL: 'A059' });
    expect(e.planilha[2]).toMatchObject({ NM_CASO: 'GHI', NU_IDADE_N: '3005', ID_HOSP: '9' });
    // O jsonb guarda as chaves em outra ordem: compara sem a ordem.
    expect(Object.fromEntries(e.dta.map((d) => [d.variavel, [d.rotulo, d.valor]]))).toEqual({
      DS_ALICAUS: ['Alimento causador', 'Salada de maionese'],
      NU_ENTR: ['Nº de entrevistados', '40'],
      NU_ENT_DOE: ['Nº de doentes entrevistados', '12'],
    });
    expect(e.avisos.some((a) => a.includes('Critério do caso'))).toBe(true);
    // Encerrado: não edita nem recebe caso.
    expect((await t.http().patch(`/api/vigilancia/surtos/${ids.dta}`).set(auth('vig')).send({ casos: 13 }).expect(422)).body.code).toBe('SURTO_FECHADO');
    await t
      .http()
      .post(`/api/vigilancia/surtos/${ids.dta}/casos`)
      .set(auth('vig'))
      .send({ linha: { iniciais: 'XYZ' } })
      .expect(422);
  });

  it('núcleo: só os surtos e as sugestões da unidade em que está lotado; o descarte é da vigilância municipal', async () => {
    const lista = (await t.http().get('/api/vigilancia/surtos').set(auth('nucleo')).expect(200)).body as Detalhe[];
    expect(lista.length).toBeGreaterThan(0);
    expect(lista.every((s) => s.unidade.id === U.hosp!.id)).toBe(true);
    expect(lista.map((s) => s.id)).toContain(ids.hosp);
    await t.http().get(`/api/vigilancia/surtos/${ids.dta}`).set(auth('nucleo')).expect(403);
    await t.http().patch(`/api/vigilancia/surtos/${ids.lepto}`).set(auth('nucleo')).send({ casos: 5 }).expect(403);
    await t.http().get(`/api/vigilancia/surtos/${ids.dta}/espelho`).set(auth('nucleo')).expect(403);
    // Notificação de outra unidade não entra na planilha pelo núcleo.
    await t.http().post(`/api/vigilancia/surtos/${ids.hosp}/casos`).set(auth('nucleo')).send({ notificationId: n.maria }).expect(403);
    const sug = await sugestoes('nucleo');
    expect(sug.sugestoes.flatMap((s) => s.casosDetalhe).every((c) => c.unidade === 'Hospital Municipal São Lucas')).toBe(true);
    expect(achar(sug.sugestoes, 'varicela-hospitalar', 'varicela', U.hosp!.id)?.casos).toContain(n.v1);
    // Descarte: só a vigilância municipal, com motivo.
    await t.http().post(`/api/vigilancia/surtos/${ids.hosp}/descartar`).set(auth('nucleo')).send({ motivo: 'Casos sem vínculo entre si.' }).expect(403);
    await t.http().post(`/api/vigilancia/surtos/${ids.hosp}/descartar`).set(auth('vig')).send({ motivo: 'curto' }).expect(400);
    const d = (await t.http().post(`/api/vigilancia/surtos/${ids.hosp}/descartar`).set(auth('vig')).send({ motivo: 'Casos sem vínculo entre si.' }).expect(200)).body as Detalhe & { descarte: { motivo: string } };
    expect(d).toMatchObject({ status: 'DESCARTADO', prazos: [], avisos: [], descarte: { motivo: 'Casos sem vínculo entre si.' } });
    const descartados = (await t.http().get('/api/vigilancia/surtos?status=DESCARTADO').set(auth('vig')).expect(200)).body as Detalhe[];
    expect(descartados.map((s) => s.id)).toEqual([ids.hosp]);
    expect(((await t.http().get('/api/vigilancia/surtos?status=ABERTO').set(auth('vig')).expect(200)).body as Detalhe[]).map((s) => s.id)).not.toContain(ids.hosp);
    // Quem não tem a permissão de surto não vê nada.
    await t.http().get('/api/vigilancia/surtos').set(auth('medica')).expect(403);
  });

  it('negativa (RQ003): o surto cancela o atesto da unidade na semana da notificação', async () => {
    const semanaPassada = deslocarSemana(semanaEpidemiologica(new Date(), TZ).codigo, -1);
    const { inicio } = intervaloDaSemana(Number(semanaPassada.slice(0, 4)), Number(semanaPassada.slice(4)));
    await t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId: U.ceo!.id, desde: '2026-01-01' }).expect(201);
    await t.http().post(`/api/vigilancia/unidades-notificantes/${U.ceo!.id}/responsaveis`).set(auth('vig')).send({ userId: usuario.dentista, tipo: 'TITULAR', desde: '2026-01-01' }).expect(201);
    const a = (await t.http().post('/api/vigilancia/negativas').set(auth('dentista')).send({ unitId: U.ceo!.id, semana: semanaPassada }).expect(201)).body as { id: string; status: string };
    expect(a.status).toBe('ATESTADA');
    const s = (
      await criar(
        'vig',
        {
          categoria: 'FORA_DA_LISTA',
          cid: 'B08.4',
          agente: 'Doença mão-pé-boca',
          notificadoEm: inicio,
          conhecidoEm: new Date(`${inicio}T15:00:00Z`).toISOString(),
          unitId: U.ceo!.id,
          primeirosSintomasEm: inicio,
          casos: 3,
          localInicial: '3',
        },
        201,
      )
    ).body as Detalhe;
    expect(await db.negativeReport.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'CANCELADA', causeOutbreakId: s.id });
  });
});
