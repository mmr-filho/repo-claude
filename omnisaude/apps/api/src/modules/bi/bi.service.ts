import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  LlmRefusalError,
  LlmUnavailableError,
  TextToSqlEngine,
  TextToSqlError,
  validateBiQuery,
  type ChartSuggestion,
  type LlmClient,
} from '@omnisaude/ai-engine';
import { localDateString } from '@omnisaude/shared';
import { types as pgTypes, type FieldDef } from 'pg';
import type { RequestContext } from '../../core/context';
import { TenantsService } from '../../core/database';
import { DomainError } from '../../core/errors';
import { BI_CATALOG, BI_RELATIONS } from './catalog';

export const BI_LLM_CLIENT = Symbol('BI_LLM_CLIENT');

export const PAGE_SIZE = 50;
export const MAX_ROWS = 5000;
const STATEMENT_TIMEOUT_MS = 15_000;

const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;

export interface BiColumnOut {
  name: string;
  type: 'number' | 'date' | 'datetime' | 'boolean' | 'text';
}

export interface BiResult {
  sql: string;
  columns: BiColumnOut[];
  rows: Record<string, unknown>[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Datas (sem hora) chegam como texto: convertê-las em Date deslocaria o dia conforme o fuso do servidor. */
const queryTypes = {
  getTypeParser: (oid: number, format?: string) => (oid === DATE ? (v: string) => v : pgTypes.getTypeParser(oid, format as 'text')),
};

function columnType(f: FieldDef): BiColumnOut['type'] {
  if ([20, 21, 23, 700, 701, 1700].includes(f.dataTypeID)) return 'number';
  if (f.dataTypeID === DATE) return 'date';
  if ([1114, 1184].includes(f.dataTypeID)) return 'datetime';
  if (f.dataTypeID === 16) return 'boolean';
  return 'text';
}

function toCell(value: unknown, f: FieldDef): unknown {
  if (value === null || value === undefined) return null;
  if ((f.dataTypeID === INT8 || f.dataTypeID === NUMERIC) && typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : value;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * BI conversacional: pergunta → SQL (IA) → validador AST → execução na réplica de leitura.
 * Toda consulta é validada de novo aqui, inclusive as que voltam do navegador para paginar ou exportar.
 */
@Injectable()
export class BiService {
  private readonly logger = new Logger('BI');

  constructor(
    private readonly tenants: TenantsService,
    @Inject(BI_LLM_CLIENT) private llm: LlmClient | null,
  ) {}

  /** Troca o provedor de IA em tempo de execução (testes, ou chave configurada depois da subida). */
  setLlmClient(client: LlmClient | null) {
    this.llm = client;
  }

  catalog() {
    return BI_CATALOG;
  }

  async ask(ctx: RequestContext, question: string, page = 0) {
    if (!ctx.tenant.settings.aiEnabled) {
      throw new DomainError('IA_DESATIVADA', 'Os recursos de IA estão desativados para esta instituição', HttpStatus.FORBIDDEN);
    }
    if (!this.llm) {
      throw new DomainError('IA_INDISPONIVEL', 'Nenhum provedor de IA configurado (ANTHROPIC_API_KEY)', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const started = Date.now();
    const engine = new TextToSqlEngine({ llm: this.llm, catalog: BI_CATALOG, maxRows: MAX_ROWS + 1 });
    let generated;
    try {
      generated = await engine.generate(question, {
        today: localDateString(new Date(), ctx.tenant.timeZone),
        timeZone: ctx.tenant.timeZone,
        limit: PAGE_SIZE + 1,
        offset: this.offset(page),
      });
    } catch (err) {
      const mapped = this.mapAiError(err);
      await this.log(ctx, { question, sql: err instanceof TextToSqlError ? (err.lastSql ?? null) : null, ok: false, error: mapped.message, ms: Date.now() - started });
      throw mapped;
    }
    const result = await this.execute(ctx, question, generated.sql, page, started);
    return { question, explanation: generated.explanation, chart: generated.chart as ChartSuggestion, model: generated.model, ...result };
  }

  /** Reexecuta (paginação) uma consulta vinda do cliente: passa pelo validador como qualquer outra. */
  run(ctx: RequestContext, sql: string, page = 0) {
    return this.execute(ctx, null, sql, page, Date.now());
  }

  async exportCsv(ctx: RequestContext, sql: string): Promise<{ fileName: string; content: Buffer; rows: number }> {
    const started = Date.now();
    const check = await validateBiQuery(sql, { allowedRelations: BI_RELATIONS, maxRows: MAX_ROWS }, { limit: MAX_ROWS, offset: 0 });
    if (!check.ok) {
      await this.log(ctx, { question: '[exportação CSV]', sql, ok: false, error: check.errors.join('; '), ms: Date.now() - started });
      throw new DomainError('SQL_RECUSADO', 'Consulta recusada pelo validador de segurança', HttpStatus.UNPROCESSABLE_ENTITY, { errors: check.errors });
    }
    const { fields, rows } = await this.query(ctx, check.paginatedSql, { question: '[exportação CSV]', sql: check.sql, started });
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[;"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [fields.map((f) => escape(f.name)).join(';'), ...rows.map((r) => r.map((v, i) => escape(toCell(v, fields[i]!))).join(';'))];
    // BOM para o Excel em português reconhecer UTF-8 e o separador ";".
    const content = Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
    await this.log(ctx, { question: '[exportação CSV]', sql: check.sql, rows: rows.length, ok: true, ms: Date.now() - started });
    return { fileName: `consulta_${localDateString(new Date(), ctx.tenant.timeZone)}.csv`, content, rows: rows.length };
  }

  private offset(page: number) {
    const offset = Math.max(0, Math.trunc(page)) * PAGE_SIZE;
    if (offset >= MAX_ROWS) throw new DomainError('PAGINA_INVALIDA', `Limite de ${MAX_ROWS} linhas por consulta`, HttpStatus.BAD_REQUEST);
    return offset;
  }

  private async execute(ctx: RequestContext, question: string | null, sql: string, page: number, started: number): Promise<BiResult> {
    const check = await validateBiQuery(sql, { allowedRelations: BI_RELATIONS, maxRows: MAX_ROWS + 1 }, { limit: PAGE_SIZE + 1, offset: this.offset(page) });
    if (!check.ok) {
      await this.log(ctx, { question: question ?? '[reexecução]', sql, ok: false, error: check.errors.join('; '), ms: Date.now() - started });
      throw new DomainError('SQL_RECUSADO', 'Consulta recusada pelo validador de segurança', HttpStatus.UNPROCESSABLE_ENTITY, { errors: check.errors });
    }
    const { fields, rows } = await this.query(ctx, check.paginatedSql, { question: question ?? '[reexecução]', sql: check.sql, started });
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = rows.slice(0, PAGE_SIZE);
    // Colunas com o mesmo nome (ex.: dois "nome") ganham sufixo para não se sobrescreverem.
    const names: string[] = [];
    for (const f of fields) {
      let n = f.name;
      for (let i = 2; names.includes(n); i++) n = `${f.name}_${i}`;
      names.push(n);
    }
    const out = pageRows.map((r) => Object.fromEntries(r.map((v, i) => [names[i]!, toCell(v, fields[i]!)])));
    await this.log(ctx, { question: question ?? '[reexecução]', sql: check.sql, rows: out.length, ok: true, ms: Date.now() - started });
    return {
      sql: check.sql,
      columns: fields.map((f, i) => ({ name: names[i]!, type: columnType(f) })),
      rows: out,
      page: Math.max(0, Math.trunc(page)),
      pageSize: PAGE_SIZE,
      hasMore,
    };
  }

  /** Executa na réplica: transação somente leitura, timeout local e papel omni_bi (search_path = bi). */
  private async query(ctx: RequestContext, sql: string, log: { question: string; sql: string; started: number }) {
    const pool = await this.tenants.readonlyPool(ctx.tenant.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      const r = await client.query({ text: sql, rowMode: 'array', types: queryTypes });
      await client.query('COMMIT');
      return { fields: r.fields, rows: r.rows as unknown[][] };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const code = (err as { code?: string }).code;
      const message =
        code === '57014'
          ? 'A consulta excedeu o tempo limite; refine o período ou os filtros'
          : code === '42501'
            ? 'Acesso negado a uma das tabelas da consulta'
            : `A consulta falhou: ${(err as Error).message}`;
      await this.log(ctx, { question: log.question, sql: log.sql, ok: false, error: message, ms: Date.now() - log.started });
      throw new DomainError('CONSULTA_FALHOU', message, HttpStatus.UNPROCESSABLE_ENTITY);
    } finally {
      client.release();
    }
  }

  private mapAiError(err: unknown): DomainError {
    if (err instanceof DomainError) return err;
    if (err instanceof TextToSqlError) {
      return new DomainError('CONSULTA_NAO_GERADA', err.message, HttpStatus.UNPROCESSABLE_ENTITY, { errors: err.errors, lastSql: err.lastSql ?? null });
    }
    if (err instanceof LlmRefusalError) {
      return new DomainError('IA_RECUSOU', 'O modelo de IA recusou a solicitação; reformule a pergunta', HttpStatus.UNPROCESSABLE_ENTITY, { category: err.category });
    }
    if (err instanceof LlmUnavailableError) {
      return new DomainError('IA_INDISPONIVEL', 'Provedor de IA indisponível no momento; tente novamente', HttpStatus.SERVICE_UNAVAILABLE, { retryable: err.retryable });
    }
    this.logger.error(err instanceof Error ? err.stack : String(err));
    return new DomainError('IA_ERRO', 'Falha ao gerar a consulta', HttpStatus.BAD_GATEWAY);
  }

  private async log(ctx: RequestContext, entry: { question: string; sql: string | null; rows?: number; ok: boolean; error?: string; ms: number }) {
    try {
      await ctx.db.biQueryLog.create({
        data: { userId: ctx.session.userId, question: entry.question, sql: entry.sql, rows: entry.rows ?? null, ok: entry.ok, error: entry.error ?? null, ms: entry.ms },
      });
    } catch (err) {
      this.logger.warn(`Falha ao registrar consulta de BI: ${(err as Error).message}`);
    }
  }

  async history(ctx: RequestContext) {
    return ctx.db.biQueryLog.findMany({ where: { userId: ctx.session.userId, ok: true, question: { not: { startsWith: '[' } } }, orderBy: { at: 'desc' }, take: 30 });
  }
}
