/** Documentos de identificação usados no SUS: CPF, CNS (Cartão Nacional de Saúde) e nomes. */

export function onlyDigits(value: string): string {
  return value.replace(/\D+/g, '');
}

export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

export function formatCpf(value: string): string {
  const cpf = onlyDigits(value).padStart(11, '0');
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

/**
 * Valida o número do CNS pelo algoritmo do Ministério da Saúde.
 * Começados por 1 ou 2 são definitivos (derivados do PIS); por 7, 8 ou 9, provisórios.
 */
export function isValidCns(value: string): boolean {
  const cns = onlyDigits(value);
  if (cns.length !== 15) return false;
  const first = cns[0];
  if (first === '1' || first === '2') {
    const pis = cns.slice(0, 11);
    let sum = 0;
    for (let i = 0; i < 11; i++) sum += Number(pis[i]) * (15 - i);
    let dv = 11 - (sum % 11);
    if (dv === 11) dv = 0;
    let expected: string;
    if (dv === 10) {
      sum += 2;
      dv = 11 - (sum % 11);
      expected = `${pis}001${dv}`;
    } else {
      expected = `${pis}000${dv}`;
    }
    return expected === cns;
  }
  if (first === '7' || first === '8' || first === '9') {
    let sum = 0;
    for (let i = 0; i < 15; i++) sum += Number(cns[i]) * (15 - i);
    return sum % 11 === 0;
  }
  return false;
}

export function formatCns(value: string): string {
  const cns = onlyDigits(value);
  return `${cns.slice(0, 3)} ${cns.slice(3, 7)} ${cns.slice(7, 11)} ${cns.slice(11, 15)}`;
}

const NAME_PARTICLES = new Set(['da', 'das', 'de', 'do', 'dos', 'e', 'di', 'du']);

/** "MARIA DA  SILVA" -> "Maria da Silva" */
export function normalizePersonName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt-BR')
    .split(' ')
    .map((word, i) =>
      i > 0 && NAME_PARTICLES.has(word) ? word : word.charAt(0).toLocaleUpperCase('pt-BR') + word.slice(1),
    )
    .join(' ');
}

/** Chave para comparação de nomes (detecção de duplicidade): sem acentos, maiúsculas, espaços únicos. */
export function personNameKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Completa os 9 dígitos-base com os verificadores. Útil para dados de teste e demonstração. */
export function completeCpf(base9: string): string {
  const base = onlyDigits(base9);
  if (base.length !== 9) throw new Error('A base do CPF deve ter 9 dígitos');
  let cpf = base;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    cpf += String(rest === 10 ? 0 : rest);
  }
  return cpf;
}

/** Gera um CNS definitivo a partir de 11 dígitos-base (iniciando com 1 ou 2). */
export function cnsFromBase(base11: string): string {
  const pis = onlyDigits(base11);
  if (pis.length !== 11 || !/^[12]/.test(pis)) throw new Error('A base do CNS deve ter 11 dígitos e iniciar com 1 ou 2');
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(pis[i]) * (15 - i);
  let dv = 11 - (sum % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) {
    sum += 2;
    dv = 11 - (sum % 11);
    return `${pis}001${dv}`;
  }
  return `${pis}000${dv}`;
}
