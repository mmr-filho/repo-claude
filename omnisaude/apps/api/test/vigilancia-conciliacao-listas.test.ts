import { cnsFromBase, completeCpf, isValidCns, isValidCpf, localDateString, normalizarNomePessoa, semanaDaData } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { sqlCnsValido, sqlCpfValido, sqlDataSinan, sqlNomePessoa, sqlSemZeros } from '../src/modules/vigilancia/conciliacao-sql';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

/**
 * Conciliação (VIG-1c, frente A2 da semana 27): cobertura por grupo no "só no OmniSaúde" (imp-cobertura-so-omni),
 * violência sexual e tentativa de suicídio casando com o Y09 pelo CNS e pelo nome (imp-violencia-grupo), evolução de
 * Mpox traduzida pela ficha nas divergências (imp-mpox-codigos), lista de pares vinculados (K9), `porPagina` (K11) e
 * datas que não existem recusadas com 400. Dados sintéticos: nomes, números, CPF e CNS inventados.
 */

const enabled = await pgAvailable();
const FUSO = 'America/Sao_Paulo';
const MUN = '355030';
const UBS = '9000011';

type Criada = { id: string };
type Pagina<T> = { total: number; pagina: number; porPagina: number; itens: T[] };
type Par = { registro: { id: string; numero: string; vinculo: { metodo: string } | null }; notificacao: { id: string }; divergencias: { campo: string; oficial: string | null; omnisaude: string | null }[] };

describe.runIf(enabled)('Vigilância: conciliação com cobertura por grupo, agravo do Sinan, ficha da evolução e vinculados', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao = '';
  let medica = '';
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let seq = 0;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const address = { cep: '77405070', street: 'Rua da Conciliação', number: '27', district: 'Centro', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  const hoje = () => localDateString(new Date(), FUSO);
  const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

  const notificar = async (nome: string, sex: 'M' | 'F', nasc: string, cid: string) => {
    seq++;
    const cns = cnsFromBase(String(27400000900 + seq));
    const cpf = completeCpf(String(274000900 + seq));
    const body = { name: nome, birthDate: nasc, sex, cpf, cns, motherName: `Mae de ${nome}`, phone: '(63) 97777-2701', address };
    const patientId = (await t.http().post('/api/patients').set(auth(recepcao)).send(body).expect(201)).body.id as string;
    const enc = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId, kind: 'AMBULATORIAL' }).expect(201)).body;
    await t.http().post(`/api/clinical/encounters/${enc.id}/start`).set(auth(medica)).expect(200);
    const note = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc.id}/notes`)
        .set(auth(medica))
        .send({ kind: 'SOAP', subjective: 'Queixa.', objective: 'Exame.', assessment: 'Hipótese.', plan: 'Conduta.', codes: [{ system: 'CID10', code: cid }] })
        .expect(201)
    ).body;
    const [c] = (await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth(medica)).expect(200)).body.notificacoes as Criada[];
    if (!c) throw new Error(`${cid}: nenhuma notificação aberta`);
    const conf = await t.http().post(`/api/vigilancia/notificacoes/${c.id}/confirmar`).set(auth(medica));
    if (conf.status !== 200) throw new Error(`confirmar ${cid}: ${conf.status} ${JSON.stringify(conf.body)}`);
    return { id: c.id, cns, cpf, nome, nasc };
  };
  const enviar = async (bytes: Uint8Array, nome: string, tipo = 'application/octet-stream') =>
    (await t.http().post('/api/vigilancia/importacoes').query({ nome }).set(auth(vig)).set('Content-Type', tipo).send(Buffer.from(bytes)).expect(201)).body as { id: string; arquivos: { tipo: string }[] };
  const aplicar = async (id: string) => (await t.http().post(`/api/vigilancia/importacoes/${id}/aplicar`).set(auth(vig)).expect(200)).body as { vinculadosAutomaticamente: number };
  const importar = async (bytes: Uint8Array, nome: string, tipo?: string) => {
    const d = await enviar(bytes, nome, tipo);
    return { tipos: d.arquivos.map((a) => a.tipo), ...(await aplicar(d.id)) };
  };
  const lista = async <T>(caminho: string, q: Record<string, string | number> = {}) => (await t.http().get(`/api/vigilancia/conciliacao/${caminho}`).query(q).set(auth(vig)).expect(200)).body as Pagina<T>;
  const resumo = async () => (await t.http().get('/api/vigilancia/conciliacao/resumo').set(auth(vig)).expect(200)).body as { soOmnisaude: number; cobertura: { sistema: string; grupos: string[] | null }[] };
  const registro = (numero: string) => db.officialRecord.findFirstOrThrow({ where: { number: numero } });
  const nindinet = (v: Record<string, ValorEscrita>) => ({
    TP_NOT: '2',
    SG_UF_NOT: '35',
    ID_MUNICIP: MUN,
    ID_UNIDADE: UBS,
    SG_UF: '35',
    ID_MN_RESI: MUN,
    ...(typeof v.DT_NOTIFIC === 'string' ? { SEM_NOT: semanaDaData(v.DT_NOTIFIC).codigo, NU_ANO: v.DT_NOTIFIC.slice(0, 4) } : {}),
    ...v,
  });
  /** CSV do e-SUS Sinan (uma linha por registro). */
  const csvEsusSinan = (linhas: Record<string, string>[]) => {
    const cab = ['NU_NOTIFIC', 'ID_AGRAVO', 'DT_NOTIFIC', 'ID_MUNICIP', 'ID_UNIDADE', 'STATUS', 'NM_PACIENT', 'DT_NASC', 'CS_SEXO', 'CPF', 'CLASSI_FIN', 'CRITERIO', 'EVOLUCAO', 'DT_ENCERRA'];
    return new TextEncoder().encode(`${cab.join(';')}\r\n${linhas.map((l) => cab.map((c) => l[c] ?? '').join(';')).join('\r\n')}\r\n`);
  };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('vigconclistas', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    t.app.get(AiService).client = null;
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('os trechos de SQL repetem as regras do shared: CNS, CPF, nome de pessoa, número sem zeros e data do Sinan', async () => {
    // CNS definitivos e provisórios válidos, mais números quaisquer de 15 dígitos (quase todos inválidos).
    const provisorio = (prefixo: string) => [...Array(10).keys()].map((d) => `${prefixo}${d}`).find(isValidCns);
    const cnss = [
      ...Array.from({ length: 40 }, (_, i) => cnsFromBase(String(10000000000 + i * 7919))),
      ...['70000000000003', '81234567890123', '98765432109876', '71111111111111'].map(provisorio).filter((x): x is string => !!x),
      ...Array.from({ length: 200 }, (_, i) => String(100000000000000n + BigInt(i) * 4_999_999_999_937n).slice(0, 15)),
      '000000000000000',
      '123',
      'abcdefghijklmno',
    ];
    const cpfs = [
      ...Array.from({ length: 40 }, (_, i) => completeCpf(String(100000000 + i * 104_729))),
      ...Array.from({ length: 200 }, (_, i) => String(10_000_000_000 + i * 449_999_993).slice(0, 11)),
      '11111111111',
      '1234',
    ];
    const cns = await db.$queryRaw<{ v: string; ok: boolean }[]>`SELECT v, ${sqlCnsValido('v')} AS ok FROM unnest(${cnss}::text[]) AS v`;
    expect(cns.map((x) => [x.v, x.ok])).toEqual(cnss.map((v) => [v, isValidCns(v)]));
    expect(cns.filter((x) => x.ok).length).toBeGreaterThan(40);
    const cpf = await db.$queryRaw<{ v: string; ok: boolean }[]>`SELECT v, ${sqlCpfValido('v')} AS ok FROM unnest(${cpfs}::text[]) AS v`;
    expect(cpf.map((x) => [x.v, x.ok])).toEqual(cpfs.map((v) => [v, isValidCpf(v)]));
    const nomes = ['JOÃO DA CONCEIÇÃO', '  Maria  Aparecida-Simões ', "D'Ávila Ñúñez Müller", 'José Ângelo 3º', 'Ç', ''];
    const n = await db.$queryRaw<{ v: string; n: string }[]>`SELECT v, ${sqlNomePessoa('v')} AS n FROM unnest(${nomes}::text[]) AS v`;
    expect(n.map((x) => x.n)).toEqual(nomes.map((v) => normalizarNomePessoa(v)));
    const numeros = ['000123', '0', '000', ' 0012 ', 'A001', '7700001'];
    const z = await db.$queryRaw<{ v: string }[]>`SELECT ${sqlSemZeros('v')} AS v FROM unnest(${numeros}::text[]) WITH ORDINALITY AS u(v, i) ORDER BY i`;
    expect(z.map((x) => x.v)).toEqual(['123', '0', '0', '12', 'A001', '7700001']);
    // DT_NOTIFIC da ficha quando é uma data que existe; senão a data local (Brasília) da notificação.
    const datas = await db.$queryRaw<{ d: Date }[]>`
      SELECT ${sqlDataSinan(FUSO)} AS d FROM (VALUES
        (1, '{"DT_NOTIFIC": "2026-03-10"}'::jsonb, '2026-03-12 15:00:00'::timestamp, '2026-03-01 15:00:00'::timestamp),
        (2, '{"DT_NOTIFIC": "2026-02-30"}'::jsonb, '2026-03-12 02:00:00'::timestamp, '2026-03-01 15:00:00'::timestamp),
        (3, '{}'::jsonb, NULL, '2026-03-01 02:30:00'::timestamp)
      ) AS n(i, form, notified_at, known_at) ORDER BY i`;
    expect(datas.map((x) => x.d.toISOString().slice(0, 10))).toEqual(['2026-03-10', '2026-03-11', '2026-02-28']);
  });

  it('só no OmniSaúde: o DBF de um agravo cobre só o agravo, não o Sinan Net inteiro (a coqueluche não aparece)', async () => {
    const coque = await notificar('Caio Coqueluche Cobertura', 'M', '1951-01-01', 'A37.9');
    const lepto = await notificar('Leo Lepto Cobertura', 'M', '1952-02-02', 'A27.9');
    const d = hoje();
    const campos: CampoEscrita[] = [...CAMPOS_NINDINET, { nome: 'RES_ELISA', tipo: 'C', tamanho: 1 }];
    const r = await importar(escreverDbf(campos, [nindinet({ NU_NOTIFIC: '9100001', ID_AGRAVO: 'A279', DT_NOTIFIC: d, NM_PACIENT: 'OUTRA PESSOA LEPTO', CS_SEXO: 'F', RES_ELISA: '1' })]), 'LEPTONET.DBF');
    expect(r.tipos).toEqual(['AGRAVO_NET']);
    expect(r.vinculadosAutomaticamente).toBe(0);
    const so = await lista<{ id: string }>('so-omnisaude', { sistema: 'SINAN_NET' });
    expect(so.itens.map((i) => i.id)).toEqual([lepto.id]);
    expect(so.itens.map((i) => i.id)).not.toContain(coque.id);
    const res = await resumo();
    expect(res.soOmnisaude).toBe(1);
    expect(res.cobertura).toEqual([expect.objectContaining({ sistema: 'SINAN_NET', grupos: ['leptospirose'], de: d, ate: d })]);
  });

  it('só no OmniSaúde: o CSV do e-SUS Sinan só com Mpox não cobre o Oropouche; o CSV de SG do e-SUS Notifica não cobre o ESAVI', async () => {
    const oro = await notificar('Otto Oropouche Cobertura', 'M', '1953-03-03', 'A93.0');
    const d = hoje();
    const r1 = await importar(
      csvEsusSinan([{ NU_NOTIFIC: '352600009101', ID_AGRAVO: 'B04', DT_NOTIFIC: br(d), ID_MUNICIP: MUN, ID_UNIDADE: UBS, STATUS: 'Encerrada', NM_PACIENT: 'Pessoa Mpox Cobertura', CLASSI_FIN: '2', CRITERIO: '1' }]),
      'esus-sinan-mpox.csv',
      'text/csv',
    );
    expect(r1.tipos).toEqual(['ESUS_SINAN_CSV']);
    expect((await lista<{ id: string }>('so-omnisaude', { busca: 'OTTO OROPOUCHE' })).itens).toEqual([]);
    expect((await resumo()).cobertura).toEqual(expect.arrayContaining([expect.objectContaining({ sistema: 'ESUS_SINAN', grupos: ['mpox'] })]));
    expect(oro.id).toBeTruthy();

    const covid = await notificar('Ciro Covid Cobertura', 'M', '1954-04-04', 'U07.1');
    const esavi = await notificar('Elias Esavi Cobertura', 'M', '1955-05-05', 'T88.0');
    const cab = ['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Data de Nascimento', 'Sexo', 'Sintoma- Febre', 'Classificação Final'];
    const csv = `﻿${cab.map((c) => `"${c}"`).join(';')}\r\n${['351234509101', br(d), '3550308', UBS, 'Outra Pessoa Sg', '01/01/1980', 'Feminino', 'Sim', 'Descartado'].join(';')}\r\n`;
    const r2 = await importar(new TextEncoder().encode(csv), 'esus-notifica-sg.csv', 'text/csv');
    expect(r2.tipos).toEqual(['ESUS_NOTIFICA_CSV']);
    const so = await lista<{ id: string }>('so-omnisaude', { sistema: 'ESUS_NOTIFICA' });
    expect(so.itens.map((i) => i.id)).toEqual([covid.id]);
    expect(so.itens.map((i) => i.id)).not.toContain(esavi.id);
    expect((await resumo()).cobertura).toEqual(expect.arrayContaining([expect.objectContaining({ sistema: 'ESUS_NOTIFICA', grupos: ['covid'] })]));
  });

  it('violência sexual (T74.2) casa com o Y09 pelo CNS (vínculo automático) e pelo nome, nascimento e sexo (sugestão)', async () => {
    const pelaIdentidade = await notificar('Vitor Violencia Cns', 'M', '1980-06-06', 'T74.2');
    const peloNome = await notificar('Valter Violencia Nome', 'M', '1981-07-07', 'T74.2');
    const d = hoje();
    const r = await importar(
      escreverDbf(CAMPOS_NINDINET, [
        nindinet({ NU_NOTIFIC: '9200001', ID_AGRAVO: 'Y09', DT_NOTIFIC: d, NM_PACIENT: 'NOME DIGITADO DIFERENTE', CS_SEXO: 'M', ID_CNS_SUS: pelaIdentidade.cns }),
        nindinet({ NU_NOTIFIC: '9200002', ID_AGRAVO: 'Y09', DT_NOTIFIC: d, NM_PACIENT: 'VALTER VIOLÊNCIA NOME', CS_SEXO: 'M', DT_NASC: peloNome.nasc }),
      ]),
      'NINDINET-violencia.DBF',
    );
    expect(r.tipos).toEqual(['NINDINET']);
    expect(r.vinculadosAutomaticamente).toBe(1);
    expect(await registro('9200001')).toMatchObject({ groupKey: 'violencia', notificationId: pelaIdentidade.id, matchMethod: 'IDENTIDADE' });
    const b = await registro('9200002');
    expect(b.notificationId).toBeNull();
    const sug = await lista<{ degrau: number; registro: { id: string }; notificacao: { id: string } }>('sugestoes', { busca: 'valter violencia' });
    expect(sug.itens).toEqual([expect.objectContaining({ degrau: 3, registro: expect.objectContaining({ id: b.id }), notificacao: expect.objectContaining({ id: peloNome.id }) })]);
    // O filtro de grupo pega o par pelos dois lados (o registro é "violencia"; a notificação, "violencia-sexual-suicidio").
    expect((await lista('sugestoes', { grupo: 'violencia-sexual-suicidio', busca: 'valter' })).total).toBe(1);
    expect((await lista<{ id: string }>('so-omnisaude', { busca: 'VALTER VIOLENCIA' })).itens.map((i) => i.id)).toEqual([peloNome.id]);
  });

  it('divergências de Mpox: a evolução do e-SUS Sinan (1 óbito, 2 cura) é traduzida antes de comparar com a do OmniSaúde', async () => {
    const obito = await notificar('Mauro Mpox Obito', 'M', '1982-08-08', 'B04');
    const cura = await notificar('Mario Mpox Cura', 'M', '1983-09-09', 'B04');
    const d = hoje();
    // As duas notificações do OmniSaúde encerradas como cura (EVOLUCAO 1 da ficha do Sinan Net).
    await db.notification.updateMany({ where: { id: { in: [obito.id, cura.id] } }, data: { status: 'ENCERRADA', finalClass: '1', criterion: '1', evolution: '1', closedAt: new Date(`${d}T00:00:00Z`) } });
    const linha = (numero: string, p: { cpf: string; nome: string; nasc: string }, evolucao: string) => ({
      NU_NOTIFIC: numero,
      ID_AGRAVO: 'B04',
      DT_NOTIFIC: br(d),
      ID_MUNICIP: MUN,
      ID_UNIDADE: UBS,
      STATUS: 'Encerrada',
      NM_PACIENT: p.nome,
      DT_NASC: br(p.nasc),
      CS_SEXO: 'M',
      CPF: p.cpf,
      CLASSI_FIN: '1',
      CRITERIO: '1',
      EVOLUCAO: evolucao,
      DT_ENCERRA: br(d),
    });
    const r = await importar(csvEsusSinan([linha('352600009201', obito, '1'), linha('352600009202', cura, '2')]), 'esus-sinan-mpox-2.csv', 'text/csv');
    expect(r.vinculadosAutomaticamente).toBe(2);
    expect(await registro('352600009201')).toMatchObject({ notificationId: obito.id, groupKey: 'mpox', evolution: '1', situation: 'CONFIRMADO' });
    const div = await lista<Par>('divergentes', { busca: '3526000092' });
    expect(div.itens.map((p) => p.notificacao.id)).toEqual([obito.id]);
    expect(div.itens[0]!.divergencias).toEqual([{ campo: 'evolucao', oficial: '2', omnisaude: '1' }]);
    // O par da cura não diverge, mas está entre os vinculados (com as diferenças vazias).
    const vinc = await lista<Par>('vinculados', { busca: '352600009202' });
    expect(vinc.itens).toEqual([expect.objectContaining({ notificacao: expect.objectContaining({ id: cura.id }), divergencias: [] })]);
  });

  it('vinculados (K9): busca, método, página com porPagina (K11), auditoria e desvínculo que tira o par da lista', async () => {
    // Lista nominal: cada página mostrada com nome deixa uma entrada na auditoria.
    const auditadas = () => db.auditEntry.count({ where: { action: 'vigilancia.conciliacao_lista' } });
    const antes = await auditadas();
    const todos = await lista<Par>('vinculados');
    expect(await auditadas()).toBe(antes + 1);
    expect(todos).toMatchObject({ pagina: 1, porPagina: 50 });
    expect(todos.total).toBe(3);
    expect(todos.itens.map((p) => p.registro.numero).sort()).toEqual(['352600009201', '352600009202', '9200001']);
    expect(todos.itens.every((p) => p.registro.vinculo?.metodo === 'IDENTIDADE')).toBe(true);
    expect((await lista('vinculados', { metodo: 'MANUAL' })).total).toBe(0);
    expect((await lista('vinculados', { pagina: 2 })).itens).toEqual([]);
    for (const caminho of ['so-oficial', 'so-omnisaude', 'divergentes', 'sugestoes']) expect((await lista(caminho)).porPagina).toBe(50);
    // O registro de violência é sigiloso: quem vê com nome deixa a marca na auditoria.
    const y09 = await registro('9200001');
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.conciliacao_ver_sensivel', entityId: y09.id } })).toBeGreaterThanOrEqual(1);

    await t.http().post('/api/vigilancia/conciliacao/desvincular').set(auth(vig)).send({ recordId: y09.id, motivo: 'Vinculado por engano na lista.' }).expect(200);
    expect((await lista('vinculados', { busca: '9200001' })).total).toBe(0);
    expect((await lista<{ id: string }>('so-oficial', { busca: '9200001' })).itens.map((i) => i.id)).toEqual([y09.id]);
    expect((await lista('vinculados')).total).toBe(2);
  });

  it('data que não existe no calendário e período invertido dão 400 (listas e envio), sem erro interno', async () => {
    for (const q of [{ de: '2025-13-01' }, { de: '2025-02-30' }, { ate: '2025-00-10' }, { de: '2025-03-10', ate: '2025-03-01' }])
      await t.http().get('/api/vigilancia/conciliacao/so-oficial').query(q).set(auth(vig)).expect(400);
    await t.http().get('/api/vigilancia/conciliacao/vinculados').query({ metodo: 'OUTRO' }).set(auth(vig)).expect(400);
    const arquivo = Buffer.from(escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '9300001', ID_AGRAVO: 'A279', DT_NOTIFIC: '2025-02-10' })]));
    for (const q of [
      { de: '2025-13-01', ate: '2025-13-31' },
      { de: '2025-02-01', ate: '2025-02-30' },
      { de: '2025-03-01', ate: '2025-02-01' },
    ])
      await t
        .http()
        .post('/api/vigilancia/importacoes')
        .query({ nome: 'periodo.dbf', ...q })
        .set(auth(vig))
        .set('Content-Type', 'application/octet-stream')
        .send(arquivo)
        .expect(400);
    // A data válida continua aceita.
    await t.http().get('/api/vigilancia/conciliacao/so-oficial').query({ de: '2024-02-29', ate: '2026-12-31' }).set(auth(vig)).expect(200);
  });
});
