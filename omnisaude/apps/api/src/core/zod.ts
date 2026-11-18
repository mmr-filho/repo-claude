import { HttpStatus, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { DomainError } from './errors';

/** Valida o corpo/consulta com um schema zod e devolve o valor já convertido. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw new DomainError('VALIDACAO', 'Dados inválidos', HttpStatus.BAD_REQUEST, details);
    }
    return parsed.data;
  }
}

export const zv = <T extends z.ZodType>(schema: T) => new ZodPipe(schema);

/** Caractere de controle (C0, DEL e C1): o espaço comum é o único que passa. */
const CONTROLE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Texto de busca ou nome curto (consulta ou corpo): sem os espaços das pontas, de `min` (padrão 0) a `max` caracteres e
 * sem caractere de controle. O NUL (U+0000) que chegasse ao Postgres daria o erro 22021 (o text não aceita); a
 * tabulação, a quebra de linha no meio e os outros não fazem sentido numa busca ou num nome: 400 VALIDACAO, como os
 * outros valores inválidos.
 */
export const textoSemControle = (max: number, opcoes: { min?: number; mensagem?: string } = {}) => {
  const texto = z.string().trim();
  return (opcoes.min ? texto.min(opcoes.min) : texto).max(max).refine((s) => !CONTROLE.test(s), opcoes.mensagem ?? 'Texto com caractere inválido (de controle)');
};
