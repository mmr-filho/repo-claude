import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString, normalizarNomePessoa, roleHasPermission, semanaDaData, semanaEpidemiologica } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '../src/core/context';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { ConciliacaoService } from '../src/modules/vigilancia/conciliacao.service';
import { ConsolidadoService } from '../src/modules/vigilancia/consolidado.service';
import { NotificacaoService } from '../src/modules/vigilancia/notificacao.service';
import { CAMPOS_NINDINET, escreverDbf, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

/**
 * Conciliação, quarta rodada da semana 27 (VIG-1c). conciliacao-3: o fim da cobertura é a data do primeiro envio do
 * mesmo arquivo, também no reenvio que declara o período, na conciliação e na base consolidada. N5: o diálogo
 * "Vincular…" do registro busca nas candidatas ao vínculo, sem a cobertura (a notificação do mesmo caso feita em outra
 * unidade ou depois do envio), com o sigilo das listas. N6: o par que já são duas linhas da planilha do mesmo surto
 * aberto não se vincula (409 no manual; o automático pula e a sugestão avisa). N7: na base consolidada, o registro do
 * Y09 ligado à violência sexual ou à tentativa de suicídio conta no grupo da notificação; a dengue reclassificada como
 * chikungunya conta em chikungunya. Contrato da SUBSTITUIDA: só a APLICADA cobre. Dados sintéticos: nomes, números, CPF
 * e CNS inventados.
 */

const enabled = await pgAvailable();
const FUSO = 'America/Sao_Paulo';
const MUN = '355030';
const UBS = '9000011';
const UPA = '9000036';
const DIA = 86_400_000;

type Pagina<T> = { total: number; pagina: number; porPagina: number; itens: T[] };
type Cobertura = { sistema: string; grupos: string[] | null; cnes: string | null; de: string; ate: string };
type Notificacao = { id: string; numero: string; grupo: string; paciente: { nome: string | null } | null; sigilosa: boolean };
type Detalhe = { id: string; numero: string; casosNaPlanilha: number; planilha: { id: string; numero: number; notificationId: string | null; officialRecordId: string | null }[] };

describe.runIf(enabled)('Vigilância: conciliação, quarta rodada (cobertura, candidatas, surto e base consolidada)', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let tenants: TenantsService;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let autor = '';
  let ubsId = '';
  let seq = 0;
  const tk: Record<string, string> = {};
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const diaLocal = (ms: number) => localDateString(new Date(ms), FUSO);
  const hoje = () => diaLocal(Date.now());
  const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const address = { cep: '01001000', street: 'Rua da Quarta Rodada', number: '27', district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' };

  const paciente = async (nome: string, nasc: string, sex: 'M' | 'F' = 'M', cns?: string) => {
    seq++;
    const body = {
      name: nome,
      birthDate: nasc,
      sex,
      confirmNotDuplicate: true,
      cpf: completeCpf(String(291000100 + seq)),
      cns: cns ?? cnsFromBase(String(29100000100 + seq)),
      motherName: `Mae de ${nome}`,
      phone: '(11) 97777-2791',
      address,
    };
    return (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
  };
  /** Notificação confirmada pelo atendimento (CID no SOAP assinado), como a unidade faz. */
  const notificarPorCid = async (patientId: string, cid: string) => {
    const enc = (await t.http().post('/api/reception/check-in').set(auth('recepcao')).send({ patientId, kind: 'AMBULATORIAL' }).expect(201)).body;
    await t.http().post(`/api/clinical/encounters/${enc.id}/start`).set(auth('medica')).expect(200);
    const note = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc.id}/notes`)
        .set(auth('medica'))
        .send({ kind: 'SOAP', subjective: 'Queixa.', objective: 'Exame.', assessment: 'Hipótese.', plan: 'Conduta.', codes: [{ system: 'CID10', code: cid }] })
        .expect(201)
    ).body;
    const [c] = (await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth('medica')).expect(200)).body.notificacoes as { id: string }[];
    if (!c) throw new Error(`${cid}: nenhuma notificação aberta`);
    const conf = await t.http().post(`/api/vigilancia/notificacoes/${c.id}/confirmar`).set(auth('medica'));
    if (conf.status !== 200) throw new Error(`confirmar ${cid}: ${conf.status} ${JSON.stringify(conf.body)}`);
    return c.id;
  };
  /** Notificação de coqueluche (ou outro agravo da lista) confirmada direto pela vigilância. */
  const notificar = async (nome: string, conditionKey = 'coqueluche') => {
    const p = await paciente(nome, '1979-09-09');
    const n = (await t.http().post('/api/vigilancia/notificacoes').set(auth('medica')).send({ patientId: p, conditionKey }).expect(201)).body as { id: string };
    expect((await t.http().post(`/api/vigilancia/notificacoes/${n.id}/confirmar`).set(auth('medica')).expect(200)).body.status).toBe('NOTIFICADA');
    return n.id;
  };
  /** Registro oficial gravado direto (o que uma importação anterior deixou), sem vínculo. */
  const registro = async (o: { numero: string; agravo: string; grupo: string; sistema?: 'SINAN_NET' | 'SINAN_ONLINE'; dia?: string; nome?: string; nascimento?: string; sensivel?: boolean }) => {
    const d = o.dia ?? hoje();
    const imp = await importacaoNoBanco({ nome: `base-${o.numero}.dbf`, sistema: o.sistema ?? 'SINAN_NET', arquivo: { tipo: 'AGRAVO_NET', agravos: [o.agravo], periodo: { de: d, ate: d } } });
    return (
      await db.officialRecord.create({
        data: {
          system: o.sistema ?? 'SINAN_NET',
          type: 'INDIVIDUAL',
          naturalKey: `${o.numero}|${d}|${MUN}|${o.agravo}`,
          number: o.numero,
          notifiedOn: new Date(`${d}T00:00:00Z`),
          epiWeekNotified: semanaDaData(d).codigo,
          epiWeekOnset: semanaDaData(d).codigo,
          symptomsOnset: new Date(`${d}T00:00:00Z`),
          municipalityIbge: MUN,
          residenceIbge: '3550308',
          unitCnes: UBS,
          unitId: ubsId,
          agravo: o.agravo,
          groupKey: o.grupo,
          situation: 'CONFIRMADO',
          sensitive: o.sensivel ?? false,
          patientName: o.nome ?? `PESSOA DO REGISTRO ${o.numero}`,
          // Como a importação grava (normalizarNomePessoa do NM_PACIENT).
          patientNameNorm: normalizarNomePessoa(o.nome ?? `PESSOA DO REGISTRO ${o.numero}`),
          birthDate: o.nascimento ? new Date(`${o.nascimento}T00:00:00Z`) : null,
          sex: 'M',
          contentHash: 'e'.repeat(64),
          firstImportId: imp,
          lastImportId: imp,
          lastSeenAt: new Date(),
        },
      })
    ).id;
  };
  /** Importação aplicada montada direto no banco. */
  const importacaoNoBanco = async (o: {
    nome: string;
    sistema: 'SINAN_NET' | 'SINAN_ONLINE' | 'ESUS_NOTIFICA';
    arquivo: Record<string, unknown>;
    status?: 'APLICADA' | 'SUBSTITUIDA';
    substituidaPor?: string;
    declarado?: [string, string];
    enviadaEm?: Date;
    sha?: string;
  }) =>
    (
      await db.officialImport.create({
        data: {
          system: o.sistema,
          status: o.status ?? 'APLICADA',
          supersededBy: o.substituidaPor ?? null,
          periodFrom: o.declarado ? new Date(`${o.declarado[0]}T00:00:00Z`) : null,
          periodTo: o.declarado ? new Date(`${o.declarado[1]}T00:00:00Z`) : null,
          declaredPeriod: !!o.declarado,
          fileName: o.nome,
          sha256: o.sha ?? String(++seq).padStart(64, 'f'),
          sizeBytes: 1,
          files: [
            {
              nome: o.nome,
              sistema: o.sistema,
              tipoRegistro: 'INDIVIDUAL',
              tamanhoBytes: 1,
              registros: 1,
              codificacao: null,
              origemCodificacao: null,
              agravos: [],
              identificado: true,
              ignorado: false,
              avisos: [],
              ...o.arquivo,
            },
          ],
          createdBy: autor,
          createdAt: o.enviadaEm ?? new Date(),
          appliedBy: autor,
          appliedAt: new Date(),
        },
      })
    ).id;
  const lista = async <T>(caminho: string, q: Record<string, string | number> = {}) => (await t.http().get(`/api/vigilancia/conciliacao/${caminho}`).query(q).set(auth('vig')).expect(200)).body as Pagina<T>;
  const ids = (p: Pagina<{ id: string }>) => p.itens.map((i) => i.id);
  const resumo = async () => (await t.http().get('/api/vigilancia/conciliacao/resumo').set(auth('vig')).expect(200)).body as { cobertura: Cobertura[] };
  const vincular = (recordId: string, notificationId: string) => t.http().post('/api/vigilancia/conciliacao/vincular').set(auth('vig')).send({ recordId, notificationId, motivo: 'Mesmo caso.' });
  const vinculo = async (recordId: string) => (await db.officialRecord.findUniqueOrThrow({ where: { id: recordId }, select: { notificationId: true } })).notificationId;
  const tarefa = async () => {
    tenants.connections.invalidate(t.slug);
    const tenant = await tenants.resolve(t.slug);
    return t.app.get(NotificacaoService).tarefa({ tenant, db: await tenants.client(tenant.id) });
  };
  const sistema = async () => {
    const tenant = await tenants.resolve(t.slug);
    return { tenant, db: await tenants.client(tenant.id) };
  };
  const nindinet = (v: Record<string, ValorEscrita>): Record<string, ValorEscrita> => ({
    TP_NOT: '2',
    SG_UF_NOT: '35',
    ID_MUNICIP: MUN,
    ID_UNIDADE: UBS,
    SG_UF: '35',
    ID_MN_RESI: MUN,
    ...(typeof v.DT_NOTIFIC === 'string' ? { SEM_NOT: semanaDaData(v.DT_NOTIFIC).codigo, NU_ANO: v.DT_NOTIFIC.slice(0, 4) } : {}),
    ...v,
  });
  const enviar = (bytes: Uint8Array, nome: string, q: Record<string, string> = {}, tipo = 'application/octet-stream') =>
    t
      .http()
      .post('/api/vigilancia/importacoes')
      .query({ nome, ...q })
      .set(auth('vig'))
      .set('Content-Type', tipo)
      .send(Buffer.from(bytes));
  const enviarEAplicar = async (bytes: Uint8Array, nome: string, q: Record<string, string> = {}, tipo?: string) => {
    const envio = (await enviar(bytes, nome, q, tipo).expect(201)).body as { id: string };
    const ap = (await t.http().post(`/api/vigilancia/importacoes/${envio.id}/aplicar`).set(auth('vig')).expect(200)).body as { vinculadosAutomaticamente: number };
    return { id: envio.id, vinculados: ap.vinculadosAutomaticamente };
  };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('vigconcr4', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    autor = (await db.user.findUniqueOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf } })).id;
    ubsId = (await db.unit.findUniqueOrThrow({ where: { cnes: UBS } })).id;
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('conciliacao-3: o mesmo arquivo reenviado para declarar o período não leva o fim da cobertura além do primeiro envio', async () => {
    const agora = Date.now();
    const d20 = diaLocal(agora - 20 * DIA);
    const d10 = diaLocal(agora - 10 * DIA);
    const arquivo = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '7705001', ID_AGRAVO: 'A379', DT_NOTIFIC: d20, NM_PACIENT: 'OUTRA PESSOA DO REENVIO', CS_SEXO: 'F' })]);
    // 1º envio, há 10 dias, sem período declarado (o período lido é o da única notificação, de 20 dias atrás).
    const primeiro = await enviarEAplicar(arquivo, 'NINDINET.DBF');
    await db.$executeRaw`UPDATE official_imports SET created_at = created_at - interval '10 days' WHERE id = ${primeiro.id}::uuid`;
    // Notificação de coqueluche de 5 dias atrás (DT_NOTIFIC da ficha): feita depois do 1º envio, não está no arquivo.
    const n = await notificar('Paciente Reenvio Quarta Rodada');
    await db.$executeRaw`UPDATE notifications SET form = jsonb_set(form, '{DT_NOTIFIC}', to_jsonb(${diaLocal(agora - 5 * DIA)}::text)) WHERE id = ${n}::uuid`;
    const so = async () => ids(await lista<{ id: string }>('so-omnisaude', { sistema: 'SINAN_NET', grupo: 'coqueluche' }));
    expect(await so()).not.toContain(n);
    // 2º envio do MESMO arquivo, hoje, declarando um período que passa de hoje (o caminho que a prévia indica).
    const declarado = { de: diaLocal(agora - 60 * DIA), ate: diaLocal(agora + 60 * DIA) };
    await enviarEAplicar(arquivo, 'NINDINET.DBF', declarado);
    expect(await so()).not.toContain(n);
    const cob = (await resumo()).cobertura.filter((c) => c.sistema === 'SINAN_NET' && c.grupos === null);
    expect(cob).toEqual([{ sistema: 'SINAN_NET', grupos: null, cnes: null, de: declarado.de, ate: d10 }]);

    // Base consolidada: o arquivo de 2025 enviado em 10/03/2025 e reenviado agora com o ano declarado cobre até a SE do
    // primeiro envio (antes do conserto, o ano inteiro ficava coberto, com zeros onde o arquivo não podia ter casos).
    const de2025 = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '7705002', ID_AGRAVO: 'A379', DT_NOTIFIC: '2025-02-10', NM_PACIENT: 'PESSOA DE 2025', CS_SEXO: 'M' })]);
    const antigo = await enviarEAplicar(de2025, 'NINDINET-2025.DBF');
    await db.officialImport.update({ where: { id: antigo.id }, data: { createdAt: new Date('2025-03-10T15:00:00Z') } });
    await enviarEAplicar(de2025, 'NINDINET-2025.DBF', { de: '2025-01-01', ate: '2025-12-31' });
    const base = await t.app.get(ConsolidadoService).carregar((await sistema()) as never, 'coqueluche', [2025], false);
    const marcas = base.semanasCobertas.get(2025)!;
    const ultimaCoberta = semanaDaData('2025-03-10').semana;
    expect(marcas.slice(0, ultimaCoberta).every(Boolean)).toBe(true);
    expect(marcas.slice(ultimaCoberta).some(Boolean)).toBe(false);
  });

  it('N5: o diálogo do registro acha a notificação do mesmo caso feita em outra unidade, fora do arquivo de um CNES só (caso A)', async () => {
    const naUbs = await notificarPorCid(await paciente('Fulana Verificacao Cnes Souza', '1975-05-05', 'F'), 'U07.1');
    const naUpa = await notificarPorCid(await paciente('Beltrana Verificacao Upa', '1976-06-06', 'F'), 'U07.1');
    await db.notification.update({ where: { id: naUpa }, data: { unitId: (await db.unit.findUniqueOrThrow({ where: { cnes: UPA } })).id } });
    const d = hoje();
    const cab = [
      'Número da Notificação',
      'Data da Notificação',
      'Data do início dos sintomas',
      'Estado de Residência',
      'Município de Residência',
      'Estado da Notificação',
      'Município da Notificação',
      'CNES Notificação',
      'Nome Completo',
      'Data de Nascimento',
      'Sexo',
      'Sintoma- Febre',
      'Evolução Caso',
      'Classificação Final',
    ];
    const linha = (numero: string, nome: string, nasc: string, sexo: string) =>
      [numero, br(d), br(d), 'São Paulo', '3550308', 'São Paulo', '3550308', UPA, nome, br(nasc), sexo, 'Sim', '', 'Confirmado Laboratorial'].join(';');
    const csv = new TextEncoder().encode(
      `${[cab.join(';'), linha('352611110001', 'Fulana Cnes Souza', '1975-05-05', 'Feminino'), linha('352611110002', 'Outra Pessoa Da Upa', '1990-01-01', 'Masculino')].join('\r\n')}\r\n`,
    );
    const imp = await enviarEAplicar(csv, 'esus-notifica-upa.csv', {}, 'text/csv');
    expect(((await db.officialImport.findUniqueOrThrow({ where: { id: imp.id }, select: { files: true } })).files as { cnes?: string }[]).map((f) => f.cnes)).toEqual([UPA]);
    // O "só no OmniSaúde" continua só com a UPA (o arquivo de um CNES só cobre só ela).
    expect(ids(await lista<{ id: string }>('so-omnisaude', { sistema: 'ESUS_NOTIFICA' }))).toEqual([naUpa]);
    const reg = (await lista<{ id: string; grupo: string }>('so-oficial', { busca: '352611110001' })).itens[0]!;
    // O diálogo do registro: no agravo do registro e em todos os agravos, pelo nome.
    expect(ids(await lista<Notificacao>('candidatas', { grupo: reg.grupo, busca: 'Fulana' }))).toEqual([naUbs]);
    expect(ids(await lista<Notificacao>('candidatas', { busca: 'Fulana' }))).toEqual([naUbs]);
    expect(ids(await lista<Notificacao>('candidatas', { grupo: reg.grupo, sistema: 'ESUS_NOTIFICA' }))).toEqual(expect.arrayContaining([naUbs, naUpa]));
    expect((await vincular(reg.id, naUbs)).status).toBe(200);
    // Vinculada, sai das candidatas.
    expect((await lista<Notificacao>('candidatas', { busca: 'Fulana' })).total).toBe(0);
  });

  it('N5: o diálogo do registro acha a notificação feita depois do envio (caso B), com o sigilo das listas e o grupo do mesmo agravo do Sinan', async () => {
    const agora = Date.now();
    const d6 = diaLocal(agora - 6 * DIA);
    const ano = d6.slice(0, 4);
    const dbf = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '7790501', ID_AGRAVO: 'A379', DT_NOTIFIC: d6, NM_PACIENT: 'CICRANO DO HOSPITAL', CS_SEXO: 'M' })]);
    const envio = await enviarEAplicar(dbf, 'NINDINET-B.DBF', { de: `${ano}-01-01`, ate: `${ano}-12-31` });
    // O envio foi há 5 dias (a exportação daquele dia); a notificação do OmniSaúde, de hoje.
    await db.officialImport.update({ where: { id: envio.id }, data: { createdAt: new Date(agora - 5 * DIA) } });
    const n = await notificar('Cicrano Verificacao Depois');
    expect((await lista<Notificacao>('so-omnisaude', { grupo: 'coqueluche', busca: 'Cicrano' })).total).toBe(0);
    expect(ids(await lista<Notificacao>('candidatas', { grupo: 'coqueluche', busca: 'Cicrano' }))).toEqual([n]);

    // Grupo do mesmo agravo do Sinan: o registro do Y09 (violência interpessoal) acha a notificação da violência sexual.
    const sexual = await notificarPorCid(await paciente('Saulo Sigilo Quarta', '1988-08-08'), 'T74.2');
    const s = await db.notification.findUniqueOrThrow({ where: { id: sexual }, select: { number: true, sensitive: true, groupKey: true } });
    expect(s).toMatchObject({ sensitive: true, groupKey: 'violencia-sexual-suicidio' });
    const comSigilo = await lista<Notificacao>('candidatas', { grupo: 'violencia', busca: 'Saulo' });
    expect(comSigilo.itens.map((i) => ({ id: i.id, nome: i.paciente?.nome, sigilosa: i.sigilosa }))).toEqual([{ id: sexual, nome: 'Saulo Sigilo Quarta', sigilosa: true }]);
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.conciliacao_ver_sensivel', entityId: sexual } })).toBeGreaterThanOrEqual(1);

    // Sem `notificacao.sensivel`: o nome não acha a sigilosa; o número acha, sem o paciente.
    const gestora = demoFixtures.STAFF.find((x) => x.key === 'gestora')!;
    const usuario = await db.user.findUniqueOrThrow({ where: { cpf: gestora.cpf }, select: { id: true } });
    expect(roleHasPermission('GESTOR', 'notificacao.sensivel')).toBe(false);
    const sys = await sistema();
    const ctx = {
      session: { tenantId: sys.tenant.id, tenantSlug: t.slug, userId: usuario.id, unitId: ubsId, role: 'GESTOR', mfa: false },
      tenant: sys.tenant,
      db: sys.db,
      ip: '127.0.0.1',
      cbo: '',
    } as unknown as RequestContext;
    const conciliacao = t.app.get(ConciliacaoService);
    expect((await conciliacao.candidatas(ctx, { busca: 'Saulo' })).total).toBe(0);
    const porNumero = await conciliacao.candidatas(ctx, { busca: s.number });
    expect(porNumero.itens.map((i) => ({ id: i.id, paciente: i.paciente, sigilosa: i.sigilosa }))).toEqual([{ id: sexual, paciente: null, sigilosa: true }]);
  });

  it('N6 manual: a notificação e o registro que já são duas linhas do mesmo surto aberto não se vinculam (409 CASO_DUPLICADO_NO_SURTO)', async () => {
    const n1 = await notificar('Caio Surto Manual Quarta');
    const r1 = await registro({ numero: '7701001', agravo: 'A379', grupo: 'coqueluche', nome: 'CAIO SURTO MANUAL QUARTA', nascimento: '1979-09-09' });
    const s = (
      await t
        .http()
        .post('/api/vigilancia/surtos')
        .set(auth('vig'))
        .send({
          casosIndicados: [{ notificationId: n1 }],
          categoria: 'DA_LISTA',
          grupo: 'coqueluche',
          notificadoEm: hoje(),
          conhecidoEm: new Date(Date.now() - 3_600_000).toISOString(),
          unitId: ubsId,
          primeirosSintomasEm: hoje(),
          casos: 1,
          localInicial: '8',
        })
        .expect(201)
    ).body as { id: string; numero: string };
    await t.http().post(`/api/vigilancia/surtos/${s.id}/casos`).set(auth('vig')).send({ officialRecordId: r1 }).expect(201);
    const recusa = await vincular(r1, n1);
    expect(recusa.status).toBe(409);
    expect(recusa.body).toMatchObject({
      code: 'CASO_DUPLICADO_NO_SURTO',
      message: `A notificação e o registro 7701001 são linhas do surto ${s.numero} (casos 1 e 2). Retire uma das linhas da planilha antes de vincular.`,
    });
    expect(await vinculo(r1)).toBeNull();
    // A sugestão do par avisa.
    const sug = await lista<{ registro: { id: string }; notificacao: { id: string }; motivo: string }>('sugestoes', { busca: 'Caio Surto Manual' });
    expect(sug.itens.find((i) => i.registro.id === r1 && i.notificacao.id === n1)?.motivo).toBe(`mesmo nome, nascimento e sexo; as duas linhas estão no surto ${s.numero}`);
    // Retirada a linha do registro, o vínculo passa.
    const detalhe = (await t.http().get(`/api/vigilancia/surtos/${s.id}`).set(auth('vig')).expect(200)).body as Detalhe;
    const linhaR = detalhe.planilha.find((c) => c.officialRecordId === r1)!;
    await t.http().delete(`/api/vigilancia/surtos/${s.id}/casos/${linhaR.id}`).set(auth('vig')).expect(200);
    expect((await vincular(r1, n1)).status).toBe(200);
    expect(await vinculo(r1)).toBe(n1);
  });

  it('N6 automático: a tarefa pula o par que já está duas vezes na planilha do surto aberto; ele fica nas sugestões, com o aviso', async () => {
    const n2 = await notificar('Davi Surto Automatico Quarta');
    const r2 = await registro({ numero: '7701002', agravo: 'A379', grupo: 'coqueluche', nome: 'OUTRO NOME DO REGISTRO' });
    const s = (
      await t
        .http()
        .post('/api/vigilancia/surtos')
        .set(auth('vig'))
        .send({
          casosIndicados: [{ notificationId: n2 }],
          categoria: 'DA_LISTA',
          grupo: 'coqueluche',
          notificadoEm: hoje(),
          conhecidoEm: new Date(Date.now() - 3_600_000).toISOString(),
          unitId: ubsId,
          primeirosSintomasEm: hoje(),
          casos: 1,
          localInicial: '8',
        })
        .expect(201)
    ).body as { id: string; numero: string };
    await t.http().post(`/api/vigilancia/surtos/${s.id}/casos`).set(auth('vig')).send({ officialRecordId: r2 }).expect(201);
    // A digitação informa depois o número do Sinan na notificação: o degrau 1 casaria os dois.
    await t.http().post(`/api/vigilancia/notificacoes/${n2}/numero-oficial`).set(auth('vig')).send({ numero: '7701002' }).expect(200);
    expect((await tarefa()).vinculadosAutomaticamente).toBe(0);
    expect(await vinculo(r2)).toBeNull();
    const sug = await lista<{ registro: { id: string }; notificacao: { id: string }; degrau: number; motivo: string }>('sugestoes', { busca: '7701002' });
    expect(sug.itens.map((i) => ({ r: i.registro.id, n: i.notificacao.id, degrau: i.degrau, motivo: i.motivo }))).toEqual([
      { r: r2, n: n2, degrau: 1, motivo: `mesmo número oficial; as duas linhas estão no surto ${s.numero}` },
    ]);
    // O surto descartado não segura mais o par: a tarefa liga.
    await t.http().post(`/api/vigilancia/surtos/${s.id}/descartar`).set(auth('vig')).send({ motivo: 'Não era surto: casos isolados.' }).expect(200);
    expect((await tarefa()).vinculadosAutomaticamente).toBe(1);
    expect(await vinculo(r2)).toBe(n2);
  });

  it('N7: o registro do Y09 ligado à violência sexual conta na série dela; a dengue ligada ao registro de chikungunya conta em chikungunya', async () => {
    const se = semanaEpidemiologica(new Date(), FUSO).codigo;
    const ano = Number(se.slice(0, 4));
    const i = Number(se.slice(4)) - 1;
    const sys = await sistema();
    const serie = async (grupo: string) => (await t.app.get(ConsolidadoService).casosPorSemana(sys as never, { grupo, nivel: 'MUNICIPIO', territorioId: null, anos: [ano], base: 'NOTIFICADOS' })).porAno.get(ano)![i] ?? 0;
    const series = async () => ({ sexual: await serie('violencia-sexual-suicidio'), interpessoal: await serie('violencia'), dengue: await serie('dengue'), chikungunya: await serie('chikungunya') });

    const sexual = await notificarPorCid(await paciente('Valter Verif Sexual Quarta', '1981-07-07'), 'T74.2');
    const y09 = await registro({ numero: '9400777', agravo: 'Y09', grupo: 'violencia', nome: 'VALTER VERIF SEXUAL QUARTA', sensivel: true });
    const dengue = await notificarPorCid(await paciente('Dario Dengue Quarta', '1990-03-03'), 'A90');
    const chik = await registro({ numero: '9400888', agravo: 'A920', grupo: 'chikungunya', sistema: 'SINAN_ONLINE', nome: 'DARIO DENGUE QUARTA' });
    const antes = await series();
    expect((await vincular(y09, sexual)).status).toBe(200);
    expect((await vincular(chik, dengue)).status).toBe(200);
    const depois = await series();
    // O caso fica na série da violência sexual (pelo registro) e sai da interpessoal; a dengue reclassificada conta em chikungunya.
    expect({ sexual: depois.sexual - antes.sexual, interpessoal: depois.interpessoal - antes.interpessoal, dengue: depois.dengue - antes.dengue, chikungunya: depois.chikungunya - antes.chikungunya }).toEqual({
      sexual: 0,
      interpessoal: -1,
      dengue: -1,
      chikungunya: 0,
    });
    expect(antes.sexual).toBeGreaterThanOrEqual(1);
  });

  it('contrato da SUBSTITUIDA: a importação substituída não cobre nada na conciliação nem na base consolidada', async () => {
    // O mesmo arquivo aplicado duas vezes: com o período lido (2024 inteiro), depois declarando o 1º semestre de 2023.
    // A primeira ficou SUBSTITUIDA e não cobre nada; a que vale cobre o semestre.
    const sha = 'd'.repeat(64);
    const arquivo = { tipo: 'NINDINET', periodo: { de: '2024-01-01', ate: '2024-12-31' } };
    const vale = await importacaoNoBanco({ nome: 'NINDINET-2023.DBF', sistema: 'SINAN_NET', arquivo, declarado: ['2023-01-01', '2023-06-30'], sha });
    await importacaoNoBanco({ nome: 'NINDINET-2023.DBF', sistema: 'SINAN_NET', status: 'SUBSTITUIDA', substituidaPor: vale, arquivo, enviadaEm: new Date('2025-01-15T12:00:00Z'), sha });
    const cob = (await resumo()).cobertura.filter((c) => c.de < '2025');
    expect(cob).toEqual([{ sistema: 'SINAN_NET', grupos: null, cnes: null, de: '2023-01-01', ate: '2023-06-30' }]);
    const base = await t.app.get(ConsolidadoService).carregar((await sistema()) as never, 'leptospirose', [2023, 2024], false);
    const ultima = semanaDaData('2023-06-30').semana;
    expect(base.semanasCobertas.get(2023)!.slice(0, ultima).every(Boolean)).toBe(true);
    expect(base.semanasCobertas.get(2023)!.slice(ultima).some(Boolean)).toBe(false);
    expect(base.semanasCobertas.get(2024)!.some(Boolean)).toBe(false);
    expect(base.cobertura).toEqual([expect.objectContaining({ ano: 2023, coberto: true, parcial: true }), expect.objectContaining({ ano: 2024, coberto: false })]);
  });

  it('N7, pelo caminho comum: a importação real do NINDINET liga o Y09 à tentativa de suicídio (CNS) e a série dela não perde o caso', async () => {
    // O registro é de ontem: o NINDINET de um dia só não dá como ausentes os registros de hoje dos outros testes.
    const ontem = diaLocal(Date.now() - DIA);
    const anos = [...new Set([Number(semanaDaData(ontem).codigo.slice(0, 4)), Number(semanaEpidemiologica(new Date(), FUSO).codigo.slice(0, 4))])];
    const sys = await sistema();
    const total = async (grupo: string) => {
      const r = await t.app.get(ConsolidadoService).casosPorSemana(sys as never, { grupo, nivel: 'MUNICIPIO', territorioId: null, anos, base: 'NOTIFICADOS' });
      return [...r.porAno.values()].flat().reduce<number>((a, v) => a + (v ?? 0), 0);
    };
    const cns = cnsFromBase('29100000999');
    const x70 = await notificarPorCid(await paciente('Wagner Verif Autoprovocada Quarta', '1982-08-08', 'M', cns), 'X70');
    const antes = { sexual: await total('violencia-sexual-suicidio'), interpessoal: await total('violencia') };
    const dbf = escreverDbf(CAMPOS_NINDINET, [
      nindinet({
        NU_NOTIFIC: '9400999',
        ID_AGRAVO: 'Y09',
        DT_NOTIFIC: ontem,
        DT_SIN_PRI: ontem,
        SEM_PRI: semanaDaData(ontem).codigo,
        NM_PACIENT: 'WAGNER VERIF AUTOPROVOCADA QUARTA',
        DT_NASC: '1982-08-08',
        CS_SEXO: 'M',
        ID_CNS_SUS: cns,
      }),
    ]);
    expect((await enviarEAplicar(dbf, 'NINDINET-Y09.DBF')).vinculados).toBe(1);
    const reg = await db.officialRecord.findFirstOrThrow({ where: { number: '9400999' }, select: { groupKey: true, notificationId: true, matchMethod: true } });
    expect(reg).toEqual({ groupKey: 'violencia', notificationId: x70, matchMethod: 'IDENTIDADE' });
    // O caso continua na série da tentativa de suicídio (agora pelo registro) e não entra na da violência interpessoal.
    expect({ sexual: await total('violencia-sexual-suicidio'), interpessoal: await total('violencia') }).toEqual(antes);
  });
});
