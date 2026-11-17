import { agravoSinanDaChave, infoAgravoSinan, LNNC_NACIONAL, localDateString, ROTAS_PADRAO, type ArquivoDetectado, type SistemaOficial } from '@omnisaude/shared';

/**
 * O que cada arquivo de uma importação aplicada cobre (VIG-1c), num lugar só para a conciliação ("só no OmniSaúde") e
 * a base consolidada usarem a mesma regra. Só o arquivo individual cobre. O NINDINET traz todas as notificações
 * individuais do Sinan Net e cobre todos os agravos que vão para lá. Os demais cobrem só o que trazem: o DBF do agravo
 * (AGRAVO_NET) e o CSV do e-SUS Sinan, os agravos que vieram; o DENGON e o CHIKON, a dengue e a chikungunya; o CSV do
 * e-SUS Notifica, a ficha (síndrome gripal = covid; ESAVI...). O período vai até a data do envio, e o arquivo de um
 * CNES só cobre só esse estabelecimento.
 */

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

/** Os grupos que os registros do arquivo recebem (o grupo do agravo de cada um, ou a ficha do e-SUS Notifica). */
function gruposDosRegistros(a: ArquivoDetectado, gruposGravados: readonly string[]): string[] | null {
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
export function gruposDoArquivo(a: ArquivoDetectado, gruposGravados: readonly string[] = []): string[] | null {
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
 * agravo do Sinan: os registros do Y09 ficam todos no grupo "violencia", e cobrir a violência sexual com eles daria SE
 * zeradas sem os casos.
 */
export function arquivoCobre(a: ArquivoDetectado, grupo: string, gruposGravados: readonly string[] = []): boolean {
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
 * e maior data de notificação), com o fim limitado à data local do envio (official_imports.created_at, no fuso do
 * tenant): a exportação não traz o que veio depois dela. null = não cobre nada (sem período, ou começa depois do envio).
 */
export function periodoCoberto(
  imp: { periodFrom: Date | null; periodTo: Date | null; declaredPeriod: boolean; createdAt: Date },
  a: Pick<ArquivoDetectado, 'periodo'>,
  timeZone: string,
): { de: string; ate: string } | null {
  const p = imp.declaredPeriod && imp.periodFrom && imp.periodTo ? { de: dia(imp.periodFrom), ate: dia(imp.periodTo) } : a.periodo;
  if (!p) return null;
  const envio = localDateString(imp.createdAt, timeZone);
  const ate = p.ate < envio ? p.ate : envio;
  return p.de <= ate ? { de: p.de, ate } : null;
}
