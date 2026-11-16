import { infoAgravoSinan, ROTAS_PADRAO, type ArquivoDetectado, type SistemaOficial } from '@omnisaude/shared';

/**
 * O que cada arquivo de uma importação aplicada cobre (VIG-1c): a regra do `arquivoCobre` do consolidado, num módulo
 * próprio para a conciliação usar a mesma (e o consolidado poder vir para cá). Só o arquivo individual cobre. O
 * NINDINET traz todas as notificações individuais do Sinan Net e cobre todos os agravos que vão para lá. Os demais
 * cobrem só o que trazem: o DBF do agravo (AGRAVO_NET) e o CSV do e-SUS Sinan, os agravos que vieram; o DENGON e o
 * CHIKON, a dengue e a chikungunya; o CSV do e-SUS Notifica, a ficha (síndrome gripal = covid; ESAVI...).
 */

/** Sistema padrão do agravo (o que não tem rota conferida vai para o Sinan Net). */
export const sistemaPadrao = (grupo: string): SistemaOficial => ROTAS_PADRAO.find((r) => r.grupo === grupo)?.sistema ?? 'SINAN_NET';

/**
 * Grupos do catálogo que o arquivo cobre. null = todos os do sistema (só o NINDINET); [] = nenhum (arquivo ignorado,
 * sem registro individual ou sem agravo conhecido). `gruposGravados`: no e-SUS Notifica sem `grupos` no arquivo
 * (envios anteriores), os grupos dos registros que a importação gravou.
 */
export function gruposDoArquivo(a: ArquivoDetectado, gruposGravados: readonly string[] = []): string[] | null {
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
 * O arquivo cobre o grupo: trouxe o agravo, é o DBF do Sinan Online do agravo (DENGON, CHIKON), é o CSV do e-SUS
 * Notifica da ficha ou é o NINDINET de agravo que vai para o Sinan Net.
 */
export function arquivoCobre(a: ArquivoDetectado, grupo: string, gruposGravados?: readonly string[]): boolean {
  const grupos = gruposDoArquivo(a, gruposGravados);
  if (grupos !== null) return grupos.includes(grupo);
  return (a.agravos ?? []).some((c) => infoAgravoSinan(c)?.grupo === grupo) || sistemaPadrao(grupo) === 'SINAN_NET';
}
