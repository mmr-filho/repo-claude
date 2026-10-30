# @omnisaude/ai-engine

Camada de IA do OmniSaúde: Text-to-SQL blindado, copiloto de prescrição, linhas de cuidado, leitura de documentos (OCR), ditado clínico (Speech-to-SOAP) e comandos de voz.

Tudo o que é regra clínica ou de segurança roda **localmente e de forma determinística**. O modelo de linguagem só entra onde precisa interpretar linguagem ou imagem (gerar SQL, ler um documento, organizar um ditado), e sempre por trás da interface `LlmClient`.

## Módulos

| Módulo | O que faz | Usa IA? |
|---|---|---|
| `sql-guard` | Valida o SQL com o parser real do PostgreSQL (libpg-query, PG 18) e pagina | Não |
| `text-to-sql` | Pergunta do gestor → SQL sobre as visões `bi.*`, validado pelo `sql-guard` | Sim |
| `clinical-copilot` | Interações, alergias e reatividade cruzada, função renal, gestação, idade, condições, duplicidade, dose máxima | Não |
| `protocols` | CID-10/CIAP-2 → protocolo do Ministério da Saúde + exames SIGTAP | Não |
| `ocr` | Imagem do documento → dados do cadastro; heurística para texto de OCR comum; validação | Opcional |
| `speech-to-soap` | Transcrição → Subjetivo/Objetivo/Avaliação/Plano + sinais vitais | Opcional |
| `stt` | Transcrição de áudio gravado em servidor Whisper autohospedado | Não (modelo local) |
| `voice-commands` | "chamar paciente", "prescrever dipirona 500 mg de 6 em 6 horas", "emitir atestado" | Não |

## Uso

```ts
import {
  AnthropicLlmClient, FakeLlmClient, TextToSqlEngine, validateBiQuery,
  analyzePrescription, suggestCarePathway, LlmDocumentExtractor, parseDocumentText,
  validateExtraction, structureSoap, heuristicSoap, parseVoiceCommand,
} from '@omnisaude/ai-engine';

// Text-to-SQL: só o catálogo e a pergunta vão ao modelo.
const engine = new TextToSqlEngine({ llm: new AnthropicLlmClient(), catalog, maxRows: 1000 });
const { paginatedSql, explanation, chart } = await engine.generate(
  'Hipertensos de 40 a 65 anos que retiraram hidroclorotiazida no 1º trimestre e não consultaram nos últimos 6 meses',
  { today: '2026-10-30', timeZone: 'America/Sao_Paulo', limit: 100, offset: 0 },
);
// Execute paginatedSql na réplica: papel somente-leitura, search_path = bi, statement_timeout.

// Copiloto de prescrição
const analysis = analyzePrescription({
  newItems: [{ name: 'Ibuprofeno 600 mg', dose: '600 mg', frequency: '8/8h' }],
  currentMedications: [{ name: 'Varfarina 5 mg' }],
  allergies: ['Dipirona'],
  conditions: ['I10'],
  labs: [{ code: 'CREATININA', value: 1.4, unit: 'mg/dL', collectedAt: '2026-10-01' }],
  patient: { ageYears: 72, sex: 'F' },
});
analysis.requiresJustification; // true se houver alerta GRAVE

// Linha de cuidado (informe o sistema: "K86" é HAS no CIAP-2 e doença do pâncreas na CID-10)
suggestCarePathway('E11.9');          // DM2 + exames SIGTAP
suggestCarePathway('K86', 'CIAP2');   // HAS

// Documento
const doc = await new LlmDocumentExtractor(llm).extract({ data: base64, mediaType: 'image/jpeg' });
const { data, issues, valid } = validateExtraction(doc);

// Ditado
await structureSoap(transcricao, { llm });  // sem llm, usa heuristicSoap
parseVoiceCommand('chamar próximo');         // { intent: 'CHAMAR_PROXIMO' }
```

`FakeLlmClient` aceita respostas roteirizadas (ou uma função) e valida cada uma contra o schema: serve para testes e para subir o sistema sem chave de API.

## Configuração

| Variável | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | Credencial do `AnthropicLlmClient` (o SDK também aceita `ANTHROPIC_AUTH_TOKEN` e perfis do `ant auth login`). |
| `OMNI_AI_MODEL` | Modelo; padrão `claude-opus-5-5`. |

O `AnthropicLlmClient`:

- usa **saída estruturada** (`client.beta.messages.parse` + `betaZodOutputFormat`), então toda resposta chega validada pelo schema Zod;
- define `output_config.effort` explicitamente por tarefa (`low` para OCR e SOAP, `medium` para SQL); o pensamento adaptativo é o padrão do modelo e não é configurado;
- marca o prompt de sistema para **cache** (`cache_control: ephemeral`), já que ele é estável por tarefa e por tenant;
- liga o **fallback no servidor** para recusas por política (`fallbacks: "default"` com o beta `server-side-fallback-2026-07-01`). Desligue com `serverSideFallback: false` (ex.: em Bedrock/Vertex, onde o parâmetro não existe);
- trata `stop_reason: "refusal"` (`LlmRefusalError`) e `max_tokens` (`LlmOutputError`) antes de ler a resposta, e converte erros do SDK em `LlmUnavailableError` com `retryable`.

## LGPD: o que sai do ambiente do tenant

| Recurso | Enviado ao provedor de IA | Observação |
|---|---|---|
| Text-to-SQL | Catálogo das visões (nomes, tipos, descrições) e a pergunta | **Nenhum dado de paciente.** O resultado é executado localmente. |
| OCR com IA | **Imagem do documento** do cidadão | Dado pessoal. Ativar só com base legal e contrato com o operador; há o caminho sem IA (`parseDocumentText` sobre OCR local). |
| Speech-to-SOAP com IA | **Transcrição da consulta** | Dado pessoal sensível (saúde). Mesma ressalva; sem IA usa `heuristicSoap`. |
| STT (Whisper) | Nada: o servidor é autohospedado na rede do tenant | — |
| Copiloto, protocolos, comandos de voz, sql-guard | Nada | Regras locais. |

A API deve oferecer uma **chave por tenant** (e idealmente por recurso) para ligar ou desligar o envio de dados pessoais ao provedor, registrar cada chamada na trilha de auditoria (`task`, modelo devolvido em `StructuredResponse.model`) e nunca enviar mais do que o necessário.

## Segurança do Text-to-SQL

O `validateBiQuery` aceita apenas **uma** instrução `SELECT` e percorre a árvore inteira com **listas de permissão**:

- tipos de nó do parser (qualquer construção desconhecida é recusada: `XmlExpr`, `ColumnDef`, `LockingClause`, `ParamRef`, comandos...);
- relações: só as visões do catálogo; nomes sem schema resolvem para `bi` (a execução precisa usar `search_path = bi`); CTEs respeitam o escopo do PostgreSQL (sem `RECURSIVE`, uma CTE não enxerga as posteriores, para que um nome não resolva para uma tabela real);
- funções (`DEFAULT_ALLOWED_FUNCTIONS`), operadores, tipos de conversão (`::regclass` é recusado) e funções SQL (`current_user` é recusado);
- sem `SELECT INTO`, `FOR UPDATE/SHARE`, CTEs com escrita, múltiplas instruções.

Depois de paginar (`SELECT * FROM (\n...\n) AS q LIMIT n OFFSET m`), o texto final é validado de novo. Mesmo assim, a execução deve ter defesa em profundidade: réplica de leitura, papel com `SELECT` apenas nas visões `bi`, `default_transaction_read_only`, `statement_timeout`.

## Limitações conhecidas

- **Base de conhecimento clínica é semente de desenvolvimento** (`KNOWLEDGE_BASE_VERSION = seed-dev-…`): cerca de 110 princípios ativos, ~20 regras de interação e regras de alergia, renais, gestação, idade e condições. Precisa ser revisada e ampliada pela Comissão de Farmácia e Terapêutica antes do uso clínico. Medicamentos não reconhecidos geram alerta `LEVE` para conferência manual.
- Doses: só a dose diária máxima de alguns fármacos, a partir de posologias simples ("1 g de 6/6h", "3x ao dia"); concentrações (`mg/mL`), doses por peso e pediatria não são calculadas.
- TFG por CKD-EPI 2021 (adultos, creatinina em mg/dL ou µmol/L); exames com mais de 180 dias são ignorados.
- **Códigos SIGTAP dos protocolos são semente**: devem ser conciliados com a tabela carregada pela sincronização mensal; exames sem código confirmado (urocultura, sorologias, espirometria) aparecem só no texto das recomendações.
- O parser de OCR sem IA é heurístico (layouts comuns de RG, CNH, Cartão SUS); a ordem pai/mãe na filiação sem rótulo segue a convenção do RG/CNH e deve ser conferida.
- `heuristicSoap` classifica por palavras-pista; ditados longos sem comandos de seção ficam melhores com IA.
- O `WhisperAsrProvider` foi escrito para a API do container `openai-whisper-asr-webservice`; outros servidores de STT precisam de outro provedor.
