import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString, semanaDaData, semanaEpidemiologica } from '@omnisaude/shared';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { ImportacaoService } from '../src/modules/vigilancia/importacao.service';
import { CAMPOS_NINDINET, escreverDbf } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * Trava da conciliação e o pool do município, quarta rodada da semana 27 (VIG-1c, N4). Com uma importação aplicando
 * (ela segura as travas da importação e da conciliação), vincular, desvincular e rejeitar tentam a trava em
 * transações curtas e esperam fora delas: nenhuma conexão fica 'idle in transaction' esperando a trava, e as outras
 * telas do município não esperam conexão. Pool como em produção (wrangler.jsonc: DB_POOL_SIZE=5). Dados sintéticos.
 */
const enabled = await pgAvailable();
const TZ = 'America/Sao_Paulo';
const MUN = '355030';
const UBS = '9000011';
const MENSAGEM = 'A conciliação está sendo atualizada agora (importação ou vínculo automático). Tente de novo em instantes.';

type Resposta = { status: number; ms: number; body: { code?: string; message?: string } };

describe.runIf(enabled)('Vigilância: ações da conciliação com a importação aplicando e o pool de 5 conexões (N4)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let importacaoId = '';
  let seq = 0;
  const tk: Record<string, string> = {};
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const hoje = () => localDateString(new Date(), TZ);
  const medir = async (p: PromiseLike<{ status: number; body: unknown }>): Promise<Resposta> => {
    const inicio = Date.now();
    const r = await p;
    return { status: r.status, ms: Date.now() - inicio, body: r.body as Resposta['body'] };
  };
  const pacienteNovo = (nome: string) => {
    seq++;
    return {
      name: `${nome} ${String.fromCharCode(64 + (seq % 26) + 1)}${seq}`,
      birthDate: '1982-04-15',
      confirmNotDuplicate: true,
      sex: 'M',
      cpf: completeCpf(String(292000100 + seq)),
      cns: cnsFromBase(String(29200000100 + seq)),
      motherName: 'Mae Pool Quarta',
      phone: '(11) 97777-2792',
      address: { cep: '01001000', street: 'Rua do Pool', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
    };
  };
  const notificacao = async () => {
    const p = (await t.http().post('/api/patients').set(auth('recepcao')).send(pacienteNovo('Paciente Pool Quarta')).expect(201)).body.id as string;
    const n = (await t.http().post('/api/vigilancia/notificacoes').set(auth('medica')).send({ patientId: p, conditionKey: 'coqueluche' }).expect(201)).body as { id: string };
    expect((await t.http().post(`/api/vigilancia/notificacoes/${n.id}/confirmar`).set(auth('medica')).expect(200)).body.status).toBe('NOTIFICADA');
    return n.id;
  };
  const registro = async (numero: string) =>
    (
      await db.officialRecord.create({
        data: {
          system: 'SINAN_NET',
          type: 'INDIVIDUAL',
          naturalKey: `${numero}|${hoje()}|${MUN}|A379`,
          number: numero,
          notifiedOn: new Date(`${hoje()}T00:00:00Z`),
          epiWeekNotified: semanaEpidemiologica(new Date(), TZ).codigo,
          municipalityIbge: MUN,
          unitCnes: UBS,
          agravo: 'A379',
          groupKey: 'coqueluche',
          situation: 'EM_INVESTIGACAO',
          contentHash: 'b'.repeat(64),
          firstImportId: importacaoId,
          lastImportId: importacaoId,
          lastSeenAt: new Date(),
        },
      })
    ).id;
  const acao = (caminho: string, corpo: object) => medir(t.http().post(`/api/vigilancia/conciliacao/${caminho}`).set(auth('vig')).send(corpo));

  beforeAll(async () => {
    t = await startTestApp('vigconcpool', { DB_POOL_SIZE: '5' });
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    const vera = (await db.user.findUniqueOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf } })).id;
    importacaoId = (await db.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'pool.dbf', sha256: 'd'.repeat(64), sizeBytes: 1, createdBy: vera, appliedAt: new Date() } })).id;
  });

  afterEach(() => {
    ImportacaoService.ganchoDeTeste = null;
  });

  afterAll(async () => {
    await t?.close();
  });

  it('importação aplicando + 4 ações ao mesmo tempo: as ações tentam em transações curtas, respondem 409 em ~3 s e as outras rotas não esperam', async () => {
    // Os pares: dois "não é o mesmo caso", um vínculo com o número oficial preenchido (a sonda e a gravação) e um desvínculo.
    const pares = [];
    for (let i = 0; i < 4; i++) pares.push({ r: await registro(String(7792100 + i)), n: await notificacao() });
    expect((await acao('vincular', { recordId: pares[3]!.r, notificationId: pares[3]!.n })).status).toBe(200);

    // Importação real, segura logo depois de pegar as duas travas (gancho INICIO): uma conexão do pool presa nela.
    const d = hoje();
    const dbf = escreverDbf(CAMPOS_NINDINET, [
      { TP_NOT: '2', ID_AGRAVO: 'A379', DT_NOTIFIC: d, SEM_NOT: semanaDaData(d).codigo, NU_ANO: d.slice(0, 4), SG_UF_NOT: '35', ID_MUNICIP: MUN, ID_UNIDADE: UBS, SG_UF: '35', ID_MN_RESI: MUN, NU_NOTIFIC: '7792901', NM_PACIENT: 'PESSOA DO POOL', CS_SEXO: 'F' },
    ]);
    const envio = (await t.http().post('/api/vigilancia/importacoes').query({ nome: 'NINDINET-POOL.DBF' }).set(auth('vig')).set('Content-Type', 'application/octet-stream').send(Buffer.from(dbf)).expect(201)).body as { id: string };
    let chegou!: () => void;
    let soltar!: () => void;
    const naTrava = new Promise<void>((r) => (chegou = r));
    const solta = new Promise<void>((r) => (soltar = r));
    ImportacaoService.ganchoDeTeste = async (etapa, _id, momento) => {
      if (etapa === 'APLICANDO' && momento === 'INICIO') {
        chegou();
        await solta;
      }
    };
    const aplicar = t
      .http()
      .post(`/api/vigilancia/importacoes/${envio.id}/aplicar`)
      .set(auth('vig'))
      .then((r) => r);
    await naTrava;

    // Monitor fora do pool do app: as conexões do app em transação, menos a da importação (a dona das travas).
    const url = new URL(TEST_PG);
    url.pathname = `/tenant_db_${t.slug.replace(/-/g, '_')}`;
    const mon = new Client({ connectionString: url.toString() });
    await mon.connect();
    const dona = (await mon.query(`SELECT DISTINCT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows.map((x) => Number(x.pid));
    expect(dona).toHaveLength(1);
    let maiorIdade = 0;
    let esperandoNaTransacao = 0;
    let amostras = 0;
    let monitorando = true;
    const monitor = (async () => {
      while (monitorando) {
        const r = await mon.query(
          `SELECT state, extract(epoch FROM clock_timestamp() - xact_start) * 1000 AS idade FROM pg_stat_activity
           WHERE datname = current_database() AND usename = 'omni_app' AND xact_start IS NOT NULL AND pid <> ALL($1::int[])`,
          [dona],
        );
        amostras++;
        for (const x of r.rows) {
          maiorIdade = Math.max(maiorIdade, Number(x.idade));
          if (x.state === 'idle in transaction' && Number(x.idade) > 500) esperandoNaTransacao++;
        }
        await new Promise((res) => setTimeout(res, 25));
      }
    })();

    const inicio = Date.now();
    const acoes = [
      acao('rejeitar', { recordId: pares[0]!.r, notificationId: pares[0]!.n, motivo: 'Pessoas diferentes no teste do pool.' }),
      acao('rejeitar', { recordId: pares[1]!.r, notificationId: pares[1]!.n, motivo: 'Pessoas diferentes no teste do pool.' }),
      acao('vincular', { recordId: pares[2]!.r, notificationId: pares[2]!.n, preencherNumeroOficial: true }),
      acao('desvincular', { recordId: pares[3]!.r, motivo: 'Vinculado por engano no teste do pool.' }),
    ];
    // No meio da espera, outras telas do mesmo município: uma consulta pelo pool, uma transação com o padrão do Prisma
    // (espera de 2 s por uma conexão), uma lista e um cadastro na recepção.
    await new Promise((r) => setTimeout(r, 600));
    const select1 = medir(db.$queryRaw`SELECT 1`.then(() => ({ status: 200, body: {} })));
    const transacao = medir(
      db
        .$transaction(async (tx) => tx.$queryRaw`SELECT 1`)
        .then(() => ({ status: 200, body: {} }))
        .catch((e: Error) => ({ status: 500, body: { message: e.message } })),
    );
    const leitura = medir(t.http().get('/api/vigilancia/conciliacao/so-oficial').set(auth('vig')));
    const cadastro = medir(t.http().post('/api/patients').set(auth('recepcao')).send(pacienteNovo('Paciente Outra Tela')));
    const [respostas, rSelect, rTransacao, rLeitura, rCadastro] = await Promise.all([Promise.all(acoes), select1, transacao, leitura, cadastro]);
    const tempo = Date.now() - inicio;
    monitorando = false;
    await monitor;
    await mon.end();
    soltar();
    const aplicada = await aplicar;
    console.log(
      `N4: ações ${JSON.stringify(respostas.map((r) => [r.status, r.ms]))}; SELECT 1 ${rSelect.ms} ms; transação ${rTransacao.ms} ms; so-oficial ${rLeitura.ms} ms; cadastro ${rCadastro.ms} ms; ` +
        `maior transação de outra conexão ${maiorIdade.toFixed(0)} ms em ${amostras} amostras`,
    );

    for (const r of respostas) expect(r).toMatchObject({ status: 409, body: { code: 'CONCILIACAO_OCUPADA', message: MENSAGEM } });
    expect(tempo).toBeGreaterThanOrEqual(2_500);
    expect(tempo).toBeLessThan(10_000);
    // Nenhuma conexão esperando a trava com a transação aberta (antes: as 4, por 3 s cada).
    expect(amostras).toBeGreaterThan(20);
    expect(esperandoNaTransacao).toBe(0);
    expect(maiorIdade).toBeLessThan(1_000);
    // As outras telas não esperam conexão (antes: 2,6 s, e a transação com o padrão do Prisma caía em 2 s).
    expect(rSelect.ms).toBeLessThan(1_000);
    expect(rTransacao).toMatchObject({ status: 200 });
    expect(rTransacao.ms).toBeLessThan(1_000);
    expect(rLeitura).toMatchObject({ status: 200 });
    expect(rLeitura.ms).toBeLessThan(1_500);
    expect(rCadastro).toMatchObject({ status: 201 });
    expect(rCadastro.ms).toBeLessThan(2_000);

    // Nada mudou, e a importação terminou.
    expect([200, 202]).toContain(aplicada.status);
    expect(await db.officialRecordRejection.count({ where: { recordId: { in: [pares[0]!.r, pares[1]!.r] } } })).toBe(0);
    expect((await db.officialRecord.findUniqueOrThrow({ where: { id: pares[2]!.r } })).notificationId).toBeNull();
    expect(await db.notification.findUniqueOrThrow({ where: { id: pares[2]!.n }, select: { officialNumber: true } })).toEqual({ officialNumber: null });
    expect((await db.officialRecord.findUniqueOrThrow({ where: { id: pares[3]!.r } })).notificationId).toBe(pares[3]!.n);
    let imp = await db.officialImport.findUniqueOrThrow({ where: { id: envio.id }, select: { status: true } });
    for (let i = 0; i < 100 && imp.status !== 'APLICADA'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      imp = await db.officialImport.findUniqueOrThrow({ where: { id: envio.id }, select: { status: true } });
    }
    expect(imp.status).toBe('APLICADA');

    // Sem a importação, as quatro passam.
    expect((await acao('rejeitar', { recordId: pares[0]!.r, notificationId: pares[0]!.n, motivo: 'Pessoas diferentes no teste do pool.' })).status).toBe(200);
    expect((await acao('vincular', { recordId: pares[2]!.r, notificationId: pares[2]!.n, preencherNumeroOficial: true })).status).toBe(200);
    expect((await acao('desvincular', { recordId: pares[3]!.r, motivo: 'Vinculado por engano no teste do pool.' })).status).toBe(200);
  });
});
