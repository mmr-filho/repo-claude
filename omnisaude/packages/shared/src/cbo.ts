/**
 * Ocupações (CBO 2002) mais comuns na rede pública, para sugerir no cadastro de lotações. Qualquer código
 * de 6 dígitos é aceito; a lista só facilita a digitação. Fonte: tabela CBO do Ministério do Trabalho.
 */
export const CBO_SUGESTOES: { code: string; label: string }[] = [
  { code: '225125', label: 'Médico clínico' },
  { code: '225142', label: 'Médico da estratégia de saúde da família' },
  { code: '225170', label: 'Médico generalista' },
  { code: '225124', label: 'Médico pediatra' },
  { code: '225250', label: 'Médico ginecologista e obstetra' },
  { code: '225120', label: 'Médico cardiologista' },
  { code: '225133', label: 'Médico psiquiatra' },
  { code: '225265', label: 'Médico ortopedista e traumatologista' },
  { code: '223505', label: 'Enfermeiro' },
  { code: '223565', label: 'Enfermeiro da estratégia de saúde da família' },
  { code: '322205', label: 'Técnico de enfermagem' },
  { code: '322230', label: 'Auxiliar de enfermagem' },
  { code: '223208', label: 'Cirurgião-dentista clínico geral' },
  { code: '223293', label: 'Cirurgião-dentista da estratégia de saúde da família' },
  { code: '322415', label: 'Técnico em saúde bucal' },
  { code: '322425', label: 'Auxiliar em saúde bucal' },
  { code: '223405', label: 'Farmacêutico' },
  { code: '251605', label: 'Assistente social' },
  { code: '251510', label: 'Psicólogo clínico' },
  { code: '223605', label: 'Fisioterapeuta' },
  { code: '223710', label: 'Nutricionista' },
  { code: '515105', label: 'Agente comunitário de saúde' },
  { code: '422105', label: 'Recepcionista' },
  { code: '411010', label: 'Assistente administrativo' },
  { code: '131205', label: 'Gerente de serviços de saúde' },
];

export function cboLabel(code: string): string | undefined {
  return CBO_SUGESTOES.find((c) => c.code === code)?.label;
}
