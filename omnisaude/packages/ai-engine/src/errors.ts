/** Erros do motor de IA. A API traduz cada um em uma resposta HTTP adequada. */

export class AiEngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** O modelo recusou a solicitação por política de segurança. Não adianta repetir igual. */
export class LlmRefusalError extends AiEngineError {
  constructor(
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(`O modelo recusou a solicitação${category ? ` (categoria: ${category})` : ''}.`);
  }
}

/** A resposta veio truncada ou fora do formato esperado. */
export class LlmOutputError extends AiEngineError {}

/** Falha de comunicação com o provedor. `retryable` indica se vale tentar de novo depois. */
export class LlmUnavailableError extends AiEngineError {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A pergunta não pôde ser convertida em uma consulta segura. */
export class TextToSqlError extends AiEngineError {
  constructor(
    message: string,
    readonly errors: string[],
    readonly lastSql?: string,
  ) {
    super(message);
  }
}
