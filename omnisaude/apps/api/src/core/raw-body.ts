import type { Request } from 'express';
import { DomainError } from './errors';

/**
 * Lê o corpo cru (application/zip, octet-stream ou text/csv), que não passa pelos parsers JSON/texto do main.ts.
 * Usado pelo pacote da SIGTAP (faturamento) e pelas exportações oficiais da vigilância (VIG-1c).
 */
export async function rawBody(req: Request, limit = 60 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new DomainError('ARQUIVO_GRANDE', 'Arquivo maior que o permitido', 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
