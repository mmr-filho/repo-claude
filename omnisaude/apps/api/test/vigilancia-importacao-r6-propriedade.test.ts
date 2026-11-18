import type { TenantPrisma } from '@omnisaude/database';
import type { AmostraRegistro, DetalheImportacao, ResultadoAplicacao } from '@omnisaude/shared';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { ImportacaoService } from '../src/modules/vigilancia/importacao.service';
import { chaveDoEnvio, type Cobertura, type LeituraEnvio } from '../src/modules/vigilancia/importacao/leitura';
import { Ritmo } from '../src/modules/vigilancia/importacao/ritmo';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Importação (VIG-1c), sexta rodada, R6-1: a prévia conta os ausentes como a aplicação marca, em qualquer arranjo. A
 * deduplicação da prévia (a entrada exclui o que as anteriores que se cruzam com ela já contaram) é um NOT sobre o
 * filtro da cobertura; o filtro é de dois valores (guarda de não nulo em cada coluna anulável), e o registro sem CNES,
 * sem município, sem agravo ou sem ficha (grupo) não some mais da prévia. Propriedades, com sementes fixas:
 * - no serviço, com registros e coberturas sorteados (as quatro colunas anuláveis com nulo, ausentes marcados pela
 *   importação substituída e por outras aplicações), numa transação desfeita no fim de cada arranjo:
 *   ausentesPrevistos = ausentes que marcarAusentes marca (a contagem e a amostra) e "voltam" da prévia
 *   (voltamDaSubstituicao) = "voltaram" da aplicação (substituirAnteriores);
 * - pela API, com CSV do e-SUS Notifica do município e de unidades (registros sem CNES e sem município), num zip e em
 *   envios separados: em cada envio a prévia bate com a aplicação; os ausentes não dependem de os arquivos irem juntos;
 *   e o reenvio do mesmo arquivo com outro período declarado anuncia na prévia os mesmos "voltam" que a aplicação dá.
 * Dados sintéticos.
 */

const enabled = await pgAvailable();
const X = '9000011';
const Y = '9000028';
const Z = '9000035';
const enc = (s: string) => new TextEncoder().encode(s);

type Db = TenantPrisma.TransactionClient;

/** Os métodos do serviço que a prévia e a aplicação usam para os ausentes (privados: o teste os chama direto). */
interface Ausentes {
  ausentesPrevistos(db: Db, cobertura: Cobertura[], leitura: LeituraEnvio, ritmo: Ritmo): Promise<{ total: number; amostra: AmostraRegistro[] }>;
  aplicadasComCobertura(db: Db, opts: { exceto: string[]; shaExceto?: string }): Promise<{ id: string; aplicadaEm: Date; cobertura: Cobertura[] }[]>;
  voltamDaSubstituicao(db: Db, anterior: string, cobertura: Cobertura[], outras: { id: string; aplicadaEm: Date; cobertura: Cobertura[] }[], leitura: LeituraEnvio, ritmo: Ritmo): Promise<number>;
  substituirAnteriores(
    tx: Db,
    anteriores: { id: string; createdAt: Date; appliedAt: Date | null; periodFrom: Date | null; periodTo: Date | null; declaredPeriod: boolean; ausentes: number }[],
    cobertura: Cobertura[],
    id: string,
    agora: Date,
  ): Promise<{ substituidas: { voltaram: number }[] }>;
  marcarAusentes(tx: Db, cobertura: Cobertura[], id: string, agora: Date): Promise<number>;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Desfaz a transação do arranjo levando o resultado. */
class Desfazer<T> extends Error {
  constructor(readonly resultado: T) {
    super('desfazer');
  }
}

describe.runIf(enabled)('importação, sexta rodada (R6-1): a prévia bate com a aplicação com CNES, município, agravo e ficha nulos', () => {
  let t: TestApp;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let svc: Ausentes;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  beforeAll(async () => {
    t = await startTestApp('vigimpr6prop');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    svc = t.app.get(ImportacaoService) as unknown as Ausentes;
  }, 180_000);

  afterAll(async () => {
    await ImportacaoService.aguardarTrabalhos();
    await t?.close();
  });

  // ───────────── no serviço: registros e coberturas sorteados ─────────────

  /** Uma semana de 2015 (o dia 1 a 7 do arranjo é o dia da semana): fora de qualquer dado da demonstração. */
  const dia = (d: number) => `2015-03-0${1 + d}`;
  const SISTEMAS = ['ESUS_NOTIFICA', 'SINAN_NET'] as const;
  const TIPOS = ['INDIVIDUAL', 'SURTO'] as const;

  interface RegistroSorteado {
    system: (typeof SISTEMAS)[number];
    type: (typeof TIPOS)[number];
    naturalKey: string;
    dia: number;
    unitCnes: string | null;
    municipalityIbge: string | null;
    agravo: string | null;
    groupKey: string | null;
    /** null = presente; 'ANTERIOR' = ausente pela importação substituída; número = ausente pela outra aplicação k. */
    ausentePor: 'ANTERIOR' | number | null;
    /** Hora (a partir do início do arranjo) em que o registro veio pela última vez: antes ou depois das outras aplicações. */
    vistoEm: number;
    noArquivo: boolean;
  }

  function sortear(semente: number) {
    const r = mulberry32(semente);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const subconjunto = <T>(xs: readonly T[], vazio = false): T[] => {
      const s = xs.filter(() => r() < 0.5);
      return s.length || vazio ? s : [pick(xs)];
    };
    /** Uma entrada da cobertura; `base`: outra da mesma lista, com que esta tende a se cruzar (sistema, tipo, período, agravos). */
    const entrada = (base?: Cobertura): Cobertura => {
      const a = 1 + Math.floor(r() * 7);
      const b = a + Math.floor(r() * (8 - a));
      const mesmoPeriodo = !!base && r() < 0.5;
      return {
        sistema: base && r() < 0.85 ? base.sistema : pick(SISTEMAS),
        tipo: base && r() < 0.9 ? base.tipo : r() < 0.9 ? 'INDIVIDUAL' : 'SURTO',
        tipoArquivo: 'NINDINET',
        agravos: base && r() < 0.4 ? [...new Set([null, ...base.agravos])] : subconjunto(['A279', 'A90', null]),
        ...(r() < 0.4 ? { grupos: subconjunto(['covid', 'esavi', 'leptospirose'], r() < 0.1) } : {}),
        ...(r() < 0.5 ? { cnes: subconjunto([X, Y, Z]) } : {}),
        de: mesmoPeriodo ? base.de : dia(a),
        ate: mesmoPeriodo ? base.ate : dia(b),
        municipios: r() < 0.7 ? ['355030'] : ['355030', '330455'],
        municipioNulo: r() < 0.5,
      };
    };
    const lista = (n: number) => {
      const out: Cobertura[] = [];
      for (let i = 0; i < n; i++) out.push(entrada(out.length && r() < 0.6 ? pick(out) : undefined));
      return out;
    };
    const cobertura = lista(1 + Math.floor(r() * 5));
    const outras = Array.from({ length: Math.floor(r() * 3) }, () => ({ cobertura: r() < 0.85 ? lista(1 + Math.floor(r() * 4)) : null, aplicadaEm: Math.floor(r() * 48) }));
    const n = 25 + Math.floor(r() * 60);
    const registros: RegistroSorteado[] = Array.from({ length: n }, (_, i) => {
      const u = r();
      return {
        system: pick(SISTEMAS),
        type: r() < 0.9 ? 'INDIVIDUAL' : 'SURTO',
        naturalKey: `r6p-${semente}-${i}`,
        dia: 1 + Math.floor(r() * 7),
        unitCnes: r() < 0.3 ? null : pick([X, Y, Z]),
        municipalityIbge: r() < 0.25 ? null : pick(['3550308', '3304557']),
        agravo: r() < 0.3 ? null : pick(['A279', 'A90']),
        groupKey: r() < 0.3 ? null : pick(['covid', 'esavi', 'leptospirose']),
        ausentePor: u < 0.6 ? null : u < 0.85 || !outras.length ? 'ANTERIOR' : Math.floor(r() * outras.length),
        vistoEm: Math.floor(r() * 96) - 48,
        noArquivo: r() < 0.35,
      };
    });
    return { cobertura, outras, registros };
  }

  /** Grava o arranjo, roda a prévia e a aplicação dos ausentes na mesma transação e a desfaz no fim. */
  async function rodar(semente: number) {
    const arr = sortear(semente);
    try {
      await db.$transaction(
        async (tx) => {
          const inicio = Date.UTC(2015, 2, 10);
          const hora = (h: number) => new Date(inicio + h * 3_600_000);
          const criado = '00000000-0000-4000-8000-000000000001';
          const sha = (c: string) => c.repeat(64);
          const importacao = (dados: Partial<TenantPrisma.OfficialImportUncheckedCreateInput> & { sha256: string }) =>
            tx.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'r6.csv', sizeBytes: 1, createdBy: criado, ...dados }, select: { id: true, createdAt: true, appliedAt: true } });
          const base = await importacao({ sha256: sha('b'), appliedAt: hora(-100) });
          const anterior = await importacao({ sha256: sha('a'), appliedAt: hora(-50), createdAt: hora(-51) });
          const outras: { id: string }[] = [];
          for (const [k, o] of arr.outras.entries()) outras.push(await importacao({ sha256: sha(String(k)), appliedAt: hora(o.aplicadaEm), applyResult: (o.cobertura ? { cobertura: o.cobertura } : {}) as object }));
          const nova = await importacao({ sha256: sha('a'), status: 'PREVIA', appliedAt: null });
          await tx.officialRecord.createMany({
            data: arr.registros.map((x, i) => ({
              system: x.system,
              type: x.type,
              naturalKey: x.naturalKey,
              number: String(i),
              notifiedOn: new Date(`${dia(x.dia)}T00:00:00Z`),
              unitCnes: x.unitCnes,
              municipalityIbge: x.municipalityIbge,
              agravo: x.agravo,
              groupKey: x.groupKey,
              situation: 'EM_INVESTIGACAO',
              contentHash: '0'.repeat(64),
              firstImportId: base.id,
              lastImportId: base.id,
              lastSeenAt: hora(x.vistoEm),
              ...(x.ausentePor === null ? {} : { absentSince: hora(-40), absentImportId: x.ausentePor === 'ANTERIOR' ? anterior.id : outras[x.ausentePor]!.id }),
            })),
          });
          const chaves = new Set(arr.registros.filter((x) => x.noArquivo).map((x) => chaveDoEnvio(x.system, x.type, x.naturalKey)));
          const leitura = { tem: (k: string) => chaves.has(k) } as unknown as LeituraEnvio;
          const ritmo = new Ritmo();

          // Prévia (como em processar): os ausentes previstos e o "voltam" da importação do mesmo arquivo.
          const previstos = await svc.ausentesPrevistos(tx, arr.cobertura, leitura, ritmo);
          const voltam = await svc.voltamDaSubstituicao(tx, anterior.id, arr.cobertura, await svc.aplicadasComCobertura(tx, { exceto: [], shaExceto: sha('a') }), leitura, ritmo);

          // Aplicação (como em aplicar): conta os ausentes da substituída, grava os registros do arquivo (presentes, desta
          // importação), substitui e marca.
          const agora = hora(200);
          const ausentesDaAnterior = await tx.officialRecord.count({ where: { absentImportId: anterior.id } });
          await tx.officialRecord.updateMany({
            where: { naturalKey: { in: arr.registros.filter((x) => x.noArquivo).map((x) => x.naturalKey) } },
            data: { lastImportId: nova.id, lastSeenAt: agora, absentSince: null, absentImportId: null },
          });
          const { substituidas } = await svc.substituirAnteriores(
            tx,
            [{ id: anterior.id, createdAt: anterior.createdAt, appliedAt: anterior.appliedAt, periodFrom: null, periodTo: null, declaredPeriod: false, ausentes: ausentesDaAnterior }],
            arr.cobertura,
            nova.id,
            agora,
          );
          const marcados = await svc.marcarAusentes(tx, arr.cobertura, nova.id, agora);
          const marcadosAgora = (await tx.officialRecord.findMany({ where: { absentImportId: nova.id, absentSince: agora }, select: { naturalKey: true } })).map((x) => x.naturalKey).sort();
          throw new Desfazer({
            previa: { ausentes: previstos.total, amostra: previstos.amostra.map((a) => a.chave).sort(), voltam },
            aplicacao: { ausentes: marcados, amostra: marcadosAgora, voltam: substituidas[0]!.voltaram },
          });
        },
        { timeout: 60_000 },
      );
    } catch (e) {
      if (e instanceof Desfazer) return { arr, ...(e.resultado as { previa: Record<string, unknown>; aplicacao: Record<string, unknown> }) };
      throw e;
    }
    throw new Error('a transação do arranjo não foi desfeita');
  }

  it('no serviço, em 150 arranjos sorteados: ausentesPrevistos (contagem e amostra) = ausentes marcados, e "voltam" da prévia = "voltaram" da aplicação', async () => {
    const violacoes: string[] = [];
    // Quantos arranjos têm, fora do arquivo, registro com cada coluna nula (o sorteio exercita os nulos).
    const nulos = { cnes: 0, municipio: 0, agravo: 0, grupo: 0 };
    let comAusente = 0;
    let comVolta = 0;
    for (let semente = 1; semente <= Number(process.env.R6IMP_ARRANJOS ?? 150); semente++) {
      const r = await rodar(semente);
      if (JSON.stringify(r.previa) !== JSON.stringify(r.aplicacao)) violacoes.push(`semente ${semente}: prévia ${JSON.stringify(r.previa)} × aplicação ${JSON.stringify(r.aplicacao)}`);
      const fora = r.arr.registros.filter((x) => !x.noArquivo);
      if (fora.some((x) => x.unitCnes === null)) nulos.cnes++;
      if (fora.some((x) => x.municipalityIbge === null)) nulos.municipio++;
      if (fora.some((x) => x.agravo === null)) nulos.agravo++;
      if (fora.some((x) => x.groupKey === null)) nulos.grupo++;
      if ((r.aplicacao.ausentes as number) > 0) comAusente++;
      if ((r.aplicacao.voltam as number) > 0) comVolta++;
    }
    console.log(`[r6imp-prop-servico] ${violacoes.length} violação(ões); arranjos com ausente marcado ${comAusente}, com volta ${comVolta}; com nulo fora do arquivo ${JSON.stringify(nulos)}\n${violacoes.join('\n')}`);
    expect(violacoes).toEqual([]);
    // O sorteio exercita o que a propriedade promete: ausentes, voltas e as quatro colunas nulas.
    expect(comAusente).toBeGreaterThan(30);
    expect(comVolta).toBeGreaterThan(30);
    expect(Math.min(nulos.cnes, nulos.municipio, nulos.agravo, nulos.grupo)).toBeGreaterThan(30);
  }, 300_000);

  it('no serviço, o registro sem CNES, sem município, sem agravo ou sem ficha dentro de uma entrada e fora da anterior que se cruza com ela conta na prévia', async () => {
    // Duas entradas do mesmo sistema e período que se cruzam: a primeira com CNES, agravo e ficha conhecidos e sem o
    // município nulo; a segunda aceita os nulos. Cada registro tem uma coluna nula e não veio: só a segunda o cobre.
    const primeira: Cobertura = {
      sistema: 'SINAN_NET',
      tipo: 'INDIVIDUAL',
      tipoArquivo: 'NINDINET',
      agravos: ['A279'],
      grupos: ['leptospirose'],
      cnes: [X],
      de: dia(1),
      ate: dia(7),
      municipios: ['355030'],
      municipioNulo: false,
    };
    const segunda: Cobertura = { sistema: 'SINAN_NET', tipo: 'INDIVIDUAL', tipoArquivo: 'NINDINET', agravos: [null, 'A279'], de: dia(1), ate: dia(7), municipios: ['355030'], municipioNulo: true };
    const resultado = await db
      .$transaction(async (tx) => {
        const importacao = (status: 'APLICADA' | 'PREVIA', sha256: string) =>
          tx.officialImport.create({ data: { system: 'SINAN_NET', status, fileName: 'r6.dbf', sha256, sizeBytes: 1, createdBy: '00000000-0000-4000-8000-000000000001' }, select: { id: true } });
        const anterior = await importacao('APLICADA', 'b'.repeat(64));
        const imp = await importacao('PREVIA', 'c'.repeat(64));
        const base = {
          system: 'SINAN_NET' as const,
          type: 'INDIVIDUAL' as const,
          notifiedOn: new Date(`${dia(3)}T00:00:00Z`),
          situation: 'EM_INVESTIGACAO',
          contentHash: '0'.repeat(64),
          firstImportId: anterior.id,
          lastImportId: anterior.id,
          lastSeenAt: new Date(Date.UTC(2015, 2, 1)),
        };
        const comum = { unitCnes: X, municipalityIbge: '3550308', agravo: 'A279', groupKey: 'leptospirose' };
        await tx.officialRecord.createMany({
          data: [
            { ...base, ...comum, naturalKey: 'r6-sem-cnes', number: '1', unitCnes: null },
            { ...base, ...comum, naturalKey: 'r6-sem-municipio', number: '2', municipalityIbge: null },
            { ...base, ...comum, naturalKey: 'r6-sem-agravo', number: '3', agravo: null },
            { ...base, ...comum, naturalKey: 'r6-sem-ficha', number: '4', groupKey: null },
          ],
        });
        const leitura = { tem: () => false } as unknown as LeituraEnvio;
        const previstos = await svc.ausentesPrevistos(tx, [primeira, segunda], leitura, new Ritmo());
        const segundaSo = await svc.ausentesPrevistos(tx, [segunda], leitura, new Ritmo());
        const marcados = await svc.marcarAusentes(tx, [primeira, segunda], imp.id, new Date());
        throw new Desfazer({ previa: previstos.amostra.map((a) => a.chave).sort(), soSegunda: segundaSo.amostra.map((a) => a.chave).sort(), marcados });
      })
      .catch((e: unknown) => {
        if (e instanceof Desfazer) return e.resultado as { previa: string[]; soSegunda: string[]; marcados: number };
        throw e;
      });
    expect(resultado).toEqual({ previa: ['r6-sem-agravo', 'r6-sem-cnes', 'r6-sem-ficha', 'r6-sem-municipio'], soSegunda: ['r6-sem-agravo', 'r6-sem-cnes', 'r6-sem-ficha', 'r6-sem-municipio'], marcados: 4 });
  });

  // ───────────── pela API: CSV do e-SUS Notifica, zip × separados e reenvio com outro período ─────────────

  interface Rec {
    i: number;
    cnes: string;
    mun: string;
    dia: number;
    vivo: boolean;
  }
  interface Arq {
    nome: string;
    recs: number[];
  }

  /**
   * Arranjo do e-SUS Notifica (como o da verificação da quinta rodada), com o período do reenvio. Pelo menos um CSV do
   * município, e o da unidade tende a vir antes dele no zip (os arquivos vão em ordem de nome): é a entrada de um CNES só
   * antes da do município que tirava da prévia o registro sem CNES.
   */
  function gerar(semente: number) {
    const r = mulberry32(semente);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const faixaSorteada = (): [number, number] => {
      const a = 1 + Math.floor(r() * 7);
      return [a, a + Math.floor(r() * (8 - a))];
    };
    const n = 6 + Math.floor(r() * 9);
    const recs: Rec[] = Array.from({ length: n }, (_, i) => {
      const u = r();
      return { i, cnes: u < 0.2 ? X : u < 0.4 ? Y : u < 0.6 ? Z : '', mun: r() < 0.2 ? '' : '3550308', dia: 1 + Math.floor(r() * 7), vivo: r() < 0.55 };
    });
    const declarado = r() < 0.5 ? faixaSorteada() : null;
    const faixa = () => declarado ?? faixaSorteada();
    const arquivos: Arq[] = [];
    const vistos = new Set<string>();
    const nMun = 1 + Math.floor(r() * 2);
    const unidades = [X, Y, Z].filter(() => r() < 0.6);
    for (let k = 0; k < nMun; k++) {
      const [a, b] = faixa();
      const linhas = recs.filter((x) => x.vivo && x.dia >= a && x.dia <= b).map((x) => x.i);
      if (!linhas.length || vistos.has(linhas.join(','))) continue;
      vistos.add(linhas.join(','));
      arquivos.push({ nome: `${pick(['a', 'm', 'z'])}-mun-${k}.csv`, recs: linhas });
    }
    for (const c of unidades) {
      const [a, b] = faixa();
      const linhas = recs.filter((x) => x.vivo && x.cnes === c && x.dia >= a && x.dia <= b).map((x) => x.i);
      if (!linhas.length || vistos.has(linhas.join(','))) continue;
      vistos.add(linhas.join(','));
      arquivos.push({ nome: `${r() < 0.7 ? 'a' : pick(['m', 'z'])}-ubs-${c}.csv`, recs: linhas });
    }
    if (!arquivos.length) return null;
    arquivos.sort((x, y) => x.nome.localeCompare(y.nome));
    // O reenvio declara outro período (o mesmo arquivo com o mesmo período declarado não é aplicado de novo).
    let reenvio = faixaSorteada();
    while (declarado && reenvio[0] === declarado[0] && reenvio[1] === declarado[1]) reenvio = faixaSorteada();
    return { recs, arquivos, declarado, reenvio };
  }

  const previa = async (bytes: Uint8Array, nome: string, q: Record<string, string> = {}) => {
    const r = await t
      .http()
      .post('/api/vigilancia/importacoes')
      .query({ nome, ...q })
      .set(auth(vig))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(bytes));
    if (r.status !== 201) throw new Error(`prévia ${nome}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as DetalheImportacao;
  };
  const aplicar = async (id: string) => {
    const r = await t.http().post(`/api/vigilancia/importacoes/${id}/aplicar`).set(auth(vig));
    if (r.status !== 200) throw new Error(`aplicar ${id}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as ResultadoAplicacao;
  };
  /** O "voltam" que a prévia anuncia no aviso da substituição (0 quando o aviso não traz o número). */
  const voltamDoAviso = (p: DetalheImportacao) => {
    const aviso = p.avisos.find((a) => a.startsWith('Este envio substitui'));
    if (!aviso) return null;
    return Number(/, e ([\d.]+) registro\(s\) que ela deu como ausentes voltam\.$/.exec(aviso)?.[1]?.replace(/\./g, '') ?? 0);
  };

  it('pela API, em 40 arranjos do e-SUS Notifica com registros sem CNES e sem município: a prévia bate com a aplicação em cada envio e no reenvio com outro período', async () => {
    const violacoes: string[] = [];
    let rodados = 0;
    let bloco = 0;
    let comVolta = 0;
    for (let semente = 1; rodados < Number(process.env.R6IMP_ARRANJOS_API ?? 40) && semente < 2000; semente++) {
      const arr = gerar(semente);
      if (!arr) continue;
      rodados++;
      const resultado: Record<'Z' | 'S', number[]> = { Z: [], S: [] };
      for (const modo of ['Z', 'S'] as const) {
        // Uma semana por cenário (de 04/01/2021 em diante: o e-SUS Notifica começa em 2020), um prefixo de número por cenário.
        const inicio = Date.UTC(2021, 0, 4) + 7 * 86_400_000 * bloco++;
        const iso = (d: number) => new Date(inicio + (d - 1) * 86_400_000).toISOString().slice(0, 10);
        const data = (d: number) => iso(d).split('-').reverse().join('/');
        const prefixo = `8${String(semente).padStart(3, '0')}${modo === 'Z' ? 1 : 2}`;
        const num = (i: number) => `${prefixo}${String(i).padStart(4, '0')}`;
        // A base leva uma coluna a mais (não lida): o SHA-256 dela nunca é o de um arquivo do arranjo.
        const csv = (idx: number[], base = false) =>
          enc(
            `${['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Sintoma- Febre', 'Classificação Final', ...(base ? ['Origem'] : [])].join(';')}\r\n${idx
              .map((i) => arr.recs[i]!)
              .map((x) => [num(x.i), data(x.dia), x.mun, x.cnes, `Pessoa ${num(x.i)}`, 'Sim', 'Confirmado Laboratorial', ...(base ? ['base'] : [])].join(';'))
              .join('\r\n')}\r\n`,
          );
        const periodo = (f: [number, number] | null): Record<string, string> => (f ? { de: iso(f[0]), ate: iso(f[1]) } : {});
        await aplicar(
          (
            await previa(
              csv(
                arr.recs.map((x) => x.i),
                true,
              ),
              `base-${prefixo}.csv`,
            )
          ).id,
        );
        const envios =
          modo === 'Z'
            ? [{ nome: `arranjo-${prefixo}.zip`, bytes: zipSync(Object.fromEntries(arr.arquivos.map((a) => [a.nome, csv(a.recs)]))) }]
            : arr.arquivos.map((a) => ({ nome: a.nome.replace('.csv', `-${prefixo}.csv`), bytes: csv(a.recs) }));
        // Cada envio, e depois o reenvio de cada um com outro período declarado (substitui a aplicação anterior dele).
        for (const [rodada, q] of [periodo(arr.declarado), periodo(arr.reenvio)].entries()) {
          for (const e of envios) {
            const p = await previa(e.bytes, e.nome, q);
            const antesDeAplicar = new Date();
            const r = await aplicar(p.id);
            // Os marcados agora (absent_since da aplicação). Na substituição, os ausentes da substituída que esta cobertura
            // marca de novo também ficam com absent_import_id = esta, mas com o absent_since de quando sumiram.
            const marcados = (await db.officialRecord.findMany({ where: { absentImportId: p.id, absentSince: { gte: antesDeAplicar } }, select: { number: true } })).map((x) => x.number).sort();
            const amostra = (p.previa?.ausentes ?? []).map((a) => a.numero).sort();
            const voltam = voltamDoAviso(p);
            const voltaram = r.substituidas?.[0]?.voltaram ?? null;
            if (voltaram) comVolta++;
            if (p.contagens?.ausentesPrevistos !== r.ausentesMarcados || JSON.stringify(amostra) !== JSON.stringify(marcados) || voltam !== voltaram)
              violacoes.push(
                `semente ${semente} ${modo} ${rodada ? 'reenvio' : 'envio'} ${e.nome}: prévia ${p.contagens?.ausentesPrevistos} ${JSON.stringify(amostra)} voltam ${voltam} × aplicação ${r.ausentesMarcados} ${JSON.stringify(marcados)} voltaram ${voltaram}`,
              );
          }
          // Os ausentes depois dos envios (antes dos reenvios): os mesmos num zip ou em envios separados (R5-1).
          if (rodada === 0)
            resultado[modo] = (await db.officialRecord.findMany({ where: { absentSince: { not: null }, number: { startsWith: prefixo } }, select: { number: true } }))
              .map((x) => Number(x.number.slice(prefixo.length)))
              .sort((a, b) => a - b);
        }
      }
      if (JSON.stringify(resultado.Z) !== JSON.stringify(resultado.S)) violacoes.push(`semente ${semente}: ausentes no zip ${JSON.stringify(resultado.Z)} × separados ${JSON.stringify(resultado.S)}`);
    }
    console.log(`[r6imp-prop-api] ${rodados} arranjos (${comVolta} reenvios com volta); ${violacoes.length} violação(ões):\n${violacoes.join('\n')}`);
    expect(violacoes).toEqual([]);
    expect(comVolta).toBeGreaterThan(5);
  }, 600_000);
});
