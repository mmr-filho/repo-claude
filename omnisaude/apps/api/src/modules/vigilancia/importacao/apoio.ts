import type { MasterClient, TenantPrisma } from '@omnisaude/database';
import { LNNC_NACIONAL } from '@omnisaude/shared';
import { chaveMunicipio, siglaDaUf } from './normalizar';

/**
 * Dados do tenant que a importação e a conciliação consultam (VIG-1c, frente F2): grupos sigilosos, município do
 * tenant, de-para de CID para grupo e a tabela de municípios por nome que o sistema já tem (endereços dos pacientes).
 */

type Db = TenantPrisma.TransactionClient;

/** Grupos sigilosos: os do catálogo nacional e os marcados como sensíveis no catálogo do tenant. */
export async function gruposSigilosos(db: Db): Promise<Set<string>> {
  const s = new Set(LNNC_NACIONAL.flatMap((v) => v.conditions.filter((c) => c.sensitive).map((c) => c.group)));
  for (const r of await db.notifiableCondition.findMany({ where: { sensitive: true }, select: { groupKey: true }, distinct: ['groupKey'] })) s.add(r.groupKey);
  return s;
}

/** Nome de cada grupo do catálogo nacional (a primeira condição do grupo). */
export const NOME_DO_GRUPO: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const v of LNNC_NACIONAL) for (const c of v.conditions) if (!m.has(c.group) || c.key === c.group) m.set(c.group, c.name);
  return m;
})();

const municipios = new Map<string, { ibge: string; uf: string }>();

/** IBGE (7 dígitos) e UF do tenant, do catálogo mestre (não muda: fica em memória). */
export async function municipioDoTenant(master: MasterClient, tenantId: string): Promise<{ ibge: string; uf: string }> {
  const cache = municipios.get(tenantId);
  if (cache) return cache;
  const t = await master.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { ibgeCode: true, uf: true } });
  const r = { ibge: t.ibgeCode, uf: t.uf };
  municipios.set(tenantId, r);
  return r;
}

/** Grupo pelo CID (prefixo mais longo do de-para homologado do catálogo do tenant). */
export async function grupoDoCidFabrica(db: Db): Promise<(cid: string) => string | null> {
  const mapas = await db.notifiableCodeMap.findMany({ where: { system: 'CID10', status: 'HOMOLOGADO' }, select: { codePrefix: true, groupKey: true } });
  const prefixos = mapas.map((m) => ({ p: m.codePrefix.toUpperCase().replace(/[^A-Z0-9]/g, ''), g: m.groupKey })).sort((a, b) => b.p.length - a.p.length);
  return (cid: string) => {
    const c = cid.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const achado = prefixos.filter((x) => x.p && c.startsWith(x.p));
    // Prefixo mais longo; dois grupos no mesmo prefixo é ambíguo.
    if (!achado.length) return null;
    const maior = achado.filter((x) => x.p.length === achado[0]!.p.length);
    return new Set(maior.map((x) => x.g)).size === 1 ? maior[0]!.g : null;
  };
}

/**
 * Municípios por nome e UF a partir dos endereços dos pacientes (cidade, UF e código IBGE do CEP). Nome com dois
 * códigos fica de fora (ambíguo). É a tabela que o sistema tem; o que não estiver nela fica com o nome e um aviso.
 */
export async function municipiosPorNome(db: Db): Promise<Map<string, string>> {
  const linhas = await db.$queryRaw<{ city: string; uf: string; ibge: string }[]>`
    SELECT DISTINCT city, uf, ibge_code AS ibge FROM patients
    WHERE city IS NOT NULL AND uf IS NOT NULL AND ibge_code ~ '^[0-9]{7}$'`;
  const mapa = new Map<string, string>();
  const ambiguos = new Set<string>();
  for (const l of linhas) {
    const uf = siglaDaUf(l.uf);
    if (!uf) continue;
    const k = chaveMunicipio(l.city, uf);
    if (mapa.has(k) && mapa.get(k) !== l.ibge) ambiguos.add(k);
    else mapa.set(k, l.ibge);
  }
  for (const k of ambiguos) mapa.delete(k);
  return mapa;
}
