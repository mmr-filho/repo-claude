import { inflateRawSync } from 'node:zlib';

/**
 * Leitor mínimo de arquivos ZIP (diretório central + deflate), suficiente para o pacote
 * da Tabela Unificada do DATASUS. Evita dependência nativa ou de terceiros só para descompactar.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipError extends Error {}

function findEndOfCentralDirectory(buf: Buffer): number {
  // O registro final tem 22 bytes + comentário de até 65535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError('Arquivo ZIP inválido: diretório central não encontrado');
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new ZipError('Arquivo ZIP inválido: entrada corrompida');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('latin1', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new ZipError(`Arquivo ZIP inválido: ${name}`);
    const localName = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buf.subarray(start, start + compressedSize);
    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    else throw new ZipError(`Método de compressão não suportado (${method}) em ${name}`);
  }
  return entries;
}
