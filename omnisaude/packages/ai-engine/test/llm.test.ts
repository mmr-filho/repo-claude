import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicLlmClient, FakeLlmClient, LlmOutputError, LlmRefusalError, LlmUnavailableError } from '@omnisaude/ai-engine';

/** Cliente Anthropic falso: captura os parâmetros e devolve uma mensagem pronta. */
function stubClient(reply: Record<string, unknown> | Error) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const schema = z.object({ answer: z.string() });
const ok = { stop_reason: 'end_turn', stop_details: null, parsed_output: { answer: 'sim' }, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 3 } };

describe('AnthropicLlmClient', () => {
  it('usa saída estruturada, esforço explícito, cache do system e fallback no servidor', async () => {
    const { client, calls } = stubClient(ok);
    const llm = new AnthropicLlmClient({ client });
    const r = await llm.generateStructured({
      system: 'instruções',
      content: [
        { type: 'text', text: 'leia' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ],
      schema,
      effort: 'low',
    });
    expect(r).toEqual({ output: { answer: 'sim' }, model: 'claude-opus-5-5', usage: { inputTokens: 10, outputTokens: 3 } });
    const p = calls[0]!;
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.fallbacks).toBe('default');
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect((p.output_config as { effort: string }).effort).toBe('low');
    expect((p.output_config as { format: unknown }).format).toBeDefined();
    expect(p).not.toHaveProperty('thinking');
    expect(p.system).toEqual([{ type: 'text', text: 'instruções', cache_control: { type: 'ephemeral' } }]);
    const content = (p.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content.map((b) => b.type)).toEqual(['image', 'text']);
  });

  it('permite desligar o fallback e trocar o modelo', async () => {
    const { client, calls } = stubClient(ok);
    await new AnthropicLlmClient({ client, model: 'claude-sonnet-5-5', serverSideFallback: false }).generateStructured({ system: 's', content: 'x', schema });
    expect(calls[0]!.model).toBe('claude-sonnet-5-5');
    expect(calls[0]).not.toHaveProperty('fallbacks');
  });

  it('trata recusa, truncamento e saída fora do formato', async () => {
    const refused = stubClient({ ...ok, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: 'x' }, parsed_output: null });
    await expect(new AnthropicLlmClient({ client: refused.client }).generateStructured({ system: 's', content: 'x', schema })).rejects.toBeInstanceOf(LlmRefusalError);
    const truncated = stubClient({ ...ok, stop_reason: 'max_tokens', parsed_output: null });
    await expect(new AnthropicLlmClient({ client: truncated.client }).generateStructured({ system: 's', content: 'x', schema })).rejects.toBeInstanceOf(LlmOutputError);
    const invalid = stubClient({ ...ok, parsed_output: null });
    await expect(new AnthropicLlmClient({ client: invalid.client }).generateStructured({ system: 's', content: 'x', schema })).rejects.toBeInstanceOf(LlmOutputError);
  });

  it('traduz erros do SDK indicando se vale repetir', async () => {
    const rate = stubClient(new Anthropic.RateLimitError(429, { type: 'error' }, 'limite', new Headers()));
    const e1 = await new AnthropicLlmClient({ client: rate.client }).generateStructured({ system: 's', content: 'x', schema }).catch((e) => e);
    expect(e1).toBeInstanceOf(LlmUnavailableError);
    expect(e1.retryable).toBe(true);
    const auth = stubClient(new Anthropic.AuthenticationError(401, { type: 'error' }, 'chave', new Headers()));
    const e2 = await new AnthropicLlmClient({ client: auth.client }).generateStructured({ system: 's', content: 'x', schema }).catch((e) => e);
    expect(e2.retryable).toBe(false);
  });
});

describe('FakeLlmClient', () => {
  it('valida respostas roteirizadas contra o schema', async () => {
    const fake = new FakeLlmClient([{ answer: 'a' }, { wrong: true }]);
    expect((await fake.generateStructured({ system: '', content: '', schema })).output).toEqual({ answer: 'a' });
    await expect(fake.generateStructured({ system: '', content: '', schema })).rejects.toBeInstanceOf(LlmOutputError);
    await expect(fake.generateStructured({ system: '', content: '', schema })).rejects.toThrow(/sem respostas/);
  });
});
