import * as compartilhado from '@omnisaude/shared';
import type { DetalheSurto, EventoSurto } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import * as regras from '../src/components/consolidacao/surto-regras';

/*
 * Surtos (web): achado tel-6 (o artigo do Ministério da Saúde), ponto K6 (a unidade do valor acima do limite), K8
 * (DTA e idade pelas regras do pacote compartilhado), K10 (a busca das notificações e dos registros oficiais pelas
 * rotas do surto) e a linha da planilha sob sigilo.
 */

const evento = (tipo: EventoSurto['tipo'], dados: Record<string, unknown>): EventoSurto => ({ id: `e-${tipo}`, tipo, em: '2026-11-10T13:00:00.000Z', por: 'Vigilância', dados });

describe('artigo da esfera (tel-6)', () => {
  it('à SMS, à SES e ao MS', () => {
    expect(regras.aEsfera('SMS')).toBe('à SMS');
    expect(regras.aEsfera('SES')).toBe('à SES');
    expect(regras.aEsfera('MS')).toBe('ao MS');
  });

  it('a linha do tempo escreve "Comunicado ao MS"', () => {
    expect(regras.textoEvento(evento('COMUNICADO', { alvo: 'MS', canal: 'TELEFONE' }))).toBe('Comunicado ao MS por telefone.');
    expect(regras.textoEvento(evento('COMUNICADO', { alvo: 'SMS', canal: 'EMAIL', contraparte: 'Plantão' }))).toBe('Comunicado à SMS por e-mail (Plantão).');
  });
});

describe('linha do tempo e planilha com o caso de registro oficial e o caso sob sigilo', () => {
  it('a retirada do caso de registro oficial cita o registro', () => {
    expect(regras.textoEvento(evento('CASO_RETIRADO', { caso: 3, notificacao: null, registro: '0012345', sistema: 'SINAN_NET' }))).toBe('Caso 3 retirado da planilha (registro oficial 0012345).');
    expect(regras.textoEvento(evento('CASO_RETIRADO', { caso: 4, notificacao: 'sob sigilo', restrito: true }))).toBe('Caso 4 retirado da planilha (notificação sob sigilo).');
    expect(regras.textoEvento(evento('CASO_VINCULADO', { caso: 5, registro: 'sob sigilo', restrito: true }))).toBe('Caso 5 na planilha: registro oficial sob sigilo.');
  });

  it('a origem da linha restrita não mostra o número', () => {
    expect(regras.origemDoCaso({ notificationId: 'n1', notificacaoNumero: null, officialRecordId: null, restrito: true })).toBe('Notificação sob sigilo');
    expect(regras.origemDoCaso({ notificationId: null, notificacaoNumero: null, officialRecordId: 'r1', restrito: true })).toBe('Registro oficial sob sigilo');
    expect(regras.origemDoCaso({ notificationId: 'n1', notificacaoNumero: '2026/000101', officialRecordId: null, restrito: false })).toBe('Notificação 2026/000101');
  });
});

describe('valor acima do limite superior na unidade do canal (K6)', () => {
  it('casos ou incidência por 100 mil', () => {
    expect(regras.textoValorExcesso(12, 'CASOS')).toBe('12 casos');
    expect(regras.textoValorExcesso(1, 'CASOS')).toBe('1 caso');
    expect(regras.textoValorExcesso(7.5, 'CASOS')).toBe('7,5 casos');
    expect(regras.textoValorExcesso(35.4321, 'INCIDENCIA')).toBe('35,43 por 100 mil');
  });
});

describe('regras do pacote compartilhado (K8)', () => {
  it('as variáveis do bloco DTA e a idade são as do pacote compartilhado', () => {
    expect(regras.CAMPOS_DTA).toBe(compartilhado.CAMPOS_DTA);
    expect(regras.idadeValida).toBe(compartilhado.idadeValida);
  });

  it('a ficha confere o bloco DTA como a API: data que existe e critério do dicionário', () => {
    const d = {
      id: 's1',
      categoria: 'DTA',
      grupo: null,
      sindrome: null,
      cid: 'A05.9',
      agente: null,
      notificadoEm: '2026-11-08',
      esp: false,
      primeirosSintomasEm: '2026-11-06',
      casos: 12,
      localInicial: '3',
      localInicialTexto: null,
      unidade: { id: 'u1', nome: 'UBS Centro', cnes: '1234567' },
      local: { municipioIbge: null, localidadeId: null, bairroId: null, endereco: null, referencia: null, zona: null, lat: null, lng: null },
      investigacao: { investigadoEm: null, modoTransmissao: null, veiculo: '1', veiculoTexto: null, observacoes: null, investigadorNome: null, investigadorFuncao: null },
      dta: null,
    } as unknown as DetalheSurto;
    const f = regras.formEdicao(d);
    f.dta = { DT_ENCERRA: '2026-02-30', CRITERIO: '7', NU_TOT: '12' };
    expect(regras.pendenciasEdicao(d, f, '2026-11-10')).toEqual(['DTA, Critério de confirmação: código de 1 a 5.', 'DTA, Data de encerramento (DTA): data válida e não futura.']);
    f.dta = { DT_ENCERRA: '2026-11-09', CRITERIO: '1', NU_TOT: '12' };
    expect(regras.pendenciasEdicao(d, f, '2026-11-10')).toEqual([]);
  });
});

describe('busca para a planilha (K10)', () => {
  const SURTO = '0190a000-0000-7000-8000-0000000000aa';

  it('consulta das rotas do surto: agravo, busca de 2 a 60 caracteres e o surto', () => {
    expect(regras.consultaCandidatas({ grupo: 'hepatite-a', surtoId: SURTO })).toBe(`?grupo=hepatite-a&surtoId=${SURTO}`);
    expect(regras.consultaCandidatas({ grupo: 'hepatite-a', busca: '  maria  ', surtoId: SURTO })).toBe(`?grupo=hepatite-a&busca=maria&surtoId=${SURTO}`);
    // Busca curta demais não vai (a API responderia 400).
    expect(regras.consultaCandidatas({ busca: 'a', surtoId: SURTO })).toBe(`?surtoId=${SURTO}`);
    expect(regras.consultaCandidatas({ de: '2026-11-01', ate: '2026-11-10' })).toBe('?de=2026-11-01&ate=2026-11-10');
    expect(regras.consultaCandidatas({})).toBe('');
  });

  it('a busca vazia vale (lista as mais recentes); com texto, de 2 a 60 caracteres', () => {
    expect(regras.buscaDaPlanilhaValida('')).toBe(true);
    expect(regras.buscaDaPlanilhaValida('  ')).toBe(true);
    expect(regras.buscaDaPlanilhaValida('a')).toBe(false);
    expect(regras.buscaDaPlanilhaValida('ab')).toBe(true);
    expect(regras.buscaDaPlanilhaValida('x'.repeat(61))).toBe(false);
  });

  it('rótulo do sistema do registro oficial', () => {
    expect(regras.rotuloSistemaOficial('SINAN_NET')).toBe(compartilhado.SISTEMA_INFO.SINAN_NET.label);
    expect(regras.rotuloSistemaOficial(null)).toBe('—');
  });
});
