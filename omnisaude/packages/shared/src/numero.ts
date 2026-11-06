/**
 * Lê uma quantidade digitada no formato brasileiro: vírgula decimal e ponto de milhar. "25.000" é 25000, "1.000,5" é
 * 1000,5, "25,5" é 25,5 e "25000" é 25000. Sem vírgula, o ponto só vale como separador de milhar quando cada grupo
 * depois dele tem exatamente três dígitos. "2.5" é ambíguo (decimal no formato inglês ou milhar mal digitado) e é
 * recusado, para nunca lançar mil vezes menos (ou mais) do que se quis. Espaços são ignorados. Não aceita sinal:
 * devolve null para texto vazio, negativo, inválido ou ambíguo.
 */
export function lerNumeroPtBr(texto: string | null | undefined): number | null {
  if (texto == null) return null;
  const t = texto.replace(/\s/g, '');
  if (!t) return null;
  const partes = t.split(',');
  if (partes.length > 2) return null;
  let inteiro = partes[0]!;
  const decimal = partes[1] ?? '';
  if (partes.length === 2 && !/^\d+$/.test(decimal)) return null;
  if (inteiro === '') {
    if (!decimal) return null;
    inteiro = '0';
  }
  if (inteiro.includes('.')) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(inteiro)) return null;
    inteiro = inteiro.replace(/\./g, '');
  } else if (!/^\d+$/.test(inteiro)) return null;
  const n = Number(decimal ? `${inteiro}.${decimal}` : inteiro);
  return Number.isFinite(n) ? n : null;
}
