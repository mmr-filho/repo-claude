import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEDI_STRUCTS, type LediFieldType } from '../src/ledi-schema';
import { decodeLedi, encodeLedi, LediEncodeError, lediFields, wireType, type LediObject, type LediValue } from '../src/thrift';

/**
 * Oráculo 1: a implementação de referência do Apache Thrift (pacote npm `thrift`) escrevendo os mesmos campos
 * pelo esquema. Oráculo 2: o código gerado pelo compilador oficial (test/oracle, lido como texto) tem de
 * declarar os mesmos campos, tipos e ids do esquema gerado dos .thrift.
 */
const require = createRequire(import.meta.url);
const thrift = require('thrift');

function referenceEncode(struct: string, obj: LediObject): Buffer {
  let out: Buffer = Buffer.alloc(0);
  const transport = new thrift.TBufferedTransport(null, (buf: Buffer) => {
    out = buf;
  });
  const p = new thrift.TBinaryProtocol(transport);
  const writeValue = (type: LediFieldType, value: LediValue) => {
    if (typeof type === 'string') {
      if (type === 'bool') p.writeBool(value);
      else if (type === 'i32') p.writeI32(value);
      else if (type === 'i64') p.writeI64(value);
      else if (type === 'double') p.writeDouble(value);
      else if (type === 'string') p.writeString(value);
      else p.writeBinary(Buffer.from(value as Uint8Array));
      return;
    }
    if ('list' in type) {
      const items = value as LediValue[];
      p.writeListBegin(wireType(type.list), items.length);
      for (const item of items) writeValue(type.list, item);
      p.writeListEnd();
      return;
    }
    writeStruct(type.struct, value as LediObject);
  };
  const writeStruct = (name: string, o: LediObject) => {
    p.writeStructBegin(name);
    for (const f of lediFields(name)) {
      const v = o[f.name];
      if (v === undefined || v === null) continue;
      p.writeFieldBegin(f.name, wireType(f.type), f.id);
      writeValue(f.type, v);
      p.writeFieldEnd();
    }
    p.writeFieldStop();
    p.writeStructEnd();
  };
  writeStruct(struct, obj);
  p.flush();
  return out;
}

describe('TBinaryProtocol próprio', () => {
  const header = { lotacaoFormPrincipal: { profissionalCNS: '898001160660001', cboCodigo_2002: '225125', cnes: '9000011', ine: '0000123456' }, dataAtendimento: 1761900000000, codigoIbgeMunicipio: '1709500' };
  const child = {
    cns: '700000000000002',
    dataNascimento: 318038400000,
    localDeAtendimento: 1,
    sexo: 1,
    turno: 2,
    tipoAtendimento: 5,
    exame: [{ codigoExame: '0202010473', solicitadoAvaliado: ['S'] }],
    condutas: [9, 1],
    dataHoraInicialAtendimento: 1761900000000,
    dataHoraFinalAtendimento: 1761901800000,
    medicoes: { pressaoArterialSistolica: 150, pressaoArterialDiastolica: 90, peso: 72.5, altura: 168, temperatura: 36.6 },
    problemasCondicoes: [
      { ciap: 'K86', isAvaliado: true },
      { cid10: 'I10', situacao: 0, isAvaliado: true },
    ],
    stCidadaoNaoPossuiCpf: false,
  };
  const master = { headerTransport: header, atendimentosIndividuais: [child], uuidFicha: '9000011-5a2fbe11-69b9-485f-baba-c606ac93ff0b', tpCdsOrigem: 3 };

  it('produz os mesmos bytes da implementação de referência e lê de volta', () => {
    const mine = encodeLedi('FichaAtendimentoIndividualMasterThrift', master);
    expect(mine.toString('hex')).toBe(referenceEncode('FichaAtendimentoIndividualMasterThrift', master).toString('hex'));
    expect(decodeLedi('FichaAtendimentoIndividualMasterThrift', mine)).toEqual(master);
  });

  it('serializa o DadoTransporte com o binário da ficha, acentos e lê de volta', () => {
    const ficha = encodeLedi('CadastroIndividualThrift', {
      fichaAtualizada: false,
      identificacaoUsuarioCidadao: { nomeCidadao: 'JOANA DA SILVA ÇÃO', dataNascimentoCidadao: 318038400000, nacionalidadeCidadao: 1, racaCorCidadao: 4, sexoCidadao: 1, cpfCidadao: '52998224725', stNaoPossuiCpf: false },
      tpCdsOrigem: 3,
      uuid: '9000011-0f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c',
      uuidFichaOriginadora: '9000011-0f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c',
      headerTransport: { profissionalCNS: '898001160660001', cboCodigo_2002: '515105', cnes: '9000011', dataAtendimento: 1761900000000, codigoIbgeMunicipio: '1709500' },
    });
    const instalacao = { contraChave: 'OmniSaude - 0.1', uuidInstalacao: 'tenant-1', cpfOuCnpj: '12345678000199', nomeOuRazaoSocial: 'Consórcio de Saúde' };
    const dado = {
      uuidDadoSerializado: '9000011-0f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c',
      tipoDadoSerializado: 2,
      cnesDadoSerializado: '9000011',
      codIbge: '1709500',
      numLote: 7,
      dadoSerializado: ficha,
      remetente: instalacao,
      originadora: instalacao,
      versao: { major: 8, minor: 7, revision: 0 },
    };
    const mine = encodeLedi('DadoTransporteThrift', dado);
    expect(mine.toString('hex')).toBe(referenceEncode('DadoTransporteThrift', dado).toString('hex'));
    const back = decodeLedi('DadoTransporteThrift', mine);
    expect(back.tipoDadoSerializado).toBe(2);
    expect(Buffer.from(back.dadoSerializado as Uint8Array).equals(ficha)).toBe(true);
    const inner = decodeLedi('CadastroIndividualThrift', back.dadoSerializado as Uint8Array);
    expect((inner.identificacaoUsuarioCidadao as { nomeCidadao: string }).nomeCidadao).toBe('JOANA DA SILVA ÇÃO');
  });

  it('ignora campos desconhecidos ao ler (compatibilidade com versões futuras)', () => {
    // Campo 99 (string) inexistente no esquema, seguido do campo 1.
    const extra = Buffer.concat([Buffer.from([11, 0, 99, 0, 0, 0, 2, 0x41, 0x42]), encodeLedi('VersaoThrift', { major: 8, minor: 7, revision: 0 })]);
    expect(decodeLedi('VersaoThrift', extra)).toEqual({ major: 8, minor: 7, revision: 0 });
  });

  it('recusa campo obrigatório ausente, tipo errado e número fora do i32', () => {
    expect(() => encodeLedi('VersaoThrift', { major: 8, minor: 7 })).toThrow(LediEncodeError);
    expect(() => encodeLedi('VersaoThrift', { major: '8', minor: 7, revision: 0 })).toThrow(/inteiro/);
    expect(() => encodeLedi('VersaoThrift', { major: 2 ** 40, minor: 7, revision: 0 })).toThrow(/32 bits/);
    expect(() => encodeLedi('Inexistente', {})).toThrow(/desconhecida/);
  });
});

describe('esquema gerado dos .thrift x código gerado pelo compilador oficial', () => {
  const TYPE_NAMES: Record<string, string> = { BOOL: 'bool', I32: 'i32', I64: 'i64', DOUBLE: 'double', STRING: 'string', LIST: 'list', STRUCT: 'struct' };
  const dir = join(__dirname, 'oracle');
  const generated = new Map<string, { name: string; type: string; id: number }[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    // Cada struct gerada tem um bloco "X.prototype.write = function(output) { ... writeFieldBegin('campo', Thrift.Type.T, id) ... }".
    for (const m of src.matchAll(/(\w+)\.prototype\.write = function\(output\) \{([\s\S]*?)\n\};/g)) {
      const fields = [...m[2].matchAll(/output\.writeFieldBegin\('(\w+)', Thrift\.Type\.(\w+), (\d+)\)/g)].map((f) => ({ name: f[1]!, type: TYPE_NAMES[f[2]!] ?? f[2]!, id: Number(f[3]) }));
      generated.set(m[1]!, fields);
    }
  }

  it('tem os mesmos campos, ids e tipos nas estruturas usadas pelas fichas', () => {
    expect(generated.size).toBeGreaterThan(30);
    for (const [name, fields] of generated) {
      const schema = LEDI_STRUCTS[name];
      expect(schema, name).toBeDefined();
      const mine = schema!.map((f) => ({ name: f.name, type: typeof f.type === 'string' ? (f.type === 'binary' ? 'string' : f.type) : 'list' in f.type ? 'list' : 'struct', id: f.id }));
      expect(mine, name).toEqual(fields);
    }
  });
});
