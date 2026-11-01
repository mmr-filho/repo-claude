/** Domínios e campos da Ficha Individual de Notificação (FIN) do Sinan Net v5 (instrucional e dicionário de dados). */
export const SINAN_SEXO: Record<string, string> = { M: 'Masculino', F: 'Feminino', I: 'Ignorado' };
export const SINAN_GESTANTE: Record<string, string> = { '1': '1º trimestre', '2': '2º trimestre', '3': '3º trimestre', '4': 'Idade gestacional ignorada', '5': 'Não', '6': 'Não se aplica', '9': 'Ignorado' };
export const SINAN_RACA: Record<string, string> = { '1': 'Branca', '2': 'Preta', '3': 'Amarela', '4': 'Parda', '5': 'Indígena', '9': 'Ignorado' };
export const SINAN_ESCOLARIDADE: Record<string, string> = {
  '0': 'Analfabeto',
  '1': '1ª a 4ª série incompleta do EF',
  '2': '4ª série completa do EF',
  '3': '5ª à 8ª série incompleta do EF',
  '4': 'Ensino fundamental completo',
  '5': 'Ensino médio incompleto',
  '6': 'Ensino médio completo',
  '7': 'Educação superior incompleta',
  '8': 'Educação superior completa',
  '9': 'Ignorado',
  '10': 'Não se aplica',
};
export const SINAN_ZONA: Record<string, string> = { '1': 'Urbana', '2': 'Rural', '3': 'Periurbana', '9': 'Ignorado' };

/** Campos 1 a 16 e 20 a 33 da FIN (17 a 19 são da notificação de surto), com o nome da variável no Sinan. */
export const CAMPOS_FIN: { campo: string; numero: number; rotulo: string; grupo: 'GERAL' | 'PESSOAL' | 'RESIDENCIA' }[] = [
  { campo: 'TP_NOT', numero: 1, rotulo: 'Tipo de notificação', grupo: 'GERAL' },
  { campo: 'ID_AGRAVO', numero: 2, rotulo: 'Agravo/doença (CID-10)', grupo: 'GERAL' },
  { campo: 'DT_NOTIFIC', numero: 3, rotulo: 'Data da notificação', grupo: 'GERAL' },
  { campo: 'SG_UF_NOT', numero: 4, rotulo: 'UF', grupo: 'GERAL' },
  { campo: 'ID_MUNICIP', numero: 5, rotulo: 'Município de notificação (IBGE)', grupo: 'GERAL' },
  { campo: 'ID_UNIDADE', numero: 6, rotulo: 'Unidade de saúde (CNES)', grupo: 'GERAL' },
  { campo: 'DT_SIN_PRI', numero: 7, rotulo: 'Data dos primeiros sintomas', grupo: 'PESSOAL' },
  { campo: 'NM_PACIENT', numero: 8, rotulo: 'Nome do paciente', grupo: 'PESSOAL' },
  { campo: 'DT_NASC', numero: 9, rotulo: 'Data de nascimento', grupo: 'PESSOAL' },
  { campo: 'NU_IDADE_N', numero: 10, rotulo: 'Idade', grupo: 'PESSOAL' },
  { campo: 'CS_SEXO', numero: 11, rotulo: 'Sexo', grupo: 'PESSOAL' },
  { campo: 'CS_GESTANT', numero: 12, rotulo: 'Gestante', grupo: 'PESSOAL' },
  { campo: 'CS_RACA', numero: 13, rotulo: 'Raça/cor', grupo: 'PESSOAL' },
  { campo: 'CS_ESCOL_N', numero: 14, rotulo: 'Escolaridade', grupo: 'PESSOAL' },
  { campo: 'ID_CNS_SUS', numero: 15, rotulo: 'Número do Cartão SUS', grupo: 'PESSOAL' },
  { campo: 'NM_MAE_PAC', numero: 16, rotulo: 'Nome da mãe', grupo: 'PESSOAL' },
  { campo: 'SG_UF', numero: 20, rotulo: 'UF de residência', grupo: 'RESIDENCIA' },
  { campo: 'ID_MN_RESI', numero: 21, rotulo: 'Município de residência (IBGE)', grupo: 'RESIDENCIA' },
  { campo: 'ID_DISTRIT', numero: 22, rotulo: 'Distrito', grupo: 'RESIDENCIA' },
  { campo: 'NM_BAIRRO', numero: 23, rotulo: 'Bairro', grupo: 'RESIDENCIA' },
  { campo: 'NM_LOGRADO', numero: 24, rotulo: 'Logradouro', grupo: 'RESIDENCIA' },
  { campo: 'NU_NUMERO', numero: 25, rotulo: 'Número', grupo: 'RESIDENCIA' },
  { campo: 'NM_COMPLEM', numero: 26, rotulo: 'Complemento', grupo: 'RESIDENCIA' },
  { campo: 'ID_GEO1', numero: 27, rotulo: 'Geo campo 1', grupo: 'RESIDENCIA' },
  { campo: 'ID_GEO2', numero: 28, rotulo: 'Geo campo 2', grupo: 'RESIDENCIA' },
  { campo: 'NM_REFEREN', numero: 29, rotulo: 'Ponto de referência', grupo: 'RESIDENCIA' },
  { campo: 'NU_CEP', numero: 30, rotulo: 'CEP', grupo: 'RESIDENCIA' },
  { campo: 'NU_TELEFON', numero: 31, rotulo: 'Telefone', grupo: 'RESIDENCIA' },
  { campo: 'CS_ZONA', numero: 32, rotulo: 'Zona', grupo: 'RESIDENCIA' },
  { campo: 'ID_PAIS', numero: 33, rotulo: 'País (se reside fora do Brasil)', grupo: 'RESIDENCIA' },
];

/** Domínio de cada campo codificado da FIN, para exibir o rótulo e montar as listas de escolha. */
export const DOMINIO_FIN: Record<string, Record<string, string>> = { CS_SEXO: SINAN_SEXO, CS_GESTANT: SINAN_GESTANTE, CS_RACA: SINAN_RACA, CS_ESCOL_N: SINAN_ESCOLARIDADE, CS_ZONA: SINAN_ZONA };
