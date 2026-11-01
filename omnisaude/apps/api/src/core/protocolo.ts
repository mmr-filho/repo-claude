import { localDateString } from '@omnisaude/shared';
import { DomainError } from './errors';

/** Ano do protocolo no fuso da instituição: um pedido de 31/12 à noite não vira do ano seguinte (o servidor roda em UTC). */
export function anoDoProtocolo(timeZone: string, agora = new Date()): number {
  return Number(localDateString(agora, timeZone).slice(0, 4));
}

/**
 * Grava um registro com número de protocolo sequencial. Dois pedidos ao mesmo tempo podem escolher o mesmo número:
 * quando o índice único recusa (P2002), tenta de novo pulando para o número seguinte, até `tentativas` vezes.
 * `gravar` deve ser atômico (um create ou uma transação): o que falhou é desfeito antes da próxima tentativa.
 */
export async function gravarComProtocolo<T>(
  proximo: (salto: number) => Promise<string>,
  gravar: (protocolo: string) => Promise<T>,
  { tentativas = 5, mensagem = 'Não foi possível gerar o número do protocolo; tente de novo' }: { tentativas?: number; mensagem?: string } = {},
): Promise<T> {
  for (let tentativa = 0; tentativa < tentativas; tentativa++) {
    const protocolo = await proximo(tentativa);
    try {
      return await gravar(protocolo);
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
  throw new DomainError('PROTOCOLO_INDISPONIVEL', mensagem);
}
