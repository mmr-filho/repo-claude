import type { TenantPrisma } from '@omnisaude/database';
import {
  agravoSinanDaChave,
  infoAgravoSinan,
  LNNC_NACIONAL,
  localDateString,
  ROTAS_PADRAO,
  SISTEMA_DO_ARQUIVO,
  SISTEMA_INFO,
  type ArquivoDetectado,
  type SistemaOficial,
  type TipoArquivoOficial,
  type TipoRegistroOficial,
} from '@omnisaude/shared';
import type { Cobertura } from './importacao/leitura';

/**
 * O que cada arquivo de uma importação aplicada cobre (VIG-1c), num lugar só para a conciliação ("só no OmniSaúde") e
 * a base consolidada usarem a mesma regra. Só o arquivo individual cobre. O NINDINET traz todas as notificações
 * individuais do Sinan Net e cobre todos os agravos que vão para lá. Os demais cobrem só o que trazem: o DBF do agravo
 * (AGRAVO_NET) e o CSV do e-SUS Sinan, os agravos que vieram; o DENGON e o CHIKON, a dengue e a chikungunya; o CSV do
 * e-SUS Notifica, a ficha (síndrome gripal = covid; ESAVI...). O período vai até a data do primeiro envio do mesmo
 * arquivo, e o arquivo de um CNES só cobre só esse estabelecimento. Só a importação APLICADA cobre (a SUBSTITUIDA, o
 * mesmo arquivo aplicado de novo com outro período, não cobre nada).
 *
 * A fonte é a cobertura dos ausentes que a aplicação usou e gravou no apply_result (R6-2): só as linhas do sistema do
 * arquivo, arquivo por arquivo, com o período declarado e o fim no primeiro envio. Assim o arquivo cobre na base
 * consolidada e na conciliação exatamente o que cobre nos ausentes: o NINDINET com algumas linhas de dengue (do Sinan
 * Online) não cobre a dengue, e o período dele é o das linhas do Sinan Net. A aplicação gravada sem essa lista (a
 * demonstração, dado antigo) ou com alguma entrada individual sem o tipo do arquivo (gravada antes desta regra) usa o
 * official_imports.files, que conta todas as linhas do arquivo (`arquivosCobertos`).
 */

type Db = TenantPrisma.TransactionClient;

/** Sistema padrão do agravo (o que não tem rota conferida vai para o Sinan Net). */
export const sistemaPadrao = (grupo: string): SistemaOficial => ROTAS_PADRAO.find((r) => r.grupo === grupo)?.sistema ?? 'SINAN_NET';

const dia = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Grupos do catálogo nacional pelo agravo do Sinan (a base, sem a variante, de `agravoSinanDaChave`): a ficha de
 * violência (Y09) recebe a violência interpessoal e também a sexual e a tentativa de suicídio (T74.2, Y05, X60-X84).
 */
const GRUPOS_DO_AGRAVO: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, Set<string>>();
  for (const v of LNNC_NACIONAL)
    for (const c of v.conditions) {
      const base = agravoSinanDaChave(c.group, null).split(':')[0]!;
      (m.get(base) ?? m.set(base, new Set()).get(base)!).add(c.group);
    }
  return new Map([...m].map(([k, s]) => [k, [...s].sort()]));
})();

/**
 * Os grupos do mesmo agravo do Sinan que o grupo (a família de GRUPOS_DO_AGRAVO, com o próprio grupo), em ordem: a
 * violência interpessoal e a sexual e tentativa de suicídio são uma família (a ficha do Y09); os demais grupos, só eles.
 */
export function gruposDoMesmoAgravo(grupo: string): string[] {
  const familia = GRUPOS_DO_AGRAVO.get(agravoSinanDaChave(grupo, null).split(':')[0]!) ?? [];
  return familia.includes(grupo) ? [...familia] : [...familia, grupo].sort();
}

/**
 * O que um arquivo traz, para as regras de cobertura: o arquivo de official_imports.files (`ArquivoDetectado`) ou a
 * entrada da cobertura gravada no apply_result (só as linhas do sistema do arquivo).
 */
export type FonteCobertura = Pick<ArquivoDetectado, 'tipo' | 'sistema' | 'tipoRegistro' | 'agravos' | 'ignorado'> & { grupos?: string[] };

/** Os grupos que os registros do arquivo recebem (o grupo do agravo de cada um, ou a ficha do e-SUS Notifica). */
function gruposDosRegistros(a: FonteCobertura, gruposGravados: readonly string[]): string[] | null {
  if (a.ignorado || !a.sistema || a.tipoRegistro !== 'INDIVIDUAL') return [];
  if (a.tipo === 'NINDINET') return null;
  const grupos = new Set<string>();
  for (const c of a.agravos ?? []) {
    const g = infoAgravoSinan(c)?.grupo;
    if (g) grupos.add(g);
  }
  if (a.tipo === 'DENGON') grupos.add('dengue');
  if (a.tipo === 'CHIKON') grupos.add('chikungunya');
  for (const g of a.grupos ?? []) grupos.add(g);
  if (a.tipo === 'ESUS_NOTIFICA_CSV' && !a.grupos) for (const g of gruposGravados) grupos.add(g);
  return [...grupos].sort();
}

/**
 * Grupos do catálogo que o arquivo cobre na conciliação: os dos registros mais os grupos com o mesmo agravo do Sinan
 * (o DBF do Y09 traz também as fichas de violência sexual e de tentativa de suicídio). null = todos os do sistema (só o
 * NINDINET); [] = nenhum (arquivo ignorado, sem registro individual ou sem agravo conhecido). `gruposGravados`: no
 * e-SUS Notifica sem `grupos` no arquivo (envios anteriores), os grupos dos registros que a importação gravou.
 */
export function gruposDoArquivo(a: FonteCobertura, gruposGravados: readonly string[] = []): string[] | null {
  const grupos = gruposDosRegistros(a, gruposGravados);
  if (grupos === null) return null;
  const todos = new Set<string>();
  for (const g of grupos) for (const x of GRUPOS_DO_AGRAVO.get(agravoSinanDaChave(g, null).split(':')[0]!) ?? [g]) todos.add(x);
  for (const g of grupos) todos.add(g);
  return [...todos].sort();
}

/**
 * O arquivo cobre o grupo na base consolidada: trouxe o agravo, é o DBF do Sinan Online do agravo (DENGON, CHIKON), é
 * o CSV do e-SUS Notifica da ficha ou é o NINDINET de agravo que vai para o Sinan Net. Aqui sem os grupos do mesmo
 * agravo do Sinan: os registros do Y09 sem vínculo ficam no grupo "violencia" (só o ligado a uma notificação da
 * violência sexual ou da tentativa de suicídio conta no grupo dela), e cobrir a violência sexual com eles daria SE
 * zeradas sem os casos.
 */
export function arquivoCobre(a: FonteCobertura, grupo: string, gruposGravados: readonly string[] = []): boolean {
  const grupos = gruposDosRegistros(a, gruposGravados);
  if (grupos !== null) return grupos.includes(grupo);
  return (a.agravos ?? []).some((c) => infoAgravoSinan(c)?.grupo === grupo) || sistemaPadrao(grupo) === 'SINAN_NET';
}

/**
 * CNES único do arquivo (exportação do e-SUS de um estabelecimento só, como a do autocadastro), gravado pela
 * importação em official_imports.files; null nos outros e nos envios anteriores ao campo. Com ele, o arquivo só cobre
 * esse estabelecimento: na conciliação, só a notificação da unidade com esse CNES fica "só no OmniSaúde"; na base
 * consolidada, o arquivo não cobre a SE (os registros dele continuam contando).
 */
export function cnesDoArquivo(a: ArquivoDetectado): string | null {
  const cnes = (a as { cnes?: string | null }).cnes ?? null;
  return typeof cnes === 'string' && cnes.trim() ? cnes.trim() : null;
}

/**
 * Período que o arquivo de uma importação aplicada cobre: o declarado no envio (vale mais) ou o lido no arquivo (menor
 * e maior data de notificação), com o fim limitado à data local (fuso do tenant) do primeiro envio do mesmo arquivo:
 * a exportação não traz o que veio depois dela, e o reenvio do mesmo arquivo (o mesmo SHA-256, para declarar o
 * período) não a deixa mais nova. `primeiroEnvio`: o menor created_at das official_imports com o mesmo sha256, em
 * qualquer situação (`primeirosEnvios`); sem ele, o envio da própria importação. null = não cobre nada (sem período, ou
 * começa depois do envio).
 */
export function periodoCoberto(
  imp: { periodFrom: Date | null; periodTo: Date | null; declaredPeriod: boolean; createdAt: Date },
  a: Pick<ArquivoDetectado, 'periodo'>,
  timeZone: string,
  primeiroEnvio?: Date | null,
): { de: string; ate: string } | null {
  const p = imp.declaredPeriod && imp.periodFrom && imp.periodTo ? { de: dia(imp.periodFrom), ate: dia(imp.periodTo) } : a.periodo;
  if (!p) return null;
  const limite = primeiroEnvio && primeiroEnvio.getTime() < imp.createdAt.getTime() ? primeiroEnvio : imp.createdAt;
  const envio = localDateString(limite, timeZone);
  const ate = p.ate < envio ? p.ate : envio;
  return p.de <= ate ? { de: p.de, ate } : null;
}

/**
 * Primeiro envio de cada arquivo (sha256): o menor created_at entre as official_imports com o mesmo sha256, em
 * qualquer situação (a prévia descartada, a leitura que falhou e a importação substituída também dizem que o arquivo
 * já existia). Para o fim do `periodoCoberto`.
 */
export async function primeirosEnvios(db: TenantPrisma.TransactionClient, shas: readonly string[]): Promise<Map<string, Date>> {
  const unicos = [...new Set(shas)];
  if (!unicos.length) return new Map();
  const linhas = await db.officialImport.groupBy({ by: ['sha256'], where: { sha256: { in: unicos } }, _min: { createdAt: true } });
  return new Map(linhas.flatMap((l) => (l._min.createdAt ? [[l.sha256, l._min.createdAt] as const] : [])));
}

// ───────────── a cobertura gravada pela aplicação ─────────────

const ehTexto = (v: unknown): v is string => typeof v === 'string';
const ehSistema = (v: unknown): v is SistemaOficial => ehTexto(v) && Object.hasOwn(SISTEMA_INFO, v);
const ehTipo = (v: unknown): v is TipoRegistroOficial => v === 'INDIVIDUAL' || v === 'NEGATIVA' || v === 'SURTO';
const ehTipoArquivo = (v: unknown): v is TipoArquivoOficial => ehTexto(v) && Object.hasOwn(SISTEMA_DO_ARQUIVO, v);
const ehListaDeTextos = (v: unknown): v is string[] => Array.isArray(v) && v.every(ehTexto);
const ehData = (v: unknown): v is string => ehTexto(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A entrada da cobertura que não cobre nada (a ficha do e-SUS Notifica sem grupo, de envios antigos). */
export const entradaVazia = (c: Cobertura) => !!c.grupos && !c.grupos.length;

/**
 * A cobertura que uma aplicação gravou no apply_result (`cobertura`), conferida entrada a entrada: a entrada fora do
 * formato fica de fora (não confirma ausência nem cobre nada), e a aplicação gravada sem a cobertura (de antes da
 * regra, a demonstração) não tem nenhuma.
 */
export function coberturaGravada(applyResult: unknown): Cobertura[] {
  const lista = (applyResult as { cobertura?: unknown } | null)?.cobertura;
  if (!Array.isArray(lista)) return [];
  return lista.filter((c): c is Cobertura => {
    const x = c as Record<string, unknown> | null;
    return (
      !!x &&
      ehSistema(x.sistema) &&
      ehTipo(x.tipo) &&
      (x.tipoArquivo === undefined || ehTipoArquivo(x.tipoArquivo)) &&
      ehData(x.de) &&
      ehData(x.ate) &&
      Array.isArray(x.agravos) &&
      x.agravos.every((a) => a === null || ehTexto(a)) &&
      ehListaDeTextos(x.municipios) &&
      typeof x.municipioNulo === 'boolean' &&
      (x.grupos === undefined || ehListaDeTextos(x.grupos)) &&
      (x.cnes === undefined || ehListaDeTextos(x.cnes))
    );
  });
}

/**
 * A cobertura gravada como a base consolidada e a conciliação a leem; null quando a aplicação foi gravada sem ela (a
 * demonstração, dado antigo) ou com alguma entrada individual sem o tipo do arquivo (gravada antes da regra): quem lê
 * usa então o files[].
 */
function coberturaParaLeitura(applyResult: unknown): Cobertura[] | null {
  if (!Array.isArray((applyResult as { cobertura?: unknown } | null)?.cobertura)) return null;
  const entradas = coberturaGravada(applyResult);
  return entradas.some((c) => c.tipo === 'INDIVIDUAL' && !c.tipoArquivo) ? null : entradas;
}

/**
 * Um arquivo de uma importação aplicada como a base consolidada e a conciliação o leem: o que ele traz (`fonte`, para
 * `arquivoCobre` e `gruposDoArquivo`), os CNES do arquivo de um estabelecimento só (a entrada que junta arquivos iguais
 * tem mais de um; vazio = o município inteiro) e o período coberto, já com o declarado no envio e o fim no primeiro
 * envio do arquivo.
 */
export interface ArquivoCoberto {
  /** Nome do envio (official_imports.file_name), para a tela. */
  envio: string;
  fonte: FonteCobertura;
  cnes: string[];
  de: string;
  ate: string;
}

/** Grupos dos registros que cada importação do e-SUS Notifica gravou (para o arquivo sem `grupos`, de envios anteriores). */
async function gruposGravados(db: Db, importacoes: string[]): Promise<Map<string, string[]>> {
  if (!importacoes.length) return new Map();
  const linhas = await db.$queryRaw<{ imp: string; grupos: string[] }[]>`
    SELECT imp, array_agg(DISTINCT g ORDER BY g) AS grupos FROM (
      SELECT first_import_id AS imp, group_key AS g FROM official_records
      WHERE system = 'ESUS_NOTIFICA' AND type = 'INDIVIDUAL' AND group_key IS NOT NULL AND first_import_id = ANY(${importacoes}::uuid[])
      UNION ALL
      SELECT last_import_id AS imp, group_key AS g FROM official_records
      WHERE system = 'ESUS_NOTIFICA' AND type = 'INDIVIDUAL' AND group_key IS NOT NULL AND last_import_id = ANY(${importacoes}::uuid[])
    ) x GROUP BY imp`;
  return new Map(linhas.map((l) => [l.imp, l.grupos]));
}

/**
 * Os arquivos individuais das importações APLICADA (a SUBSTITUIDA não cobre nada), com o que cada um cobre. A fonte é a
 * cobertura dos ausentes gravada no apply_result (a lista que a aplicação usou: só as linhas do sistema do arquivo, o
 * período declarado e o fim no primeiro envio, como na prévia); a aplicação gravada sem ela usa o files[] (agravos e
 * período de todas as linhas, com `periodoCoberto` e `cnesDoArquivo`, e, no e-SUS Notifica sem `grupos`, os grupos
 * dos registros gravados). Nos dois casos o fim passa pelo corte do primeiro envio do arquivo lido agora
 * (`primeirosEnvios`, `periodoCoberto`): a entrada gravada já vem cortada na prévia, e o corte de novo só muda alguma
 * coisa se o primeiro envio do arquivo aparecer mais antigo do que estava na prévia.
 */
export async function arquivosCobertos(db: Db, timeZone: string): Promise<ArquivoCoberto[]> {
  const imps = await db.officialImport.findMany({
    where: { status: 'APLICADA' },
    select: { id: true, fileName: true, sha256: true, periodFrom: true, periodTo: true, declaredPeriod: true, createdAt: true, files: true, applyResult: true },
  });
  const arquivos = (imp: (typeof imps)[number]) => (Array.isArray(imp.files) ? (imp.files as unknown as ArquivoDetectado[]) : []);
  const lidas = imps.map((imp) => ({ imp, gravada: coberturaParaLeitura(imp.applyResult) }));
  const [gravados, primeiros] = await Promise.all([
    gruposGravados(
      db,
      lidas.filter((l) => !l.gravada && arquivos(l.imp).some((a) => a.tipo === 'ESUS_NOTIFICA_CSV' && !a.grupos)).map((l) => l.imp.id),
    ),
    primeirosEnvios(
      db,
      imps.map((i) => i.sha256),
    ),
  ]);
  const out: ArquivoCoberto[] = [];
  for (const { imp, gravada } of lidas) {
    const primeiro = primeiros.get(imp.sha256);
    if (gravada) {
      for (const c of gravada) {
        if (c.tipo !== 'INDIVIDUAL' || !c.tipoArquivo || entradaVazia(c)) continue;
        const p = periodoCoberto({ periodFrom: null, periodTo: null, declaredPeriod: false, createdAt: imp.createdAt }, { periodo: { de: c.de, ate: c.ate } }, timeZone, primeiro);
        if (!p) continue;
        out.push({
          envio: imp.fileName,
          fonte: { tipo: c.tipoArquivo, sistema: c.sistema, tipoRegistro: c.tipo, agravos: c.agravos.filter((x): x is string => !!x), ignorado: false, ...(c.grupos ? { grupos: c.grupos } : {}) },
          cnes: c.cnes ?? [],
          de: p.de,
          ate: p.ate,
        });
      }
      continue;
    }
    for (const a of arquivos(imp)) {
      const p = periodoCoberto(imp, a, timeZone, primeiro);
      if (!p) continue;
      const cnes = cnesDoArquivo(a);
      out.push({ envio: imp.fileName, fonte: a.tipo === 'ESUS_NOTIFICA_CSV' && !a.grupos ? { ...a, grupos: gravados.get(imp.id) ?? [] } : a, cnes: cnes ? [cnes] : [], de: p.de, ate: p.ate });
    }
  }
  return out;
}
