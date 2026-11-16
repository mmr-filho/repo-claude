import { TenantPrisma } from '@omnisaude/database';

/**
 * Trechos de SQL da conciliação (VIG-1c) que repetem regras do shared, para as listas e as contagens rodarem no banco
 * sem carregar a base: CNS e CPF válidos (`isValidCns`, `isValidCpf`), nome de pessoa normalizado
 * (`normalizarNomePessoa`), número sem zeros à esquerda e a data da notificação como o Sinan a vê. O teste
 * vigilancia-conciliacao-listas confere cada um contra a função do shared. `col` é sempre uma coluna escrita no código
 * (nunca texto do usuário).
 */

type Sql = TenantPrisma.Sql;

const digito = (col: string, i: number) => `substr(${col}, ${i}, 1)::int`;
const soma = (col: string, n: number, primeiroPeso: number) => Array.from({ length: n }, (_, i) => `${digito(col, i + 1)} * ${primeiroPeso - i}`).join(' + ');

/** CPF válido (11 dígitos, não repetidos, dois verificadores), como `isValidCpf`. */
export function sqlCpfValido(col: string): Sql {
  return TenantPrisma.raw(
    `(CASE WHEN ${col} ~ '^[0-9]{11}$' AND ${col} <> repeat(left(${col}, 1), 11) ` +
      `THEN (((${soma(col, 9, 10)}) * 10) % 11) % 10 = ${digito(col, 10)} AND (((${soma(col, 10, 11)}) * 10) % 11) % 10 = ${digito(col, 11)} ` +
      `ELSE false END)`,
  );
}

/** CNS válido pelo algoritmo do Ministério da Saúde (definitivo: 1 e 2; provisório: 7, 8 e 9), como `isValidCns`. */
export function sqlCnsValido(col: string): Sql {
  const s11 = `(${soma(col, 11, 15)})`;
  return TenantPrisma.raw(
    `(CASE WHEN ${col} !~ '^[0-9]{15}$' THEN false ` +
      `WHEN left(${col}, 1) IN ('1', '2') THEN ${col} = left(${col}, 11) || ` +
      `CASE WHEN 11 - ${s11} % 11 = 10 THEN '001' || (11 - (${s11} + 2) % 11)::text ELSE '000' || ((11 - ${s11} % 11) % 11)::text END ` +
      `WHEN left(${col}, 1) IN ('7', '8', '9') THEN (${soma(col, 15, 15)}) % 11 = 0 ` +
      `ELSE false END)`,
  );
}

/** Marcas de acento (U+0300 a U+036F), passadas como parâmetro para a expressão regular do banco. */
const MARCAS = '[̀-ͯ]';

/** Nome de pessoa para comparar (decomposto, sem acento, minúsculas, só letras e espaço simples), como `normalizarNomePessoa`. */
export function sqlNomePessoa(col: string): Sql {
  return TenantPrisma.sql`btrim(regexp_replace(regexp_replace(lower(regexp_replace(normalize(COALESCE(${TenantPrisma.raw(col)}, ''), NFD), ${MARCAS}, '', 'g')), '[^a-z ]+', ' ', 'g'), ' +', ' ', 'g'))`;
}

/** Número sem espaços nas pontas nem zeros à esquerda (o último dígito fica), como o `semZeros` da conciliação. */
export function sqlSemZeros(col: string): Sql {
  return TenantPrisma.raw(`regexp_replace(btrim(${col}), '^0+(?=[0-9])', '')`);
}

/**
 * Data da notificação como o Sinan a vê (alias `n`): o DT_NOTIFIC da ficha quando é uma data que existe; senão a data
 * local (fuso do tenant) da notificação ou do conhecimento.
 */
export function sqlDataSinan(tz: string): Sql {
  const f = `(n.form->>'DT_NOTIFIC')`;
  return TenantPrisma.sql`COALESCE(
    CASE WHEN ${TenantPrisma.raw(f)} ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
      CASE WHEN substr(${TenantPrisma.raw(f)}, 9, 2)::int <= extract(day FROM make_date(substr(${TenantPrisma.raw(f)}, 1, 4)::int, substr(${TenantPrisma.raw(f)}, 6, 2)::int, 1) + interval '1 month - 1 day')::int
        THEN ${TenantPrisma.raw(f)}::date END
    END,
    ((COALESCE(n.notified_at, n.known_at) AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date)`;
}
