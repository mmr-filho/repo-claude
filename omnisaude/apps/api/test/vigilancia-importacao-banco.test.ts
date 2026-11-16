import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Importação com banco (VIG-1c, achado imp-memoria): a prévia compara em lotes e a aplicação lê o payload em lotes, então
 * o heap não cresce com o envio. Um CSV do e-SUS Notifica com 60 mil linhas passa pela API (prévia e aplicação) enquanto
 * um amostrador mede o crescimento do heap e o laço de eventos. Antes, o envio inteiro ficava na memória três vezes
 * (leitura, payload e aplicação): só a leitura de 40 mil linhas já passava de 140 MB de heap e travava o laço por 1,7 s.
 */

const enabled = await pgAvailable();
const N = 60_000;

describe.runIf(enabled)('importação com banco: heap e laço de eventos num envio de 60 mil linhas', () => {
  let t: TestApp;
  let vig = '';
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  beforeAll(async () => {
    t = await startTestApp('vigimpbanco');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it('prévia e aplicação em lotes: o heap cresce pouco e o laço de eventos não para', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const cab = 'Número da Notificação;Data da Notificação;Data do início dos sintomas;Município da Notificação;CNES Notificação;Nome Completo;Sexo;Sintoma- Febre;Evolução Caso;Classificação Final;Bairro';
    const linhas = [cab];
    for (let i = 0; i < N; i++) {
      const d = `${String(1 + (i % 28)).padStart(2, '0')}/0${1 + (i % 9)}/2024`;
      linhas.push(`3524${String(i).padStart(8, '0')};${d};${d};3550308;9000011;Paciente Numero ${i} da Silva Teste;${i % 2 ? 'Feminino' : 'Masculino'};Sim;Cura;Confirmado Laboratorial;Centro`);
    }
    const zip = Buffer.from(zipSync({ 'esus-2024.csv': new TextEncoder().encode(linhas.join('\r\n')) }));
    linhas.length = 0;

    gc();
    const base = process.memoryUsage().heapUsed;
    // Heap retido: coleta forçada a cada 250 ms (o heap do vitest não tem teto e deixaria lixo acumular).
    let retido = 0;
    const coleta = setInterval(() => {
      gc();
      retido = Math.max(retido, process.memoryUsage().heapUsed - base);
    }, 250);
    const atraso = monitorEventLoopDelay({ resolution: 10 });
    atraso.enable();
    try {
      const previa = (await t.http().post('/api/vigilancia/importacoes').query({ nome: 'esus-2024.zip' }).set(auth(vig)).set('Content-Type', 'application/octet-stream').send(zip).expect(201)).body;
      expect(previa.contagens).toMatchObject({ lidos: N, novos: N, recusados: 0 });
      const retidoPrevia = retido;
      const r = (await t.http().post(`/api/vigilancia/importacoes/${previa.id}/aplicar`).set(auth(vig)).expect(200)).body;
      expect(r.contagens).toMatchObject({ novos: N });
      atraso.disable();
      const medida = { linhas: N, zipMB: +(zip.length / 1048576).toFixed(1), retidoPreviaMB: Math.round(retidoPrevia / 1048576), retidoMB: Math.round(retido / 1048576), maiorPausaMs: Math.round(atraso.max / 1e6) };
      console.log(`[importação com banco] ${JSON.stringify(medida)}`);
      // Cresce o índice das chaves e os lotes; o histórico do debug do Prisma guarda os últimos INSERTs (limitado).
      expect(medida.retidoMB).toBeLessThan(80);
      // A coleta forçada também pausa o laço; mesmo assim, longe de 1 s.
      expect(medida.maiorPausaMs).toBeLessThan(500);
      const tenants = t.app.get(TenantsService);
      const db = await tenants.client((await tenants.resolve(t.slug)).id);
      expect(await db.officialRecord.count({ where: { system: 'ESUS_NOTIFICA' } })).toBe(N);
      // O INSERT por SQL grava o mesmo que o Prisma gravaria: id UUIDv7, datas e o estado relido com o mesmo hash.
      const um = await db.officialRecord.findFirstOrThrow({ where: { number: '352400000007' } });
      expect(um.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(um).toMatchObject({ system: 'ESUS_NOTIFICA', type: 'INDIVIDUAL', naturalKey: '352400000007', groupKey: 'covid', situation: 'CONFIRMADO', excluded: false, sensitive: false, sex: 'F' });
      expect(um.notifiedOn.toISOString()).toBe('2024-08-08T00:00:00.000Z');
      expect(Math.abs(um.lastSeenAt.getTime() - um.createdAt.getTime())).toBeLessThan(1000);
      expect(Math.abs(um.updatedAt.getTime() - Date.now())).toBeLessThan(10 * 60_000);
      const mesmo = (await t.http().post('/api/vigilancia/importacoes').query({ nome: 'esus-2024-de-novo.zip' }).set(auth(vig)).set('Content-Type', 'application/octet-stream').send(zip).expect(200)).body;
      expect(mesmo).toEqual({ jaImportado: { id: previa.id, aplicadoEm: expect.any(String) } });
    } finally {
      clearInterval(coleta);
      atraso.disable();
    }
  }, 240_000);
});
