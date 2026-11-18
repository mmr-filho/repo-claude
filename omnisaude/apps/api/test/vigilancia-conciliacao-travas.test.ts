import { Logger } from '@nestjs/common';
import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString, semanaDaData, semanaEpidemiologica } from '@omnisaude/shared';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { ConciliacaoService } from '../src/modules/vigilancia/conciliacao.service';
import { ImportacaoService } from '../src/modules/vigilancia/importacao.service';
import { NotificacaoService } from '../src/modules/vigilancia/notificacao.service';
import { CAMPOS_NINDINET, escreverDbf, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * Travas da conciliação, terceira rodada da semana 27 (VIG-1c). K5: a tarefa periódica tenta as duas travas sem
 * esperar, na ordem da importação (importação, depois conciliação), e devolve 0 com qualquer uma ocupada; vincular,
 * desvincular e rejeitar esperam a trava da conciliação por poucos segundos e respondem 409 CONCILIACAO_OCUPADA. Com
 * uma importação real segurada depois de gravar os registros, nenhum 40P01: ela termina APLICADA. conciliacao-4: o
 * "não é o mesmo caso" no meio do vínculo automático não deixa o par vinculado com a rejeição gravada. Dados
 * sintéticos.
 */
const enabled = await pgAvailable();
const TZ = 'America/Sao_Paulo';
const MUN = '355030';
const UBS = '9000011';

type Resposta = { status: number; body: { code?: string; message?: string } };

describe.runIf(enabled)('Vigilância: travas da conciliação com a tarefa, a importação e as ações da tela (terceira rodada)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let tenants: TenantsService;
  let importacaoId = '';
  let seq = 0;
  const tk: Record<string, string> = {};
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const hoje = () => localDateString(new Date(), TZ);
  const tarefa = async () => {
    tenants.connections.invalidate(t.slug);
    const tenant = await tenants.resolve(t.slug);
    return t.app.get(NotificacaoService).tarefa({ tenant, db: await tenants.client(tenant.id) });
  };
  const espera = (ms: number) => new Promise<'sem resposta'>((r) => setTimeout(() => r('sem resposta'), ms));

  /** Notificação de coqueluche confirmada; com `numero`, a vigilância informa o número do Sinan Net depois. */
  const notificacao = async (numero?: string) => {
    seq++;
    const body = {
      name: `Paciente Trava Conciliacao ${String.fromCharCode(64 + seq)}`,
      birthDate: '1981-03-14',
      confirmNotDuplicate: true,
      sex: 'M',
      cpf: completeCpf(String(277000900 + seq)),
      cns: cnsFromBase(String(27700000900 + seq)),
      motherName: 'Mae Trava Conciliacao',
      phone: '(11) 97777-2705',
      address: { cep: '01001000', street: 'Rua da Trava', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
    };
    const p = (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
    const n = (await t.http().post('/api/vigilancia/notificacoes').set(auth('medica')).send({ patientId: p, conditionKey: 'coqueluche' }).expect(201)).body as { id: string };
    expect((await t.http().post(`/api/vigilancia/notificacoes/${n.id}/confirmar`).set(auth('medica')).expect(200)).body.status).toBe('NOTIFICADA');
    if (numero) await t.http().post(`/api/vigilancia/notificacoes/${n.id}/numero-oficial`).set(auth('vig')).send({ numero }).expect(200);
    return n.id;
  };
  /** Registro de coqueluche do Sinan Net, de hoje, sem vínculo (o que uma importação anterior gravou). */
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
  const vinculo = async (recordId: string) => (await db.officialRecord.findUniqueOrThrow({ where: { id: recordId }, select: { notificationId: true } })).notificationId;
  const rejeicoes = (recordId: string, notificationId: string) => db.officialRecordRejection.count({ where: { recordId, notificationId } });
  const post = (caminho: string, corpo: object): Promise<Resposta> =>
    t
      .http()
      .post(`/api/vigilancia/conciliacao/${caminho}`)
      .set(auth('vig'))
      .send(corpo)
      .then((r) => ({ status: r.status, body: r.body }));
  /** Segura a trava num cliente à parte (a importação aplicando, para quem pede a trava). */
  const segurarTrava = async (chave: string) => {
    const url = new URL(TEST_PG);
    url.pathname = `/tenant_db_${t.slug.replace(/-/g, '_')}`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('${chave}'))`);
    return {
      soltar: async () => {
        await c.query('ROLLBACK');
        await c.end();
      },
    };
  };

  beforeAll(async () => {
    t = await startTestApp('vigconctravas');
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    const vera = (await db.user.findUniqueOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf } })).id;
    importacaoId = (await db.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'travas.dbf', sha256: 'a'.repeat(64), sizeBytes: 1, createdBy: vera, appliedAt: new Date() } })).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ImportacaoService.ganchoDeTeste = null;
  });

  afterAll(async () => {
    await t?.close();
  });

  it('K5: com a trava da importação ocupada, a tarefa devolve 0 na hora e não vincula; solta, vincula', async () => {
    const r = await registro('7700501');
    const n = await notificacao('7700501');
    // Uma importação aplicando (antes de chegar à trava da conciliação, ou de outra versão do processo).
    const trava = await segurarTrava('vigilancia:importacao');
    try {
      const inicio = Date.now();
      expect((await tarefa()).vinculadosAutomaticamente).toBe(0);
      expect(Date.now() - inicio).toBeLessThan(10_000);
      expect(await vinculo(r)).toBeNull();
    } finally {
      await trava.soltar();
    }
    expect((await tarefa()).vinculadosAutomaticamente).toBe(1);
    expect(await vinculo(r)).toBe(n);
  });

  it('K5: vincular, desvincular e rejeitar esperam a trava da conciliação só por alguns segundos e respondem 409 CONCILIACAO_OCUPADA', async () => {
    const vinculado = await db.officialRecord.findFirstOrThrow({ where: { number: '7700501' }, select: { id: true } });
    const r2 = await registro('7700502');
    const n2 = await notificacao();
    const r3 = await registro('7700503');
    const n3 = await notificacao();
    const r4 = await registro('7700504');
    const n4 = await notificacao();
    const trava = await segurarTrava('vigilancia:conciliacao');
    const pedidos = [
      post('vincular', { recordId: r2, notificationId: n2 }),
      post('desvincular', { recordId: vinculado.id, motivo: 'Vinculado por engano no teste.' }),
      post('rejeitar', { recordId: r3, notificationId: n3, motivo: 'Pessoas diferentes no teste.' }),
      // Com "preencher o número oficial": o 409 vem antes de mexer na notificação.
      post('vincular', { recordId: r4, notificationId: n4, preencherNumeroOficial: true }),
    ];
    let respostas: (Resposta | 'sem resposta')[];
    const inicio = Date.now();
    try {
      respostas = await Promise.all(pedidos.map((p) => Promise.race([p, espera(10_000)])));
    } finally {
      await trava.soltar();
      await Promise.allSettled(pedidos);
    }
    const tempo = Date.now() - inicio;
    for (const resposta of respostas)
      expect(resposta).toEqual({
        status: 409,
        body: expect.objectContaining({ code: 'CONCILIACAO_OCUPADA', message: 'A conciliação está sendo atualizada agora (importação ou vínculo automático). Tente de novo em instantes.' }),
      });
    expect(tempo).toBeGreaterThanOrEqual(2_500);
    expect(tempo).toBeLessThan(10_000);
    // Nada mudou.
    expect(await vinculo(r2)).toBeNull();
    expect(await vinculo(vinculado.id)).not.toBeNull();
    expect(await rejeicoes(r3, n3)).toBe(0);
    expect(await vinculo(r4)).toBeNull();
    expect(await db.notification.findUniqueOrThrow({ where: { id: n4 }, select: { officialNumber: true, entryStatus: true } })).toEqual({ officialNumber: null, entryStatus: 'PENDENTE' });
    // Sem a trava, as três passam.
    expect((await post('vincular', { recordId: r2, notificationId: n2 })).status).toBe(200);
    expect((await post('desvincular', { recordId: vinculado.id, motivo: 'Vinculado por engano no teste.' })).status).toBe(200);
    expect((await post('rejeitar', { recordId: r3, notificationId: n3, motivo: 'Pessoas diferentes no teste.' })).status).toBe(200);
    expect(await post('vincular', { recordId: r4, notificationId: n4, preencherNumeroOficial: true })).toMatchObject({ status: 200, body: { numeroOficialPreenchido: true } });
    expect(await db.notification.findUniqueOrThrow({ where: { id: n4 }, select: { officialNumber: true } })).toEqual({ officialNumber: '7700504' });
  });

  it('K5: importação real segurada depois de gravar os registros, com a tarefa e o vincular ao mesmo tempo: sem 40P01, APLICADA, tarefa 0 e vincular 409', async () => {
    const erros = vi.spyOn(Logger.prototype, 'error');
    const d = hoje();
    const linha = (numero: string): Record<string, ValorEscrita> => ({
      TP_NOT: '2',
      ID_AGRAVO: 'A379',
      DT_NOTIFIC: d,
      SEM_NOT: semanaDaData(d).codigo,
      NU_ANO: d.slice(0, 4),
      SG_UF_NOT: '35',
      ID_MUNICIP: MUN,
      ID_UNIDADE: UBS,
      SG_UF: '35',
      ID_MN_RESI: MUN,
      NU_NOTIFIC: numero,
      NM_PACIENT: `PESSOA DO REGISTRO ${numero}`,
      CS_SEXO: 'F',
    });
    const enviarEAplicar = async (numeros: string[], nome: string) => {
      const envio = (
        await t
          .http()
          .post('/api/vigilancia/importacoes')
          .query({ nome })
          .set(auth('vig'))
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from(escreverDbf(CAMPOS_NINDINET, numeros.map(linha))))
          .expect(201)
      ).body as { id: string };
      return { id: envio.id, aplicar: t.http().post(`/api/vigilancia/importacoes/${envio.id}/aplicar`).set(auth('vig')) };
    };
    const primeira = await enviarEAplicar(['7700601', '7700602'], 'NINDINET-1.DBF');
    expect((await primeira.aplicar).status).toBe(200);
    // Depois da primeira importação: a vigilância informa o número de uma; a outra fica para o vínculo manual.
    const n6 = await notificacao('7700601');
    const n7 = await notificacao();
    const r7 = (await db.officialRecord.findFirstOrThrow({ where: { number: '7700602' }, select: { id: true } })).id;

    // A segunda importação traz os dois de novo (travas de linha neles) e um novo; fica parada depois de gravar.
    let chegou!: () => void;
    let soltar!: () => void;
    const naGravacao = new Promise<void>((r) => (chegou = r));
    const solta = new Promise<void>((r) => (soltar = r));
    ImportacaoService.ganchoDeTeste = async (etapa, _id, momento) => {
      if (etapa === 'APLICANDO' && momento === 'GRAVADO') {
        chegou();
        await solta;
      }
    };
    const segunda = await enviarEAplicar(['7700601', '7700602', '7700603'], 'NINDINET-2.DBF');
    const aplicar = segunda.aplicar.then((r) => r);
    let tarefaNoMeio: number | undefined;
    let vincularNoMeio: Resposta | 'sem resposta' = 'sem resposta';
    try {
      await Promise.race([naGravacao, espera(20_000)]);
      const inicio = Date.now();
      tarefaNoMeio = (await tarefa()).vinculadosAutomaticamente;
      expect(Date.now() - inicio).toBeLessThan(10_000);
      vincularNoMeio = await Promise.race([post('vincular', { recordId: r7, notificationId: n7 }), espera(10_000)]);
    } finally {
      soltar();
    }
    const aplicada = await aplicar;
    expect(tarefaNoMeio).toBe(0);
    expect(vincularNoMeio).toEqual({ status: 409, body: expect.objectContaining({ code: 'CONCILIACAO_OCUPADA' }) });
    expect([200, 202]).toContain(aplicada.status);
    let imp = await db.officialImport.findUniqueOrThrow({ where: { id: segunda.id }, select: { status: true, error: true, workingStep: true } });
    for (let i = 0; i < 100 && imp.status !== 'APLICADA'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      imp = await db.officialImport.findUniqueOrThrow({ where: { id: segunda.id }, select: { status: true, error: true, workingStep: true } });
    }
    expect(imp).toMatchObject({ status: 'APLICADA', error: null });
    expect(await db.officialRecord.count({ where: { number: '7700603' } })).toBe(1);
    expect(
      erros.mock.calls
        .flat()
        .map(String)
        .filter((m) => /40P01|deadlock/i.test(m)),
    ).toEqual([]);
    // A própria importação vinculou o registro que ganhou o número; o manual passa depois dela.
    expect(await vinculo((await db.officialRecord.findFirstOrThrow({ where: { number: '7700601' } })).id)).toBe(n6);
    expect((await post('vincular', { recordId: r7, notificationId: n7 })).status).toBe(200);
  });

  it('conciliacao-4: "não é o mesmo caso" no meio do vínculo automático não deixa o par vinculado com a rejeição gravada', async () => {
    const conc = t.app.get(ConciliacaoService) as unknown as { candidatosDoDegrau: (...a: unknown[]) => Promise<unknown[]> };
    const original = conc.candidatosDoDegrau.bind(conc);
    let segurar: { chegou: () => void; solta: Promise<void> } | null = null;
    vi.spyOn(conc, 'candidatosDoDegrau').mockImplementation(async (...args: unknown[]) => {
      const lidos = await original(...args);
      if (segurar && lidos.length) {
        const s = segurar;
        segurar = null;
        s.chegou();
        await s.solta;
      }
      return lidos;
    });
    const segurarTarefa = () => {
      let chegou!: () => void;
      let soltar!: () => void;
      const leu = new Promise<void>((r) => (chegou = r));
      segurar = { chegou, solta: new Promise<void>((r) => (soltar = r)) };
      return { leu, soltar };
    };

    // (1) A vigilância rejeita enquanto a tarefa já leu o candidato: a rejeição espera a trava e acha o par vinculado.
    const r8 = await registro('7700801');
    const n8 = await notificacao('7700801');
    const s1 = segurarTarefa();
    const rodada1 = tarefa();
    await s1.leu;
    const rejeitar = post('rejeitar', { recordId: r8, notificationId: n8, motivo: 'Não é o mesmo caso no teste.' });
    await new Promise((r) => setTimeout(r, 800));
    s1.soltar();
    const [resposta, feita] = await Promise.all([rejeitar, rodada1]);
    expect(feita.vinculadosAutomaticamente).toBe(1);
    expect(resposta).toEqual({ status: 409, body: expect.objectContaining({ code: 'CONFLITO', message: 'O par está vinculado: use "desvincular"' }) });
    expect(await vinculo(r8)).toBe(n8);
    expect(await rejeicoes(r8, n8)).toBe(0);

    // (2) A rejeição gravada entre a leitura dos candidatos e a gravação do vínculo (por quem não pega a trava) vale.
    const r9 = await registro('7700901');
    const n9 = await notificacao('7700901');
    const vera = (await db.user.findUniqueOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf } })).id;
    const s2 = segurarTarefa();
    const rodada2 = tarefa();
    await s2.leu;
    await db.officialRecordRejection.create({ data: { recordId: r9, notificationId: n9, reason: 'Rejeição gravada no meio.', rejectedBy: vera } });
    s2.soltar();
    expect((await rodada2).vinculadosAutomaticamente).toBe(0);
    expect(await vinculo(r9)).toBeNull();
  });
});
