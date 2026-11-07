/**
 * Leitura dos erros do PostgreSQL que chegam pelo Prisma com o adaptador pg: o código do PostgreSQL e o nome da
 * restrição ficam em meta.driverAdapterError.cause, tanto nas consultas do Prisma quanto no SQL escrito à mão.
 */
interface CausaPg {
  originalCode?: string;
  code?: string;
  kind?: string;
  message?: string;
  originalMessage?: string;
  constraint?: { index?: string } | string;
}

function causa(err: unknown): CausaPg | null {
  return (err as { meta?: { driverAdapterError?: { cause?: CausaPg } } } | null)?.meta?.driverAdapterError?.cause ?? null;
}

/** Código SQLSTATE do PostgreSQL (ex.: 23505, 40P01), quando o erro veio do banco. */
export function codigoPg(err: unknown): string | null {
  const c = causa(err);
  return c?.originalCode ?? c?.code ?? null;
}

/**
 * Conflito entre transações que se resolve repetindo: deadlock (40P01), falha de serialização (40001) e transação
 * interativa que expirou esperando a vez (P2028).
 */
export function ehConflitoPassageiro(err: unknown): boolean {
  const codigo = (err as { code?: string } | null)?.code;
  if (codigo === 'P2034' || codigo === 'P2028') return true;
  const pg = codigoPg(err);
  return pg === '40P01' || pg === '40001' || causa(err)?.kind === 'TransactionWriteConflict';
}

/** Violação de índice único; com `indice`, só a daquele índice. */
export function violouUnico(err: unknown, indice?: string): boolean {
  if ((err as { code?: string } | null)?.code !== 'P2002' && codigoPg(err) !== '23505') return false;
  if (!indice) return true;
  const c = causa(err)?.constraint;
  return (typeof c === 'string' ? c : c?.index) === indice;
}

/** Nome da restrição CHECK violada (23514); '' quando o banco não disse qual; null quando não é esse o erro. */
export function restricaoCheckViolada(err: unknown): string | null {
  if (codigoPg(err) !== '23514') return null;
  const c = causa(err);
  return /check constraint "([^"]+)"/.exec(c?.originalMessage ?? c?.message ?? '')?.[1] ?? '';
}
