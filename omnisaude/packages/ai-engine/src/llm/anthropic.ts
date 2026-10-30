import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { LlmOutputError, LlmRefusalError, LlmUnavailableError } from '../errors';
import type { LlmClient, LlmContentPart, StructuredRequest, StructuredResponse } from './types';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AnthropicLlmClientOptions {
  /** Padrão: variável ANTHROPIC_API_KEY (ou demais credenciais que o SDK reconhece). */
  apiKey?: string;
  /** Padrão: variável OMNI_AI_MODEL ou claude-opus-5-5. */
  model?: string;
  /** Repetir no servidor, em outro modelo, quando o pedido é recusado por política. Padrão: ligado. */
  serverSideFallback?: boolean;
  timeoutMs?: number;
  /** Cliente já configurado (testes, proxy corporativo). */
  client?: Anthropic;
}

export class AnthropicLlmClient implements LlmClient {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly serverSideFallback: boolean;

  constructor(options: AnthropicLlmClientOptions = {}) {
    this.model = options.model ?? process.env.OMNI_AI_MODEL ?? DEFAULT_MODEL;
    this.serverSideFallback = options.serverSideFallback ?? true;
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      });
  }

  async generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: request.maxTokens ?? 16000,
        // O prompt de sistema é estável por tarefa/tenant: marcá-lo para cache reduz custo e latência.
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: toBlocks(request.content) }],
        output_config: { effort: request.effort ?? 'medium', format: betaZodOutputFormat(request.schema) },
        ...(this.serverSideFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
    } catch (error) {
      throw translateError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new LlmRefusalError(response.stop_details?.category ?? null, response.stop_details?.explanation ?? null);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new LlmOutputError('A resposta do modelo foi interrompida pelo limite de tokens.');
    }
    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new LlmOutputError('A resposta do modelo não seguiu o formato esperado.');
    }
    return {
      output: response.parsed_output as z.infer<S>,
      model: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}

function toBlocks(content: string | LlmContentPart[]): Anthropic.Beta.BetaContentBlockParam[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  // Imagens antes do texto: o modelo lê melhor a pergunta depois de ver o documento.
  const images = content.filter((p) => p.type === 'image');
  const texts = content.filter((p) => p.type === 'text');
  return [
    ...images.map(
      (p): Anthropic.Beta.BetaImageBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: p.mediaType, data: p.data },
      }),
    ),
    ...texts.map((p): Anthropic.Beta.BetaTextBlockParam => ({ type: 'text', text: p.text })),
  ];
}

function translateError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new LlmUnavailableError('Credencial do provedor de IA inválida ou sem permissão.', false, { cause: error });
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new LlmUnavailableError(`Requisição recusada pelo provedor de IA: ${error.message}`, false, { cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmUnavailableError('Limite de uso do provedor de IA atingido. Tente novamente em instantes.', true, { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmUnavailableError('Sem conexão com o provedor de IA.', true, { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    const retryable = error.status === undefined || error.status >= 500 || error.status === 408 || error.status === 409;
    return new LlmUnavailableError(`Erro no provedor de IA (${error.status ?? 'sem status'}).`, retryable, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
