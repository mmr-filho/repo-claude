import { HttpStatus, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
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
