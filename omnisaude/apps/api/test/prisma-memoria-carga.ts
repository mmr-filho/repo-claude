/**
 * Carga do teste prisma-memoria.test.ts. Roda num processo próprio, com o heap do container de produção:
 *   node --import tsx --max-old-space-size=512 --expose-gc prisma-memoria-carga.ts <url do banco do tenant>
 * Usa o cliente de tenant com o adaptador pg, como a API, e mede o heap retido depois de cada carga (o que sobra acima
 * da base depois da coleta de lixo). Cada carga tem o tamanho de uma importação grande do CNES (dezenas de milhares de
 * linhas) e repete um padrão de escrita ou leitura em volume do código. Imprime uma linha JSON.
 */
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../packages/database/src/generated/tenant/client';

const LINHAS = 30_000;
const url = process.argv[2];
if (!url) throw new Error('Informe a URL do banco do tenant');
const gc = globalThis.gc;
if (!gc) throw new Error('Rode com --expose-gc');

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }) });
type Db = typeof db;

async function heapUsado() {
  for (let i = 0; i < 4; i++) {
    gc!();
    await tick();
  }
  return process.memoryUsage().heapUsed;
}

/** Endereços no formato da base do CNEFE (território). */
function enderecos(quantos: number, inicio: number) {
  return Array.from({ length: quantos }, (_, k) => {
    const i = inicio + k;
    return {
      source: 'CNEFE2022',
      externalId: `17095000500${String(i).padStart(9, '0')}`,
      ibgeCode: '1709500',
      sector: '170950005000123',
      quadra: String(i % 300).padStart(3, '0'),
      face: String(i % 7).padStart(3, '0'),
      cep: `77405${String(i % 999).padStart(3, '0')}`,
      locality: 'Setor Central',
      street: `RUA JOSÉ DE ALENCAR ${i % 997}`,
      streetKey: `rua jose de alencar ${i % 997}`,
      number: String(i % 2000),
      complement: i % 5 === 0 ? 'CASA 2 FUNDOS' : null,
      quadraKey: `q${i % 300}`,
      loteKey: `l${i % 40}`,
      latitude: -11.73 + i * 1e-6,
      longitude: -49.07 - i * 1e-6,
      level: 1,
      species: 1,
    };
  });
}

/** Linhas da planilha de profissionais do CNES, como a prévia as guarda. */
function profissionais(quantos: number) {
  return Array.from({ length: quantos }, (_, i) => ({
    line: i + 2,
    name: `MARIA DA CONCEIÇÃO SANTOS ${i}`,
    cpf: String(10_000_000_000 + i),
    cns: String(700_000_000_000_000 + i),
    cbo: '515105',
    cboLabel: 'Agente comunitário de saúde',
    cnes: '2468123',
    unitId: randomUUID(),
    unitName: 'UBS Vila Nova São José',
    ine: '0001234567',
    teamFound: true,
    role: 'ACS',
    status: 'acesso',
    errors: [] as string[],
  }));
}

function inserirPorSql(cliente: Db, lote: ReturnType<typeof enderecos>) {
  return cliente.$executeRaw`
    INSERT INTO address_points (id, source, external_id, ibge_code, sector, quadra, face, cep, locality, street, street_key, number,
      complement, quadra_key, lote_key, latitude, longitude, level, species)
    SELECT gen_random_uuid(), r.source, r."externalId", r."ibgeCode", r.sector, r.quadra, r.face, r.cep, r.locality, r.street,
      r."streetKey", r.number, r.complement, r."quadraKey", r."loteKey", r.latitude, r.longitude, r.level, r.species
    FROM jsonb_to_recordset(${JSON.stringify(lote)}::jsonb) AS r(source text, "externalId" text, "ibgeCode" text, sector text,
      quadra text, face text, cep text, locality text, street text, "streetKey" text, number text, complement text, "quadraKey" text,
      "loteKey" text, latitude float8, longitude float8, level int, species int)`;
}

interface Carga {
  nome: string;
  /** `escala` 1 é a carga inteira; o aquecimento roda uma miniatura. `inicio` separa as chaves de cada execução. */
  rodar: (escala: number, inicio: number) => Promise<unknown>;
}

const cargas: Carga[] = [
  {
    nome: 'createMany em lotes de 500',
    rodar: async (escala, inicio) => {
      const total = Math.ceil(LINHAS * escala);
      for (let i = 0; i < total; i += 500) await db.addressPoint.createMany({ data: enderecos(Math.min(500, total - i), inicio + i) });
    },
  },
  {
    nome: 'createMany em lotes de 2000 numa transação (base do CNEFE no território)',
    rodar: async (escala, inicio) => {
      const total = Math.ceil(LINHAS * escala);
      await db.$transaction(
        async (tx) => {
          for (let i = 0; i < total; i += 2000)
            await tx.addressPoint.createMany({ data: enderecos(Math.min(2000, total - i), inicio + i), skipDuplicates: true });
        },
        { timeout: 120_000 },
      );
    },
  },
  {
    nome: 'prévia do CNES: a planilha inteira num campo JSON, gravada e lida de volta',
    rodar: async (escala) => {
      const rows = profissionais(Math.ceil(LINHAS * escala));
      const imp = await db.cnesImport.create({
        data: { kind: 'PROFISSIONAIS', source: 'planilha', summary: { linhas: rows.length }, payload: { rows }, actorId: randomUUID() },
      });
      const lida = await db.cnesImport.findUniqueOrThrow({ where: { id: imp.id } });
      if ((lida.payload as { rows: unknown[] }).rows.length !== rows.length) throw new Error('payload incompleto');
    },
  },
  {
    nome: 'findMany e updateMany com 30 mil chaves em "in" (10 vezes)',
    rodar: async (escala) => {
      const ids = Array.from({ length: Math.ceil(LINHAS * escala) }, () => randomUUID());
      for (let i = 0; i < 10; i++) {
        await db.addressPoint.findMany({ where: { id: { in: ids } }, select: { id: true } });
        await db.addressPoint.updateMany({ where: { id: { in: ids } }, data: { complement: `rodada ${i}` } });
      }
    },
  },
  {
    nome: 'INSERT em SQL com um parâmetro JSON, lotes de 250',
    rodar: async (escala, inicio) => {
      const total = Math.ceil(LINHAS * escala);
      for (let i = 0; i < total; i += 250) await inserirPorSql(db, enderecos(Math.min(250, total - i), inicio + i));
    },
  },
];

async function main() {
  // Aquecimento: compilador WASM, pool e cache de planos com o formato de cada carga.
  for (const [n, carga] of cargas.entries()) await carga.rodar(0.0001, 50_000_000 + n * 1000);
  const base = await heapUsado();
  const resultado = [];
  for (const [n, carga] of cargas.entries()) {
    const inicio = Date.now();
    await carga.rodar(1, n * 1_000_000);
    const ms = Date.now() - inicio;
    resultado.push({ nome: carga.nome, linhas: LINHAS, ms, retidoMB: Math.round(((await heapUsado()) - base) / 104857.6) / 10 });
  }
  await db.$disconnect();
  console.log(JSON.stringify({ baseMB: Math.round(base / 104857.6) / 10, cargas: resultado }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
