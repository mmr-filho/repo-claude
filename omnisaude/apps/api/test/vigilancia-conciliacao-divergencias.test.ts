import { semanaDaData } from '@omnisaude/shared';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { ConciliacaoService, divergenciasDoPar } from '../src/modules/vigilancia/conciliacao.service';
import { ImportacaoService } from '../src/modules/vigilancia/importacao.service';
import { CAMPOS_NINDINET, escreverDbf, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Divergências dos pares vinculados depois de uma importação, quarta rodada da semana 27 (VIG-1c, IMPORTACAO-3).
 * `atualizarDivergencias` grava em lotes (uma leitura dos dois lados e um UPDATE por lote, com um parâmetro JSON) em
 * vez de um UPDATE por registro dentro da transação da aplicação. O resultado é o do caminho antigo, coluna a coluna (o
 * caminho antigo está copiado aqui como referência), e 4.000 registros alterados e vinculados aplicam perto do tempo
 * de 4.000 alterados sem vínculo (antes: 3,3 s contra 0,6 s). Dados sintéticos.
 */

const enabled = await pgAvailable();
const MUN = '355030';
const UBS = '9000011';

type Db = Awaited<ReturnType<TenantsService['client']>>;

/** O caminho antigo (conciliacao.service.ts da terceira rodada), sem mudar nada: um UPDATE por registro. */
async function atualizarDivergenciasAntigo(db: Db, recordIds: string[]): Promise<void> {
  for (let i = 0; i < recordIds.length; i += 1000) {
    const regs = await db.officialRecord.findMany({
      where: { id: { in: recordIds.slice(i, i + 1000) }, notificationId: { not: null } },
      select: { id: true, system: true, agravo: true, situation: true, evolution: true, closedOn: true, notificationId: true },
    });
    const nots = new Map(
      (
        await db.notification.findMany({
          where: { id: { in: regs.map((r) => r.notificationId!) } },
          select: { id: true, status: true, finalClass: true, evolution: true, closedAt: true },
        })
      ).map((n) => [n.id, n]),
    );
    for (const r of regs) {
      const n = nots.get(r.notificationId!);
      if (n) await db.officialRecord.update({ where: { id: r.id }, data: { divergences: divergenciasDoPar(r, n) as object[] } });
    }
  }
}

describe.runIf(enabled)('Vigilância: divergências dos pares vinculados gravadas em lote (IMPORTACAO-3)', () => {
  let t: TestApp;
  let vig = '';
  let db: Db;
  let autor = '';
  let ubsId = '';
  let pacienteId = '';
  let condicao: { id: string; key: string; group_key: string };
  let seq = 0;
  const auth = () => ({ authorization: `Bearer ${vig}` });

  /** Notificações gravadas direto no banco (o que a unidade e a vigilância já tinham feito), com o desfecho pedido. */
  const notificacoes = async (desfechos: { status: string; classe: string | null; evolucao: string | null; encerrada: string | null }[], ano = 2026) => {
    const linhas = desfechos.map((d) => ({ ...d, seq: ++seq }));
    return db.$queryRaw<{ id: string }[]>`
      INSERT INTO notifications (id, year, seq, number, status, origin, condition_id, condition_key, group_key, patient_id, unit_id, notifier_id, notifier_role,
                                 known_at, deadline_start, deadline_kind, final_class, evolution, closed_at, updated_at)
      SELECT gen_random_uuid(), ${ano}, 700000 + x.seq, 'DIV-' || x.seq, x.status::"NotificationStatus", 'MANUAL', ${condicao.id}::uuid, ${condicao.key}, ${condicao.group_key},
             ${pacienteId}::uuid, ${ubsId}::uuid, ${autor}::uuid, 'VIGILANCIA_EPIDEMIOLOGICA', now(), 'CONHECIMENTO', 'SEMANAL', x.classe, x.evolucao, x.encerrada::date, now()
      FROM jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) AS x(seq int, status text, classe text, evolucao text, encerrada text)
      ORDER BY x.seq
      RETURNING id::text AS id`;
  };

  beforeAll(async () => {
    t = await startTestApp('vigconcdiv');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    // O catálogo nacional entra no banco na primeira vez que é usado.
    await t.app.get(CatalogoVigilanciaService).garantir({ tenant, db } as never);
    [{ id: autor }] = await db.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM users ORDER BY id LIMIT 1`;
    [{ id: ubsId }] = await db.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM units WHERE cnes = ${UBS}`;
    [{ id: pacienteId }] = await db.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM patients ORDER BY id LIMIT 1`;
    [condicao] = await db.$queryRaw<{ id: string; key: string; group_key: string }[]>`
      SELECT id::text AS id, key, group_key FROM notifiable_conditions WHERE group_key = 'leptospirose' ORDER BY key LIMIT 1`;
    expect(condicao).toBeDefined();
  }, 120_000);

  afterAll(async () => {
    await ImportacaoService.aguardarTrabalhos();
    await t?.close();
  });

  it('o lote grava o mesmo que o caminho antigo, coluna a coluna, nos sistemas, fichas e desfechos (com lotes de 250)', async () => {
    const imp = (
      await db.officialImport.create({
        data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'divergencias.dbf', sha256: 'c'.repeat(64), sizeBytes: 1, createdBy: autor, appliedAt: new Date() },
      })
    ).id;
    // O lado oficial: sistemas, fichas com a evolução própria (tuberculose: 3 é o óbito; Mpox: 1 é o óbito), códigos com
    // espaço e zero à esquerda, sem evolução e sem encerramento.
    const registros: { system: 'SINAN_NET' | 'SINAN_ONLINE' | 'ESUS_SINAN' | 'ESUS_NOTIFICA'; agravo: string | null; grupo: string; situation: string; evolution: string | null; closedOn: string | null }[] = [
      { system: 'SINAN_NET', agravo: 'A279', grupo: 'leptospirose', situation: 'CONFIRMADO', evolution: '1', closedOn: '2026-10-01' },
      { system: 'SINAN_NET', agravo: 'A169', grupo: 'tuberculose', situation: 'CONFIRMADO', evolution: '3', closedOn: null },
      { system: 'SINAN_NET', agravo: 'A169', grupo: 'tuberculose', situation: 'DESCARTADO', evolution: '5', closedOn: '2026-10-02' },
      { system: 'ESUS_SINAN', agravo: 'B04', grupo: 'mpox', situation: 'CONFIRMADO', evolution: '1', closedOn: '2026-10-03' },
      { system: 'ESUS_NOTIFICA', agravo: null, grupo: 'covid', situation: 'CONFIRMADO', evolution: '6', closedOn: '2026-11-30' },
      { system: 'ESUS_NOTIFICA', agravo: null, grupo: 'covid', situation: 'EM_INVESTIGACAO', evolution: '3', closedOn: null },
      { system: 'SINAN_ONLINE', agravo: 'A90', grupo: 'dengue', situation: 'EM_INVESTIGACAO', evolution: ' 2', closedOn: null },
      { system: 'SINAN_NET', agravo: 'A279', grupo: 'leptospirose', situation: 'INCONCLUSIVO', evolution: '02', closedOn: '2026-11-30' },
      { system: 'SINAN_NET', agravo: 'A279', grupo: 'leptospirose', situation: 'CONFIRMADO', evolution: null, closedOn: null },
    ];
    // O lado do OmniSaúde: em investigação, encerradas com cada classificação, a classificação com espaço e sem data.
    const desfechos = [
      { status: 'NOTIFICADA', classe: null, evolucao: null, encerrada: null },
      { status: 'ENCERRADA', classe: '1', evolucao: '1', encerrada: '2026-10-01' },
      { status: 'ENCERRADA', classe: '2', evolucao: '2', encerrada: '2026-10-03' },
      { status: 'ENCERRADA', classe: '8', evolucao: '9', encerrada: '2026-11-30' },
      { status: 'ENCERRADA', classe: ' 1', evolucao: '3', encerrada: null },
    ];
    // Todas as combinações, repetidas até passar de dois lotes (250 por lote): 9 × 5 × 14 = 630 pares.
    const pares = Array.from({ length: 14 }, () => registros.flatMap((r) => desfechos.map((d) => ({ r, d })))).flat();
    const nots = await notificacoes(pares.map((p) => p.d));
    const linhas = pares.map((p, i) => ({ ...p.r, numero: String(5_000_000 + i), nid: nots[i]!.id, antes: i % 3 === 0 ? null : i % 3 === 1 ? [] : [{ campo: 'situacao', oficial: 'X', omnisaude: 'Y' }] }));
    const vinculados = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO official_records (id, system, type, natural_key, number, notified_on, municipality_ibge, agravo, group_key, situation, evolution, closed_on,
                                    notification_id, match_method, matched_at, divergences, content_hash, first_import_id, last_import_id, last_seen_at, updated_at)
      SELECT gen_random_uuid(), x.system::"OfficialSystem", 'INDIVIDUAL', x.numero || '|div', x.numero, DATE '2026-09-20', ${MUN}, x.agravo, x.grupo, x.situation, x.evolution,
             x.closed_on::date, x.nid::uuid, 'MANUAL', now(), x.antes, ${'a'.repeat(64)}, ${imp}::uuid, ${imp}::uuid, now(), now() - interval '1 day'
      FROM jsonb_to_recordset(${JSON.stringify(linhas.map((l) => ({ ...l, closed_on: l.closedOn })))}::jsonb)
        AS x(system text, agravo text, grupo text, situation text, evolution text, closed_on text, numero text, nid text, antes jsonb)
      ORDER BY x.numero
      RETURNING id::text AS id`;
    // Sem vínculo (o lote não mexe) e um id que não existe.
    const soltos = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO official_records (id, system, type, natural_key, number, notified_on, municipality_ibge, agravo, group_key, situation, divergences, content_hash, first_import_id, last_import_id, last_seen_at, updated_at)
      SELECT gen_random_uuid(), 'SINAN_NET', 'INDIVIDUAL', g || '|solto', g::text, DATE '2026-09-20', ${MUN}, 'A279', 'leptospirose', 'CONFIRMADO', NULL, ${'a'.repeat(64)}, ${imp}::uuid, ${imp}::uuid, now(), now() - interval '1 day'
      FROM generate_series(6000000, 6000009) g
      RETURNING id::text AS id`;
    const ids = [...vinculados, ...soltos].map((r) => r.id);
    // A ordem de entrada embaralhada (como a aplicação junta os alterados), com o id que não existe no meio.
    const entrada = [...ids].sort((a, b) => (a.slice(-4) < b.slice(-4) ? -1 : 1));
    entrada.splice(300, 0, '00000000-0000-4000-8000-000000000000');

    const retrato = async () =>
      new Map(
        (
          await db.$queryRaw<{ id: string; linha: Record<string, unknown>; atualizado: Date }[]>`
          SELECT id::text AS id, to_jsonb(r) - 'updated_at' AS linha, updated_at AS atualizado FROM official_records r WHERE id = ANY(${ids}::uuid[])`
        ).map((x) => [x.id, x]),
      );
    const inicial = await retrato();
    // Volta as divergências e a data de atualização ao retrato inicial (para o caminho novo partir do mesmo estado).
    const voltar = () => db.$executeRaw`
      UPDATE official_records r SET divergences = x.antes, updated_at = x.atualizado AT TIME ZONE 'UTC'
      FROM jsonb_to_recordset(${JSON.stringify([...inicial.values()].map((x) => ({ id: x.id, antes: x.linha.divergences ?? null, atualizado: x.atualizado.toISOString() })))}::jsonb)
        AS x(id text, antes jsonb, atualizado timestamptz)
      WHERE r.id = x.id::uuid`;

    await db.$transaction((tx) => atualizarDivergenciasAntigo(tx as unknown as Db, entrada), { timeout: 120_000 });
    const antigo = await retrato();
    await voltar();
    expect((await retrato()).get(vinculados[0]!.id)!.linha).toEqual(inicial.get(vinculados[0]!.id)!.linha);
    const conciliacao = t.app.get(ConciliacaoService);
    await db.$transaction((tx) => conciliacao.atualizarDivergencias(tx, entrada), { timeout: 120_000 });
    const novo = await retrato();

    // Coluna a coluna, registro a registro (a data de atualização muda nos dois e só nos vinculados).
    let comDiferenca = 0;
    for (const id of ids) {
      expect(novo.get(id)!.linha, id).toEqual(antigo.get(id)!.linha);
      const vinculado = !!inicial.get(id)!.linha.notification_id;
      for (const depois of [novo, antigo]) expect(depois.get(id)!.atualizado.getTime() > inicial.get(id)!.atualizado.getTime(), id).toBe(vinculado);
      if (vinculado && (novo.get(id)!.linha.divergences as unknown[]).length) comDiferenca++;
    }
    // As combinações cobrem par igual e par com diferença, e os soltos ficaram como estavam.
    expect(comDiferenca).toBeGreaterThan(0);
    expect(comDiferenca).toBeLessThan(vinculados.length);
    for (const s of soltos) expect(novo.get(s.id)!.linha).toEqual(inicial.get(s.id)!.linha);
    // Os três campos aparecem: situação, evolução traduzida pela ficha e encerramento.
    const campos = new Set([...novo.values()].flatMap((x) => ((x.linha.divergences ?? []) as { campo: string }[]).map((d) => d.campo)));
    expect([...campos].sort()).toEqual(['encerramento', 'evolucao', 'situacao']);
  });

  it('4.000 registros alterados e vinculados aplicam perto do tempo de 4.000 alterados sem vínculo', async () => {
    const N = 4000;
    const reg = (n: number, dt: string, v: Record<string, ValorEscrita> = {}) => ({
      NU_NOTIFIC: String(n),
      TP_NOT: '2',
      ID_AGRAVO: 'A279',
      DT_NOTIFIC: dt,
      SEM_NOT: semanaDaData(dt).codigo,
      NU_ANO: dt.slice(0, 4),
      SG_UF_NOT: '35',
      ID_MUNICIP: MUN,
      ID_UNIDADE: UBS,
      SG_UF: '35',
      ID_MN_RESI: MUN,
      NM_PACIENT: `PACIENTE ${n}`,
      CS_SEXO: 'F',
      NM_BAIRRO: 'CENTRO',
      ...v,
    });
    const lote = (base: number, ano: number, v: Record<string, ValorEscrita> = {}) =>
      zipSync({
        'NINDINET.DBF': escreverDbf(
          CAMPOS_NINDINET,
          Array.from({ length: N }, (_, i) => reg(base + i, `${ano}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`, v)),
        ),
      });
    const importar = async (bytes: Uint8Array, nome: string) => {
      const envio = (await t.http().post('/api/vigilancia/importacoes').query({ nome }).set(auth()).set('Content-Type', 'application/octet-stream').send(Buffer.from(bytes)).expect(201)).body as { id: string };
      const inicio = Date.now();
      const r = (await t.http().post(`/api/vigilancia/importacoes/${envio.id}/aplicar`).set(auth()).expect(200)).body as { contagens: { alterados: number } };
      return { ms: Date.now() - inicio, alterados: r.contagens.alterados };
    };

    // Dois conjuntos: A (2022), que fica vinculado, e B (2023), sem vínculo.
    await importar(lote(9_100_000, 2022), 'a-novos.zip');
    await importar(lote(9_200_000, 2023), 'b-novos.zip');
    // Uma notificação por registro de A, ligada direto no banco (como se a conciliação tivesse vinculado), com desfecho:
    // o lote recalcula as divergências de todos os 4.000.
    await notificacoes(
      Array.from({ length: N }, (_, i) => ({ status: i % 2 ? 'ENCERRADA' : 'NOTIFICADA', classe: i % 2 ? '1' : null, evolucao: i % 4 === 1 ? '1' : null, encerrada: i % 2 ? '2022-12-20' : null })),
      2022,
    );
    const ligados = await db.$executeRaw`
      UPDATE official_records r SET notification_id = x.nid, match_method = 'MANUAL', matched_at = now()
      FROM (SELECT r2.id AS rid, n.id AS nid FROM
              (SELECT id, row_number() OVER (ORDER BY id) AS k FROM official_records WHERE number ~ '^91[0-9]{5}$') r2
              JOIN (SELECT id, row_number() OVER (ORDER BY id) AS k FROM notifications WHERE year = 2022 AND number LIKE 'DIV-%') n ON n.k = r2.k) x
      WHERE r.id = x.rid`;
    expect(ligados).toBe(N);

    // Duas rodadas de alterações (o bairro muda), A e B alternados: vale o menor tempo de cada um (menos ruído da máquina).
    const vinculados: number[] = [];
    const soltos: number[] = [];
    for (const bairro of ['VILA NOVA', 'VILA VELHA']) {
      const a = await importar(lote(9_100_000, 2022, { NM_BAIRRO: bairro }), `a-${bairro}.zip`);
      const b = await importar(lote(9_200_000, 2023, { NM_BAIRRO: bairro }), `b-${bairro}.zip`);
      expect([a.alterados, b.alterados]).toEqual([N, N]);
      vinculados.push(a.ms);
      soltos.push(b.ms);
    }
    console.log(`IMPORTACAO-3: aplicar ${N} alterados: vinculados ${vinculados.join(' e ')} ms; sem vínculo ${soltos.join(' e ')} ms`);

    // As divergências gravadas são as do par com os dados atuais (uma amostra de cada desfecho).
    const amostra = await db.officialRecord.findMany({
      where: { number: { in: ['9100000', '9100001', '9100002', '9100003'] } },
      select: { system: true, agravo: true, situation: true, evolution: true, closedOn: true, divergences: true, notification: { select: { status: true, finalClass: true, evolution: true, closedAt: true } } },
    });
    expect(amostra).toHaveLength(4);
    for (const a of amostra) expect(a.divergences).toEqual(divergenciasDoPar(a, a.notification!));
    // Antes: 3,3 s com vínculo contra 0,6 s sem (um UPDATE por registro dentro da transação da aplicação).
    expect(Math.min(...vinculados)).toBeLessThan(Math.min(...soltos) * 2 + 250);
  }, 300_000);
});
