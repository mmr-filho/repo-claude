import { Module } from '@nestjs/common';
import { AnthropicLlmClient } from '@omnisaude/ai-engine';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { BiController } from './bi.controller';
import { BI_LLM_CLIENT, BiService } from './bi.service';

@Module({
  controllers: [BiController],
  providers: [
    {
      provide: BI_LLM_CLIENT,
      // Sem chave, o BI conversacional fica indisponível; consultas já validadas (run/export) continuam funcionando.
      useFactory: (config: AppConfig) =>
        config.ANTHROPIC_API_KEY ? new AnthropicLlmClient({ apiKey: config.ANTHROPIC_API_KEY, ...(config.OMNI_AI_MODEL ? { model: config.OMNI_AI_MODEL } : {}) }) : null,
      inject: [APP_CONFIG],
    },
    BiService,
  ],
  exports: [BiService],
})
export class BiModule {}
