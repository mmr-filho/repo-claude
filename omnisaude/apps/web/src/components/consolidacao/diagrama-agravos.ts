import { AGRAVOS_SINAN } from '@omnisaude/shared';

/*
 * Agravos dos seletores do diagrama de controle e da conciliação, sem React (testados em
 * apps/web/test/diagrama-dados.test.ts).
 */

/** Agravo do seletor: o grupo do catálogo e o nome que a tela mostra. */
export interface OpcaoAgravo {
  grupo: string;
  nome: string;
}

/** Linha do catálogo vigente (GET /vigilancia/catalogo/vigente) que o seletor usa. */
export interface CondicaoDoCatalogo {
  key: string;
  groupKey: string;
  name: string;
  context: string;
}

/** Grupo que a API aceita nas consultas (diagrama e conciliação). */
const GRUPO_VALIDO = /^[a-z0-9-]{2,40}$/;

/** Arboviroses primeiro: são os agravos do plano de contingência. */
const PRIMEIROS = ['dengue', 'chikungunya', 'zika'];

/** Grupos com mais de uma linha na tabela do Sinan: o nome do grupo inteiro. */
const NOME_DO_GRUPO_SINAN: Record<string, string> = {
  sifilis: 'Sífilis',
  tetano: 'Tétano',
  'toxoplasmose-gestacional-congenita': 'Toxoplasmose gestacional e congênita',
};

function ordenar(opcoes: OpcaoAgravo[]): OpcaoAgravo[] {
  const primeiro = (g: string) => {
    const i = PRIMEIROS.indexOf(g);
    return i < 0 ? PRIMEIROS.length : i;
  };
  return opcoes.filter((o) => GRUPO_VALIDO.test(o.grupo)).sort((a, b) => primeiro(a.grupo) - primeiro(b.grupo) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

/**
 * Agravos do seletor. Com o catálogo vigente do tenant, um por grupo, com o nome que a API dá ao diagrama (a linha
 * do próprio grupo, senão a de casos, sem o " - Casos"). Sem acesso ao catálogo (o gestor só tem o resumo), os grupos
 * da tabela de agravos do Sinan. Dengue, chikungunya e zika primeiro; os demais em ordem alfabética.
 */
export function opcoesDeAgravo(condicoes?: CondicaoDoCatalogo[] | null): OpcaoAgravo[] {
  if (condicoes?.length) {
    const porGrupo = new Map<string, CondicaoDoCatalogo[]>();
    for (const c of condicoes) porGrupo.set(c.groupKey, [...(porGrupo.get(c.groupKey) ?? []), c]);
    return ordenar(
      [...porGrupo].map(([grupo, linhas]) => {
        const l = linhas.find((x) => x.key === grupo) ?? linhas.find((x) => x.context === 'CASO') ?? linhas[0]!;
        return { grupo, nome: l.name.replace(/\s+-\s+Casos$/i, '') };
      }),
    );
  }
  const vistos = new Map<string, string>();
  for (const info of Object.values(AGRAVOS_SINAN)) if (info.grupo && !vistos.has(info.grupo)) vistos.set(info.grupo, NOME_DO_GRUPO_SINAN[info.grupo] ?? info.nome);
  return ordenar([...vistos].map(([grupo, nome]) => ({ grupo, nome })));
}

/** Nome do agravo para a tela; o grupo quando não está na lista. */
export const nomeDoAgravo = (opcoes: OpcaoAgravo[], grupo: string | null | undefined) => (grupo ? (opcoes.find((o) => o.grupo === grupo)?.nome ?? grupo) : '—');
