import { LEDI_STRUCTS, type LediField, type LediFieldType } from './ledi-schema';

/**
 * TBinaryProtocol do Apache Thrift (o protocolo exigido pelo LEDI), guiado pelo esquema gerado dos .thrift
 * oficiais: codifica objetos simples em bytes e lê bytes de volta. Sem a biblioteca thrift em produção; os
 * testes comparam a saída com a implementação de referência do Apache Thrift e o esquema com o código gerado
 * pelo compilador oficial.
 */

export const THRIFT_TYPE = { STOP: 0, BOOL: 2, BYTE: 3, DOUBLE: 4, I16: 6, I32: 8, I64: 10, STRING: 11, STRUCT: 12, MAP: 13, SET: 14, LIST: 15 } as const;
const TYPE = THRIFT_TYPE;

export type LediValue = string | number | bigint | boolean | Uint8Array | LediValue[] | LediObject | null | undefined;
export interface LediObject {
  [field: string]: LediValue;
}

export class LediEncodeError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${path}: ${message}`);
  }
}

export function wireType(t: LediFieldType): number {
  if (typeof t === 'string') {
    switch (t) {
      case 'bool':
        return TYPE.BOOL;
      case 'i32':
        return TYPE.I32;
      case 'i64':
        return TYPE.I64;
      case 'double':
        return TYPE.DOUBLE;
      case 'string':
      case 'binary':
        return TYPE.STRING;
    }
  }
  return 'list' in t ? TYPE.LIST : TYPE.STRUCT;
}

class Writer {
  private chunks: Buffer[] = [];
  private size = 0;
  byte(v: number) {
    this.push(Buffer.from([v & 0xff]));
  }
  i16(v: number) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.push(b);
  }
  i32(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.push(b);
  }
  i64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(v);
    this.push(b);
  }
  double(v: number) {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    this.push(b);
  }
  bytes(v: Buffer) {
    this.i32(v.length);
    this.push(v);
  }
  push(b: Buffer) {
    this.chunks.push(b);
    this.size += b.length;
  }
  result() {
    return Buffer.concat(this.chunks, this.size);
  }
}

export function lediFields(struct: string): LediField[] {
  const f = LEDI_STRUCTS[struct];
  if (!f) throw new Error(`Estrutura LEDI desconhecida: ${struct}`);
  return f;
}

function writeValue(w: Writer, type: LediFieldType, value: LediValue, path: string) {
  if (typeof type === 'string') {
    switch (type) {
      case 'bool':
        if (typeof value !== 'boolean') throw new LediEncodeError('esperado boolean', path);
        w.byte(value ? 1 : 0);
        return;
      case 'i32': {
        const n = typeof value === 'bigint' ? Number(value) : value;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < -2147483648 || n > 2147483647) throw new LediEncodeError('esperado inteiro de 32 bits', path);
        w.i32(n);
        return;
      }
      case 'i64': {
        if (typeof value === 'bigint') {
          w.i64(value);
          return;
        }
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new LediEncodeError('esperado inteiro (número seguro ou bigint)', path);
        w.i64(BigInt(value));
        return;
      }
      case 'double':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new LediEncodeError('esperado número', path);
        w.double(value);
        return;
      case 'string':
        if (typeof value !== 'string') throw new LediEncodeError('esperado texto', path);
        w.bytes(Buffer.from(value, 'utf8'));
        return;
      case 'binary':
        if (!(value instanceof Uint8Array)) throw new LediEncodeError('esperado binário', path);
        w.bytes(Buffer.from(value));
        return;
    }
  }
  if ('list' in type) {
    if (!Array.isArray(value)) throw new LediEncodeError('esperada lista', path);
    w.byte(wireType(type.list));
    w.i32(value.length);
    value.forEach((item, i) => writeValue(w, type.list, item, `${path}[${i}]`));
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array) throw new LediEncodeError(`esperado objeto ${type.struct}`, path);
  writeStruct(w, type.struct, value as LediObject, path);
}

function writeStruct(w: Writer, struct: string, obj: LediObject, path: string) {
  for (const f of lediFields(struct)) {
    const value = obj[f.name];
    if (value === undefined || value === null) {
      if (f.required) throw new LediEncodeError(`campo obrigatório ${f.name} ausente`, `${path}.${struct}`);
      continue;
    }
    w.byte(wireType(f.type));
    w.i16(f.id);
    writeValue(w, f.type, value, `${path}.${f.name}`);
  }
  w.byte(TYPE.STOP);
}

/** Serializa um objeto como a estrutura Thrift indicada (TBinaryProtocol, sem cabeçalho de mensagem). */
export function encodeLedi(struct: string, obj: LediObject): Buffer {
  const w = new Writer();
  writeStruct(w, struct, obj, '$');
  return w.result();
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}
  byte() {
    return this.buf.readInt8(this.pos++);
  }
  i16() {
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i32() {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i64() {
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }
  double() {
    const v = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes() {
    const n = this.i32();
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('Tamanho inválido no Thrift');
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
}

function skip(r: Reader, wire: number) {
  switch (wire) {
    case TYPE.BOOL:
    case TYPE.BYTE:
      r.byte();
      return;
    case TYPE.I16:
      r.i16();
      return;
    case TYPE.I32:
      r.i32();
      return;
    case TYPE.I64:
      r.i64();
      return;
    case TYPE.DOUBLE:
      r.double();
      return;
    case TYPE.STRING:
      r.bytes();
      return;
    case TYPE.STRUCT:
      for (;;) {
        const t = r.byte();
        if (t === TYPE.STOP) return;
        r.i16();
        skip(r, t);
      }
    case TYPE.LIST:
    case TYPE.SET: {
      const t = r.byte();
      const n = r.i32();
      for (let i = 0; i < n; i++) skip(r, t);
      return;
    }
    case TYPE.MAP: {
      const k = r.byte();
      const v = r.byte();
      const n = r.i32();
      for (let i = 0; i < n; i++) {
        skip(r, k);
        skip(r, v);
      }
      return;
    }
    default:
      throw new Error(`Tipo Thrift desconhecido: ${wire}`);
  }
}

function readValue(r: Reader, type: LediFieldType, wire: number): LediValue {
  if (wireType(type) !== wire) {
    skip(r, wire);
    return undefined;
  }
  if (typeof type === 'string') {
    switch (type) {
      case 'bool':
        return r.byte() !== 0;
      case 'i32':
        return r.i32();
      case 'i64': {
        const v = r.i64();
        return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      case 'double':
        return r.double();
      case 'string':
        return r.bytes().toString('utf8');
      case 'binary':
        return Buffer.from(r.bytes());
    }
  }
  if ('list' in type) {
    const t = r.byte();
    const n = r.i32();
    const out: LediValue[] = [];
    for (let i = 0; i < n; i++) out.push(readValue(r, type.list, t));
    return out;
  }
  return readStruct(r, type.struct);
}

function readStruct(r: Reader, struct: string): LediObject {
  const byId = new Map(lediFields(struct).map((f) => [f.id, f]));
  const out: LediObject = {};
  for (;;) {
    const wire = r.byte();
    if (wire === TYPE.STOP) return out;
    const id = r.i16();
    const f = byId.get(id);
    if (!f) {
      skip(r, wire);
      continue;
    }
    const v = readValue(r, f.type, wire);
    if (v !== undefined) out[f.name] = v;
  }
}

/** Lê bytes TBinaryProtocol como a estrutura indicada; campos desconhecidos são ignorados. */
export function decodeLedi(struct: string, data: Uint8Array): LediObject {
  return readStruct(new Reader(Buffer.from(data)), struct);
}
