import { randomUUID } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

/**
 * Memória da conciliação com milhares de registros oficiais sem vínculo (achado imp-memoria-resumo): o resumo, as
 * sugestões e as listas contam e paginam no banco, sem carregar a base por requisição. O histórico do diagrama (anos
 * de dengue) é justamente de registros sem vínculo. Mede o pico de heap de cada requisição (amostrado a cada volta do
 * laço de eventos, depois de um gc). Rode com NODE_OPTIONS=--max-old-space-size=512, o heap do container de 1 GiB da
 * produção. Antes da correção, 10 mil registros custavam cerca de 70 MB por resumo.
 */

const enabled = await pgAvailable();
const N = 10_000;
/** Teto do pico de heap por requisição (a versão que carregava a base passava de 40 MB com 10 mil registros). */
const TETO_MB = 16;

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

/** Pico de heap (MB) durante a chamada, acima do heap depois do gc. */
async function picoDeHeap(fn: () => Promise<unknown>): Promise<number> {
  gc();
  gc();
  const base = process.memoryUsage().heapUsed;
  let max = base;
  const amostra = setInterval(() => {
    const h = process.memoryUsage().heapUsed;
    if (h > max) max = h;
  }, 0);
  try {
    await fn();
  } finally {
    clearInterval(amostra);
  }
  max = Math.max(max, process.memoryUsage().heapUsed);
  return (max - base) / 2 ** 20;
}

describe.runIf(enabled)(`Conciliação com ${N.toLocaleString('pt-BR')} registros sem vínculo: memória por requisição`, () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('vigconcmem', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    t.app.get(AiService).client = null;
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    // Uma importação aplicada do DENGON com dez anos de histórico, gravada direto (a leitura do arquivo não é o que se mede).
    const user = await db.user.findFirstOrThrow({ select: { id: true } });
    const imp = await db.officialImport.create({
      data: {
        id: randomUUID(),
        system: 'SINAN_ONLINE',
        status: 'APLICADA',
        fileName: 'DENGON-historico.zip',
        sha256: 'f'.repeat(64),
        sizeBytes: 1,
        files: [
          {
            nome: 'DENGON.DBF',
            tipo: 'DENGON',
            sistema: 'SINAN_ONLINE',
            tipoRegistro: 'INDIVIDUAL',
            tamanhoBytes: 1,
            registros: N,
            codificacao: 'CP850',
            origemCodificacao: 'CABECALHO',
            agravos: ['A90'],
            periodo: { de: '2016-01-03', ate: '2025-11-29' },
            identificado: true,
            ignorado: false,
            avisos: [],
          },
        ],
        createdBy: user.id,
        appliedBy: user.id,
        appliedAt: new Date(),
      },
    });
    await db.$executeRaw`
      INSERT INTO official_records (id, system, type, natural_key, number, notified_on, epi_week_notified, municipality_ibge, unit_cnes, agravo, group_key,
        symptoms_onset, residence_ibge, neighborhood_name, final_class, criterion, situation, patient_name, patient_name_norm, birth_date, sex, mother_name_norm,
        cns, data, content_hash, first_import_id, last_import_id, last_seen_at, updated_at)
      SELECT gen_random_uuid(), 'SINAN_ONLINE', 'INDIVIDUAL', (i::text || '|' || d::text || '|355030|A90'), lpad(i::text, 7, '0'), d, to_char(d, 'IYYYIW'), '355030', '9000011', 'A90', 'dengue',
        d - 3, '355030', 'BAIRRO HISTORICO ' || (i % 40), '10', '1', 'CONFIRMADO', 'PACIENTE HISTORICO ' || i, 'paciente historico ' || i, date '1950-01-01' + (i % 20000),
        CASE WHEN i % 2 = 0 THEN 'M' ELSE 'F' END, 'mae do paciente historico ' || i, NULL,
        jsonb_build_object('cs_raca', '1', 'cs_escol_n', '09', 'id_ocupa_n', '999999', 'tp_sistema', '2', 'dt_invest', d::text, '_fontes', jsonb_build_object('classificacao', 'DENGON')),
        repeat('0', 64), ${imp.id}::uuid, ${imp.id}::uuid, now(), now()
      FROM generate_series(1, ${N}) AS i, LATERAL (SELECT date '2016-01-03' + (i % 3600) AS d) x`;
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('resumo, sugestões e listas: o pico de heap por requisição não cresce com a base', async () => {
    expect(await db.officialRecord.count({ where: { notificationId: null } })).toBe(N);
    const get = (caminho: string, q: Record<string, string> = {}) => t.http().get(`/api/vigilancia/conciliacao/${caminho}`).query(q).set(auth(vig)).expect(200);
    // Aquecimento (compilação e cache das consultas não contam).
    await get('resumo');
    await get('sugestoes');
    const medidas: Record<string, { mb: number; ms: number }> = {};
    for (const [nome, q] of [
      ['resumo', {}],
      ['sugestoes', {}],
      ['so-oficial', {}],
      ['so-omnisaude', {}],
      ['divergentes', {}],
      ['vinculados', {}],
      ['so-oficial', { busca: 'paciente historico 99' }],
    ] as const) {
      const inicio = performance.now();
      let corpo: { total?: number; registros?: number } = {};
      const mb = await picoDeHeap(async () => {
        corpo = (await get(nome, q)).body;
      });
      medidas[`${nome}${Object.keys(q).length ? ' (busca)' : ''}`] = { mb: Math.round(mb * 10) / 10, ms: Math.round(performance.now() - inicio) };
      if (nome === 'resumo') expect(corpo.registros).toBe(N);
      if (nome === 'so-oficial' && !Object.keys(q).length) expect(corpo.total).toBe(N);
    }
    console.log(`Pico de heap por requisição com ${N} registros sem vínculo (MB e ms):`, JSON.stringify(medidas));
    for (const [nome, m] of Object.entries(medidas)) expect(m.mb, nome).toBeLessThan(TETO_MB);
  }, 120_000);
});
