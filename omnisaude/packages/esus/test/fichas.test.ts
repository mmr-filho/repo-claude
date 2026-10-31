import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cnsFromBase } from '@omnisaude/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { TIPO_DADO } from '../src/codes';
import {
  buildAtendimentoIndividual,
  buildCadastroDomiciliar,
  buildCadastroIndividual,
  buildProcedimentos,
  buildVacinacao,
  buildVisitaDomiciliar,
  type AtendimentoIndividualInput,
  type CadastroIndividualInput,
} from '../src/fichas';
import { buildDadoTransporte, ibge7, lediUuid, normalizeName, splitLogradouro, structForTipo, turnoFromDate } from '../src/ledi';
import { PecClient, PecError } from '../src/pec-client';
import { decodeLedi, encodeLedi, type LediObject } from '../src/thrift';
import { validateFicha } from '../src/validate';
import { buildZip, readZipEntries } from '../src/zip';

const CNS_PROF = cnsFromBase('19876543210');
const CNS_PAC = cnsFromBase('29876543210');
const header = { cns: CNS_PROF, cbo: '225125', cnes: '9000011', ine: '0000123456', dataAtendimento: new Date('2026-10-30T13:00:00Z'), codigoIbge: '1709500' };
const cidadao = { name: 'Joana da Silva', birthDate: new Date('1981-02-03'), sex: 'F', cpf: '52998224725', cns: CNS_PAC };

describe('utilitários do LEDI', () => {
  it('normaliza nomes pelas regras do CADSUS', () => {
    expect(normalizeName('  maria  da paz ')).toBe('MARIA DA PAZ');
    expect(normalizeName("João D'Ávila")).toBe("JOÃO D'ÁVILA");
    expect(normalizeName('Joaquim')).toBeNull();
    expect(normalizeName('A A da Silva')).toBeNull();
    expect(normalizeName('Jo Si')).toBeNull();
    expect(normalizeName('Ana 2 Lima')).toBe('ANA LIMA');
  });
  it('separa o tipo de logradouro (DNE) e completa o IBGE', () => {
    expect(splitLogradouro('Rua de 14 Novembro')).toEqual({ tipo: '081', nome: 'DE 14 NOVEMBRO' });
    expect(splitLogradouro('Avenida Goiás')).toEqual({ tipo: '008', nome: 'GOIAS' });
    expect(splitLogradouro('Travessa Particular 2')).toEqual({ tipo: '570', nome: '2' });
    expect(splitLogradouro('Setor Central')).toEqual({ tipo: '095', nome: 'CENTRAL' });
    expect(splitLogradouro('Lote 10 quadra 3')).toEqual({ tipo: '801', nome: '10 QUADRA 3' });
    expect(ibge7('170950')).toBe('1709500');
    expect(ibge7('355030')).toBe('3550308');
    expect(ibge7('1709500')).toBe('1709500');
    expect(ibge7('12')).toBeUndefined();
  });
  it('calcula o turno no fuso da instituição', () => {
    expect(turnoFromDate(new Date('2026-10-30T11:30:00Z'), 'America/Araguaina')).toBe(1); // 8h30 local
    expect(turnoFromDate(new Date('2026-10-30T18:30:00Z'), 'America/Araguaina')).toBe(2); // 15h30
    expect(turnoFromDate(new Date('2026-10-30T22:30:00Z'), 'America/Araguaina')).toBe(3); // 19h30
    expect(lediUuid('9000011')).toMatch(/^9000011-[0-9a-f-]{36}$/);
  });
});

describe('fichas do e-SUS APS', () => {
  it('cadastro individual: monta, valida e serializa de ida e volta', () => {
    const input: CadastroIndividualInput = {
      uuid: lediUuid('9000011'),
      header: { ...header, cbo: '515105' },
      atualizada: false,
      cidadao: {
        ...cidadao,
        racaCor: '03',
        motherName: 'Maria da Silva',
        education: '10',
        workSituation: '02',
        kinship: '02',
        responsibleCns: CNS_PROF,
        phone: '(63) 99999-0000',
        nis: '12345678901',
        birthIbgeCode: '170950',
      },
      condicoes: { hipertensao: true },
    };
    const ficha = buildCadastroIndividual(input);
    expect(validateFicha(TIPO_DADO.CADASTRO_INDIVIDUAL, ficha)).toEqual([]);
    const id = ficha.identificacaoUsuarioCidadao as LediObject;
    expect(id).toMatchObject({
      nomeCidadao: 'JOANA DA SILVA',
      nomeMaeCidadao: 'MARIA DA SILVA',
      racaCorCidadao: 4,
      sexoCidadao: 1,
      telefoneCelular: '63999990000',
      codigoIbgeMunicipioNascimento: '1709500',
      cnsResponsavelFamiliar: CNS_PROF,
      statusEhResponsavel: false,
      stNaoPossuiCpf: false,
    });
    expect(ficha.informacoesSocioDemograficas).toMatchObject({ grauInstrucaoCidadao: 60, situacaoMercadoTrabalhoCidadao: 67, relacaoParentescoCidadao: 138 });
    const bytes = encodeLedi('CadastroIndividualThrift', ficha);
    expect(decodeLedi('CadastroIndividualThrift', bytes)).toEqual(JSON.parse(JSON.stringify(ficha)));

    // Sem CPF e sem justificativa, nome de um termo só, CBO fora do modelo: a validação aponta antes do envio.
    const ruim = buildCadastroIndividual({ ...input, header: { ...header, cbo: '999999' }, cidadao: { ...input.cidadao, cpf: null, name: 'Joana' } });
    const issues = validateFicha(TIPO_DADO.CADASTRO_INDIVIDUAL, ruim);
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['$.headerTransport.cboCodigo_2002', '$.identificacaoUsuarioCidadao.nomeCidadao', '$.identificacaoUsuarioCidadao.justificativaNaoPossuiCpf']));
    const atualizacao = buildCadastroIndividual({ ...input, atualizada: true, uuidOriginadora: 'x' });
    expect(atualizacao.uuidFichaOriginadora).toBe('x');
  });

  it('cadastro domiciliar: endereço no padrão DNE, família e condições de moradia', () => {
    const ficha = buildCadastroDomiciliar({
      uuid: lediUuid('9000011'),
      header: { ...header, cbo: '515105' },
      atualizada: false,
      endereco: { street: 'Rua de 14 Novembro', number: '100', district: 'Setor Central', cep: '77405-070', ibgeCode: '1709500', uf: 'TO', phone: '63999990000' },
      moradia: { propertyType: '01', dwellingType: '01', tenure: '01', wallMaterial: '01', waterSupply: '01', waterTreatment: '01', sewage: '01', garbage: '01', electricity: true, rooms: 5, residents: 3 },
      familias: [{ responsavel: { cns: CNS_PAC, birthDate: new Date('1981-02-03') }, membros: 3, renda: '03', resideDesde: new Date('2020-01-01') }],
    });
    expect(validateFicha(TIPO_DADO.CADASTRO_DOMICILIAR, ficha)).toEqual([]);
    expect(ficha.enderecoLocalPermanencia).toMatchObject({
      cep: '77405070',
      tipoLogradouroNumeroDne: '081',
      nomeLogradouro: 'DE 14 NOVEMBRO',
      numero: '100',
      numeroDneUf: '24',
      bairro: 'SETOR CENTRAL',
      codigoIbgeMunicipio: '1709500',
    });
    expect(ficha.condicaoMoradia).toMatchObject({
      localizacao: 83,
      situacaoMoradiaPosseTerra: 75,
      tipoDomicilio: 85,
      abastecimentoAgua: 117,
      aguaConsumoDomicilio: 218,
      formaEscoamentoBanheiro: 122,
      destinoLixo: 93,
      nuComodos: '5',
    });
    expect((ficha.familias as LediObject[])[0]).toMatchObject({ numeroCnsResponsavel: CNS_PAC, numeroMembrosFamilia: 3, rendaFamiliar: 3 });
    const semNumero = buildCadastroDomiciliar({
      uuid: lediUuid('9000011'),
      header,
      atualizada: false,
      endereco: { street: 'Estrada Velha', cep: '77405070', ibgeCode: '170950', uf: 'TO', district: 'Zona rural' },
      moradia: { tenure: '03', location: 'rural' },
      familias: [{ responsavel: { cpf: '52998224725' }, membros: 1 }],
    });
    expect(semNumero.enderecoLocalPermanencia).toMatchObject({ numero: 'SN', stSemNumero: true, tipoLogradouroNumeroDne: '671', codigoIbgeMunicipio: '1709500' });
    expect(semNumero.condicaoMoradia).toMatchObject({ localizacao: 84 });
    const issues = validateFicha(TIPO_DADO.CADASTRO_DOMICILIAR, buildCadastroDomiciliar({ uuid: 'x', header, atualizada: false, endereco: {}, moradia: {}, familias: [{ responsavel: {}, membros: 2 }] }));
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['$.enderecoLocalPermanencia.cep', '$.condicaoMoradia.situacaoMoradiaPosseTerra', '$.familias[0]']));
  });

  it('atendimento individual: dois atendimentos do mesmo profissional no dia, com condutas, problemas e exames', () => {
    const base: AtendimentoIndividualInput = {
      cidadao,
      localAtendimento: 1,
      turno: 1,
      tipoAtendimento: 5,
      inicio: new Date('2026-10-30T13:00:00Z'),
      fim: new Date('2026-10-30T13:30:00Z'),
      medicoes: { systolic: 150, diastolic: 90, weightKg: 72.5, heightCm: 168, glucose: 110 },
      problemas: [{ cid10: 'I10' }, { ciap: 'K86' }],
      condutas: [9, 9, 1],
      exames: [{ codigo: '0202010473', solicitado: true }],
    };
    const ficha = buildAtendimentoIndividual({
      uuid: lediUuid('9000011'),
      header: { principal: header, dataAtendimento: header.dataAtendimento, codigoIbge: '1709500' },
      atendimentos: [base, { ...base, cidadao: { ...cidadao, name: 'Pedro Lima', sex: 'M', cpf: null, cns: null, justificativaSemCpf: 8 } }],
    });
    expect(validateFicha(TIPO_DADO.ATENDIMENTO_INDIVIDUAL, ficha)).toEqual([]);
    const [a, b] = ficha.atendimentosIndividuais as LediObject[];
    expect(a).toMatchObject({ cns: CNS_PAC, cpfCidadao: '52998224725', stCidadaoNaoPossuiCpf: false, condutas: [9, 1], sexo: 1, tipoAtendimento: 5 });
    expect(a!.problemasCondicoes).toEqual([
      { cid10: 'I10', isAvaliado: true },
      { ciap: 'K86', isAvaliado: true },
    ]);
    expect(a!.medicoes).toMatchObject({ pressaoArterialSistolica: 150, peso: 72.5, altura: 168, glicemiaCapilar: 110, tipoGlicemiaCapilar: 3 });
    expect(b).toMatchObject({ stCidadaoNaoPossuiCpf: true, justificativaCidadaoNaoPossuiCpf: 8, sexo: 0 });
    const bytes = encodeLedi(structForTipo(TIPO_DADO.ATENDIMENTO_INDIVIDUAL), ficha);
    expect(decodeLedi('FichaAtendimentoIndividualMasterThrift', bytes)).toEqual(JSON.parse(JSON.stringify(ficha)));

    const ruim = buildAtendimentoIndividual({
      uuid: 'u',
      header: { principal: { ...header, cbo: '422105' }, dataAtendimento: header.dataAtendimento, codigoIbge: '170950' },
      atendimentos: [{ ...base, fim: new Date('2026-10-30T12:00:00Z'), problemas: [], condutas: [], cidadao: { ...cidadao, cpf: null } }],
    });
    const paths = validateFicha(TIPO_DADO.ATENDIMENTO_INDIVIDUAL, ruim).map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '$.headerTransport.lotacaoFormPrincipal.cboCodigo_2002',
        '$.headerTransport.codigoIbgeMunicipio',
        '$.atendimentosIndividuais[0].dataHoraFinalAtendimento',
        '$.atendimentosIndividuais[0].problemasCondicoes',
        '$.atendimentosIndividuais[0].condutas',
        '$.atendimentosIndividuais[0].justificativaCidadaoNaoPossuiCpf',
      ]),
    );
  });

  it('procedimentos e vacinação', () => {
    const fp = buildProcedimentos({
      uuid: lediUuid('9000011'),
      header: { ...header, cbo: '223505' },
      atendimentos: [
        { cidadao, localAtendimento: 1, turno: 2, inicio: new Date('2026-10-30T16:00:00Z'), fim: new Date('2026-10-30T16:10:00Z'), procedimentos: ['03.01.10.003-9'], medicoes: { systolic: 120, diastolic: 80 } },
      ],
      totais: { afericaoPa: 1 },
    });
    expect(validateFicha(TIPO_DADO.PROCEDIMENTOS, fp)).toEqual([]);
    expect((fp.atendProcedimentos as LediObject[])[0]!.procedimentos).toEqual(['0301100039']);
    expect(fp.numTotalAfericaoPa).toBe(1);
    const fv = buildVacinacao({
      uuid: lediUuid('9000011'),
      header: { ...header, cbo: '223505' },
      atendimentos: [
        {
          cidadao,
          turno: 1,
          localAtendimento: 1,
          inicio: new Date('2026-10-30T13:00:00Z'),
          fim: new Date('2026-10-30T13:05:00Z'),
          vacinas: [{ imunobiologico: 33, dose: 8, lote: 'L123', fabricanteRnds: '29909', viaAdministracao: 14, localAplicacao: 2 }],
        },
      ],
    });
    expect(validateFicha(TIPO_DADO.VACINACAO, fv)).toEqual([]);
    const semFabricante = buildVacinacao({
      uuid: 'u',
      header: { ...header, cbo: '223505' },
      atendimentos: [{ cidadao, turno: 1, localAtendimento: 1, inicio: header.dataAtendimento, fim: header.dataAtendimento, vacinas: [{ imunobiologico: 33, dose: 8, viaAdministracao: 14, localAplicacao: 2 }] }],
    });
    expect(validateFicha(TIPO_DADO.VACINACAO, semFabricante).map((i) => i.path)).toContain('$.vacinacoes[0].vacinas[0].coRndsFabricante');
  });

  it('empacota o DadoTransporte em .esus dentro de um zip e lê de volta', () => {
    const ficha = encodeLedi('FichaProcedimentoMasterThrift', buildProcedimentos({ uuid: '9000011-u', header: { ...header, cbo: '223505' }, atendimentos: [], totais: { afericaoPa: 3 } }));
    const instalacao = { contraChave: 'OmniSaude - 0.1', uuidInstalacao: 't', cpfOuCnpj: '12345678000199', nomeOuRazaoSocial: 'Consórcio' };
    const dado = buildDadoTransporte({ uuid: '9000011-u', tipo: TIPO_DADO.PROCEDIMENTOS, cnes: '9000011', codIbge: '1709500', ine: '0000123456', numLote: 1, ficha, instalacao });
    const zip = buildZip([{ name: '9000011-u.esus', data: dado }]);
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    const entries = readZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('9000011-u.esus');
    expect(Buffer.from(entries[0]!.data).equals(dado)).toBe(true);
    const back = decodeLedi('DadoTransporteThrift', entries[0]!.data);
    expect(back).toMatchObject({ tipoDadoSerializado: 7, cnesDadoSerializado: '9000011', ineDadoSerializado: '0000123456', numLote: 1, versao: { major: 8, minor: 7, revision: 0 } });
  });
});

describe('cliente da API do PEC', () => {
  const servers: http.Server[] = [];
  afterEach(() => servers.forEach((s) => s.close()));
  const start = (handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void) =>
    new Promise<string>((resolve) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => handler(req, Buffer.concat(chunks), res));
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });

  it('faz login (cookie JSESSIONID), envia a ficha como multipart e trata recusas', async () => {
    const seen: { url: string; cookie?: string; body: string }[] = [];
    let logins = 0;
    const url = await start((req, body, res) => {
      seen.push({ url: req.url!, cookie: req.headers.cookie, body: body.toString('latin1') });
      if (req.url === '/api/recebimento/login') {
        logins++;
        if (!body.toString().includes('integracao')) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Usuário ou senha inválidos' }));
        return res.writeHead(200, { 'set-cookie': `JSESSIONID=sess${logins}; Path=/; HttpOnly` }).end('{}');
      }
      if (req.url === '/api/v1/recebimento/ficha') {
        if (req.headers.cookie !== `JSESSIONID=sess${logins}`) return res.writeHead(401).end();
        if (body.toString('latin1').includes('REJEITA')) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'CNS do profissional inválido' }));
        return res.writeHead(201).end();
      }
      res.writeHead(404).end();
    });
    const client = new PecClient({ url, usuario: 'integracao', senha: 'integracao' });
    const ok = await client.sendFicha('9000011-abc', Buffer.from('conteudo'));
    expect(ok).toMatchObject({ ok: true, status: 201 });
    expect(seen[0]!.url).toBe('/api/recebimento/login');
    expect(seen[0]!.body).toMatch(/name="usuario"[\s\S]*integracao/);
    expect(seen[1]!.cookie).toBe('JSESSIONID=sess1');
    expect(seen[1]!.body).toMatch(/name="ficha"; filename="9000011-abc.esus"/);
    const rejected = await client.sendFicha('9000011-def', Buffer.from('REJEITA'));
    expect(rejected).toEqual({ ok: false, status: 400, message: 'CNS do profissional inválido' });
    // Sessão expirada: o cliente entra de novo uma vez.
    logins++;
    const again = await client.sendFicha('9000011-ghi', Buffer.from('x'));
    expect(again.ok).toBe(true);
    expect(seen.filter((s) => s.url === '/api/recebimento/login')).toHaveLength(2);
    await expect(new PecClient({ url, usuario: 'errado', senha: 'x' }).sendFicha('u', Buffer.from('x'))).rejects.toThrow(PecError);
  });
});

describe('ficha de visita domiciliar e territorial (ACS)', () => {
  const headerAcs = { ...header, cbo: '515105' };
  it('monta a ficha com pessoa identificada e visita ao imóvel, valida e serializa em Thrift', () => {
    const ficha = buildVisitaDomiciliar({
      uuid: lediUuid('9000011'),
      header: headerAcs,
      visitas: [
        { turno: 1, cidadao, motivos: [29, 11, 29], desfecho: 1, microArea: '01', compartilhada: false, sistolica: 130, diastolica: 85, pesoKg: 72.5, latitude: -11.7292, longitude: -49.0686 },
        { turno: 2, motivos: [35], desfecho: 1, microArea: '01', tipoImovel: '03' },
        { turno: 2, cidadao: { ...cidadao, cpf: null, justificativaSemCpf: 8 }, motivos: [5], desfecho: 3, foraDaArea: true },
      ],
    });
    expect(validateFicha(TIPO_DADO.VISITA_DOMICILIAR, ficha, new Date('2026-10-31T12:00:00Z'))).toEqual([]);
    const visitas = ficha.visitasDomiciliares as LediObject[];
    expect(visitas[0]).toMatchObject({ turno: 1, cpfCidadao: '52998224725', stCidadaoNaoPossuiCpf: false, motivosVisita: [29, 11], desfecho: 1, microArea: '01', tipoDeImovel: 1, pressaoSistolica: 130 });
    expect(visitas[1]).toMatchObject({ tipoDeImovel: 3, desfecho: 1 });
    expect(visitas[1]!.cnsCidadao).toBeUndefined();
    expect(visitas[2]).toMatchObject({ stCidadaoNaoPossuiCpf: true, justificativaCidadaoNaoPossuiCpf: 8, stForaArea: true });
    expect(visitas[2]!.microArea).toBeUndefined();
    const bytes = encodeLedi(structForTipo(TIPO_DADO.VISITA_DOMICILIAR), ficha);
    const back = decodeLedi(structForTipo(TIPO_DADO.VISITA_DOMICILIAR), bytes);
    expect((back.visitasDomiciliares as LediObject[])[0]).toMatchObject({ desfecho: 1, latitude: -11.7292, motivosVisita: [29, 11] });
  });

  it('aponta o que o PEC recusaria: sem motivo, sem microárea, pessoa não identificada em visita realizada e CBO fora do modelo', () => {
    const ficha = buildVisitaDomiciliar({
      uuid: lediUuid('9000011'),
      header: { ...header, cbo: '411010' },
      visitas: [{ turno: 1, motivos: [], desfecho: 1 }],
    });
    const issues = validateFicha(TIPO_DADO.VISITA_DOMICILIAR, ficha, new Date('2026-10-31T12:00:00Z')).map((i) => i.path);
    expect(issues).toEqual(expect.arrayContaining(['$.headerTransport.cboCodigo_2002', '$.visitasDomiciliares[0].motivosVisita', '$.visitasDomiciliares[0].microArea', '$.visitasDomiciliares[0].cnsCidadao']));
  });
});
