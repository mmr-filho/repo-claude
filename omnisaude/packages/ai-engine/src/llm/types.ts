import type { z } from 'zod';

export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type LlmImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: LlmImageMediaType; data: string /* base64 */ };

export interface StructuredRequest<S extends z.ZodType> {
  /** Instruções estáveis (candidatas a cache no provedor). */
  system: string;
  content: string | LlmContentPart[];
  schema: S;
  maxTokens?: number;
  effort?: LlmEffort;
  /** Rótulo da tarefa, para logs e trilha de auditoria (ex.: "text-to-sql"). */
  task?: string;
}

export interface StructuredResponse<T> {
  output: T;
  /** Modelo que efetivamente respondeu (pode diferir do pedido quando há fallback). */
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Contrato mínimo que o restante do sistema usa para falar com um modelo de linguagem. */
export interface LlmClient {
  generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>>;
}
