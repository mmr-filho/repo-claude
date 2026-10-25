import type { Eixo, Indicador, Perfil } from './tipos';

/**
 * Fontes de recursos padronizadas pela STN (3 últimos dígitos; o primeiro dígito da MSC só separa recursos do
 * exercício e de exercícios anteriores). Só as federais que o módulo acompanha.
 */
export const FONTES: Record<string, { rotulo: string; eixo: Eixo | 'Outras' }> = {
  '540': { rotulo: 'FUNDEB (impostos e transferências)', eixo: 'Educação' },
  '541': { rotulo: 'FUNDEB: complementação da União VAAF', eixo: 'Educação' },
  '542': { rotulo: 'FUNDEB: complementação da União VAAT', eixo: 'Educação' },
  '543': { rotulo: 'FUNDEB: complementação da União VAAR', eixo: 'Educação' },
  '550': { rotulo: 'Salário-Educação (FNDE)', eixo: 'Educação' },
  '551': { rotulo: 'PDDE (FNDE)', eixo: 'Educação' },
  '552': { rotulo: 'PNAE, alimentação escolar (FNDE)', eixo: 'Educação' },
  '553': { rotulo: 'PNATE, transporte escolar (FNDE)', eixo: 'Educação' },
  '569': { rotulo: 'Outras transferências do FNDE', eixo: 'Educação' },
  '570': { rotulo: 'Convênios com a União (educação)', eixo: 'Educação' },
  '600': { rotulo: 'SUS fundo a fundo da União: manutenção', eixo: 'Saúde' },
  '601': { rotulo: 'SUS fundo a fundo da União: estruturação', eixo: 'Saúde' },
  '604': { rotulo: 'Agentes comunitários de saúde e de endemias (União)', eixo: 'Saúde' },
  '605': { rotulo: 'Piso da enfermagem: assistência complementar da União', eixo: 'Saúde' },
  '631': { rotulo: 'Convênios com a União (saúde)', eixo: 'Saúde' },
  '660': { rotulo: 'FNAS, Fundo Nacional de Assistência Social', eixo: 'Assistência Social' },
  '665': { rotulo: 'Convênios (assistência social)', eixo: 'Assistência Social' },
  '700': { rotulo: 'Outros convênios e repasses da União', eixo: 'Outras' },
  '706': { rotulo: 'Transferência especial da União (emendas individuais)', eixo: 'Outras' },
};

export const FUNDEB = ['540', '541', '542', '543'];

/** Anos de referência: o último ano completo (12 meses de MSC) e o ano corrente (parcial). */
export function anos(p: Perfil): { base: number | null; corrente: number | null } {
  const ks = Object.keys(p.receitas).map(Number).sort();
  const base = ks.filter((a) => p.receitas[a]?.meses === 12).pop() ?? null;
  const corrente = ks.filter((a) => (p.receitas[a]?.meses ?? 12) < 12).pop() ?? null;
  return { base, corrente };
}

export const receita = (p: Perfil, ano: number | null, ...fontes: string[]): number =>
  ano === null ? 0 : fontes.reduce((s, f) => s + (p.receitas[ano]?.por_fonte[f] ?? 0), 0);

export const caixa = (p: Perfil, ...fontes: string[]): number | null =>
  p.caixa ? fontes.reduce((s, f) => s + (p.caixa?.por_fonte[f] ?? 0), 0) : null;

/** Saldo em caixa medido em meses do repasse médio do último ano completo. */
export function mesesDeSaldo(p: Perfil, fonte: string): number | null {
  const { base } = anos(p);
  const media = receita(p, base, fonte) / 12;
  const saldo = caixa(p, fonte);
  if (saldo === null || media <= 0 || saldo <= 0) return null; // saldo negativo é inconsistência contábil: não se usa
  return saldo / media;
}

const porHab = (p: Perfil, fonte: string): number | null => {
  const { base } = anos(p);
  return base !== null && p.populacao > 0 ? receita(p, base, fonte) / p.populacao : null;
};

/** Indicadores comparáveis entre prefeituras (o valor de cada uma; as estatísticas vêm de `estatisticas`). */
export const INDICADORES: Record<string, { rotulo: string; unidade: Indicador['unidade']; valor: (p: Perfil) => number | null }> = {
  fundeb_hab: { rotulo: 'FUNDEB recebido por habitante', unidade: 'R$/hab', valor: (p) => porHab(p, '540') },
  salario_educacao_hab: { rotulo: 'Salário-Educação por habitante', unidade: 'R$/hab', valor: (p) => porHab(p, '550') },
  pnae_hab: { rotulo: 'PNAE por habitante', unidade: 'R$/hab', valor: (p) => porHab(p, '552') },
  pnate_hab: { rotulo: 'PNATE por habitante', unidade: 'R$/hab', valor: (p) => porHab(p, '553') },
  vaar_fundeb: {
    rotulo: 'VAAR em relação ao FUNDEB (quem recebe)',
    unidade: '%',
    valor: (p) => {
      const { base } = anos(p);
      const v = receita(p, base, '543');
      const f = receita(p, base, '540');
      return v > 0 && f > 0 ? (100 * v) / f : null;
    },
  },
  sus_hab: { rotulo: 'SUS fundo a fundo (manutenção) por habitante', unidade: 'R$/hab', valor: (p) => porHab(p, '600') },
  fnas_hab: { rotulo: 'FNAS por habitante', unidade: 'R$/hab', valor: (p) => porHab(p, '660') },
  meses_saldo_sus: { rotulo: 'Saldo do SUS (manutenção) em meses de repasse', unidade: 'meses', valor: (p) => mesesDeSaldo(p, '600') },
  meses_saldo_fnas: { rotulo: 'Saldo do FNAS em meses de repasse', unidade: 'meses', valor: (p) => mesesDeSaldo(p, '660') },
};

/** Grupo de comparação: a faixa populacional; as faixas com poucas prefeituras no Tocantins se juntam. */
export function grupo(faixa: string): string {
  return ['até 5 mil', '5 a 10 mil', '10 a 20 mil'].includes(faixa) ? faixa : 'acima de 20 mil';
}

export function quantil(ordenados: number[], q: number): number | null {
  if (!ordenados.length) return null;
  const pos = (ordenados.length - 1) * q;
  const i = Math.floor(pos);
  const a = ordenados[i] as number;
  const b = ordenados[Math.min(i + 1, ordenados.length - 1)] as number;
  return a + (b - a) * (pos - i);
}

export type Estatisticas = Record<string, Record<string, { n: number; p25: number | null; mediana: number | null; p75: number | null }>>;

/** Para cada indicador e grupo: quantas prefeituras têm o dado, quartis e mediana. */
export function estatisticas(perfis: Perfil[]): Estatisticas {
  const saida: Estatisticas = {};
  for (const [k, ind] of Object.entries(INDICADORES)) {
    const por: Record<string, number[]> = {};
    for (const p of perfis) {
      const v = ind.valor(p);
      if (v === null || !Number.isFinite(v)) continue;
      (por[grupo(p.faixa_populacional)] ??= []).push(v);
      (por['Tocantins'] ??= []).push(v);
    }
    saida[k] = Object.fromEntries(
      Object.entries(por).map(([g, vs]) => {
        vs.sort((a, b) => a - b);
        return [g, { n: vs.length, p25: quantil(vs, 0.25), mediana: quantil(vs, 0.5), p75: quantil(vs, 0.75) }];
      }),
    );
  }
  return saida;
}

export function indicadores(p: Perfil, est: Estatisticas): Record<string, Indicador> {
  const g = grupo(p.faixa_populacional);
  return Object.fromEntries(
    Object.entries(INDICADORES).map(([k, ind]) => {
      const s = est[k]?.[g] ?? { n: 0, p25: null, mediana: null, p75: null };
      return [k, { rotulo: ind.rotulo, unidade: ind.unidade, valor: ind.valor(p), grupo: g, ...s }];
    }),
  );
}
