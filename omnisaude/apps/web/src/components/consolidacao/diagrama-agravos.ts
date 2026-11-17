import { AGRAVOS_SINAN, GRUPOS_SIGILOSOS_DIAGRAMA, type Permission, type Role } from '@omnisaude/shared';

/*
 * Agravos dos seletores do diagrama de controle e da conciliação, sem React (testados em
 * apps/web/test/diagrama-dados.test.ts).
 */

/** Agravo do seletor: o grupo do catálogo e o nome que a tela mostra. */
export interface OpcaoAgravo {
  grupo: string;
  nome: string;
  /**
   * Agravo sigiloso no diagrama (HIV, aids, sífilis, violências, tuberculose, hanseníase e hepatites; Lei 14.289/2022):
   * só aparece no seletor de quem pode vê-lo.
   */
  sigiloso?: true;
}

/** Linha do catálogo vigente (GET /vigilancia/catalogo/vigente) que o seletor usa. */
export interface CondicaoDoCatalogo {
  key: string;
  groupKey: string;
  name: string;
  context: string;
  /** Linha sigilosa no catálogo do tenant. */
  sensitive?: boolean;
}

/**
 * O diagrama, o CSV, os anos epidêmicos e a configuração de agravo sigiloso só saem para a vigilância municipal com
 * acesso ao sigilo (a API responde 403 AGRAVO_SIGILOSO aos demais, inclusive ao gestor e ao núcleo da unidade).
 */
export const podeVerDiagramaSigiloso = (papel: Role | null | undefined, permissoes: readonly Permission[]) => papel === 'VIGILANCIA_EPIDEMIOLOGICA' && permissoes.includes('notificacao.sensivel');

/** As opções que o seletor mostra: sem as sigilosas para quem não pode vê-las (a escolhida continua, para não sumir). */
export const opcoesVisiveis = (opcoes: OpcaoAgravo[], sigilosos: boolean, escolhido?: string | null) => (sigilosos ? opcoes : opcoes.filter((o) => !o.sigiloso || o.grupo === escolhido));

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

/** A opção com a marca de sigilo só quando sigilosa (as demais ficam só com grupo e nome). */
const opcao = (grupo: string, nome: string, sigiloso: boolean): OpcaoAgravo => (sigiloso ? { grupo, nome, sigiloso: true } : { grupo, nome });

/**
 * Agravos do seletor. Com o catálogo vigente do tenant, um por grupo, com o nome que a API dá ao diagrama (a linha
 * do próprio grupo, senão a de casos, sem o " - Casos"). Sem acesso ao catálogo (o gestor só tem o resumo), os grupos
 * da tabela de agravos do Sinan. Dengue, chikungunya e zika primeiro; os demais em ordem alfabética. O grupo é
 * sigiloso quando está na lista única do diagrama (`GRUPOS_SIGILOSOS_DIAGRAMA`, a mesma da API) ou quando alguma linha
 * dele é sigilosa no catálogo do tenant.
 */
export function opcoesDeAgravo(condicoes?: CondicaoDoCatalogo[] | null): OpcaoAgravo[] {
  if (condicoes?.length) {
    const porGrupo = new Map<string, CondicaoDoCatalogo[]>();
    for (const c of condicoes) porGrupo.set(c.groupKey, [...(porGrupo.get(c.groupKey) ?? []), c]);
    return ordenar(
      [...porGrupo].map(([grupo, linhas]) => {
        const l = linhas.find((x) => x.key === grupo) ?? linhas.find((x) => x.context === 'CASO') ?? linhas[0]!;
        return opcao(grupo, l.name.replace(/\s+-\s+Casos$/i, ''), GRUPOS_SIGILOSOS_DIAGRAMA.has(grupo) || linhas.some((x) => x.sensitive === true));
      }),
    );
  }
  const vistos = new Map<string, string>();
  for (const info of Object.values(AGRAVOS_SINAN)) if (info.grupo && !vistos.has(info.grupo)) vistos.set(info.grupo, NOME_DO_GRUPO_SINAN[info.grupo] ?? info.nome);
  return ordenar([...vistos].map(([grupo, nome]) => opcao(grupo, nome, GRUPOS_SIGILOSOS_DIAGRAMA.has(grupo))));
}

/** Nome do agravo para a tela; o grupo quando não está na lista. */
export const nomeDoAgravo = (opcoes: OpcaoAgravo[], grupo: string | null | undefined) => (grupo ? (opcoes.find((o) => o.grupo === grupo)?.nome ?? grupo) : '—');
