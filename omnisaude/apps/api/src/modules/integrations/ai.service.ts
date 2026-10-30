import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AnthropicLlmClient, type LlmClient } from '@omnisaude/ai-engine';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import type { RequestContext } from '../../core/context';
import { DomainError } from '../../core/errors';

/**
 * Acesso ao modelo de linguagem. Só é usado quando o tenant ativou a IA (aiEnabled), porque
 * imagens de documentos e transcrições de consulta são dados pessoais enviados a um provedor externo.
 */
@Injectable()
export class AiService {
  /** Substituível em testes (FakeLlmClient). */
  client: LlmClient | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = config.ANTHROPIC_API_KEY ? new AnthropicLlmClient({ apiKey: config.ANTHROPIC_API_KEY, model: config.OMNI_AI_MODEL }) : null;
  }

  enabledFor(ctx: Pick<RequestContext, 'tenant'>): boolean {
    return ctx.tenant.settings.aiEnabled && this.client !== null;
  }

  require(ctx: Pick<RequestContext, 'tenant'>): LlmClient {
    if (!ctx.tenant.settings.aiEnabled) throw new DomainError('IA_DESATIVADA', 'Os recursos de IA estão desativados para esta instituição', HttpStatus.FORBIDDEN);
    if (!this.client) throw new DomainError('IA_INDISPONIVEL', 'Provedor de IA não configurado', HttpStatus.SERVICE_UNAVAILABLE);
    return this.client;
  }
}
