import { loadModule, parseSync } from 'libpg-query';

/**
 * Camada de segurança do Text-to-SQL. O SQL gerado pela IA é analisado pelo parser real do
 * PostgreSQL (libpg-query) e só passa se for exatamente um SELECT que lê relações da lista
 * permitida (as visões do schema `bi`), usando apenas funções, operadores e tipos conhecidos.
 * A árvore inteira é percorrida e qualquer tipo de nó fora da lista é recusado: o que o
 * validador não conhece, não executa. A execução ainda deve ocorrer na réplica de leitura,
 * com papel somente-leitura, search_path = bi e statement_timeout (defesa em profundidade).
 */

export interface SqlGuardPolicy {
  /** Relações permitidas, qualificadas por schema (ex.: "bi.atendimentos"). */
  allowedRelations: readonly string[];
  /** Substitui a lista padrão de funções permitidas. */
  allowedFunctions?: readonly string[];
  /** Teto de linhas por página. */
  maxRows: number;
  /** Schema assumido para nomes sem qualificação (deve coincidir com o search_path da execução). Padrão: "bi". */
  defaultSchema?: string;
  /** Tamanho máximo do texto SQL. Padrão: 20.000 caracteres. */
  maxLength?: number;
}

export interface PageRequest {
  limit?: number;
  offset?: number;
}

export type SqlGuardResult =
  | {
      ok: true;
      /** A instrução validada, sem ponto e vírgula final. */
      sql: string;
      /** A instrução envolvida em LIMIT/OFFSET; é esta que deve ser executada. */
      paginatedSql: string;
      limit: number;
      offset: number;
      /** Relações lidas (para a trilha de auditoria). */
      relations: string[];
    }
  | { ok: false; errors: string[] };

export const DEFAULT_ALLOWED_FUNCTIONS: readonly string[] = [
  // Agregações
  'count', 'sum', 'avg', 'min', 'max', 'string_agg', 'array_agg', 'bool_and', 'bool_or', 'every',
  'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
  'percentile_cont', 'percentile_disc', 'mode', 'json_agg', 'jsonb_agg',
  // Janela
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead',
  'first_value', 'last_value', 'nth_value',
  // Datas
  'date_trunc', 'date_part', 'extract', 'age', 'now', 'make_date', 'make_interval', 'make_timestamp',
  'to_date', 'to_timestamp', 'to_char', 'justify_days', 'justify_interval', 'date_bin', 'timezone',
  'generate_series', 'isfinite',
  // Números
  'round', 'trunc', 'abs', 'ceil', 'ceiling', 'floor', 'power', 'sqrt', 'mod', 'div', 'sign', 'width_bucket',
  'to_number',
  // Texto
  'lower', 'upper', 'initcap', 'btrim', 'ltrim', 'rtrim', 'concat', 'concat_ws', 'length', 'char_length',
  'substring', 'substr', 'replace', 'left', 'right', 'lpad', 'rpad', 'position', 'strpos', 'split_part',
  'starts_with', 'format', 'regexp_replace', 'similar_to_escape', 'unaccent', 'overlaps',
];

const ALLOWED_NODES = new Set([
  'SelectStmt', 'ResTarget', 'ColumnRef', 'String', 'A_Star', 'A_Const', 'Integer', 'Float', 'Boolean',
  'FuncCall', 'A_Expr', 'BoolExpr', 'NullTest', 'BooleanTest', 'SubLink', 'CaseExpr', 'CaseWhen',
  'CoalesceExpr', 'MinMaxExpr', 'TypeCast', 'TypeName', 'RangeVar', 'RangeSubselect', 'RangeFunction',
  'JoinExpr', 'Alias', 'SortBy', 'WindowDef', 'A_ArrayExpr', 'A_Indirection', 'A_Indices', 'RowExpr',
  'SQLValueFunction', 'GroupingSet', 'GroupingFunc', 'List', 'CollateClause', 'NamedArgExpr',
  'CommonTableExpr',
]);

const ALLOWED_OPERATORS = new Set([
  '=', '<>', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '^', '||',
  '~~', '~~*', '!~~', '!~~*', '~', '~*', '!~', '!~*',
]);

const ALLOWED_TYPES = new Set([
  'int2', 'int4', 'int8', 'smallint', 'integer', 'int', 'bigint', 'numeric', 'decimal', 'float4', 'float8',
  'real', 'double precision', 'text', 'varchar', 'bpchar', 'char', 'date', 'timestamp', 'timestamptz',
  'time', 'timetz', 'interval', 'bool', 'boolean', 'uuid',
]);

const ALLOWED_SQL_VALUE_FUNCTIONS = new Set([
  'SVFOP_CURRENT_DATE', 'SVFOP_CURRENT_TIME', 'SVFOP_CURRENT_TIME_N', 'SVFOP_CURRENT_TIMESTAMP',
  'SVFOP_CURRENT_TIMESTAMP_N', 'SVFOP_LOCALTIME', 'SVFOP_LOCALTIME_N', 'SVFOP_LOCALTIMESTAMP',
  'SVFOP_LOCALTIMESTAMP_N',
]);

const STATEMENT_NAMES: Record<string, string> = {
  InsertStmt: 'INSERT', UpdateStmt: 'UPDATE', DeleteStmt: 'DELETE', MergeStmt: 'MERGE', DropStmt: 'DROP',
  AlterTableStmt: 'ALTER', GrantStmt: 'GRANT/REVOKE', GrantRoleStmt: 'GRANT/REVOKE', TruncateStmt: 'TRUNCATE',
  CopyStmt: 'COPY', VariableSetStmt: 'SET', CreateStmt: 'CREATE', CreateTableAsStmt: 'CREATE TABLE AS',
  ExplainStmt: 'EXPLAIN', DoStmt: 'DO', CallStmt: 'CALL', TransactionStmt: 'controle de transação',
  LockStmt: 'LOCK', VacuumStmt: 'VACUUM', CreateFunctionStmt: 'CREATE FUNCTION', CreateRoleStmt: 'CREATE ROLE',
  AlterRoleStmt: 'ALTER ROLE', ViewStmt: 'CREATE VIEW', IndexStmt: 'CREATE INDEX', RenameStmt: 'ALTER/RENAME',
};

const MAX_NODES = 5000;
const DEFAULT_MAX_LENGTH = 20_000;

let moduleReady: Promise<void> | undefined;

/** Carrega o parser (WASM) uma única vez. Chamado automaticamente por validateBiQuery. */
export function initSqlGuard(): Promise<void> {
  moduleReady ??= loadModule();
  return moduleReady;
}

type PgNode = Record<string, unknown>;

class Checker {
  readonly errors = new Set<string>();
  readonly relations = new Set<string>();
  private nodes = 0;
  private readonly allowedRelations: Set<string>;
  private readonly allowedFunctions: Set<string>;
  private readonly defaultSchema: string;

  constructor(policy: SqlGuardPolicy) {
    this.allowedRelations = new Set(policy.allowedRelations);
    this.allowedFunctions = new Set(policy.allowedFunctions ?? DEFAULT_ALLOWED_FUNCTIONS);
    this.defaultSchema = policy.defaultSchema ?? 'bi';
  }

  private fail(message: string) {
    this.errors.add(message);
  }

  /** Percorre qualquer valor da árvore; chaves com inicial maiúscula são tipos de nó. */
  visit(value: unknown, scope: readonly string[]): void {
    if (Array.isArray(value)) {
      for (const item of value) this.visit(item, scope);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (++this.nodes > MAX_NODES) {
      this.fail('Consulta complexa demais para ser analisada.');
      return;
    }
    for (const [key, child] of Object.entries(value as PgNode)) {
      if (/^[A-Z]/.test(key)) this.visitNode(key, child as PgNode, scope);
      else this.visit(child, scope);
    }
  }

  private visitNode(type: string, node: PgNode, scope: readonly string[]) {
    if (!ALLOWED_NODES.has(type)) {
      const statement = STATEMENT_NAMES[type];
      if (type === 'LockingClause') this.fail('Cláusulas de bloqueio (FOR UPDATE/FOR SHARE) não são permitidas.');
      else if (type === 'ParamRef') this.fail('Parâmetros posicionais ($1) não são permitidos.');
      else if (statement || type.endsWith('Stmt')) this.fail(`Comando não permitido: ${statement ?? type}.`);
      else this.fail(`Construção SQL não permitida: ${type}.`);
      return;
    }
    switch (type) {
      case 'SelectStmt':
        return this.visitSelect(node, scope);
      case 'RangeVar':
        return this.checkRelation(node, scope);
      case 'FuncCall':
        this.checkFunction(node);
        break;
      case 'A_Expr':
        this.checkOperator(node);
        break;
      case 'TypeCast':
        this.checkType((node.typeName as PgNode | undefined) ?? {});
        break;
      case 'TypeName':
        this.checkType(node);
        break;
      case 'SQLValueFunction':
        if (!ALLOWED_SQL_VALUE_FUNCTIONS.has(String(node.op))) this.fail(`Função de sistema não permitida: ${String(node.op)}.`);
        return;
      case 'CommonTableExpr':
        // Só aparece dentro de WITH, tratado em visitSelect.
        this.fail('WITH fora de posição.');
        return;
    }
    this.visit(node, scope);
  }

  visitSelect(stmt: PgNode, scope: readonly string[]) {
    if (stmt.intoClause) this.fail('SELECT INTO não é permitido.');
    let inner = scope;
    const withClause = stmt.withClause as PgNode | undefined;
    if (withClause) {
      if (withClause.recursive) this.fail('WITH RECURSIVE não é permitido.');
      const names: string[] = [];
      for (const item of (withClause.ctes as PgNode[] | undefined) ?? []) {
        const cte = item.CommonTableExpr as PgNode | undefined;
        if (!cte) {
          this.fail('Cláusula WITH inválida.');
          continue;
        }
        const query = cte.ctequery as PgNode | undefined;
        const select = query?.SelectStmt as PgNode | undefined;
        if (!select) {
          const kind = query ? Object.keys(query)[0] : undefined;
          this.fail(`Comando de escrita dentro de WITH não é permitido${kind && STATEMENT_NAMES[kind] ? ` (${STATEMENT_NAMES[kind]})` : ''}.`);
        } else {
          // Sem RECURSIVE, cada CTE enxerga apenas as anteriores: um nome posterior resolveria para uma tabela real.
          this.visitSelect(select, [...scope, ...names]);
        }
        const { ctequery: _q, ctename: _n, ...rest } = cte;
        this.visit(rest, scope);
        names.push(String(cte.ctename));
      }
      inner = [...scope, ...names];
    }
    for (const [key, child] of Object.entries(stmt)) {
      if (key === 'withClause' || key === 'intoClause') continue;
      if ((key === 'larg' || key === 'rarg') && child) this.visitSelect(child as PgNode, inner);
      else this.visit(child, inner);
    }
  }

  private checkRelation(rv: PgNode, scope: readonly string[]) {
    if (rv.catalogname) {
      this.fail('Referências a outros bancos de dados não são permitidas.');
      return;
    }
    const name = String(rv.relname);
    const schema = rv.schemaname === undefined ? undefined : String(rv.schemaname);
    if (schema === undefined && scope.includes(name)) return;
    const qualified = `${schema ?? this.defaultSchema}.${name}`;
    if (this.allowedRelations.has(qualified)) this.relations.add(qualified);
    else this.fail(`Tabela ou visão não permitida: ${qualified}.`);
    if (rv.alias) this.visit(rv.alias, scope);
  }

  private checkFunction(fc: PgNode) {
    const names = ((fc.funcname as PgNode[] | undefined) ?? []).map((n) => String((n.String as PgNode | undefined)?.sval));
    const name = names.join('.');
    const ok =
      (names.length === 1 || (names.length === 2 && names[0] === 'pg_catalog')) && this.allowedFunctions.has(names.at(-1)!);
    if (!ok) this.fail(`Função não permitida: ${name}.`);
  }

  private checkOperator(expr: PgNode) {
    const kind = String(expr.kind);
    if (kind.includes('BETWEEN')) return;
    const names = ((expr.name as PgNode[] | undefined) ?? []).map((n) => String((n.String as PgNode | undefined)?.sval));
    const op = names.at(-1) ?? '';
    if ((names.length === 2 && names[0] !== 'pg_catalog') || names.length > 2 || !ALLOWED_OPERATORS.has(op)) {
      this.fail(`Operador não permitido: ${names.join('.')}.`);
    }
  }

  private checkType(typeName: PgNode) {
    const names = ((typeName.names as PgNode[] | undefined) ?? []).map((n) => String((n.String as PgNode | undefined)?.sval));
    const type = names.at(-1) ?? '';
    if ((names.length === 2 && names[0] !== 'pg_catalog') || names.length > 2 || !ALLOWED_TYPES.has(type)) {
      this.fail(`Conversão para o tipo não permitida: ${names.join('.')}.`);
    }
  }
}

interface Analysis {
  errors: string[];
  statement?: string;
  relations: string[];
}

function analyze(sql: string, policy: SqlGuardPolicy): Analysis {
  if (sql.length > (policy.maxLength ?? DEFAULT_MAX_LENGTH)) return { errors: ['Consulta longa demais.'], relations: [] };
  let tree;
  try {
    tree = parseSync(sql);
  } catch (error) {
    return { errors: [`SQL inválido: ${error instanceof Error ? error.message : String(error)}`], relations: [] };
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length === 0) return { errors: ['Consulta vazia.'], relations: [] };
  if (stmts.length > 1) return { errors: ['Apenas uma instrução SQL é permitida.'], relations: [] };
  const raw = stmts[0]!;
  const stmt = raw.stmt as unknown as PgNode | undefined;
  const select = stmt?.SelectStmt as PgNode | undefined;
  if (!select) {
    const kind = stmt ? Object.keys(stmt)[0]! : 'desconhecido';
    return { errors: [`Comando não permitido: ${STATEMENT_NAMES[kind] ?? kind}. Apenas SELECT é aceito.`], relations: [] };
  }
  const checker = new Checker(policy);
  checker.visitSelect(select, []);
  const start = raw.stmt_location ?? 0;
  const statement = (raw.stmt_len ? sql.slice(start, start + raw.stmt_len) : sql.slice(start)).trim();
  return { errors: [...checker.errors], statement, relations: [...checker.relations].sort() };
}

/** Envolve a consulta com LIMIT/OFFSET. A quebra de linha impede que um comentário "--" engula o fechamento. */
export function paginate(sql: string, page: { limit: number; offset: number }): string {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1) throw new RangeError('limit inválido');
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) throw new RangeError('offset inválido');
  return `SELECT * FROM (\n${sql}\n) AS q LIMIT ${page.limit} OFFSET ${page.offset}`;
}

/** Valida a consulta gerada pela IA e devolve a versão paginada pronta para execução na réplica. */
export async function validateBiQuery(sql: string, policy: SqlGuardPolicy, page: PageRequest = {}): Promise<SqlGuardResult> {
  await initSqlGuard();
  const first = analyze(sql, policy);
  if (first.errors.length > 0 || first.statement === undefined) return { ok: false, errors: first.errors };

  const limit = Math.min(Math.max(1, Math.trunc(page.limit ?? policy.maxRows)), policy.maxRows);
  const offset = Math.max(0, Math.trunc(page.offset ?? 0));
  const paginatedSql = paginate(first.statement, { limit, offset });
  // Revalida o texto final: a paginação não pode ter mudado o significado (ex.: comentário aberto).
  const second = analyze(paginatedSql, policy);
  const wrapped = second.errors.length === 0 && second.relations.join() === first.relations.join();
  if (!wrapped) return { ok: false, errors: second.errors.length ? second.errors : ['Falha ao paginar a consulta.'] };

  return { ok: true, sql: first.statement, paginatedSql, limit, offset, relations: first.relations };
}
