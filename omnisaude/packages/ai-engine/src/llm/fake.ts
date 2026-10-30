import type { z } from 'zod';
import { LlmOutputError } from '../errors';
import type { LlmClient, StructuredRequest, StructuredResponse } from './types';

type Responder = (request: StructuredRequest<z.ZodType>, callIndex: number) => unknown | Promise<unknown>;

/**
 * Cliente roteirizado: devolve respostas pré-definidas (em ordem) ou calculadas por uma função.
 * Serve para testes e para rodar o sistema sem chave de API. As respostas passam pelo mesmo schema.
 */
export class FakeLlmClient implements LlmClient {
  readonly calls: StructuredRequest<z.ZodType>[] = [];
  private readonly responder: Responder;

  constructor(responses: unknown[] | Responder) {
    if (typeof responses === 'function') {
      this.responder = responses;
    } else {
      const queue = [...responses];
      this.responder = () => {
        if (queue.length === 0) throw new LlmOutputError('FakeLlmClient sem respostas restantes.');
        return queue.shift();
      };
    }
  }

  async generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>> {
    this.calls.push(request);
    const raw = await this.responder(request, this.calls.length - 1);
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) throw new LlmOutputError(`Resposta roteirizada fora do schema: ${parsed.error.message}`);
    return { output: parsed.data, model: 'fake', usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
