import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString, normalizarNomePessoa, semanaDaData, semanaEpidemiologica } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

/**
 * Conciliação, terceira rodada da semana 27 (VIG-1c): o "só no OmniSaúde" com o arquivo de um CNES só
 * (imp-cobertura-so-omni), o período que termina na data do envio (conciliacao-3), o DBF do Y09 cobrindo a violência
 * sexual e a tentativa de suicídio (conciliacao-2), o degrau 3 com a mesma normalização de nome dos dois lados
 * (conciliacao-5) e os bairros sem correspondência contados no resumo e paginados na lista sem parar o laço de eventos
 * (conciliacao-1). Dados sintéticos: nomes, números, CPF e CNS inventados.
 */

const enabled = await pgAvailable();
const FUSO = 'America/Sao_Paulo';
const MUN = '355030';
const UBS = '9000011';
const UPA = '9000036';
const DIA = 86_400_000;

type Pagina<T> = { total: number; pagina: number; porPagina: number; itens: T[] };
type Cobertura = { sistema: string; grupos: string[] | null; cnes: string | null; de: string; ate: string };
type Bairro = { nome: string; nomeNormalizado: string; registros: number; candidatos: { nome: string }[] };

describe.runIf(enabled)('Vigilância: cobertura do "só no OmniSaúde" e bairros sem correspondência (terceira rodada)', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao = '';
  let medica = '';
  let vig = '';
  let autor = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let seq = 0;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const address = { cep: '01001000', street: 'Rua da Cobertura', number: '27', district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' };
  const diaLocal = (d: Date) => localDateString(d, FUSO);
  const hoje = () => diaLocal(new Date());
  const unidade = async (cnes: string) => (await db.unit.findUniqueOrThrow({ where: { cnes }, select: { id: true } })).id;

  /** Notificação confirmada pelo atendimento (CID no SOAP assinado), como a unidade faz. */
  const notificar = async (nome: string, nasc: string, cid: string) => {
    seq++;
    const body = { name: nome, birthDate: nasc, sex: 'M', cpf: completeCpf(String(275000900 + seq)), cns: cnsFromBase(String(27500000900 + seq)), motherName: `Mae de ${nome}`, phone: '(11) 97777-2703', address };
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
    const [c] = (await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth(medica)).expect(200)).body.notificacoes as { id: string }[];
    if (!c) throw new Error(`${cid}: nenhuma notificação aberta`);
    const conf = await t.http().post(`/api/vigilancia/notificacoes/${c.id}/confirmar`).set(auth(medica));
    if (conf.status !== 200) throw new Error(`confirmar ${cid}: ${conf.status} ${JSON.stringify(conf.body)}`);
    return c.id;
  };
  /** Importação aplicada montada direto no banco (o arquivo com o CNES ou o envio de dias atrás). */
  const importacao = async (o: { sistema: 'SINAN_NET' | 'ESUS_NOTIFICA'; arquivo: Record<string, unknown>; declarado?: [string, string]; enviadaEm?: Date }) =>
    (
      await db.officialImport.create({
        data: {
          system: o.sistema,
          status: 'APLICADA',
          fileName: String(o.arquivo.nome),
          sha256: String(++seq).padStart(64, 'c'),
          sizeBytes: 1,
          files: [{ tipoRegistro: 'INDIVIDUAL', tamanhoBytes: 1, registros: 1, codificacao: null, origemCodificacao: null, agravos: [], identificado: true, ignorado: false, avisos: [], ...o.arquivo }],
          periodFrom: o.declarado ? new Date(`${o.declarado[0]}T00:00:00Z`) : null,
          periodTo: o.declarado ? new Date(`${o.declarado[1]}T00:00:00Z`) : null,
          declaredPeriod: !!o.declarado,
          createdBy: autor,
          createdAt: o.enviadaEm ?? new Date(),
          appliedBy: autor,
          appliedAt: new Date(),
        },
      })
    ).id;
  const lista = async <T>(caminho: string, q: Record<string, string | number> = {}) => (await t.http().get(`/api/vigilancia/conciliacao/${caminho}`).query(q).set(auth(vig)).expect(200)).body as Pagina<T>;
  const soOmni = async (sistema: string) => (await lista<{ id: string }>('so-omnisaude', { sistema })).itens.map((i) => i.id);
  const resumo = async () => (await t.http().get('/api/vigilancia/conciliacao/resumo').set(auth(vig)).expect(200)).body as { cobertura: Cobertura[]; bairrosSemCorrespondencia: number };
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

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('vigconccob', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    t.app.get(AiService).client = null;
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    autor = (await db.user.findUniqueOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf } })).id;
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('imp-cobertura-so-omni: o CSV do e-SUS Notifica de um CNES só cobre só a unidade com esse CNES', async () => {
    const naUbs = await notificar('Caio Covid Ubs Cobertura', '1960-01-01', 'U07.1');
    const naUpa = await notificar('Ciro Covid Upa Cobertura', '1961-02-02', 'U07.1');
    await db.notification.update({ where: { id: naUpa }, data: { unitId: await unidade(UPA) } });
    const d = hoje();
    // O arquivo da exportação do autocadastro: só a UPA (a importação grava o CNES único em files[].cnes).
    await importacao({ sistema: 'ESUS_NOTIFICA', arquivo: { nome: 'esus-notifica-upa.csv', tipo: 'ESUS_NOTIFICA_CSV', sistema: 'ESUS_NOTIFICA', grupos: ['covid'], periodo: { de: d, ate: d }, cnes: UPA } });
    expect(await soOmni('ESUS_NOTIFICA')).toEqual([naUpa]);
    expect((await resumo()).cobertura).toEqual([{ sistema: 'ESUS_NOTIFICA', grupos: ['covid'], cnes: UPA, de: d, ate: d }]);
    // Um arquivo antigo, sem o campo, cobre todas as unidades: a notificação da UBS entra.
    await importacao({ sistema: 'ESUS_NOTIFICA', arquivo: { nome: 'esus-notifica-todas.csv', tipo: 'ESUS_NOTIFICA_CSV', sistema: 'ESUS_NOTIFICA', grupos: ['covid'], periodo: { de: d, ate: d } } });
    expect((await soOmni('ESUS_NOTIFICA')).sort()).toEqual([naUbs, naUpa].sort());
    expect((await resumo()).cobertura.filter((c) => c.sistema === 'ESUS_NOTIFICA')).toEqual([
      { sistema: 'ESUS_NOTIFICA', grupos: ['covid'], cnes: null, de: d, ate: d },
      { sistema: 'ESUS_NOTIFICA', grupos: ['covid'], cnes: UPA, de: d, ate: d },
    ]);
  });

  it('conciliacao-2: o DBF só do Y09 cobre também a violência sexual (T74.2) e a tentativa de suicídio (X70)', async () => {
    // Antes do NINDINET do teste seguinte: aqui só o arquivo do Y09 cobre o Sinan Net.
    const interpessoal = await notificar('Vitor Violencia Interpessoal', '1980-06-06', 'T74.1');
    const sexual = await notificar('Valter Violencia Sexual', '1981-07-07', 'T74.2');
    const tentativa = await notificar('Vicente Tentativa Suicidio', '1982-08-08', 'X70');
    const d = hoje();
    // Um campo da ficha de investigação da violência faz o arquivo ser o DBF do agravo (AGRAVO_NET), não o NINDINET.
    const campos: CampoEscrita[] = [...CAMPOS_NINDINET, { nome: 'VIOL_FISIC', tipo: 'C', tamanho: 1 }];
    const envio = (
      await t
        .http()
        .post('/api/vigilancia/importacoes')
        .query({ nome: 'VIOLENET.DBF' })
        .set(auth(vig))
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(escreverDbf(campos, [nindinet({ NU_NOTIFIC: '9400001', ID_AGRAVO: 'Y09', DT_NOTIFIC: d, NM_PACIENT: 'OUTRA PESSOA DA VIOLENCIA', CS_SEXO: 'F', VIOL_FISIC: '1' })])))
        .expect(201)
    ).body as { id: string; arquivos: { tipo: string }[] };
    expect(envio.arquivos.map((a) => a.tipo)).toEqual(['AGRAVO_NET']);
    await t.http().post(`/api/vigilancia/importacoes/${envio.id}/aplicar`).set(auth(vig)).expect(200);
    expect((await soOmni('SINAN_NET')).sort()).toEqual([interpessoal, sexual, tentativa].sort());
    expect((await resumo()).cobertura).toEqual(expect.arrayContaining([{ sistema: 'SINAN_NET', grupos: ['violencia', 'violencia-sexual-suicidio'], cnes: null, de: d, ate: d }]));
  });

  it('conciliacao-3: o período declarado vai só até a data do envio; a notificação feita depois não fica "só no OmniSaúde"', async () => {
    const agora = Date.now();
    const enviadaEm = new Date(agora - 10 * DIA);
    const declarado: [string, string] = [diaLocal(new Date(agora - 60 * DIA)), diaLocal(new Date(agora + 60 * DIA))];
    // NINDINET enviado há 10 dias, declarando um período que passa de hoje (como o "ano inteiro" do aviso da prévia).
    await importacao({ sistema: 'SINAN_NET', arquivo: { nome: 'NINDINET.DBF', tipo: 'NINDINET', sistema: 'SINAN_NET', periodo: { de: declarado[0], ate: diaLocal(enviadaEm) } }, declarado, enviadaEm });
    const depois = await notificar('Leo Lepto Depois Do Envio', '1962-03-03', 'A27.9');
    const antes = await notificar('Lia Lepto Antes Do Envio', '1963-04-04', 'A27.9');
    // A segunda é de 20 dias atrás (DT_NOTIFIC da ficha): estava na exportação.
    await db.$executeRaw`UPDATE notifications SET form = jsonb_set(form, '{DT_NOTIFIC}', to_jsonb(${diaLocal(new Date(agora - 20 * DIA))}::text)) WHERE id = ${antes}::uuid`;
    const so = await soOmni('SINAN_NET');
    expect(so).toContain(antes);
    expect(so).not.toContain(depois);
    expect((await resumo()).cobertura.find((c) => c.sistema === 'SINAN_NET' && c.grupos === null)).toEqual({ sistema: 'SINAN_NET', grupos: null, cnes: null, de: declarado[0], ate: diaLocal(enviadaEm) });
  });

  it('conciliacao-5: o degrau 3 normaliza o nome dos dois lados do mesmo jeito (ß no OmniSaúde e no Sinan)', async () => {
    const n = await notificar('Pedro Weiß Teixeira', '1970-01-01', 'A37.9');
    const d = hoje();
    const imp = await importacao({ sistema: 'SINAN_NET', arquivo: { nome: 'COQUENET.DBF', tipo: 'AGRAVO_NET', sistema: 'SINAN_NET', agravos: ['A379'], periodo: { de: d, ate: d } } });
    const r = await db.officialRecord.create({
      data: {
        system: 'SINAN_NET',
        type: 'INDIVIDUAL',
        naturalKey: `7709001|${d}|${MUN}|A379`,
        number: '7709001',
        notifiedOn: new Date(`${d}T00:00:00Z`),
        epiWeekNotified: semanaEpidemiologica(new Date(), FUSO).codigo,
        municipalityIbge: MUN,
        unitCnes: UBS,
        agravo: 'A379',
        groupKey: 'coqueluche',
        situation: 'EM_INVESTIGACAO',
        patientName: 'PEDRO WEIß TEIXEIRA',
        // Como a importação grava (normalizarNomePessoa do NM_PACIENT).
        patientNameNorm: normalizarNomePessoa('PEDRO WEIß TEIXEIRA'),
        birthDate: new Date('1970-01-01T00:00:00Z'),
        sex: 'M',
        contentHash: 'd'.repeat(64),
        firstImportId: imp,
        lastImportId: imp,
        lastSeenAt: new Date(),
      },
    });
    const sug = await lista<{ degrau: number; registro: { id: string }; notificacao: { id: string } }>('sugestoes', { busca: '7709001' });
    expect(sug.itens).toEqual([expect.objectContaining({ degrau: 3, registro: expect.objectContaining({ id: r.id }), notificacao: expect.objectContaining({ id: n }) })]);
  });

  it('conciliacao-1: o resumo só conta os nomes sem correspondência e a lista pagina de 50 em 50, sem parar o laço de eventos', async () => {
    const localidade = await db.locality.create({ data: { code: 'BSC', name: 'Localidade dos Bairros Oficiais' } });
    await db.neighborhood.createMany({ data: Array.from({ length: 300 }, (_, i) => ({ localityId: localidade.id, name: `Jardim Oficial ${i}`, aliases: [`Jd Oficial ${i}`] })) });
    const imp = await importacao({ sistema: 'SINAN_NET', arquivo: { nome: 'BAIRROS.DBF', tipo: 'AGRAVO_NET', sistema: 'SINAN_NET', agravos: ['A279'], periodo: { de: '2020-01-01', ate: '2020-01-01' } } });
    // 2.000 grafias livres de ~15 letras, sem correspondência, e uma parecida com os bairros (5 registros: vem primeiro).
    const letras = (i: number) => Array.from({ length: 6 }, (_, k) => String.fromCharCode(65 + (Math.floor(i / 26 ** k) % 26))).join('');
    const registro = (i: number, nome: string) => ({
      system: 'SINAN_NET' as const,
      type: 'INDIVIDUAL' as const,
      naturalKey: `bairro-${i}`,
      number: String(8_000_000 + i),
      notifiedOn: new Date('2020-01-01T00:00:00Z'),
      residenceIbge: '3550308',
      neighborhoodName: nome,
      agravo: 'A279',
      groupKey: 'leptospirose',
      situation: 'CONFIRMADO',
      contentHash: '0'.repeat(64),
      firstImportId: imp,
      lastImportId: imp,
      lastSeenAt: new Date(),
    });
    await db.officialRecord.createMany({
      data: [...Array.from({ length: 2000 }, (_, i) => registro(i, `Vila Livre ${letras(i)}`)), ...Array.from({ length: 5 }, (_, i) => registro(3000 + i, 'JARDIM OFICIAL 7A'))],
    });

    /** Maior atraso do laço de eventos (setInterval de 10 ms) enquanto o pedido roda no mesmo processo da API. */
    const medir = async <T>(fn: () => Promise<T>) => {
      let maior = 0;
      let ultimo = performance.now();
      const timer = setInterval(() => {
        const agora = performance.now();
        maior = Math.max(maior, agora - ultimo - 10);
        ultimo = agora;
      }, 10);
      try {
        return { r: await fn(), maior };
      } finally {
        clearInterval(timer);
      }
    };
    const r = await medir(resumo);
    const p1 = await medir(() => lista<Bairro>('bairros'));
    const ultima = await medir(() => lista<Bairro>('bairros', { pagina: 41 }));
    console.log(`conciliacao-1: laço parado no resumo ${r.maior.toFixed(0)} ms; na lista ${p1.maior.toFixed(0)} ms e ${ultima.maior.toFixed(0)} ms`);
    expect(r.r.bairrosSemCorrespondencia).toBe(2001);
    expect(p1.r).toMatchObject({ total: 2001, pagina: 1, porPagina: 50 });
    expect(p1.r.itens).toHaveLength(50);
    expect(p1.r.itens[0]).toMatchObject({ nome: 'JARDIM OFICIAL 7A', nomeNormalizado: 'JARDIM OFICIAL 7A', registros: 5 });
    expect(p1.r.itens[0]!.candidatos.length).toBeGreaterThan(0);
    expect(p1.r.itens[0]!.candidatos.length).toBeLessThanOrEqual(5);
    expect(p1.r.itens[0]!.candidatos.every((c) => c.nome.startsWith('Jardim Oficial 7'))).toBe(true);
    expect(ultima.r.itens.map((b) => b.registros)).toEqual([1]);
    // Antes, 2.000 nomes × 300 bairros paravam o laço por ~4 s (a API de todos os tenants).
    expect(r.maior).toBeLessThan(1000);
    expect(p1.maior).toBeLessThan(1000);
    expect(ultima.maior).toBeLessThan(1000);
  });
});
