// Números em português do Brasil. O mesmo formato é usado no texto das regras e na conferência do texto do agente.

const inteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dois = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "R$ 1.234.567" (sem centavos: são estimativas e somas de relatórios) */
export const brl = (v: number): string => `R$ ${inteiro.format(Math.round(v))}`;

/** "R$ 1,2 milhão", "R$ 350 mil": para títulos e cartões */
export function brlCurto(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `R$ ${decimal.format(v / 1e9)} ${a >= 2e9 ? 'bilhões' : 'bilhão'}`;
  if (a >= 1e6) return `R$ ${decimal.format(v / 1e6)} ${a >= 2e6 ? 'milhões' : 'milhão'}`;
  if (a >= 1e3) return `R$ ${inteiro.format(v / 1e3)} mil`;
  return brl(v);
}

export const pct = (v: number): string => `${dois.format(v)}%`;
export const num1 = (v: number): string => decimal.format(v);
export const reaisPorHab = (v: number): string => `R$ ${dois.format(v)} por habitante`;

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const mesAno = (mes: number, ano: number): string => `${MESES[mes - 1] ?? mes} de ${ano}`;

/**
 * Valores em reais citados num texto: "R$ 1.234.567,89", "R$ 1,2 milhão", "R$ 350 mil". `curto` indica a forma
 * arredondada (mil, milhão), que se confere com tolerância maior. Usado para conferir se o agente só repetiu valores
 * calculados pelo motor.
 */
export function valoresEmReais(texto: string): { valor: number; curto: boolean }[] {
  const rx = /R\$\s*(-?\d[\d.]*(?:,\d+)?)(?:\s*(mil\b|milh(?:ão|ões|oes|ao)|bilh(?:ão|ões|oes|ao)))?/gi;
  const saida: { valor: number; curto: boolean }[] = [];
  for (const m of texto.matchAll(rx)) {
    const base = Number((m[1] ?? '').replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(base)) continue;
    const escala = (m[2] ?? '').toLowerCase();
    const fator = escala.startsWith('bilh') ? 1e9 : escala.startsWith('milh') ? 1e6 : escala === 'mil' ? 1e3 : 1;
    saida.push({ valor: base * fator, curto: fator > 1 });
  }
  return saida;
}

/** Percentuais citados num texto ("24,71%", "70 %", "10% (dez por cento)"). */
export function percentuais(texto: string): number[] {
  return [...texto.matchAll(/(\d+(?:,\d+)?)\s*%/g)].map((m) => Number((m[1] ?? '').replace(',', '.')));
}
