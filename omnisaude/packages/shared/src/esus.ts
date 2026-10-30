/**
 * Tabelas de domínio do e-SUS APS (cadastro individual e domiciliar), com os códigos do LEDI. Usadas no
 * cadastro do cidadão e, depois, nas fichas enviadas ao PEC.
 */

export const ESCOLARIDADE: Record<string, string> = {
  '01': 'Creche',
  '02': 'Pré-escola (exceto CA)',
  '03': 'Classe de alfabetização (CA)',
  '04': 'Ensino fundamental 1ª a 4ª série',
  '05': 'Ensino fundamental 5ª a 8ª série',
  '06': 'Ensino fundamental completo',
  '07': 'Ensino fundamental especial',
  '08': 'Ensino fundamental EJA, séries iniciais',
  '09': 'Ensino fundamental EJA, séries finais',
  '10': 'Ensino médio',
  '11': 'Ensino médio especial',
  '12': 'Ensino médio EJA',
  '13': 'Superior, aperfeiçoamento, especialização, mestrado, doutorado',
  '14': 'Alfabetização para adultos (Mobral etc.)',
  '15': 'Nenhum',
};

export const SITUACAO_TRABALHO: Record<string, string> = {
  '01': 'Empregador',
  '02': 'Assalariado com carteira de trabalho',
  '03': 'Assalariado sem carteira de trabalho',
  '04': 'Autônomo com previdência social',
  '05': 'Autônomo sem previdência social',
  '06': 'Aposentado / pensionista',
  '07': 'Desempregado',
  '08': 'Não trabalha',
  '09': 'Servidor público / militar',
  '10': 'Outro',
};

/** Relação com o responsável familiar; "00" é o próprio responsável. */
export const PARENTESCO: Record<string, string> = {
  '00': 'Responsável familiar',
  '01': 'Cônjuge / companheiro(a)',
  '02': 'Filho(a)',
  '03': 'Enteado(a)',
  '04': 'Neto(a)',
  '05': 'Pai / mãe',
  '06': 'Sogro(a)',
  '07': 'Irmão / irmã',
  '08': 'Genro / nora',
  '09': 'Outro parente',
  '10': 'Não parente',
};

export const TIPO_IMOVEL: Record<string, string> = {
  '01': 'Domicílio',
  '02': 'Comércio',
  '03': 'Terreno baldio',
  '04': 'Ponto estratégico',
  '05': 'Escola',
  '06': 'Creche',
  '07': 'Abrigo',
  '08': 'Instituição de longa permanência para idosos',
  '09': 'Unidade prisional',
  '10': 'Unidade de medida socioeducativa',
  '11': 'Delegacia',
  '12': 'Estabelecimento religioso',
  '99': 'Outros',
};

export const SITUACAO_MORADIA: Record<string, string> = {
  '01': 'Próprio',
  '02': 'Financiado',
  '03': 'Alugado',
  '04': 'Arrendado',
  '05': 'Cedido',
  '06': 'Ocupação',
  '07': 'Situação de rua',
  '08': 'Outra',
};

export const TIPO_DOMICILIO: Record<string, string> = {
  '01': 'Casa',
  '02': 'Apartamento',
  '03': 'Cômodo',
  '04': 'Outro',
};

export const MATERIAL_PAREDES: Record<string, string> = {
  '01': 'Alvenaria / tijolo com revestimento',
  '02': 'Alvenaria / tijolo sem revestimento',
  '03': 'Taipa com revestimento',
  '04': 'Taipa sem revestimento',
  '05': 'Madeira aparelhada',
  '06': 'Material aproveitado',
  '07': 'Palha',
  '08': 'Outro material',
};

export const ABASTECIMENTO_AGUA: Record<string, string> = {
  '01': 'Rede encanada até o domicílio',
  '02': 'Poço / nascente no domicílio',
  '03': 'Cisterna',
  '04': 'Carro-pipa',
  '05': 'Outro',
};

export const TRATAMENTO_AGUA: Record<string, string> = {
  '01': 'Filtração',
  '02': 'Fervura',
  '03': 'Cloração',
  '04': 'Sem tratamento',
  '05': 'Mineral',
};

export const ESGOTAMENTO: Record<string, string> = {
  '01': 'Rede coletora de esgoto ou pluvial',
  '02': 'Fossa séptica',
  '03': 'Fossa rudimentar',
  '04': 'Direto para um rio, lago ou mar',
  '05': 'Céu aberto',
  '06': 'Outra forma',
};

export const DESTINO_LIXO: Record<string, string> = {
  '01': 'Coletado',
  '02': 'Queimado / enterrado',
  '03': 'Céu aberto',
  '04': 'Outro',
};

export const RENDA_FAMILIAR: Record<string, string> = {
  '01': '1/4 de salário mínimo',
  '02': '1/2 salário mínimo',
  '03': '1 salário mínimo',
  '04': '2 salários mínimos',
  '05': '3 salários mínimos',
  '06': '4 salários mínimos',
  '07': 'Acima de 4 salários mínimos',
};

export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'] as const;

export const codeIn = (table: Record<string, string>) => Object.keys(table) as [string, ...string[]];
