import { z } from 'zod';
import { TextToSqlError } from './errors';
import type { LlmClient } from './llm/types';
import { validateBiQuery, type PageRequest, type SqlGuardPolicy } from './sql-guard';

export interface BiColumn {
  name: string;
  type: string;
  description?: string;
}

export interface BiView {
  /** Nome qualificado, ex.: "bi.atendimentos". */
  name: string;
  description: string;
  columns: BiColumn[];
}

export interface BiCatalog {
  views: BiView[];
  /** Observações de negócio (ex.: "competência é AAAAMM", "idade em anos completos"). */
  notes?: string[];
}

export const CHART_TYPES = ['bar', 'line', 'pie', 'table'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSuggestion {
  type: ChartType;
  x?: string;
  y?: string;
}

export interface TextToSqlResult {
  sql: string;
  paginatedSql: string;
  limit: number;
  offset: number;
  explanation: string;
  chart: ChartSuggestion;
  relations: string[];
  model: string;
  attempts: number;
}

export interface GenerateOptions extends PageRequest {
  /** Data de referência para expressões relativas ("últimos 6 meses"), AAAA-MM-DD. */
  today: string;
  timeZone: string;
}

const OutputSchema = z.object({
  sql: z.string().describe('Uma única instrução SELECT em PostgreSQL, sem ponto e vírgula, ou string vazia se não for possível responder.'),
  explanation: z.string().describe('Explicação curta, em português, do que a consulta retorna e dos critérios usados.'),
  cannotAnswer: z.string().nullable().describe('Motivo, se a pergunta não puder ser respondida com as visões disponíveis; senão null.'),
  chart: z
    .object({
      type: z.enum(CHART_TYPES),
      x: z.string().nullable(),
      y: z.string().nullable(),
    })
    .describe('Sugestão de visualização dos resultados.'),
});

function describeCatalog(catalog: BiCatalog): string {
  const views = catalog.views
    .map((v) => {
      const cols = v.columns.map((c) => `  - ${c.name} (${c.type})${c.description ? `: ${c.description}` : ''}`).join('\n');
      return `### ${v.name}\n${v.description}\n${cols}`;
    })
    .join('\n\n');
  const notes = catalog.notes?.length ? `\n\n## Observações\n${catalog.notes.map((n) => `- ${n}`).join('\n')}` : '';
  return `## Visões disponíveis\n\n${views}${notes}`;
}

/**
 * Converte perguntas de gestores em SQL de leitura sobre as visões de BI.
 * Só o catálogo (nomes e descrições) e a pergunta vão para o modelo; nenhum dado de paciente.
 */
export class TextToSqlEngine {
  private readonly llm: LlmClient;
  private readonly catalog: BiCatalog;
  private readonly policy: SqlGuardPolicy;
  private readonly system: string;

  constructor(options: { llm: LlmClient; catalog: BiCatalog; maxRows?: number; allowedFunctions?: readonly string[] }) {
    this.llm = options.llm;
    this.catalog = options.catalog;
    this.policy = {
      allowedRelations: options.catalog.views.map((v) => v.name),
      maxRows: options.maxRows ?? 1000,
      ...(options.allowedFunctions ? { allowedFunctions: options.allowedFunctions } : {}),
    };
    this.system = [
      'Você é o analista de dados de uma rede pública de saúde (SUS) e escreve consultas SQL para PostgreSQL.',
      'Regras obrigatórias:',
      '- Gere exatamente uma instrução SELECT (CTEs com WITH são permitidas, sem RECURSIVE). Nunca escreva comandos de alteração.',
      '- Use somente as visões listadas abaixo, sempre qualificadas pelo schema (ex.: bi.atendimentos). Não existem outras tabelas.',
      '- Use apenas funções comuns de agregação, data, texto e número. Não use funções de sistema nem parâmetros ($1).',
      '- Não inclua LIMIT/OFFSET: a paginação é aplicada depois.',
      '- Para buscas por nome ou texto use lower(...) com LIKE; compare datas com literais ISO (\'2026-01-31\').',
      '- Dê nomes de colunas em português, legíveis (AS "Nome da coluna" quando ajudar).',
      '- Se a pergunta não puder ser respondida com estas visões, deixe sql vazio e explique em cannotAnswer.',
      '',
      describeCatalog(this.catalog),
    ].join('\n');
  }

  async generate(question: string, options: GenerateOptions): Promise<TextToSqlResult> {
    const context = `Data de hoje: ${options.today} (fuso ${options.timeZone}).\n\nPergunta do gestor:\n${question.trim()}`;
    let feedback = '';
    let lastSql: string | undefined;
    let lastErrors: string[] = [];

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { output, model } = await this.llm.generateStructured({
        task: 'text-to-sql',
        system: this.system,
        content: context + feedback,
        schema: OutputSchema,
        effort: 'medium',
        maxTokens: 8000,
      });

      if (output.cannotAnswer || !output.sql.trim()) {
        throw new TextToSqlError(output.cannotAnswer ?? 'Não foi possível montar a consulta.', [], undefined);
      }
      lastSql = output.sql;
      const check = await validateBiQuery(output.sql, this.policy, options);
      if (check.ok) {
        return {
          sql: check.sql,
          paginatedSql: check.paginatedSql,
          limit: check.limit,
          offset: check.offset,
          explanation: output.explanation,
          chart: {
            type: output.chart.type,
            ...(output.chart.x ? { x: output.chart.x } : {}),
            ...(output.chart.y ? { y: output.chart.y } : {}),
          },
          relations: check.relations,
          model,
          attempts: attempt,
        };
      }
      lastErrors = check.errors;
      feedback =
        `\n\nSua consulta anterior foi recusada pelo validador de segurança:\n${output.sql}\n\n` +
        `Problemas encontrados:\n${check.errors.map((e) => `- ${e}`).join('\n')}\n\nCorrija respeitando as regras.`;
    }
    throw new TextToSqlError('A consulta gerada não passou na validação de segurança.', lastErrors, lastSql);
  }
}
