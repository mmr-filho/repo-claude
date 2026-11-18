import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Surto (VIG-1c), quinta rodada da semana 27, decisão R5-8 (r4vsur-1, revê a decisão 6): o mesmo caso em duas linhas da
 * planilha (a notificação numa e o registro oficial conciliado com ela na outra) não é revelado a quem não abre uma das
 * duas origens. Para ele, `mesmoCasoQue` fica nulo nas duas linhas e o aviso é genérico, sem os NU_CASO, no detalhe, na
 * lista e no espelho; o caso continua contando uma vez (`casosNaPlanilha` e a regra dos 10%). O aviso da inclusão e da
 * criação não diz "pelo outro lado" quando o outro lado é sigiloso e quem inclui não o abre, e a recusa do mesmo caso
 * (409) não dá o NU_CASO da linha que ele não abre.
 *
 * Quem lê: o núcleo do hospital (com `notificacao.sensivel`) abre a notificação e o registro sigilosos do hospital, mas
 * não os da UBS; a vigilância municipal abre todos.
 */
const enabled = await pgAvailable();
const H = 3_600_000;
const DIA = 24 * H;
const TZ = 'America/Sao_Paulo';
const hoje = () => localDateString(new Date(), TZ);
const diasAtras = (n: number) => localDateString(new Date(Date.now() - n * DIA), TZ);

const OCULTO_ABERTO = 'Há um caso em duas linhas da planilha (notificação e registro conciliados): quem abre as duas origens vê quais. Retire uma delas.';
const OCULTO_ENCERRADO = 'Há um caso em duas linhas da planilha (notificação e registro conciliados): quem abre as duas origens vê quais. Digite só uma delas no Sinan Net.';
const OCULTOS_ABERTO = (n: number) => `Há ${n} casos com duas linhas cada na planilha (notificação e registro conciliados): quem abre as duas origens vê quais. Retire uma das linhas de cada um.`;
const par = (a: number, b: number, aberto = true) => `Os casos ${a} e ${b} são o mesmo caso (notificação e registro conciliados): ${aberto ? 'retire uma das linhas' : 'digite só uma das linhas no Sinan Net'}.`;

type Caso = { id: string; numero: number; notificationId: string | null; officialRecordId: string | null; mesmoCasoQue: number | null; restrito: boolean; iniciais: string | null };
type Espelho = { planilha: Record<string, string | null>[]; avisos: string[] };
type Detalhe = { id: string; numero: string; status: string; casosNaPlanilha: number; avisos: string[]; planilha: Caso[]; espelho: Espelho };

describe.runIf(enabled)('Vigilância: surto, quinta rodada (semana 27)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  const tk: Record<string, string> = {};
  const U: Record<string, { id: string; cnes: string }> = {};
  const usuario: Record<string, string> = {};
  let seq = 0;
  let nReg = 0;
  let importacao = '';
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const detalhe = async (id: string, k = 'vig') => (await t.http().get(`/api/vigilancia/surtos/${id}`).set(auth(k)).expect(200)).body as Detalhe;
  const espelho = async (id: string, k = 'vig') => (await t.http().get(`/api/vigilancia/surtos/${id}/espelho`).set(auth(k)).expect(200)).body as Espelho;
  const daLista = async (id: string, k = 'vig') => ((await t.http().get('/api/vigilancia/surtos').set(auth(k)).expect(200)).body as Detalhe[]).find((s) => s.id === id)!;
  const numero = async (id: string) => (await db.notification.findUniqueOrThrow({ where: { id }, select: { number: true } })).number;
  const novoPaciente = async (nome: string) => {
    seq++;
    const body = {
      name: nome,
      birthDate: `${1960 + (seq % 40)}-0${1 + (seq % 9)}-1${seq % 8}`,
      sex: seq % 2 ? 'M' : 'F',
      cpf: completeCpf(String(274500700 + seq)),
      cns: cnsFromBase(String(27450000700 + seq)),
      motherName: `Mae de ${nome}`,
      phone: '(11) 97777-2705',
      address: { cep: '01001000', street: 'Rua da Quinta Rodada', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
      confirmNotDuplicate: true,
    };
    return (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
  };
  /**
   * Notificação de sífilis (agravo sigiloso) de quem a registra, na unidade da sessão dele. A ficha da sífilis pede outros
   * campos: a notificação nasce de leptospirose e troca de condição pelo banco, como nos testes da quarta rodada.
   */
  const sifilis = async (k: string, nome: string) => {
    const id = (
      (
        await t
          .http()
          .post('/api/vigilancia/notificacoes')
          .set(auth(k))
          .send({ patientId: await novoPaciente(nome), conditionKey: 'leptospirose', knownAt: new Date(Date.now() - 2 * DIA).toISOString(), symptomsOnset: diasAtras(3) })
          .expect(201)
      ).body as { id: string }
    ).id;
    const c = await db.notifiableCondition.findFirstOrThrow({ where: { key: 'sifilis' }, select: { id: true, key: true, groupKey: true, sensitive: true } });
    expect([c.groupKey, c.sensitive]).toEqual(['sifilis', true]);
    await db.notification.update({ where: { id }, data: { status: 'NOTIFICADA', conditionId: c.id, conditionKey: c.key, groupKey: c.groupKey, sensitive: c.sensitive } });
    return id;
  };
  /** Registro de sífilis do Sinan (sigiloso) da unidade, como a importação aplicada o deixaria, conciliado ou não. */
  const registro = async (o: { nome: string; unidade: 'ubs' | 'hosp'; notificationId?: string }) => {
    nReg++;
    return db.officialRecord.create({
      data: {
        system: 'SINAN_NET',
        type: 'INDIVIDUAL',
        naturalKey: `r5sur-${nReg}`,
        number: String(8_550_000 + nReg),
        notifiedOn: new Date(`${diasAtras(2)}T00:00:00Z`),
        municipalityIbge: '355030',
        unitCnes: U[o.unidade]!.cnes,
        unitId: U[o.unidade]!.id,
        agravo: 'A539',
        groupKey: 'sifilis',
        residenceIbge: '355030',
        situation: 'CONFIRMADO',
        patientName: o.nome,
        sex: 'F',
        sensitive: true,
        contentHash: '0'.repeat(64),
        firstImportId: importacao,
        lastImportId: importacao,
        lastSeenAt: new Date(),
        ...(o.notificationId ? { notificationId: o.notificationId, matchMethod: 'MANUAL' as const, matchedBy: usuario.vigilancia!, matchedAt: new Date() } : {}),
      },
    });
  };
  /** O vínculo feito depois de as duas linhas estarem na planilha (dado de antes, corrida ou surto encerrado). */
  const vincularNoBanco = (recordId: string, notificationId: string) =>
    db.officialRecord.update({ where: { id: recordId }, data: { notificationId, matchMethod: 'MANUAL', matchedBy: usuario.vigilancia!, matchedAt: new Date() } });
  const base = () => ({ notificadoEm: hoje(), conhecidoEm: new Date(Date.now() - H).toISOString(), primeirosSintomasEm: diasAtras(4), casos: 2, localInicial: '8' });
  /** Surto de sífilis montado pela vigilância municipal (na unidade pedida). */
  const criarSurto = async (unidade: 'ubs' | 'hosp', corpo: Record<string, unknown> = {}) =>
    (
      await t
        .http()
        .post('/api/vigilancia/surtos')
        .set(auth('vig'))
        .send({ ...base(), categoria: 'DA_LISTA', grupo: 'sifilis', unitId: U[unidade]!.id, ...corpo })
        .expect(201)
    ).body as Detalhe;
  const incluir = (k: string, id: string, corpo: Record<string, unknown>) => t.http().post(`/api/vigilancia/surtos/${id}/casos`).set(auth(k)).send(corpo);
  /** O que a resposta diz do par: as marcas das linhas e os avisos que falam do mesmo caso (detalhe e espelho). */
  const doPar = (d: { planilha: Caso[]; avisos: string[]; espelho?: Espelho }) => ({
    marcas: d.planilha.map((c) => c.mesmoCasoQue ?? null),
    avisos: d.avisos.filter((a) => a.includes('mesmo caso') || a.includes('duas linhas')),
    ...(d.espelho ? { espelho: d.espelho.avisos.filter((a) => a.includes('mesmo caso') || a.includes('duas linhas')) } : {}),
  });

  beforeAll(async () => {
    t = await startTestApp('vigsurtor5');
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.medicaHosp = await t.login('medica', 'Hospital Municipal São Lucas', 'MEDICO');
    tk.nucleo = await t.login('nucleo', 'Hospital Municipal São Lucas', 'NUCLEO_VIGILANCIA');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    for (const u of demoFixtures.UNITS) U[u.key] = { id: (await db.unit.findUniqueOrThrow({ where: { cnes: u.cnes } })).id, cnes: u.cnes };
    for (const s of demoFixtures.STAFF) usuario[s.key] = (await db.user.findUniqueOrThrow({ where: { cpf: s.cpf } })).id;
    for (const tabela of ['outbreak_cases', 'outbreak_events', 'outbreak_dismissals', 'outbreaks']) await db.$executeRawUnsafe(`DELETE FROM ${tabela}`);
    importacao = (await db.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'r5sur.zip', sha256: 'c'.repeat(64), sizeBytes: 1, createdBy: usuario.vigilancia! } })).id;
  }, 180_000);

  afterAll(async () => {
    await t?.close();
  });

  it('R5-8: com uma das linhas do par sob sigilo para quem lê, o par não é revelado no detalhe, no espelho e na lista, e o caso conta uma vez', async () => {
    // O cenário da verificação (zz-verif-r4vsur-surto): a notificação de sífilis é da UBS Centro; o registro do Sinan da
    // mesma pessoa é do hospital. A vigilância municipal monta a planilha do surto do hospital com as duas linhas, e o
    // vínculo vem depois.
    const n = await sifilis('medica', 'Sabrina Sigilo Quinta');
    const r = await registro({ nome: 'SABRINA SIGILO QUINTA', unidade: 'hosp' });
    const s = await criarSurto('hosp', { casos: 30, casosIndicados: [{ notificationId: n }, { officialRecordId: r.id }] });
    await vincularNoBanco(r.id, n);
    // O núcleo do hospital não abre a notificação sigilosa da UBS: a linha dela vem mascarada; a do registro, não.
    await t.http().get(`/api/vigilancia/notificacoes/${n}`).set(auth('nucleo')).expect(403);
    const nuc = await detalhe(s.id, 'nucleo');
    expect(nuc.planilha.map((c) => [c.numero, c.restrito, c.iniciais])).toEqual([
      [1, true, null],
      [2, false, 'SSQ'],
    ]);
    // Antes (decisão 6): marcas [2, 1] e "Os casos 1 e 2 são o mesmo caso..." no detalhe, no espelho e na lista, ligando
    // a linha mascarada à pessoa SSQ da linha 2.
    expect(doPar(nuc)).toEqual({ marcas: [null, null], avisos: [OCULTO_ABERTO], espelho: [OCULTO_ABERTO] });
    expect(doPar({ planilha: nuc.planilha, avisos: (await espelho(s.id, 'nucleo')).avisos })).toEqual({ marcas: [null, null], avisos: [OCULTO_ABERTO] });
    const naLista = await daLista(s.id, 'nucleo');
    expect(naLista.avisos.filter((a) => a.includes('mesmo caso') || a.includes('duas linhas'))).toEqual([OCULTO_ABERTO]);
    // O caso continua contando uma vez: na planilha, na lista e na regra dos 10%.
    expect([nuc.casosNaPlanilha, naLista.casosNaPlanilha, nuc.avisos.find((a) => a.includes('10%'))?.match(/\(\d+ de \d+\)/)?.[0]]).toEqual([1, 1, '(1 de 30)']);
    // A vigilância municipal abre as duas origens: para ela, o par com os NU_CASO, como antes.
    const vig = await detalhe(s.id, 'vig');
    expect(doPar(vig)).toEqual({ marcas: [2, 1], avisos: [par(1, 2)], espelho: [par(1, 2)] });
    expect((await daLista(s.id, 'vig')).avisos.filter((a) => a.includes('mesmo caso'))).toEqual([par(1, 2)]);
    // Surto encerrado: o aviso genérico pede a digitação de uma linha só no Sinan Net.
    await t
      .http()
      .patch(`/api/vigilancia/surtos/${s.id}`)
      .set(auth('vig'))
      .send({ investigacao: { investigadoEm: hoje() } })
      .expect(200);
    await t.http().post(`/api/vigilancia/surtos/${s.id}/encerrar`).set(auth('vig')).send({ delimitacao: '8', data: hoje() }).expect(200);
    const encerrado = await detalhe(s.id, 'nucleo');
    expect([encerrado.status, doPar(encerrado)]).toEqual(['ENCERRADO', { marcas: [null, null], avisos: [OCULTO_ENCERRADO], espelho: [OCULTO_ENCERRADO] }]);
    expect(doPar(await detalhe(s.id, 'vig'))).toEqual({ marcas: [2, 1], avisos: [par(1, 2, false)], espelho: [par(1, 2, false)] });
  });

  it('R5-8: dois pares ocultos e um visível para quem lê: um aviso genérico com a contagem, e o visível com os NU_CASO', async () => {
    // Linhas 1 a 4: dois pares em que a notificação é da UBS (o núcleo não a abre). Linhas 5 e 6: notificação e registro
    // do hospital (o núcleo abre os dois). Linha 7: manual.
    const n1 = await sifilis('medica', 'Ana Par Oculto Quinta');
    const r1 = await registro({ nome: 'ANA PAR OCULTO QUINTA', unidade: 'hosp' });
    const n2 = await sifilis('medica', 'Bia Par Oculto Quinta');
    const r2 = await registro({ nome: 'BIA PAR OCULTO QUINTA', unidade: 'hosp' });
    const n3 = await sifilis('medicaHosp', 'Cida Par Visivel Quinta');
    const r3 = await registro({ nome: 'CIDA PAR VISIVEL QUINTA', unidade: 'hosp' });
    const indicados = [{ notificationId: n1 }, { officialRecordId: r1.id }, { notificationId: n2 }, { officialRecordId: r2.id }, { notificationId: n3 }, { officialRecordId: r3.id }];
    const s = await criarSurto('hosp', { casos: 40, casosIndicados: indicados });
    await incluir('vig', s.id, { linha: { iniciais: 'MNL' } }).expect(201);
    for (const [rec, not] of [
      [r1.id, n1],
      [r2.id, n2],
      [r3.id, n3],
    ] as const)
      await vincularNoBanco(rec, not);
    const nuc = await detalhe(s.id, 'nucleo');
    expect(nuc.planilha.map((c) => c.restrito)).toEqual([true, false, true, false, false, false, false]);
    expect(doPar(nuc)).toEqual({ marcas: [null, null, null, null, 6, 5, null], avisos: [par(5, 6), OCULTOS_ABERTO(2)], espelho: [par(5, 6), OCULTOS_ABERTO(2)] });
    expect([nuc.casosNaPlanilha, nuc.avisos.find((a) => a.includes('10%'))?.match(/\(\d+ de \d+\)/)?.[0]]).toEqual([4, '(3 de 40)']);
    const vig = await detalhe(s.id, 'vig');
    expect(doPar(vig)).toEqual({ marcas: [2, 1, 4, 3, 6, 5, null], avisos: [par(1, 2), par(3, 4), par(5, 6)], espelho: [par(1, 2), par(3, 4), par(5, 6)] });
    expect(vig.casosNaPlanilha).toBe(4);
  });

  it('R5-8: o aviso da inclusão não diz "pelo outro lado" quando o outro lado é sigiloso e quem inclui não o abre, nos dois sentidos', async () => {
    // (a) O registro do hospital, conciliado com a notificação da UBS (que o núcleo não abre) que está num surto aberto.
    const nu = await sifilis('medica', 'Dora Inclusao Quinta');
    const rh = await registro({ nome: 'DORA INCLUSAO QUINTA', unidade: 'hosp', notificationId: nu });
    const daUbs = await criarSurto('ubs', { casosIndicados: [{ notificationId: nu }] });
    const s1 = await criarSurto('hosp');
    // Antes: '..., pela notificação conciliada com ele.'
    expect((await incluir('nucleo', s1.id, { officialRecordId: rh.id }).expect(201)).body.avisos).toEqual([`O registro ${rh.number} também está no surto ${daUbs.numero}.`]);
    // A vigilância municipal abre a notificação: o aviso diz por onde (e o registro, agora, também está no s1).
    const s2 = await criarSurto('hosp');
    expect((await incluir('vig', s2.id, { officialRecordId: rh.id }).expect(201)).body.avisos).toEqual([
      `O registro ${rh.number} também está no surto ${s1.numero}.`,
      `O registro ${rh.number} também está no surto ${daUbs.numero}, pela notificação conciliada com ele.`,
    ]);
    // Na criação ("Notificar surto" pelo núcleo, com o registro indicado), o mesmo: o surto da notificação entra no aviso
    // como os do próprio registro, em ordem, sem dizer por onde.
    const criado = (
      await t
        .http()
        .post('/api/vigilancia/surtos')
        .set(auth('nucleo'))
        .send({ ...base(), categoria: 'DA_LISTA', grupo: 'sifilis', unitId: U.hosp!.id, casosIndicados: [{ officialRecordId: rh.id }] })
        .expect(201)
    ).body as Detalhe;
    expect(criado.avisos.filter((a) => a.includes('também está no surto'))).toEqual([
      `O registro ${rh.number} também está no surto ${daUbs.numero}.`,
      `O registro ${rh.number} também está no surto ${s1.numero}.`,
      `O registro ${rh.number} também está no surto ${s2.numero}.`,
    ]);
    // (b) A notificação do hospital, conciliada com o registro da UBS (que o núcleo não abre) que está num surto aberto.
    const nh = await sifilis('medicaHosp', 'Edna Inclusao Quinta');
    const ru = await registro({ nome: 'EDNA INCLUSAO QUINTA', unidade: 'ubs', notificationId: nh });
    const daUbs2 = await criarSurto('ubs', { casosIndicados: [{ officialRecordId: ru.id }] });
    const s3 = await criarSurto('hosp');
    expect((await incluir('nucleo', s3.id, { notificationId: nh }).expect(201)).body.avisos).toEqual([`A notificação ${await numero(nh)} também está no surto ${daUbs2.numero}.`]);
    const s4 = await criarSurto('hosp');
    expect((await incluir('vig', s4.id, { notificationId: nh }).expect(201)).body.avisos).toEqual([
      `A notificação ${await numero(nh)} também está no surto ${s3.numero}.`,
      `A notificação ${await numero(nh)} também está no surto ${daUbs2.numero}, pelo registro oficial conciliado com ela.`,
    ]);
  });

  it('R5-8: a recusa do mesmo caso (409) não dá o NU_CASO da linha que quem inclui não abre', async () => {
    // A notificação da UBS está na planilha do surto do hospital (caso 1, mascarada para o núcleo); o registro do
    // hospital conciliado com ela é o mesmo caso.
    const nu = await sifilis('medica', 'Fabia Recusa Quinta');
    const rh = await registro({ nome: 'FABIA RECUSA QUINTA', unidade: 'hosp', notificationId: nu });
    const s = await criarSurto('hosp', { casosIndicados: [{ notificationId: nu }] });
    const nuc = await incluir('nucleo', s.id, { officialRecordId: rh.id });
    // Antes: '... que já está na planilha deste surto (caso 1)'.
    expect([nuc.status, nuc.body.message]).toEqual([409, `O registro ${rh.number} é o mesmo caso da notificação conciliada com ele, que já está na planilha deste surto`]);
    const vig = await incluir('vig', s.id, { officialRecordId: rh.id });
    expect([vig.status, vig.body.message]).toEqual([409, `O registro ${rh.number} é o mesmo caso da notificação conciliada com ele, que já está na planilha deste surto (caso 1)`]);
    // O outro sentido: o registro da UBS na planilha, e a notificação do hospital conciliada com ele.
    const nh = await sifilis('medicaHosp', 'Gema Recusa Quinta');
    const ru = await registro({ nome: 'GEMA RECUSA QUINTA', unidade: 'ubs', notificationId: nh });
    const s2 = await criarSurto('hosp', { casosIndicados: [{ officialRecordId: ru.id }] });
    const nuc2 = await incluir('nucleo', s2.id, { notificationId: nh });
    expect([nuc2.status, nuc2.body.message]).toEqual([409, `A notificação ${await numero(nh)} é o mesmo caso do registro oficial conciliado com ela, que já está na planilha deste surto`]);
    const vig2 = await incluir('vig', s2.id, { notificationId: nh });
    expect([vig2.status, vig2.body.message]).toEqual([409, `A notificação ${await numero(nh)} é o mesmo caso do registro oficial conciliado com ela, que já está na planilha deste surto (caso 1)`]);
  });
});
